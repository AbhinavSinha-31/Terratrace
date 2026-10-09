"""TERRATRACE scientific definitions shared by every provider.

Keeping the forest mask, change rule, severity, evidence model, sensor eras,
observation-quality rules and result-validity checks in one place guarantees every
Earth Engine result is scored identically and documented once (see docs/METHOD.md).
"""

from __future__ import annotations

import math
from typing import Any

# --------------------------------------------------------------------------- method version
# Bump whenever any rule below (or the Earth Engine pipeline) changes: cached results
# computed under another version are never reused.
METHOD_VERSION = "tt-ee-2.4"   # 2.4: upper-quartile (p75) DW tree probability (2.3 used p90: unstable at Rondonia); 2.2: seasonal rule; 2.1: leaf-on (p90) NDVI

# --------------------------------------------------------------------------- definitions
FOREST_TREE_PROB = 0.50   # Dynamic World "trees" probability, per-pixel FOREST_TREE_PERCENTILE of the year's observations
FOREST_NDVI = 0.60        # NDVI floor for the operational forest mask
FOREST_NDVI_PERCENTILE = 90  # the NDVI floor is applied to leaf-on NDVI: per-pixel 90th percentile of clear observations
# Tree probability: the UPPER QUARTILE of the year's Dynamic World observations - a pixel is tree-covered only if at least a
# quarter of its observations say so. Measured 2026-10-09 at all four featured sites (max gross gain %/yr, limit 5):
# annual mean 8.18 at Hasdeo (deciduous: leaf-off scenes pull it to 0.50); p90 6.82 at Rondonia (a few transient high
# scenes over pasture/regrowth flip it); p75 3.14 / 3.82 / 0.63 / 2.35 - stable at every site (docs/METHOD.md).
FOREST_TREE_PERCENTILE = 75
LANDSAT_FOREST_NDVI = 0.60  # historical proxy (no Dynamic World before mid-2015)
D_NDVI = -0.20
D_NBR = -0.25
D_TREE = -0.30
MIN_CLEAR_OBS = 5         # event evidence check (per-pixel minimum inside an event)
MMU_HA = 2.0
# Only the largest change polygons are measured and returned (events_meta records whether more were found).
MAX_EVENTS = 60
PERSISTENCE_OK = 0.70
REFERENCE_OK = 0.30

# --------------------------------------------------------------------------- observation quality & validity
# A pixel is OBSERVED in a year only with at least this many cloud-free observations
# (median compositing needs ≥ 3 values to reject a single missed cloud/shadow).
MIN_PIXEL_CLEAR_OBS = 3
# Modern era: the forest rule uses the Dynamic World annual mean tree probability,
# which likewise needs ≥ 3 Dynamic World observations of the pixel.
MIN_PIXEL_DW_OBS = 3
# A year is analysable only if ≥ 80 % of the AOI is observed; below that the AOI-level
# figures would describe a fragment rather than the area.
MIN_YEAR_COVERAGE = 0.80
# Modern era: the forest test uses LEAF-ON NDVI (an upper percentile over the year's clear observations), so a year must
# sample the whole phenological cycle. A year is analysable only if, in EVERY calendar quarter, the same share of the AOI
# (MIN_YEAR_COVERAGE) has at least one clear Sentinel-2 observation. Without it a missing season (e.g. the 2017–2018
# Sentinel-2 SR archive gaps: no July–September scenes over parts of India) makes deciduous forest fail the leaf-on test
# and shows up as spurious forest gain in the next year. Same threshold as the coverage rule; no new tuning constant.
QUARTERS = ("Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec")
# Tree canopy cannot establish over large areas within a year. Forest GAIN above 5 % of
# the compared area per year signals an unstable forest classification (e.g. cloud or
# phenology artefacts), which makes the same classifier's LOSS figures untrustworthy too.
MAX_ANNUAL_GAIN_FRACTION = 0.05
# Rasterisation tolerance for area comparisons (30 m pixels along the AOI boundary).
AREA_TOLERANCE = 0.01

