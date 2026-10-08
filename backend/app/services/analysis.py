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
import concurrent.futures
import json
import logging
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from ..config import settings
from ..errors import diagnostics, public_error
from ..lru import LRUDict
from ..providers import registry
from ..providers.earth_engine.provider import RESTRICTED_MODE, EarthEngineError, provider as ee_provider
from . import science as sc
from .geometry import Aoi, AoiError, validate_aoi

log = logging.getLogger("terratrace.analysis")
AOIS = settings.cache_dir / "aois"
RESULTS = settings.cache_dir / "results"
# In-memory copies of the method-versioned result files (bounded; evicted entries are re-read from disk).
_results: LRUDict = LRUDict(settings.memory_cache_entries)

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


CUSTOM_AOI_ID = re.compile(r"aoi-[0-9a-f]{12}")


def aoi_doc(aid: str) -> dict[str, Any]:
    feat = registry.get(aid)
    if feat:
        return feat
    # Only ids this backend generates (register_aoi) map to a file: the id comes from the URL, so anything else
    # (e.g. "..\\..\\x") would otherwise read an arbitrary .json file from disk.
    if not CUSTOM_AOI_ID.fullmatch(aid):
        raise AnalysisNotFound(aid)
    f = AOIS / f"{aid}.json"
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    raise AnalysisNotFound(aid)


def analysis_target(aoi: dict[str, Any]) -> dict[str, Any]:
    """What is actually analysed for an AOI.

    A featured region larger than the interactive limit may declare an `analysis_area` (a defined subset, e.g. its
    central ~1,000 km²): then only that subset is analysed and the full region is shown for context. Every other AOI
    is analysed as drawn. Nothing about the region outside the subset is ever reported.
    """
    sub = aoi.get("analysis_area")
    if sub:
        return {"geometry": sub["geometry"], "area_km2": sub["area_km2"], "area_ha": sub.get("area_ha"), "subset": True,
                "region_area_km2": aoi.get("area_km2"), "basis": sub.get("basis"), "bbox": sub.get("bbox")}
    return {"geometry": aoi["geometry"], "area_km2": aoi.get("area_km2"), "area_ha": aoi.get("area_ha"), "subset": False,
            "region_area_km2": aoi.get("area_km2"), "basis": None, "bbox": aoi.get("bbox")}


def analysis_area_info(aoi: dict[str, Any]) -> dict[str, Any]:
    """Public description of the analysed area (included in every envelope, whatever the status)."""
    t = analysis_target(aoi)
    info = {k: t[k] for k in ("area_km2", "area_ha", "subset", "region_area_km2", "basis", "bbox")}
    if t["subset"]:
        info["geometry"] = t["geometry"]
    return info


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
        # What was (or would be) analysed: the AOI itself, or a featured region's declared subset.
        "analysis_area": analysis_area_info(aoi),
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


def _area_limit(aoi: dict[str, Any]) -> dict[str, Any] | None:
    """Deterministic AOI validation: the interactive area limit applies to EVERY area (featured or drawn), before any
    stored result is read or any Earth Engine work starts. Returns the limit facts when the area exceeds it."""
    area = analysis_target(aoi).get("area_km2")
    if area is None or area <= settings.interactive_max_km2:
        return None
    return {"selected_area_km2": round(float(area), 1), "maximum_area_km2": round(float(settings.interactive_max_km2), 1)}


def _too_large_envelope(aid: str, aoi: dict[str, Any], b: int, c: int, limit: dict[str, Any]) -> dict[str, Any]:
    km2 = lambda v: f"{int(v + 0.5):,}"   # round half up (1,822.5 -> 1,823), as the UI does
    msg = (f"Analysis area exceeds TerraTrace's {km2(limit['maximum_area_km2'])} km² limit "
           f"(selected area: {km2(limit['selected_area_km2'])} km²). Select a smaller area. No forest-change analysis was run.")
    env = _envelope(aid, aoi, b, c, "UNAVAILABLE", code="analysis_too_large", user_message=msg, retryable=False,
                    diag=diagnostics(stage="workload_guard", area_km2=limit["selected_area_km2"], limit_km2=limit["maximum_area_km2"]))
    env["limits"] = limit
    return env


