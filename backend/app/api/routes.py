"""TERRATRACE HTTP API (/api). One data mode: LIVE (Google Earth Engine)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Path, Query
from fastapi.responses import RedirectResponse

from ..config import settings
from ..errors import public_error
from ..providers import registry
from ..providers.ai import claude
from ..providers.earth_engine.provider import EarthEngineError, provider as ee_provider
from ..schemas import AnalysisEnvelope, AnalysisJobRequest, AnalyzeRequest, AoiPreview, AoiPreviewRequest, AoiRegisterRequest, Explanation, ExplainRequest, Health
from ..services import analysis, imagery, search
from ..services.explanation import service as explanation
from ..services.geometry import AoiError

log = logging.getLogger("terratrace.api")
router = APIRouter(prefix="/api")
DEFAULT_B, DEFAULT_C = analysis.DEFAULT_WINDOW


def _err(status: int, code: str, message: str | None = None, retryable: bool | None = None) -> HTTPException:
    """Public HTTP error: {code, user_message, retryable} (+ message alias). message must be TERRATRACE's own text."""
    e = public_error(code, message, retryable)
    return HTTPException(status_code=status, detail={**e, "message": e["user_message"]})


RID = r"^[A-Za-z0-9-]{8,64}$"


def _tile_redirect(url: str) -> RedirectResponse:
    """Redirect to an Earth Engine tile. Cacheable briefly (the map id is stable while this process runs), so
    the browser does not re-ask the backend — and Earth Engine — for a tile it already has."""
    return RedirectResponse(url, status_code=307, headers={"Cache-Control": "private, max-age=600"})


async def _run(aid: str, baseline: int | None, comparison: int | None, rid: str | None = None) -> dict[str, Any]:
    try:
        return await analysis.run(aid, baseline or DEFAULT_B, comparison or DEFAULT_C, rid)
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    except AoiError as e:
        raise _err(422, e.code, e.message) from None


@router.get("/health", response_model=Health)
def health() -> Health:
    ee_status, ee_detail = ee_provider.status()
    if ee_status != "ready":
        log.warning("Health: Earth Engine status=%s (%s)", ee_status, ee_detail)   # detail stays server-side
    return Health(
        status="operational",
        version=settings.version,
        analysis={"status": ee_status, "detail": "Live Earth observation available" if ee_status == "ready" else "Live analysis unavailable"},
        explainer={"status": "ready" if claude.configured() else "unconfigured",
                   "detail": None if claude.configured() else "Deterministic briefing from measured facts"},
        explainer_model=settings.llm_model if claude.configured() else None,
        geocoder={"status": "ready" if settings.geocoder_enabled else "offline", "detail": "OpenStreetMap Nominatim + offline gazetteer"},
        limits={"max_aoi_km2": settings.max_aoi_km2, "min_aoi_km2": settings.min_aoi_km2, "interactive_max_km2": settings.interactive_max_km2},
    )


@router.get("/study-areas")
def study_areas() -> dict[str, Any]:
    """Featured investigations — predefined AOIs only (no metrics)."""
    return registry.featured()


@router.post("/aoi")
def register_aoi(req: AoiRegisterRequest) -> dict[str, Any]:
    """Register a selected area (validation + a small definition file) so its live imagery can load BEFORE any
    analysis. No Earth Engine call, no analysis. The same geometry always gets the same id (as POST /analyze)."""
    try:
        _, doc = analysis.register_aoi(req.geometry, req.name)
    except AoiError as e:
        raise _err(422, e.code, e.message) from None
    return doc


@router.get("/aoi/{aid}")
def get_aoi(aid: str) -> dict[str, Any]:
    """A registered area (featured or custom): geometry and metadata only — no analysis, no Earth Engine call."""
    try:
        return analysis.aoi_doc(aid)
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None


@router.get("/analysis/{aid}/history")
async def get_analysis_history(aid: str, baseline: int | None = None, comparison: int | None = None) -> dict[str, Any]:
    """Measured per-year statistics for the years OUTSIDE the analysed window (Time Machine and charts). They never
    change the window's result or validation. A public error — never estimates — when they cannot be measured."""
    try:
        return await analysis.history(aid, baseline or DEFAULT_B, comparison or DEFAULT_C)
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    except analysis.HistoryUnavailable as e:
        raise _err(e.status, e.code, e.message) from None


