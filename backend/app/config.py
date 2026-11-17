"""Runtime configuration. Everything secret comes from the environment (or backend/.env)."""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from . import __version__

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
load_dotenv(BACKEND_DIR / ".env")


def _bounded_int(name: str, default: int, lo: int, hi: int) -> int:
    """Integer setting clamped to [lo, hi]; an out-of-range or invalid value is logged and clamped, never trusted."""
    raw = os.environ.get(name)
    try:
        v = int(float(raw)) if raw not in (None, "") else default
    except ValueError:
        logging.getLogger("terratrace.config").warning("%s=%r is not a number; using %d", name, raw, default)
        return default
    if not lo <= v <= hi:
        logging.getLogger("terratrace.config").warning("%s=%d is outside %d..%d; using %d", name, v, lo, hi, min(hi, max(lo, v)))
    return min(hi, max(lo, v))


DEV_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")
_ORIGIN = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d{1,5})?$")


def _cors_origins() -> tuple[str, ...]:
    """Browser origins allowed to call the API: the local dev server plus TT_CORS_ORIGINS (comma-separated exact
    origins, e.g. https://terratrace.vercel.app). A wildcard or anything that is not a bare origin is ignored."""
    extra = []
    for o in os.environ.get("TT_CORS_ORIGINS", "").split(","):
        o = o.strip().rstrip("/")
        if not o:
            continue
        if _ORIGIN.fullmatch(o):
            extra.append(o)
        else:
            logging.getLogger("terratrace.config").warning("TT_CORS_ORIGINS entry %r is not an exact origin; ignored", o)
    return tuple(dict.fromkeys((*DEV_ORIGINS, *extra)))


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


_CACHE_DIR = Path(os.environ.get("TT_CACHE_DIR") or BACKEND_DIR / ".cache")


