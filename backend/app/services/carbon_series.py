"""Carbon over time: above-ground tree biomass carbon of an area for every ESA CCI Biomass epoch, and its change.

The carbon INDEX of TERRATRACE stays a measurement-based estimate: ESA CCI above-ground biomass (a satellite-derived
map with a per-pixel standard deviation) × 0.47, the IPCC (2006) default carbon fraction — the same rule as the quick
scan (services/quickscan.py). An IPCC Tier 1 estimate (land-cover area × default carbon density per class) is NOT
computed: its forest defaults depend on the FAO Global Ecological Zone, which is not available in Earth Engine for this
project yet (docs/QUICKSCAN_PLAN.md, "IPCC Tier 1 — future cross-check"). Nothing is substituted for it.

One Earth Engine request per area (providers/earth_engine/quickscan.carbon_series), on the quick scan's single worker,
stored on disk; GET never computes.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from ..lru import LRUDict
from ..config import settings
from ..providers.earth_engine import provider as P
from ..providers.earth_engine import quickscan as Q
from . import analysis, quickscan

log = logging.getLogger("terratrace.carbon")
VERSION = f"cs-2-{Q.CCI_AGB.rsplit('/', 1)[-1]}-{Q.CARBON_FRACTION}"
# Change is measured over the consistent annual epochs only; 2007 and 2010 come from earlier radar inputs (shown, not used).
CHANGE_FROM_YEAR = 2015
# CCI pixels without a value are masked where there is no above-ground tree biomass (checked 2026-11-18: the Sahara and
# Gurugram's built-up core are fully masked; farmland and forest carry values), so they count as zero, not as a data gap.
MASK_NOTE = "Pixels without a CCI value (e.g. desert, dense built-up land) are counted as no above-ground tree biomass."
CAVEAT = ("Differences between CCI epochs include map uncertainty: ESA advises caution when reading small differences "
          "between biomass maps as real change. The range uses the per-pixel standard deviation (widest case).")

_memory: LRUDict = LRUDict(settings.memory_cache_entries)
_running: dict[str, Any] = {}
_failures: LRUDict = LRUDict(settings.memory_cache_entries)


def _r(v: float | None, n: int) -> float | None:
    return None if v is None else round(v, n)


def parse(raw: dict[str, Any]) -> dict[str, Any]:
    """Per-epoch carbon (t C) with range and coverage, and the change between the first and last usable epochs."""
    series = []
    for y in Q.CCI_YEARS:
        s = raw.get(str(y))
        if not s or float(s.get("covered_ha") or 0.0) <= 0:
            series.append({"year": y, "status": "UNAVAILABLE", "reason": f"No CCI biomass values over this area for {y}."})
            continue
        area, covered = float(s.get("area_ha") or 0.0), float(s["covered_ha"])
        total, spread = float(s.get("agb_x_ha") or 0.0) * Q.CARBON_FRACTION, float(s.get("sd_x_ha") or 0.0) * Q.CARBON_FRACTION
        cov = covered / area if area else None
        series.append({"year": y, "status": "READY", "total_t": _r(total, 0), "density_t_per_ha": _r(total / covered, 2),
                       "range_t": [_r(max(0.0, total - spread), 0), _r(total + spread, 0)], "coverage_share": _r(cov, 4),
                       "usable_for_change": y >= CHANGE_FROM_YEAR})
    usable = [s for s in series if s.get("usable_for_change")]
    change = None
    if len(usable) >= 2:
        a, b = usable[0], usable[-1]
        change = {"from_year": a["year"], "to_year": b["year"], "change_t": _r(b["total_t"] - a["total_t"], 0),
                  "change_pct": _r((b["total_t"] - a["total_t"]) / a["total_t"] * 100, 1) if a["total_t"] else None,
                  "ranges_overlap": not (b["range_t"][0] > a["range_t"][1] or b["range_t"][1] < a["range_t"][0])}
    return {
        "status": "READY" if any(s["status"] == "READY" for s in series) else "UNAVAILABLE",
        "label": "Estimated above-ground tree carbon over time (ESA CCI Biomass × 0.47)",
        "estimate": True,
        "method": f"ESA CCI above-ground biomass v6.0 (oven-dry woody biomass of living trees, 100 m) × {Q.CARBON_FRACTION} "
                  f"(IPCC 2006 default carbon fraction of dry wood), summed over the area for each epoch. {MASK_NOTE} "
                  f"Change is measured between the first and last epochs from {CHANGE_FROM_YEAR} on; 2007 and 2010 come from "
                  "earlier radar inputs and are shown for context only.",
        "source": {"dataset": "ESA CCI Above-Ground Biomass v6.0", "id": Q.CCI_AGB, "resolution_m": Q.CCI_SCALE,
                   "citation": "Santoro, M. & Cartus, O. ESA Biomass Climate Change Initiative (Biomass_cci): global forest "
                               "above-ground biomass, v6.0 (Earth Engine catalog ESA/CCI/Above_Ground_Biomass/V6_0)."},
        "carbon_fraction": Q.CARBON_FRACTION,
        "series": series, "change": change, "caveat": CAVEAT,
        "excludes": "Below-ground biomass, dead wood, litter and soil carbon are not included.",
        "tier1": {"status": "NOT_COMPUTED",
                  "reason": "An IPCC Tier 1 estimate needs the FAO Global Ecological Zone of the area to choose default carbon "
                            "densities; that layer is not available here yet, so no Tier 1 figure is shown."},
    }


def _path(aid: str):
    return quickscan.CACHE / f"carbon-series-{aid}-{VERSION}.json"


def stored(aid: str) -> dict[str, Any] | None:
    doc = _memory.get(aid)
    if doc is None:
        try:
            doc = json.loads(_path(aid).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        _memory[aid] = doc
    return doc


def status(aid: str) -> dict[str, Any]:
    """Stored series, PROCESSING, a recent failure, or NOT_RUN. Never computes."""
    analysis.aoi_doc(aid)   # AnalysisNotFound for an unknown area
    doc = stored(aid)
    if doc is not None:
        return doc
    fut = _running.get(aid)
    if fut is not None and not fut.done():
        return {"aoi_id": aid, "status": "PROCESSING"}
    fail = _failures.get(aid)
    if fail and time.monotonic() - fail[1] < quickscan.FAILURE_TTL_S:
        return {"aoi_id": aid, "status": "UNAVAILABLE", "reason": fail[0], "retryable": True}
    return {"aoi_id": aid, "status": "NOT_RUN"}


def start(aid: str) -> dict[str, Any]:
    aoi = analysis.aoi_doc(aid)
    if stored(aid) is not None:
        return stored(aid)
    target = analysis.analysis_target(aoi)
    if (target.get("area_km2") or 0) > settings.interactive_max_km2:
        return {"aoi_id": aid, "status": "UNAVAILABLE", "retryable": False,
                "reason": f"Limited to {settings.interactive_max_km2:,.0f} km²; this area is {target['area_km2']:,.0f} km²."}
    if not P.provider.credentials_configured():
        return {"aoi_id": aid, "status": "UNAVAILABLE", "retryable": False,
                "reason": "Google Earth Engine is not configured on this server."}
    fut = _running.get(aid)
    if fut is None or fut.done():
        _failures.pop(aid, None)
        _running[aid] = quickscan._submit(_run, aid, target["geometry"])
    return status(aid)


def _run(aid: str, geometry: dict[str, Any]) -> None:
    t0 = time.monotonic()
    try:
        doc = parse(Q.carbon_series(geometry))
    except Exception as e:  # noqa: BLE001 — Earth Engine / network; never raw error text to the client
        log.warning("[carbon] FAILED aoi=%s after %.1fs: %s", aid, time.monotonic() - t0, type(e).__name__)
        _failures[aid] = ("The carbon series could not be computed right now; try again in a few minutes.", time.monotonic())
        return
    doc = {**doc, "aoi_id": aid, "version": VERSION, "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "elapsed_s": round(time.monotonic() - t0, 1)}
    _memory[aid] = doc
    try:
        quickscan.CACHE.mkdir(parents=True, exist_ok=True)
        _path(aid).write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    except OSError as e:
        log.warning("[carbon] cache write failed: %s", e)
    log.info("[carbon] %s aoi=%s in %.1fs", doc["status"], aid, doc["elapsed_s"])
