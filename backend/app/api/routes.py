"""TERRATRACE HTTP API (/api). One data mode: LIVE (Google Earth Engine)."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Path, Query, Request
from fastapi.responses import Response, StreamingResponse

from .. import ratelimit
from ..config import settings
from ..errors import public_error
from ..providers import registry
from ..providers.ai import claude
from ..providers.earth_engine import quickscan as qs_ee
from ..providers.earth_engine.provider import CONTEXT_LAYERS, EarthEngineError, layer_key, provider as ee_provider
from ..schemas import AnalysisEnvelope, AreaContext, AnalysisJobRequest, AnalyzeRequest, AoiPreview, AoiPreviewRequest, AoiRegisterRequest, ChatRequest, ChatResponse, Explanation, ExplainRequest, Health, NotComputed
from ..services import analysis, context as area_context, featured, imagery, quickscan, search, science as sc, tiles as tile_cache
from ..services.chat import counters as chat_counters, service as chat
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


async def _serve_tile(request: Request, key: str, z: int, x: int, y: int, template, forget_template) -> Response:
    """Cache-first tile: a cached tile needs no Earth Engine call at all. Otherwise the client's tile limit is checked
    (429 rate_limited with Retry-After; app/ratelimit.py group `tiles`), the template (map ID) is resolved and the tile
    fetched through the bounded, single-flight, backoff fetcher (services/tiles.py). An expired map ID is rebuilt once.
    `template` is an async callable returning the EE URL template."""
    data = tile_cache.cached(key)
    if data is not None:
        return _tile_response(data)
    retry_after = ratelimit.limiter.check(ratelimit.client_of(request), "tiles")
    if retry_after is not None:
        log.warning("Tile rate limit reached for %s", ratelimit.client_of(request))
        e = public_error("rate_limited")
        raise HTTPException(status_code=429, detail={**e, "message": e["user_message"]},
                            headers={"Retry-After": str(int(retry_after + 0.999))})
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


def _window(baseline: int | None, comparison: int | None, aid: str | None = None) -> tuple[int, int]:
    """The requested analysis window (defaults filled in); 422 unless baseline < comparison. A featured area's
    missing years default to ITS window (the one its stored result is keyed by), not the global default."""
    db, dc = featured.default_window(aid) if aid and aid in featured.featured_ids() else (DEFAULT_B, DEFAULT_C)
    b, c = baseline or db, comparison or dc
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


def _cache_writable() -> bool:
    """The durable cache directory exists (or can be created) and accepts a write."""
    try:
        settings.cache_dir.mkdir(parents=True, exist_ok=True)
        probe = settings.cache_dir / ".write-probe"
        probe.write_bytes(b"")
        probe.unlink()
        return True
    except OSError:
        return False


@router.get("/health/live")
def health_live() -> Response:
    """Liveness for container health checks: the process answers and can write its cache. No Earth Engine call
    (/api/health checks Earth Engine and can take seconds). 503 when the cache is not writable: every result would be
    lost on restart, so the platform should flag the deployment."""
    ok = _cache_writable()
    if not ok:
        log.error("Cache directory %s is not writable (TT_CACHE_DIR / volume permissions)", settings.cache_dir)
    return Response(json.dumps({"status": "ok" if ok else "cache_not_writable", "version": settings.version}),
                    status_code=200 if ok else 503, media_type="application/json")


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
        chat={**dict(zip(("status", "detail"), chat.status())), "tier": settings.chat_tier},
    )


@router.get("/study-areas")
def study_areas() -> dict[str, Any]:
    """Featured investigations — predefined AOIs only (no metrics), each with its default analysis window (the standard
    window moved inward to measured-analysable years; see services/featured.py)."""
    doc = registry.featured()
    return {**doc, "items": [{**a, "default_window": list(featured.default_window(a["id"]))} for a in doc["items"]]}


@router.get("/featured/summary")
def featured_summary() -> dict[str, Any]:
    """Stored outcome of every featured investigation for its default window (+ headline KPIs when READY).
    Read-only: never starts an analysis. The overview totals and featured cards come from here."""
    return {"items": [featured.summary(aid) for aid in featured.featured_ids()]}


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
async def get_aoi(aid: str = _aid(), include: str | None = Query(None, pattern="^context$")) -> dict[str, Any]:
    """A registered area (featured or custom): geometry and metadata — no analysis. With ?include=context, also its
    REFERENCE context (terrain, forest cover; services/context.py): measured once per area, then cached. A context
    that cannot be measured is returned as UNAVAILABLE with a public reason — never estimated."""
    try:
        doc = analysis.aoi_doc(aid)
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    if include != "context":
        return doc
    geometry = analysis.analysis_target(doc)["geometry"]
    ctx = await asyncio.to_thread(area_context.ensure, aid, geometry)
    return {**doc, "context": AreaContext.model_validate(ctx).model_dump()}


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


@router.get("/analysis-result/{aid}", response_model=AnalysisEnvelope | NotComputed)
def get_stored_analysis(aid: str = _aid(), baseline: int | None = _year(), comparison: int | None = _year()) -> dict[str, Any]:
    """The STORED analysis envelope for an area and window (READY / INVALID_ANALYSIS / UNAVAILABLE), so an opened
    investigation shows its real result at once. Read-only, never computes. Nothing stored for this window is not an
    error: 200 {status: "not_computed"}. Only an unknown area is a 404."""
    window = _window(baseline, comparison, aid)
    try:
        env = analysis.stored_envelope(aid, *window)
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    if env is None:
        return {"status": "not_computed", "aoi_id": aid, "window": list(window)}
    return env


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
        return analysis.stored_status(aid, *_window(baseline, comparison, aid))
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None


def _quickscan(fn, aid: str, year: int | None, season: str | None) -> dict[str, Any]:
    try:
        return fn(aid, year, season)
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    except quickscan.QuickScanError as e:
        raise _err(422, "invalid_request", e.message, False) from None


_SEASON = Query(None, pattern="^(all|mam|jja|son|djf)$")


@router.get("/quickscan/{aid}")
def get_quickscan(aid: str = _aid(), year: int | None = _year(), season: str | None = _SEASON) -> dict[str, Any]:
    """Quick scan of an area (land cover, surface temperature, biomass carbon from public datasets): the stored scan,
    PROCESSING, a recent failure, or NOT_RUN. Read-only — it never starts Earth Engine work (services/quickscan.py)."""
    return _quickscan(quickscan.status, aid, year, season)


@router.post("/quickscan/{aid}")
async def run_quickscan(aid: str = _aid(), year: int | None = _year(), season: str | None = _SEASON) -> dict[str, Any]:
    """Start a quick scan ("Run quick scan"), or join the running one; returns its state at once. Rate-limited.
    Refused (UNAVAILABLE with a public reason) over the interactive area limit, without Earth Engine, or while Earth
    Engine reports restricted mode."""
    return await asyncio.to_thread(_quickscan, quickscan.start, aid, year, season)


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


def _chat_window(req: ChatRequest) -> tuple[int, int] | None:
    if not req.aoi_id:
        return None
    if req.baseline is not None or req.comparison is not None:
        return _window(req.baseline, req.comparison)
    return featured.default_window(req.aoi_id) if req.aoi_id in featured.featured_ids() else (DEFAULT_B, DEFAULT_C)


@router.post("/chat", response_model=ChatResponse)
async def chat_answer(req: ChatRequest, request: Request) -> ChatResponse:
    """AI chat (additive; /api/explain is unchanged). Answers are checked deterministically (services/chat/validator.py)
    and withheld whole when a check fails. Chat text is never logged; only outcome/reason codes are counted."""
    window = _chat_window(req)
    try:
        out = await chat.answer([t.model_dump() for t in req.messages], req.aoi_id, window,
                                request.client.host if request.client else "unknown")
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    except chat.ChatRefused as e:
        raise _err(e.status, e.code) from None
    return ChatResponse(**out)


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/chat/stream")
async def chat_stream(req: ChatRequest, request: Request) -> StreamingResponse:
    """The same answer as POST /api/chat, as Server-Sent Events: "stage" events while the model works
    ({"stage": "asking" | "fallback" | "checking"}), then ONE "reply" event whose data is exactly /api/chat's body,
    or ONE "error" event ({status, code, user_message, retryable}). Stage events carry no model text: nothing the model
    wrote is sent before every check has passed. Same request shape, limits and counters as /api/chat."""
    window = _chat_window(req)    # invalid windows are refused before the stream starts
    host = request.client.host if request.client else "unknown"
    queue: asyncio.Queue[tuple[str, dict[str, Any]] | None] = asyncio.Queue()

    async def progress(stage: str) -> None:
        await queue.put(("stage", {"stage": stage}))

    async def run() -> None:
        try:
            out = await chat.answer([t.model_dump() for t in req.messages], req.aoi_id, window, host, progress)
            await queue.put(("reply", ChatResponse(**out).model_dump()))
        except analysis.AnalysisNotFound:
            await queue.put(("error", {"status": 404, **public_error("not_found")}))
        except chat.ChatRefused as e:
            await queue.put(("error", {"status": e.status, **public_error(e.code)}))
        except Exception as e:  # noqa: BLE001 — never leak internals into the stream
            log.warning("chat stream failed: %s", type(e).__name__)
            await queue.put(("error", {"status": 503, **public_error("chat_unavailable")}))
        finally:
            await queue.put(None)

    async def events():
        task = asyncio.create_task(run())
        try:
            while (item := await queue.get()) is not None:
                yield _sse(*item)
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/chat/stats")
def chat_stats() -> dict[str, Any]:
    """How often answers were answered, declined, withheld (by reason code) or unavailable. Counts only.
    There is no admin authentication: OFF (404, as if absent) unless TT_CHAT_STATS_ENABLED=true — for a local machine
    only. The same counts are always in cache_dir/chat_counters.json on the server."""
    if not settings.chat_stats_enabled:
        raise _err(404, "not_found")
    return chat_counters.snapshot()


@router.get("/search")
async def search_places(q: str = Query(..., min_length=1, max_length=120)) -> dict[str, Any]:
    results, notice = await search.search(q)
    return {"query": q, "results": results, "notice": notice}


@router.get("/tiles/{aid}/quickscan/{layer}/{year}/{season}/{z}/{x}/{y}")
async def quickscan_tiles(request: Request, aid: str = _aid(), layer: str = Path(..., max_length=16), year: int = Path(..., ge=YEAR_MIN, le=YEAR_MAX),
                          season: str = Path(..., pattern="^(all|mam|jja|son|djf)$"),
                          z: int = Path(..., ge=0, le=24), x: int = Path(..., ge=0), y: int = Path(..., ge=0)) -> Response:
    """Quick-scan map tiles (land surface temperature, Dynamic World land cover, ESA CCI biomass carbon) — only for a
    STORED scan whose section is READY: a tile request never starts a quick scan. Same cache, concurrency cap, backoff
    and public errors as the other tile routes; declared BEFORE the year route."""
    if layer not in qs_ee.LAYERS:
        raise _err(404, "not_found", "This map layer does not exist.", False)
    _tile_xyz(z, x, y)
    try:
        try:
            aoi = analysis.aoi_doc(aid)
        except analysis.AnalysisNotFound:
            raise _err(404, "not_found") from None
        doc = quickscan.stored(aid, year, season)
        if not any(lyr["id"] == layer for lyr in quickscan.layers_for(doc)):
            raise _err(404, "not_found", "This map layer is not available: run the quick scan first.", False)
        geometry = analysis.analysis_target(aoi)["geometry"]
        rng = quickscan.lst_range(doc) if layer == "lst" else None

        async def template() -> str:
            return await asyncio.to_thread(qs_ee.tile_url, aid, layer, year, season, geometry, rng)

        key = tile_cache.cache_key(f"qs-{layer}-{season}-{doc['quickscan_version']}", aid, year, z, x, y)
        return await _serve_tile(request, key, z, x, y, template, lambda: ee_provider.drop_mapid(qs_ee.mapid_key(aid, layer, year, season, rng)))
    except HTTPException:
        raise
    except EarthEngineError as e:
        if e.code == "unknown_layer":
            raise _err(404, "not_found", "This map layer does not exist.", False) from None
        log.warning("Quick-scan tiles %s/%s unavailable: %s", aid, layer, e)
        raise _err(503, "tiles_unavailable") from None
    except Exception as e:  # noqa: BLE001 — ee transport errors / TileUnavailable; details stay in the log
        log.warning("Quick-scan tiles %s/%s unavailable: %s", aid, layer, e)
        raise _err(503, "tiles_unavailable") from None


@router.get("/tiles/{aid}/context/{layer}/{z}/{x}/{y}")
async def context_tiles(request: Request, aid: str = _aid(), layer: str = Path(..., max_length=32),
                        z: int = Path(..., ge=0, le=24), x: int = Path(..., ge=0), y: int = Path(..., ge=0)) -> Response:
    """Reference context map tiles (hillshade, slope, Hansen tree cover 2000, Hansen loss year) — never TerraTrace
    results. Same validation, cache, concurrency cap, backoff and public errors as the analysis tile route; declared
    BEFORE it so /tiles/{aid}/context/... is never parsed as a year."""
    if layer not in CONTEXT_LAYERS:
        raise _err(404, "not_found", "This map layer does not exist.", False)
    _tile_xyz(z, x, y)
    try:
        try:
            geometry = analysis.analysis_target(analysis.aoi_doc(aid))["geometry"]
        except analysis.AnalysisNotFound:
            raise _err(404, "not_found") from None

        async def template() -> str:
            return await asyncio.to_thread(ee_provider.context_tile_url, aid, layer, geometry)

        key = tile_cache.cache_key(f"ctx-{layer}-{area_context.CONTEXT_VERSION}", aid, 0, z, x, y)
        return await _serve_tile(request, key, z, x, y, template, lambda: ee_provider.drop_mapid((aid, f"ctx:{layer}", 0)))
    except HTTPException:
        raise
    except EarthEngineError as e:
        if e.code == "unknown_layer":
            raise _err(404, "not_found", "This map layer does not exist.", False) from None
        log.warning("Context tiles %s/%s unavailable: %s", aid, layer, e)
        raise _err(503, "tiles_unavailable") from None
    except Exception as e:  # noqa: BLE001 — ee transport errors / TileUnavailable; details stay in the log
        log.warning("Context tiles %s/%s unavailable: %s", aid, layer, e)
        raise _err(503, "tiles_unavailable") from None


@router.get("/tiles/{aid}/{kind}/{year}/{z}/{x}/{y}")
async def tiles(request: Request, aid: str = _aid(), kind: str = Path(..., max_length=16), year: int = Path(..., ge=YEAR_MIN, le=YEAR_MAX),
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
    # Before 2016 only imagery is shown: the Landsat proxy's forest mask (and change between proxy masks) is withheld.
    if kind != "imagery" and (sc.era_of(year) == "historical" or (baseline is not None and sc.era_of(baseline) == "historical")):
        raise _err(404, "not_found", "Forest layers before 2016 are withheld: the Landsat-era forest measure cannot tell "
                                     "green crops from forest.", False)
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

        return await _serve_tile(request, tile_cache.cache_key(layer, aid, year, z, x, y), z, x, y, template,
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
async def imagery_tiles(request: Request, aid: str = _aid(), year: int = Path(..., ge=YEAR_MIN, le=YEAR_MAX),
                        z: int = Path(..., ge=0, le=24), x: int = Path(..., ge=0), y: int = Path(..., ge=0)) -> Response:
    """Earth Engine composite tiles for a year MEASURED as AVAILABLE (fetched and cached by the backend; no credentials
    reach the browser)."""
    _tile_xyz(z, x, y)
    try:
        return await _serve_tile(request, tile_cache.cache_key("aoi-imagery", aid, year, z, x, y), z, x, y,
                                 lambda: imagery.tile_url(aid, year), lambda: ee_provider.drop_mapid((aid, "aoi-imagery", year)))
    except analysis.AnalysisNotFound:
        raise _err(404, "not_found") from None
    except imagery.ImageryError as e:
        raise _imagery_err(e) from None
    except Exception as e:  # noqa: BLE001 — details stay in the log
        log.warning("Imagery tiles %s/%s unavailable: %s", aid, year, e)
        raise _err(503, "tiles_unavailable") from None
