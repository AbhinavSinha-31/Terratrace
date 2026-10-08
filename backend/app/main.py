"""TERRATRACE backend entry point.

    uvicorn app.main:app --host 127.0.0.1 --port 8001   (from backend/)

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

from . import ratelimit
from .api.routes import router
from .config import settings
from .errors import diagnostics, public_error

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
# httpx logs every request URL at INFO; Earth Engine tile URLs carry map IDs (short-lived capability tokens).
logging.getLogger("httpx").setLevel(logging.WARNING)

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


class BodySizeLimit:
    """Refuse request bodies over `max_bytes` with a public 413 before any route parses them (uvicorn has no limit).
    Declared Content-Length is checked first; a chunked body is buffered up to the limit and then replayed."""

    def __init__(self, app, max_bytes: int):
        self.app, self.max_bytes = app, max_bytes

    async def _too_large(self, scope, receive, send) -> None:
        log.warning("Request body over %d bytes refused on %s %s", self.max_bytes, scope.get("method"), scope.get("path"))
        body = {**public_error("invalid_request", "This request is too large.", False), "message": "This request is too large."}
        await JSONResponse(status_code=413, content={"detail": body})(scope, receive, send)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > self.max_bytes):
            return await self._too_large(scope, receive, send)
        chunks, size, more = [], 0, True
        while more:
            msg = await receive()
            if msg["type"] != "http.request":   # client disconnected
                return
            chunks.append(msg.get("body", b""))
            size += len(chunks[-1])
            if size > self.max_bytes:
                return await self._too_large(scope, receive, send)
            more = msg.get("more_body", False)
        replayed = False

        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        return await self.app(scope, replay, send)


app = FastAPI(title="TERRATRACE API", version=settings.version, description="Explainable satellite forest-change intelligence", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
app.add_middleware(BodySizeLimit, max_bytes=settings.max_request_bytes)
app.include_router(router)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    """Refuse requests over the per-client limit with an explicit 429 public error (app/ratelimit.py)."""
    group = ratelimit.group_of(request.method, request.url.path)
    if group:
        retry_after = ratelimit.limiter.check(request.client.host if request.client else "unknown", group)
        if retry_after is not None:
            log.warning("Rate limit (%s) reached for %s on %s %s", group, request.client.host if request.client else "?", request.method, request.url.path)
            body = {**public_error("rate_limited"), "message": public_error("rate_limited")["user_message"]}
            return JSONResponse(status_code=429, content={"detail": body}, headers={"Retry-After": str(int(retry_after + 0.999))})
    return await call_next(request)


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
