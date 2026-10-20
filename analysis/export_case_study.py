"""Export the case study for the website: one JSON file + web-sized images, from analysis/outputs only.

    .venv\\Scripts\\python export_case_study.py

No Earth Engine. Every number is read from outputs/tables/*.csv (and the run metadata in outputs/cache) through the
same code that writes results_summary.md (terratrace_analysis.report), so the page and the summary cannot disagree:
  * the report's cross-checks run first (class areas re-counted from the rasters, transition sums, UHI = urban − rural…);
  * the five findings and the limitations are the report's own sentences, and each is checked to appear verbatim in
    outputs/results_summary.md (run `run_pipeline.py --steps report` first if this fails);
  * the QC flags come from terratrace_analysis.checks.
Re-runnable: when 2005 is added to the pipeline, run this again and the page shows all three years.

Output: frontend/public/case-studies/<id>/case-study.json and *.webp (each image ≤ ~480 KB).
The homepage card image is not exported here: it is the same true-colour basemap tile the live featured cards use
(see frontend/src/features/casestudy/data.ts), not a land-cover or temperature map.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path

import pandas as pd
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from terratrace_analysis import __version__, checks, config as config_mod, report  # noqa: E402

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "outputs"
CACHE = OUT / "cache"
CASE_ID = "noida-ghaziabad"
DEST = ROOT.parent / "frontend" / "public" / "case-studies" / CASE_ID
MAX_BYTES = 480_000
CORE, BUILTM = report.CORE, report.BUILTM


# ----------------------------------------------------------------------------- images
def webp(src: Path, dest: Path, width: int) -> dict:
    """Resize to `width` px and save as WebP, lowering quality until the file is ≤ MAX_BYTES."""
    im = Image.open(src).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    for q in (86, 80, 74, 68, 60, 52):
        im.save(dest, "WEBP", quality=q, method=6)
        if dest.stat().st_size <= MAX_BYTES:
            break
    return {"file": dest.name, "width": im.width, "height": im.height, "bytes": dest.stat().st_size}


# ----------------------------------------------------------------------------- report sentences (verbatim)
def _section(fn, T) -> list[str]:
    lines: list[str] = []
    fn(T, lines)
    return lines


def findings(T) -> list[str]:
    return [re.sub(r"^\d+\.\s+", "", l) for l in _section(report.s8_findings, T) if re.match(r"^\d+\.\s", l)]


def limitations(T) -> list[dict]:
    out = []
    for l in _section(report.s9_limits, T):
        m = re.match(r"^- \*\*(.+?)\*\*\s*(.*)$", l)
        if m:
            # The bold lead keeps its own punctuation ("…accuracy." / "…two maps" + "; small …"), as in the summary.
            out.append({"title": m.group(1), "text": m.group(2).strip(), "markdown": l})
    return out


# ----------------------------------------------------------------------------- plain-language presentation
def _sg(v: float, d: int) -> str:
    """Signed number with a typographic minus, for display (−0.55, +1.06)."""
    return f"{v:+,.{d}f}".replace("-", "−")


def headlines(T) -> list[dict]:
    """Headline cards for a general reader (website and PDF): one number and one sentence each, from the tables.
    Only the wording is written here; every number is read from the same tables as results_summary.md."""
    a, b = T.years[0], T.years[-1]
    bu, ag = T.built, T.cfg.class_name(3)
    ba, bb = T.area(a, 1), T.area(b, 1)
    pa, pb = T.area(a, 1, "percent_of_classified"), T.area(b, 1, "percent_of_classified")
    tm = T.tm[(a, b)]
    net = float(tm.loc[ag, bu] - tm.loc[bu, ag])
    dc = T.area(b, 3) - T.area(a, 3)
    va, vb = T.area(a, 2), T.area(b, 2)
    vpa, vpb = T.area(a, 2, "percent_of_classified"), T.area(b, 2, "percent_of_classified")
    sa, sb = float(T.u(a, "summer", CORE).uhi_intensity_c), float(T.u(b, "summer", CORE).uhi_intensity_c)
    wa, wb = float(T.u(a, "winter", CORE).uhi_intensity_c), float(T.u(b, "winter", CORE).uhi_intensity_c)
    nd = T.cor[T.cor["index"] == "NDVI"].r.astype(float)
    nb = T.cor[T.cor["index"] == "NDBI"].r.astype(float)

    pop = ""
    if T.pop is not None:
        p = T.pop.set_index("epoch")
        if a in p.index and b in p.index:
            pop = (f", while population rose {(p.population[b] / p.population[a] - 1) * 100:.0f} % "
                   f"(GHSL{'; ' + str(b) + ' is a projection' if bool(p.projection_not_estimate[b]) else ''})")
    cards = [{
        "id": "built", "value": f"{_sg(bb - ba, 0)} km²", "period": f"{a}→{b}", "title": "More built-up land",
        "text": f"Built-up land (including bare land) grew from {ba:,.0f} km² ({pa:.1f} % of the study area) in {a} "
                f"to {bb:,.0f} km² ({pb:.1f} %) in {b}{pop}.",
    }, {
        "id": "farmland", "value": f"{net:,.0f} km²", "period": f"{a}→{b}", "title": "The city grew mostly into farmland",
        "text": f"Most new built-up land replaced cropland: a net {net:,.0f} km² of farmland became built-up, and cropland "
                f"overall {'shrank' if dc < 0 else 'grew'} by {abs(dc):,.0f} km².",
    }]
    slight = abs(vpb - vpa) < 2
    cards.append({
        "id": "vegetation", "value": f"{_sg(vb - va, 0)} km²", "period": f"{a}→{b}",
        "title": f"Tree and vegetation cover {'rose' if vb >= va else 'fell'}{' slightly' if slight else ''}",
        "text": f"Tree/vegetation cover went from {vpa:.1f} % to {vpb:.1f} % of the study area ({va:,.0f} → {vb:,.0f} km²)"
                f"{', possibly due to parks and plantations' if vb >= va else ''}.",
    })
    both_warm = wa >= report.NEAR_ZERO_C and wb >= report.NEAR_ZERO_C
    cards.append({
        "id": "winter", "value": (f"≈ {_sg(wa, 1)} °C" if round(wa, 1) == round(wb, 1) else f"{_sg(wa, 1)} / {_sg(wb, 1)} °C"),
        "period": "Nov–Feb", "title": "Winter heat island in both years" if both_warm else "Winter: city vs countryside",
        "text": f"In November–February the urban core was {_sg(wa, 2)} °C ({a}) and {_sg(wb, 2)} °C ({b}) "
                f"{'warmer than' if both_warm else 'relative to'} the countryside around it.",
    })
    small = max(abs(sa), abs(sb)) < 1
    cards.append({
        "id": "summer", "value": "< 1 °C" if small else f"{_sg(sa, 1)} / {_sg(sb, 1)} °C", "period": "Apr–Jun",
        "title": "Summer days: no clear city heat effect" if small else "Summer days: city vs countryside",
        "text": f"In April–June, around 10:30 local time, the urban core was {'within 1 °C of' if small else 'compared with'} the "
                f"countryside around it in both years ({_sg(sa, 2)} °C in {a}, {_sg(sb, 2)} °C in {b}).",
    })
    if (nd < 0).all():
        cards.append({
            "id": "greener", "value": f"r ≈ {_sg(nd.mean(), 1)}", "period": "NDVI–LST", "title": "Greener areas are cooler",
            "text": f"Surface temperature falls as vegetation (NDVI) rises in both seasons and years (r {_sg(nd.max(), 3)} to "
                    f"{_sg(nd.min(), 3)}) and rises with built-up surfaces (NDBI, r {_sg(nb.min(), 3)} to {_sg(nb.max(), 3)}).",
        })
    return cards


def caveats(T) -> list[dict]:
    """How to read the results: the technical caveats, stated plainly (Method & limitations on the page and in the PDF)."""
    a, b = T.years[0], T.years[-1]
    bu, ag = T.built, T.cfg.class_name(3)
    tm = T.tm[(a, b)]
    fwd, rev = float(tm.loc[ag, bu]), float(tm.loc[bu, ag])
    acc = T.acc.set_index("year")
    sa, sb = float(T.u(a, "summer", CORE).uhi_intensity_c), float(T.u(b, "summer", CORE).uhi_intensity_c)
    out = [{
        "title": "Net, not gross, land-cover change",
        "text": f"Between {a} and {b}, {fwd:.1f} km² of cropland was mapped as built-up, but {rev:.1f} km² was mapped the other way. "
                "Built-up land rarely turns back into cropland: most of this reverse flow is confusion between bare harvested fields "
                f"(counted as built-up) and cropland. The headline figures therefore use the net change ({fwd - rev:.1f} km²), and "
                "change patches of a few km² are within classification noise.",
    }, {
        "title": "Agreement, not accuracy",
        "text": f"The land-cover maps agree with held-out reference labels for {acc.overall_agreement[a] * 100:.1f} % ({a}) and "
                f"{acc.overall_agreement[b] * 100:.1f} % ({b}) of test points (kappa {acc.kappa[a]:.3f} and {acc.kappa[b]:.3f}). "
                "These labels come from GLC-FCS30D and are restricted to pixels whose class did not change, which are easier to map, "
                "so the figures are optimistic. They are agreement with reference labels, not accuracy against ground truth; "
                "independent validation is still to be done.",
    }]
    if (sa < 0) != (sb < 0):
        out.append({
            "title": "The summer daytime result changes sign",
            "text": f"In April–June the urban core was {_sg(sa, 2)} °C relative to its rural ring in {a} (a cool island) and "
                    f"{_sg(sb, 2)} °C in {b} (a heat island). Both values are below 1 °C, and with one composite per season and year a "
                    "change this small cannot be separated from year-to-year weather, so it is not read as a warming trend. A daytime "
                    "cool island over dry, harvested farmland is known in pre-monsoon India (Shastri et al., 2017).",
        })
    out.append({
        "title": "Association, not cause",
        "text": "Correlations describe how surface temperature varies with vegetation and built-up surfaces across pixels; on their own "
                f"they do not show cause. Population and built-up area are compared at two time points ({a} and {b}) only.",
    })
    return out


# ----------------------------------------------------------------------------- export
def main() -> None:
    cfg = config_mod.load()
    years = sorted(int(y) for y in pd.read_csv(OUT / "tables" / "class_areas.csv").year.unique())
    T = report.Tables(cfg, CACHE, OUT, years)
    cross = report.cross_check(T)                       # stops here if any number disagrees with the rasters
    summary_md = (OUT / "results_summary.md").read_text(encoding="utf-8")
    F, LIM = findings(T), limitations(T)
    for s in F + [l["markdown"] for l in LIM]:
        if s not in summary_md:
            raise SystemExit("results_summary.md is older than the tables: run `run_pipeline.py --steps report` first.\n"
                             f"Not found in it: {s[:120]}…")
    flags = [{"level": lvl, "topic": topic, "message": msg} for lvl, topic, msg in checks.run(cfg, CACHE, OUT / "tables", T.years)]

    names = {"LT05": "Landsat 5 TM", "LE07": "Landsat 7 ETM+", "LC08": "Landsat 8", "LC09": "Landsat 9"}
    areas = [{"year": int(r.year), "class_code": int(r.class_code), "class": r["class"], "area_km2": float(r.area_km2),
              "percent": float(r.percent_of_classified)} for _, r in T.areas[T.areas.class_code > 0].iterrows()]
    net, transitions = [], []
    for a, b in combinations(T.years, 2):
        for c in cfg.classes:
            ka, kb = T.area(a, c.code), T.area(b, c.code)
            net.append({"from_year": a, "to_year": b, "class": c.name, "class_code": c.code, "from_km2": ka, "to_km2": kb,
                        "delta_km2": kb - ka, "delta_pp": T.area(b, c.code, "percent_of_classified") - T.area(a, c.code, "percent_of_classified"),
                        "delta_rel_pct": (kb / ka - 1) * 100 if ka else None})
        tm = T.tm[(a, b)]
        off = sorted(((float(tm.iat[i, j]), tm.index[i], tm.columns[j]) for i in range(len(tm)) for j in range(len(tm)) if i != j), reverse=True)
        moved = sum(v for v, _, _ in off)
        bu, ag = T.built, cfg.class_name(3)
        transitions.append({
            "from_year": a, "to_year": b, "total_changed_km2": moved,
            "top": [{"from": f, "to": t, "km2": v, "share": v / moved} for v, f, t in off[:3]],
            "into_built": [{"from": k, "km2": float(v)} for k, v in tm[bu].drop(bu).sort_values(ascending=False).items()],
            "cropland_to_built": {"gross_km2": float(tm.loc[ag, bu]), "reverse_km2": float(tm.loc[bu, ag]),
                                  "net_km2": float(tm.loc[ag, bu] - tm.loc[bu, ag])},
            "classes": list(tm.index), "matrix_km2": tm.to_numpy(float).round(3).tolist(),
        })
    pop = []
    if T.pop is not None:
        for _, r in T.pop.iterrows():
            pop.append({"epoch": int(r.epoch), "population": int(r.population), "ghsl_built_km2": float(r.ghsl_built_km2),
                        "projection": bool(r.projection_not_estimate),
                        "builtup_km2_this_study": None if pd.isna(r.builtup_km2_this_study) else float(r.builtup_km2_this_study)})
    lst_summary = [{"year": int(r.year), "season": r.season, "mean_land_c": float(r.mean_land_c), "valid_fraction": float(r.valid_fraction_of_study_area)}
                   for _, r in T.lsts.iterrows()]
    lst_class = [{"year": int(r.year), "season": r.season, "class": r["class"], "class_code": int(r.class_code), "mean_c": float(r.mean_c),
                  "n_pixels": int(r.n_pixels)} for _, r in T.lstc.iterrows()]

    def island(v: float) -> str:
        return "near zero" if abs(v) < report.NEAR_ZERO_C else ("heat island" if v > 0 else "cool island")
    uhi = [{"year": int(r.year), "season": r.season, "method": r.method, "primary": r.method == CORE, "uhi_c": float(r.uhi_intensity_c),
            "urban_mean_c": float(r.urban_mean_c), "rural_mean_c": float(r.rural_mean_c),
            "ring_outer_km": None if pd.isna(r.ring_outer_km) else float(r.ring_outer_km), "result": island(float(r.uhi_intensity_c))}
           for _, r in T.uhi.iterrows()]
    conv = [] if T.conv is None else [{"period": r.period, "season": r.season, "group": r.group, "area_km2": float(r.area_km2),
                                        "delta_lst_c": float(r.mean_delta_lst_c), "delta_z": float(r.mean_delta_z)}
                                       for _, r in T.conv[T.conv.n_pixels > 0].iterrows()]
    cor = [{"year": int(r.year), "season": r.season, "index": r["index"], "r": float(r.r), "p_thinned": float(r.p_thinned),
            "n_pixels": int(r.n_pixels), "n_thinned": int(r.n_thinned), "thin_spacing_m": int(r.thin_spacing_m)} for _, r in T.cor.iterrows()]
    acc = []
    for _, r in T.acc.iterrows():
        cm = T.cm[int(r.year)]
        pairs = sorted(((int(cm.iat[i, j] + cm.iat[j, i]), cm.index[i], cm.columns[j]) for i in range(len(cm)) for j in range(i + 1, len(cm))), reverse=True)
        acc.append({"year": int(r.year), "overall_agreement": float(r.overall_agreement), "kappa": float(r.kappa), "n_test": int(r.n_test_points),
                    "label": "agreement with reference labels", "most_confused": [{"a": a_, "b": b_, "n": n} for n, a_, b_ in pairs[:2]]})
    mask = [] if T.mask is None else [{k: (v.item() if hasattr(v, "item") else v) for k, v in r.items()} for _, r in T.mask.iterrows()]

    DEST.mkdir(parents=True, exist_ok=True)
    for old in DEST.glob("*.webp"):
        old.unlink()
    images: dict = {"lulc": {}, "lst_summer": {}, "lst_winter": {}, "change": {}, "uhi_zones": {}, "charts": {}}
    for y in T.years:
        images["lulc"][str(y)] = webp(OUT / "maps" / f"lulc_{y}.png", DEST / f"lulc_{y}.webp", 900)
        images["lst_summer"][str(y)] = webp(OUT / "maps" / f"lst_summer_{y}.png", DEST / f"lst_summer_{y}.webp", 900)
        images["lst_winter"][str(y)] = webp(OUT / "maps" / f"lst_winter_{y}.png", DEST / f"lst_winter_{y}.webp", 900)
        images["uhi_zones"][str(y)] = webp(OUT / "maps" / f"uhi_zones_{y}.png", DEST / f"uhi_zones_{y}.webp", 900)
    for a, b in combinations(T.years, 2):
        images["change"][f"{a}-{b}"] = webp(OUT / "maps" / f"change_{a}_{b}.png", DEST / f"change_{a}_{b}.webp", 900)
    for name in ("builtup_percent_by_year", "lulc_composition", "uhi_intensity_by_year", "lst_by_class_and_year", "population_vs_builtup",
                 "scatter_lst_indices_summer", "scatter_lst_indices_winter"):
        images["charts"][name] = webp(OUT / "charts" / f"{name}.png", DEST / f"{name}.webp", 1200)
    for p in sorted((OUT / "charts").glob("conversion_lst_change_*.png")):
        images["charts"][p.stem] = webp(p, DEST / f"{p.stem}.webp", 1200)

    sensors = {str(y): " + ".join(names[s] for s in T.meta[y]["sensors"]) for y in T.years}
    doc = {
        "id": CASE_ID, "kind": "static-case-study", "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pipeline_version": __version__, "thumbnail_url": cfg.raw["website"]["thumbnail_url"], "source": "analysis/outputs/tables (TerraTrace LULC + UHI pipeline); no live computation",
        "study": {
            "name": cfg.study["name"], "short_name": cfg.study["short_name"], "districts": cfg.study.get("district_labels", cfg.study["gaul_districts"]),
            "boundary_source": "FAO GAUL 2025, level 2", "area_km2": T.aoi_area["area_km2_geodesic"], "area_km2_grid": T.aoi_area["area_km2_grid"],
            "years": T.years, "sensors": sensors,
            "scenes": [{"year": int(r.year), "season": r.season, "scenes": int(r.scenes)} for _, r in T.scenes.iterrows()],
            "classes": [{"code": c.code, "name": c.name, "color": c.color} for c in cfg.classes],
            "method_summary": (f"Landsat Collection 2 Level-2 composites; {len(cfg.classes)}-class Random Forest ({cfg.rf['trees']} trees) in "
                               "Google Earth Engine at 30 m, trained on stable GLC-FCS30D labels; land surface temperature from the "
                               "Landsat thermal band (April–June primary, November–February secondary); UHI as urban core minus an "
                               "equal-area rural ring."),
        },
        "headlines": headlines(T), "caveats": caveats(T),
        "findings": F, "limitations": [{"title": l["title"], "text": l["text"]} for l in LIM], "flags": flags,
        "areas": areas, "net_change": net, "transitions": transitions, "population": pop,
        "lst_summary": lst_summary, "lst_per_class": lst_class, "uhi": uhi, "conversion": conv, "correlations": cor,
        "accuracy": acc,
        "masking": {"rule": (f"In every scene a pixel's land surface temperature is dropped when the USGS uncertainty (ST_QA) exceeds "
                             f"{cfg.max_st_uncertainty_k:g} K or its emissivity (ST_EMIS) is below {cfg.min_st_emissivity:.2f}, in addition "
                             "to the QA_PIXEL cloud, shadow and snow mask. It removes emissivity-database artefacts (blocky false hot "
                             "spots) that the cloud mask cannot see; reflectance and the land-cover maps are unaffected."),
                    "impact": mask},
        "images": images, "cross_checks": cross,
    }
    (DEST / "case-study.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    sizes = sorted(((p.stat().st_size, p.name) for p in DEST.iterdir()), reverse=True)
    print(f"wrote {DEST.relative_to(ROOT.parent).as_posix()} — {len(sizes)} files, {sum(s for s, _ in sizes) / 1e6:.2f} MB; largest: "
          + ", ".join(f"{n} {s / 1e3:.0f} KB" for s, n in sizes[:3]))
    print(f"cross-checks: {len(cross)} passed; findings/limitations verbatim in results_summary.md: {len(F)}/{len(LIM)}")


if __name__ == "__main__":
    main()
