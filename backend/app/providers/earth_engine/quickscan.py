"""Quick scan: surface temperature, land cover and above-ground tree biomass carbon for any area (docs/QUICKSCAN_PLAN.md).

ONE Earth Engine request per scan (`measure`). It returns RAW sums only; services/quickscan.py interprets them.

  Land surface temperature  Landsat 8/9 Collection 2 Level-2, Tier 1. The scene filter and the per-scene masking
                            (QA_PIXEL cloud/shadow/snow, QA_RADSAT, ST_QA ≤ 5 K, ST_EMIS ≥ 0.90, scale factors) are the
                            research pipeline's own code — analysis/terratrace_analysis/landsat.py `scenes`/`prepare` —
                            with the thresholds in analysis/config.toml [scenes]: imported, never copied. Composite = per-
                            pixel median of the clear scenes in the season. Fewer than MIN_SCENES scenes → not computed.
  Land cover                Dynamic World V1, annual composite of the scan year: mean probability per class, top class
                            wins; aggregated from 10 m to 30 m by MODE for the statistics. A 10 m pixel whose top mean
                            probability is below LOW_CONFIDENCE counts as low confidence.
  Biomass carbon            ESA CCI Above-Ground Biomass v6.0, year CCI_YEAR, 100 m: `agb` and `agb_sd` (Mg/ha of oven-dry
                            woody biomass of living trees). Carbon = biomass × CARBON_FRACTION (done in the service).
  Cross-check               ESA WorldCover v200 (2021): share of the area where its class (mapped to Dynamic World's
                            classes) equals the Dynamic World class.

Every branch that would composite an empty collection is skipped server-side (`ee.Algorithms.If`) and comes back null,
so a missing dataset is reported as unavailable — never computed from an empty composite, never a zero.
"""

from __future__ import annotations

import contextlib
import functools
import hashlib
import os
import sys
import threading
from pathlib import Path
from typing import Any

from .provider import DW, DW_LABELS, TILE_SCALE, WORLDCOVER, EarthEngineError, EETimer, _ee, provider

# The research pipeline lives next to the backend in the repository (override with TT_ANALYSIS_DIR on a host that
# deploys it elsewhere). Without it the quick scan is unavailable — it is never re-implemented here.
ANALYSIS_DIR = Path(os.environ.get("TT_ANALYSIS_DIR") or Path(__file__).resolve().parents[4] / "analysis")

SENSORS = ("LC08", "LC09")            # Landsat 8 OLI/TIRS (2013–) and 9 (late 2021–); no SLC-off Landsat 7
MIN_SCENES = 5                        # usable scenes needed for an LST composite
SCALE = 30                            # m, statistics grid (Landsat; Dynamic World aggregated by mode)
LOW_CONFIDENCE = 0.5                  # Dynamic World top mean probability below this = low confidence
CCI_AGB = "ESA/CCI/Above_Ground_Biomass/V6_0"
CCI_YEAR = 2022                       # latest year of CCI Biomass v6.0 (2007, 2010, 2015–2022)
CCI_SCALE = 100                       # m, native CCI resolution
CARBON_FRACTION = 0.47                # IPCC (2006) default carbon fraction of dry woody biomass
WORLDCOVER_YEAR = 2021
# ESA WorldCover v200 class → Dynamic World class index (DW_LABELS order), for the cross-check only.
WORLDCOVER_TO_DW = {10: 1, 20: 5, 30: 2, 40: 4, 50: 6, 60: 7, 70: 8, 80: 0, 90: 3, 95: 1, 100: 7}

# Seasons: [start, end) of the scan year; "djf" is December of the previous year to February.
SEASONS: dict[str, tuple[str, str, int]] = {
    "all": ("01-01", "01-01", 1), "mam": ("03-01", "06-01", 0), "jja": ("06-01", "09-01", 0),
    "son": ("09-01", "12-01", 0), "djf": ("12-01", "03-01", 0),
}
SEASON_LABELS = {"all": "all months", "mam": "March–May", "jja": "June–August", "son": "September–November",
                 "djf": "December–February"}

# Map layers (served through /api/tiles; built from the SAME images as the measurement).
LAYERS = ("lst", "landcover", "carbon")
# Dynamic World's published class colours, in DW_LABELS order.
DW_PALETTE = ["419bdf", "397d49", "88b053", "7a87c6", "e49635", "dfc35a", "c4281b", "a59b8f", "b39fe1"]
# Temperature: inferno, stretched over the area's own 2nd–98th percentile (from the stored scan).
LST_PALETTE = ["000004", "1b0c41", "4a0c6b", "781c6d", "a52c60", "cf4446", "ed6925", "fb9b06", "f7d13d", "fcffa4"]
# Biomass carbon density: one fixed range for every area, so maps are comparable.
CARBON_RANGE_T_PER_HA = (0.0, 150.0)
CARBON_PALETTE = ["f7fcf5", "c7e9c0", "74c476", "238b45", "00441b"]