EE_HOST = "earthengine.googleapis.com"
NETWORK_MARKERS = ("NameResolutionError", "getaddrinfo", "Failed to resolve", "Max retries exceeded", "ConnectionError",
                   "ConnectionResetError", "ConnectionRefused", "RemoteDisconnected", "timed out", "Network is unreachable")
THROTTLE_MARKERS = ("Too Many Requests", "concurrency limit", "RESOURCE_EXHAUSTED", "429")


def _ee_reachable() -> bool:
    """Instant, free check that the Earth Engine host resolves (DNS). A machine without a working connection
    fails here immediately instead of after minutes of client retries."""
    import socket
    try:
        socket.getaddrinfo(EE_HOST, 443)
        return True
    except OSError as e:
        log.warning("Earth Engine host %s is not reachable: %s", EE_HOST, e)
        return False


def classify_failure(e: BaseException) -> str:
    """Public code for a failed Earth Engine computation, by its real cause (the detail itself stays in the log)."""
    text = f"{type(e).__name__}: {e}"
    if any(m in text for m in NETWORK_MARKERS):
        return "earth_engine_unreachable"
    if any(m in text for m in THROTTLE_MARKERS):
        return "earth_engine_throttled"
    return "analysis_failed"


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
        sc.upgrade_result(result)   # explicit metric fields for results stored before they existed (same values)
        return _envelope(aid, aoi, b, c, "READY", result=result, quality=result.get("quality"))
    # Scientific outcomes: the reason is TERRATRACE's own rule text (coverage / validity), safe to show.
    return _envelope(aid, aoi, b, c, status, code=result.get("reasonCode"), user_message=result.get("reason"),
                     retryable=False, quality=result.get("quality"))


# ----------------------------------------------------------------------------- analysis jobs
# Every analysis is a JOB. Its whole lifecycle (validation, cache lookup, Earth Engine computation, persistence,
# envelope) runs in a dedicated worker pool, so no HTTP request is held open for the computation and analyses
# never queue behind tile/imagery work. Job state is thread-safe and event-loop independent: the async job API
# polls it, and the legacy synchronous endpoint (`run`) simply waits for the same job for ee_timeout_s.
#
# Stages are REAL (reported by the provider as it starts each Earth Engine request) — never estimated.
JOB_STAGES = {  # provider stage -> public job stage
    "validating_aoi": "VALIDATING", "preparing_imagery": "PREPARING_IMAGERY", "measuring_coverage": "MEASURING_OBSERVATION_COVERAGE",
    "measuring_forest": "MEASURING_FOREST_COVER", "detecting_change": "DETECTING_CHANGE", "validating_result": "VALIDATING_RESULT",
}
TERMINAL = {"READY", "INVALID_ANALYSIS", "UNAVAILABLE", "ERROR", "CANCELLED"}
# Stages after the LAST Earth Engine request. Cancellation exists to avoid starting more Earth Engine work; past this
# point there is none left, so a job that timed out / was cancelled meanwhile still validates and caches its result
# (its reported terminal state is unchanged) and a Retry returns it instead of recomputing everything.
NO_EE_WORK_LEFT = {"validating_result"}


class AnalysisCancelled(Exception):
    pass


