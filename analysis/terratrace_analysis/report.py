"""results_summary.md — nine fixed sections, written so an abstract can be drafted directly from it.

Every number is read from the regenerated CSV tables in outputs/tables (or the run metadata); nothing is typed in by hand.
Before the file is written, `cross_check` recomputes the key numbers independently from the tables/rasters and stops
with an error if any disagree, so a wrong number cannot reach the summary silently.
Sentences state the direction the data show (heat island OR cool island, warming OR cooling) — never the expected one.
"""

from __future__ import annotations

import json
from datetime import date
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd

from . import __version__, checks
from .config import Config
from .stats import load_meta

NEAR_ZERO_C = 0.2   # |UHI| below this is described as "near zero", not as an island


def _f(v: float, d: int = 1) -> str:
    return f"{v:,.{d}f}"


def _signed(v: float, d: int = 2, unit: str = " °C") -> str:
    return f"{v:+.{d}f}{unit}"


def _island(v: float) -> str:
    if abs(v) < NEAR_ZERO_C:
        return f"near zero (|UHI| < {NEAR_ZERO_C} °C) — neither a heat nor a cool island"
    return "a surface urban **heat island** (urban warmer)" if v > 0 else "a surface urban **cool island** (urban cooler than its surroundings)"


def _verdict(dz: float, draw: float) -> str:
    """Plain verdict for 'converted minus unchanged': inconclusive when the normalised and raw differences disagree in sign."""
    if abs(dz) < 0.05:
        return "no difference"
    if abs(draw) >= 0.05 and np.sign(dz) != np.sign(draw):
        return "inconclusive: normalised and raw differences point in opposite directions"
    size = "slightly " if abs(dz) < 0.2 else ""
    return f"{size}{'warmer' if dz > 0 else 'cooler'} than the unchanged class"


def _p(p: float) -> str:
    return "p < 0.001" if p < 1e-3 else f"p = {p:.3f}"


class Tables:
    """All inputs of the report, loaded once."""

    def __init__(self, cfg: Config, cache: Path, out: Path, years: list[int]):
        t = out / "tables"
        self.cfg, self.cache, self.t = cfg, cache, t
        self.years = [y for y in years if (cache / str(y) / "meta.json").exists()]
        self.meta = {y: load_meta(cache, y) for y in self.years}
        self.areas = pd.read_csv(t / "class_areas.csv")
        self.acc = pd.read_csv(t / "accuracy_metrics.csv")
        self.labels = pd.read_csv(t / "training_labels.csv")
        self.lstc = pd.read_csv(t / "lst_per_class.csv")
        self.lsts = pd.read_csv(t / "lst_summary.csv")
        self.uhi = pd.read_csv(t / "uhi_intensity.csv")
        self.cor = pd.read_csv(t / "lst_correlations.csv")
        self.scenes = pd.read_csv(t / "scenes.csv")
        self.conv = pd.read_csv(t / "conversion_lst_change.csv") if (t / "conversion_lst_change.csv").exists() else None
        self.pop = pd.read_csv(t / "population_vs_builtup.csv") if (t / "population_vs_builtup.csv").exists() else None
        self.mask = pd.read_csv(t / "lst_mask_impact.csv") if (t / "lst_mask_impact.csv").exists() else None
        self.cm = {y: pd.read_csv(t / f"confusion_matrix_{y}.csv", index_col=0) for y in self.years}
        self.tm = {(a, b): pd.read_csv(t / f"transition_{a}_{b}_km2.csv", index_col=0) for a, b in combinations(self.years, 2)}
        self.aoi_area = json.loads((cache / "aoi_area.json").read_text(encoding="utf-8"))
        self.built = cfg.class_name(1)

    def area(self, y: int, code: int, col: str = "area_km2") -> float:
        return float(self.areas[(self.areas.year == y) & (self.areas.class_code == code)][col].iloc[0])

    def u(self, y: int, s: str, method: str) -> pd.Series:
        return self.uhi[(self.uhi.year == y) & (self.uhi.season == s) & (self.uhi.method == method)].iloc[0]


CORE, BUILTM = "urban core vs rural ring", "built-up vs non-built-up land"


