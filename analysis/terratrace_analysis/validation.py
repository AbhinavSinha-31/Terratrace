"""Stratified random validation points for MANUAL checking (Olofsson et al., 2014 good practice).

For each year: `points_per_class` random pixels of each MAPPED class (stratified by the map, seeded).
Outputs in outputs/validation/:
  validation_points_<year>.kml   open in Google Earth Pro, set the historical-imagery slider to that year,
                                 and record the class you see at each point — the KML is BLIND (no map class shown)
  validation_sheet.csv           one row per point: id, year, lon, lat, interpreted_class (empty — fill in), notes
  validation_key.csv             id → map class. Keep it closed while interpreting; join afterwards to get true accuracy.
Accuracy from these points must then be computed with stratum (class-area) weights — see the README.
"""

from __future__ import annotations

import logging
from pathlib import Path
from xml.sax.saxutils import escape

import ee
import numpy as np
import pandas as pd

from .config import Config
from .download import Grid
from .stats import load_year

log = logging.getLogger("analysis.validation")


def sample_pixels(lulc: np.ndarray, aoi: np.ndarray, codes: list[int], n: int, seed: int) -> list[tuple[int, int, int]]:
    """(row, col, class) of up to n random pixels per mapped class inside the study area."""
    rng = np.random.default_rng(seed)
    out = []
    for c in codes:
        rows, cols = np.nonzero(aoi & (lulc == c))
        if rows.size == 0:
            continue
        pick = rng.choice(rows.size, size=min(n, rows.size), replace=False)
        out += [(int(rows[i]), int(cols[i]), c) for i in sorted(pick)]
    return out


def to_lonlat(grid: Grid, pix: list[tuple[int, int, int]]) -> list[tuple[float, float]]:
    """Pixel centres (UTM) → lon/lat via Earth Engine's projection library (one request)."""
    xy = [[grid.x0 + (c + 0.5) * grid.scale, grid.y0 - (r + 0.5) * grid.scale] for r, c, _ in pix]
    coords = ee.Geometry.MultiPoint(xy, ee.Projection(grid.crs)).transform("EPSG:4326", 0.001).coordinates().getInfo()
    return [(float(lon), float(lat)) for lon, lat in coords]


def kml(cfg: Config, year: int, rows: pd.DataFrame) -> str:
    classes = " / ".join(c.name for c in cfg.classes)
    marks = "\n".join(
        f"  <Placemark><name>{r.id}</name><description>{escape(f'Interpret for {year}. Choose one: {classes}.')}</description>"
        f"<Point><coordinates>{r.lon:.7f},{r.lat:.7f},0</coordinates></Point></Placemark>"
        for r in rows.itertuples())
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n'
            f"  <name>{escape(cfg.study['short_name'])} validation points {year}</name>\n{marks}\n</Document></kml>\n")


def run(cfg: Config, cache: Path, out: Path, years: list[int]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    grid = Grid.load(cache / "grid.json")
    aoi = np.load(cache / "aoi_mask.npy").astype(bool)
    n, seed = int(cfg.validation["points_per_class"]), int(cfg.validation["seed"])
    sheet, key = [], []
    for y in [y for y in years if (cache / str(y) / "meta.json").exists()]:
        pix = sample_pixels(load_year(cache, y)["lulc"], aoi, cfg.class_codes, n, seed + y)
        ll = to_lonlat(grid, pix)
        order = np.random.default_rng(seed + 1000 + y).permutation(len(pix))   # shuffle so classes are not grouped
        rows = []
        for k, i in enumerate(order, 1):
            pid = f"V{y}-{k:04d}"
            rows.append({"id": pid, "year": y, "lon": ll[i][0], "lat": ll[i][1], "interpreted_class": "", "notes": ""})
            key.append({"id": pid, "year": y, "map_class": cfg.class_name(pix[i][2]), "map_code": pix[i][2]})
        df = pd.DataFrame(rows)
        (out / f"validation_points_{y}.kml").write_text(kml(cfg, y, df), encoding="utf-8")
        sheet.append(df)
    pd.concat(sheet).to_csv(out / "validation_sheet.csv", index=False)
    pd.DataFrame(key).to_csv(out / "validation_key.csv", index=False)
    log.info("validation: %d points written to %s", len(key), out)