HIST_YEARS = [1984, 1990, 1995, 2000, 2005, 2010, 2015]   # historical Landsat era
MODERN_FIRST_YEAR = 2016                                  # first full Dynamic World year
DEFAULT_EVENT_WINDOW = (2018, 2025)
MODERN_YEARS = list(range(DEFAULT_EVENT_WINDOW[0], DEFAULT_EVENT_WINDOW[1] + 1))
PERIODS = [(1984, 1995), (1995, 2005), (2005, 2015)]

METHOD: dict[str, Any] = {
    "version": METHOD_VERSION,
    "eras": (
        "Historical (1984–2015): Landsat 5/7/8/9 Collection 2 surface reflectance, multi-year median composites, forest proxy NDVI ≥ 0.60 at 30 m. "
        "Modern: Sentinel-2 SR Harmonized (catalogue from 2017-03-28) calendar-year composites + Dynamic World V1 annual mean tree probability. "
        "Forest from the two eras is never compared: loss/gain are computed only between years of the same era."
    ),
    "cloud_masking": "Sentinel-2: Cloud Score+ cs_cdf ≥ 0.60 (scenes without Cloud Score+ are excluded). Landsat: QA_PIXEL dilated cloud, cloud and cloud-shadow bits.",
    "no_data": (
        f"A pixel is observed only with ≥ {MIN_PIXEL_CLEAR_OBS} clear observations"
        f" (and ≥ {MIN_PIXEL_DW_OBS} Dynamic World observations in the modern era). Unobserved pixels stay no-data: they are never counted as non-forest, "
        "and every statistic is computed over observed pixels only. Missing statistics are reported as null, never 0."
    ),
    "forest_rule": f"Modern: Dynamic World tree probability ≥ {FOREST_TREE_PROB:.2f} in at least a quarter of the year's observations (per-pixel {FOREST_TREE_PERCENTILE}th percentile) AND leaf-on NDVI (per-pixel {FOREST_NDVI_PERCENTILE}th percentile of clear observations) ≥ {FOREST_NDVI:.2f}. Historical: NDVI ≥ {LANDSAT_FOREST_NDVI:.2f} (Landsat proxy).",
    "coverage_rule": f"A year is analysable only if ≥ {MIN_YEAR_COVERAGE:.0%} of the AOI is observed; forest % is relative to the observed area.",
    "seasonal_rule": (
        f"Modern era: a year is analysable only if ≥ {MIN_YEAR_COVERAGE:.0%} of the AOI has at least one clear Sentinel-2 observation in "
        "EVERY calendar quarter, because the forest test uses leaf-on (90th-percentile) NDVI over the whole phenological year. "
        "A year missing a season is reported as insufficient — never composited into a forest measurement."
    ),
    "change_rule": (
        f"forest(t−1) ∧ [ΔNDVI ≤ {D_NDVI:.2f} ∨ ΔNBR ≤ {D_NBR:.2f}] ∧ Δtree-probability ≤ {D_TREE:.2f} ∧ ¬forest(t); "
        "both composites must pass the coverage rule and each pixel must be observed in both."
    ),
    "transition_rule": "Loss and gain between two analysable years of the same era are measured only over pixels observed in both years (compared area).",
    "validity_rules": (
        "INVALID_ANALYSIS if any area is negative, loss or gain exceeds the compared area, forest % is outside 0–100, cumulative loss exceeds "
        f"initial forest plus gain, or forest gain exceeds {MAX_ANNUAL_GAIN_FRACTION:.0%} of the compared area per year (unstable forest classification). "
        "UNAVAILABLE if the baseline or comparison year lacks sufficient clear observations. Values are never clamped."
    ),
    "history_rule": (
        "Periods are classified by forest-loss rate (low < 0.1 %/yr ≤ moderate < 0.4 %/yr ≤ high) within the historical Landsat era only. "
        "Change events are only detected in the modern Sentinel-2 / Dynamic World era."
    ),
    "metrics": {
        "gross_loss_ha": (
            "Gross forest-loss transitions: the sum, over every consecutive pair of analysable years in the window, of the "
            "area that was forest in the earlier year and non-forest in the later one (pixels observed in both years only). "
            "A pixel that flips forest → non-forest → forest is counted every time it flips, so gross loss is NOT "
            "permanent deforestation."
        ),
        "gross_gain_ha": (
            "Gross forest-gain transitions: the same sum for non-forest → forest. Large gross gain together with large gross "
            "loss usually means the forest classification is flickering between years, not real regrowth."
        ),
        "net_change_ha": (
            "Net forest change: forest area in the comparison year minus forest area in the baseline year, measured directly "
            "between those two composites over the pixels observed in BOTH years (the compared area). Unobserved pixels are "
            "excluded, never counted as non-forest."
        ),
        "event_area_ha": (
            "Event area: the total area of the detected change events (polygons ≥ the minimum mapping unit that passed the "
            "change rule between the baseline and comparison composites). Only the largest events are kept (see event limit)."
        ),
    },
    "event_limit": f"Only the largest {MAX_EVENTS} change polygons (by area) are measured and returned; events_meta reports whether more were found.",
    "mmu_ha": MMU_HA,
    "thresholds": {
        "d_ndvi": D_NDVI, "d_nbr": D_NBR, "d_tree_prob": D_TREE, "min_clear_obs": MIN_CLEAR_OBS,
        "min_pixel_clear_obs": MIN_PIXEL_CLEAR_OBS, "min_pixel_dw_obs": MIN_PIXEL_DW_OBS,
        "min_year_coverage": MIN_YEAR_COVERAGE, "min_season_coverage": MIN_YEAR_COVERAGE, "max_annual_gain_fraction": MAX_ANNUAL_GAIN_FRACTION, "area_tolerance": AREA_TOLERANCE,
    },
    "severity": "Clearing: 0.5·|ΔNDVI|/0.7 + 0.3·conversion + 0.2·log-area. Fire: USGS dNBR classes (Key & Benson).",
    "confidence": (
        "Evidence score (not a calibrated probability): NDVI 0.20, NBR 0.20, tree-probability 0.20, "
        "persistence 0.15, clear observations 0.10, reference agreement 0.15."
    ),
}


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def era_of(year: int) -> str:
    return "historical" if year < MODERN_FIRST_YEAR else "modern"