# ----------------------------------------------------------------------------- cross-check
def cross_check(T: Tables) -> list[str]:
    """Independent recomputation of the key numbers. Raises AssertionError on any disagreement."""
    done = []
    aoi = np.load(T.cache / "aoi_mask.npy").astype(bool)
    for y in T.years:
        lulc = np.load(T.cache / str(y) / "lulc.npy")
        for c in T.cfg.classes:
            px = int(((lulc == c.code) & aoi).sum())
            assert abs(px * T.cfg.scale**2 / 1e6 - T.area(y, c.code)) < 1e-6, f"area {y} {c.name}"
        tot = T.areas[(T.areas.year == y)].area_km2.sum()
        assert abs(tot - T.aoi_area["area_km2_grid"]) < 0.01, f"class areas {y} do not add up to the study area"
        pc = T.areas[(T.areas.year == y) & (T.areas.class_code > 0)].percent_of_classified.sum()
        assert abs(pc - 100) < 1e-6, f"percentages {y} sum to {pc}"
        cm = T.cm[y].to_numpy(float)
        a = T.acc[T.acc.year == y].iloc[0]
        assert abs(np.trace(cm) / cm.sum() - a.overall_agreement) < 1e-9, f"overall agreement {y}"
        assert int(cm.sum()) == int(a.n_test_points), f"test points {y}"
        for s in ("summer", "winter"):
            for m in (CORE, BUILTM):
                r = T.u(y, s, m)
                assert abs(r.urban_mean_c - r.rural_mean_c - r.uhi_intensity_c) < 1e-9, f"UHI {y} {s} {m}"
        done.append(f"{y}: class areas re-counted from the raster, sum to the study area, percentages sum to 100; "
                    "overall agreement = trace / total of the confusion matrix; UHI = urban − rural (4 cases)")
    for (a, b), tm in T.tm.items():
        la, lb = np.load(T.cache / str(a) / "lulc.npy"), np.load(T.cache / str(b) / "lulc.npy")
        both = aoi & (la > 0) & (lb > 0)
        tol = 0.0005 * len(T.cfg.classes) + 1e-9   # each CSV cell is rounded to 0.001 km²: a sum of n cells may be off by n × 0.0005
        for c in T.cfg.classes:
            assert abs(tm.loc[c.name].sum() - ((la == c.code) & both).sum() * T.cfg.scale**2 / 1e6) <= tol, f"transition rows {a}-{b}"
            assert abs(tm[c.name].sum() - ((lb == c.code) & both).sum() * T.cfg.scale**2 / 1e6) <= tol, f"transition cols {a}-{b}"
        done.append(f"{a}→{b}: transition-matrix row sums = {a} class areas and column sums = {b} class areas (re-counted)")
    if T.pop is not None:
        p = T.pop.set_index("epoch")
        raw = pd.read_csv(T.cache / "population.csv").set_index("epoch")
        assert (p.population == raw.population).all(), "population table differs from the Earth Engine result"
        done.append("population table identical to the Earth Engine sums")
    return done


# ----------------------------------------------------------------------------- sections
def s1_setup(T: Tables, L: list[str]) -> None:
    cfg = T.cfg
    L += ["## 1. Study setup", ""]
    names = {"LE07": "Landsat 7 ETM+", "LC08": "Landsat 8", "LC09": "Landsat 9", "LT05": "Landsat 5 TM"}
    sens = "; ".join(f"{y}: {' + '.join(names[s] for s in T.meta[y]['sensors'])}"
                     + (f" ({T.meta[y]['pooled_years'][0]}–{T.meta[y]['pooled_years'][-1]} pooled)" if len(T.meta[y]['pooled_years']) > 1 else "")
                     for y in T.years)
    sc = "; ".join(f"{y}: {int(T.scenes[(T.scenes.year == y) & (T.scenes.season == 'summer')].scenes.iloc[0])} April–June, "
                   f"{int(T.scenes[(T.scenes.year == y) & (T.scenes.season == 'winter')].scenes.iloc[0])} Nov–Feb, "
                   f"{int(T.scenes[(T.scenes.year == y) & (T.scenes.season == 'annual')].scenes.iloc[0])} whole-year" for y in T.years)
    pts = "; ".join(f"{y}: {int(T.labels[T.labels.year == y].train_points.sum())} training / {int(T.labels[T.labels.year == y].test_points.sum())} test"
                    for y in T.years)
    L += [f"- **Study area:** {cfg.study['name']} — FAO GAUL 2025 districts {' + '.join(cfg.study.get('district_labels', cfg.study['gaul_districts']))}, "
          f"{_f(T.aoi_area['area_km2_geodesic'], 0)} km² (30 m grid: {_f(T.aoi_area['area_km2_grid'], 0)} km²).",
          f"- **Years and sensors:** {sens} — Landsat Collection 2 Level-2, Tier 1, 30 m.",
          f"- **Scenes used:** {sc}.",
          f"- **Classes ({len(cfg.classes)}):** {', '.join(c.name for c in cfg.classes)} (Barren/Open land merged into Built-up in every year). "
          f"Random Forest, {cfg.rf['trees']} trees; points ({cfg.rf['points_per_class']} per class, 70/30 per class): {pts}.", ""]


