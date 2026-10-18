"""Landsat Collection 2 Level-2: scale factors, cloud/shadow masking, harmonised band names, seasonal composites.

Steps applied to every scene before compositing:
  1. Keep Tier-1 scenes over the study area, in the season's dates, with scene CLOUD_COVER below the configured limit.
  2. Mask pixels flagged in QA_PIXEL as fill, dilated cloud, cirrus (Landsat 8/9 only), cloud, cloud shadow or snow,
     and pixels saturated in any band (QA_RADSAT ≠ 0).
  2b. For LST only: also mask pixels whose surface-temperature uncertainty (ST_QA × 0.01 K) exceeds the configured
     limit, or whose emissivity (ST_EMIS × 0.0001) is below a physical floor — this removes emissivity artefacts
     (bad ASTER GED values) that the cloud mask cannot see; some of them carry no uncertainty value (ST_QA = 0).
  3. Scale surface reflectance:  ρ = DN × 0.0000275 − 0.2          (unitless, 0–1)
     Scale surface temperature:  T = DN × 0.00341802 + 149.0 (K)  → °C = T − 273.15
  4. Rename sensor bands to common names so Landsat 5/7 (TM/ETM+) and 8/9 (OLI/TIRS) can be treated alike:
        blue green red nir swir1 swir2 lst
  5. Composite = per-pixel median of the clear observations in the season (median resists residual cloud and haze).
"""

from __future__ import annotations

from typing import Any

import ee

from .config import Config, YearSpec

COLLECTIONS = {
    "LT05": "LANDSAT/LT05/C02/T1_L2",
    "LE07": "LANDSAT/LE07/C02/T1_L2",
    "LC08": "LANDSAT/LC08/C02/T1_L2",
    "LC09": "LANDSAT/LC09/C02/T1_L2",
}
# Source band names in the order of COMMON. TM/ETM+ thermal = ST_B6; OLI/TIRS thermal = ST_B10.
_TM_ETM = ("SR_B1", "SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B7", "ST_B6")
_OLI = ("SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B6", "SR_B7", "ST_B10")
SOURCE_BANDS = {"LT05": _TM_ETM, "LE07": _TM_ETM, "LC08": _OLI, "LC09": _OLI}
OPTICAL = ("blue", "green", "red", "nir", "swir1", "swir2")
COMMON = OPTICAL + ("lst",)

# USGS Landsat Collection 2 Level-2 scale factors.
SR_SCALE, SR_OFFSET = 0.0000275, -0.2
ST_SCALE, ST_OFFSET = 0.00341802, 149.0
KELVIN_TO_CELSIUS = -273.15

# QA_PIXEL bits that make a pixel unusable (bit numbers from the USGS C2 L2 product guide).
QA_BITS_MASKED = {"fill": 0, "dilated_cloud": 1, "cirrus": 2, "cloud": 3, "cloud_shadow": 4, "snow": 5}
QA_MASK = sum(1 << b for b in QA_BITS_MASKED.values())

# Spectral features given to the Random Forest (order matters for reproducibility).
INDICES = ("ndvi", "ndbi", "mndwi")
ANNUAL_NDVI = ("ndvi_p10", "ndvi_p50", "ndvi_p90")
FEATURES = OPTICAL + INDICES + ANNUAL_NDVI


# ----------------------------------------------------------------------------- pure-Python mirrors (tested offline)
def reflectance(dn: float) -> float:
    """Collection 2 surface-reflectance DN → reflectance."""
    return dn * SR_SCALE + SR_OFFSET


def celsius(dn: float) -> float:
    """Collection 2 surface-temperature DN → °C."""
    return dn * ST_SCALE + ST_OFFSET + KELVIN_TO_CELSIUS


def is_clear(qa_pixel: int) -> bool:
    """True when none of the masked QA_PIXEL bits is set."""
    return (qa_pixel & QA_MASK) == 0


def season_ranges(cfg: Config, spec: YearSpec, season: str) -> list[tuple[str, str]]:
    """Date ranges [start, end) for a season, one per pooled calendar year.

    winter of 2025 (offsets −1/0) → 2024-11-01 … 2025-03-01; summer of 2005 with window 1 → three April–June ranges.
    """
    s = cfg.seasons[season]
    return [(f"{y + int(s['start_year_offset'])}-{s['start']}", f"{y + int(s['end_year_offset'])}-{s['end']}") for y in spec.years]


# ----------------------------------------------------------------------------- Earth Engine
ST_QA_SCALE = 0.01   # ST_QA DN → uncertainty in kelvin
ST_EMIS_SCALE = 0.0001   # ST_EMIS DN → emissivity