def landsat_window(year: int) -> tuple[int, int]:
    """[start, end) calendar years of the multi-year Landsat composite for `year`."""
    return (max(1984, year - 1) if year > 1984 else 1984, year + 2)


def sensor_for(year: int) -> dict[str, Any]:
    """Sensor provenance for a composite year (Landsat historical era, Sentinel-2 / Dynamic World modern era)."""
    landsat = (
        "Landsat 5 TM" if year < 1999 else
        "Landsat 5 TM / 7 ETM+" if year < 2013 else
        "Landsat 8 OLI" if year < 2021 else
        "Landsat 8 OLI / 9 OLI-2"
    )
    if era_of(year) == "historical":
        y0, y1 = landsat_window(year)
        return {"source": "landsat", "label": landsat, "resolution_m": 30, "dw_available": False,
                "forest_method": "landsat_ndvi_proxy", "composite": f"{y0}–{y1 - 1} Landsat composite"}
    return {"source": "sentinel-2", "label": f"Sentinel-2 MSI (+ {landsat})", "resolution_m": 10, "dw_available": True,
            "forest_method": "dynamic_world", "composite": None}


def imagery_status(clear_obs: int | None, passes: bool) -> str:
    if not passes or clear_obs is None:
        return "insufficient"
    return "cloud_limited" if clear_obs < 8 else "good"