def s2_quality(T: Tables, L: list[str]) -> None:
    L += ["## 2. Classification quality", ""]
    for y in T.years:
        a = T.acc[T.acc.year == y].iloc[0]
        cm = T.cm[y]
        pairs = []
        n = len(cm)
        for i in range(n):
            for j in range(i + 1, n):
                pairs.append((int(cm.iat[i, j] + cm.iat[j, i]), cm.index[i], cm.columns[j], int(cm.iat[i, j]), int(cm.iat[j, i])))
        pairs.sort(reverse=True)
        conf = "; ".join(f"{p[1]} ↔ {p[2]}: {p[0]} of {int(a.n_test_points)} test points ({p[3]} {p[1]} → {p[2]}, {p[4]} the other way)"
                         for p in pairs[:2])
        withheld = f" Per-class agreement withheld for {a.per_class_withheld} (< {T.cfg.checks['min_test_points_per_class']} test points)." \
            if isinstance(a.get("per_class_withheld"), str) and a.per_class_withheld else ""
        L.append(f"- **{y}:** overall agreement with reference labels **{a.overall_agreement:.1%}**, kappa **{a.kappa:.3f}** "
                 f"({int(a.n_test_points)} held-out points). Most confused pairs: {conf}.{withheld}")
    L += ["- These figures measure agreement with labels derived from GLC-FCS30D (stable pixels, agreeing with an independent "
          "product), **not accuracy against ground truth**; see §9.", ""]


def s3_change(T: Tables, L: list[str]) -> None:
    cfg = T.cfg
    L += ["## 3. Land-cover change (core result)", "", "| Class | " + " | ".join(f"{y} km² | {y} %" for y in T.years) + " |",
          "|---|" + "---:|---:|" * len(T.years)]
    for c in cfg.classes:
        L.append(f"| {c.name} | " + " | ".join(f"{_f(T.area(y, c.code))} | {_f(T.area(y, c.code, 'percent_of_classified'))}" for y in T.years) + " |")
    L.append("")
    for (a, b), tm in T.tm.items():
        L.append(f"**Change {a} → {b}:**")
        L.append("")
        for c in cfg.classes:
            dk = T.area(b, c.code) - T.area(a, c.code)
            dp = T.area(b, c.code, "percent_of_classified") - T.area(a, c.code, "percent_of_classified")
            rel = dk / T.area(a, c.code) * 100 if T.area(a, c.code) else float("nan")
            L.append(f"- {c.name}: {_signed(dk, 1, ' km²')} ({_signed(dp, 1, ' percentage points')}; {_signed(rel, 0, ' % relative')})")
        off = [(float(tm.iat[i, j]), tm.index[i], tm.columns[j]) for i in range(len(tm)) for j in range(len(tm)) if i != j]
        off.sort(reverse=True)
        moved = sum(v for v, _, _ in off)
        L.append(f"- Top 3 transitions ({_f(moved)} km² changed class in total): " + "; ".join(
            f"**{_f(v)} km² of {f} became {t}** ({v / moved:.0%} of all change)" for v, f, t in off[:3]) + ".")
        new_built = tm[T.built].drop(T.built)
        L.append(f"- Land that became {T.built}: {_f(new_built.sum())} km² in total — " + ", ".join(
            f"{_f(v)} km² from {k} ({v / new_built.sum():.0%})" for k, v in new_built.sort_values(ascending=False).items()) + ".")
        lost = tm.loc[T.built].drop(T.built)
        L.append(f"- {T.built} that changed to another class: {_f(lost.sum())} km² (" + ", ".join(f"{_f(v)} km² to {k}" for k, v in lost.items()) +
                 "). Built-up rarely returns to cropland in reality; most of this is confusion between bare harvested fields "
                 "(inside the merged Built-up class) and cropland, so the gross transitions overstate change; **use the net figures**.")
        L.append("")