_deadline_lock = threading.Lock()


@contextlib.contextmanager
def request_deadline(seconds: float):
    """Raise Earth Engine's request deadline to at least `seconds` for the duration of one quick scan, then restore it.
    The client keeps ONE global deadline, so requests running at the same moment also get the longer deadline — only
    ever longer, never shorter. Quick scans run one at a time, so only one of them changes it."""
    ee = _ee()
    from ee import _state   # noqa: PLC0415 — the client's own state, read to restore the previous deadline
    with _deadline_lock:
        before = float(_state.get_state().deadline_ms or 0)
        wanted = seconds * 1000.0
        if before == 0 or wanted <= before:      # 0 = no limit at all; never shorten an existing deadline
            yield
            return
        ee.data.setDeadline(wanted)
        try:
            yield
        finally:
            ee.data.setDeadline(before)


def season_range(year: int, season: str) -> tuple[str, str]:
    """Date range [start, end) of a season of a scan year."""
    start, end, end_offset = SEASONS[season]
    if season == "djf":
        return f"{year - 1}-{start}", f"{year}-{end}"
    return f"{year}-{start}", f"{year + end_offset}-{end}"


@functools.lru_cache(maxsize=1)
def pipeline() -> tuple[Any, Any]:
    """(landsat module, pipeline config) from analysis/ — the quick scan's LST code and thresholds."""
    if not (ANALYSIS_DIR / "terratrace_analysis" / "landsat.py").exists():
        raise EarthEngineError("quickscan_unavailable", "The research pipeline (analysis/) is not installed on this server.")
    if str(ANALYSIS_DIR) not in sys.path:
        sys.path.insert(0, str(ANALYSIS_DIR))
    from terratrace_analysis import config as pipeline_config, landsat   # noqa: PLC0415 — optional, imported on demand
    return landsat, pipeline_config.load()


def method_parameters() -> dict[str, Any]:
    """Everything that changes a quick-scan number (its hash is the method version: a change invalidates stored scans)."""
    landsat, cfg = pipeline()
    return {
        "landsat": {"collections": [landsat.COLLECTIONS[s] for s in SENSORS], "qa_mask": landsat.QA_MASK,
                    "st_scale": landsat.ST_SCALE, "st_offset": landsat.ST_OFFSET, "max_cloud_cover": cfg.max_cloud_cover,
                    "max_st_uncertainty_k": cfg.max_st_uncertainty_k, "min_st_emissivity": cfg.min_st_emissivity,
                    "min_scenes": MIN_SCENES, "composite": "median"},
        "dynamic_world": {"id": DW, "composite": "annual mean probability, top class", "aggregation": f"mode to {SCALE} m",
                          "low_confidence": LOW_CONFIDENCE},
        "carbon": {"id": CCI_AGB, "year": CCI_YEAR, "carbon_fraction": CARBON_FRACTION, "scale": CCI_SCALE},
        "worldcover": {"id": WORLDCOVER, "map": WORLDCOVER_TO_DW},
        "scale": SCALE, "seasons": SEASONS,
    }


def method_version(extra: dict[str, Any] | None = None) -> str:
    blob = repr(sorted({**method_parameters(), **(extra or {})}.items()))
    return "qs-1-" + hashlib.sha256(blob.encode()).hexdigest()[:8]


def _lst(ee, landsat, cfg, geom, year: int, season: str):
    """(scenes, LST composite): the research pipeline's scenes and masking; median of the season's clear scenes. With
    fewer than MIN_SCENES scenes the composite is an empty (fully masked) image — never a composite of too few scenes."""
    scenes = landsat.scenes(cfg, geom, SENSORS, [season_range(year, season)])
    lst = ee.Image(ee.Algorithms.If(scenes.size().gte(MIN_SCENES), scenes.select("lst").median(),
                                    ee.Image.constant(0).updateMask(0))).rename("lst")
    return scenes, lst


def _dynamic_world(ee, geom, year: int):
    """(collection, native 10 m projection, mean probabilities, top class at 10 m) of the scan year."""
    dw = ee.ImageCollection(DW).filterBounds(geom).filterDate(f"{year}-01-01", f"{year + 1}-01-01")
    native = ee.Image(dw.first()).projection()
    probs = dw.select(DW_LABELS).mean().setDefaultProjection(native)
    top = probs.toArray().arrayArgmax().arrayGet([0]).int().setDefaultProjection(native).rename("label")
    return dw, native, probs, top


