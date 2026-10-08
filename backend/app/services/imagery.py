"""Canonical imagery service — the backend owns every imagery decision and every imagery URL.

Imagery is independent of analysis (imagery availability never implies an analysis, and an analysis
status never depends on imagery):

    GET /api/imagery?aoi=<id>&year=<y>        REAL Earth Engine imagery for that AOI and composite year:
                                              scene count -> composite (only if scenes > 0) -> tile URL.
                                              READY (tileUrl) or UNAVAILABLE (classified code, tileUrl null).
    GET /api/imagery/availability?aoi=<id>    per-year availability for the timeline, measured with the
                                              analysis' own observation rules (services/science.py):
        UNAVAILABLE   a source the composite needs has zero scenes
        INSUFFICIENT  scenes exist, but < MIN_YEAR_COVERAGE of the AOI has >= MIN_PIXEL_CLEAR_OBS clear
                      (and Dynamic World) observations — or coverage could not be measured
        AVAILABLE     the year meets the coverage rule
    GET /api/imagery/basemaps                 static base layers for the globe (never live, never analysis)

Nothing is invented: when Earth Engine cannot answer, the response says so (error / UNAVAILABLE).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import date, datetime, timezone
from typing import Any

from ..config import settings
from ..errors import public_error
from ..providers.earth_engine.provider import EarthEngineError, provider as ee_provider, split_available
from . import science as sc
from ..lru import LRUDict
from .analysis import _service_unavailable, analysis_target, aoi_doc
from .geometry import AoiError, validate_aoi

log = logging.getLogger("terratrace.imagery")
CACHE = settings.cache_dir / "imagery"
_availability: LRUDict = LRUDict(settings.memory_cache_entries)
_inflight: dict[str, asyncio.Future] = {}

# ----------------------------------------------------------------------------- reference sources (imagery only)
# The ONLY place imagery URLs exist. None of these is a TERRATRACE measurement, and none is live:
# they are static base layers for the globe view. AOI imagery comes only from Earth Engine (decide()).
GLOBE_MOSAIC_YEAR = 2025
GLOBE_MOSAIC = f"https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-{GLOBE_MOSAIC_YEAR}_3857/default/g/{{z}}/{{y}}/{{x}}.jpg"


def basemaps() -> dict[str, Any]:
    """Map base layers. Imagery/reference only — none of these is a TERRATRACE result."""
    return {
        "schema_version": "1.0",
        "note": "Base imagery and reference layers only. None of these layers is a TERRATRACE measurement.",
        "globe": {
            "kind": "basemap", "year": GLOBE_MOSAIC_YEAR, "tiles": [GLOBE_MOSAIC], "tile_size": 256, "max_zoom": 15,
            "label": f"Sentinel-2 cloudless {GLOBE_MOSAIC_YEAR} mosaic (EOX) — static basemap, not live imagery",
            "attribution": f"Sentinel-2 cloudless {GLOBE_MOSAIC_YEAR} — s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data)",
            "aoi_verified": False, "is_analysis": False,
        },
        "hires": {
            "kind": "basemap", "year": None, "tiles": ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            "tile_size": 256, "max_zoom": 19, "label": "Esri World Imagery (current, undated)",
            "attribution": "High-resolution imagery © Esri, Maxar, Earthstar Geographics", "aoi_verified": False, "is_analysis": False,
        },
        "labels": {
            "kind": "basemap", "year": None, "tiles": ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
            "tile_size": 256, "max_zoom": 19, "label": "Place labels", "attribution": "Labels © Esri", "aoi_verified": False, "is_analysis": False,
        },
        "reference_forest": {
            "kind": "reference", "year": 2000, "tiles": ["https://storage.googleapis.com/earthenginepartners-hansen/tiles/gfc_v1.4/tree_alpha/{z}/{x}/{y}.png"],
            "tile_size": 256, "max_zoom": 12, "label": "Tree cover 2000 (Hansen et al.) — reference, not a TERRATRACE detection",
            "attribution": "Tree cover 2000: Hansen/UMD/Google/USGS/NASA (CC BY 4.0)", "aoi_verified": False, "is_analysis": False,
        },
    }


# ----------------------------------------------------------------------------- availability
class ImageryError(Exception):
    """Availability could not be measured. Carries a public error; no status is invented."""

    def __init__(self, status: int, code: str, message: str | None = None, retryable: bool | None = None):
        super().__init__(code)
        self.status = status
        self.error = public_error(code, message, retryable)


def candidate_years() -> list[int]:
    """Composite years of the method (same list as the analysis)."""
    latest = min(date.today().year - 1, 2030)
    return sc.HIST_YEARS + list(range(sc.MODERN_FIRST_YEAR, latest + 1))


def _scene_count(year: int, scenes: dict[str, Any]) -> int:
    """Scenes of the composite's primary source (Landsat historical; cloud-scored Sentinel-2 modern)."""
    return int(scenes.get("landsat" if sc.era_of(year) == "historical" else "sentinel2") or 0)