def assess_year(year: int, clear_median: float | None, dw_median: float | None, coverage: float | None,
                seasonal: list[float | None] | None = None, forest_analysis: bool = False) -> tuple[bool, str | None]:
    """Does a composite year meet the quality requirements? (passes, reason-if-not).

    `forest_analysis` adds the seasonal rule, which exists for the leaf-on FOREST test: the analysis sets it; imagery
    availability (imagery only, no forest measurement) does not. `seasonal` = share of the AOI with >= 1 clear
    observation in each calendar quarter. A modern analysis year whose seasonal coverage was not measured never passes."""
    if coverage is None:
        return False, "Observation coverage could not be measured."
    if coverage < MIN_YEAR_COVERAGE:
        what = "clear Sentinel-2 + Dynamic World" if era_of(year) == "modern" else "clear Landsat"
        return False, (f"Insufficient clear observations: only {coverage:.0%} of the area has ≥ {MIN_PIXEL_CLEAR_OBS} {what} observations "
                       f"(≥ {MIN_YEAR_COVERAGE:.0%} required).")
    if forest_analysis and era_of(year) == "modern":
        if seasonal is None or len(seasonal) != 4 or any(q is None for q in seasonal):
            return False, "Seasonal observation coverage could not be measured."
        missing = [(QUARTERS[i], q) for i, q in enumerate(seasonal) if q < MIN_YEAR_COVERAGE]
        if missing:
            gaps = ", ".join(f"{name}: {q * 100:.1f}% of the area observed" for name, q in missing)   # 1 decimal: 79.8% must not read as 80%
            return False, (f"Incomplete seasonal coverage ({gaps}; ≥ {MIN_YEAR_COVERAGE:.0%} required in every quarter). "
                           "The leaf-on forest test needs observations from the whole year, so this year cannot be compared.")
    return True, None


def _num(v: Any) -> float | None:
    """A measured value or None — never a default zero."""
    return None if v is None else float(v)


def severity_of(change_type: str, d_ndvi: float, d_nbr: float, conversion: float, area_ha: float) -> dict[str, Any]:
    if change_type == "fire":
        dnbr = -d_nbr
        score = clamp((dnbr - 0.1) / 0.75)
        cls = "critical" if dnbr >= 0.66 else "high" if dnbr >= 0.44 else "moderate" if dnbr >= 0.27 else "low"
        usgs = "high" if dnbr >= 0.66 else "moderate-high" if dnbr >= 0.44 else "moderate-low" if dnbr >= 0.27 else "low"
        return {"class": cls, "score": round(score, 2), "basis": f"USGS burn-severity class “{usgs}” (dNBR {dnbr:.2f})"}
    score = clamp(
        0.5 * clamp(abs(d_ndvi) / 0.7)
        + 0.3 * clamp((conversion - 0.5) / 0.5)
        + 0.2 * clamp(math.log10(max(area_ha, 1)) / math.log10(500))
    )
    cls = "critical" if score >= 0.75 else "high" if score >= 0.6 else "moderate" if score >= 0.45 else "low"
    return {"class": cls, "score": round(score, 2), "basis": "Composite of NDVI decline, share of forest converted and patch size"}


