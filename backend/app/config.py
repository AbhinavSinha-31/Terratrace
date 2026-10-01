"""Runtime configuration. Everything secret comes from the environment (or backend/.env)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from . import __version__

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
load_dotenv(BACKEND_DIR / ".env")


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    version: str = __version__
    frontend_dist: Path = REPO_DIR / "frontend" / "dist"
    cache_dir: Path = Path(os.environ.get("TT_CACHE_DIR", BACKEND_DIR / ".cache"))

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
    analysis_workers: int = int(_float("TT_ANALYSIS_WORKERS", 3))
    # Largest AOI accepted for an INTERACTIVE (synchronous) analysis. Measured 2026-09-27 (tt-ee-2.0): AOIs up to
    # 1,215 km² completed within the 120 s window; 1,773 km² and 1,822 km² exceeded it on cold runs.
    # Every composite year is always computed, so the requested window does not change the cost.
    interactive_max_km2: float = _float("TT_INTERACTIVE_MAX_KM2", 1500.0)
    # Concurrent Earth Engine requests per analysis stage. 1 = one combined request per stage (default).
    # >1 is an UNVERIFIED optimisation (A/B interrupted 2026-09-27: project entered EE restricted mode).
    ee_parallel_requests: int = int(_float("EE_PARALLEL_REQUESTS", 1))

    # Developer diagnostics in API responses (stage / error type / timing; never secrets). Local only.
    dev_diagnostics: bool = os.environ.get("DEV_DIAGNOSTICS", "false").strip().lower() in ("1", "true", "yes")

    # AI explanation provider (optional — an offline deterministic provider is always available).
    llm_model: str = os.environ.get("TERRATRACE_LLM_MODEL", "claude-opus-5")
    llm_effort: str = os.environ.get("TERRATRACE_LLM_EFFORT", "low")

    # Place search (OpenStreetMap Nominatim; offline gazetteer is always available).
    geocoder_enabled: bool = os.environ.get("TT_GEOCODER", "nominatim") != "off"
    user_agent: str = field(default_factory=lambda: os.environ.get("TT_USER_AGENT", f"TERRATRACE-prototype/{__version__} (university innovation expo)"))

    cors_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")


settings = Settings()
