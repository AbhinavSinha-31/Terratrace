"""All statistics, computed locally from the downloaded 30 m rasters (same grid for every year) → CSV tables.

Conventions
  * Only pixels inside the study area count. LULC code 0 = not classified (no clear summer observation).
  * Area = pixel count × 30 m × 30 m (UTM 43N; scale distortion here < 0.04 %, ignored).
  * "Land" = classified, not Water, with a valid LST value for the season in question. Water is excluded from
    LST comparisons because its temperature is governed by different physics (thermal inertia, evaporation).
"""

from __future__ import annotations

import json
import logging
from itertools import combinations
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy import ndimage, signal, stats as sstats

from .config import Config

log = logging.getLogger("analysis.stats")

SEASONS = ("summer", "winter")
BUILT, VEG, AGRI, WATER = 1, 2, 3, 4   # Barren/Open land is merged into BUILT (config.toml)


# ----------------------------------------------------------------------------- loading
def load_year(cache: Path, year: int, lst: bool = True) -> dict[str, np.ndarray]:
    """A year's rasters; lst=False skips the LST rasters (config.toml [lst] enabled = false)."""
    d = cache / str(year)
    out = {"lulc": np.load(d / "lulc.npy")}
    for b in ("lst_summer", "lst_winter", "ndvi_summer", "ndbi_summer", "ndvi_winter", "ndbi_winter"):
        if lst or not b.startswith("lst_"):
            out[b] = np.load(d / f"{b}.npy")
    return out


def load_meta(cache: Path, year: int) -> dict[str, Any]:
    return json.loads((cache / str(year) / "meta.json").read_text(encoding="utf-8"))


def km2(pixels: int | float, scale: float) -> float:
    return float(pixels) * scale * scale / 1e6


# ----------------------------------------------------------------------------- areas and transitions
def class_areas(cfg: Config, lulc: np.ndarray, aoi: np.ndarray) -> pd.DataFrame:
    inside = lulc[aoi]
    classified = int((inside > 0).sum())
    rows = []
    for c in cfg.classes:
        n = int((inside == c.code).sum())
        rows.append({"class_code": c.code, "class": c.name, "pixels": n, "area_km2": km2(n, cfg.scale),
                     "percent_of_classified": 100 * n / classified if classified else np.nan})
    n0 = int((inside == 0).sum())
    rows.append({"class_code": 0, "class": "Not classified (no clear observation)", "pixels": n0,
                 "area_km2": km2(n0, cfg.scale), "percent_of_classified": np.nan})
    return pd.DataFrame(rows)


def transition_matrix(cfg: Config, a: np.ndarray, b: np.ndarray, aoi: np.ndarray) -> pd.DataFrame:
    """km² moving from each class in year A (rows) to each class in year B (columns), over pixels classified in both."""
    codes = cfg.class_codes
    both = aoi & (a > 0) & (b > 0)
    k = len(codes) + 1
    counts = np.bincount(a[both].astype(np.int64) * k + b[both].astype(np.int64), minlength=k * k).reshape(k, k)
    mat = counts[np.ix_(codes, codes)] * cfg.scale**2 / 1e6
    names = [cfg.class_name(c) for c in codes]
    return pd.DataFrame(mat, index=pd.Index(names, name="from \\ to"), columns=names)


# ----------------------------------------------------------------------------- UHI
def disk(radius_px: float) -> np.ndarray:
    r = int(np.ceil(radius_px))
    y, x = np.mgrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y <= radius_px * radius_px).astype(np.float32)


def urban_core(cfg: Config, lulc: np.ndarray, aoi: np.ndarray) -> np.ndarray:
    """Urban core: built-up fraction (among classified pixels) within core_radius_m ≥ core_threshold,
    patches smaller than core_min_km2 removed."""
    u = cfg.uhi
    k = disk(float(u["core_radius_m"]) / cfg.scale)
    classified = (aoi & (lulc > 0)).astype(np.float32)
    built = (aoi & (lulc == BUILT)).astype(np.float32)
    num = signal.fftconvolve(built, k, mode="same")
    den = signal.fftconvolve(classified, k, mode="same")
    with np.errstate(invalid="ignore", divide="ignore"):
        frac = np.where(den > 0.5, num / np.maximum(den, 1e-6), 0)
    core = (frac >= float(u["core_threshold"])) & aoi & (lulc > 0)
    lab, n = ndimage.label(core)
    if n:
        sizes = np.bincount(lab.ravel())
        min_px = float(u["core_min_km2"]) * 1e6 / cfg.scale**2
        keep = sizes >= min_px
        keep[0] = False
        core = keep[lab]
    return core