class Job:
    def __init__(self, aid: str, aoi: dict[str, Any], b: int, c: int, key: str):
        self.id = uuid.uuid4().hex[:16]
        self.aid, self.aoi, self.b, self.c, self.key = aid, aoi, b, c, key
        self.created = time.monotonic()
        self.status = "QUEUED"          # QUEUED | RUNNING | terminal
        self.stage = "QUEUED"           # public stage
        self.provider_stage: str | None = None
        self.stages: list[dict[str, Any]] = []
        self.envelope: dict[str, Any] | None = None
        self.cancel = threading.Event()
        self.future: concurrent.futures.Future | None = None
        self.finished: float | None = None
        self._lock = threading.Lock()

    # -- state transitions (thread-safe) ---------------------------------------------------------
    def enter(self, provider_stage: str) -> None:
        if self.cancel.is_set() and provider_stage not in NO_EE_WORK_LEFT:
            raise AnalysisCancelled()
        now = time.monotonic()
        with self._lock:
            # A terminal state is final (ERROR / CANCELLED never turn into RUNNING and then READY): a worker that keeps
            # going after a timeout or cancel only finishes its computation, for the result cache.
            if self.status in TERMINAL:
                return
            if self.stages:
                self.stages[-1]["duration_s"] = round(now - self.stages[-1]["t"], 2)
                log.info("[%s] %s %.1fs", self.id, self.stages[-1]["stage"], self.stages[-1]["duration_s"])
            self.provider_stage = provider_stage
            self.stage = JOB_STAGES.get(provider_stage, provider_stage.upper())
            self.status = "RUNNING"
            self.stages.append({"stage": self.stage, "t": now, "duration_s": None})

    def finish(self, envelope: dict[str, Any] | None, status: str | None = None) -> None:
        now = time.monotonic()
        with self._lock:
            if self.status in TERMINAL:      # e.g. already CANCELLED / timed out: keep the first terminal state
                return
            if self.stages and self.stages[-1]["duration_s"] is None:
                self.stages[-1]["duration_s"] = round(now - self.stages[-1]["t"], 2)
            self.envelope = envelope
            self.status = status or (envelope or {}).get("analysisStatus", "ERROR")
            self.stage = self.status
            self.provider_stage = None
            self.finished = now
        log.info("[%s] %s total=%.1fs area_km2=%s aoi=%s window=%s-%s", self.id, self.status, now - self.created,
                 self.aoi.get("area_km2"), self.aid, self.b, self.c)
        log.info("ANALYSIS_SUMMARY %s", json.dumps(self.summary_record(), ensure_ascii=False, default=str))

    def summary_record(self) -> dict[str, Any]:
        """One structured record per finished job: what was analysed, what Earth Engine measured about the observations,
        the validation outcome and the final state. Facts only — never credentials, tokens or raw error text."""
        env = self.envelope or {}
        q = env.get("quality") or {}
        years = [{"year": y.get("year"), "scenes": y.get("scenes"), "clear_obs_median": y.get("clear_obs_median"),
                  "coverage_pct": y.get("coverage_pct"), "seasonal_coverage_pct": y.get("seasonal_coverage_pct"),
                  "passes": y.get("passes")} for y in q.get("years") or []]
        return {
            "job_id": self.id, "analysis_id": self.aid, "investigation": self.aoi.get("name"),
            "geometry_bbox": analysis_target(self.aoi).get("bbox") if self.aoi.get("geometry") else None,
            "area_km2": analysis_target(self.aoi).get("area_km2") if self.aoi.get("geometry") else self.aoi.get("area_km2"),
            "requested_window": [self.b, self.c], "analysable_window": q.get("analyzable_window"),
            "datasets": "Sentinel-2 SR Harmonized + Cloud Score+ + Dynamic World V1 (modern); Landsat C2 L2 (historical)",
            "method_version": sc.METHOD_VERSION, "years": years,
            "stages": [{"stage": s["stage"], "duration_s": s["duration_s"]} for s in self.stages],
            "validation": {"issues": [{"rule": i.get("rule"), "years": i.get("years"), "evidence": i.get("evidence")} for i in q.get("issues") or []]},
            "state": self.status, "reason_code": env.get("reasonCode"),
            "elapsed_s": round((self.finished or time.monotonic()) - self.created, 1),
        }

    @property
    def done(self) -> bool:
        return self.status in TERMINAL

    def public(self) -> dict[str, Any]:
        now = time.monotonic()
        return {
            "job_id": self.id, "analysis_id": self.aid, "window": {"baseline_year": self.b, "comparison_year": self.c},
            "status": self.status if self.done else ("QUEUED" if self.status == "QUEUED" else "PROCESSING"),
            "stage": self.stage,
            "elapsed_s": round((self.finished or now) - self.created, 1),
            "stages": [{"stage": s["stage"], "duration_s": s["duration_s"]} for s in self.stages],
            "result": self.envelope if self.done else None,
        }


_jobs: dict[str, Job] = {}
_active: dict[str, Job] = {}            # analysis key -> the job currently computing it
_jobs_lock = threading.Lock()
_rid_key: dict[str, str] = {}           # client request id -> analysis key (legacy progress endpoint)
_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, int(settings.analysis_workers)), thread_name_prefix="tt-analysis")


def _job_budget() -> float:
    """Longest a job may compute: the interactive window plus one bounded Earth Engine request."""
    return settings.ee_timeout_s + settings.ee_request_deadline_s


