"""Scientific-validity rules: no-data handling, observation quality, physical constraints,
status decision and method-versioned caching.

Pure tests need no credentials. The two Earth Engine expression tests at the bottom run
only with TT_EE_LIVE=1 (they use synthetic constant images — algebra checks, not data).
"""

import json
import os

import pytest

from app.providers.earth_engine import provider as p
from app.services import analysis
from app.services import science as sc

AOI_HA = 10_000.0


def row(year, passes=True, **kw):
    r = {"year": year, "era": sc.era_of(year), "passes_quality": passes, "quality_reason": None if passes else "Insufficient clear observations",
         "previous_year": None, "valid_ha": 9_500.0, "forest_ha": None, "forest_pct": None, "loss_ha": None, "gain_ha": None,
         "compared_ha": None, "net_change_ha": None, "mean_ndvi": None, "mean_nbr": None}
    r.update(kw)
    return r


def measured(rows, sums, means=None):
    p.link_transitions(rows)
    p.apply_statistics(rows, sums, means or {})
    return rows


# ----------------------------------------------------------------------------- no-data handling
def test_missing_statistics_stay_null_and_measured_zero_stays_zero():
    rows = measured([row(2019), row(2020)], {"forest_2019": 5000.0, "forest_2020": 0.0, "loss_2020": 0.0, "gain_2020": 0.0, "cmp_2020": 9000.0})
    r19, r20 = rows
    assert r19["mean_ndvi"] is None and r19["mean_nbr"] is None, "missing mean must be None, not 0"
    assert r20["forest_ha"] == 0.0 and r20["loss_ha"] == 0.0, "a measured zero stays zero"
    rows = measured([row(2019), row(2020)], {"forest_2019": 5000.0})   # 2020 statistics missing entirely
    assert rows[1]["forest_ha"] is None and rows[1]["loss_ha"] is None and rows[1]["net_change_ha"] is None


def test_forest_pct_is_relative_to_observed_area():
    rows = measured([row(2019, valid_ha=5_000.0)], {"forest_2019": 2_500.0})
    assert rows[0]["forest_pct"] == 50.0


def test_provider_never_unmasks_forest_to_zero():
    src = open(p.__file__, encoding="utf-8").read()
    for bad in ('select("forest").unmask', "forest.unmask", 'forest").unmask(0)', "or 0.0"):
        assert bad not in src, f"regression: {bad!r} turns unobserved/missing into a measurement"


# ----------------------------------------------------------------------------- insufficient years
def test_insufficient_year_is_excluded_from_transitions_and_statistics():
    rows = [row(2019), row(2020, passes=False), row(2021)]
    sums = {"forest_2019": 6000.0, "forest_2020": 1.0, "forest_2021": 5800.0,
            "loss_2020": 5000.0, "gain_2020": 0.0, "cmp_2020": 9000.0,   # must be ignored: 2020 is insufficient
            "loss_2021": 300.0, "gain_2021": 100.0, "cmp_2021": 9000.0}
    measured(rows, sums)
    assert rows[1]["previous_year"] is None and rows[1]["forest_ha"] is None and rows[1]["loss_ha"] is None
    assert rows[2]["previous_year"] == 2019, "the comparison explicitly skips the insufficient year"
    k = sc.kpis_for(rows, [], 2019, 2021, {"loss": 300.0, "gain": 100.0, "compared": 9000.0, "forest_b": 6000.0})
    assert k["total_loss_ha"] == 300.0 and k["total_gain_ha"] == 100.0


def test_eras_are_never_compared():
    rows = measured([row(2010), row(2015), row(2016), row(2017)], {})
    assert rows[1]["previous_year"] == 2010 and rows[2]["previous_year"] is None and rows[3]["previous_year"] == 2016


def test_window_uses_only_analysable_modern_years():
    rows = [row(2015), row(2016, passes=False), row(2017, passes=False), row(2018, passes=False), row(2019), row(2024), row(2025)]
    window, hist = p.choose_windows(rows, 2016, 2025)
    assert window == (2019, 2025) and hist is None
    assert p.choose_windows([row(2019), row(2020, passes=False)], 2016, 2025)[0] is None