def rural_ring(cfg: Config, core: np.ndarray, lulc: np.ndarray, lst: np.ndarray, aoi: np.ndarray, need: int) -> tuple[np.ndarray, float, bool]:
    """Rural reference: the `need` non-built-up, non-water land pixels nearest the core (equal area), within ring_max_km.
    Returns (mask, outer distance in km, capped?)."""
    dist = ndimage.distance_transform_edt(~core) * cfg.scale
    cand = aoi & ~core & (lulc > 0) & (lulc != BUILT) & (lulc != WATER) & np.isfinite(lst)
    cand &= dist <= float(cfg.uhi["ring_max_km"]) * 1000
    d = dist[cand]
    if d.size == 0:
        return np.zeros_like(core), float("nan"), True
    capped = d.size < need
    limit = d.max() if capped else np.partition(d, need - 1)[need - 1]
    return cand & (dist <= limit), float(limit) / 1000, bool(capped)


def uhi(cfg: Config, lulc: np.ndarray, lst: np.ndarray, aoi: np.ndarray, core: np.ndarray) -> list[dict[str, Any]]:
    """UHI intensity by both methods for one year and season."""
    valid = aoi & (lulc > 0) & np.isfinite(lst)
    land = valid & (lulc != WATER)
    rows = []
    # Method B — built-up vs non-built-up land, whole study area.
    b, nb = land & (lulc == BUILT), land & (lulc != BUILT)
    rows.append({"method": "built-up vs non-built-up land", "urban_mean_c": float(lst[b].mean()), "rural_mean_c": float(lst[nb].mean()),
                 "urban_km2": km2(b.sum(), cfg.scale), "rural_km2": km2(nb.sum(), cfg.scale), "ring_outer_km": np.nan, "ring_capped": False})
    # Method A — urban core vs equal-area rural ring.
    c = core & land
    ring, outer, capped = rural_ring(cfg, core, lulc, lst, aoi, int(c.sum()))
    rows.append({"method": "urban core vs rural ring", "urban_mean_c": float(lst[c].mean()) if c.any() else np.nan,
                 "rural_mean_c": float(lst[ring].mean()) if ring.any() else np.nan,
                 "urban_km2": km2(c.sum(), cfg.scale), "rural_km2": km2(ring.sum(), cfg.scale), "ring_outer_km": outer, "ring_capped": capped})
    for r in rows:
        r["uhi_intensity_c"] = r["urban_mean_c"] - r["rural_mean_c"]
    return rows


# ----------------------------------------------------------------------------- LST per class, correlations
def lst_per_class(cfg: Config, lulc: np.ndarray, lst: np.ndarray, aoi: np.ndarray) -> list[dict[str, Any]]:
    rows = []
    for c in cfg.classes:
        m = aoi & (lulc == c.code) & np.isfinite(lst)
        v = lst[m]
        rows.append({"class_code": c.code, "class": c.name, "n_pixels": int(v.size),
                     "mean_c": float(v.mean()) if v.size else np.nan, "sd_c": float(v.std()) if v.size else np.nan,
                     "median_c": float(np.median(v)) if v.size else np.nan})
    return rows