# ----------------------------------------------------------------------------- pre-flight (custom areas)
# Sentinel-2 MSI systematically acquires land between 56° S and 84° N (ESA mission specification); Dynamic World is
# derived from it. Outside that band there is nothing to composite, so the area is refused before any work.
S2_LAT_MIN, S2_LAT_MAX = -56.0, 84.0
# Below this share of reference tree cover (Hansen 2000, >= 30 % canopy) an area has no forest to analyse. A gate on
# WHETHER to run, never a result: an unmeasured tree cover does not block (the analysis then decides honestly).
MIN_FOREST_PCT = 1.0
_preflight_cache: LRUDict = LRUDict(settings.memory_cache_entries)


def coverage_refusal(bbox: Any) -> tuple[str, str] | None:
    """Refusal if any part of the area lies outside Sentinel-2's systematic acquisition band."""
    _, s, _, n = bbox
    if s >= S2_LAT_MIN and n <= S2_LAT_MAX:
        return None
    lat = (s + n) / 2
    return "outside_sentinel2_coverage", (
        f"This area is at {abs(lat):.2f}° {'S' if lat < 0 else 'N'}, outside Sentinel-2 coverage (land between 56° S and 84° N), "
        "so there is no imagery to analyse. Choose an area within that range.")


def forest_refusal(tree_cover_pct: float | None) -> tuple[str, str] | None:
    """Refusal if the MEASURED reference tree cover is below MIN_FOREST_PCT (None = not measured: never refused)."""
    if tree_cover_pct is None or tree_cover_pct >= MIN_FOREST_PCT:
        return None
    return "no_forest", (
        f"Reference tree cover is {tree_cover_pct:.1f} % of this area (Hansen et al., year 2000, ≥ 30 % canopy), so there is "
        "essentially no forest to analyse. Choose a forested area.")


def preflight(aoi: dict[str, Any]) -> tuple[str, str] | None:
    """(code, message) if a custom area cannot yield a forest-change analysis, else None. Featured investigations are
    curated and skip it. Coverage is checked first (no network); tree cover is the Hansen reference preview."""
    if not aoi.get("custom"):
        return None
    refused = coverage_refusal(aoi["bbox"])
    if refused:
        return refused
    key = aoi["id"]
    if key not in _preflight_cache:
        from ..providers.reference import hansen
        from .geometry import in_aoi
        geom = aoi["geometry"]
        _preflight_cache[key] = hansen.tree_cover_fraction(tuple(aoi["bbox"]), lambda lon, lat: in_aoi(lon, lat, geom))
    return forest_refusal(_preflight_cache[key])


def create_job(aid: str, b: int, c: int, rid: str | None = None) -> Job:
    """Create (or join) the analysis job for an AOI and window. Returns immediately.
    Raises AoiError for an invalid window or an area that cannot be analysed (pre-flight), and AnalysisNotFound for an
    unknown AOI — all before any job exists."""
    if not (1984 <= b < c <= 2100):
        raise AoiError("invalid_window", "The comparison year must be after the baseline year.")
    aoi = aoi_doc(aid)
    refused = preflight(aoi)
    if refused:
        log.info("Pre-flight refused %s: %s", aid, refused[0])
        raise AoiError(*refused)
    key = _key(aid, b, c)
    if rid:
        _rid_key[rid] = key
        if len(_rid_key) > 500:   # bounded
            _rid_key.pop(next(iter(_rid_key)))
    with _jobs_lock:
        running = _expire_if_overdue(_active.get(key))
        # Identical requests share ONE job (no duplicate Earth Engine work) — unless that job has exceeded its whole
        # budget without finishing (a hung request): then it is abandoned and a fresh job starts.
        if running is not None and not running.done and time.monotonic() - running.created < _job_budget():
            log.info("[%s] joined by a new request for %s %s-%s", running.id, aid, b, c)
            return running
        if running is not None and not running.done:
            log.warning("[%s] exceeded %.0f s without finishing; starting a fresh job", running.id, _job_budget())
        job = Job(aid, aoi, b, c, key)
        _jobs[job.id] = job
        _active[key] = job
        if len(_jobs) > 300:   # bounded registry: forget the oldest finished jobs
            for jid in [j for j, x in _jobs.items() if x.done][:100]:
                _jobs.pop(jid, None)
    log.info("[%s] QUEUED aoi=%s area_km2=%s window=%s-%s", job.id, aid, aoi.get("area_km2"), b, c)
    job.future = _POOL.submit(_execute, job)
    return job