def test_insufficient_coverage_fails_the_year_with_a_reason():
    ok, reason = sc.assess_year(2018, 2, 40, 0.41)
    assert not ok and reason.startswith("Insufficient clear observations: only 41% of the area")
    assert sc.assess_year(2019, 22, 30, 0.97) == (True, None)
    assert sc.assess_year(2019, None, None, None)[0] is False


# ----------------------------------------------------------------------------- status decision
def ready_rows():
    rows = [row(2019, forest_ha=6000.0, forest_pct=63.2), row(2025, forest_ha=5800.0, forest_pct=61.1)]
    p.link_transitions(rows)
    rows[1].update(loss_ha=300.0, gain_ha=100.0, compared_ha=9000.0, net_change_ha=-200.0)
    return rows


def test_valid_observations_produce_ready():
    rows = ready_rows()
    k = sc.kpis_for(rows, [], 2019, 2025, {"loss": 300.0, "gain": 100.0, "compared": 9000.0, "forest_b": 6000.0})
    assert sc.evaluate(rows, AOI_HA, (2019, 2025), k)[0] == "READY"


def test_insufficient_coverage_is_unavailable_not_ready():
    status, code, reason, _ = sc.evaluate([row(2019), row(2025, passes=False)], AOI_HA, None)
    assert status == "UNAVAILABLE" and code == "insufficient_clear_observations" and "Insufficient clear observations" in reason


@pytest.mark.parametrize("patch,rule", [
    ({"loss_ha": 12_000.0}, "loss_exceeds_area"),
    ({"gain_ha": 9_500.0}, "gain_exceeds_area"),
    ({"forest_pct": 101.5}, "forest_pct_out_of_range"),
    ({"forest_pct": -0.5}, "forest_pct_out_of_range"),
    ({"forest_ha": -1.0}, "negative_area"),
    ({"forest_ha": 10_500.0}, "forest_exceeds_area"),
    ({"gain_ha": 3_540.0}, "unstable_forest_mask"),   # the Cameroon 2021→2022 pattern: 39 % gain in one year
])
def test_impossible_or_unstable_results_are_invalid(patch, rule):
    rows = ready_rows()
    rows[1].update(patch)
    status, code, _, issues = sc.evaluate(rows, AOI_HA, (2019, 2025))
    assert status == "INVALID_ANALYSIS" and rule in [i["rule"] for i in issues]


# ----------------------------------------------------------------------------- validation scope = analysed window
def history_and_window_rows(in_window_gain=100.0):
    """1990→1995 (historical) is unstable; 2017→2018 (the transition INTO the baseline) is unstable;
    the requested 2018→2025 window itself is clean unless `in_window_gain` says otherwise."""
    rows = [row(1990, forest_ha=5000.0), row(1995, forest_ha=5000.0), row(2017, forest_ha=5000.0),
            row(2018, forest_ha=6000.0, forest_pct=63.2), row(2025, forest_ha=5800.0, forest_pct=61.1)]
    p.link_transitions(rows)
    by = {r["year"]: r for r in rows}
    by[1995].update(loss_ha=10.0, gain_ha=4_000.0, compared_ha=9000.0)   # 8.9 %/yr — unstable, historical
    by[2018].update(loss_ha=10.0, gain_ha=1_000.0, compared_ha=9000.0)   # 11 %/yr — unstable, 2017→2018
    by[2025].update(loss_ha=300.0, gain_ha=in_window_gain, compared_ha=9000.0)
    return rows


def test_out_of_window_transitions_never_invalidate_the_requested_analysis():
    """Regression (Hasdeo Arand 2018→2025 listed 1990→1995 as a reason)."""
    rows = history_and_window_rows()
    k = sc.kpis_for(rows, [], 2018, 2025, {"loss": 300.0, "gain": 100.0, "compared": 9000.0, "forest_b": 6000.0})
    status, code, reason, issues = sc.evaluate(rows, AOI_HA, (2018, 2025), k)
    assert status == "READY" and issues == []
    ctx = sc.context_issues(rows, AOI_HA, (2018, 2025))
    assert {tuple(i["years"]) for i in ctx} == {(1990, 1995), (2017, 2018)}, "reported as context only"


def test_in_window_instability_still_invalidates_with_the_unchanged_rule():
    rows = history_and_window_rows(in_window_gain=3_540.0)          # 2018→2025: 5.6 %/yr > 5 %
    status, code, reason, issues = sc.evaluate(rows, AOI_HA, (2018, 2025))
    assert status == "INVALID_ANALYSIS" and code == "unstable_forest_mask"
    assert [i["years"] for i in issues] == [[2018, 2025]], "only the in-window transition decides"
    assert "1990" not in reason and "2017" not in reason and "ecologically plausible 5%" in reason