def evidence_of(d_ndvi: float, d_nbr: float, d_tree: float, persistence: float | None, clear_obs: int | None, reference: float | None) -> dict[str, Any]:
    def strength(v: float, thr: float) -> float:
        return clamp(abs(min(v, 0.0)) / (2 * abs(thr)))

    items = [
        {"key": "ndvi", "label": "NDVI decline", "value": round(d_ndvi, 3), "threshold": D_NDVI, "unit": "Δ index", "weight": 0.2, "score": strength(d_ndvi, D_NDVI), "passed": d_ndvi <= D_NDVI},
        {"key": "nbr", "label": "NBR decline", "value": round(d_nbr, 3), "threshold": D_NBR, "unit": "Δ index", "weight": 0.2, "score": strength(d_nbr, D_NBR), "passed": d_nbr <= D_NBR},
        {"key": "tree_prob", "label": "Tree-probability drop (Dynamic World)", "value": round(d_tree, 3), "threshold": D_TREE, "unit": "Δ probability", "weight": 0.2, "score": strength(d_tree, D_TREE), "passed": d_tree <= D_TREE},
        {"key": "persistence", "label": "Persists into the following year", "value": persistence, "threshold": PERSISTENCE_OK, "unit": "fraction", "weight": 0.15,
         "score": 0.5 if persistence is None else clamp((persistence - 0.4) / 0.5), "passed": None if persistence is None else persistence >= PERSISTENCE_OK},
        {"key": "clear_obs", "label": "Clear observations (min. per pixel)", "value": clear_obs, "threshold": MIN_CLEAR_OBS, "unit": "scenes", "weight": 0.1,
         "score": 0.5 if clear_obs is None else clamp(clear_obs / 12), "passed": None if clear_obs is None else clear_obs >= MIN_CLEAR_OBS},
        {"key": "reference", "label": "Overlap with Hansen GFC loss", "value": reference, "threshold": REFERENCE_OK, "unit": "fraction", "weight": 0.15,
         "score": 0.5 if reference is None else clamp(reference / 0.6), "passed": None if reference is None else reference >= REFERENCE_OK},
    ]
    score = min(0.97, sum(i["weight"] * i["score"] for i in items))
    for i in items:
        i["score"] = round(i["score"], 2)
    return {
        "score": round(score, 2),
        "class": "high" if score >= 0.8 else "medium" if score >= 0.6 else "low",
        "evidence": items,
    }


def passes_change_rule(d_ndvi: float, d_nbr: float, d_tree: float) -> bool:
    return (d_ndvi <= D_NDVI or d_nbr <= D_NBR) and d_tree <= D_TREE



def classify_periods(years: list[dict[str, Any]], last_year: int) -> list[dict[str, Any]]:
    """Long-term change periods (historical Landsat era), classified by forest-loss rate.

    A period is reported only if both end years are analysable composites and every
    transition inside it was measured (previous_year chain unbroken); never from partial data.
    """
    out = []
    by_year = {y["year"]: y for y in years if y.get("passes_quality")}
    for start, end in PERIODS:
        end = min(end, last_year)
        if start not in by_year or end not in by_year or end <= start or era_of(start) != era_of(end):
            continue
        inside = [y for y in years if start < y["year"] <= end and y.get("passes_quality")]
        chain_ok = all(y.get("previous_year") is not None and y.get("loss_ha") is not None for y in inside)
        linked = inside and inside[0]["previous_year"] == start
        if not chain_ok or not linked:
            continue
        loss = sum(y["loss_ha"] for y in inside)
        gain = sum(y["gain_ha"] for y in inside)
        base = by_year[start]["forest_ha"]
        if not base:
            continue
        rate = loss / (end - start) / base * 100
        out.append({
            "from_year": start, "to_year": end,
            "loss_ha": round(loss, 1), "gain_ha": round(gain, 1), "net_change_ha": round(gain - loss, 1),
            "rate_pct_per_year": round(rate, 3),
            "level": "high" if rate >= 0.4 else "moderate" if rate >= 0.1 else "low",
            "sensors": "Landsat", "label": "Historical Landsat analysis",
        })
    return out


