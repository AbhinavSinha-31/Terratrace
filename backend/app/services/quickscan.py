"""Quick scan — surface temperature, land cover and above-ground tree biomass carbon for any area, on request.

Tier "Quick scan": computed from public datasets, NOT validated for the area (docs/QUICKSCAN_PLAN.md). It never enters
the forest "Detected change" totals and is never called a TerraTrace classification. Every value carries its dataset,
year and resolution.

Runs only when a user presses "Run quick scan" (POST /api/quickscan/{aid}), as a background job on the analysis
workers (one Earth Engine request, providers/earth_engine/quickscan.py). A finished scan is stored in
cache_dir/quickscan/<aid>-<year>-<season>-<version>.json and opens instantly afterwards. A FAILURE (Earth Engine error,
timeout) is reported as UNAVAILABLE with a public reason and is not stored, so it can be run again. A measured shortage
(e.g. fewer than 5 usable Landsat scenes) is a result and is stored, like any other measurement. New scans are refused
while Earth Engine reports restricted mode (quota exhausted); stored scans still open.
"""

from __future__ import annotations

import concurrent.futures
import contextlib
import json
import logging
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from ..config import settings
from ..lru import LRUDict
from ..providers.earth_engine import provider as P
from ..providers.earth_engine import quickscan as Q
from . import analysis, land_metrics

log = logging.getLogger("terratrace.quickscan")

CACHE = settings.cache_dir / "quickscan"
TIER = "quick_scan"
LABEL = "Quick scan · public datasets, not validated for this area"
FIRST_YEAR = 2016                     # first full year of Dynamic World (from 2015-06-27)
DEFAULT_SEASON = "all"
UHI_MIN_SHARE = 0.05                  # built-up land must be ≥ 5 % of the land …
UHI_MIN_HA = 200.0                    # … and ≥ 2 km² (and the rest of the land ≥ 2 km² too)
FAILURE_TTL_S = 120.0                 # a failed scan is not retried by itself; a new request after this runs again
RESTRICTED_SLOWDOWN = (5, 6)          # forest analyses ran ~5–6× slower in restricted mode (2026-10-07: ~100 s → ~580 s)
TROPICS_LAT = 15.0                    # |latitude| below this: single seasons are often too cloudy → recommend all months
ESTIMATE_SAMPLE = 50                  # stored scans used for the time estimate (most recent first)

# Dynamic World classes (index = label value) with display names; colours are the map layer's own (Q.DW_PALETTE).
_DW_NAMES = ["Water", "Trees", "Grass", "Flooded vegetation", "Crops", "Shrub and scrub", "Built area", "Bare ground",
             "Snow and ice"]
DW_CLASSES = [(key, _DW_NAMES[i], "#" + Q.DW_PALETTE[i]) for i, key in enumerate(P.DW_LABELS)]
WATER, BUILT = 0, 6

SOURCES = {
    "landsat": {"dataset": "Landsat 8 and 9 Collection 2 Level-2 surface temperature (USGS)",
                "ids": ["LANDSAT/LC08/C02/T1_L2", "LANDSAT/LC09/C02/T1_L2"], "resolution_m": 30,
                "note": "Thermal band acquired at 100 m, delivered at 30 m. Same scene masking as the research pipeline."},
    "dynamic_world": {"dataset": "Dynamic World V1 (Google, World Resources Institute)", "id": P.DW, "resolution_m": 10,
                      "statistics_resolution_m": Q.SCALE},
    "cci": {"dataset": "ESA CCI Above-Ground Biomass v6.0", "id": Q.CCI_AGB, "year": Q.CCI_YEAR, "resolution_m": Q.CCI_SCALE},
    "worldcover": {"dataset": "ESA WorldCover v200", "id": P.WORLDCOVER, "year": Q.WORLDCOVER_YEAR, "resolution_m": 10},
}
# Shown with every quick-scan result: nothing here was checked against ground truth for the area.
DISCLAIMER = ("Agreement, not accuracy: these values come from public datasets and were not validated for this area. "
              "The WorldCover figure is agreement between two maps, not accuracy.")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