def test_cached_invalid_results_are_rescoped_or_recomputed():
    msg = lambda a, b: f"{a}→{b}: forest gain exceeds the ecologically plausible 5% ..."
    mixed = {"status": "INVALID_ANALYSIS", "quality": {"analyzable_window": [2018, 2025], "issues": [
        {"rule": "unstable_forest_mask", "years": [1990, 1995], "message": msg(1990, 1995)},
        {"rule": "unstable_forest_mask", "years": [2019, 2020], "message": msg(2019, 2020)}]}}
    assert analysis._rescope_invalid(mixed) is True
    assert [i["years"] for i in mixed["quality"]["issues"]] == [[2019, 2020]] and "1990" not in mixed["reason"]
    assert [i["years"] for i in mixed["quality"]["context_issues"]] == [[1990, 1995]]
    only_history = {"status": "INVALID_ANALYSIS", "quality": {"analyzable_window": [2018, 2025], "issues": [
        {"rule": "unstable_forest_mask", "years": [1990, 1995], "message": msg(1990, 1995)}]}}
    assert analysis._rescope_invalid(only_history) is False, "never turned into READY without statistics: recompute"


def test_cumulative_loss_beyond_available_forest_is_invalid():
    rows = ready_rows()
    k = {"baseline_year": 2019, "latest_year": 2025, "forest_baseline_ha": 1_000.0, "total_loss_ha": 5_000.0, "total_gain_ha": 100.0}
    status, code, _, _ = sc.evaluate(rows, AOI_HA, (2019, 2025), k)
    assert status == "INVALID_ANALYSIS" and code == "cumulative_loss_exceeds_forest"


def test_values_are_not_clamped():
    rows = ready_rows()
    rows[1]["loss_ha"] = 12_000.0
    sc.evaluate(rows, AOI_HA, (2019, 2025))
    assert rows[1]["loss_ha"] == 12_000.0


# ----------------------------------------------------------------------------- method-versioned cache
def test_results_from_an_older_method_are_never_reused(tmp_path, monkeypatch):
    monkeypatch.setattr(analysis, "RESULTS", tmp_path)
    analysis._results.clear()
    old = tmp_path / f"aoi-x-2016-2025-{sc.METHOD_VERSION}.json"
    old.write_text(json.dumps({"status": "READY", "method_version": "ee-0.1.0", "summary": {"aoi": {"id": "aoi-x"}}, "geometry": {}}), encoding="utf-8")
    assert analysis._load_result(f"aoi-x-2016-2025-{sc.METHOD_VERSION}") is None and not old.exists()
    legacy = tmp_path / "aoi-7e6d17858ee8-2016-2025.json"   # the pre-versioning file name
    legacy.write_text(json.dumps({"summary": {}}), encoding="utf-8")
    assert analysis.purge_stale_results() == 1 and not legacy.exists()
    current = {"status": "INVALID_ANALYSIS", "reasonCode": "unstable_forest_mask", "reason": "r",
               "quality": {"analyzable_window": [2016, 2025], "issues": [{"rule": "unstable_forest_mask", "years": [2019, 2020], "message": "m"}]}}
    analysis._save_result(analysis._key("aoi-x", 2016, 2025), current, {})
    analysis._results.clear()
    assert analysis._load_result(analysis._key("aoi-x", 2016, 2025))["status"] == "INVALID_ANALYSIS"
    assert sc.METHOD_VERSION in analysis._key("aoi-x", 2016, 2025)


# ----------------------------------------------------------------------------- Earth Engine algebra (opt-in)
live = pytest.mark.skipif(os.environ.get("TT_EE_LIVE") != "1", reason="set TT_EE_LIVE=1 to run against Earth Engine")


@pytest.fixture(scope="module")
def ee_live():
    import ee
    ee.Initialize(project=os.environ["EE_PROJECT"])   # opt-in live test: the project comes from the environment
    return ee