def classify(years: list[int], counts: dict[str, dict[str, int]], coverage: dict[str, Any]) -> list[dict[str, Any]]:
    """Per-year status from REAL measurements (scene counts + observed-area coverage)."""
    _, no_scenes = split_available(years, counts)
    missing = {u["year"]: u["reason"] for u in no_scenes}
    aoi_ha = sc._num(coverage.get("aoi"))
    out = []
    for y in years:
        scenes = counts.get(str(y), {})
        s = sc.sensor_for(y)
        entry: dict[str, Any] = {
            "year": y, "era": sc.era_of(y), "source": s["label"], "composite": s["composite"] or f"{y} annual composite",
            "sceneCount": _scene_count(y, scenes), "scenes": scenes, "coverage": None, "status": "UNAVAILABLE", "reason": None,
        }
        if y in missing:
            entry["reason"] = missing[y]
        else:
            valid_ha = sc._num(coverage.get(f"valid_{y}"))
            cov = valid_ha / aoi_ha if valid_ha is not None and aoi_ha else None
            passes, reason = sc.assess_year(y, None, None, cov)
            entry.update(coverage=None if cov is None else round(cov, 4), status="AVAILABLE" if passes else "INSUFFICIENT", reason=reason)
        out.append(entry)
    return out


def _cache_key(aid: str, years: list[int]) -> str:
    return f"{aid}-{years[-1]}-{sc.METHOD_VERSION}"


def _load(key: str) -> dict[str, Any] | None:
    if key in _availability:
        return _availability[key]
    f = CACHE / f"{key}.json"
    if not f.exists():
        return None
    try:
        doc = json.loads(f.read_text(encoding="utf-8"))
    except ValueError:
        return None
    if doc.get("method_version") != sc.METHOD_VERSION:
        f.unlink(missing_ok=True)
        return None
    _availability[key] = doc
    return doc


def _save(key: str, doc: dict[str, Any]) -> None:
    _availability[key] = doc
    CACHE.mkdir(parents=True, exist_ok=True)
    (CACHE / f"{key}.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")


def purge_stale() -> int:
    """Delete cached availability from any other method version (called at startup)."""
    n = 0
    for f in CACHE.glob("*.json") if CACHE.exists() else []:
        try:
            ok = json.loads(f.read_text(encoding="utf-8")).get("method_version") == sc.METHOD_VERSION
        except ValueError:
            ok = False
        if not ok:
            f.unlink(missing_ok=True)
            n += 1
    return n


def cached_availability(aid: str) -> dict[str, Any] | None:
    return _load(_cache_key(aid, candidate_years()))