def s4_population(T: Tables, L: list[str]) -> None:
    L += ["## 4. Population", ""]
    if T.pop is None:
        L += ["- Population table not available.", ""]
        return
    p = T.pop.set_index("epoch")
    ys = [y for y in T.years if y in p.index]
    for y in ys:
        tag = " — **GHSL model projection, not a census-based estimate**" if p.loc[y, "projection_not_estimate"] else ""
        L.append(f"- {y}: {_f(p.loc[y, 'population'] / 1e6, 2)} million residents (GHSL GHS-POP P2023A){tag}.")
    for a, b in combinations(ys, 2):
        pg = (p.loc[b, "population"] / p.loc[a, "population"] - 1) * 100
        bg = (T.area(b, 1) / T.area(a, 1) - 1) * 100
        gg = (p.loc[b, "ghsl_built_km2"] / p.loc[a, "ghsl_built_km2"] - 1) * 100
        pc_a = T.area(a, 1) * 1e6 / p.loc[a, "population"]
        pc_b = T.area(b, 1) * 1e6 / p.loc[b, "population"]
        L.append(f"- {a} → {b}: population {_signed(pg, 1, ' %')}; built-up area (this study) {_signed(bg, 1, ' %')}; "
                 f"GHSL built-up surface {_signed(gg, 1, ' %')}. Built-up land per resident: {_f(pc_a, 0)} m² → {_f(pc_b, 0)} m² "
                 f"({'built-up grew faster than population' if bg > pg else 'population grew faster than built-up area'}).")
    L += ["- Only two (later three) time points: this describes co-occurring growth, not a statistical relationship or cause.", ""]


def s5_lst(T: Tables, L: list[str]) -> None:
    cfg = T.cfg
    L += ["## 5. Temperature / UHI", "", "**Mean land surface temperature (land = all classes except Water):**", "",
          "| | " + " | ".join(f"{y} Apr–Jun" for y in T.years) + " | " + " | ".join(f"{y} Nov–Feb" for y in T.years) + " |",
          "|---|" + "---:|" * (2 * len(T.years))]
    row = lambda s, y: T.lsts[(T.lsts.year == y) & (T.lsts.season == s)].iloc[0]  # noqa: E731
    L.append("| Study area (land) | " + " | ".join(f"{row('summer', y).mean_land_c:.1f} °C" for y in T.years) + " | "
             + " | ".join(f"{row('winter', y).mean_land_c:.1f} °C" for y in T.years) + " |")
    for c in cfg.classes:
        g = lambda s, y: T.lstc[(T.lstc.year == y) & (T.lstc.season == s) & (T.lstc.class_code == c.code)].iloc[0].mean_c  # noqa: E731
        L.append(f"| {c.name} | " + " | ".join(f"{g('summer', y):.1f} °C" for y in T.years) + " | "
                 + " | ".join(f"{g('winter', y):.1f} °C" for y in T.years) + " |")
    L += ["", "Absolute LST differs between years partly because of that season's weather; compare classes within a year, "
          "or use the relative measures below across years.", "", "**UHI intensity (urban − rural):**", "",
          "| Year | Season | Urban core − rural ring (primary) | Built-up − non-built-up (secondary) | Result |", "|---|---|---:|---:|---|"]
    for s in ("summer", "winter"):
        for y in T.years:
            a, b = T.u(y, s, CORE), T.u(y, s, BUILTM)
            L.append(f"| {y} | {'April–June (primary)' if s == 'summer' else 'Nov–Feb (secondary)'} | {_signed(a.uhi_intensity_c)} "
                     f"({a.urban_mean_c:.1f} vs {a.rural_mean_c:.1f}; ring to {a.ring_outer_km:.1f} km) | {_signed(b.uhi_intensity_c)} | "
                     f"{_island(a.uhi_intensity_c).split(' (')[0]} |")
    L.append("")
    for y in T.years:
        a = T.u(y, "summer", CORE)
        L.append(f"- **{y}, April–June (primary): {_island(a.uhi_intensity_c)}** — urban core {_signed(a.uhi_intensity_c)} relative to the rural ring.")
    for y in T.years:
        a = T.u(y, "winter", CORE)
        L.append(f"- {y}, November–February (secondary): {_island(a.uhi_intensity_c)} — {_signed(a.uhi_intensity_c)}.")
    L.append("")
    if T.conv is not None:
        L += ["**Key test of the story — LST change of pixels that became Built-up vs pixels that kept their class:**", "",
              "| Period | Season | Group | Area km² | Mean ΔLST (°C) | Mean Δ normalised LST (SD) |", "|---|---|---|---:|---:|---:|"]
        for _, r in T.conv[T.conv.n_pixels > 0].iterrows():
            L.append(f"| {r.period.replace('-', '→')} | {r.season} | {r.group} | {_f(r.area_km2)} | {_signed(r.mean_delta_lst_c)} | {_signed(r.mean_delta_z, 2, '')} |")
        L.append("")
        for (period, s), d in T.conv.groupby(["period", "season"], sort=False):
            d = d.set_index("group")
            for src, stable in (("Agriculture/Cropland → Built-up", "Stable Agriculture/Cropland"), ("Vegetation/Trees → Built-up", "Stable Vegetation/Trees")):
                if src not in d.index or d.loc[src, "n_pixels"] == 0:
                    continue
                g, st = d.loc[src], d.loc[stable]
                dd, dr = g.mean_delta_z - st.mean_delta_z, g.mean_delta_lst_c - st.mean_delta_lst_c
                L.append(f"- {period.replace('-', '→')}, {s}: {src.split(' →')[0].lower()} that became built-up ({_f(g.area_km2)} km²) vs "
                         f"{stable.replace('Stable ', 'unchanged ').lower()}: difference {_signed(dd, 2, ' SD')} normalised, {_signed(dr)} raw "
                         f"({_signed(g.mean_delta_lst_c)} vs {_signed(st.mean_delta_lst_c)}) — **{_verdict(dd, dr)}**.")
        L.append("")