def correlation(x: np.ndarray, y: np.ndarray, mask: np.ndarray, thin: int) -> dict[str, Any]:
    """Pearson r on all pixels; p-value on a thinned grid (every `thin`-th row and column) because neighbouring
    pixels are spatially autocorrelated and would make any p-value meaninglessly small."""
    xa, ya = x[mask].astype(np.float64), y[mask].astype(np.float64)
    r_all = float(np.corrcoef(xa, ya)[0, 1])
    # Least-squares line in closed form (float64): slope = cov(x, y) / var(x). (np.polyfit on millions of float32
    # values is ill-conditioned and returned a wrong-signed slope.)
    dx = xa - xa.mean()
    slope = float((dx * (ya - ya.mean())).sum() / (dx * dx).sum())
    intercept = float(ya.mean() - slope * xa.mean())
    mt = mask[::thin, ::thin]
    xt, yt = x[::thin, ::thin][mt], y[::thin, ::thin][mt]
    rt, pt = sstats.pearsonr(xt, yt)
    return {"r": r_all, "n_pixels": int(xa.size), "slope_c_per_unit": float(slope), "intercept_c": float(intercept),
            "r_thinned": float(rt), "p_thinned": float(pt), "n_thinned": int(xt.size), "thin_spacing_m": None}


def zscore(lst: np.ndarray, land: np.ndarray) -> np.ndarray:
    """Normalised LST: (LST − mean) / sd over the year's land pixels — removes the year-to-year weather offset."""
    v = lst[land]
    return (lst - v.mean()) / v.std()


# ----------------------------------------------------------------------------- conversion analysis
CONVERSION_GROUPS = [
    ("Vegetation/Trees → Built-up", VEG, BUILT), ("Agriculture/Cropland → Built-up", AGRI, BUILT),
    ("Stable Built-up", BUILT, BUILT), ("Stable Vegetation/Trees", VEG, VEG), ("Stable Agriculture/Cropland", AGRI, AGRI),
]


def conversion(cfg: Config, la: np.ndarray, lb: np.ndarray, ta: np.ndarray, tb: np.ndarray, aoi: np.ndarray) -> list[dict[str, Any]]:
    """Change in LST of pixels that became built-up vs pixels that kept their class (same season, years A → B).
    ΔLST in °C, and Δz (normalised LST) which is not affected by one summer simply being hotter than the other."""
    land_a = aoi & (la > 0) & (la != WATER) & np.isfinite(ta)
    land_b = aoi & (lb > 0) & (lb != WATER) & np.isfinite(tb)
    za, zb = zscore(ta, land_a), zscore(tb, land_b)
    rows = []
    for name, f, t in CONVERSION_GROUPS:
        m = land_a & land_b & (la == f) & (lb == t)
        n = int(m.sum())
        rows.append({"group": name, "from_code": f, "to_code": t, "n_pixels": n, "area_km2": km2(n, cfg.scale),
                     "mean_lst_a_c": float(ta[m].mean()) if n else np.nan, "mean_lst_b_c": float(tb[m].mean()) if n else np.nan,
                     "mean_delta_lst_c": float((tb[m] - ta[m]).mean()) if n else np.nan,
                     "mean_delta_z": float((zb[m] - za[m]).mean()) if n else np.nan})
    return rows


# ----------------------------------------------------------------------------- scene timing
def median_date(dates: list[str]) -> str:
    """Median acquisition date of a composite's scenes (midpoint of the two middle dates for an even count, rounded down)."""
    if not dates:
        return ""
    return pd.to_datetime(pd.Series(sorted(dates))).median().strftime("%Y-%m-%d")


def scene_months(cfg: Config, year: int, season: str, dates: list[str]) -> list[dict[str, Any]]:
    """Scenes per calendar month of one composite, every month of the season listed (0 where none). A scene is one
    Landsat path/row acquisition that passed the scene cloud filter; neighbouring path/rows on one date count separately."""
    first, last = cfg.season_span(season, year)
    months = pd.period_range(first, last, freq="M")
    got = pd.Series(pd.to_datetime(pd.Series(dates)).dt.to_period("M")).value_counts() if dates else pd.Series(dtype=int)
    n = len(dates)
    return [{"year": year, "season": season, "composite": cfg.season_label(season, year), "month": str(m),
             "month_of_season": i, "month_name": m.strftime("%b"), "scenes": int(got.get(m, 0)),
             "share_of_composite": int(got.get(m, 0)) / n if n else np.nan} for i, m in enumerate(months, 1)]