def _expire_if_overdue(job: Job | None) -> Job | None:
    """A job past its whole budget is finished as an honest timeout (ERROR, retryable), whoever looks at it first —
    the poll, the stored-status read, the progress read or a new request for the same analysis. So no job can stay
    QUEUED / RUNNING indefinitely, even if its worker is blocked in an Earth Engine call or nobody polls it."""
    if job is not None and not job.done and time.monotonic() - job.created > _job_budget():
        job.cancel.set()   # the worker stops at its next stage boundary
        job.finish(_envelope(job.aid, job.aoi, job.b, job.c, "ERROR", code="analysis_timeout",
                             user_message="Earth Engine did not complete the analysis in time (request timed out). No forest-change measurements were generated."))
    return job


def get_job(job_id: str) -> Job | None:
    return _expire_if_overdue(_jobs.get(job_id))


def cancel_job(job_id: str) -> Job | None:
    job = _jobs.get(job_id)
    if job is not None and not job.done:
        job.cancel.set()      # the worker stops at its next stage boundary (an in-flight EE request cannot be aborted)
        job.finish(None, status="CANCELLED")
        log.info("[%s] CANCELLED by the user", job.id)
    return job


def _execute(job: Job) -> None:
    """Worker: the complete lifecycle of one analysis job (runs in the analysis pool)."""
    aid, aoi, b, c, key = job.aid, job.aoi, job.b, job.c, job.key
    t0 = time.monotonic()
    try:
        # VALIDATING — geometry, coordinates and limits only (no Earth Engine call).
        job.enter("validating_aoi")
        geom = validate_aoi(analysis_target(aoi)["geometry"], enforce_limits=False)
        # Workload guard FIRST: an area over the limit is never analysed, and a result stored before the limit
        # existed is never served for it (same rule for featured and drawn areas).
        limit = _area_limit(aoi)
        if limit:
            log.info("[%s] refused: %.0f km² > interactive limit %.0f km²", job.id, limit["selected_area_km2"], limit["maximum_area_km2"])
            job.finish(_too_large_envelope(aid, aoi, b, c, limit))
            return
        cached = _results.get(key) or _load_result(key)
        if cached:
            job.finish(_from_result(aid, aoi, b, c, cached))
            return
        if _service_unavailable():
            job.finish(_envelope(aid, aoi, b, c, "UNAVAILABLE", code="service_unavailable"))
            return
        if not _ee_reachable():
            job.finish(_envelope(aid, aoi, b, c, "UNAVAILABLE", code="earth_engine_unreachable"))
            return
        deadline = t0 + _job_budget()   # the provider stops at its next stage once this passes
        result = ee_provider.analyze(geom, aid, aoi["name"], b, c, deadline=deadline, on_stage=job.enter)
        # Deterministic scientific outcomes (READY / UNAVAILABLE / INVALID_ANALYSIS) are cached per method version —
        # also when the job was already reported as timed out or cancelled, so a Retry returns it without recomputing.
        if result.get("status") in ("READY", "UNAVAILABLE", "INVALID_ANALYSIS") and not result.get("diagnostic"):
            _results[key] = result
            _save_result(key, result, analysis_target(aoi)["geometry"])
        job.finish(_from_result(aid, aoi, b, c, result))
    except AnalysisCancelled:
        log.info("[%s] stopped after cancellation", job.id)
        job.finish(None, status="CANCELLED")
        return
    except AoiError as e:
        job.finish(_envelope(aid, aoi, b, c, "UNAVAILABLE", code="invalid_request", user_message=e.message, retryable=False))
        return
    except EarthEngineError as e:
        log.warning("[%s] Earth Engine error %s — %s", job.id, e.code, e.message)
        code = {"no_imagery": "insufficient_imagery", "ee_unconfigured": "service_unavailable", "ee_init_failed": "service_unavailable",
                "analysis_timeout": "analysis_timeout"}.get(e.code, classify_failure(e))
        status = "UNAVAILABLE" if code in ("insufficient_imagery", "service_unavailable", "earth_engine_unreachable") else "ERROR"
        job.finish(_envelope(aid, aoi, b, c, status, code=code,
                             diag=diagnostics(stage=job.provider_stage, error_type=e.code, elapsed_s=round(time.monotonic() - t0, 1))))
        return
    except Exception as e:  # noqa: BLE001 — Earth Engine raises ee.EEException and transport errors
        code = classify_failure(e)
        log.exception("[%s] Earth Engine analysis failed (%s)", job.id, code)   # full detail stays server-side
        job.finish(_envelope(aid, aoi, b, c, "UNAVAILABLE" if code == "earth_engine_unreachable" else "ERROR", code=code,
                             diag=diagnostics(stage=job.provider_stage, error_type=type(e).__name__, elapsed_s=round(time.monotonic() - t0, 1))))
        return
    finally:
        with _jobs_lock:
            if _active.get(key) is job:
                _active.pop(key, None)