@live
def test_masked_pixel_is_not_non_forest(ee_live):
    ee = ee_live
    region = ee.Geometry.Rectangle([10.0, 4.0, 10.02, 4.02])
    east = ee.Image.pixelLonLat().select("longitude").gte(10.01)
    area = ee.Image.pixelArea().divide(1e4)
    fa = ee.Image.constant(1).rename("forest")                  # forest everywhere, observed everywhere
    fb = ee.Image.constant(0).rename("forest").updateMask(east)  # non-forest in the east; WEST UNOBSERVED
    bands = ee.Image.cat(p.transition_bands(fa, fb, area, "t") + [area.rename("all")])
    s = bands.reduceRegion(ee.Reducer.sum(), region, 30, maxPixels=1e9).getInfo()
    half = s["all"] / 2
    assert s["cmp_t"] == pytest.approx(half, rel=0.05), "compared area = pixels observed in both years only"
    assert s["loss_t"] == pytest.approx(half, rel=0.05), "unobserved west half must NOT count as loss"
    assert s["gain_t"] == 0


@live
def test_forest_area_sums_observed_pixels_only(ee_live):
    ee = ee_live
    region = ee.Geometry.Rectangle([10.0, 4.0, 10.02, 4.02])
    east = ee.Image.pixelLonLat().select("longitude").gte(10.01)
    area = ee.Image.pixelArea().divide(1e4)
    forest = ee.Image.constant(1).updateMask(east)
    s = ee.Image.cat([forest.multiply(area).rename("f"), area.rename("all")]).reduceRegion(ee.Reducer.sum(), region, 30, maxPixels=1e9).getInfo()
    assert s["f"] == pytest.approx(s["all"] / 2, rel=0.05)


# ----------------------------------------------------------------------------- sensor eras (1984 → present)
def test_historical_landsat_years_do_not_require_dynamic_world():
    counts = {str(y): {"landsat": 5} for y in sc.HIST_YEARS}   # no Dynamic World entry at all
    available, unavailable = p.split_available(sc.HIST_YEARS, counts)
    assert available == sc.HIST_YEARS and unavailable == []
    assert sc.era_of(1984) == sc.era_of(2015) == "historical" and sc.era_of(2016) == "modern"
    assert sc.sensor_for(2015)["dw_available"] is False and sc.sensor_for(2016)["dw_available"] is True


def test_dynamic_world_is_never_requested_before_the_modern_era(monkeypatch):
    pr = p.EarthEngineProvider()
    calls = {"landsat": [], "s2": [], "dw": []}

    class Col:
        def size(self):
            return 1

    monkeypatch.setattr(pr, "_landsat_collection", lambda g, y: (calls["landsat"].append(y), Col())[1])
    monkeypatch.setattr(pr, "_s2_collection", lambda g, y: (calls["s2"].append(y), Col())[1])
    monkeypatch.setattr(pr, "_dw_collection", lambda g, y: (calls["dw"].append(y), Col())[1])

    class FakeEE:
        Dictionary = staticmethod(lambda d: d)

    monkeypatch.setattr(p, "_ee", lambda: FakeEE)
    years = sc.HIST_YEARS + list(range(sc.MODERN_FIRST_YEAR, 2026))
    out = pr.source_sizes(None, years)
    assert calls["landsat"] == sc.HIST_YEARS, "1984 is part of the analysis; historical years use Landsat"
    assert min(calls["dw"]) == 2016 and min(calls["s2"]) == 2016, "no Dynamic World / Sentinel-2 before the modern era"
    assert set(out["1984"]) == {"landsat"} and set(out["2016"]) == {"sentinel2", "dynamicWorld"}

    built = []
    monkeypatch.setattr(pr, "_landsat", lambda g, y: (built.append(("landsat", y)), (None, None))[1])
    monkeypatch.setattr(pr, "_s2", lambda g, y: (built.append(("s2+dw", y)), (None, None))[1])
    for y in (1984, 2010, 2015, 2016, 2025):
        pr._composite(None, y)
    assert built == [("landsat", 1984), ("landsat", 2010), ("landsat", 2015), ("s2+dw", 2016), ("s2+dw", 2025)]


def test_no_global_2016_or_2018_minimum_in_the_backend():
    assert sc.HIST_YEARS[0] == 1984
    assert sc.DEFAULT_EVENT_WINDOW == (2018, 2025), "a default request, not a minimum"
    # Any requested baseline is honoured by the window choice (analysable years inside the request only).
    rows = [{"year": y, "era": sc.era_of(y), "passes_quality": True} for y in (1984, 1990, 2016, 2017, 2020)]
    window, hist = p.choose_windows(rows, 1984, 2020)
    assert window == (2016, 2020) and hist == (1984, 1990)


