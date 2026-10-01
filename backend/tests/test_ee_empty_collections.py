"""Regression: an empty source collection must never become a zero-band composite.

Real case (2026-09-27): 101 km² AOI in Cameroon, 2016→2025. All four Landsat
collections had 0 scenes for the 1995 composite (1994–1996); the provider built
`merged.median()` anyway → an image with no bands → EE error
"Image.normalizedDifference: No band named 'nir'. Available band names: []".
No credentials needed: Earth Engine is replaced by fakes.
"""

import pytest

from app.providers.earth_engine import provider as p
from app.services import science as sc
from app.services.geometry import bbox_polygon, validate_aoi

# Scene counts observed live for aoi-7e6d17858ee8 (Earth Engine metadata, 2026-09-27).
CAMEROON_COUNTS = {
    "1984": {"landsat": 5}, "1990": {"landsat": 1}, "1995": {"landsat": 0}, "2000": {"landsat": 29},
    "2005": {"landsat": 27}, "2010": {"landsat": 30}, "2015": {"landsat": 100},
    **{str(y): {"sentinel2": n, "dynamicWorld": d} for y, n, d in [
        (2018, 6, 40), (2019, 146, 32), (2020, 144, 21), (2021, 146, 23), (2022, 144, 32), (2023, 146, 20), (2024, 148, 28), (2025, 198, 15)]},
}
YEARS = sc.HIST_YEARS + list(range(2018, 2026))


def test_empty_landsat_period_is_unavailable_not_composited():
    available, unavailable = p.split_available(YEARS, CAMEROON_COUNTS)
    assert 1995 not in available and 1990 in available and 2000 in available
    assert unavailable == [{"year": 1995, "sources": {"landsat": 0}, "reason": "No Landsat Collection 2 scenes over this area for 1994–1996."}]


def test_modern_year_needs_both_sentinel2_and_dynamic_world():
    counts = {**CAMEROON_COUNTS, "2021": {"sentinel2": 146, "dynamicWorld": 0}, "2022": {"sentinel2": 0, "dynamicWorld": 0}}
    available, unavailable = p.split_available(YEARS, counts)
    assert 2021 not in available and 2022 not in available
    reasons = {u["year"]: u["reason"] for u in unavailable}
    assert reasons[2021] == "No Dynamic World scenes over this area in 2021."
    assert reasons[2022] == "No Sentinel-2 SR (with Cloud Score+) or Dynamic World scenes over this area in 2022."


def test_missing_counts_are_treated_as_empty():
    available, unavailable = p.split_available([1990, 2019], {})
    assert available == [] and [u["year"] for u in unavailable] == [1990, 2019]


class _Info:
    def __init__(self, v):
        self.v = v

    def getInfo(self):
        return self.v


class _StopAtReductions(Exception):
    pass


class _FakeEE:
    class Geometry:
        def __init__(self, g):
            self.g = g

    class Image:
        @staticmethod
        def pixelArea():
            raise _StopAtReductions()  # composites are built; reductions are not under test here


@pytest.fixture
def prov(monkeypatch):
    pr = p.EarthEngineProvider()
    monkeypatch.setattr(pr, "initialize", lambda: None)
    monkeypatch.setattr(p, "_ee", lambda: _FakeEE)
    pr.built = []
    monkeypatch.setattr(pr, "_composite", lambda geom, year: (pr.built.append(year), None))
    return pr


def aoi():
    return validate_aoi(bbox_polygon((9.94, 4.30, 10.03, 4.39)))


def test_empty_periods_are_never_composited(prov, monkeypatch):
    counts = {**CAMEROON_COUNTS, "2018": {"sentinel2": 0, "dynamicWorld": 40}}   # 2016/2017 absent → empty
    monkeypatch.setattr(prov, "source_sizes", lambda geom, years: _Info(counts))
    with pytest.raises(_StopAtReductions):
        prov.analyze(aoi(), "aoi-test", "Test", 2016, 2025, scope="all")   # every era: historical AND modern
    assert 1995 not in prov.built and 2016 not in prov.built and 2017 not in prov.built and 2018 not in prov.built
    assert prov.built == [1984, 1990, 2000, 2005, 2010, 2015, 2019, 2020, 2021, 2022, 2023, 2024, 2025]


def test_change_period_needs_real_composites_at_both_ends():
    rows = [{"year": y, "era": "historical", "passes_quality": True, "loss_ha": 1.0, "gain_ha": 0.0, "forest_ha": 100.0, "previous_year": None}
            for y in (1984, 1990, 2000, 2005, 2010, 2015)]
    p.link_transitions(rows)
    periods = sc.classify_periods(rows, 2025)
    spans = [(q["from_year"], q["to_year"]) for q in periods]
    assert (1984, 1995) not in spans and (1995, 2005) not in spans, "1995 has no composite"
    assert (2005, 2015) in spans

def test_live_analysis_composites_only_the_requested_window(prov, monkeypatch):
    """The live analysis builds composites ONLY for the years its result uses: the window plus the next modern year
    (event persistence). Historical years belong to the separate history request, not to every analysis."""
    monkeypatch.setattr(prov, "source_sizes", lambda geom, years: _Info(CAMEROON_COUNTS))
    with pytest.raises(_StopAtReductions):
        prov.analyze(aoi(), "aoi-test", "Test", 2019, 2023)
    assert prov.built == [2019, 2020, 2021, 2022, 2023, 2024]


def test_history_request_composites_only_years_outside_the_window(prov, monkeypatch):
    monkeypatch.setattr(prov, "source_sizes", lambda geom, years: _Info(CAMEROON_COUNTS))
    with pytest.raises(_StopAtReductions):
        prov.analyze(aoi(), "aoi-test", "Test", 2018, 2025, scope="history")
    assert prov.built == [1984, 1990, 2000, 2005, 2010, 2015]   # 1995 has no scenes; 2016/2017 have none in this fixture