def kpis_for(years: list[dict[str, Any]], features: list[dict[str, Any]], baseline_year: int, latest_year: int,
             pair: dict[str, float | None]) -> dict[str, Any]:
    """Window KPIs. Net change comes from the direct baseline→comparison comparison over the
    area observed in BOTH years (`pair`), not from subtracting areas with different coverage."""
    first = next(y for y in years if y["year"] == baseline_year)
    last = next(y for y in years if y["year"] == latest_year)
    window = [y for y in years if baseline_year < y["year"] <= latest_year and y.get("passes_quality") and y.get("loss_ha") is not None]
    confs = [f["properties"]["confidence"]["score"] for f in features]
    net = None if pair.get("loss") is None or pair.get("gain") is None else pair["gain"] - pair["loss"]
    gross_loss = round(sum(y["loss_ha"] for y in window), 1)
    gross_gain = round(sum(y["gain_ha"] for y in window), 1)
    return {
        "baseline_year": first["year"],
        "latest_year": last["year"],
        "forest_baseline_ha": first["forest_ha"],
        "forest_latest_ha": last["forest_ha"],
        "compared_ha": None if pair.get("compared") is None else round(pair["compared"], 1),
        # Definitions: METHOD["metrics"]. Gross transitions are never permanent loss; net change is the direct
        # baseline → comparison difference over the area observed in both years.
        "gross_loss_ha": gross_loss,
        "gross_gain_ha": gross_gain,
        "gross_transition_count": len(window),
        "net_change_ha": None if net is None else round(net, 1),
        "net_change_pct": None if net is None or not pair.get("forest_b") else round(net / pair["forest_b"] * 100, 2),
        "event_area_ha": round(sum(f["properties"]["area_ha"] for f in features), 1),
        # Deprecated aliases of gross_loss_ha / gross_gain_ha (kept so older clients keep working).
        "total_loss_ha": gross_loss,
        "total_gain_ha": gross_gain,
        "event_count": len(features),
        "high_severity_count": sum(1 for f in features if f["properties"]["severity"]["class"] in ("high", "critical")),
        "mean_confidence": round(sum(confs) / len(confs), 2) if confs else None,
    }


def events_meta(returned: int, candidates: int | None) -> dict[str, Any]:
    """Event-cap facts. `candidates` = change polygons found before the MAX_EVENTS cut (None = not recorded)."""
    truncated = None if candidates is None else candidates > MAX_EVENTS
    return {
        "event_limit": MAX_EVENTS,
        "events_returned": returned,
        "candidate_polygons": candidates,
        "events_truncated": truncated,
        "note": (f"Only the largest {MAX_EVENTS} detected events are returned; {candidates} change polygons were found."
                 if truncated else
                 f"All {candidates} detected change polygons are returned." if truncated is False else
                 f"At most {MAX_EVENTS} events are kept; whether more were found was not recorded for this stored result."),
    }


def upgrade_result(result: dict[str, Any]) -> dict[str, Any]:
    """Add the explicit metric fields to a READY result stored before they existed (same measured values, renamed;
    nothing is recomputed or estimated). Idempotent."""
    summary, events = result.get("summary"), result.get("events")
    if not summary or not events:
        return result
    k = summary.get("kpis") or {}
    feats = events.get("features") or []
    k.setdefault("gross_loss_ha", k.get("total_loss_ha"))
    k.setdefault("gross_gain_ha", k.get("total_gain_ha"))
    if "gross_transition_count" not in k:
        b, c = k.get("baseline_year"), k.get("latest_year")
        k["gross_transition_count"] = sum(1 for y in summary.get("years") or []
                                         if b is not None and c is not None and b < y["year"] <= c and y.get("passes_quality") and y.get("loss_ha") is not None)
    k.setdefault("event_area_ha", round(sum(f["properties"]["area_ha"] for f in feats), 1))
    events.setdefault("meta", events_meta(len(feats), None))
    summary.setdefault("events_meta", events["meta"])
    summary.setdefault("method", {}).setdefault("metrics", METHOD["metrics"])
    summary["method"].setdefault("event_limit", METHOD["event_limit"])
    return result


def history_for(years: list[dict[str, Any]], pair: dict[str, float | None] | None) -> dict[str, Any] | None:
    """Historical-era summary (first → last analysable Landsat composite), measured over the area observed in both."""
    hist = [y for y in years if y["era"] == "historical" and y.get("passes_quality")]
    if len(hist) < 2 or not pair or pair.get("loss") is None:
        return None
    net = pair["gain"] - pair["loss"]
    return {
        "first_year": hist[0]["year"],
        "last_year": hist[-1]["year"],
        "forest_first_ha": hist[0]["forest_ha"],
        "net_change_ha": round(net, 1),
        "net_change_pct": round(net / pair["forest_b"] * 100, 2) if pair.get("forest_b") else None,
        "note": ("Historical Landsat era only (30 m NDVI forest proxy), measured over pixels observed in both years. "
                 "Not comparable to the modern Dynamic World forest mask, so the two eras are never subtracted."),
    }


