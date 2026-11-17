"""Earth Engine map tiles, fetched by the backend and cached on disk.

Why: every Earth Engine tile is computed live (a cloud-masked median of hundreds of scenes). Redirecting the browser
to Earth Engine meant every pan, year switch, reload and visitor recomputed the same tiles, with concurrency capped
only per browser tab — so a project in Restricted Mode answered 429 and tiles were left empty.

Here:
  - a tile is fetched from Earth Engine at most once per (layer, method version, z/x/y) and kept in
    TT_TILE_CACHE_DIR, default cache_dir/tiles (bounded by TT_TILE_CACHE_MB, oldest evicted first); a cached tile needs no Earth Engine call
    at all, not even a map ID;
  - identical concurrent requests share one fetch (single-flight);
  - at most TT_EE_TILE_CONCURRENCY Earth Engine tile fetches run at once for the whole backend (a dedicated pool,
    so waiting tiles hold no request threads), with a bounded queue;
  - 429 / 5xx are retried with exponential backoff and jitter (Retry-After honoured, capped); a tile that still
    fails is a retryable 503 — never a substitute image.

Nothing is invented: a cached tile is byte-for-byte what Earth Engine returned for that layer.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import logging
import os
import random
import threading
import time
from pathlib import Path

import httpx

from ..config import settings
from ..lru import LRUDict
from . import science as sc

log = logging.getLogger("terratrace.tiles")

# Bump when a layer's visualisation changes (styling is not part of the scientific method version).
TILE_STYLE_VERSION = "s1"
TILES = settings.tile_cache_dir
RETRY_STATUS = {429, 500, 502, 503, 504}
BACKOFF_S = (1.0, 2.0, 4.0, 8.0)       # 4 retries after the first attempt
MAX_RETRY_AFTER_S = 15.0
MAX_QUEUED = 256                        # tile fetches waiting for a slot; beyond this answer 503 at once
EVICT_EVERY = 200                       # writes between cache-size checks


class TileUnavailable(Exception):
    """Earth Engine did not deliver the tile (still throttled / failing after the retries). Retryable."""


class TileExpired(Exception):
    """Earth Engine rejected the tile URL itself (expired or unknown map ID): rebuild the map ID and retry once."""


_pool = concurrent.futures.ThreadPoolExecutor(max_workers=settings.ee_tile_concurrency, thread_name_prefix="ee-tile")
_inflight: dict[str, concurrent.futures.Future] = {}
_lock = threading.Lock()
_memory: LRUDict = LRUDict(512)          # recently served tiles (bytes); the disk cache is the real store
_client = httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0), headers={"User-Agent": settings.user_agent})
_writes = 0


def cache_key(layer: str, aid: str, year: int, z: int, x: int, y: int) -> str:
    """Stable key of one tile. `layer` = imagery | aoi-imagery | forest | change:<baseline>."""
    return f"{sc.METHOD_VERSION}/{TILE_STYLE_VERSION}/{aid}/{layer.replace(':', '-')}/{year}/{z}/{x}/{y}"


def _path(key: str) -> Path:
    # Every component is validated by the routes (ids, years, ints); the hash keeps the path short and flat-ish.
    h = hashlib.sha256(key.encode()).hexdigest()
    return TILES / h[:2] / f"{h}.png"


def cached(key: str) -> bytes | None:
    data = _memory.get(key)
    if data is not None:
        return data
    p = _path(key)
    try:
        data = p.read_bytes()
    except OSError:
        return None
    _memory[key] = data
    return data


def _store(key: str, data: bytes) -> None:
    global _writes
    p = _path(key)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(f".{threading.get_ident()}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)
    except OSError as e:
        log.warning("Tile cache write failed: %s", e)
        return
    _memory[key] = data
    with _lock:
        _writes += 1
        check = _writes % EVICT_EVERY == 0
    if check:
        evict()


def evict(limit_bytes: int | None = None) -> int:
    """Delete the oldest cached tiles until the cache is under 90 % of its limit. Returns files removed."""
    limit = settings.tile_cache_mb * 1024 * 1024 if limit_bytes is None else limit_bytes
    files = []
    for p in TILES.glob("*/*.png") if TILES.exists() else []:
        try:
            st = p.stat()
        except OSError:
            continue
        files.append((st.st_mtime, st.st_size, p))
    total = sum(s for _, s, _ in files)
    if total <= limit:
        return 0
    removed = 0
    for _, size, p in sorted(files):
        if total <= limit * 0.9:
            break
        p.unlink(missing_ok=True)
        total -= size
        removed += 1
    log.info("Tile cache over %d MB: removed %d oldest tiles", limit // (1024 * 1024), removed)
    return removed


def _retry_after(r: httpx.Response, default: float) -> float:
    try:
        return min(MAX_RETRY_AFTER_S, max(default, float(r.headers.get("Retry-After", ""))))
    except ValueError:
        return default


def _fetch(key: str, url: str) -> bytes:
    """One tile from Earth Engine with bounded exponential backoff (runs on the tile pool)."""
    last = None
    for attempt in range(len(BACKOFF_S) + 1):
        try:
            r = _client.get(url)
        except httpx.HTTPError as e:   # network: transient
            last = f"{type(e).__name__}"
            r = None
        if r is not None:
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image/"):
                _store(key, r.content)
                return r.content
            if r.status_code in (400, 401, 403, 404):
                raise TileExpired(f"HTTP {r.status_code}")
            last = f"HTTP {r.status_code}"
        if attempt == len(BACKOFF_S):
            break
        delay = BACKOFF_S[attempt] * (1 + random.random() * 0.25)
        if r is not None and r.status_code == 429:
            delay = _retry_after(r, delay)
        log.info("Tile %s: %s - retry %d in %.1fs", key, last, attempt + 1, delay)
        time.sleep(delay)
    raise TileUnavailable(last or "unknown")


def fetch(key: str, url: str) -> concurrent.futures.Future:
    """Future of the tile bytes; identical concurrent requests share one fetch."""
    with _lock:
        fut = _inflight.get(key)
        if fut is not None:
            return fut
        if len(_inflight) >= MAX_QUEUED:
            raise TileUnavailable("tile queue full")
        fut = _pool.submit(_fetch, key, url)
        _inflight[key] = fut
    fut.add_done_callback(lambda f, k=key: _drop(k, f))
    return fut


def _drop(key: str, fut: concurrent.futures.Future) -> None:
    with _lock:
        if _inflight.get(key) is fut:
            _inflight.pop(key, None)