async def availability(aid: str) -> dict[str, Any]:
    """Measured per-year availability (cached per AOI and method version). Raises ImageryError when it cannot
    be measured — never a guessed status. Raises analysis.AnalysisNotFound for an unknown AOI."""
    aoi = aoi_doc(aid)
    years = candidate_years()
    key = _cache_key(aid, years)
    cached = _load(key)
    if cached:
        return cached
    if await asyncio.to_thread(_service_unavailable):
        raise ImageryError(503, "service_unavailable", "Imagery availability cannot be checked right now: live Earth observation is temporarily unavailable.")
    # Availability is measured over what is analysed (a featured region's declared subset, else the AOI), with the
    # same interactive limit as the analysis — checked BEFORE any computation.
    target = analysis_target(aoi)
    if (target.get("area_km2") or 0) > settings.interactive_max_km2:
        raise ImageryError(422, "analysis_too_large", "This area is too large to check imagery availability interactively. Try a smaller area.", False)
    if key in _inflight:
        return await asyncio.shield(_inflight[key])
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    _inflight[key] = fut
    try:
        doc = await _measure(aid, aoi, years, key)
        fut.set_result(doc)
        return doc
    except BaseException as e:
        fut.set_exception(e)
        raise
    finally:
        _inflight.pop(key, None)
        if fut.done() and not fut.cancelled():
            fut.exception()  # mark retrieved


async def _measure(aid: str, aoi: dict[str, Any], years: list[int], key: str) -> dict[str, Any]:
    deadline = time.monotonic() + settings.ee_timeout_s
    loop = asyncio.get_running_loop()
    work = loop.run_in_executor(None, lambda: ee_provider.measure_imagery(analysis_target(aoi)["geometry"], years, deadline=deadline))

    def build(raw: dict[str, Any]) -> dict[str, Any]:
        return {
            "aoi_id": aid, "method_version": sc.METHOD_VERSION, "provider": "Google Earth Engine",
            "measured_area": {"area_km2": analysis_target(aoi).get("area_km2"), "subset": analysis_target(aoi)["subset"]},
            "thresholds": {"min_pixel_clear_obs": sc.MIN_PIXEL_CLEAR_OBS, "min_pixel_dw_obs": sc.MIN_PIXEL_DW_OBS, "min_year_coverage": sc.MIN_YEAR_COVERAGE},
            "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "years": classify(years, raw["counts"], raw["coverage"]),
        }

    def keep_late(f: asyncio.Future) -> None:
        # EE requests cannot be cancelled: a measurement that finishes late is kept for the next request.
        if not f.cancelled() and f.exception() is None and key not in _availability:
            _save(key, build(f.result()))

    work.add_done_callback(keep_late)
    try:
        raw = await asyncio.wait_for(asyncio.shield(work), timeout=settings.ee_timeout_s)
    except (asyncio.TimeoutError, TimeoutError):
        raise ImageryError(504, "analysis_timeout", "Checking imagery availability exceeded the available computation window.") from None
    except EarthEngineError as e:
        log.warning("Imagery availability %s failed: %s — %s", aid, e.code, e.message)
        if e.code in ("ee_unconfigured", "ee_init_failed"):
            raise ImageryError(503, "service_unavailable", "Imagery availability cannot be checked right now: live Earth observation is temporarily unavailable.") from None
        if e.code == "analysis_timeout":
            raise ImageryError(504, "analysis_timeout", "Checking imagery availability exceeded the available computation window.") from None
        raise ImageryError(502, "imagery_check_failed") from None
    except Exception:  # noqa: BLE001 — Earth Engine / transport errors; detail stays in the log
        log.exception("Imagery availability failed for %s", aid)
        raise ImageryError(502, "imagery_check_failed") from None
    doc = build(raw)
    _save(key, doc)
    return doc


