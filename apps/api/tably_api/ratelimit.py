import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

from .config import get_settings

_lock = threading.Lock()
_hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)


def client_ip(request: Request) -> str:
    if get_settings().trust_proxy:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def reset() -> None:
    with _lock:
        _hits.clear()


def limit(bucket: str, count: int, per_seconds: int):
    """Sliding-window limiter per client IP. In-memory: fine for one instance; use Redis if scaled out."""

    def dep(request: Request) -> None:
        if not get_settings().rate_limit_enabled:
            return
        now = time.monotonic()
        key = (bucket, client_ip(request))
        with _lock:
            q = _hits[key]
            while q and now - q[0] > per_seconds:
                q.popleft()
            if len(q) >= count:
                retry = max(1, int(per_seconds - (now - q[0])))
                raise HTTPException(429, "Too many requests. Please slow down.", headers={"Retry-After": str(retry)})
            q.append(now)

    return dep
