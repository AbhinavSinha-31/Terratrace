"""Offline tests (no Earth Engine): scale factors, QA bits, season dates, label windows, accuracy maths,
areas / transitions, UHI zones, correlations, change codes. Run:  .venv\\Scripts\\python -m pytest tests"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from terratrace_analysis import config, labels, landsat, lulc, stats  # noqa: E402
from terratrace_analysis.maps import change_codes  # noqa: E402

CFG = config.load()


# ----------------------------------------------------------------------------- config
def test_classes_are_1_to_4_with_barren_merged_into_built_up():
    assert CFG.class_codes == [1, 2, 3, 4]
    assert 200 in config.class_mapping(CFG.labels["glc_map"])[1]          # GLC bare areas → Built-up
    assert 60 in config.class_mapping(CFG.labels["worldcover_map"])[1]    # WorldCover bare/sparse → Built-up
    assert 7 in config.class_mapping(CFG.labels["dynamic_world_map"])[1]  # Dynamic World bare → Built-up


@pytest.mark.parametrize("table", ["glc_map", "worldcover_map", "dynamic_world_map"])
def test_every_source_code_maps_to_one_class_only(table):
    m = config.class_mapping(CFG.labels[table])
    codes = [c for v in m.values() for c in v]
    assert len(codes) == len(set(codes))
    assert set(m) == set(CFG.class_codes)


# ----------------------------------------------------------------------------- Landsat
def test_reflectance_scale_matches_usgs_valid_range():
    assert landsat.reflectance(7273) == pytest.approx(0.0, abs=1e-4)
    assert landsat.reflectance(43636) == pytest.approx(1.0, abs=1e-4)


def test_surface_temperature_scale():
    dn = (300.0 - 149.0) / 0.00341802          # DN of 300 K
    assert landsat.celsius(dn) == pytest.approx(26.85, abs=1e-6)


def test_qa_mask_bits():
    assert landsat.QA_MASK == 0b111111
    assert landsat.is_clear(0)
    assert landsat.is_clear(1 << 6)              # bit 6 = clear flag: not a masking bit
    assert landsat.is_clear(1 << 7)              # bit 7 = water: kept
    for b in (0, 1, 2, 3, 4, 5):
        assert not landsat.is_clear(1 << b)


def test_harmonised_bands():
    assert landsat.SOURCE_BANDS["LE07"][-1] == "ST_B6" and landsat.SOURCE_BANDS["LC09"][-1] == "ST_B10"
    assert landsat.SOURCE_BANDS["LE07"][3] == "SR_B4" and landsat.SOURCE_BANDS["LC08"][3] == "SR_B5"   # NIR
    assert len(landsat.FEATURES) == 12


def test_season_ranges():
    assert landsat.season_ranges(CFG, CFG.year(2025), "winter") == [("2024-11-01", "2025-03-01")]
    assert landsat.season_ranges(CFG, CFG.year(2015), "summer") == [("2015-04-01", "2015-07-01")]
    assert landsat.season_ranges(CFG, CFG.year(2015), "annual") == [("2015-01-01", "2016-01-01")]
    assert landsat.season_ranges(CFG, CFG.year(2005), "summer") == [("2004-04-01", "2004-07-01"), ("2005-04-01", "2005-07-01"),
                                                                    ("2006-04-01", "2006-07-01")]


# ----------------------------------------------------------------------------- labels
def test_glc_windows():
    assert labels.glc_years(CFG, 2015) == (2015, [2013, 2014, 2015, 2016, 2017])
    assert labels.glc_years(CFG, 2025) == (2022, [2020, 2021, 2022])          # GLC-FCS30D ends 2022
    assert labels.glc_years(CFG, 2005) == (2005, [2003, 2004, 2005, 2006, 2007])
    assert labels.glc_band(CFG, 2000) == "b1" and labels.glc_band(CFG, 2022) == "b23"


def test_label_rule_text_is_honest_about_2005():
    assert "no independent product" in labels.describe(CFG, 2005)
    assert "WorldCover" in labels.describe(CFG, 2025) and "Dynamic World 2025" in labels.describe(CFG, 2025)


# ----------------------------------------------------------------------------- accuracy
def test_metrics_known_matrix():
    m = np.array([[45, 5], [10, 40]])             # rows reference, cols predicted
    r = lulc.metrics(m)
    assert r["overall_accuracy"] == pytest.approx(0.85)
    pe = (55 * 50 + 45 * 50) / 100**2
    assert r["kappa"] == pytest.approx((0.85 - pe) / (1 - pe))
    assert r["producers_accuracy"] == pytest.approx([0.9, 0.8])
    assert r["users_accuracy"] == pytest.approx([45 / 55, 40 / 45])


def test_split_is_stratified_and_seeded():
    df = pd.DataFrame({"label": [1] * 100 + [5] * 10, "lon": 0.0, "lat": 0.0})
    a, b = lulc.split(df, 0.7, 1), lulc.split(df, 0.7, 1)
    assert (a.set == b.set).all()
    assert ((a.label == 1) & (a.set == "train")).sum() == 70
    assert ((a.label == 5) & (a.set == "train")).sum() == 7


# ----------------------------------------------------------------------------- areas, transitions
def test_areas_and_transitions():
    aoi = np.ones((2, 3), bool)
    a = np.array([[1, 3, 3], [2, 4, 0]], np.uint8)
    b = np.array([[1, 1, 3], [1, 4, 4]], np.uint8)
    ar = stats.class_areas(CFG, a, aoi).set_index("class_code")
    assert ar.loc[3, "pixels"] == 2 and ar.loc[0, "pixels"] == 1
    assert ar.loc[3, "area_km2"] == pytest.approx(2 * 900 / 1e6)
    assert ar.loc[1, "percent_of_classified"] == pytest.approx(20.0)
    tm = stats.transition_matrix(CFG, a, b, aoi)
    assert tm.values.sum() == pytest.approx(5 * 900 / 1e6)           # unclassified pixel excluded
    assert tm.loc["Agriculture/Cropland", CFG.class_name(1)] == pytest.approx(900 / 1e6)
    assert tm.loc["Vegetation/Trees", CFG.class_name(1)] == pytest.approx(900 / 1e6)


# ----------------------------------------------------------------------------- UHI
def _city():
    """120×120 grid (3.6 km): a 40×40 built-up block (1.44 km², above the 1 km² core minimum) at 30 °C, cropland at 25 °C."""
    lulc_ = np.full((120, 120), 3, np.uint8)
    lulc_[40:80, 40:80] = 1
    lst = np.where(lulc_ == 1, 30.0, 25.0).astype(np.float32)
    return lulc_, lst, np.ones((120, 120), bool)


def test_urban_core_and_equal_area_ring():
    lulc_, lst, aoi = _city()
    core = stats.urban_core(CFG, lulc_, aoi)
    assert core[60, 60] and not core[2, 2]
    ring, outer, capped = stats.rural_ring(CFG, core, lulc_, lst, aoi, int(core.sum()))
    assert not capped
    assert abs(int(ring.sum()) - int(core.sum())) <= 4 * 120          # equal area up to one distance step
    assert not (ring & core).any() and not (ring & (lulc_ == 1)).any()


def test_uhi_both_methods():
    lulc_, lst, aoi = _city()
    rows = {r["method"]: r for r in stats.uhi(CFG, lulc_, lst, aoi, stats.urban_core(CFG, lulc_, aoi))}
    assert rows["built-up vs non-built-up land"]["uhi_intensity_c"] == pytest.approx(5.0)
    assert rows["urban core vs rural ring"]["uhi_intensity_c"] == pytest.approx(5.0, abs=0.5)


def test_water_excluded_from_uhi():
    lulc_, lst, aoi = _city()
    lulc_[0:5, :] = 4
    lst[0:5, :] = 10.0                                                 # cold water must not lower the rural mean
    r = {x["method"]: x for x in stats.uhi(CFG, lulc_, lst, aoi, stats.urban_core(CFG, lulc_, aoi))}
    assert r["built-up vs non-built-up land"]["uhi_intensity_c"] == pytest.approx(5.0)


def test_correlation_perfect_negative():
    x = np.linspace(0, 1, 400).reshape(20, 20)
    y = 40 - 10 * x
    r = stats.correlation(x, y, np.ones_like(x, bool), thin=2)
    assert r["r"] == pytest.approx(-1.0) and r["slope_c_per_unit"] == pytest.approx(-10.0)


def test_conversion_zscore_removes_year_offset():
    lulc_a = np.full((10, 10), 3, np.uint8)
    lulc_b = lulc_a.copy()
    lulc_b[:5, :] = 1                                                  # half the cropland becomes built-up
    ta = 30.0 + np.tile([0.0, 1.0], 50).reshape(10, 10)               # year A: 30–31 °C everywhere
    tb = ta + np.where(lulc_b == 1, 7.0, 5.0)                          # year B 5 °C hotter overall; converted pixels +2 °C more
    rows = {r["group"]: r for r in stats.conversion(CFG, lulc_a, lulc_b, ta, tb, np.ones((10, 10), bool))}
    conv, stable = rows["Agriculture/Cropland → Built-up"], rows["Stable Agriculture/Cropland"]
    assert conv["mean_delta_lst_c"] == pytest.approx(7.0) and stable["mean_delta_lst_c"] == pytest.approx(5.0)
    assert conv["mean_delta_z"] > 0 > stable["mean_delta_z"]


def test_change_codes():
    a = np.array([[3, 2, 4, 1, 3, 3, 0]], np.uint8)
    b = np.array([[1, 1, 1, 1, 2, 3, 1]], np.uint8)
    assert change_codes(a, b).tolist() == [[1, 2, 3, 4, 5, 6, 0]]