_memory: LRUDict = LRUDict(settings.memory_cache_entries)
_failures: LRUDict = LRUDict(settings.memory_cache_entries)      # key -> (public reason, code, monotonic time)
_running: dict[str, Any] = {}                                    # key -> Future
_started: set[str] = set()                                       # keys whose scan has left the queue
_lock = threading.Lock()
# Quick scans run ONE AT A TIME on their own worker (a second request waits in the queue, shown as queued), separate
# from the forest analyses' workers.
_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="tt-quickscan")
_submit: Callable[..., Any] = lambda fn, *a: _POOL.submit(fn, *a)   # noqa: E731 — replaced in tests


# ----------------------------------------------------------------------------- Earth Engine restricted mode
def _pacific_offset_h(utc: datetime) -> int:
    """UTC offset of US Pacific time (−7 in daylight time, −8 otherwise): DST from the second Sunday of March 02:00
    local to the first Sunday of November 02:00 local (US rule since 2007). No tz database needed."""
    y = utc.year

    def nth_sunday(month: int, n: int) -> datetime:
        d = datetime(y, month, 1, tzinfo=timezone.utc)
        first = d + timedelta(days=(6 - d.weekday()) % 7)
        return first + timedelta(weeks=n - 1)
    start = nth_sunday(3, 2) + timedelta(hours=2 + 8)    # 02:00 PST = 10:00 UTC
    end = nth_sunday(11, 1) + timedelta(hours=2 + 7)     # 02:00 PDT = 09:00 UTC
    return -7 if start <= utc < end else -8


def quota_month_bounds(now: datetime | None = None) -> tuple[datetime, datetime]:
    """(start, end) in UTC of the current Earth Engine quota month: quotas reset on the 1st at 00:00 Pacific Time."""
    now = now or datetime.now(timezone.utc)
    local = now + timedelta(hours=_pacific_offset_h(now))
    start_local = datetime(local.year, local.month, 1, tzinfo=timezone.utc)
    end_local = datetime(local.year + (local.month == 12), local.month % 12 + 1, 1, tzinfo=timezone.utc)

    def to_utc(d: datetime) -> datetime:
        return d - timedelta(hours=_pacific_offset_h(d + timedelta(hours=8)))
    return to_utc(start_local), to_utc(end_local)


def restricted_mode() -> dict[str, Any] | None:
    """Restricted mode seen in THIS quota month (it cannot end before the monthly reset, unless the tier changes).
    Requests still run in restricted mode, more slowly: a quick scan gets a longer deadline and a slower estimate."""
    seen = P.RESTRICTED_MODE.get("seen_at")
    if seen is None:
        return None
    start, end = quota_month_bounds()
    if datetime.fromtimestamp(seen, tz=timezone.utc) < start:
        return None
    reset = end + timedelta(hours=_pacific_offset_h(end))            # the reset as a Pacific calendar date
    return {"active": True, "until": end.isoformat(timespec="minutes"), "until_label": f"{reset.day} {reset.strftime('%B')}",
            "deadline_s": settings.quickscan_restricted_deadline_s,
            "message": "Earth Engine is in its slower restricted mode this month. A quick scan still works but may take several "
                       f"minutes. Full speed returns on {reset.day} {reset.strftime('%B')}."}


class QuickScanError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


# ----------------------------------------------------------------------------- inputs
def last_year() -> int:
    """The latest COMPLETE calendar year (a scan covers a whole year of Dynamic World)."""
    return date.today().year - 1


def validate(year: int | None, season: str | None) -> tuple[int, str]:
    y = last_year() if year is None else int(year)
    s = DEFAULT_SEASON if season is None else season
    if not FIRST_YEAR <= y <= last_year():
        raise QuickScanError("invalid_year", f"Quick scans cover complete years from {FIRST_YEAR} to {last_year()}.")
    if s not in Q.SEASONS:
        raise QuickScanError("invalid_season", f"Season must be one of: {', '.join(Q.SEASONS)}.")
    return y, s


