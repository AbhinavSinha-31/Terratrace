"""Custom areas: coordinate order through the whole pipeline, and pre-flight refusal of areas that cannot be analysed.

Regression (2026-10-09): a custom area at 84.951° S, 89.481° E (Antarctica) was accepted and run. It was NOT a lat/lon
swap — every stage keeps GeoJSON [longitude, latitude] — the selection really was placed near the pole, and nothing
refused an area outside Sentinel-2 coverage or without forest.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import analysis, search
from app.services.geometry import bbox_polygon, validate_aoi

client = TestClient(app, raise_server_exceptions=False)

HASDEO = (82.79, 22.84)                       # lon, lat — central India
ANTARCTICA = (89.4806, -84.95055)            # the area from the report, exactly as stored


def square(lon: float, lat: float, half: float = 0.045) -> dict:
    """The frontend's 10 km click square, in GeoJSON [lon, lat] order (frontend/src/lib/geo.ts squareAround)."""
    return bbox_polygon((lon - half, lat - half, lon + half, lat + half))


@pytest.fixture
def no_earth_engine(monkeypatch):
    def forbidden(*a, **k):
        raise AssertionError("Earth Engine must not be called for an area refused by pre-flight")
    monkeypatch.setattr(analysis.ee_provider, "analyze", forbidden)
    monkeypatch.setattr(analysis.ee_provider, "status", forbidden)


# ----------------------------------------------------------------------------- coordinate order
def test_coordinates_keep_lon_lat_order_from_selection_to_stored_area():
    lon, lat = HASDEO
    aid, doc = analysis.register_aoi(square(lon, lat), None)
    assert doc["center"] == pytest.approx([lon, lat], abs=1e-4), "center is [lon, lat]"
    w, s, e, n = doc["bbox"]
    assert w < lon < e and s < lat < n and w > 80 and s > 20, "bbox is [west, south, east, north]"
    assert doc["region"] == "22.840°N, 82.790°E"
    first = doc["geometry"]["coordinates"][0][0]
    assert 82 < first[0] < 83 and 22 < first[1] < 23, "GeoJSON ring points stay [lon, lat]"
    # what Earth Engine receives (analysis_target -> ee.Geometry(geojson)) is the same [lon, lat] geometry
    assert analysis.analysis_target(analysis.aoi_doc(aid))["geometry"] == doc["geometry"]


def test_typed_coordinates_are_read_as_lat_lon_and_stored_as_lon_lat():
    assert search.parse_coordinates("22.84, 82.79") == (82.79, 22.84)
    assert search.parse_coordinates("22.84N 82.79E") == (82.79, 22.84)
    assert search.parse_coordinates("-84.95, 89.48") == (89.48, -84.95)


def test_the_reported_antarctic_area_is_really_at_85_south_not_swapped():
    lon, lat = ANTARCTICA
    aoi = validate_aoi(square(lon, lat))
    assert aoi.centroid[1] == pytest.approx(lat, abs=1e-3) and aoi.centroid[0] == pytest.approx(lon, abs=1e-3)
    # swapped it would be latitude 89.48° — outside the ±85° the validator accepts at all
    from app.services.geometry import AoiError
    with pytest.raises(AoiError):
        validate_aoi(square(lat, lon))


# ----------------------------------------------------------------------------- pre-flight: Sentinel-2 coverage
@pytest.mark.parametrize("lon,lat", [ANTARCTICA, (10.0, -60.0), (40.0, 84.5)])
def test_areas_outside_sentinel2_coverage_are_refused_before_any_job(no_earth_engine, lon, lat):
    pv = client.post("/api/aoi/preview", json={"geometry": square(lon, lat)}).json()
    assert pv["valid"] is False and pv["code"] == "outside_sentinel2_coverage"
    assert "56° S and 84° N" in pv["message"]
    r = client.post("/api/analysis-jobs", json={"geometry": square(lon, lat), "baseline": 2019, "comparison": 2025})
    d = r.json()["detail"]
    assert r.status_code == 422 and d["code"] == "outside_sentinel2_coverage" and d["retryable"] is False
    assert f"{abs(lat):.2f}°" in d["user_message"]


def test_areas_inside_the_coverage_band_pass_the_coverage_check():
    for lat in (-55.9, 0.0, 83.9):
        assert analysis.coverage_refusal((10.0, lat - 0.04, 10.1, lat + 0.04)) is None


# ----------------------------------------------------------------------------- pre-flight: no forest
def test_an_area_without_forest_is_refused_with_its_measured_tree_cover(no_earth_engine, tree_cover):
    tree_cover.pct = 0.3
    pv = client.post("/api/aoi/preview", json={"geometry": square(*HASDEO)}).json()
    assert pv["valid"] is False and pv["code"] == "no_forest" and "0.3 %" in pv["message"]
    r = client.post("/api/analysis-jobs", json={"geometry": square(*HASDEO), "baseline": 2019, "comparison": 2025})
    d = r.json()["detail"]
    assert r.status_code == 422 and d["code"] == "no_forest" and d["retryable"] is False


def test_forested_or_unmeasured_areas_are_not_refused(tree_cover):
    for pct in (1.0, 45.0, None):   # exactly at the gate, forested, and "could not be measured" (never blocks)
        tree_cover.pct = pct
        analysis._preflight_cache.clear()
        assert analysis.forest_refusal(pct) is None
        aid, doc = analysis.register_aoi(square(*HASDEO), None)
        assert analysis.preflight(doc) is None


def test_featured_investigations_skip_the_custom_area_preflight(tree_cover):
    tree_cover.pct = 0.0
    assert analysis.preflight(analysis.aoi_doc("hasdeo-arand")) is None and tree_cover.calls == 0


def test_area_limits_are_enforced_by_the_backend():
    from app.config import settings
    tiny = client.post("/api/aoi", json={"geometry": bbox_polygon((82.79, 22.84, 82.795, 22.845))})
    assert tiny.status_code == 422 and tiny.json()["detail"]["code"] == "aoi_too_small" and tiny.json()["detail"]["retryable"] is False
    huge = client.post("/api/aoi", json={"geometry": bbox_polygon((80.0, 20.0, 81.0, 21.0))})   # ~11,600 km²
    assert huge.status_code == 422 and huge.json()["detail"]["code"] == "aoi_too_large"
    assert settings.min_aoi_km2 <= 1 and settings.interactive_max_km2 <= settings.max_aoi_km2