def _prepare(sensor: str, max_st_uncertainty_k: float, min_st_emissivity: float):
    """Mask, scale and rename one scene of `sensor`."""
    src = SOURCE_BANDS[sensor]

    def f(img):
        qa = img.select("QA_PIXEL")
        clear = qa.bitwiseAnd(QA_MASK).eq(0).And(img.select("QA_RADSAT").eq(0))
        sr = img.select(list(src[:6]), list(OPTICAL)).multiply(SR_SCALE).add(SR_OFFSET)
        lst = img.select([src[6]], ["lst"]).multiply(ST_SCALE).add(ST_OFFSET + KELVIN_TO_CELSIUS)
        lst = lst.updateMask(img.select("ST_QA").multiply(ST_QA_SCALE).lte(max_st_uncertainty_k)
                             .And(img.select("ST_EMIS").multiply(ST_EMIS_SCALE).gte(min_st_emissivity)))
        return (sr.addBands(lst).updateMask(clear)
                .copyProperties(img, ["system:time_start", "system:index", "CLOUD_COVER", "SPACECRAFT_ID"]))
    return f


def collection(cfg: Config, geom, spec: YearSpec, season: str):
    """All usable scenes of a study year's season, every sensor merged, already masked/scaled/renamed."""
    ranges = season_ranges(cfg, spec, season)
    date_filter = ee.Filter.Or(*[ee.Filter.date(a, b) for a, b in ranges])
    merged = None
    for sensor in spec.sensors:
        c = (ee.ImageCollection(COLLECTIONS[sensor]).filterBounds(geom).filter(date_filter)
             .filter(ee.Filter.lt("CLOUD_COVER", cfg.max_cloud_cover)).map(_prepare(sensor, cfg.max_st_uncertainty_k, cfg.min_st_emissivity)))
        merged = c if merged is None else merged.merge(c)
    return merged


def indices(img):
    """NDVI (vegetation), NDBI (built-up), MNDWI (water) from a composite with common band names."""
    return ee.Image.cat(
        img.normalizedDifference(["nir", "red"]).rename("ndvi"),
        img.normalizedDifference(["swir1", "nir"]).rename("ndbi"),
        img.normalizedDifference(["green", "swir1"]).rename("mndwi"),
    )


def scene_list(col) -> ee.Dictionary:
    """Scene count, ids and dates — written to the run manifest so every composite can be reproduced."""
    return ee.Dictionary({
        "count": col.size(),
        "ids": col.aggregate_array("system:index"),
        "dates": col.aggregate_array("system:time_start").map(lambda t: ee.Date(t).format("YYYY-MM-dd")),
    })


def composites(cfg: Config, geom, spec: YearSpec) -> dict[str, Any]:
    """Earth Engine images for one study year (nothing is computed until something asks for pixels or numbers).

    features      12 bands for the classifier: summer median reflectance (6), summer NDVI/NDBI/MNDWI,
                  and the 10th/50th/90th percentile of NDVI over the whole year (cropland is green in some season,
                  bare land never is — April–June alone cannot separate harvested fields from bare ground)
    lst_summer    median April–June land surface temperature (°C) — the primary UHI result
    lst_winter    median November–February land surface temperature (°C) — secondary, for season comparison
    ndvi/ndbi_*   index of the same season's median composite, for the LST correlations
    """
    summer = collection(cfg, geom, spec, "summer")
    winter = collection(cfg, geom, spec, "winter")
    annual = collection(cfg, geom, spec, "annual")

    s_med = summer.median()
    w_med = winter.median()
    s_idx = indices(s_med)
    w_idx = indices(w_med)
    annual_ndvi = (annual.map(lambda i: i.normalizedDifference(["nir", "red"]).rename("ndvi"))
                   .reduce(ee.Reducer.percentile([10, 50, 90])).rename(list(ANNUAL_NDVI)))
    features = s_med.select(list(OPTICAL)).addBands(s_idx).addBands(annual_ndvi).toFloat()
    return {
        "features": features,
        "lst_summer": summer.select("lst").median().rename("lst_summer").toFloat(),
        "lst_winter": winter.select("lst").median().rename("lst_winter").toFloat(),
        "ndvi_summer": s_idx.select("ndvi").rename("ndvi_summer").toFloat(),
        "ndbi_summer": s_idx.select("ndbi").rename("ndbi_summer").toFloat(),
        "ndvi_winter": w_idx.select("ndvi").rename("ndvi_winter").toFloat(),
        "ndbi_winter": w_idx.select("ndbi").rename("ndbi_winter").toFloat(),
        "scenes": ee.Dictionary({"summer": scene_list(summer), "winter": scene_list(winter), "annual": scene_list(annual)}),
    }