@dataclass(frozen=True)
class Settings:
    version: str = __version__
    frontend_dist: Path = REPO_DIR / "frontend" / "dist"
    # Durable state (registered areas, stored results, quick scans): a PERSISTENT volume in production.
    cache_dir: Path = _CACHE_DIR
    # Fetched map tiles: disposable (rebuilt from Earth Engine on demand). Defaults to cache_dir/tiles; can point at a
    # faster or ephemeral disk where the durable volume is slow for many small files (e.g. Cloud Storage FUSE).
    tile_cache_dir: Path = Path(os.environ.get("TT_TILE_CACHE_DIR") or _CACHE_DIR / "tiles")

    # AOI limits for interactive analysis (prototype scale, not planetary scale).
    max_aoi_km2: float = _float("TT_MAX_AOI_KM2", 2500.0)
    min_aoi_km2: float = _float("TT_MIN_AOI_KM2", 0.5)

    # Google Earth Engine (LIVE mode). Either a service-account key file or `earthengine authenticate`.
    ee_project: str | None = os.environ.get("EE_PROJECT") or None
    ee_service_account_key: str | None = os.environ.get("EE_SERVICE_ACCOUNT_KEY") or None
    ee_timeout_s: float = _float("EE_TIMEOUT_S", 120.0)
    # Per-request HTTP deadline for Earth Engine calls (getInfo / getMapId). Without it a request can block a worker
    # forever (observed 2026-09-27: one getInfo hung 40,471 s across a network drop). Longer than any measured
    # legitimate request (≤ ~62 s), so late results can still finish and be cached for Retry.
    ee_request_deadline_s: float = _float("EE_REQUEST_DEADLINE_S", 180.0)
    # Dedicated worker threads for analysis jobs (separate from tile/imagery work, so analyses never queue behind
    # map tiles). Earth Engine Restricted Mode throttles concurrency, so a small number is deliberate.
    analysis_workers: int = _bounded_int("TT_ANALYSIS_WORKERS", 3, 1, 8)
    # Largest AOI accepted for an INTERACTIVE (synchronous) analysis. Measured 2026-09-27 (tt-ee-2.0): AOIs up to
    # 1,215 km² completed within the 120 s window; 1,773 km² and 1,822 km² exceeded it on cold runs.
    # Every composite year is always computed, so the requested window does not change the cost.
    interactive_max_km2: float = _float("TT_INTERACTIVE_MAX_KM2", 1500.0)
    # Concurrent Earth Engine requests per analysis stage. 1 = one combined request per stage (default).
    # >1 is an UNVERIFIED optimisation (A/B interrupted 2026-09-27: project entered EE restricted mode).
    # Bounded to 1..4: each concurrent request is a separate Earth Engine computation, and the noncommercial quota
    # (restricted mode) throttles concurrency, so more is not faster beyond a few.
    ee_parallel_requests: int = _bounded_int("EE_PARALLEL_REQUESTS", 1, 1, 4)

    # Developer diagnostics in API responses (stage / error type / timing; never secrets). Local only.
    dev_diagnostics: bool = os.environ.get("DEV_DIAGNOSTICS", "false").strip().lower() in ("1", "true", "yes")

    # AI explanation provider (optional — an offline deterministic provider is always available).
    llm_model: str = os.environ.get("TERRATRACE_LLM_MODEL", "claude-opus-5")
    llm_effort: str = os.environ.get("TERRATRACE_LLM_EFFORT", "low")

    # Place search (OpenStreetMap Nominatim; offline gazetteer is always available).
    geocoder_enabled: bool = os.environ.get("TT_GEOCODER", "nominatim") != "off"
    user_agent: str = field(default_factory=lambda: os.environ.get("TT_USER_AGENT", f"TERRATRACE-prototype/{__version__} (university innovation expo)"))

    cors_origins: tuple[str, ...] = field(default_factory=_cors_origins)

    # In-memory cache entries per cache (results, history, imagery availability, ...). Evicted entries are re-read from
    # the method-versioned files in cache_dir or rebuilt from the same inputs; nothing measured is lost.
    memory_cache_entries: int = _bounded_int("TT_MEMORY_CACHE_ENTRIES", 256, 16, 100_000)

    # Earth Engine map tiles: concurrent fetches for the WHOLE backend (Restricted Mode measured 2026-09-27: 3 in
    # flight never throttled, 4 did), and the disk-cache budget for fetched tiles.
    ee_tile_concurrency: int = _bounded_int("TT_EE_TILE_CONCURRENCY", 3, 1, 16)
    tile_cache_mb: int = _bounded_int("TT_TILE_CACHE_MB", 1024, 50, 100_000)

    # Pre-compute the featured investigations' results in the background after startup (one at a time; skipped when
    # already stored for the current method version). Off in tests.
    precompute_featured: bool = os.environ.get("TT_PRECOMPUTE_FEATURED", "true").strip().lower() in ("1", "true", "yes")

    # Largest accepted request body. Real bodies are a drawn AOI polygon or one event's facts (a few KB).
    max_request_bytes: int = _bounded_int("TT_MAX_REQUEST_BYTES", 1_000_000, 10_000, 20_000_000)

    # Per-client request limits (requests per minute; 0 disables a limit). Generous defaults: they stop runaway
    # clients from exhausting the Earth Engine quota without getting in the way of normal use.
    rate_analysis_per_min: int = _bounded_int("TT_RATE_ANALYSIS_PER_MIN", 30, 0, 10_000)
    rate_compute_per_min: int = _bounded_int("TT_RATE_COMPUTE_PER_MIN", 120, 0, 10_000)
    rate_search_per_min: int = _bounded_int("TT_RATE_SEARCH_PER_MIN", 60, 0, 10_000)
    rate_explain_per_min: int = _bounded_int("TT_RATE_EXPLAIN_PER_MIN", 20, 0, 10_000)
    # Quick scans (POST /api/quickscan/{aid}): each one is an Earth Engine request over a year of Landsat and Dynamic World.
    rate_quickscan_per_min: int = _bounded_int("TT_RATE_QUICKSCAN_PER_MIN", 6, 0, 10_000)
    # Map tiles that need Earth Engine (cache misses) per client; cached tiles are never limited. The whole backend fetches
    # at most TT_EE_TILE_CONCURRENCY tiles at once (~1 s each), i.e. roughly 180 per minute: 120 keeps one client from
    # taking every slot while a normal map view (20-60 new tiles) is never refused.
    rate_tiles_per_min: int = _bounded_int("TT_RATE_TILES_PER_MIN", 120, 0, 100_000)
    # Earth Engine request deadline for ONE quick scan while the project is in restricted mode (slower, not blocked).
    quickscan_restricted_deadline_s: float = _float("TT_QUICKSCAN_RESTRICTED_DEADLINE_S", 900.0)

    # AI chat (POST /api/chat). Off by default: Gemini API users must be 18+ and the free tier may not serve EEA / UK /
    # Swiss users (docs/PRE_DEPLOYMENT.md). The key is read from GEMINI_API_KEY at call time and never stored here.
    chat_enabled: bool = os.environ.get("TT_CHAT_ENABLED", "false").strip().lower() in ("1", "true", "yes")
    chat_provider: str = os.environ.get("TT_LLM_PROVIDER", "gemini").strip().lower()
    # Which Gemini API tier GEMINI_API_KEY belongs to (it cannot be read from the key): "free" (default) or "paid" (a key
    # from a project with billing enabled). Decides the notice next to the chat: on the free tier Google may use inputs
    # to improve its products and human reviewers may read them. Switching to paid = new key + TT_LLM_TIER=paid + the
    # project's paid limits in TT_RATE_CHAT_PER_MIN / TT_CHAT_*; no code change.
    chat_tier: str = "paid" if os.environ.get("TT_LLM_TIER", "free").strip().lower() == "paid" else "free"
    chat_model: str = os.environ.get("TT_LLM_MODEL", "gemini-3.8-flash").strip()
    # Tried ONCE when the primary model answers 503 ("high demand"; seen for every full Flash model on 2026-10-15 while
    # gemini-3.5-flash-lite answered). Empty = no fallback. Never used after a 429 (quota) or any other error.
    chat_fallback_model: str = os.environ.get("TT_LLM_FALLBACK_MODEL", "gemini-3.5-flash-lite").strip()
    chat_timeout_s: int = _bounded_int("TT_CHAT_TIMEOUT_S", 60, 5, 120)
    # Model thinking level (minimal | low | medium | high | default) and output budget (thinking tokens count against it).
    chat_thinking: str = (os.environ.get("TT_LLM_THINKING", "low").strip().lower()
                          if os.environ.get("TT_LLM_THINKING", "low").strip().lower() in ("minimal", "low", "medium", "high", "default")
                          else "low")
    chat_max_output_tokens: int = _bounded_int("TT_LLM_MAX_OUTPUT_TOKENS", 8192, 1024, 65_536)
    # After Gemini answers 429 (quota), no request is sent to Gemini for this many seconds (answers "busy" at once).
    chat_cooldown_s: int = _bounded_int("TT_CHAT_COOLDOWN_S", 60, 0, 3600)
    # GET /api/chat/stats (counts by reason code). There is no admin authentication, so it is OFF unless enabled; the
    # same counts are always in cache_dir/chat_counters.json on the server.
    chat_stats_enabled: bool = os.environ.get("TT_CHAT_STATS_ENABLED", "false").strip().lower() in ("1", "true", "yes")
    # Conservative defaults (Google publishes no fixed free-tier figures; read the project's limits in AI Studio).
    rate_chat_per_min: int = _bounded_int("TT_RATE_CHAT_PER_MIN", 6, 0, 10_000)            # per client
    chat_per_client_per_day: int = _bounded_int("TT_CHAT_PER_CLIENT_PER_DAY", 60, 0, 100_000)
    chat_global_per_min: int = _bounded_int("TT_CHAT_GLOBAL_PER_MIN", 8, 0, 100_000)        # whole backend
    chat_global_per_day: int = _bounded_int("TT_CHAT_GLOBAL_PER_DAY", 200, 0, 1_000_000)    # whole backend (UTC day)


settings = Settings()