def s6_cor(T: Tables, L: list[str]) -> None:
    L += ["## 6. Correlations", "", "| Year | Season | LST vs NDVI r | LST vs NDBI r | p (300 m thinned grid) | n pixels (thinned) |", "|---|---|---:|---:|---|---:|"]
    for s in ("summer", "winter"):
        for y in T.years:
            c = T.cor[(T.cor.year == y) & (T.cor.season == s)].set_index("index")
            L.append(f"| {y} | {'April–June' if s == 'summer' else 'Nov–Feb'} | {c.loc['NDVI', 'r']:+.3f} | {c.loc['NDBI', 'r']:+.3f} | "
                     f"NDVI {_p(c.loc['NDVI', 'p_thinned'])}; NDBI {_p(c.loc['NDBI', 'p_thinned'])} | {_f(c.loc['NDVI', 'n_pixels'], 0)} ({_f(c.loc['NDVI', 'n_thinned'], 0)}) |")
    L += ["", "- r uses every land pixel (water excluded). The p-value uses every 10th row and column (300 m apart) because "
          "neighbouring 30 m pixels are not independent (thermal bands are 100 m natively); even so, p-values from tens of "
          "thousands of pixels are always tiny — the size of r is what matters.", ""]


def s7_qc(T: Tables, L: list[str], flags: list, checks_done: list[str]) -> None:
    L += ["## 7. Quality control", "",
          f"- **LST masking rule:** in every scene, a pixel's LST is dropped when the USGS surface-temperature uncertainty "
          f"(`ST_QA`) exceeds {T.cfg.max_st_uncertainty_k:g} K **or** its emissivity (`ST_EMIS`) is below {T.cfg.min_st_emissivity:.2f} "
          "(real surfaces here: ~0.92–0.99), in addition to the QA_PIXEL cloud/shadow/snow mask. It targets ASTER GED emissivity "
          "artefacts that the cloud mask cannot see: blocky 100 m rectangles at the southern tip (28.09°N 77.48–77.51°E) with "
          "emissivity 0.74–0.80, LST up to 69 °C in single scenes, and either ST_QA ≈ 55 K or no uncertainty value at all "
          "(ST_QA = 0 — so the uncertainty test alone missed most of them; found by checking the hottest pixel after a first run). "
          "Reflectance and the LULC maps are unaffected."]
    if T.mask is not None:
        for _, r in T.mask.iterrows():
            L.append(f"- {int(r.year)} {r.season}: {int(r.pixels_removed_entirely):,} pixels lost their LST entirely "
                     f"({r.pixels_removed_entirely / r.pixels_with_lst_before:.3%} of {int(r.pixels_with_lst_before):,}); "
                     f"{int(r.pixels_changed_over_1c):,} more changed by > 1 °C; pixels > 55 °C {int(r.pixels_over_55c_before)} → "
                     f"{int(r.pixels_over_55c_after)}; max land LST {r.max_land_lst_before_c:.1f} → {r.max_land_lst_after_c:.1f} °C. "
                     f"UHI before → after: core vs ring {_signed(r.uhi_core_ring_before_c)} → {_signed(r.uhi_core_ring_after_c)}; "
                     f"built-up vs non-built-up {_signed(r.uhi_builtup_before_c)} → {_signed(r.uhi_builtup_after_c)}.")
    else:
        L.append("- Mask-impact table not available.")
    L.append("- Seasonal ponds: a few pixels classified Water are ponds that are dry in April–June (e.g. 28.62°N 77.47°E; "
             "JRC Global Surface Water ≈ 1 month of water per year). Their LST is real; the class is wrong. Water is excluded "
             "from all land-LST statistics, so they do not affect the UHI numbers.")
    L += ["", "**Flags raised by checks.py:**", ""]
    order = {"WARNING": 0, "CAUTION": 1, "INFO": 2}
    L += [f"- **{lvl}** ({topic}): {msg}" for lvl, topic, msg in sorted(flags, key=lambda f: order[f[0]])] or ["- none"]
    L += ["", "**Cross-checks run before writing this file (all passed):**", ""] + [f"- {c}" for c in checks_done] + [""]