# ----------------------------------------------------------------------------- driver
def run(cfg: Config, cache: Path, out: Path, years: list[int]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    aoi = np.load(cache / "aoi_mask.npy").astype(bool)
    years = [y for y in years if (cache / str(y) / "meta.json").exists()]
    data = {y: load_year(cache, y, cfg.lst_enabled) for y in years}
    meta = {y: load_meta(cache, y) for y in years}
    thin = int(cfg.uhi["correlation_thin"])
    names = {c.code: c.name for c in cfg.classes}

    # 1. Class areas
    areas = pd.concat([class_areas(cfg, data[y]["lulc"], aoi).assign(year=y) for y in years], ignore_index=True)
    areas[["year", "class_code", "class", "pixels", "area_km2", "percent_of_classified"]].to_csv(out / "class_areas.csv", index=False)

    # 2. Transition matrices (every ordered pair of available years)
    for a, b in combinations(years, 2):
        transition_matrix(cfg, data[a]["lulc"], data[b]["lulc"], aoi).to_csv(out / f"transition_{a}_{b}_km2.csv", float_format="%.3f")

    # 3. Accuracy (agreement with reference labels), confusion matrices, feature importance, labels/sample sizes
    acc_rows, imp_rows, lab_rows = [], [], []
    for y in years:
        acc = meta[y]["accuracy"]
        # Overall agreement and kappa are always reported. Per-class figures are WITHHELD (left empty) for a class
        # with fewer than min_test_points_per_class test points: a percentage from a handful of points is not meaningful.
        row = {"year": y, "overall_agreement": acc["overall_accuracy"], "kappa": acc["kappa"], "n_test_points": acc["n_test"]}
        min_n = int(cfg.checks["min_test_points_per_class"])
        withheld = []
        for i, c in enumerate(cfg.class_codes):
            n_c = int(np.asarray(acc["matrix"])[i].sum())
            ok = n_c >= min_n
            row[f"n_test_{names[c]}"] = n_c
            row[f"producers_{names[c]}"] = acc["producers_accuracy"][i] if ok else np.nan
            row[f"users_{names[c]}"] = acc["users_accuracy"][i] if ok else np.nan
            row[f"f1_{names[c]}"] = acc["f1"][i] if ok else np.nan
            if not ok:
                withheld.append(f"{names[c]} ({n_c} test points)")
        row["per_class_withheld"] = "; ".join(withheld)
        acc_rows.append(row)
        cm = pd.DataFrame(acc["matrix"], index=pd.Index([names[c] for c in cfg.class_codes], name="reference \\ predicted"),
                          columns=[names[c] for c in cfg.class_codes])
        cm.to_csv(out / f"confusion_matrix_{y}.csv")
        for f, v in sorted(acc["importance"].items(), key=lambda kv: -kv[1]):
            imp_rows.append({"year": y, "feature": f, "importance": v})
        pts = pd.read_csv(cache / str(y) / "training_points.csv")
        for c in cfg.class_codes:
            lab_rows.append({"year": y, "class": names[c], "reference_label_pixels": meta[y]["label_pixels"].get(str(c), meta[y]["label_pixels"].get(c, 0)),
                             "train_points": int(((pts.label == c) & (pts.set == "train")).sum()),
                             "test_points": int(((pts.label == c) & (pts.set == "test")).sum())})
    pd.DataFrame(acc_rows).to_csv(out / "accuracy_metrics.csv", index=False)
    pd.DataFrame(imp_rows).to_csv(out / "feature_importance.csv", index=False)
    pd.DataFrame(lab_rows).to_csv(out / "training_labels.csv", index=False)

    # 4. Scenes — from the scene lists saved with each year's Earth Engine run (meta.json), not re-queried
    scene_rows, month_rows = [], []
    for y in years:
        for s in ("summer", "winter", "annual"):
            sc = meta[y]["scenes"][s]
            scene_rows.append({"year": y, "season": s, "composite": cfg.season_label(s, y), "sensors": "+".join(meta[y]["sensors"]),
                               "scenes": sc["count"], "first_date": min(sc["dates"]) if sc["dates"] else "",
                               "last_date": max(sc["dates"]) if sc["dates"] else "", "median_date": median_date(sc["dates"]),
                               "date_ranges": "; ".join(f"{a}…{b}" for a, b in meta[y]["season_ranges"][s])})
            if s != "annual":
                month_rows += scene_months(cfg, y, s, sc["dates"])
    pd.DataFrame(scene_rows).to_csv(out / "scenes.csv", index=False)
    pd.DataFrame(month_rows).to_csv(out / "scene_months.csv", index=False)

    # 5–6. LST and UHI — only while config.toml [lst] enabled = true. When it is off, the LST tables already in `out` are
    # left exactly as they are (kept as raw outputs) and nothing downstream reads them.
    if cfg.lst_enabled:
        lst_tables(cfg, data, aoi, cache, out, years, thin)
    else:
        log.info("stats: LST / UHI switched off in config.toml [lst] — LST tables not recomputed")

    # 7. Population vs built-up
    pop_path = cache / "population.csv"
    if pop_path.exists():
        pop = pd.read_csv(pop_path)
        pop.to_csv(out / "population.csv", index=False)
        built = areas[areas.class_code == BUILT][["year", "area_km2", "percent_of_classified"]].rename(
            columns={"area_km2": "builtup_km2_this_study", "percent_of_classified": "builtup_percent_this_study"})
        merged = pop.merge(built, left_on="epoch", right_on="year", how="left").drop(columns="year")
        merged.to_csv(out / "population_vs_builtup.csv", index=False)
    log.info("stats: tables written to %s", out)


def lst_tables(cfg: Config, data: dict, aoi: np.ndarray, cache: Path, out: Path, years: list[int], thin: int) -> None:
    """LST summaries, LST per class, UHI (both methods), LST–index correlations and the conversion analysis."""
    # 5. LST summaries, per class, UHI, correlations
    lst_rows, cls_rows, uhi_rows, cor_rows = [], [], [], []
    for y in years:
        lulc = data[y]["lulc"]
        core = urban_core(cfg, lulc, aoi)
        np.save(cache / str(y) / "urban_core.npy", core)
        for s in SEASONS:
            lst = data[y][f"lst_{s}"]
            classified = aoi & (lulc > 0)
            land = classified & (lulc != WATER) & np.isfinite(lst)
            v = lst[land]
            lst_rows.append({"year": y, "season": s, "mean_land_c": float(v.mean()), "sd_land_c": float(v.std()),
                             "p1_c": float(np.percentile(v, 1)), "p99_c": float(np.percentile(v, 99)),
                             "valid_fraction_of_study_area": float((aoi & np.isfinite(lst)).sum() / aoi.sum()),
                             "classified_fraction_of_study_area": float(classified.sum() / aoi.sum())})
            cls_rows += [{"year": y, "season": s, **r} for r in lst_per_class(cfg, lulc, lst, aoi)]
            uhi_rows += [{"year": y, "season": s, **r} for r in uhi(cfg, lulc, lst, aoi, core)]
            for idx in ("ndvi", "ndbi"):
                x = data[y][f"{idx}_{s}"]
                m = land & np.isfinite(x)
                r = correlation(x, lst, m, thin)
                r["thin_spacing_m"] = thin * cfg.scale
                cor_rows.append({"year": y, "season": s, "index": idx.upper(), **r})
    pd.DataFrame(lst_rows).to_csv(out / "lst_summary.csv", index=False)
    pd.DataFrame(cls_rows).to_csv(out / "lst_per_class.csv", index=False)
    pd.DataFrame(uhi_rows)[["year", "season", "method", "uhi_intensity_c", "urban_mean_c", "rural_mean_c", "urban_km2",
                            "rural_km2", "ring_outer_km", "ring_capped"]].to_csv(out / "uhi_intensity.csv", index=False)
    pd.DataFrame(cor_rows).to_csv(out / "lst_correlations.csv", index=False)

    # 6. Conversion analysis (did pixels that became built-up warm more than pixels that did not change?)
    conv_rows = []
    for a, b in combinations(years, 2):
        for s in SEASONS:
            conv_rows += [{"period": f"{a}-{b}", "season": s, **r}
                          for r in conversion(cfg, data[a]["lulc"], data[b]["lulc"], data[a][f"lst_{s}"], data[b][f"lst_{s}"], aoi)]
    if conv_rows:
        pd.DataFrame(conv_rows).to_csv(out / "conversion_lst_change.csv", index=False)