def test_event_request_returns_the_measured_polygons_and_candidate_count(monkeypatch):
    """Regression: the event request once nested the FeatureCollection in an ee.Dictionary, which Earth Engine
    serialises WITHOUT features — every measured polygon was dropped (0 events for 382 candidates). The polygons and
    the candidate count must come back from the one collection request."""
    from unittest.mock import MagicMock
    fake = MagicMock()
    fc = fake.Image.cat.return_value.reduceRegions.return_value.sort.return_value
    props = {"area_ha": 42.0, "ndvi_b_mean": 0.8, "ndvi_a_mean": 0.3, "nbr_b_mean": 0.5, "nbr_a_mean": 0.1,
             "tree_b_mean": 0.9, "tree_a_mean": 0.1, "label_a_mode": 2, "clear_a_min": 6, "persist_mean": 1.0, "ref_mean": 0.8}
    ring = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]
    fc.set.return_value.getInfo.return_value = {
        "type": "FeatureCollection", "properties": {"tt_candidates": 382},
        "features": [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": props}],
    }
    monkeypatch.setattr(p, "_ee", lambda: fake)
    pr = p.EarthEngineProvider()
    comps = {2018: MagicMock(), 2025: MagicMock()}
    features, candidates = pr._events(None, comps, 2018, 2025, None, "aoi-test0001")
    assert candidates == 382
    assert len(features) == 1 and features[0]["properties"]["area_ha"] == 42.0
    fake.Dictionary.assert_not_called()


class _Px:
    """Tiny masked-pixel stand-in for ee.Image algebra (Earth Engine semantics: an operation is masked wherever any
    input is masked; And/Not/gte keep the mask). Used to test the REAL transition expression offline."""
    def __init__(self, v, m):
        self.v, self.m = list(v), list(m)
    def _op(self, o, f):
        o = o if isinstance(o, _Px) else _Px([o] * len(self.v), [True] * len(self.v))
        return _Px([f(a, b) for a, b in zip(self.v, o.v)], [a and b for a, b in zip(self.m, o.m)])
    def And(self, o): return self._op(o, lambda a, b: int(bool(a) and bool(b)))
    def Not(self): return _Px([int(not a) for a in self.v], self.m)
    def gte(self, o): return self._op(o, lambda a, b: int(a >= b))
    def multiply(self, o): return self._op(o, lambda a, b: a * b)
    def updateMask(self, o): return _Px(self.v, [a and b and bool(bv) for a, b, bv in zip(self.m, o.m, o.v)])
    def rename(self, _): return self
    def total(self): return sum(v for v, m in zip(self.v, self.m) if m)   # reducers sum observed pixels only


def test_unobserved_pixels_never_become_gain_or_loss():
    from app.providers.earth_engine.provider import transition_bands
    # pixel:        0 F->F  1 N->F  2 F->N  3 nodata->F  4 nodata->N  5 F->nodata  6 N->nodata  7 N->N
    fa = _Px([1, 0, 1, 0, 0, 1, 0, 0], [True, True, True, False, False, True, True, True])
    fb = _Px([1, 1, 0, 1, 0, 0, 0, 0], [True, True, True, True, True, False, False, True])
    area = _Px([1.0] * 8, [True] * 8)
    loss, gain, cmp_, fbase = (b.total() for b in transition_bands(fa, fb, area, "t"))
    assert gain == 1.0 and loss == 1.0, "only observed N->F is gain and observed F->N is loss"
    assert cmp_ == 4.0, "compared area = pixels observed in BOTH years (0, 1, 2, 7)"
    assert fbase == 2.0


def test_unstable_mask_issue_carries_the_measured_evidence():
    rows = [
        {"year": 2019, "era": "modern", "passes_quality": True, "previous_year": None, "forest_ha": 100.0, "forest_pct": 10.0,
         "loss_ha": None, "gain_ha": None, "compared_ha": None, "valid_ha": 1000.0},
        {"year": 2020, "era": "modern", "passes_quality": True, "previous_year": 2019, "forest_ha": 158.0, "forest_pct": 15.8,
         "loss_ha": 2.0, "gain_ha": 60.0, "compared_ha": 1000.0, "valid_ha": 1000.0},
    ]
    status, code, _, issues = sc.evaluate(rows, 1000.0, (2019, 2020))
    assert status == "INVALID_ANALYSIS" and code == "unstable_forest_mask"
    ev = issues[0]["evidence"]
    assert ev == {"measured_pct_per_year": 6.0, "threshold_pct_per_year": 5.0, "gain_ha": 60.0, "compared_ha": 1000.0}
    assert sc.MAX_ANNUAL_GAIN_FRACTION == 0.05, "the plausibility guardrail is unchanged"


def test_forest_mask_uses_leaf_on_ndvi_with_unchanged_thresholds():
    """tt-ee-2.1: the NDVI floor applies to leaf-on NDVI (per-pixel p90 of clear observations), not the annual median;
    the thresholds themselves are unchanged and results of the previous method are never reused (version bump)."""
    import inspect
    src = inspect.getsource(p.LiveProvider._s2) if hasattr(p, "LiveProvider") else inspect.getsource(type(p.provider)._s2)
    assert "Reducer.percentile([sc.FOREST_NDVI_PERCENTILE])" in src
    assert 'trees_leafon.gte(sc.FOREST_TREE_PROB).And(ndvi_leafon.gte(sc.FOREST_NDVI)).updateMask(valid)' in src   # 2.3: leaf-on trees too
    assert (sc.FOREST_TREE_PROB, sc.FOREST_NDVI, sc.FOREST_NDVI_PERCENTILE) == (0.50, 0.60, 90)
    assert (sc.MAX_ANNUAL_GAIN_FRACTION, sc.MIN_PIXEL_CLEAR_OBS, sc.MIN_PIXEL_DW_OBS, sc.MIN_YEAR_COVERAGE) == (0.05, 3, 3, 0.80)
    assert sc.METHOD_VERSION == "tt-ee-2.4"   # 2.2 seasonal rule, 2.3/2.4 tree-probability statistic; every threshold above is unchanged


# ----------------------------------------------------------------------------- tt-ee-2.2 seasonal-coverage rule
# Fixture values below are the MEASURED Hasdeo Arand figures (Earth Engine, 2026-10-07) that exposed the gap.

def test_a_year_missing_a_season_is_not_analysable():
    """Hasdeo 2018: 100 % annual coverage and median 21 clear observations, but NO July–September scene in the
    Sentinel-2 SR archive. Leaf-on NDVI cannot be measured without the leaf-on season -> the year must not pass."""
    passes, reason = sc.assess_year(2018, 21, 39, 1.0, [1.0, 1.0, 0.0, 1.0], forest_analysis=True)
    assert not passes and "Jul–Sep: 0.0% of the area observed" in reason and "every quarter" in reason


def test_complete_years_pass_and_the_threshold_is_the_coverage_threshold():
    assert sc.assess_year(2019, 46, 33, 1.0, [1.0, 1.0, 0.92, 1.0], forest_analysis=True) == (True, None)
    assert sc.assess_year(2024, 45, 30, 1.0, [1.0, 1.0, 0.80, 1.0], forest_analysis=True) == (True, None)
    assert not sc.assess_year(2024, 45, 30, 1.0, [1.0, 1.0, 0.79, 1.0], forest_analysis=True)[0]
    assert sc.METHOD["thresholds"]["min_season_coverage"] == sc.MIN_YEAR_COVERAGE   # no new tuning constant


def test_unmeasured_seasonal_coverage_never_passes_an_analysis_year():
    for seasonal in (None, [1.0, None, 1.0, 1.0], [1.0, 1.0, 1.0]):
        passes, reason = sc.assess_year(2020, 40, 30, 1.0, seasonal, forest_analysis=True)
        assert not passes and "could not be measured" in reason


def test_seasonal_rule_is_for_the_forest_analysis_only():
    """Imagery availability is imagery, not a forest measurement: the seasonal rule never hides real imagery."""
    assert sc.assess_year(2025, None, None, 0.95) == (True, None)
    assert sc.assess_year(1990, 12, None, 0.95, None, forest_analysis=True) == (True, None)   # Landsat era: no leaf-on test


def test_an_unstable_mask_names_the_component_that_moved():
    """Hasdeo 2019→2020: imagery complete, leaf-on NDVI stable (+2.3 pts) while the Dynamic World tree probability
    jumped (+9.7 pts). The issue stays (VALIDATION REQUIRED) and its reason states the measured cause."""
    rows = [row(2019, previous_year=None, forest_ha=55340.0, forest_components={"tree_prob": 47.3, "leafon_ndvi": 63.6}),
            row(2020, previous_year=2019, forest_ha=64420.0, loss_ha=2000.0, gain_ha=9893.0, compared_ha=120945.1,
                forest_components={"tree_prob": 57.0, "leafon_ndvi": 65.9}, forest_components_change_pts={"tree_prob": 9.7, "leafon_ndvi": 2.3})]
    status, code, reason, issues = sc.evaluate(rows, 120945.1, (2019, 2020))
    assert status == "INVALID_ANALYSIS" and code == "unstable_forest_mask"
    assert issues[0]["evidence"]["driver"] == "tree_prob"
    assert "Dynamic World tree-probability classification" in reason and "+9.7 pts" in reason and "+2.3 pts" in reason


def test_component_driver_reports_both_or_nothing_when_unclear_or_unmeasured():
    assert sc.component_driver({"tree_prob": 3.0, "leafon_ndvi": 2.0})[0] == "both"
    assert sc.component_driver({"tree_prob": 0.5, "leafon_ndvi": 6.0})[0] == "leafon_ndvi"
    assert sc.component_driver(None) == (None, None)
    assert sc.component_driver({"tree_prob": None, "leafon_ndvi": 1.0}) == (None, None)


def test_component_change_is_measured_between_analysable_years_only():
    rows = [row(2018, passes=False), row(2019), row(2020)]
    p.link_transitions(rows)
    for r in rows:
        r["valid_ha"] = 1000.0
    sums = {"forest_2019": 500.0, "ctree_2019": 400.0, "cndvi_2019": 600.0,
            "forest_2020": 520.0, "ctree_2020": 500.0, "cndvi_2020": 610.0, "loss_2020": 1.0, "gain_2020": 21.0, "cmp_2020": 1000.0}
    p.apply_statistics(rows, sums, {})
    assert rows[0].get("forest_components") is None              # a failing year is never measured
    assert rows[1]["forest_components_change_pts"] is None        # no analysable previous year
    assert rows[2]["forest_components_change_pts"] == {"tree_prob": 10.0, "leafon_ndvi": 1.0}


def test_an_empty_quarter_is_counted_as_zero_observations_not_composited():
    """A quarter without scenes must yield 'not observed', never an error and never a filled value."""
    import inspect
    src = inspect.getsource(type(p.provider)._quarter_obs)
    assert 'updateMask(ee.Image.constant(0))' in src and "none.merge(seen).count()" in src


def test_a_failing_seasonal_share_never_reads_as_the_threshold():
    """Measured Hasdeo 2024: 79.8 % in Jul–Sep fails the 80 % rule; the reason must not print it as '80%'."""
    passes, reason = sc.assess_year(2024, 45, 30, 1.0, [1.0, 1.0, 0.798, 1.0], forest_analysis=True)
    assert not passes and "79.8%" in reason


# ----------------------------------------------------------------------------- tt-ee-2.3: leaf-on tree probability
class _Expr:
    """Records an Earth Engine expression graph (no Earth Engine call): every attribute is a call producing a node."""

    def __init__(self, desc):
        self.desc = desc

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Expr(("attr", self, name))

    def __call__(self, *a, **k):
        return _Expr(("call", self, a))

    def __repr__(self):
        if isinstance(self.desc, str):
            return self.desc
        kind, parent, x = self.desc
        return f"{parent!r}.{x}" if kind == "attr" else f"{parent!r}({', '.join(repr(a) for a in x)})"


def _s2_bands(monkeypatch) -> dict[str, str]:
    """The band expressions of the modern composite, by band name."""
    monkeypatch.setattr(p, "_ee", lambda: _Expr("ee"))
    comp, _ = p.EarthEngineProvider()._s2(_Expr("geom"), 2020)
    out = {}
    for band in comp.desc[2][0]:   # comp = <median>.addBands([bands]) -> the call's first argument is the band list
        text = repr(band)
        name = text.rsplit(".rename(", 1)[-1].rstrip(")").strip("'\"")
        out[name] = text
    return out


def test_forest_mask_uses_the_upper_quartile_tree_probability(monkeypatch):
    """Regressions (2026-10-09): the annual MEAN of Dynamic World tree probability flipped deciduous sal forest with
    each year's season mix (Hasdeo 2019->2020 'gain' 8.2 %/yr); the 90th percentile (tt-ee-2.3) let a few transient
    high scenes flip pasture at Rondonia (6.8 %/yr). The forest test uses the per-pixel upper quartile (p75)."""
    assert sc.FOREST_TREE_PERCENTILE == 75
    bands = _s2_bands(monkeypatch)
    forest, tree_c = bands["forest"], bands["forest_c_tree"]
    for expr in (forest, tree_c):
        assert "select('trees').reduce(ee.Reducer.percentile([75]))" in expr
        assert ".mean()" not in expr, "the annual mean must not decide forest"
    assert f"percentile([{sc.FOREST_NDVI_PERCENTILE}])" in bands["ndvi_leafon"]
    # change EVIDENCE still uses the annual-mean tree probability (unchanged event rule)
    assert "select('trees').mean()" in bands["trees"]


def test_gain_plausibility_limit_is_not_loosened():
    assert sc.MAX_ANNUAL_GAIN_FRACTION == 0.05
    assert sc.FOREST_TREE_PROB == 0.50 and sc.FOREST_NDVI == 0.60
    assert sc.METHOD_VERSION == "tt-ee-2.4" and "75th percentile" in sc.METHOD["forest_rule"]


def test_imagery_availability_reports_whether_an_analysis_can_use_each_year():
    from app.services import imagery
    years = [2015, 2018, 2019, 2026]
    counts = {"2015": {"landsat": 9}, "2018": {"sentinel2": 40, "dynamicWorld": 80}, "2019": {"sentinel2": 140, "dynamicWorld": 85},
              "2026": {"sentinel2": 0, "dynamicWorld": 0}}
    cov = {"aoi": 100.0, "valid_2015": 95.0, "valid_2018": 100.0, "valid_2019": 100.0,
           "season1_2018": 100.0, "season2_2018": 100.0, "season3_2018": 0.0, "season4_2018": 100.0,
           "season1_2019": 100.0, "season2_2019": 100.0, "season3_2019": 92.2, "season4_2019": 100.0}
    by = {e["year"]: e for e in imagery.classify(years, counts, cov)}
    # 2018: imagery exists (AVAILABLE to view), but no July–September observations -> not analysable, with the reason
    assert by[2018]["status"] == "AVAILABLE" and by[2018]["analysable"] is False
    assert "Jul–Sep: 0.0%" in by[2018]["analysisReason"] and by[2018]["seasonalCoverage"] == [1.0, 1.0, 0.0, 1.0]
    assert by[2019]["analysable"] is True and by[2019]["analysisReason"] is None
    assert by[2015]["analysable"] is True and by[2015]["seasonalCoverage"] is None   # historical: no seasonal rule
    assert by[2026]["status"] == "UNAVAILABLE" and by[2026]["analysable"] is False and by[2026]["analysisReason"]


def test_unmeasured_seasonal_coverage_is_never_analysable():
    from app.services import imagery
    by = imagery.classify([2020], {"2020": {"sentinel2": 140, "dynamicWorld": 85}}, {"aoi": 100.0, "valid_2020": 100.0})
    assert by[0]["status"] == "AVAILABLE" and by[0]["analysable"] is False and "could not be measured" in by[0]["analysisReason"]


@live
@pytest.mark.parametrize("aid", ["hasdeo-arand", "rondonia-frontier"])
def test_featured_forest_masks_are_stable_2019_2025(ee_live, aid):
    """Opt-in live regression: no consecutive 2019–2025 pair exceeds the unchanged 5 %/yr gain limit at the deciduous
    site (annual mean: 8.2 %) or the evergreen frontier (90th percentile: 6.8 %)."""
    from app.services import analysis
    from app.services.geometry import validate_aoi
    aoi = validate_aoi(analysis.analysis_target(analysis.aoi_doc(aid))["geometry"], enforce_limits=False)
    res = p.provider.analyze(aoi, f"{aid}#live-test", aid, 2019, 2025)
    issues = [i for i in (res.get("quality") or {}).get("issues", []) if i["rule"] == "unstable_forest_mask"]
    assert issues == [], issues