# --------------------------------------------------------------------------- validity
def _issue(rule: str, years: list[int], message: str, evidence: dict[str, Any] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"rule": rule, "years": years, "message": message}
    if evidence:
        out["evidence"] = evidence   # the measured value that failed the check (never shown as a finding)
    return out


def _row_issues(y: dict[str, Any], aoi_ha: float, first_year: int | None = None) -> list[dict[str, Any]]:
    """Physical-validity and stability checks for one analysable year and its transition from `previous_year`.
    The transition is checked only when it starts at or after `first_year` (None = any)."""
    tol = 1 + AREA_TOLERANCE
    issues: list[dict[str, Any]] = []
    if not y.get("passes_quality"):
        return issues
    yr = y["year"]
    for k in ("forest_ha", "loss_ha", "gain_ha", "valid_ha", "compared_ha"):
        if y.get(k) is not None and y[k] < 0:
            issues.append(_issue("negative_area", [yr], f"{yr}: a measured area ({k}) is negative."))
    if y.get("forest_pct") is not None and not (0 <= y["forest_pct"] <= 100 * tol):
        issues.append(_issue("forest_pct_out_of_range", [yr], f"{yr}: forest share is outside 0–100 %."))
    if y.get("forest_ha") is not None and y["forest_ha"] > aoi_ha * tol:
        issues.append(_issue("forest_exceeds_area", [yr], f"{yr}: forest area exceeds the area of interest."))
    prev = y.get("previous_year")
    if prev is None or y.get("loss_ha") is None or (first_year is not None and prev < first_year):
        return issues
    cmp_ha = y.get("compared_ha")
    limit = min(aoi_ha, cmp_ha) * tol if cmp_ha is not None else aoi_ha * tol
    if y["loss_ha"] > limit:
        issues.append(_issue("loss_exceeds_area", [prev, yr], f"{prev}→{yr}: forest loss exceeds the compared area."))
    if y["gain_ha"] > limit:
        issues.append(_issue("gain_exceeds_area", [prev, yr], f"{prev}→{yr}: forest gain exceeds the compared area."))
    if cmp_ha and y["gain_ha"] / cmp_ha / (yr - prev) > MAX_ANNUAL_GAIN_FRACTION:
        # Denominator = compared area: pixels validly observed in BOTH years (never the whole AOI, never unobserved pixels).
        driver, detail = component_driver(y.get("forest_components_change_pts"))
        evidence = {"measured_pct_per_year": round(100 * y["gain_ha"] / cmp_ha / (yr - prev), 2),
                    "threshold_pct_per_year": round(100 * MAX_ANNUAL_GAIN_FRACTION, 2),
                    "gain_ha": round(y["gain_ha"], 1), "compared_ha": round(cmp_ha, 1)}
        if driver:
            evidence.update(driver=driver, component_change_pts=y["forest_components_change_pts"])
        issues.append(_issue("unstable_forest_mask", [prev, yr],
                             f"{prev}→{yr}: forest gain of {evidence['measured_pct_per_year']:.1f}% of the compared area per year exceeds the ecologically "
                             f"plausible {MAX_ANNUAL_GAIN_FRACTION:.0%} — the forest classification is unstable here, so loss figures cannot be trusted either."
                             + (f" {detail}" if detail else ""),
                             evidence))
    return issues


COMPONENT_LABELS = {"tree_prob": "Dynamic World tree probability ≥ 0.50", "leafon_ndvi": "leaf-on NDVI ≥ 0.60"}


