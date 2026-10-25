"""Per-client request limits for expensive or abusable endpoints.

A sliding one-minute window per (client address, endpoint group). Over the limit the request is refused with an
explicit 429 public error (`rate_limited`, retryable, Retry-After header) — never dropped silently, never queued.
Cheap reads (job polling, stored status, imagery decisions, health) are not limited. Map tiles are limited only when
they need Earth Engine: group `tiles` is checked by the tile routes on a cache miss (api/routes.py `_serve_tile`), so a
cached tile is never refused.

Limits come from settings (TT_RATE_*_PER_MIN; 0 disables a group). In-process only: behind several workers or
processes each keeps its own counters, which is acceptable for a single-instance prototype (see docs).
"""

from __future__ import annotations

import re
import threading
import time
from collections import deque

from .config import settings

WINDOW_S = 60.0

# (method, path regex, group). Order matters: the first match wins.
_RULES: list[tuple[str, re.Pattern[str], str]] = [
    ("POST", re.compile(r"^/api/analysis-jobs$"), "analysis"),
    ("POST", re.compile(r"^/api/analyze$"), "analysis"),
    ("GET", re.compile(r"^/api/analysis/[^/]+$"), "analysis"),            # legacy synchronous analysis (starts work)
    ("GET", re.compile(r"^/api/analysis/[^/]+/history$"), "compute"),
    ("GET", re.compile(r"^/api/imagery/availability$"), "compute"),
    ("GET", re.compile(r"^/api/imagery$"), "compute"),                     # an uncached (area, year) is an EE request
    ("POST", re.compile(r"^/api/aoi$"), "compute"),
    ("GET", re.compile(r"^/api/aoi/[^/]+$"), "compute"),                   # ?include=context measures reference datasets
    ("POST", re.compile(r"^/api/aoi/preview$"), "compute"),
    ("GET", re.compile(r"^/api/search$"), "search"),
    ("POST", re.compile(r"^/api/explain$"), "explain"),
    ("POST", re.compile(r"^/api/chat(?:/stream)?$"), "chat"),   # the streaming route shares the chat limit
    ("POST", re.compile(r"^/api/quickscan/[^/]+$"), "quickscan"),   # starts one Earth Engine request
]


def limit_for(group: str) -> int:
    return {"analysis": settings.rate_analysis_per_min, "compute": settings.rate_compute_per_min,
            "search": settings.rate_search_per_min, "explain": settings.rate_explain_per_min,
            "chat": settings.rate_chat_per_min, "quickscan": settings.rate_quickscan_per_min,
            "tiles": settings.rate_tiles_per_min}[group]


def client_of(request) -> str:
    """The address limits are counted for (the real client only when uvicorn runs with --proxy-headers)."""
    return request.client.host if request.client else "unknown"


def group_of(method: str, path: str) -> str | None:
    for m, rx, group in _RULES:
        if m == method and rx.match(path):
            return group
    return None


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[tuple[str, str], deque[float]] = {}
        self._lock = threading.Lock()

    def check(self, client: str, group: str, now: float | None = None) -> float | None:
        """Record a request. Returns None when allowed, else the seconds until the next request would be allowed."""
        limit = limit_for(group)
        if limit <= 0:
            return None
        now = time.monotonic() if now is None else now
        with self._lock:
            q = self._hits.setdefault((client, group), deque())
            while q and now - q[0] >= WINDOW_S:
                q.popleft()
            if len(q) >= limit:
                return max(1.0, WINDOW_S - (now - q[0]))
            q.append(now)
            if len(self._hits) > 10_000:   # bounded: forget idle clients
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] >= WINDOW_S]:
                    self._hits.pop(k, None)
            return None

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = RateLimiter()
