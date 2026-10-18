"""Population and built-up surface from the Global Human Settlement Layer (GHSL, release P2023A).

GHS-POP gives residents per 100 m cell (Mollweide projection) for epochs 1975–2030 every 5 years; epochs from 2025 on
are model projections, not census-based estimates — they are labelled as such in every table and chart.
GHS-BUILT-S gives built-up surface (m²) per cell: an independent check of the built-up trend of our own classification.
Sums are taken in each image's native projection; a cell counts when its centre lies inside the study area.
"""

from __future__ import annotations

import ee
import pandas as pd

from .config import Config


def table(cfg: Config, geom) -> pd.DataFrame:
    p = cfg.population
    rows = {}
    for epoch in p["epochs"]:
        pop = ee.Image(f"{p['collection']}/{epoch}").select("population_count")
        built = ee.Image(f"{p['built_collection']}/{epoch}").select("built_surface")
        rows[str(epoch)] = ee.Dictionary({
            "population": pop.reduceRegion(ee.Reducer.sum(), geom, maxPixels=1e10).get("population_count"),
            "built_m2": built.reduceRegion(ee.Reducer.sum(), geom, maxPixels=1e10).get("built_surface"),
        })
    res = ee.Dictionary(rows).getInfo()
    out = pd.DataFrame([{
        "epoch": int(e),
        "population": round(v["population"]),
        "ghsl_built_km2": round(v["built_m2"] / 1e6, 2),
        "source": "GHSL GHS-POP / GHS-BUILT-S P2023A",
        "projection_not_estimate": int(e) >= int(p["projected_from"]),
    } for e, v in sorted(res.items())])
    return out