def _cci(ee):
    """(collection, image) of ESA CCI biomass for CCI_YEAR, mosaicked with its own projection."""
    col = ee.ImageCollection(CCI_AGB).filterDate(f"{CCI_YEAR}-01-01", f"{CCI_YEAR + 1}-01-01")
    return col, col.mosaic().setDefaultProjection(ee.Image(col.first()).projection())


def measure(geometry: dict[str, Any], year: int, season: str) -> dict[str, Any]:
    """RAW quick-scan measurements over an area — one Earth Engine request (services/quickscan.py interprets them)."""
    landsat, cfg = pipeline()
    provider.initialize()
    ee = _ee()
    geom = ee.Geometry(geometry)
    area = ee.Image.pixelArea().divide(1e4).rename("area_ha")

    scenes, lst = _lst(ee, landsat, cfg, geom, year, season)
    n_scenes = scenes.size()

    # Dynamic World: annual mean probability, top class, mode to 30 m.
    dw, native, probs, top = _dynamic_world(ee, geom, year)
    n_dw = dw.size()
    grid = native.atScale(SCALE)
    label = top.reduceResolution(ee.Reducer.mode(), maxPixels=64).reproject(grid).rename("label")
    low = (probs.reduce(ee.Reducer.max()).lt(LOW_CONFIDENCE).setDefaultProjection(native)
           .reduceResolution(ee.Reducer.mean(), maxPixels=64).reproject(grid))   # share of low-confidence 10 m pixels

    rr = dict(geometry=geom, maxPixels=1e10, tileScale=TILE_SCALE)
    by_class = ee.Image.cat([
        area, low.multiply(area).rename("low_ha"),
        area.updateMask(lst.mask()).unmask(0).rename("lst_ha"),           # area with a valid LST
        lst.multiply(area).unmask(0).rename("lst_x_ha"),                  # LST × area (area-weighted mean = Σ / lst_ha)
        label,
    ]).reduceRegion(ee.Reducer.sum().repeat(4).group(groupField=4, groupName="class"), crs=native, scale=SCALE, **rr)

    land = ee.Image(ee.Algorithms.If(n_dw.gt(0), label.neq(0), ee.Image.constant(1)))   # water excluded where known
    lst_stats = (lst.updateMask(land).reduceRegion(
        ee.Reducer.mean().combine(ee.Reducer.percentile([2, 50, 98]), "", True).combine(ee.Reducer.count(), "", True),
        scale=SCALE, **rr)
        .combine(area.updateMask(lst.mask()).rename("valid_ha").reduceRegion(ee.Reducer.sum(), scale=SCALE, **rr)))

    # ESA CCI biomass.
    cci_col, cci = _cci(ee)
    n_cci = cci_col.size()
    agb, sd = cci.select("agb"), cci.select("agb_sd")
    carbon = ee.Image.cat([
        area, area.updateMask(agb.mask()).unmask(0).rename("covered_ha"),
        agb.multiply(area).unmask(0).rename("agb_x_ha"), sd.multiply(area).unmask(0).rename("sd_x_ha"),
    ]).reduceRegion(ee.Reducer.sum(), scale=CCI_SCALE, **rr)

    # WorldCover 2021 cross-check (classes mapped to Dynamic World's).
    wc = ee.ImageCollection(WORLDCOVER).first().select("Map")
    wc_dw = wc.remap(list(WORLDCOVER_TO_DW), list(WORLDCOVER_TO_DW.values())).reproject(grid)
    compared = label.mask().And(wc_dw.mask())
    worldcover = ee.Image.cat([area.updateMask(compared).unmask(0).rename("compared_ha"),
                               area.updateMask(compared.And(label.eq(wc_dw))).unmask(0).rename("agree_ha")]
                              ).reduceRegion(ee.Reducer.sum(), crs=native, scale=SCALE, **rr)

    req = ee.Dictionary({
        "counts": ee.Dictionary({
            "landsat_scenes": n_scenes, "landsat_by_spacecraft": scenes.aggregate_histogram("SPACECRAFT_ID"),
            "landsat_first_ms": scenes.aggregate_min("system:time_start"), "landsat_last_ms": scenes.aggregate_max("system:time_start"),
            "dw_images": n_dw, "dw_first_ms": dw.aggregate_min("system:time_start"),
            "dw_last_ms": dw.aggregate_max("system:time_start"), "cci_images": n_cci,
        }),
        "aoi": area.reduceRegion(ee.Reducer.sum(), scale=SCALE, **rr),
        "classes": ee.Algorithms.If(n_dw.gt(0), by_class, None),
        "lst": ee.Algorithms.If(n_scenes.gte(MIN_SCENES), lst_stats, None),
        "carbon": ee.Algorithms.If(n_cci.gt(0), carbon, None),
        "worldcover": ee.Algorithms.If(n_dw.gt(0), worldcover, None),
    })
    with EETimer("quickscan")("quick_scan [getInfo]"):
        return req.getInfo()


