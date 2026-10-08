"""TERRATRACE HTTP API (/api). One data mode: LIVE (Google Earth Engine)."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Path, Query
from fastapi.responses import Response

from ..config import settings
from ..errors import public_error
from ..providers import registry
from ..providers.ai import claude
from ..providers.earth_engine.provider import EarthEngineError, layer_key, provider as ee_provider
from ..schemas import AnalysisEnvelope, AnalysisJobRequest, AnalyzeRequest, AoiPreview, AoiPreviewRequest, AoiRegisterRequest, Explanation, ExplainRequest, Health
from ..services import analysis, imagery, search, tiles as tile_cache
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
YEAR_MIN, YEAR_MAX = 1984, 2100
# Facts of one event serialise to ~2 KB (frontend/src/explain/facts.ts); anything far larger is not a real request.
MAX_FACTS_CHARS = 16_000


def _tile_response(data: bytes) -> Response:
    """A tile image. The browser may keep it for an hour (a method-version change can alter a layer at the same URL)."""
    return Response(data, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})


async def _serve_tile(key: str, z: int, x: int, y: int, template, forget_template) -> Response:
    """Cache-first tile: a cached tile needs no Earth Engine call at all. Otherwise the template (map ID) is resolved
    and the tile fetched through the bounded, single-flight, backoff fetcher (services/tiles.py). An expired map ID
    is rebuilt once. `template` is an async callable returning the EE URL template."""
    data = tile_cache.cached(key)
    if data is not None:
        return _tile_response(data)
    for attempt in (1, 2):
        url = (await template()).format(z=z, x=x, y=y)
        try:
            # shield: a browser that gives up (pan / zoom) must not cancel a fetch other requests share
            return _tile_response(await asyncio.shield(asyncio.wrap_future(tile_cache.fetch(key, url))))
        except tile_cache.TileExpired:
            forget_template()
            if attempt == 2:
                raise tile_cache.TileUnavailable("map ID rejected twice") from None
    raise AssertionError("unreachable")


def _year() -> Any:
    return Query(None, ge=YEAR_MIN, le=YEAR_MAX)


def _aid() -> Any:
    """Area id (featured slug or "aoi-<hex>"). Length-bounded here; analysis.aoi_doc() accepts only ids the backend
    knows or generated (anything else -> 404 not_found), so an id never reaches the filesystem unchecked."""
    return Path(..., min_length=1, max_length=80)


def _window(baseline: int | None, comparison: int | None) -> tuple[int, int]:
    """The requested analysis window (defaults filled in); 422 unless baseline < comparison."""
    b, c = baseline or DEFAULT_B, comparison or DEFAULT_C
    if not b < c:
        raise _err(422, "invalid_window", "The comparison year must be after the baseline year.", False)
    return b, c


def _tile_xyz(z: int, x: int, y: int) -> None:
    """A tile index that exists at zoom z (0 <= x, y < 2^z)."""
    if not (x < 2 ** z and y < 2 ** z):
        raise _err(404, "not_found", "This map tile does not exist.", False)


async def _run(aid: str, baseline: int | None, comparison: int | None, rid: str | None = None) -> dict[str, Any]:
    try:
        return await analysis.run(aid, *_window(baseline, comparison), rid)
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    except AoiError as e:
        raise _err(422, e.code, e.message, False) from None


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
        raise _err(422, e.code, e.message, False) from None
    return doc


@router.get("/aoi/{aid}")
def get_aoi(aid: str = _aid()) -> dict[str, Any]:
    """A registered area (featured or custom): geometry and metadata only — no analysis, no Earth Engine call."""
    try:
        return analysis.aoi_doc(aid)
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None


@router.get("/analysis/{aid}/history")
async def get_analysis_history(aid: str = _aid(), baseline: int | None = _year(), comparison: int | None = _year()) -> dict[str, Any]:
    """Measured per-year statistics for the years OUTSIDE the analysed window (Time Machine and charts). They never
    change the window's result or validation. A public error — never estimates — when they cannot be measured."""
    try:
        return await analysis.history(aid, *_window(baseline, comparison))
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    except analysis.HistoryUnavailable as e:
        raise _err(e.status, e.code, e.message) from None


