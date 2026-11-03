"""Cross-cutting protections: body size limits, security headers, token-guessing defence, log redaction."""

from __future__ import annotations

import logging
import re

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import ratelimit
from .config import get_settings

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)

_TOKEN_PATH = re.compile(r"^/api/s/[^/]+")
BAD_TOKEN_STRIKES = 30  # unknown share links per IP...
BAD_TOKEN_WINDOW = 300  # ...per five minutes, then 429




class BodyLimitMiddleware:
    """Reject oversized request bodies, including chunked ones that carry no Content-Length."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS", "DELETE"):
            return await self.app(scope, receive, send)
        cfg = get_settings()
        limit = cfg.max_upload_bytes + 64 * 1024 if scope["path"].endswith("/image") else cfg.max_json_bytes
        declared = dict(scope["headers"]).get(b"content-length")
        too_big = Response("Request body too large.", status_code=413)
        if declared and declared.isdigit() and int(declared) > limit:
            return await too_big(scope, receive, send)

        received = 0
        exceeded = False
        body_sent = False
        text = b"Request body too large."

        async def counting_receive() -> Message:
            nonlocal received, exceeded
            if exceeded:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True  # stop feeding the app; whatever it answers is replaced below
                    return {"type": "http.disconnect"}
            return message

        async def replacing_send(message: Message) -> None:
            nonlocal body_sent
            if not exceeded:
                return await send(message)
            # The app saw a broken body and will answer 400 (or similar); tell the client the real reason.
            if message["type"] == "http.response.start":
                await send({"type": "http.response.start", "status": 413,
                            "headers": [(b"content-type", b"text/plain"), (b"content-length", str(len(text)).encode())]})
            elif message["type"] == "http.response.body" and not body_sent:
                body_sent = True
                await send({"type": "http.response.body", "body": text})

        await self.app(scope, counting_receive, replacing_send)


async def security_middleware(request: Request, call_next):
    ip = ratelimit.client_ip(request)
    on_share_link = bool(_TOKEN_PATH.match(request.url.path))
    if on_share_link:
        wait = ratelimit.is_blocked("badtoken", ip, BAD_TOKEN_STRIKES, BAD_TOKEN_WINDOW)
        if wait:
            return JSONResponse({"detail": "Too many requests. Please slow down."}, status_code=429,
                                headers={"Retry-After": str(wait)})

    response = await call_next(request)

    if on_share_link and response.status_code == 404:
        ratelimit.strike("badtoken", ip)  # someone is guessing links

    h = response.headers
    # Share tokens live in URLs, so never leak them through Referer; never cache bill data.
    h["Referrer-Policy"] = "no-referrer"
    h["X-Content-Type-Options"] = "nosniff"
    h["X-Frame-Options"] = "DENY"
    h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"
    h["Content-Security-Policy"] = CSP
    if request.url.path.startswith("/api/"):
        h["Cache-Control"] = "no-store"
    forwarded_https = get_settings().trust_proxy and request.headers.get("x-forwarded-proto") == "https"
    if request.url.scheme == "https" or forwarded_https:
        h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


_REDACT = re.compile(r"(/(?:api/)?s/)[A-Za-z0-9_-]+")


class RedactTokens(logging.Filter):
    """Access logs would otherwise record every share token (they are in the URL)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(_REDACT.sub(r"\1[redacted]", a) if isinstance(a, str) else a for a in record.args)
        if isinstance(record.msg, str):
            record.msg = _REDACT.sub(r"\1[redacted]", record.msg)
        return True


def install_log_redaction() -> None:
    for name in ("uvicorn.access", "uvicorn.error", "uvicorn", "httpx", "httpcore"):
        logging.getLogger(name).addFilter(RedactTokens())