def season_hint(aoi: dict[str, Any], season: str) -> str | None:
    """Near the equator single seasons are often too cloudy for 5 clear Landsat scenes: recommend all months."""
    bbox = analysis.analysis_target(aoi).get("bbox") or aoi.get("bbox")
    if not bbox or season == "all":
        return None
    lat = (float(bbox[1]) + float(bbox[3])) / 2
    if abs(lat) < TROPICS_LAT:
        return (f"Near the equator ({abs(lat):.1f}°{'N' if lat >= 0 else 'S'}) clouds often leave too few clear Landsat scenes "
                "in a single season; All months is recommended.")
    return None


def estimate(restricted: bool = False) -> dict[str, Any]:
    """Expected run time from the scans this server has actually timed (never invented), in the matching mode. With no
    restricted-mode timing yet, the restricted estimate is the normal one × the slowdown the forest analyses showed."""
    times: dict[bool, list[float]] = {False: [], True: []}
    for f in sorted(CACHE.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:ESTIMATE_SAMPLE] if CACHE.exists() else []:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        t = d.get("elapsed_s")
        if isinstance(t, (int, float)) and t > 0:
            times[bool(d.get("restricted_mode"))].append(float(t))

    def median(v: list[float]) -> int:
        v = sorted(v)
        return round(v[len(v) // 2])
    n = len(times[restricted])
    if n:
        return {"seconds": median(times[restricted]), "restricted": restricted,
                "basis": f"median of {n} {'restricted-mode ' if restricted else ''}scan{'s' if n != 1 else ''} on this server"}
    if restricted and times[False]:
        lo, hi = (median(times[False]) * k for k in RESTRICTED_SLOWDOWN)
        return {"seconds": None, "range_s": [lo, hi], "restricted": True,
                "basis": f"{RESTRICTED_SLOWDOWN[0]}–{RESTRICTED_SLOWDOWN[1]}× the normal median, the slowdown forest analyses showed in restricted mode"}
    return {"seconds": None, "restricted": restricted, "basis": "not yet measured on this server"}


def version() -> str:
    """Method version: changes whenever a dataset, threshold or rule that affects a number changes."""
    return Q.method_version({"uhi": [UHI_MIN_SHARE, UHI_MIN_HA], "classes": [c[0] for c in DW_CLASSES]})


def _key(aid: str, year: int, season: str) -> str:
    return f"{aid}-{year}-{season}-{version()}"


def _path(key: str):
    return CACHE / f"{key}.json"


# ----------------------------------------------------------------------------- interpretation (pure)
def _r(v: float | None, n: int) -> float | None:
    return None if v is None else round(float(v), n)


def _date(ms: Any) -> str | None:
    return None if ms is None else datetime.fromtimestamp(float(ms) / 1000, tz=timezone.utc).date().isoformat()


def day_label(d: date) -> str:
    return f"{d.day} {_MONTHS[d.month - 1]} {d.year}"


def _period(start: str, end_exclusive: str, label: str | None = None) -> dict[str, str]:
    """A dataset's date window [start, end) as inclusive ISO dates and a readable label."""
    s, e = date.fromisoformat(start), date.fromisoformat(end_exclusive) - timedelta(days=1)
    return {"start": s.isoformat(), "end": e.isoformat(), "label": label or f"{day_label(s)} – {day_label(e)}"}


def periods(year: int, season: str) -> dict[str, dict[str, str]]:
    """The date window each dataset of a scan covers — the same windows the Earth Engine request filters on."""
    return {
        "dynamic_world": _period(f"{year}-01-01", f"{year + 1}-01-01"),
        "landsat": _period(*Q.season_range(year, season)),
        "cci": _period(f"{Q.CCI_YEAR}-01-01", f"{Q.CCI_YEAR + 1}-01-01", f"{Q.CCI_YEAR} (annual map)"),
        "worldcover": _period(f"{Q.WORLDCOVER_YEAR}-01-01", f"{Q.WORLDCOVER_YEAR + 1}-01-01", f"{Q.WORLDCOVER_YEAR} (annual map)"),
    }


def parse(raw: dict[str, Any], *, year: int, season: str) -> dict[str, Any]:
    """Interpret one raw measurement (providers/earth_engine/quickscan.measure). Nothing is estimated: a value that was
    not measured is null with a reason, never 0."""
    counts = raw.get("counts") or {}
    aoi_ha = float((raw.get("aoi") or {}).get("area_ha") or 0.0)
    groups = {int(g["class"]): [float(v or 0.0) for v in g["sum"]] for g in ((raw.get("classes") or {}).get("groups") or [])}
    season_label = Q.SEASON_LABELS[season]

    # ---- land cover (Dynamic World)
    classified_ha = sum(v[0] for v in groups.values())
    if raw.get("classes") is None or classified_ha <= 0:
        landcover: dict[str, Any] = {"status": "UNAVAILABLE", "reason": f"No Dynamic World images over this area in {year}.",
                                     "source": {**SOURCES["dynamic_world"], "year": year}}
    else:
        classes = []
        for i, (key, name, color) in enumerate(DW_CLASSES):
            a, low = groups.get(i, [0.0, 0.0, 0.0, 0.0])[:2]
            classes.append({"key": key, "name": name, "color": color, "area_km2": _r(a / 100, 3),
                            "share": _r(a / classified_ha, 4), "low_confidence_share": _r(low / a, 4) if a > 0 else None})
        wc = raw.get("worldcover") or {}
        compared, agree = float(wc.get("compared_ha") or 0.0), float(wc.get("agree_ha") or 0.0)
        landcover = {
            "status": "READY", "label": f"Land cover from Dynamic World (Google/WRI), {year}",
            "source": {**SOURCES["dynamic_world"], "year": year, "images": int(counts.get("dw_images") or 0),
                       "first_image": _date(counts.get("dw_first_ms")), "last_image": _date(counts.get("dw_last_ms"))},
            "method": f"Annual mean probability per class, top class; aggregated from 10 m to {Q.SCALE} m by mode.",
            "classified_km2": _r(classified_ha / 100, 3), "coverage_share": _r(classified_ha / aoi_ha, 4) if aoi_ha else None,
            "low_confidence_share": _r(sum(v[1] for v in groups.values()) / classified_ha, 4),
            "low_confidence_rule": f"top mean probability below {Q.LOW_CONFIDENCE}",
            "classes": classes,
            "worldcover_agreement": ({"share": _r(agree / compared, 4), "compared_km2": _r(compared / 100, 3),
                                      "source": SOURCES["worldcover"],
                                      "note": "Agreement with ESA WorldCover 2021 (another year and method) — a cross-check, not accuracy."}
                                     if compared > 0 else None),
        }

    # ---- land surface temperature (Landsat)
    n_scenes = int(counts.get("landsat_scenes") or 0)
    lst_src = {**SOURCES["landsat"], "year": year, "season": season, "season_label": season_label,
               "scenes": n_scenes, "spacecraft": counts.get("landsat_by_spacecraft") or {},
               "first_scene": _date(counts.get("landsat_first_ms")), "last_scene": _date(counts.get("landsat_last_ms"))}
    stats = raw.get("lst")
    if n_scenes < Q.MIN_SCENES or stats is None:
        lst: dict[str, Any] = {"status": "UNAVAILABLE", "source": lst_src, "reason_code": "too_few_scenes",
                               "scenes_found": n_scenes, "min_scenes": Q.MIN_SCENES,
                               "suggest_season": "all" if season != "all" else None,
                               "reason": f"Only {n_scenes} usable Landsat scene{'s' if n_scenes != 1 else ''} over this area for "
                                         f"{season_label} {year}; a quick scan needs at least {Q.MIN_SCENES}."}
    elif stats.get("lst_mean") is None:
        lst = {"status": "UNAVAILABLE", "source": lst_src, "reason": "No clear land pixels in the Landsat scenes of this period."}
    else:
        per_class = []
        for i, (key, name, _c) in enumerate(DW_CLASSES):
            a, _low, a_lst, x = groups.get(i, [0.0, 0.0, 0.0, 0.0])
            if a_lst > 0:
                per_class.append({"key": key, "name": name, "mean_c": _r(x / a_lst, 2), "area_km2": _r(a_lst / 100, 3),
                                  "water": i == WATER})
        lst = {
            "status": "READY", "label": f"Land surface temperature, {season_label} {year}", "source": lst_src,
            "method": "Per-pixel median of clear Landsat 8/9 scenes; water excluded from the statistics where Dynamic World maps it.",
            "mean_c": _r(stats["lst_mean"], 2), "p2_c": _r(stats.get("lst_p2"), 2), "median_c": _r(stats.get("lst_p50"), 2),
            "p98_c": _r(stats.get("lst_p98"), 2),
            "valid_share": _r(float(stats.get("valid_ha") or 0.0) / aoi_ha, 4) if aoi_ha else None,
            "per_class": per_class, "uhi": _uhi(groups),
        }

    # ---- above-ground tree biomass carbon (ESA CCI)
    c = raw.get("carbon")
    cci_src = {**SOURCES["cci"]}
    if c is None or float(c.get("covered_ha") or 0.0) <= 0:
        carbon_component: dict[str, Any] = {"id": "agb_trees", "status": "UNAVAILABLE", "source": cci_src,
                                            "reason": f"No ESA CCI biomass values over this area for {Q.CCI_YEAR}."}
    else:
        covered, agb, sd = float(c["covered_ha"]), float(c.get("agb_x_ha") or 0.0), float(c.get("sd_x_ha") or 0.0)
        total, spread = agb * Q.CARBON_FRACTION, sd * Q.CARBON_FRACTION
        carbon_component = {
            "id": "agb_trees", "status": "READY", "label": "Above-ground tree biomass carbon (ESA CCI)", "source": cci_src,
            "density_t_per_ha": _r(total / covered, 2), "total_t": _r(total, 0),
            "range_t": [_r(max(0.0, total - spread), 0), _r(total + spread, 0)],
            "coverage_share": _r(covered / float(c.get("area_ha") or covered), 4),
            "carbon_fraction": Q.CARBON_FRACTION,
            "method": f"ESA CCI above-ground biomass {Q.CCI_YEAR} (oven-dry woody biomass of living trees) × {Q.CARBON_FRACTION} "
                      "(IPCC default carbon fraction).",
            "range_rule": "± the CCI per-pixel standard deviation, summed as if fully correlated (the widest range).",
            "excludes": "Roots, dead wood, litter and soil carbon are not included.",
        }
    carbon = {"status": carbon_component["status"], "label": "Carbon", "components": [carbon_component],
              "scope": "Above-ground tree biomass only. Further carbon pools (e.g. soil) can be added as components."}

    sections = (landcover["status"], lst["status"], carbon["status"])
    return {
        "status": "READY" if "READY" in sections else "UNAVAILABLE",
        "reason": None if "READY" in sections else "None of the quick-scan datasets has values over this area.",
        "tier": TIER, "label": LABEL, "year": year, "season": season, "season_label": season_label,
        "area_km2": _r(aoi_ha / 100, 3), "landcover": landcover, "lst": lst, "carbon": carbon,
    }


def _uhi(groups: dict[int, list[float]]) -> dict[str, Any]:
    """Simple surface UHI = mean LST of built-up land − mean LST of the other land (water excluded), area-weighted."""
    label = "Simple surface UHI (built − non-built land, water excluded)"
    land_ha = sum(v[0] for k, v in groups.items() if k != WATER)
    built = groups.get(BUILT, [0.0, 0.0, 0.0, 0.0])
    rest = [v for k, v in groups.items() if k not in (WATER, BUILT)]
    built_ha, rest_ha = built[0], sum(v[0] for v in rest)
    rest_lst_ha, rest_x = sum(v[2] for v in rest), sum(v[3] for v in rest)
    share = built_ha / land_ha if land_ha else 0.0
    if share < UHI_MIN_SHARE or built_ha < UHI_MIN_HA or rest_ha < UHI_MIN_HA:
        return {"status": "UNAVAILABLE", "label": label, "built_km2": _r(built_ha / 100, 3), "built_share": _r(share, 4),
                "reason": f"Not enough built-up land for a heat-island figure: it needs at least {UHI_MIN_SHARE:.0%} of the land and "
                          f"{UHI_MIN_HA / 100:g} km² (and as much other land); this area has {built_ha / 100:.1f} km² ({share:.1%})."}
    if built[2] <= 0 or rest_lst_ha <= 0:
        return {"status": "UNAVAILABLE", "label": label, "reason": "Built-up or other land has no valid surface temperature."}
    b, n = built[3] / built[2], rest_x / rest_lst_ha
    return {"status": "READY", "label": label, "value_c": _r(b - n, 2), "built_mean_c": _r(b, 2), "other_mean_c": _r(n, 2),
            "built_km2": _r(built_ha / 100, 3), "built_share": _r(share, 4), "other_km2": _r(rest_ha / 100, 3)}


# ----------------------------------------------------------------------------- map layers
def layers_for(doc: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Map layers of a READY scan, served by GET /api/tiles/{aid}/quickscan/{layer}/{year}/{season}/{z}/{x}/{y}. A section
    that is not READY has no layer (nothing is drawn for a value that was not measured)."""
    if not doc or doc.get("status") != "READY":
        return []
    aid, y, s = doc["aoi_id"], doc["year"], doc["season"]

    def tiles(layer: str) -> list[str]:
        return [f"/api/tiles/{aid}/quickscan/{layer}/{y}/{s}/{{z}}/{{x}}/{{y}}"]
    out = []
    lst = doc.get("lst") or {}
    if lst.get("status") == "READY" and lst.get("p2_c") is not None and lst.get("p98_c") is not None:
        out.append({"id": "lst", "label": lst["label"], "tiles": tiles("lst"), "source": lst["source"],
                    "legend": {"type": "gradient", "unit": "°C", "min": lst["p2_c"], "max": lst["p98_c"],
                               "palette": ["#" + c for c in Q.LST_PALETTE],
                               "note": "Colours span this area's 2nd–98th percentile, so they are not comparable between areas."}})
    lc = doc.get("landcover") or {}
    if lc.get("status") == "READY":
        out.append({"id": "landcover", "label": lc["label"], "tiles": tiles("landcover"), "source": lc["source"],
                    "legend": {"type": "classes", "classes": [{"key": k, "name": n, "color": c} for k, n, c in DW_CLASSES],
                               "note": "Shown at Dynamic World's 10 m; statistics use 30 m (mode)."}})
    comp = ((doc.get("carbon") or {}).get("components") or [{}])[0]
    if comp.get("status") == "READY":
        lo, hi = Q.CARBON_RANGE_T_PER_HA
        out.append({"id": "carbon", "label": comp["label"], "tiles": tiles("carbon"), "source": comp["source"],
                    "legend": {"type": "gradient", "unit": "t C/ha", "min": lo, "max": hi, "palette": ["#" + c for c in Q.CARBON_PALETTE],
                               "note": f"Same colour range for every area; values above {hi:g} t C/ha show as the darkest colour."}})
    return out


def lst_range(doc: dict[str, Any]) -> tuple[float, float] | None:
    lst = doc.get("lst") or {}
    return (lst["p2_c"], lst["p98_c"]) if lst.get("status") == "READY" and lst.get("p2_c") is not None else None


def present(doc: dict[str, Any]) -> dict[str, Any]:
    """A stored scan as the API serves it: its map layers, the date window of every dataset and the disclaimer. All are
    derived from the scan's year and season when served, so scans stored before they existed show them too."""
    if not doc.get("quickscan_version"):
        return doc
    p = periods(doc["year"], doc["season"])

    def dated(section: dict[str, Any] | None, key: str) -> dict[str, Any] | None:
        return None if section is None else {**section, "source": {**section["source"], "period": p[key]}}
    out = {**doc, "disclaimer": DISCLAIMER, "landcover": dated(doc.get("landcover"), "dynamic_world"),
           "lst": dated(doc.get("lst"), "landsat")}
    agreement = (out["landcover"] or {}).get("worldcover_agreement")
    if agreement:
        out["landcover"]["worldcover_agreement"] = dated(agreement, "worldcover")
    if out["landcover"] and out["landcover"].get("status") == "READY":
        out["landcover"]["advisor_classes"] = land_metrics.advisor_classes(out["landcover"])
    if out["lst"] and out["lst"].get("status") == "READY":
        out["lst"]["uhi_vegetated"] = land_metrics.uhi_vegetated(out["lst"], out["landcover"])
    if doc.get("carbon"):
        out["carbon"] = {**doc["carbon"], "components": [dated(c, "cci") if c.get("id") == "agb_trees" else c
                                                         for c in doc["carbon"]["components"]]}
    if doc.get("status") == "READY":
        out["layers"] = layers_for(doc)
    return out


# ----------------------------------------------------------------------------- cache and jobs
def _envelope(aid: str, year: int, season: str, status: str, **extra: Any) -> dict[str, Any]:
    return {"aoi_id": aid, "status": status, "tier": TIER, "label": LABEL, "year": year, "season": season,
            "season_label": Q.SEASON_LABELS[season], "first_year": FIRST_YEAR, "last_year": last_year(), **extra}


def stored(aid: str, year: int, season: str) -> dict[str, Any] | None:
    """The stored scan of an area, year and season (current method version), or None. Never computes."""
    try:
        v = version()
    except P.EarthEngineError:
        return None
    key = _key(aid, year, season)
    doc = _memory.get(key)
    if doc is None:
        try:
            doc = json.loads(_path(key).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if doc.get("quickscan_version") != v:
            return None
        _memory[key] = doc
    return doc


def status(aid: str, year: int | None = None, season: str | None = None) -> dict[str, Any]:
    """Stored scan, PROCESSING, a recent failure (UNAVAILABLE, retryable) or NOT_RUN. Never computes."""
    analysis.aoi_doc(aid)                      # AnalysisNotFound for an unknown area
    y, s = validate(year, season)
    doc = stored(aid, y, s)
    if doc is not None:
        return present(doc)
    try:
        key = _key(aid, y, s)
    except P.EarthEngineError as e:
        return _envelope(aid, y, s, "UNAVAILABLE", reason=e.message, reason_code=e.code, retryable=False)
    slow = restricted_mode()
    fut = _running.get(key)
    if fut is not None and not fut.done():
        return _envelope(aid, y, s, "PROCESSING", queued=key not in _started, restricted_mode=slow, estimate=estimate(bool(slow)))
    fail = _failures.get(key)
    aoi = analysis.aoi_doc(aid)
    extra = {"estimate": estimate(bool(slow)), "season_hint": season_hint(aoi, s), "restricted_mode": slow}
    if fail and time.monotonic() - fail[2] < FAILURE_TTL_S:
        return _envelope(aid, y, s, "UNAVAILABLE", reason=fail[0], reason_code=fail[1], retryable=True, **extra)
    blocked = _refusal(aid, y, s, analysis.analysis_target(aoi))   # what a run would meet right now (no Earth Engine call)
    if blocked is not None:
        extra["blocked"] = {k: blocked[k] for k in ("reason_code", "reason", "retryable")}
    return _envelope(aid, y, s, "NOT_RUN", **extra)


def _refusal(aid: str, y: int, s: str, target: dict[str, Any]) -> dict[str, Any] | None:
    area = target.get("area_km2")
    if area is not None and area > settings.interactive_max_km2:
        return _envelope(aid, y, s, "UNAVAILABLE", reason_code="area_too_large", retryable=False,
                         reason=f"Quick scans are limited to {settings.interactive_max_km2:,.0f} km²; this area is {area:,.0f} km².")
    if not P.provider.credentials_configured():
        return _envelope(aid, y, s, "UNAVAILABLE", reason_code="ee_unconfigured", retryable=False,
                         reason="Live Earth Engine is not configured on this server, so quick scans cannot run.")
    return None   # restricted mode is NOT a refusal: the scan runs, slower (restricted_mode())


def start(aid: str, year: int | None = None, season: str | None = None) -> dict[str, Any]:
    """Run a quick scan in the background (or join the running one). Returns immediately with its state."""
    aoi = analysis.aoi_doc(aid)
    y, s = validate(year, season)
    doc = stored(aid, y, s)
    if doc is not None:
        return present(doc)
    target = analysis.analysis_target(aoi)
    refused = _refusal(aid, y, s, target)
    if refused is not None:
        return refused
    try:
        key = _key(aid, y, s)
    except P.EarthEngineError as e:
        return _envelope(aid, y, s, "UNAVAILABLE", reason=e.message, reason_code=e.code, retryable=False)
    with _lock:
        fut = _running.get(key)
        if fut is None or fut.done():
            _failures.pop(key, None)
            log.info("[quickscan] QUEUED aoi=%s year=%s season=%s area_km2=%s", aid, y, s, target.get("area_km2"))
            _running[key] = _submit(_run, aid, y, s, key, target["geometry"], target.get("area_km2"))
    return status(aid, y, s)


def _run(aid: str, y: int, s: str, key: str, geometry: dict[str, Any], area_km2: float | None) -> None:
    _started.add(key)
    t0 = time.monotonic()
    slow = restricted_mode()
    try:
        with Q.request_deadline(slow["deadline_s"]) if slow else contextlib.nullcontext():
            raw = Q.measure(geometry, y, s)
        doc = parse(raw, year=y, season=s)
    except Exception as e:  # noqa: BLE001 — Earth Engine / network; the public reason never carries raw error text
        text = str(e)
        if isinstance(e, P.EarthEngineError) and e.code in ("ee_unconfigured", "quickscan_unavailable"):
            reason, code = e.message, e.code
        elif "Too Many Requests" in text or "429" in text:
            reason, code = "Earth Engine is throttling requests right now; run the quick scan again in a few minutes.", "ee_throttled"
        elif any(w in text.lower() for w in ("deadline", "timed out", "timeout")):
            reason, code = ("Earth Engine took too long to answer"
                            + (f" even with the {slow['deadline_s'] / 60:.0f}-minute restricted-mode limit" if slow else "")
                            + "; run the quick scan again, or choose All months or a smaller area.", "ee_timeout")
        elif "quota" in text.lower() or "restricted" in text.lower():
            reason, code = "Earth Engine's free compute quota is used up right now; run the quick scan again later.", "quota_restricted"
        else:
            reason, code = "The quick scan could not be computed right now.", "quickscan_failed"
        log.warning("[quickscan] FAILED aoi=%s year=%s season=%s after %.1fs: %s: %s", aid, y, s, time.monotonic() - t0,
                    type(e).__name__, text[:300])
        _failures[key] = (reason, code, time.monotonic())
        _started.discard(key)
        return
    doc = {**_envelope(aid, y, s, doc["status"]), **doc, "aoi_id": aid, "quickscan_version": version(),
           "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "elapsed_s": round(time.monotonic() - t0, 1),
           "analysed_area_km2": area_km2, "restricted_mode": bool(slow or restricted_mode())}
    _memory[key] = doc
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        _path(key).write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    except OSError as e:
        log.warning("[quickscan] cache write failed: %s", e)
    _started.discard(key)
    log.info("[quickscan] %s aoi=%s year=%s season=%s in %.1fs%s", doc["status"], aid, y, s, doc["elapsed_s"],
             " (restricted mode)" if doc["restricted_mode"] else "")


def compare(aid: str, from_year: int, to_year: int, season: str | None = None) -> dict[str, Any]:
    """Change between two STORED scans of an area (same season). Never computes; a missing scan is reported as such."""
    analysis.aoi_doc(aid)
    y1, s = validate(from_year, season)
    y2, _ = validate(to_year, s)
    if y1 >= y2:
        raise QuickScanError("invalid_request", "The second year must be after the first.")
    a, b = stored(aid, y1, s), stored(aid, y2, s)
    missing = [y for y, d in ((y1, a), (y2, b)) if d is None or d.get("status") != "READY"]
    if missing:
        return {"aoi_id": aid, "season": s, "from_year": y1, "to_year": y2, "status": "NOT_RUN", "missing_years": missing,
                "reason": f"Run the quick scan for {' and '.join(map(str, missing))} first (same season) to compare."}
    return {"status": "READY", **land_metrics.compare(present(a), present(b)), "disclaimer": DISCLAIMER}