@router.get("/analysis/{aid}", response_model=AnalysisEnvelope)
async def get_analysis(aid: str, baseline: int | None = None, comparison: int | None = None,
                       rid: str | None = Query(None, pattern=RID)) -> dict[str, Any]:
    return await _run(aid, baseline, comparison, rid)


# ----------------------------------------------------------------------------- asynchronous analysis jobs
JOB_ID = r"^[0-9a-f]{16}$"


@router.post("/analysis-jobs")
def create_analysis_job(req: AnalysisJobRequest, rid: str | None = Query(None, pattern=RID)) -> dict[str, Any]:
    """Start (or join) an analysis job and return immediately: {job_id, status, stage, ...}. Poll GET /analysis-jobs/{id}."""
    try:
        if req.aoi_id:
            aid = req.aoi_id
        elif req.geometry:
            aid, _ = analysis.register_aoi(req.geometry, req.name)
        else:
            raise _err(422, "invalid_request", "Select or draw an area to analyse.")
        return analysis.create_job(aid, req.baseline, req.comparison, rid).public()
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    except AoiError as e:
        raise _err(422, e.code, e.message) from None


@router.get("/analysis-jobs/{job_id}")
def get_analysis_job(job_id: str = Path(..., pattern=JOB_ID)) -> dict[str, Any]:
    """Real job state: status (QUEUED / PROCESSING / terminal), current stage, elapsed time, per-stage durations,
    and — only once terminal — the analysis envelope."""
    job = analysis.get_job(job_id)
    if job is None:
        raise _err(404, "not_found", "This analysis job is no longer available. Run the analysis again.")
    return job.public()


@router.post("/analysis-jobs/{job_id}/cancel")
def cancel_analysis_job(job_id: str = Path(..., pattern=JOB_ID)) -> dict[str, Any]:
    job = analysis.cancel_job(job_id)
    if job is None:
        raise _err(404, "not_found", "This analysis job is no longer available.")
    return job.public()


@router.get("/analysis-status/{aid}")
def get_analysis_status(aid: str, baseline: int | None = None, comparison: int | None = None) -> dict[str, Any]:
    """Stored status of an analysis (RUNNING / READY / INVALID_ANALYSIS / UNAVAILABLE / NOT_RUN). Read-only: it never
    starts or runs an analysis, so featured cards can show real state without triggering Earth Engine work."""
    try:
        return analysis.stored_status(aid, baseline or DEFAULT_B, comparison or DEFAULT_C)
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None


@router.get("/progress/{rid}")
def get_progress(rid: str) -> dict[str, Any]:
    """Real analysis stage for a client request id (no percentages are invented)."""
    return analysis.progress(rid)


@router.post("/analyze", response_model=AnalysisEnvelope)
async def analyze(req: AnalyzeRequest, rid: str | None = Query(None, pattern=RID)) -> dict[str, Any]:
    try:
        aid, _ = analysis.register_aoi(req.geometry, req.name)
    except AoiError as e:
        raise _err(422, e.code, e.message) from None
    return await _run(aid, req.baseline_period.year, req.comparison_period.year, rid)


@router.post("/aoi/preview", response_model=AoiPreview)
async def aoi_preview(req: AoiPreviewRequest) -> AoiPreview:
    return AoiPreview(**await asyncio.to_thread(analysis.preview, req.geometry))


@router.post("/explain", response_model=Explanation)
async def explain(req: ExplainRequest, provider: str = Query("auto", pattern="^(auto|offline)$")) -> Explanation:
    if "event_id" not in req.facts:
        raise _err(422, "invalid_request", "This explanation request is incomplete.")
    try:
        return Explanation(**await explanation.explain(req.facts, provider))
    except (KeyError, TypeError) as e:
        log.warning("Explain: incomplete facts (%s)", e)
        raise _err(422, "invalid_request", "This explanation request is incomplete.") from None