# ----------------------------------------------------------------------------- imagery decision (independent of analysis)
IMAGERY_MESSAGES = {
    "NO_SENTINEL2_IMAGERY": "No Sentinel-2 observations were found for the requested region and period.",
    "NO_LANDSAT_IMAGERY": "No Landsat observations were found for the requested region and period.",
    "INVALID_GEOMETRY": "The selected area is not a valid region for imagery.",
    "INVALID_DATE_RANGE": "TERRATRACE has no imagery period for this year.",
    "EARTH_ENGINE_AUTH_ERROR": "Live satellite imagery is unavailable: the imagery service is not connected.",
    "EARTH_ENGINE_PERMISSION_ERROR": "Live satellite imagery is unavailable: access to the imagery service was refused.",
    "EARTH_ENGINE_COMPUTATION_ERROR": "Live satellite imagery could not be prepared for this area and year.",
    "NETWORK_ERROR": "Live satellite imagery is unavailable: the imagery service could not be reached.",
}
# Imagery decisions per (AOI, year): small, and real scene counts of a completed year do not change (bounded anyway).
_decisions: LRUDict = LRUDict(settings.memory_cache_entries * 8)
# Imagery failures caused by Earth Engine itself (not by the data): a tile request may be retried.
TRANSIENT_CODES = {"EARTH_ENGINE_AUTH_ERROR", "EARTH_ENGINE_PERMISSION_ERROR", "EARTH_ENGINE_COMPUTATION_ERROR", "NETWORK_ERROR"}
# One in-flight decision per (AOI, year): a map requests a dozen tiles at once; they share one Earth Engine call.
_deciding: dict[tuple[str, int], asyncio.Future] = {}


def classify_ee_failure(status: str | None, detail: str | None) -> str:
    """Earth Engine failure -> public imagery code. The detail itself stays server-side."""
    msg = (detail or "").lower()
    if status == "unconfigured":
        return "EARTH_ENGINE_AUTH_ERROR"
    if any(k in msg for k in ("permission", "403", "not authorized", "access denied", "not registered", "forbidden")):
        return "EARTH_ENGINE_PERMISSION_ERROR"
    if any(k in msg for k in ("connection", "network", "unreachable", "name resolution", "ssl", "timed out", "max retries")):
        return "NETWORK_ERROR"
    if any(k in msg for k in ("credential", "authenticat", "invalid_grant", "401", "token", "initialisation failed", "not configured")):
        return "EARTH_ENGINE_AUTH_ERROR"
    return "EARTH_ENGINE_COMPUTATION_ERROR"


def _unavailable(base: dict[str, Any], code: str, **extra: Any) -> dict[str, Any]:
    return {**base, "status": "UNAVAILABLE", "code": code, "message": IMAGERY_MESSAGES[code], "tileUrl": None, **extra}


