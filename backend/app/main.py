"""TERRATRACE backend entry point.

    uvicorn app.main:app --port 8000          (from backend/)

Serves the API under /api and, when frontend/dist exists, the built app at /.
"""

from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.routes import router
from .config import settings
from .errors import diagnostics, public_error

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

@asynccontextmanager
async def lifespan(_: FastAPI):
    # Warm up Earth Engine in the background so the first /api/health is fast.
    # Readiness itself is still decided by a real initialisation + request.
    from .providers.earth_engine.provider import provider as ee_provider
    from .services.analysis import purge_stale_results

    stale = purge_stale_results()   # results from another scientific-method version are never reused
    if stale:
        logging.getLogger("terratrace").info("Removed %d cached result(s) from an older method version", stale)
    from .services.imagery import purge_stale as purge_stale_imagery

    purge_stale_imagery()   # imagery availability is method-versioned too
    threading.Thread(target=ee_provider.status, name="ee-warmup", daemon=True).start()
    yield


log = logging.getLogger("terratrace")
app = FastAPI(title="TERRATRACE API", version=settings.version, description="Explainable satellite forest-change intelligence", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
app.include_router(router)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    """Validation failures → public error. Field-level pydantic detail only with DEV_DIAGNOSTICS."""
    errors = [{"loc": list(e.get("loc", [])), "msg": str(e.get("msg", ""))} for e in exc.errors()]
    log.info("Invalid request: %s", errors)
    msg = "The comparison year must be after the baseline year." if any("comparison_period" in str(e["msg"]) for e in errors) else None
    body = {**public_error("invalid_request", msg), "message": msg or public_error("invalid_request")["user_message"]}
    if diagnostics(errors=errors):
        body["diagnostics"] = diagnostics(errors=errors)
    return JSONResponse(status_code=422, content={"detail": body})


@app.exception_handler(Exception)
async def unexpected_error(request: Request, exc: Exception) -> JSONResponse:
    """Never send raw exception text to the browser; the traceback stays in the server log."""
    log.exception("Unhandled error on %s %s", request.method, request.url.path)
    body = {**public_error("internal_error"), "message": public_error("internal_error")["user_message"]}
    if diagnostics(error_type=type(exc).__name__):
        body["diagnostics"] = diagnostics(error_type=type(exc).__name__, path=request.url.path)
    return JSONResponse(status_code=500, content={"detail": body})


if settings.frontend_dist.exists():
    app.mount("/", StaticFiles(directory=settings.frontend_dist, html=True), name="frontend")
