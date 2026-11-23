"""TerraTrace LULC + Urban Heat Island pipeline — run end to end, or step by step.

    .venv\\Scripts\\python run_pipeline.py                         # all steps, all configured years
    .venv\\Scripts\\python run_pipeline.py --years 2015 2025       # only these years
    .venv\\Scripts\\python run_pipeline.py --steps stats figures report   # re-run local steps only (no Earth Engine)
    .venv\\Scripts\\python run_pipeline.py --force                 # ignore cached Earth Engine results

Steps (in order):
  boundary    create the study-area GeoJSON from FAO GAUL 2025 (skipped if the file exists — replace it freely)
  grid        fix the 30 m UTM grid and rasterise the study area                         [Earth Engine]
  ee          per year: composites, reference labels, sample, Random Forest, accuracy,
              then download LULC / LST / NDVI / NDBI rasters                              [Earth Engine]
  lst         re-download only the LST rasters of cached years (after an LST-masking change; LULC kept)  [Earth Engine]
              — skipped while config.toml [lst] enabled = false (then `ee` does not download LST either)
  population  GHSL population and built-up surface per epoch                             [Earth Engine]
  stats       class areas, transitions, LST per class, UHI (both methods), correlations,
              conversion analysis → CSV tables                                           [local]
  figures     maps and charts → PNG                                                      [local]
  validation  stratified validation points (KML + CSV) for manual checking               [local + 1 small EE call]
  report      sanity checks + results_summary.md                                         [local]

With [lst] enabled = false, stats / figures / report leave out every temperature and UHI result (the LST code and the LST
outputs already in outputs/ are kept).

Earth Engine results are cached in outputs/cache/; a cached step is skipped unless --force is given.
Earth Engine requests run one at a time (noncommercial quota).
"""

from __future__ import annotations

import argparse
import json
import logging
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from terratrace_analysis import __version__  # noqa: E402
from terratrace_analysis import config as config_mod  # noqa: E402

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "outputs"
CACHE = OUT / "cache"
STEPS = ["boundary", "grid", "ee", "lst", "population", "stats", "figures", "validation", "report"]
FLOAT_BANDS = ["lst_summer", "lst_winter", "ndvi_summer", "ndbi_summer", "ndvi_winter", "ndbi_winter"]

log = logging.getLogger("analysis")


# ----------------------------------------------------------------------------- helpers
def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, default=str), encoding="utf-8")


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def aoi_geometry(cfg):
    """Study area from the GeoJSON file (union of its features), as planar WGS84 polygons — the way GIS draws them."""
    import ee
    gj = read_json(cfg.boundary_path)
    feats = gj["features"] if gj.get("type") == "FeatureCollection" else [gj]
    geoms = [ee.Geometry(f["geometry"] if "geometry" in f else f, None, False) for f in feats]
    return ee.FeatureCollection([ee.Feature(g) for g in geoms]).geometry(1)


# ----------------------------------------------------------------------------- Earth Engine steps
def step_boundary(cfg, force: bool) -> None:
    import ee
    if cfg.boundary_path.exists() and not force:
        log.info("boundary: %s exists — kept", cfg.boundary_path.name)
        return
    s = cfg.study
    fc = (ee.FeatureCollection(s["gaul_collection"]).filter(ee.Filter.eq("GAUL0_NAME", s["gaul_country"]))
          .filter(ee.Filter.eq("GAUL1_NAME", s["gaul_state"])).filter(ee.Filter.inList("GAUL2_NAME", s["gaul_districts"])))
    # 10 m simplification keeps the file small; the boundary moves by at most 10 m (a third of a pixel).
    fc = fc.map(lambda f: ee.Feature(f.geometry().simplify(10), {"name": f.get("GAUL2_NAME"), "state": f.get("GAUL1_NAME")}))
    gj = fc.getInfo()
    names = sorted(f["properties"]["name"] for f in gj["features"])
    if names != sorted(s["gaul_districts"]):
        raise SystemExit(f"boundary: expected districts {s['gaul_districts']}, found {names}")
    out = {"type": "FeatureCollection", "name": s["short_name"],
           "source": f"{s['gaul_collection']} (FAO GAUL 2025), simplified 10 m; replace this file to change the study area",
           "features": [{"type": "Feature", "properties": f["properties"], "geometry": f["geometry"]} for f in gj["features"]]}
    write_json(cfg.boundary_path, out)
    log.info("boundary: wrote %s (%s)", cfg.boundary_path.name, ", ".join(names))