def stored_status(aid: str, b: int, c: int) -> dict[str, Any]:
    """The REAL stored outcome of an analysis (never computes, never calls Earth Engine):
    RUNNING while a job for this key is computing, else the cached method-versioned result's status
    (READY / INVALID_ANALYSIS / UNAVAILABLE with its reason), else NOT_RUN."""
    aoi = aoi_doc(aid)   # AnalysisNotFound -> 404
    key = _key(aid, b, c)
    base = {"aoi_id": aid, "window": [b, c], "method_version": sc.METHOD_VERSION, "analysis_area": analysis_area_info(aoi)}
    limit = _area_limit(aoi)
    if limit:
        env = _too_large_envelope(aid, aoi, b, c, limit)
        return {**base, "status": "UNAVAILABLE", "reasonCode": "analysis_too_large", "reason": env["reason"], **limit}
    job = _expire_if_overdue(_active.get(key))
    if job is not None and not job.done:
        return {**base, "status": "RUNNING", "reasonCode": None, "reason": None, "job_id": job.id, "stage": job.stage}
    cached = _results.get(key) or _load_result(key)
    if not cached:
        return {**base, "status": "NOT_RUN", "reasonCode": None, "reason": None}
    issues = [i["years"] for i in ((cached.get("quality") or {}).get("issues") or [])]
    f = RESULTS / f"{key}.json"
    stored_at = datetime.fromtimestamp(f.stat().st_mtime, timezone.utc).isoformat(timespec="seconds") if f.exists() else None
    return {**base, "status": cached["status"], "reasonCode": cached.get("reasonCode"), "reason": cached.get("reason"),
            "issueYears": issues, "stored_at": stored_at}


def progress(rid: str) -> dict[str, Any]:
    """Current REAL provider stage of the job a request id belongs to (None when unknown/finished)."""
    key = _rid_key.get(rid)
    job = _expire_if_overdue(_active.get(key)) if key else None
    if job is None or job.done or job.provider_stage is None:
        return {"stage": None, "elapsed_s": None}
    return {"stage": job.provider_stage, "elapsed_s": round(time.monotonic() - job.created, 1)}


# ----------------------------------------------------------------------------- history (Time Machine / charts)
class HistoryUnavailable(Exception):
    def __init__(self, status: int, code: str, message: str | None = None):
        super().__init__(code)
        self.status, self.code, self.message = status, code, message


_history: LRUDict = LRUDict(settings.memory_cache_entries)
_history_jobs: dict[str, concurrent.futures.Future] = {}


def _history_key(aid: str, b: int, c: int) -> str:
    return f"{aid}-history-{b}-{c}-{sc.METHOD_VERSION}"


def _load_history(key: str) -> dict[str, Any] | None:
    if key in _history:
        return _history[key]
    f = RESULTS / f"{key}.json"
    if not f.exists():
        return None
    try:
        doc = json.loads(f.read_text(encoding="utf-8"))
    except ValueError:
        return None
    if doc.get("method_version") != sc.METHOD_VERSION:
        f.unlink(missing_ok=True)
        return None
    _history[key] = doc
    return doc


def _compute_history(aid: str, aoi: dict[str, Any], b: int, c: int, key: str) -> dict[str, Any]:
    t0 = time.monotonic()
    geom = validate_aoi(analysis_target(aoi)["geometry"], enforce_limits=False)
    raw = ee_provider.analyze(geom, aid, aoi["name"], b, c, deadline=t0 + _job_budget(), scope="history")
    doc = {k: raw.get(k) for k in ("years", "periods", "history", "quality_years")}
    doc.update(method_version=sc.METHOD_VERSION, aoi_id=aid, window=[b, c])
    _history[key] = doc
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / f"{key}.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    log.info("History %s (outside %s-%s): %d years in %.1fs", aid, b, c, len(doc["years"] or []), time.monotonic() - t0)
    return doc


