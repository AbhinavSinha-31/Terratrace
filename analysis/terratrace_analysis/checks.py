"""Sanity checks: anything suspicious is FLAGGED in results_summary.md, never hidden or silently fixed.

With config.toml [lst] enabled = false no LST / UHI check runs and the November–February composite (used only for LST)
is not checked.

Each flag is (level, topic, message). Levels: WARNING = a number that must not be used without addressing it,
CAUTION = usable but must be stated in the paper, INFO = context worth knowing.
"""

from __future__ import annotations

from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd

from .config import Config
from .stats import load_meta

Flag = tuple[str, str, str]


def churn(tm: pd.DataFrame, name: str) -> dict[str, float]:
    """Gross flows of one class in a transition matrix (km², rows = first year, columns = second year)."""
    stable = float(tm.loc[name, name])
    lost = float(tm.loc[name].sum()) - stable
    gained = float(tm[name].sum()) - stable
    return {"first_km2": stable + lost, "second_km2": stable + gained, "stable_km2": stable, "lost_km2": lost,
            "gained_km2": gained, "net_km2": gained - lost}


def run(cfg: Config, cache: Path, tables: Path, years: list[int]) -> list[Flag]:
    ck = cfg.checks
    flags: list[Flag] = []
    acc = pd.read_csv(tables / "accuracy_metrics.csv")
    labels = pd.read_csv(tables / "training_labels.csv")
    heat = cfg.lst_enabled
    lst = pd.read_csv(tables / "lst_summary.csv") if heat else pd.DataFrame()
    per_class = pd.read_csv(tables / "lst_per_class.csv") if heat else pd.DataFrame()
    uhi = pd.read_csv(tables / "uhi_intensity.csv") if heat else pd.DataFrame()
    areas = pd.read_csv(tables / "class_areas.csv")

    flags.append(("CAUTION", "accuracy", "All accuracy figures are AGREEMENT WITH REFERENCE LABELS (held-out GLC-FCS30D stable pixels), "
                  "not accuracy against ground truth; stable pixels are easier than changing ones, so the figures are optimistic. "
                  "Independent validation points (outputs/validation) have not been interpreted yet."))
    for _, r in acc.iterrows():
        if r.overall_agreement < ck["min_overall_accuracy"]:
            flags.append(("WARNING", "accuracy", f"{r.year}: overall agreement {r.overall_agreement:.1%} is below {ck['min_overall_accuracy']:.0%}."))
        if r.kappa < ck["min_kappa"]:
            flags.append(("WARNING", "accuracy", f"{r.year}: kappa {r.kappa:.2f} is below {ck['min_kappa']:.2f}."))
        if isinstance(r.get("per_class_withheld"), str) and r["per_class_withheld"]:
            flags.append(("WARNING", "accuracy", f"{r.year}: per-class agreement NOT reported for {r['per_class_withheld']} — fewer than "
                          f"{ck['min_test_points_per_class']} test points; any per-class percentage would be meaningless."))
        for c in cfg.classes:
            for kind in ("producers", "users"):
                v = r[f"{kind}_{c.name}"]
                if pd.notna(v) and v < ck["min_class_accuracy"]:
                    flags.append(("WARNING", "accuracy", f"{r.year}: {kind[:-1]}'s agreement for {c.name} is {v:.0%}."))

    for _, r in labels.iterrows():
        pts = r.train_points + r.test_points
        if pts < ck["min_points_per_class"]:
            flags.append(("WARNING", "training labels", f"{r.year}: only {r.reference_label_pixels:,} reference-label pixels for {r['class']} "
                          f"({pts} sample points; target {cfg.rf['points_per_class']}). Its map area and accuracy are unreliable: "
                          f"few points, probably from very few patches."))

    lab = lambda y, s: cfg.season_label(s, int(y))  # noqa: E731
    for y in years:
        meta = load_meta(cache, y)
        for s in ("summer", "winter", "annual") if heat else ("summer", "annual"):
            n = meta["scenes"][s]["count"]
            if n < ck["min_scenes"]:
                flags.append(("WARNING", "scenes", f"{lab(y, s)}: only {n} Landsat scenes."))
        if meta.get("note"):
            flags.append(("INFO", "data", f"{y}: {meta['note']}."))
    for r in lst.itertuples():
        if r.valid_fraction_of_study_area < ck["min_valid_fraction"]:
            flags.append(("CAUTION", "coverage", f"{lab(r.year, r.season)}: LST exists for {r.valid_fraction_of_study_area:.1%} of the study area "
                          f"(gaps: clouds / SLC-off stripes with no clear observation)."))
        lo, hi = ck["lst_pixel_range"]
        if r.p1_c < lo or r.p99_c > hi:
            flags.append(("WARNING", "LST", f"{lab(r.year, r.season)}: 1st–99th percentile LST {r.p1_c:.1f}–{r.p99_c:.1f} °C is outside {lo}–{hi} °C."))
    for _, r in per_class.iterrows():
        lo, hi = ck[f"lst_{r.season}_mean_range"]
        if pd.notna(r.mean_c) and not (lo <= r.mean_c <= hi):
            flags.append(("WARNING", "LST", f"{lab(r.year, r.season)}: mean LST of {r['class']} is {r.mean_c:.1f} °C (expected {lo}–{hi} °C)."))
    for r in uhi.itertuples():
        if r.ring_capped:
            flags.append(("CAUTION", "UHI", f"{lab(r.year, r.season)}: the rural ring reached {cfg.uhi['ring_max_km']} km before matching the core's area."))
        if r.uhi_intensity_c < 0:
            flags.append(("INFO", "UHI", f"{lab(r.year, r.season)} ({r.method}): UHI intensity is negative ({r.uhi_intensity_c:+.2f} °C) — "
                          f"the urban area is cooler than its surroundings at the ~10:30 overpass (a known daytime 'urban cool island' "
                          f"over dry, bare farmland in pre-monsoon India; Shastri et al., 2017)."))
    built = areas[areas.class_code == 1].sort_values("year")
    if len(built) > 1 and (built.area_km2.diff().dropna() < 0).any():
        flags.append(("WARNING", "LULC", "Built-up area DECREASES between two study years — implausible here; check the classification."))
    # Results that contradict the expected story, or transitions that look like class confusion, are flagged — not hidden.
    yrs = sorted(areas.year.unique())
    bname, aname = cfg.class_name(1), cfg.class_name(3)
    for a, b in combinations(yrs, 2):
        tm = pd.read_csv(tables / f"transition_{a}_{b}_km2.csv", index_col=0)
        fwd, rev = tm.loc[aname, bname], tm.loc[bname, aname]
        if fwd > 0 and rev > 0.25 * fwd:
            flags.append(("CAUTION", "LULC change", f"{a}→{b}: {fwd:.1f} km² of {aname} became {bname}, but {rev:.1f} km² went the other way "
                          f"({rev / fwd:.0%} of the forward flow). Built-up → cropland reversals at this scale are mostly class confusion, "
                          f"because bare harvested fields are counted in {bname}; use the NET conversion ({fwd - rev:.1f} km²) and net class "
                          f"changes, not the gross transition, as the headline."))
        for c in cfg.classes:
            ch = churn(tm, c.name)
            if ch["first_km2"] > 0 and ch["stable_km2"] < ck["min_stable_share"] * ch["first_km2"]:
                flags.append(("CAUTION", "LULC change", f"{a}→{b}: only {ch['stable_km2']:.1f} km² ({ch['stable_km2'] / ch['first_km2']:.0%}) "
                              f"of the {ch['first_km2']:.1f} km² mapped as {c.name} in {a} is {c.name} again in {b} (threshold "
                              f"{ck['min_stable_share']:.0%}); {ch['lost_km2']:.1f} km² was lost to other classes and {ch['gained_km2']:.1f} km² "
                              f"gained from them. The net change ({ch['net_km2']:+.1f} km²) is a small difference between these large gross "
                              f"flows, which include class confusion, so it is uncertain."))
    for season in ("summer", "winter") if heat else ():
        u = uhi[(uhi.season == season) & (uhi.method == "urban core vs rural ring")].sort_values("year")
        if len(u) > 1 and np.sign(u.uhi_intensity_c).nunique() > 1:
            flags.append(("CAUTION", "UHI", "the core-vs-ring UHI changes sign between years ("
                          + ", ".join(f"{lab(r.year, season)}: {r.uhi_intensity_c:+.2f} °C" for r in u.itertuples())
                          + "). Both values are small (< 1 °C); one composite per year cannot separate a trend from weather."))
    # Scene timing: the same season drawn from different parts of the season in different years is not like-for-like.
    months_path = tables / "scene_months.csv"
    if months_path.exists():
        sm = pd.read_csv(months_path)
        if not heat:
            sm = sm[sm.season == "summer"]
        for season, d in sm.groupby("season", sort=False):
            for a, b in combinations(sorted(d.year.unique()), 2):
                da, db = d[d.year == a].set_index("month_of_season"), d[d.year == b].set_index("month_of_season")
                diff = ((db.share_of_composite - da.share_of_composite) * 100).dropna()
                if not len(diff):
                    continue
                k = diff.abs().idxmax()
                la, lb = cfg.season_label(season, int(a)), cfg.season_label(season, int(b))
                if diff.abs().max() <= ck["max_month_share_diff_pp"]:
                    flags.append(("INFO", "scenes", f"{la} vs {lb}: scene timing checked — the largest difference in a month's share of the "
                                  f"scenes is {abs(diff[k]):.0f} percentage points ({da.month_name[k]}: {da.share_of_composite[k]:.0%} vs "
                                  f"{db.share_of_composite[k]:.0%}), within the {ck['max_month_share_diff_pp']}-point limit."))
                else:
                    flags.append(("CAUTION", "scenes", f"{la} vs {lb}: the scenes are "
                                  f"spread differently over the season — {da.month_name[k]} holds {da.share_of_composite[k]:.0%} of the scenes in "
                                  f"{la} but {db.share_of_composite[k]:.0%} in {lb} (more than {ck['max_month_share_diff_pp']} percentage points "
                                  "apart). The two composites describe different parts of the season, so part of their "
                                  f"{'temperature ' if heat else ''}difference can come from timing."))
    flags.append(("INFO", "population", f"GHSL epochs from {cfg.population['projected_from']} are model projections, not census-based estimates."))
    return flags
