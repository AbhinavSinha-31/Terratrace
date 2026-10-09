"""Featured investigations: their analysis window and pre-computed results.

Each featured investigation opens on its DEFAULT WINDOW: the standard window (science.DEFAULT_EVENT_WINDOW) moved
inward to the nearest years an analysis can use, as MEASURED by imagery availability (the frontend's window selector
applies the same rule). Its result is pre-computed once per method version by a background runner — strictly one
analysis at a time, because the Earth Engine noncommercial quota throttles concurrency — and stored like any other
result, so the Explore overview and an opened investigation show real, stored measurements immediately.

Nothing here invents a result: a site whose analysis is INVALID / UNAVAILABLE is stored and shown as exactly that.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any

from ..providers import registry
from . import analysis

log = logging.getLogger("terratrace.featured")
STORED = ("READY", "INVALID_ANALYSIS", "UNAVAILABLE")
_state: dict[str, Any] = {"running": False, "done": [], "started_at": None}


def featured_ids() -> list[str]:
    return [a["id"] for a in registry.featured()["items"]]


def default_window(aid: str) -> tuple[int, int]:
    """The standard window moved inward to measured-analysable years (unchanged while availability is unmeasured)."""
    from . import imagery   # imagery imports analysis; imported lazily
    b, c = analysis.DEFAULT_WINDOW
    av = imagery.cached_availability(aid)
    if not av:
        return b, c
    ok = [y["year"] for y in av["years"] if y.get("analysable") and b <= y["year"] <= c]
    return (ok[0], ok[-1]) if len(ok) >= 2 else (b, c)


def summary(aid: str) -> dict[str, Any]:
    """Default window + stored status (+ headline KPIs when READY) of one featured investigation. Read-only."""
    b, c = default_window(aid)
    return {"id": aid, "default_window": [b, c], **analysis.stored_status(aid, b, c)}


def _measure_availability(aid: str, loop: asyncio.AbstractEventLoop | None) -> None:
    from . import imagery
    coro = imagery.availability(aid)
    if loop is None:
        asyncio.run(coro)
    else:   # the server's loop owns the in-flight bookkeeping: run it there
        asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=900)


RETRY_PAUSE_S = 60.0


def precompute(loop: asyncio.AbstractEventLoop | None = None, per_site_timeout_s: float = 1200) -> list[tuple[str, str]]:
    """Measure availability and run the default-window analysis of every featured investigation that has no stored
    result yet — one at a time. Returns [(id, outcome)]. Safe to call repeatedly (stored results are skipped).

    A site that ends without a stored outcome (e.g. Earth Engine answered 429 in Restricted Mode) is retried ONCE,
    after the other sites and a pause — never in a loop. Its honest ERROR is never stored or shown as a result."""
    first = dict(_pass(featured_ids(), loop, per_site_timeout_s))
    retry = [aid for aid, outcome in first.items() if not outcome.startswith(("stored", *STORED))]
    if retry:
        log.info("Featured pre-compute: retrying %s once in %.0fs", retry, RETRY_PAUSE_S)
        time.sleep(RETRY_PAUSE_S)
        first.update(_pass(retry, loop, per_site_timeout_s))
    return list(first.items())


def _pass(ids: list[str], loop: asyncio.AbstractEventLoop | None, per_site_timeout_s: float) -> list[tuple[str, str]]:
    out = []
    for aid in ids:
        try:
            _measure_availability(aid, loop)
        except Exception as e:  # noqa: BLE001 — availability failure: the window stays the standard one
            log.warning("Featured %s: availability not measured (%s)", aid, type(e).__name__)
        b, c = default_window(aid)
        status = analysis.stored_status(aid, b, c)["status"]
        if status in STORED:
            out.append((aid, f"stored {status} {b}-{c}"))
            continue
        t0 = time.monotonic()
        try:
            job = analysis.create_job(aid, b, c)
            if job.future is not None:
                job.future.result(timeout=per_site_timeout_s)
            outcome = (job.envelope or {}).get("analysisStatus") or job.status
        except Exception as e:  # noqa: BLE001 — logged; the next run retries this site
            outcome = f"failed ({type(e).__name__})"
        log.info("Featured %s %s-%s pre-computed: %s in %.0fs", aid, b, c, outcome, time.monotonic() - t0)
        out.append((aid, f"{outcome} {b}-{c}"))
    return out


def start_background(loop: asyncio.AbstractEventLoop, wait_for_ready_s: float = 120) -> None:
    """Pre-compute in a daemon thread once Earth Engine is ready (never blocks startup)."""
    from ..providers.earth_engine.provider import provider as ee_provider

    def run() -> None:
        deadline = time.monotonic() + wait_for_ready_s
        while ee_provider.status()[0] != "ready":
            if time.monotonic() > deadline:
                log.info("Featured pre-compute skipped: Earth Engine not ready")
                return
            time.sleep(5)
        _state.update(running=True, started_at=time.time())
        try:
            _state["done"] = precompute(loop)
            log.info("Featured pre-compute finished: %s", _state["done"])
        finally:
            _state["running"] = False

    threading.Thread(target=run, name="featured-precompute", daemon=True).start()