def step_grid(cfg, force: bool) -> None:
    import ee
    from terratrace_analysis import download
    if (CACHE / "grid.json").exists() and (CACHE / "aoi_mask.npy").exists() and not force:
        log.info("grid: cached")
        return
    geom = aoi_geometry(cfg)
    grid = download.make_grid(geom, cfg.crs, cfg.scale)
    CACHE.mkdir(parents=True, exist_ok=True)
    grid.save(CACHE / "grid.json")
    mask = download.fetch(ee.Image.constant(1).toByte().rename("aoi").clip(geom), grid, ["aoi"], nodata=0)["aoi"]
    np.save(CACHE / "aoi_mask.npy", mask.astype(np.uint8))
    # Study-area outline in grid coordinates, for maps.
    write_json(CACHE / "aoi_outline_utm.json", geom.transform(cfg.crs, 1).coordinates().getInfo())
    write_json(CACHE / "aoi_area.json", {"area_km2_geodesic": geom.area(1).getInfo() / 1e6,
                                         "area_km2_grid": float(mask.sum()) * cfg.scale**2 / 1e6})
    log.info("grid: %d × %d pixels, study area %.0f km²", grid.width, grid.height, mask.sum() * cfg.scale**2 / 1e6)


def step_ee(cfg, year: int, force: bool) -> None:
    import ee
    from terratrace_analysis import download, labels, landsat, lulc
    d = CACHE / str(year)
    if (d / "meta.json").exists() and not force:
        log.info("ee %d: cached", year)
        return
    d.mkdir(parents=True, exist_ok=True)
    spec = cfg.year(year)
    geom = aoi_geometry(cfg)
    grid = download.Grid.load(CACHE / "grid.json")
    t0 = time.monotonic()

    comp = landsat.composites(cfg, geom, spec)
    scenes = comp["scenes"].getInfo()
    log.info("ee %d: scenes summer=%d winter=%d annual=%d", year, scenes["summer"]["count"], scenes["winter"]["count"], scenes["annual"]["count"])

    label = labels.reference_label(cfg, geom, year)
    counts = lulc.label_counts(cfg, label, geom)
    log.info("ee %d: reference-label pixels per class %s", year, counts)

    seed = int(cfg.rf["seed"]) + year
    sample = lulc.draw_sample(cfg, comp["features"], label, geom, seed)
    sample = lulc.split(sample, float(cfg.rf["train_fraction"]), seed)
    sample.to_csv(d / "training_points.csv", index=False)
    log.info("ee %d: sample %d points (%s)", year, len(sample), sample.groupby("label").size().to_dict())

    clf = lulc.classifier(cfg, sample[sample.set == "train"])
    acc = lulc.assess(cfg, clf, sample[sample.set == "test"])
    log.info("ee %d: agreement with reference labels OA=%.3f kappa=%.3f", year, acc["overall_accuracy"], acc["kappa"])

    lulc_img = comp["features"].classify(clf).rename("lulc").toByte().clip(geom)
    np.save(d / "lulc.npy", download.fetch(lulc_img, grid, ["lulc"], nodata=0)["lulc"].astype(np.uint8))
    log.info("ee %d: LULC raster downloaded", year)
    bands = FLOAT_BANDS if cfg.lst_enabled else [b for b in FLOAT_BANDS if not b.startswith("lst_")]
    stack = ee.Image.cat([comp[b] for b in bands]).clip(geom)
    for b, a in download.fetch(stack, grid, bands).items():
        np.save(d / f"{b}.npy", a)
    log.info("ee %d: %s rasters downloaded", year, "LST / NDVI / NDBI" if cfg.lst_enabled else "NDVI / NDBI (LST switched off)")

    write_json(d / "meta.json", {
        "year": year, "sensors": list(spec.sensors), "pooled_years": spec.years, "note": spec.note,
        "season_ranges": {s: landsat.season_ranges(cfg, spec, s) for s in ("summer", "winter", "annual")},
        "scenes": scenes, "label_rule": labels.describe(cfg, year), "label_pixels": counts,
        "sample_seed": seed, "accuracy": acc, "features": list(landsat.FEATURES),
        "rf": dict(cfg.rf), "elapsed_s": round(time.monotonic() - t0, 1),
    })
    log.info("ee %d: done in %.0f s", year, time.monotonic() - t0)


