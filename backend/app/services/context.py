"""Area context: terrain and forest cover from REFERENCE datasets — never TerraTrace results.

Shown for every area whatever the state of its TerraTrace analysis, labelled as reference context, with the dataset
and year on every value:

  Terrain      Copernicus DEM GLO-30 (2024 release; radar acquired 2011–2015). A surface model: over forest the
               elevation includes the canopy.
  Tree cover   Hansen Global Forest Change v1.13 — the YEAR-2000 BASELINE (canopy >= 30 %), loss PER YEAR 2001–2025
               within that baseline, gain 2000–2012 only. Loss = stand-replacing canopy removal (incl. logging, fire,
               plantation harvest), not necessarily deforestation; method changes across versions make years not
               strictly comparable.
  Tree cover   ESA WorldCover v200 — 2021 snapshot (10 m), class "Tree cover".
None of these is current forest cover, and no "remaining" figure is derived.

One Earth Engine request per area (provider.area_context), cached per CONTEXT_VERSION (dataset IDs). A failure is
reported as UNAVAILABLE with a public reason and NOT cached, so it is measured again later. Nothing is estimated:
a value that could not be measured is null, never 0. (A loss year absent from Hansen's grouped sum over the whole
area is a measured zero: every pixel was evaluated and none was lost that year.)
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from ..config import settings
from ..lru import LRUDict
from ..providers.earth_engine import provider as P

log = logging.getLogger("terratrace.context")

LABEL = "Reference context, not a TerraTrace result"
CONTEXT_VERSION = "ctx-1-" + hashlib.sha256("|".join([P.DEM, P.HANSEN, P.WORLDCOVER, str(P.HANSEN_CANOPY),
                                                      str(P.STEEP_SLOPE_DEG)]).encode()).hexdigest()[:8]
CACHE = settings.cache_dir / "context"
HANSEN_LOSS_YEARS = list(range(2001, 2026))   # v1.13: lossyear 1..25

SOURCES = {
    "dem": {"dataset": "Copernicus DEM GLO-30", "id": P.DEM, "year": "2011–2015", "year_label": "acquired 2011–2015 (2024 release)",
            "resolution_m": 30, "note": "Surface model: over forest, elevation includes the canopy."},
    "hansen": {"dataset": "Hansen Global Forest Change v1.13", "id": P.HANSEN, "resolution_m": 30,
               "note": "Loss is stand-replacing canopy removal (incl. logging, fire, plantation harvest), not necessarily "
                       "deforestation; method updates make years not strictly comparable."},
    "worldcover": {"dataset": "ESA WorldCover v200", "id": P.WORLDCOVER, "year": "2021", "year_label": "2021", "resolution_m": 10,
                   "note": "Class 'Tree cover' (mangroves are a separate class); share of the land area (permanent water excluded)."},
}

_memory: LRUDict = LRUDict(settings.memory_cache_entries)
_failures: LRUDict = LRUDict(settings.memory_cache_entries)   # aid -> (public reason, monotonic time)
FAILURE_TTL_S = 120.0


def _num(v: Any) -> float | None:
    return None if v is None else float(v)


def _pct(part: float | None, whole: float | None) -> float | None:
    """Unrounded share (rounded once, by the caller, at display precision — never twice)."""
    return None if part is None or not whole else 100.0 * part / whole


def _r(v: float | None, n: int = 1) -> float | None:
    return None if v is None else round(v, n)


def unavailable(reason: str) -> dict[str, Any]:
    return {"status": "UNAVAILABLE", "reason": reason, "label": LABEL, "context_version": CONTEXT_VERSION,
            "terrain": None, "forest": None}


def parse(raw: dict[str, Any]) -> dict[str, Any]:
    """Interpret provider.area_context's raw measurements. Pure function; never fills a gap."""
    aoi_ha = _num((raw.get("aoi") or {}).get("aoi_ha"))
    el = raw.get("elevation") or {}
    dem_ha = _num((raw.get("dem_cover") or {}).get("dem_ha"))
    sl = raw.get("slope") or {}
    elevation = {k: _r(_num(el.get(f"elevation_{k}")), 0) for k in ("min", "p5", "mean", "p95", "max")}
    terrain_ok = elevation["mean"] is not None and _num(sl.get("slope")) is not None
    terrain = {
        "status": "READY" if terrain_ok else "UNAVAILABLE",
        "reason": None if terrain_ok else "Elevation could not be measured for this area (no Copernicus DEM data).",
        "source": SOURCES["dem"],
        "elevation_m": elevation if terrain_ok else None,
        "slope_mean_deg": _r(_num(sl.get("slope"))) if terrain_ok else None,
        "steep_share_pct": _r(100.0 * _num(sl.get("steep")), 1) if terrain_ok and sl.get("steep") is not None else None,
        "steep_threshold_deg": P.STEEP_SLOPE_DEG,
        "dem_coverage_pct": _r(_pct(dem_ha, aoi_ha), 1),
    }

    hn = raw.get("hansen") or {}
    land_ha, f2000_ha, gain_ha = _num(hn.get("land_ha")), _num(hn.get("forest2000_ha")), _num(hn.get("gain_ha"))
    groups = (raw.get("loss_by_year") or {}).get("groups")
    hansen_ok = land_ha is not None and land_ha > 0 and f2000_ha is not None and groups is not None
    by_year: dict[int, float] = {}
    if hansen_ok:
        for g in groups:
            y = 2000 + int(g["lossyear"])
            by_year[y] = by_year.get(y, 0.0) + float(g["sum"])
    src_h = SOURCES["hansen"]
    hansen_reason = None if hansen_ok else "Hansen Global Forest Change could not be measured for this area."
    tree_2000 = {
        "status": "READY" if hansen_ok else "UNAVAILABLE", "reason": hansen_reason,
        "source": {**src_h, "year": "2000", "year_label": "year-2000 baseline"},
        "canopy_threshold_pct": P.HANSEN_CANOPY,
        "area_ha": _r(f2000_ha) if hansen_ok else None,
        "share_of_land_pct": _r(_pct(f2000_ha, land_ha), 1) if hansen_ok else None,
        "land_ha": _r(land_ha) if hansen_ok else None,
    }
    loss = {
        "status": "READY" if hansen_ok else "UNAVAILABLE", "reason": hansen_reason,
        "source": {**src_h, "year": "2001–2025", "year_label": "loss per year 2001–2025, within the year-2000 tree cover"},
        # Every year 2001–2025 of the dataset; a year with no loss pixel over the measured area is a measured 0.
        "years": [{"year": y, "loss_ha": round(by_year.get(y, 0.0), 1)} for y in HANSEN_LOSS_YEARS] if hansen_ok else None,
        "total_ha": round(sum(by_year.values()), 1) if hansen_ok else None,
        "share_of_2000_tree_cover_pct": _r(_pct(sum(by_year.values()), f2000_ha), 1) if hansen_ok else None,
    }
    gain = {
        "status": "READY" if hansen_ok and gain_ha is not None else "UNAVAILABLE",
        "reason": None if hansen_ok and gain_ha is not None else "Hansen gain could not be measured for this area.",
        "source": {**src_h, "year": "2000–2012", "year_label": "gain 2000–2012 only (not updated after 2012)"},
        "area_ha": _r(gain_ha) if hansen_ok else None,
    }

    wc = raw.get("worldcover") or {}
    wc_land, wc_tree = _num(wc.get("land_ha")), _num(wc.get("tree_ha"))
    wc_ok = wc_land is not None and wc_land > 0 and wc_tree is not None
    worldcover = {
        "status": "READY" if wc_ok else "UNAVAILABLE",
        "reason": None if wc_ok else "ESA WorldCover could not be measured for this area.",
        "source": SOURCES["worldcover"],
        "area_ha": _r(wc_tree) if wc_ok else None,
        "share_of_land_pct": _r(_pct(wc_tree, wc_land), 1) if wc_ok else None,
    }
    any_ok = terrain_ok or hansen_ok or wc_ok
    return {
        "status": "READY" if any_ok else "UNAVAILABLE",
        "reason": None if any_ok else "No reference dataset could be measured for this area.",
        "label": LABEL, "context_version": CONTEXT_VERSION,
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "area_ha": _r(aoi_ha),
        "terrain": terrain,
        "forest": {"tree_cover_2000": tree_2000, "loss_by_year": loss, "gain_2000_2012": gain, "worldcover_2021": worldcover},
        "layers": None,   # filled per area by layers_for()
    }