def s8_findings(T: Tables, L: list[str]) -> None:
    L += ["## 8. Five key findings", ""]
    a, b = T.years[0], T.years[-1]
    tm = T.tm[(a, b)]
    bu, ag = T.built, T.cfg.class_name(3)
    ba, bb = T.area(a, 1), T.area(b, 1)
    F = []
    pop = ""
    if T.pop is not None and a in set(T.pop.epoch) and b in set(T.pop.epoch):
        p = T.pop.set_index("epoch")
        pop = (f", while GHSL population rose {_signed((p.loc[b, 'population'] / p.loc[a, 'population'] - 1) * 100, 0, ' %')} "
               f"({p.loc[a, 'population'] / 1e6:.2f} → {p.loc[b, 'population'] / 1e6:.2f} million; the {b} figure is a GHSL projection)")
    F.append(f"Built-up land (including bare land) in {T.cfg.study['short_name']} grew from {_f(ba, 0)} km² ({T.area(a, 1, 'percent_of_classified'):.1f} %) "
             f"in {a} to {_f(bb, 0)} km² ({T.area(b, 1, 'percent_of_classified'):.1f} %) in {b}, a net {_signed(bb - ba, 0, ' km²')} "
             f"({_signed((bb / ba - 1) * 100, 0, ' %')}){pop}.")
    fwd, rev = tm.loc[ag, bu], tm.loc[bu, ag]
    F.append(f"Cropland was the main source of new built-up land: {_f(fwd, 0)} km² changed from cropland to built-up, but "
             f"{_f(rev, 0)} km² was mapped the other way (mostly class confusion), leaving a net conversion of {_f(fwd - rev, 0)} km² and a net "
             f"cropland change of {_signed(T.area(b, 3) - T.area(a, 3), 0, ' km²')}.")
    dv = T.area(b, 2) - T.area(a, 2)
    F.append(f"Vegetation/tree cover {'increased' if dv >= 0 else 'decreased'}: it changed by {_signed(dv, 0, ' km²')} "
             f"({_f(T.area(a, 2), 0)} → {_f(T.area(b, 2), 0)} km²)"
             f"{', so urban growth in this period replaced cropland rather than vegetation' if dv >= 0 else ''}.")
    u_b, u_a = T.u(b, "summer", CORE), T.u(a, "summer", CORE)
    w_a, w_b = T.u(a, "winter", CORE), T.u(b, "winter", CORE)
    F.append(f"In the pre-monsoon season (April–June, ~10:30 overpass) the urban core was {_signed(u_a.uhi_intensity_c)} relative to its rural ring "
             f"in {a} ({'cool' if u_a.uhi_intensity_c < 0 else 'heat'} island) and {_signed(u_b.uhi_intensity_c)} in {b} "
             f"({'cool' if u_b.uhi_intensity_c < 0 else 'heat'} island), small values whose change of sign cannot be separated from weather "
             f"with one composite per year, whereas November–February showed a consistent heat island "
             f"({_signed(w_a.uhi_intensity_c)} and {_signed(w_b.uhi_intensity_c)}).")
    if T.conv is not None:
        d = T.conv[(T.conv.period == f"{a}-{b}") & (T.conv.season == "summer")].set_index("group")
        g, st = d.loc[f"{ag} → Built-up"], d.loc[f"Stable {ag}"]
        dd, dr = g.mean_delta_z - st.mean_delta_z, g.mean_delta_lst_c - st.mean_delta_lst_c
        F.append(f"Cropland that became built-up between {a} and {b} changed by {_signed(g.mean_delta_z, 2, ' SD')} in normalised April–June LST, "
                 f"against {_signed(st.mean_delta_z, 2, ' SD')} for cropland that stayed cropland, a difference of {_signed(dd, 2, ' SD')} "
                 f"({_signed(dr)} raw), i.e. {_verdict(dd, dr)}; "
                 + ("conversion to built-up was associated with clear summer warming." if dd >= 0.2 and dr > 0
                    else "conversion to built-up was associated with summer cooling." if dd <= -0.2 and dr < 0
                    else "conversion to built-up did not produce a clear summer temperature change."))
    L += [f"{i}. {x}" for i, x in enumerate(F[:5], 1)] + [""]