@router.get("/analysis/{aid}", response_model=AnalysisEnvelope)
async def get_analysis(aid: str = _aid(), baseline: int | None = _year(), comparison: int | None = _year(),
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
        raise _err(422, e.code, e.message, False) from None


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
def get_analysis_status(aid: str = _aid(), baseline: int | None = _year(), comparison: int | None = _year()) -> dict[str, Any]:
    """Stored status of an analysis (RUNNING / READY / INVALID_ANALYSIS / UNAVAILABLE / NOT_RUN). Read-only: it never
    starts or runs an analysis, so featured cards can show real state without triggering Earth Engine work."""
    try:
        return analysis.stored_status(aid, *_window(baseline, comparison))
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None


@router.get("/progress/{rid}")
def get_progress(rid: str = Path(..., pattern=RID)) -> dict[str, Any]:
    """Real analysis stage for a client request id (no percentages are invented)."""
    return analysis.progress(rid)


@router.post("/analyze", response_model=AnalysisEnvelope)
async def analyze(req: AnalyzeRequest, rid: str | None = Query(None, pattern=RID)) -> dict[str, Any]:
    try:
        aid, _ = analysis.register_aoi(req.geometry, req.name)
    except AoiError as e:
        raise _err(422, e.code, e.message, False) from None
    return await _run(aid, req.baseline_period.year, req.comparison_period.year, rid)


@router.post("/aoi/preview", response_model=AoiPreview)
async def aoi_preview(req: AoiPreviewRequest) -> AoiPreview:
    return AoiPreview(**await asyncio.to_thread(analysis.preview, req.geometry))


@router.post("/explain", response_model=Explanation)
async def explain(req: ExplainRequest, provider: str = Query("auto", pattern="^(auto|offline)$")) -> Explanation:
    if "event_id" not in req.facts:
        raise _err(422, "invalid_request", "This explanation request is incomplete.")
    if len(json.dumps(req.facts, ensure_ascii=False)) > MAX_FACTS_CHARS:
        raise _err(422, "invalid_request", "This explanation request is too large.")
    # The facts come from the browser: only an event of a stored READY analysis, with its stored measurements, is
    # explained (never client-asserted numbers sent to the language model on this server's key).
    props = await asyncio.to_thread(analysis.find_ready_event, req.facts["event_id"])
    if props is None or not explanation.matches_event(req.facts, props):
        log.info("Explain withheld: facts do not match a stored READY event")
        return Explanation(**explanation.withheld())
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
async def tiles(aid: str = _aid(), kind: str = Path(..., max_length=16), year: int = Path(..., ge=YEAR_MIN, le=YEAR_MAX),
                z: int = Path(..., ge=0, le=24), x: int = Path(..., ge=0), y: int = Path(..., ge=0),
                baseline: int | None = _year()) -> Response:
    """Earth Engine map tiles for a READY live analysis (proxied so no credentials reach the browser).

    A change layer depends on two years: `baseline` (query) is required unless exactly one stored READY result of this
    AOI ends at `year`, whose baseline is then used."""
    if kind not in ("imagery", "forest", "change"):
        raise _err(404, "not_found")
    _tile_xyz(z, x, y)
    # Only the method's composite years exist as layers: any other year would start a new Earth Engine map request.
    years = imagery.candidate_years()
    if year not in years or (baseline is not None and baseline not in years):
        raise _err(404, "not_found", "This map layer does not exist for this analysis.", False)
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
        layer = f"change:{baseline}" if kind == "change" else kind

        async def template() -> str:
            return await asyncio.to_thread(ee_provider.tile_url, aid, kind, year, geometry, baseline)

        return await _serve_tile(tile_cache.cache_key(layer, aid, year, z, x, y), z, x, y, template,
                                 lambda: ee_provider.drop_mapid(layer_key(aid, kind, year, baseline)))
    except HTTPException:
        raise
    except EarthEngineError as e:
        if e.code == "unknown_layer":   # a layer that cannot exist (bad kind / baseline): not retryable
            raise _err(404, "not_found", "This map layer does not exist for this analysis.", False) from None
        log.warning("Tiles %s/%s/%s unavailable: %s", aid, kind, year, e)
        raise _err(503, "tiles_unavailable") from None
    except Exception as e:  # noqa: BLE001 — ee transport errors / TileUnavailable; details stay in the log
        log.warning("Tiles %s/%s/%s unavailable: %s", aid, kind, year, e)
        raise _err(503, "tiles_unavailable") from None


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
async def imagery_decision(aoi: str = Query(..., min_length=1, max_length=80), year: int = Query(..., ge=1900, le=YEAR_MAX)) -> dict[str, Any]:
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
async def imagery_tiles(aid: str = _aid(), year: int = Path(..., ge=YEAR_MIN, le=YEAR_MAX),
                        z: int = Path(..., ge=0, le=24), x: int = Path(..., ge=0), y: int = Path(..., ge=0)) -> Response:
    """Earth Engine composite tiles for a year MEASURED as AVAILABLE (fetched and cached by the backend; no credentials
    reach the browser)."""
    _tile_xyz(z, x, y)
    try:
        return await _serve_tile(tile_cache.cache_key("aoi-imagery", aid, year, z, x, y), z, x, y,
                                 lambda: imagery.tile_url(aid, year), lambda: ee_provider.drop_mapid((aid, "aoi-imagery", year)))
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    except imagery.ImageryError as e:
        raise _imagery_err(e) from None
    except Exception as e:  # noqa: BLE001 — details stay in the log
        log.warning("Imagery tiles %s/%s unavailable: %s", aid, year, e)
        raise _err(503, "tiles_unavailable") from None
