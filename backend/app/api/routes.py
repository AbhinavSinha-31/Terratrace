"""TERRATRACE HTTP API (/api). One data mode: LIVE (Google Earth Engine)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import RedirectResponse

from ..config import settings
from ..errors import public_error
from ..providers import registry
from ..providers.ai import claude
from ..providers.earth_engine.provider import provider as ee_provider
from ..schemas import AnalysisEnvelope, AnalyzeRequest, AoiPreview, AoiPreviewRequest, Explanation, ExplainRequest, Health
from ..services import analysis, search
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


@router.get("/analysis/{aid}", response_model=AnalysisEnvelope)
async def get_analysis(aid: str, baseline: int | None = None, comparison: int | None = None,
                       rid: str | None = Query(None, pattern=RID)) -> dict[str, Any]:
    return await _run(aid, baseline, comparison, rid)


@router.get("/progress/{rid}")
def get_progress(rid: str) -> dict[str, Any]:
    """Real analysis stage for a client request id (no percentages are invented)."""
    return analysis.progress(rid)


def _subset(env: dict[str, Any], *keys: str) -> dict[str, Any]:
    base = {k: env[k] for k in ("analysis_id", "dataMode", "analysisStatus", "reason", "reasonCode", "window")}
    if env["analysisStatus"] == "READY":
        base.update({k: env.get(k) for k in keys})
    return base


@router.get("/analysis/{aid}/events")
async def get_events(aid: str, baseline: int | None = None, comparison: int | None = None) -> dict[str, Any]:
    return _subset(await _run(aid, baseline, comparison), "events")


@router.get("/analysis/{aid}/stats")
async def get_stats(aid: str, baseline: int | None = None, comparison: int | None = None) -> dict[str, Any]:
    env = await _run(aid, baseline, comparison)
    out = _subset(env)
    if env["analysisStatus"] == "READY":
        s = env["summary"]
        out.update({k: s.get(k) for k in ("kpis", "history", "years", "periods", "analysis_window")})
    return out


@router.get("/analysis/{aid}/layers")
async def get_layers(aid: str, baseline: int | None = None, comparison: int | None = None) -> dict[str, Any]:
    return _subset(await _run(aid, baseline, comparison), "layers")


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
async def tiles(aid: str, kind: str, year: int, z: int, x: int, y: int) -> RedirectResponse:
    """Earth Engine map tiles for a READY live analysis (proxied so no credentials reach the browser)."""
    if kind not in ("imagery", "forest", "change"):
        raise _err(404, "not_found")
    try:
        url = await asyncio.to_thread(ee_provider.tile_url, aid, kind, year)
    except Exception as e:  # noqa: BLE001 — EarthEngineError or ee transport errors; details stay in the log
        log.warning("Tiles %s/%s/%s unavailable: %s", aid, kind, year, e)
        raise _err(503, "tiles_unavailable") from None
    return RedirectResponse(url.format(z=z, x=x, y=y), status_code=307)