async def decide(aid: str, year: int) -> dict[str, Any]:
    """Real satellite imagery for an AOI and composite year — NEVER an analysis, never a substitute year.

    READY        scenes exist -> Earth Engine composite of exactly that year (tileUrl, sceneCount > 0)
    UNAVAILABLE  zero scenes (NO_SENTINEL2_IMAGERY / NO_LANDSAT_IMAGERY) or a classified failure; tileUrl = null
    Independent of /api/analysis: it does not wait for, or change, any analysis status.
    """
    aoi = aoi_doc(aid)   # AnalysisNotFound -> 404
    base: dict[str, Any] = {
        "aoi_id": aid, "year": year, "source": "Earth Engine", "is_analysis": False,
        # Timeline availability (observation coverage) when it has already been measured — never guessed.
        "imageryStatus": next((e["status"] for e in (cached_availability(aid) or {}).get("years", []) if e["year"] == year), None),
    }
    if year not in candidate_years():
        return _unavailable(base, "INVALID_DATE_RANGE")
    try:
        validate_aoi(aoi["geometry"], enforce_limits=False)
    except AoiError:
        return _unavailable(base, "INVALID_GEOMETRY")
    key = (aid, year)
    if key in _decisions:
        return {**_decisions[key], "imageryStatus": base["imageryStatus"]}
    status, detail = await asyncio.to_thread(ee_provider.status)
    if status != "ready":
        code = classify_ee_failure(status, detail)
        log.warning("Imagery %s %s unavailable: %s (%s)", aid, year, code, detail)
        return _unavailable(base, code)
    try:
        raw = await asyncio.wait_for(asyncio.to_thread(ee_provider.imagery_layer, aid, aoi["geometry"], year), timeout=settings.ee_timeout_s)
    except (asyncio.TimeoutError, TimeoutError):
        log.warning("Imagery %s %s exceeded %.0f s", aid, year, settings.ee_timeout_s)
        return _unavailable(base, "EARTH_ENGINE_COMPUTATION_ERROR")
    except Exception as e:  # noqa: BLE001 — ee.EEException / transport errors; detail stays in the log
        code = classify_ee_failure("error", f"{type(e).__name__}: {e}")
        log.warning("Imagery %s %s failed: %s (%s: %s)", aid, year, code, type(e).__name__, e)
        return _unavailable(base, code)
    info = {
        "dataset": raw["dataset"], "dateRange": raw["dateRange"], "sceneCount": raw["sceneCount"],
        "visualization": {"bands": raw["bands"], **ee_provider.IMAGERY_VIS, "units": "surface reflectance"},
        "cloudMask": "Cloud Score+ cs_cdf >= 0.6 per pixel" if sc.era_of(year) == "modern" else "Landsat QA_PIXEL cloud / shadow / dilated-cloud mask",
    }
    if raw["sceneCount"] == 0:
        decision = _unavailable(base, "NO_SENTINEL2_IMAGERY" if sc.era_of(year) == "modern" else "NO_LANDSAT_IMAGERY", **info)
    else:
        sensor = "Sentinel-2" if sc.era_of(year) == "modern" else "Landsat"
        decision = {
            **base, **info, "status": "READY", "code": None, "message": None,
            "tileUrl": f"/api/imagery/tiles/{aid}/{year}/{{z}}/{{x}}/{{y}}",
            "label": f"Live {sensor} imagery {year}", "attribution": "Contains modified Copernicus Sentinel data / USGS Landsat · composited in Google Earth Engine",
            "max_zoom": 15,
        }
    _decisions[key] = decision   # real scene counts for a completed year are stable; never an analysis
    return decision


async def tile_url(aid: str, year: int) -> str:
    """Earth Engine tile template — only for a year whose imagery decision is READY (scenes > 0).

    The decision is NOT required to be in memory: after a backend restart (or for a link opened directly) it is
    re-created from the same real inputs (scene count + map ID). Concurrent tile requests share one re-creation."""
    key = (aid, year)
    d = _decisions.get(key)
    if d is None:
        fut = _deciding.get(key)
        if fut is None:
            fut = asyncio.ensure_future(decide(aid, year))
            _deciding[key] = fut
            fut.add_done_callback(lambda _f: _deciding.pop(key, None))
        d = await asyncio.shield(fut)
    if d and d["status"] != "READY" and d.get("code") in TRANSIENT_CODES:
        # Earth Engine itself failed (network / auth / computation): transient, so the tile loader retries it
        # instead of treating it as "no imagery exists" (a 404 would leave a permanent black tile).
        raise ImageryError(503, "tiles_unavailable", "Satellite imagery is temporarily unavailable.", True)
    if not d or d["status"] != "READY":
        raise ImageryError(404, "tiles_unavailable", "No satellite imagery for this year.", False)
    url = ee_provider.cached_imagery_url(aid, year)
    if url is None:   # map IDs expire with the process; rebuild from the same real inputs
        raw = await asyncio.to_thread(ee_provider.imagery_layer, aid, aoi_doc(aid)["geometry"], year)
        url = raw["tileUrl"]
    if not url:
        raise ImageryError(404, "tiles_unavailable", "No satellite imagery for this year.", False)
    return url
