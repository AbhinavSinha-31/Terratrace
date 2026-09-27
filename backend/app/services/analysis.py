"""Analysis orchestration — one scientific path: Google Earth Engine.

Every response is an envelope:

    {
      "analysis_id": "...",
      "dataMode": "LIVE",
      "analysisStatus": "READY" | "UNAVAILABLE" | "INVALID_ANALYSIS" | "PROCESSING" | "ERROR",
      "reason": "...", "reasonCode": "...",      # when not READY
      "aoi": {...},                               # the geometry analysed (+ its geodesic area)
      "window": {"baseline_year": .., "comparison_year": ..},
      "source": {"landsat": .., "sentinel2": .., "dynamicWorld": .., "hansen": ..},
      "quality": {...},                          # observation coverage per year + validity issues
      "summary": {...}, "events": {...}, "layers": {...}   # ONLY when READY
    }

There is no simulated or fallback scientific data anywhere in this path: if Earth
Engine is not configured, fails, or has no usable imagery, the envelope says so
and carries no metrics. READY additionally requires sufficient observations and
passing every validity check in services/science.py — a finished computation is not enough.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from ..config import settings
from ..errors import diagnostics, public_error
from ..providers import registry
from ..providers.earth_engine.provider import RESTRICTED_MODE, EarthEngineError, provider as ee_provider
from . import science as sc
from .geometry import Aoi, AoiError, validate_aoi

log = logging.getLogger("terratrace.analysis")
AOIS = settings.cache_dir / "aois"
RESULTS = settings.cache_dir / "results"
_results: dict[str, dict[str, Any]] = {}

NO_SOURCES = {"landsat": False, "sentinel2": False, "dynamicWorld": False, "hansen": False}


class AnalysisNotFound(KeyError):
    pass


# ----------------------------------------------------------------------------- AOIs
def _custom_aoi_doc(aid: str, aoi: Aoi, name: str | None) -> dict[str, Any]:
    lon, lat = aoi.centroid
    return {
        "id": aid, "name": name or "Custom area of interest", "short_name": (name or "Custom area")[:28],
        "region": f"{abs(lat):.3f}°{'N' if lat >= 0 else 'S'}, {abs(lon):.3f}°{'E' if lon >= 0 else 'W'}",
        "country": None, "biome": None, "description": "User-defined area of interest.", "tags": ["Custom AOI"],
        "bbox": list(aoi.bbox), "center": [lon, lat], "geometry": aoi.geometry,
        "area_km2": round(aoi.area_km2, 2), "area_ha": round(aoi.area_ha, 1),
        "thumbnail_url": "", "featured": False, "custom": True,
    }


def register_aoi(geometry: dict[str, Any], name: str | None) -> tuple[str, dict[str, Any]]:
    """Validate a user AOI and persist its definition (so links/refreshes resolve)."""
    aoi = validate_aoi(geometry)
    aid = f"aoi-{aoi.fingerprint()}"
    doc = _custom_aoi_doc(aid, aoi, name)
    AOIS.mkdir(parents=True, exist_ok=True)
    (AOIS / f"{aid}.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return aid, doc


def aoi_doc(aid: str) -> dict[str, Any]:
    feat = registry.get(aid)
    if feat:
        return feat
    f = AOIS / f"{aid}.json"
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    raise AnalysisNotFound(aid)


# ----------------------------------------------------------------------------- envelopes
def _envelope(aid: str, aoi: dict[str, Any], b: int, c: int, status: str, *, code: str | None = None,
              user_message: str | None = None, retryable: bool | None = None, result: dict[str, Any] | None = None,
              quality: dict[str, Any] | None = None, diag: dict[str, Any] | None = None) -> dict[str, Any]:
    """Public envelope. For every non-READY status `error` = {code, user_message, retryable}; `reason`/`reasonCode`
    mirror it. Only text TERRATRACE wrote is ever placed in user_message (see app/errors.py)."""
    error = None if status == "READY" else public_error(code or "analysis_failed", user_message, retryable)
    env: dict[str, Any] = {
        "analysis_id": aid,
        "dataMode": "LIVE",
        "analysisStatus": status,
        "reason": error["user_message"] if error else None,
        "reasonCode": error["code"] if error else None,
        "error": error,
        "aoi": aoi,
        "window": {"baseline_year": b, "comparison_year": c},
        "source": dict(NO_SOURCES),
        # Observation quality (scene counts, coverage, pass/fail reasons) — never forest/change metrics.
        "quality": quality,
    }
    if diag:
        env["diagnostics"] = diag
    if status == "READY" and result:
        env["source"] = {"landsat": True, "sentinel2": True, "dynamicWorld": True, "hansen": True}
        env.update(summary=result["summary"], events=result["events"], layers=result["layers"])
    elif quality is not None:
        env["source"] = {"landsat": True, "sentinel2": True, "dynamicWorld": True, "hansen": False}  # queried, not concluded
    return env


def _service_unavailable() -> bool:
    """True if live analysis cannot run. The detailed reason is logged, never returned."""
    status, detail = ee_provider.status()
    if status != "ready":
        log.warning("Live analysis unavailable: Earth Engine status=%s (%s)", status, detail)
        return True
    return False


def _from_result(aid: str, aoi: dict[str, Any], b: int, c: int, result: dict[str, Any]) -> dict[str, Any]:
    status = result["status"]
    if status == "READY":
        return _envelope(aid, aoi, b, c, "READY", result=result, quality=result.get("quality"))
    # Scientific outcomes: the reason is TERRATRACE's own rule text (coverage / validity), safe to show.
    return _envelope(aid, aoi, b, c, status, code=result.get("reasonCode"), user_message=result.get("reason"),
                     retryable=False, quality=result.get("quality"))


_inflight: dict[str, asyncio.Future] = {}
# Real progress: analysis key → {stage, started}; client request id → analysis key (joined requests share it).
_stage: dict[str, dict[str, Any]] = {}
_rid_key: dict[str, str] = {}


def progress(rid: str) -> dict[str, Any]:
    """Current REAL stage of the analysis a request id belongs to (None when unknown/finished)."""
    key = _rid_key.get(rid)
    st = _stage.get(key) if key else None
    if not st:
        return {"stage": None, "elapsed_s": None}
    return {"stage": st["stage"], "elapsed_s": round(time.monotonic() - st["started"], 1)}


async def run(aid: str, b: int, c: int, rid: str | None = None) -> dict[str, Any]:
    """Analyse an AOI (featured or registered custom) with Earth Engine."""
    if not (1984 <= b < c <= 2100):
        raise AoiError("invalid_window", "The comparison year must be after the baseline year.")
    aoi = aoi_doc(aid)
    if await asyncio.to_thread(_service_unavailable):  # may initialise EE (blocking)
        return _envelope(aid, aoi, b, c, "UNAVAILABLE", code="service_unavailable")

    key = _key(aid, b, c)
    if rid:
        _rid_key[rid] = key
        if len(_rid_key) > 500:   # bounded
            _rid_key.pop(next(iter(_rid_key)))
    cached = _results.get(key) or _load_result(key)
    if cached:
        return _from_result(aid, aoi, b, c, cached)

    # Workload guard BEFORE any computation: never start what cannot finish interactively.
    if aoi.get("area_km2", 0) > settings.interactive_max_km2:
        log.info("Analysis %s refused: %.0f km² > interactive limit %.0f km²", aid, aoi["area_km2"], settings.interactive_max_km2)
        return _envelope(aid, aoi, b, c, "UNAVAILABLE", code="analysis_too_large",
                         diag=diagnostics(stage="workload_guard", area_km2=aoi["area_km2"], limit_km2=settings.interactive_max_km2))

    # Identical concurrent requests share ONE computation (no duplicate Earth Engine jobs).
    if key in _inflight:
        return await asyncio.shield(_inflight[key])
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    _inflight[key] = fut
    _stage[key] = {"stage": "validating_aoi", "started": time.monotonic()}
    try:
        env = await _compute(aid, aoi, b, c, key)
        fut.set_result(env)
        return env
    except BaseException as e:
        fut.set_exception(e)
        raise
    finally:
        _inflight.pop(key, None)
        _stage.pop(key, None)
        if fut.done() and not fut.cancelled():
            fut.exception()  # mark retrieved


async def _compute(aid: str, aoi: dict[str, Any], b: int, c: int, key: str) -> dict[str, Any]:
    t0 = time.monotonic()
    deadline = t0 + settings.ee_timeout_s   # the provider stops at its next stage once this passes
    try:
        geom = validate_aoi(aoi["geometry"], enforce_limits=False)
        def on_stage(name: str) -> None:
            if key in _stage:
                _stage[key]["stage"] = name

        loop = asyncio.get_running_loop()
        work = loop.run_in_executor(None, lambda: ee_provider.analyze(geom, aid, aoi["name"], b, c, deadline=deadline, on_stage=on_stage))

        def keep_late_result(f: asyncio.Future) -> None:
            # An Earth Engine request cannot be cancelled once sent. If the analysis finishes after the
            # interactive window, keep its (deterministic, method-versioned) outcome so a Retry returns it
            # immediately instead of starting the same computation again.
            if f.cancelled() or f.exception() is not None or key in _results:
                return
            res = f.result()
            if res.get("status") in ("READY", "UNAVAILABLE", "INVALID_ANALYSIS") and not res.get("diagnostic"):
                _results[key] = res
                _save_result(key, res, aoi["geometry"])
                log.info("Analysis %s %s-%s finished after the interactive window; result cached for retry", aid, b, c)

        work.add_done_callback(keep_late_result)
        result = await asyncio.wait_for(asyncio.shield(work), timeout=settings.ee_timeout_s)
    except (asyncio.TimeoutError, TimeoutError):
        log.warning("Analysis %s %s-%s exceeded the %.0f s interactive window", aid, b, c, settings.ee_timeout_s)
        return _envelope(aid, aoi, b, c, "ERROR", code="analysis_timeout",
                         diag=diagnostics(stage="earth_engine", elapsed_s=round(time.monotonic() - t0, 1), limit_s=settings.ee_timeout_s,
                                          ee_restricted_mode=RESTRICTED_MODE["seen_at"] is not None))
    except EarthEngineError as e:
        log.warning("Analysis %s failed: %s — %s", aid, e.code, e.message)
        code = {"no_imagery": "insufficient_imagery", "ee_unconfigured": "service_unavailable", "ee_init_failed": "service_unavailable",
                "analysis_timeout": "analysis_timeout"}.get(e.code, "analysis_failed")
        status = "UNAVAILABLE" if code in ("insufficient_imagery", "service_unavailable") else "ERROR"
        return _envelope(aid, aoi, b, c, status, code=code, diag=diagnostics(stage="earth_engine", error_type=e.code, elapsed_s=round(time.monotonic() - t0, 1)))
    except Exception as e:  # noqa: BLE001 — Earth Engine raises ee.EEException and transport errors
        log.exception("Earth Engine analysis failed for %s", aid)   # full detail stays server-side
        return _envelope(aid, aoi, b, c, "ERROR", code="analysis_failed",
                         diag=diagnostics(stage="earth_engine", error_type=type(e).__name__, elapsed_s=round(time.monotonic() - t0, 1)))
    # Deterministic scientific outcomes (READY / UNAVAILABLE / INVALID_ANALYSIS) are cached per method version.
    _results[key] = result
    _save_result(key, result, aoi["geometry"])
    return _from_result(aid, aoi, b, c, result)

# ----------------------------------------------------------------------------- result cache (method-versioned)
def _key(aid: str, b: int, c: int) -> str:
    return f"{aid}-{b}-{c}-{sc.METHOD_VERSION}"


def _save_result(key: str, result: dict[str, Any], geometry: dict[str, Any]) -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    doc = {k: result.get(k) for k in ("status", "reasonCode", "reason", "quality", "summary", "events", "layers")}
    doc["method_version"] = sc.METHOD_VERSION
    doc["geometry"] = geometry
    (RESULTS / f"{key}.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")


def _load_result(key: str) -> dict[str, Any] | None:
    """A cached result is reused only if it was produced by the CURRENT scientific method."""
    f = RESULTS / f"{key}.json"
    if not f.exists():
        return None
    try:
        doc = json.loads(f.read_text(encoding="utf-8"))
    except ValueError:
        return None
    if doc.get("method_version") != sc.METHOD_VERSION or doc.get("status") not in ("READY", "UNAVAILABLE", "INVALID_ANALYSIS"):
        log.info("Discarding cached result %s from method %s", key, doc.get("method_version"))
        f.unlink(missing_ok=True)
        return None
    if doc["status"] == "READY":
        ee_provider._requests[doc["summary"]["aoi"]["id"]] = {"geometry": doc["geometry"]}  # lazy tile rebuild
    _results[key] = doc
    return doc


def purge_stale_results() -> int:
    """Delete cached results from any other method version (called at startup)."""
    n = 0
    for f in RESULTS.glob("*.json") if RESULTS.exists() else []:
        try:
            ok = json.loads(f.read_text(encoding="utf-8")).get("method_version") == sc.METHOD_VERSION
        except ValueError:
            ok = False
        if not ok:
            f.unlink(missing_ok=True)
            n += 1
    return n

def preview(geometry: dict[str, Any]) -> dict[str, Any]:
    """Cheap, non-analytical AOI preview: validity, geodesic area, Hansen reference tree cover."""
    from ..providers.reference import hansen
    from .geometry import in_aoi

    try:
        aoi = validate_aoi(geometry)
        valid, code, message = True, None, None
    except AoiError as e:
        try:
            aoi = validate_aoi(geometry, enforce_limits=False)
        except AoiError:
            return {"valid": False, "code": e.code, "message": e.message}
        valid, code, message = False, e.code, e.message
    forest = None
    if aoi.area_km2 <= 50000:
        forest = hansen.tree_cover_fraction(aoi.bbox, lambda lon, lat: in_aoi(lon, lat, aoi.geometry))
    return {
        "valid": valid, "code": code, "message": message,
        "area_km2": round(aoi.area_km2, 2), "area_ha": round(aoi.area_ha, 1),
        "centroid": aoi.centroid, "bbox": aoi.bbox,
        "forest_cover_pct": forest,
        "forest_source": "Hansen et al. tree cover 2000 (≥ 30 % canopy) — reference, not a TERRATRACE detection" if forest is not None else None,
    }


DEFAULT_WINDOW = sc.DEFAULT_EVENT_WINDOW