def step_lst(cfg, year: int) -> None:
    """Re-fetch only the LST rasters (summer, winter) for a year whose LULC is cached — the classification does not
    use thermal data, so an LST-masking change never requires reclassifying."""
    import ee
    from terratrace_analysis import download, landsat
    d = CACHE / str(year)
    meta = read_json(d / "meta.json")
    comp = landsat.composites(cfg, aoi_geometry(cfg), cfg.year(year))
    grid = download.Grid.load(CACHE / "grid.json")
    bands = ["lst_summer", "lst_winter"]
    for b, a in download.fetch(ee.Image.cat([comp[b] for b in bands]).clip(aoi_geometry(cfg)), grid, bands).items():
        np.save(d / f"{b}.npy", a)
    meta["lst_mask"] = {"max_st_uncertainty_k": cfg.max_st_uncertainty_k, "min_st_emissivity": cfg.min_st_emissivity, "refetched_utc": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    write_json(d / "meta.json", meta)
    log.info("lst %d: LST rasters re-downloaded (ST_QA ≤ %.1f K, ST_EMIS ≥ %.2f)", year, cfg.max_st_uncertainty_k, cfg.min_st_emissivity)


def step_population(cfg, force: bool) -> None:
    from terratrace_analysis import population
    path = CACHE / "population.csv"
    if path.exists() and not force:
        log.info("population: cached")
        return
    population.table(cfg, aoi_geometry(cfg)).to_csv(path, index=False)
    log.info("population: %s", path.name)


# ----------------------------------------------------------------------------- local steps
def step_stats(cfg, years: list[int]) -> None:
    from terratrace_analysis import stats
    stats.run(cfg, CACHE, OUT / "tables", years)


def step_figures(cfg, years: list[int]) -> None:
    from terratrace_analysis import charts, maps
    maps.run(cfg, CACHE, OUT / "tables", OUT / "maps", years)
    charts.run(cfg, CACHE, OUT / "tables", OUT / "charts", years)


def step_validation(cfg, years: list[int]) -> None:
    from terratrace_analysis import validation
    validation.run(cfg, CACHE, OUT / "validation", years)


def step_report(cfg, years: list[int]) -> None:
    from terratrace_analysis import report
    report.run(cfg, CACHE, OUT, years)


def manifest(cfg, years: list[int], steps: list[str]) -> None:
    import ee
    import matplotlib
    import pandas
    import scipy
    write_json(OUT / "run_manifest.json", {
        "pipeline_version": __version__, "run_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "years": years, "steps": steps, "config_file": cfg.path.name, "config": cfg.raw,
        "software": {"python": platform.python_version(), "earthengine-api": ee.__version__, "numpy": np.__version__,
                     "pandas": pandas.__version__, "scipy": scipy.__version__, "matplotlib": matplotlib.__version__},
        "per_year_cache_meta": {y: f"outputs/cache/{y}/meta.json" for y in years},
    })


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--years", type=int, nargs="+", help="study years (default: all in config.toml)")
    ap.add_argument("--steps", nargs="+", choices=STEPS, default=STEPS)
    ap.add_argument("--force", action="store_true", help="recompute cached Earth Engine steps")
    ap.add_argument("--config", type=Path, help="alternative config file")
    a = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("googleapiclient").setLevel(logging.WARNING)
    cfg = config_mod.load(a.config)
    years = sorted(a.years or [s.year for s in cfg.years])
    for y in years:
        cfg.year(y)   # fails early on an unknown year

    if any(s in a.steps for s in ("boundary", "grid", "ee", "lst", "population", "validation")):
        from terratrace_analysis import ee_auth
        log.info("Earth Engine project: %s", ee_auth.initialize())
    if "boundary" in a.steps:
        step_boundary(cfg, a.force)
    if "grid" in a.steps:
        step_grid(cfg, a.force)
    if "ee" in a.steps:
        for y in years:
            step_ee(cfg, y, a.force)
    if "lst" in a.steps:
        if not cfg.lst_enabled:
            log.info("lst: switched off in config.toml [lst] enabled = false — skipped")
        else:
            for y in years:
                step_lst(cfg, y)
    if "population" in a.steps:
        step_population(cfg, a.force)
    if "stats" in a.steps:
        step_stats(cfg, years)
    if "figures" in a.steps:
        step_figures(cfg, years)
    if "validation" in a.steps:
        step_validation(cfg, years)
    if "report" in a.steps:
        step_report(cfg, years)
    manifest(cfg, years, a.steps)
    log.info("finished: %s", ", ".join(a.steps))


if __name__ == "__main__":
    main()
