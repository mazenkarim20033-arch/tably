import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

from .config import get_settings

_lock = threading.Lock()
_hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)
_last_gc = time.monotonic()
_GC_EVERY = 300  # seconds
_LONGEST_WINDOW = 3600


def client_ip(request: Request) -> str:
    if get_settings().trust_proxy:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def reset() -> None:
    with _lock:
        _hits.clear()


def _gc(now: float) -> None:
    """Forget clients that have been quiet, so the table cannot grow without bound. Caller holds the lock."""
    global _last_gc
    if now - _last_gc < _GC_EVERY:
        return
    _last_gc = now
    for key in [k for k, q in _hits.items() if not q or now - q[-1] > _LONGEST_WINDOW]:
        del _hits[key]


def _over(key: tuple[str, str], count: int, per_seconds: int, now: float) -> deque[float] | None:
    q = _hits[key]
    while q and now - q[0] > per_seconds:
        q.popleft()
    return q if len(q) >= count else None


def limit(bucket: str, count: int, per_seconds: int):
    """Sliding-window limiter per client IP. In-memory: fine for one instance; use Redis if scaled out."""

    def dep(request: Request) -> None:
        if not get_settings().rate_limit_enabled:
            return
        now = time.monotonic()
        key = (bucket, client_ip(request))
        with _lock:
            _gc(now)
            full = _over(key, count, per_seconds, now)
            if full is not None:
                retry = max(1, int(per_seconds - (now - full[0])))
                raise HTTPException(429, "Too many requests. Please slow down.", headers={"Retry-After": str(retry)})
            _hits[key].append(now)

    return dep


def is_blocked(bucket: str, ip: str, count: int, per_seconds: int) -> int | None:
    """Seconds to wait if `ip` already has `count` strikes in the window, else None."""
    if not get_settings().rate_limit_enabled:
        return None
    now = time.monotonic()
    with _lock:
        full = _over((bucket, ip), count, per_seconds, now)
        return None if full is None else max(1, int(per_seconds - (now - full[0])))


def strike(bucket: str, ip: str) -> None:
    with _lock:
        _hits[(bucket, ip)].append(time.monotonic())