def component_driver(change: dict[str, float | None] | None) -> tuple[str | None, str | None]:
    """Which half of the forest mask moved: (driver key, sentence) from the MEASURED change of each component (percentage
    points of the observed area). A component is named the driver only when its change is at least twice the other's;
    otherwise both are reported. (None, None) when the components were not measured."""
    if not change or change.get("tree_prob") is None or change.get("leafon_ndvi") is None:
        return None, None
    t, n = change["tree_prob"], change["leafon_ndvi"]
    facts = f"{COMPONENT_LABELS['tree_prob']}: {t:+.1f} pts; {COMPONENT_LABELS['leafon_ndvi']}: {n:+.1f} pts of the observed area"
    if abs(t) >= 2 * abs(n):
        return "tree_prob", f"The change comes from the Dynamic World tree-probability classification, not from canopy greenness ({facts})."
    if abs(n) >= 2 * abs(t):
        return "leafon_ndvi", f"The change comes from leaf-on canopy greenness (NDVI), not from the Dynamic World classification ({facts})."
    return "both", f"Both forest-mask components moved ({facts})."


def in_window(issue: dict[str, Any], window: tuple[int, int] | list[int] | None) -> bool:
    """True when every year of an issue lies inside the analysed window (the data the result is built from)."""
    return window is not None and window[0] <= min(issue["years"]) and max(issue["years"]) <= window[1]


NO_WINDOW_REASON = (
    "Insufficient clear observations: fewer than two modern years in the requested window meet the analysis-quality requirements, "
    "so no change detection is possible."
)


def invalid_reason(issues: list[dict[str, Any]]) -> str:
    return ("The computation finished, but its results fail TERRATRACE's scientific validity checks, so they are not shown as findings. "
            + " ".join(i["message"] for i in issues[:3]))


def context_issues(years: list[dict[str, Any]], aoi_ha: float, event_window: tuple[int, int] | None) -> list[dict[str, Any]]:
    """The same checks for years/transitions OUTSIDE the analysed window (e.g. historical Landsat pairs).
    Informational for the history view only — they never decide the status of the requested analysis."""
    found = [i for y in years for i in _row_issues(y, aoi_ha)]
    return [i for i in found if not in_window(i, event_window)]


def evaluate(years: list[dict[str, Any]], aoi_ha: float, event_window: tuple[int, int] | None,
             kpis: dict[str, Any] | None = None) -> tuple[str, str | None, str | None, list[dict[str, Any]]]:
    """Decide the analysis status from measured statistics.

    Returns (status, reasonCode, reason, issues) with status READY | UNAVAILABLE | INVALID_ANALYSIS.
    Hard physical violations and an unstable forest classification make the analysis
    INVALID; a baseline/comparison year without sufficient observations makes it
    UNAVAILABLE. Nothing is clamped or repaired.

    Scope: only what the requested result is built from — the years of the analysed window
    (`event_window`) and the transitions inside it (see `kpis_for`). Years and transitions outside
    it (historical Landsat pairs, the transition INTO the baseline year) never invalidate the result;
    they are reported separately by `context_issues`. The rules themselves are unchanged.
    """
    issues: list[dict[str, Any]] = []
    if event_window is not None:
        for y in years:
            if event_window[0] <= y["year"] <= event_window[1]:
                issues += _row_issues(y, aoi_ha, first_year=event_window[0])
    if kpis and kpis.get("forest_baseline_ha") is not None:
        if kpis["total_loss_ha"] > (kpis["forest_baseline_ha"] + kpis["total_gain_ha"]) + aoi_ha * AREA_TOLERANCE:
            issues.append(_issue("cumulative_loss_exceeds_forest", [kpis["baseline_year"], kpis["latest_year"]],
                                 "Cumulative forest loss exceeds the initial forest plus all measured gain."))
    if issues:
        return "INVALID_ANALYSIS", issues[0]["rule"], invalid_reason(issues), issues
    if event_window is None:
        return "UNAVAILABLE", "insufficient_clear_observations", NO_WINDOW_REASON, issues
    return "READY", None, None, issues