def layers_for(aid: str) -> list[dict[str, Any]]:
    """Reference map layers served by GET /api/tiles/{aid}/context/{layer}/... (never TerraTrace results)."""
    meta = {
        "hillshade": ("Hillshade", SOURCES["dem"]["dataset"], "acquired 2011–2015"),
        "slope": ("Slope (0–45°)", SOURCES["dem"]["dataset"], "acquired 2011–2015"),
        "treecover2000": (f"Tree cover ≥ {P.HANSEN_CANOPY} % canopy · year 2000", SOURCES["hansen"]["dataset"], "2000 baseline"),
        "lossyear": ("Tree cover loss year · 2001–2025", SOURCES["hansen"]["dataset"], "2001–2025"),
    }
    return [{"id": k, "label": v[0], "dataset": v[1], "year_label": v[2], "reference": True,
             "tiles": [f"/api/tiles/{aid}/context/{k}/{{z}}/{{x}}/{{y}}"]} for k, v in meta.items()]


def _path(aid: str):
    return CACHE / f"{aid}-{CONTEXT_VERSION}.json"


def cached(aid: str) -> dict[str, Any] | None:
    """The stored context, or the recent failure as UNAVAILABLE, or None (never computes)."""
    doc = _memory.get(aid)
    if doc is None:
        try:
            doc = json.loads(_path(aid).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            doc = None
        if doc is not None and doc.get("context_version") == CONTEXT_VERSION:
            _memory[aid] = doc
        else:
            doc = None
    if doc is not None:
        return {**doc, "layers": layers_for(aid)}
    fail = _failures.get(aid)
    if fail and time.monotonic() - fail[1] < FAILURE_TTL_S:
        return unavailable(fail[0])
    return None


def ensure(aid: str, geometry: dict[str, Any]) -> dict[str, Any]:
    """The context of an area, measured once (blocking; call off the event loop). Never raises: a failure returns an
    UNAVAILABLE context with a public reason (details stay in the log) and is not cached."""
    doc = cached(aid)
    if doc is not None:   # stored, or a failure still inside its back-off window (no Earth Engine hammering)
        return doc
    try:
        doc = parse(P.provider.area_context(geometry))
    except Exception as e:  # noqa: BLE001 — Earth Engine / network; the public reason never carries raw error text
        log.warning("Area context %s unavailable: %s: %s", aid, type(e).__name__, str(e)[:300])
        reason = ("Earth Engine is throttling requests right now; reference context will be measured again shortly."
                  if "Too Many Requests" in str(e) or "429" in str(e) else
                  "Reference context could not be measured right now.")
        _failures[aid] = (reason, time.monotonic())
        return unavailable(reason)
    _failures.pop(aid, None)
    _memory[aid] = doc
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        _path(aid).write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    except OSError as e:
        log.warning("Area context cache write failed: %s", e)
    return {**doc, "layers": layers_for(aid)}