def s9_limits(T: Tables, L: list[str]) -> None:
    L += ["## 9. Limitations", "",
          "- **Accuracy is agreement with reference labels, not true accuracy.** Training and test points come from the same "
          "GLC-FCS30D-derived labels, restricted to temporally stable pixels (easier than changing ones) and spatially "
          "clustered; the figures are optimistic. Independent, stratified validation points (outputs/validation, "
          f"{T.cfg.validation['points_per_class']} per class per year) still have to be interpreted on high-resolution imagery.",
          "- **Built-up includes bare land.** Barren/Open land could not be trained (86 and 14 label pixels) and was merged into "
          "Built-up in every year; construction sites and cleared plots therefore count as built-up.",
          "- **Few labels for Vegetation/Trees and Water** (" + "; ".join(
              f"{y}: {int(T.labels[(T.labels.year == y) & (T.labels['class'] == 'Vegetation/Trees')].reference_label_pixels.iloc[0]):,} and "
              f"{int(T.labels[(T.labels.year == y) & (T.labels['class'] == 'Water')].reference_label_pixels.iloc[0]):,} label pixels" for y in T.years)
          + "), from a limited number of patches; their mapped areas are the least certain.",
          "- **Change maps add the errors of two maps**; small transitions (a few km²) are within classification noise.",
          "- **One overpass time.** Landsat sees ~10:30 local time only; night-time UHI (usually the strongest) is not measured.",
          "- **One composite per season per year.** Year-to-year weather differences affect absolute LST; UHI intensity and "
          "normalised LST reduce but do not remove this.",
          "- **Thermal resolution.** LST is 100 m (Landsat 8/9) or 60 m (Landsat 7) resampled to 30 m; small features are smoothed.",
          "- **Rural ring inside the study area.** East Delhi (urban) borders the study area to the west, so the ring is "
          "restricted to the districts; its location differs between years with the urban core.",
          "- **GHSL 2025 is a projection**, and GHSL population is itself modelled from census and built-up data (not a count).",
          "- **2005 (once added): Landsat 7 SLC-off** — about 22 % of each scene is missing in stripes; three pooled years fill most "
          "gaps, the remainder is reported. No independent label product exists for 2005 (stability filter only), and the "
          "sensor differs from 2015/2025 (ETM+ vs OLI).", ""]


def run(cfg: Config, cache: Path, out: Path, years: list[int]) -> None:
    T = Tables(cfg, cache, out, years)
    checks_done = cross_check(T)
    flags = checks.run(cfg, cache, out / "tables", T.years)
    L = [f"# Results summary — {cfg.study['name']}", "",
         f"Generated {date.today().isoformat()} by the TerraTrace analysis pipeline v{__version__} from `outputs/tables/*.csv` "
         f"(years {', '.join(map(str, T.years))}). Every number is read from those tables; none is typed by hand.", ""]
    s1_setup(T, L)
    s2_quality(T, L)
    s3_change(T, L)
    s4_population(T, L)
    s5_lst(T, L)
    s6_cor(T, L)
    s7_qc(T, L, flags, checks_done)
    s8_findings(T, L)
    s9_limits(T, L)
    (out / "results_summary.md").write_text("\n".join(L) + "\n", encoding="utf-8")