HISTORY_SCOPE_NOTE = (
    "Historical context, not change detection. 1984–2015 are seven multi-year Landsat snapshots with an NDVI-only forest "
    "proxy (no Dynamic World); 2016 onward are annual Sentinel-2 / Dynamic World composites. The two eras use different "
    "forest definitions and are never subtracted from each other. Years outside the analysed window never change its result."
)


def _describe_history(doc: dict[str, Any], aoi: dict[str, Any]) -> dict[str, Any]:
    """The history response with its scope stated and its stability checked (never alters the measured values).

    Each transition gets the same physical-validity and gain-stability checks as the analysis; failures are reported
    as `stability_issues` (informational — history never decides an analysis status). A long-term period containing an
    unstable transition is flagged, and its level is labelled as a GROSS loss rate (gain is reported next to it).
    """
    out = dict(doc)
    area_ha = analysis_target(aoi).get("area_ha") or (analysis_target(aoi).get("area_km2") or 0) * 100
    issues = sc.context_issues(doc.get("years") or [], area_ha, None)
    out["scope"] = "historical_context"
    out["scope_note"] = HISTORY_SCOPE_NOTE
    out["stability_issues"] = issues
    periods = []
    for p in doc.get("periods") or []:
        unstable = [i for i in issues if p["from_year"] <= min(i["years"]) and max(i["years"]) <= p["to_year"]]
        periods.append({**p, "level_basis": "gross loss rate (loss transitions per year / forest at period start)",
                        "unstable": bool(unstable), "unstable_transitions": [i["years"] for i in unstable]})
    out["periods"] = periods
    return out


async def history(aid: str, b: int, c: int) -> dict[str, Any]:
    """Measured statistics for the composite years OUTSIDE the analysed window (Time Machine / charts only; they never
    affect the window's result or its validation). Cached per method version; never estimated."""
    aoi = aoi_doc(aid)
    key = _history_key(aid, b, c)
    if _area_limit(aoi):
        raise HistoryUnavailable(422, "analysis_too_large")
    cached = _load_history(key)
    if cached:
        return _describe_history(cached, aoi)
    if await asyncio.to_thread(_service_unavailable):
        raise HistoryUnavailable(503, "service_unavailable")
    if not await asyncio.to_thread(_ee_reachable):
        raise HistoryUnavailable(503, "earth_engine_unreachable")
    fut = _history_jobs.get(key)
    if fut is None or fut.done():
        fut = _POOL.submit(_compute_history, aid, aoi, b, c, key)
        _history_jobs[key] = fut
        # A finished future is never reused (its result is in _history, or it failed): drop it, and the exception
        # traceback it would otherwise hold for the life of the process.
        fut.add_done_callback(lambda f, k=key: _history_jobs.pop(k, None) if _history_jobs.get(k) is f else None)
    try:
        return _describe_history(await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(fut)), timeout=settings.ee_timeout_s), aoi)
    except (asyncio.TimeoutError, TimeoutError):
        raise HistoryUnavailable(504, "analysis_timeout", "The historical record is still being computed. Try again shortly.") from None
    except Exception as e:  # noqa: BLE001 — Earth Engine / transport errors; detail stays in the log
        log.warning("History %s failed: %s", aid, e)
        raise HistoryUnavailable(503, classify_failure(e)) from None


async def run(aid: str, b: int, c: int, rid: str | None = None) -> dict[str, Any]:
    """Synchronous-style analysis (GET /api/analysis/{aid}): create or join the job and wait for it for at most
    ee_timeout_s. If it is still computing, answer analysis_timeout — the job continues and a Retry joins it."""
    job = create_job(aid, b, c, rid)
    try:
        await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(job.future)), timeout=settings.ee_timeout_s)
    except (asyncio.TimeoutError, TimeoutError):
        log.warning("[%s] still computing after the %.0f s interactive window (continues in the background)", job.id, settings.ee_timeout_s)
        return _envelope(aid, job.aoi, b, c, "ERROR", code="analysis_timeout",
                         diag=diagnostics(stage=job.provider_stage, elapsed_s=round(time.monotonic() - job.created, 1), limit_s=settings.ee_timeout_s,
                                          ee_restricted_mode=RESTRICTED_MODE["seen_at"] is not None))
    return job.envelope or _envelope(aid, job.aoi, b, c, "ERROR", code="analysis_failed")


