"""Reference training labels: temporally stable GLC-FCS30D pixels that agree with an independent product.

Why this rule (to describe in the paper's methods):
  * GLC-FCS30D (Zhang et al., 2024, Earth System Science Data) is a global annual 30 m land-cover map for 2000–2022,
    the same resolution as Landsat, so it can give labels for 2005 and 2015 where no 10 m product exists.
  * It is itself a classification with errors. To keep only pixels that are very likely correct we require
      (a) temporal stability — the same (re-mapped) class in every year from y−2 to y+2 (clipped to 2000–2022), and
      (b) agreement — the same class in each independent product configured for that year
          (ESA WorldCover 2021 and Dynamic World 2025 for 2025; Dynamic World 2016 for 2015; none exists for 2005).
  * Accuracy measured on held-out pixels of these labels is therefore AGREEMENT WITH REFERENCE LABELS,
    not accuracy against ground truth. Stable pixels are also easier than changing ones, so it is an optimistic figure.
"""

from __future__ import annotations

from typing import Any

import ee

from .config import Config, class_mapping

WORLDCOVER = "ESA/WorldCover/v200"
DYNAMIC_WORLD = "GOOGLE/DYNAMICWORLD/V1"


def remap(img, mapping: dict[int, list[int]]):
    """Source class codes → our class codes. Codes not in the mapping become masked (never a label)."""
    src: list[int] = []
    dst: list[int] = []
    for ours, theirs in mapping.items():
        src += theirs
        dst += [ours] * len(theirs)
    return img.remap(src, dst).rename("label")


def glc_years(cfg: Config, year: int) -> tuple[int, list[int]]:
    """(target GLC year, years that must agree). After 2022 the last GLC year stands in for the target."""
    lab = cfg.labels
    first, last, k = int(lab["glc_first_year"]), int(lab["glc_last_year"]), int(lab["stable_years"])
    target = min(max(year, first), last)
    return target, [y for y in range(target - k, target + k + 1) if first <= y <= last]


def glc_band(cfg: Config, year: int) -> str:
    return f"b{year - int(cfg.labels['glc_first_year']) + 1}"


def glc_stable(cfg: Config, geom, year: int):
    """GLC-FCS30D class of the target year, kept only where every year in the stability window has that class."""
    mosaic = ee.ImageCollection(cfg.labels["glc_collection"]).filterBounds(geom).mosaic()
    mapping = class_mapping(cfg.labels["glc_map"])
    target, years = glc_years(cfg, year)
    stack = ee.Image.cat([remap(mosaic.select(glc_band(cfg, y)), mapping).rename(f"y{y}") for y in years])
    stable = stack.reduce(ee.Reducer.count()).eq(len(years)).And(stack.reduce(ee.Reducer.countDistinct()).eq(1))
    return remap(mosaic.select(glc_band(cfg, target)), mapping).updateMask(stable)


def worldcover(cfg: Config):
    return remap(ee.ImageCollection(WORLDCOVER).first().select("Map"), class_mapping(cfg.labels["worldcover_map"]))


def dynamic_world(cfg: Config, geom, year: int):
    """Most frequent Dynamic World label of the calendar year, re-mapped to our classes."""
    dw = (ee.ImageCollection(DYNAMIC_WORLD).filterBounds(geom)
          .filterDate(f"{year}-01-01", f"{year + 1}-01-01").select("label").mode())
    return remap(dw, class_mapping(cfg.labels["dynamic_world_map"]))


def agreement_products(cfg: Config, year: int) -> list[dict[str, Any]]:
    return list(cfg.labels.get("agreement", {}).get(str(year), []))


def reference_label(cfg: Config, geom, year: int):
    """The training-label image for a study year: band 'label' (1–5), masked wherever the rule is not met."""
    label = glc_stable(cfg, geom, year)
    for p in agreement_products(cfg, year):
        other = worldcover(cfg) if p["product"] == "worldcover" else dynamic_world(cfg, geom, int(p["year"]))
        label = label.updateMask(label.eq(other))   # `other` masked (unmapped) → excluded as well
    return label.toByte()


def describe(cfg: Config, year: int) -> str:
    target, years = glc_years(cfg, year)
    parts = [f"GLC-FCS30D {target} class, unchanged in every year {years[0]}–{years[-1]}"]
    for p in agreement_products(cfg, year):
        parts.append("agreeing with ESA WorldCover 2021" if p["product"] == "worldcover"
                     else f"agreeing with the Dynamic World {p['year']} annual mode")
    if not agreement_products(cfg, year):
        parts.append("(no independent product exists for this year, so stability is the only filter)")
    return ", ".join(parts)