# ----------------------------------------------------------------------------- map layers
def layer_image(layer: str, geometry: dict[str, Any], year: int, season: str, lst_range: tuple[float, float] | None = None):
    """Styled map layer, clipped to the area — built by the same functions as the measurement."""
    landsat, cfg = pipeline()
    ee = _ee()
    geom = ee.Geometry(geometry)
    if layer == "lst":
        if lst_range is None:
            raise EarthEngineError("unknown_layer", "The temperature layer needs the stored scan's colour range.")
        _scenes, lst = _lst(ee, landsat, cfg, geom, year, season)
        img = lst.visualize(min=lst_range[0], max=lst_range[1], palette=LST_PALETTE)
    elif layer == "landcover":
        _dw, _native, _probs, top = _dynamic_world(ee, geom, year)
        img = top.visualize(min=0, max=len(DW_PALETTE) - 1, palette=DW_PALETTE)
    elif layer == "carbon":
        _col, cci = _cci(ee)
        img = cci.select("agb").multiply(CARBON_FRACTION).visualize(
            min=CARBON_RANGE_T_PER_HA[0], max=CARBON_RANGE_T_PER_HA[1], palette=CARBON_PALETTE)
    else:
        raise EarthEngineError("unknown_layer", f"Unknown quick-scan layer {layer!r}.")
    return img.clip(geom)


def mapid_key(aid: str, layer: str, year: int, season: str, lst_range: tuple[float, float] | None = None) -> tuple:
    return (aid, f"qs:{layer}:{season}:{lst_range}", year)


def tile_url(aid: str, layer: str, year: int, season: str, geometry: dict[str, Any],
             lst_range: tuple[float, float] | None = None) -> str:
    """Tile template of a quick-scan layer (map IDs cached; one build per layer at a time)."""
    if layer not in LAYERS:
        raise EarthEngineError("unknown_layer", f"Unknown quick-scan layer {layer!r}.")
    key = mapid_key(aid, layer, year, season, lst_range)
    cached = provider.cached_mapid(key)
    if cached:
        return cached
    with provider.mapid_lock(key):
        cached = provider.cached_mapid(key)
        if cached:
            return cached
        provider.initialize()
        url = _ee().data.getMapId({"image": layer_image(layer, geometry, year, season, lst_range)})["tile_fetcher"].url_format
        provider.store_mapid(key, url)
        return url


# ----------------------------------------------------------------------------- carbon over time (ESA CCI epochs)
# Every epoch of CCI Biomass v6.0 (checked in the catalog 2026-11-17). The quick scan itself uses CCI_YEAR only.
CCI_YEARS = (2007, 2010, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022)


def carbon_series(geometry: dict[str, Any]) -> dict[str, Any]:
    """RAW per-epoch sums of ESA CCI above-ground biomass over an area — ONE Earth Engine request at the native 100 m:
    {year: {area_ha, covered_ha, agb_x_ha, sd_x_ha} | None}. services/carbon_series.py turns them into carbon."""
    provider.initialize()
    ee = _ee()
    geom = ee.Geometry(geometry)
    area = ee.Image.pixelArea().divide(1e4).rename("area_ha")
    col = ee.ImageCollection(CCI_AGB)
    rr = dict(geometry=geom, scale=CCI_SCALE, maxPixels=1e10, tileScale=TILE_SCALE)
    out = {}
    for y in CCI_YEARS:
        yc = col.filterDate(f"{y}-01-01", f"{y + 1}-01-01")
        img = yc.mosaic().setDefaultProjection(ee.Image(col.first()).projection())
        agb, sd = img.select("agb"), img.select("agb_sd")
        sums = ee.Image.cat([area, area.updateMask(agb.mask()).unmask(0).rename("covered_ha"),
                             agb.multiply(area).unmask(0).rename("agb_x_ha"), sd.multiply(area).unmask(0).rename("sd_x_ha")]
                            ).reduceRegion(ee.Reducer.sum(), **rr)
        out[str(y)] = ee.Algorithms.If(yc.size().gt(0), sums, None)
    with EETimer("carbon_series")("carbon_series [getInfo]"):
        return ee.Dictionary(out).getInfo()