@router.get("/search")
async def search_places(q: str = Query(..., min_length=1, max_length=120)) -> dict[str, Any]:
    results, notice = await search.search(q)
    return {"query": q, "results": results, "notice": notice}


@router.get("/tiles/{aid}/{kind}/{year}/{z}/{x}/{y}")
async def tiles(aid: str, kind: str, year: int, z: int, x: int, y: int,
                baseline: int | None = Query(None, ge=1984, le=2100)) -> RedirectResponse:
    """Earth Engine map tiles for a READY live analysis (proxied so no credentials reach the browser).

    A change layer depends on two years: `baseline` (query) is required unless exactly one stored READY result of this
    AOI ends at `year`, whose baseline is then used."""
    if kind not in ("imagery", "forest", "change"):
        raise _err(404, "not_found")
    try:
        try:
            # Registered AOI on disk (layers survive a backend restart), rendered over what was actually analysed.
            geometry = analysis.analysis_target(analysis.aoi_doc(aid))["geometry"]
        except analysis.AnalysisNotFound:
            raise _err(404, "not_found") from None
        if kind == "change" and baseline is None:
            candidates = analysis.change_baselines(aid, year)
            if len(candidates) != 1:
                raise _err(404, "not_found", "This change layer needs its baseline year (?baseline=YYYY).", False)
            baseline = candidates[0]
        url = await asyncio.to_thread(ee_provider.tile_url, aid, kind, year, geometry, baseline)
    except HTTPException:
        raise
    except EarthEngineError as e:
        if e.code == "unknown_layer":   # a layer that cannot exist (bad kind / baseline): not retryable
            raise _err(404, "not_found", "This map layer does not exist for this analysis.", False) from None
        log.warning("Tiles %s/%s/%s unavailable: %s", aid, kind, year, e)
        raise _err(503, "tiles_unavailable") from None
    except Exception as e:  # noqa: BLE001 — ee transport errors; details stay in the log
        log.warning("Tiles %s/%s/%s unavailable: %s", aid, kind, year, e)
        raise _err(503, "tiles_unavailable") from None
    return _tile_redirect(url.format(z=z, x=x, y=y))


# ----------------------------------------------------------------------------- imagery (never an analysis)
def _imagery_err(e: imagery.ImageryError) -> HTTPException:
    return HTTPException(status_code=e.status, detail={**e.error, "message": e.error["user_message"]})


@router.get("/imagery/availability")
async def imagery_availability(aoi: str = Query(..., min_length=1, max_length=80)) -> dict[str, Any]:
    """Measured per-year imagery availability for an AOI (AVAILABLE / INSUFFICIENT / UNAVAILABLE)."""
    try:
        return await imagery.availability(aoi)
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    except imagery.ImageryError as e:
        raise _imagery_err(e) from None


@router.get("/imagery")
async def imagery_decision(aoi: str = Query(..., min_length=1, max_length=80), year: int = Query(..., ge=1900, le=2100)) -> dict[str, Any]:
    """The canonical imagery decision for an AOI and year (the frontend never builds imagery URLs)."""
    try:
        return await imagery.decide(aoi, year)
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    except imagery.ImageryError as e:
        raise _imagery_err(e) from None


@router.get("/imagery/basemaps")
def imagery_basemaps() -> dict[str, Any]:
    """Base imagery and reference layers (imagery only; no TERRATRACE measurement)."""
    return imagery.basemaps()


@router.get("/imagery/tiles/{aid}/{year}/{z}/{x}/{y}")
async def imagery_tiles(aid: str, year: int, z: int, x: int, y: int) -> RedirectResponse:
    """Earth Engine composite tiles for a year MEASURED as AVAILABLE (proxied; no credentials reach the browser)."""
    try:
        url = await imagery.tile_url(aid, year)
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    except imagery.ImageryError as e:
        raise _imagery_err(e) from None
    except Exception as e:  # noqa: BLE001 — details stay in the log
        log.warning("Imagery tiles %s/%s unavailable: %s", aid, year, e)
        raise _err(503, "tiles_unavailable") from None
    return _tile_redirect(url.format(z=z, x=x, y=y))