def change_baselines(aid: str, comparison_year: int) -> list[int]:
    """Baseline years of the stored READY results (current method) of `aid` whose event window ends at
    `comparison_year` — read-only, used to resolve a change-layer tile request without an explicit baseline."""
    aoi_doc(aid)   # validates the id (AnalysisNotFound) before it is used in a file pattern
    out = set()
    for f in RESULTS.glob(f"{aid}-*-{sc.METHOD_VERSION}.json") if RESULTS.exists() else []:
        if "-history-" in f.name:
            continue
        doc = _load_result(f.name[: -len(".json")])
        win = ((doc or {}).get("summary") or {}).get("analysis_window", {}).get("event_window")
        if doc and doc.get("status") == "READY" and win and win[1] == comparison_year:
            out.add(win[0])
    return sorted(out)


def find_ready_event(event_id: str) -> dict[str, Any] | None:
    """The stored properties of a change event of a READY result (current method version), or None.

    Used to decide whether facts sent for an AI briefing belong to a real, validated analysis. Reads only the
    method-versioned result files; never computes anything.
    """
    if not isinstance(event_id, str) or not re.fullmatch(r"TT-[A-Z0-9-]{4,}-\d{4}-\d{2}", event_id):
        return None
    docs = list(_results.values())
    for f in RESULTS.glob(f"*-{sc.METHOD_VERSION}.json") if RESULTS.exists() else []:
        if "-history-" in f.name:
            continue
        try:
            docs.append(json.loads(f.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    for doc in docs:
        if doc.get("status") != "READY" or doc.get("method_version", sc.METHOD_VERSION) != sc.METHOD_VERSION:
            continue
        for feat in (doc.get("events") or {}).get("features") or []:
            if feat.get("id") == event_id:
                return feat.get("properties")
    return None


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
    if doc["status"] == "INVALID_ANALYSIS" and not _rescope_invalid(doc):
        log.info("Discarding cached result %s: its validity issues were all outside the analysed window", key)
        f.unlink(missing_ok=True)
        return None
    if doc["status"] == "READY":
        ee_provider._requests[doc["summary"]["aoi"]["id"]] = {"geometry": doc["geometry"]}  # lazy tile rebuild
    _results[key] = doc
    return doc


def _rescope_invalid(doc: dict[str, Any]) -> bool:
    """Apply the window scope of `science.evaluate` to a cached INVALID result (bug fix 2026-09-27: validation used
    to include out-of-window years, e.g. 1990→1995 for a 2018→2025 request). Issues outside the analysed window
    become non-blocking context. Returns False when no in-window issue remains — then the cached verdict is
    unfounded and the analysis must be recomputed (never turned into READY without its statistics)."""
    q = doc.get("quality") or {}
    window = q.get("analyzable_window")
    issues = q.get("issues") or []
    kept = [i for i in issues if sc.in_window(i, window)]
    if not kept:
        return False
    if len(kept) != len(issues):
        q["context_issues"] = (q.get("context_issues") or []) + [i for i in issues if not sc.in_window(i, window)]
        q["issues"] = kept
        doc.update(reasonCode=kept[0]["rule"], reason=sc.invalid_reason(kept))
    return True


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
    refused = valid and (coverage_refusal(aoi.bbox) or forest_refusal(forest))   # the analysis' own pre-flight, shown up front
    if refused:
        valid, (code, message) = False, refused
    return {
        "valid": valid, "code": code, "message": message,
        "area_km2": round(aoi.area_km2, 2), "area_ha": round(aoi.area_ha, 1),
        "centroid": aoi.centroid, "bbox": aoi.bbox,
        "forest_cover_pct": forest,
        "forest_source": "Hansen et al. tree cover 2000 (≥ 30 % canopy) — reference, not a TERRATRACE detection" if forest is not None else None,
    }


DEFAULT_WINDOW = sc.DEFAULT_EVENT_WINDOW
