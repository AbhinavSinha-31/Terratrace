"""Route input validation: ids, years, windows and tile indexes are bounded before any work starts.

Out-of-range input must be refused with a public error and must never reach Earth Engine (each distinct year or
window would otherwise start a new computation and write a new cache file). No credentials needed.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import analysis, imagery

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def no_earth_engine(monkeypatch):
    """Fail the test if any request reaches Earth Engine."""
    def forbidden(*a, **k):
        raise AssertionError("Earth Engine must not be called for invalid input")
    for name in ("analyze", "tile_url", "imagery_layer", "status"):
        monkeypatch.setattr(analysis.ee_provider, name, forbidden)
    monkeypatch.setattr(analysis, "_ee_reachable", forbidden)


def public(r):
    d = r.json()["detail"]
    assert set(d) >= {"code", "user_message", "retryable"}, d
    return d


@pytest.mark.parametrize("path", [
    "/api/analysis/silent-valley/history?baseline=1&comparison=99999",
    "/api/analysis/silent-valley/history?baseline=2025&comparison=2018",
    "/api/analysis-status/silent-valley?baseline=-5&comparison=999999",
    "/api/analysis-status/silent-valley?baseline=2020&comparison=2020",
    "/api/analysis/silent-valley?baseline=2025&comparison=2019",
])
def test_invalid_years_or_windows_are_refused(no_earth_engine, path):
    r = client.get(path)
    assert r.status_code == 422
    assert public(r)["retryable"] is False


@pytest.mark.parametrize("path", [
    "/api/tiles/silent-valley/forest/2017/0/0/0?baseline=1999",
    "/api/tiles/silent-valley/forest/1991/0/0/0",        # between historical composite years
    "/api/tiles/silent-valley/forest/2020/3/8/0",        # x >= 2^z
    "/api/imagery/tiles/silent-valley/2020/2/0/4",       # y >= 2^z
])
def test_nonexistent_tile_layers_are_404_without_earth_engine(no_earth_engine, path):
    r = client.get(path, follow_redirects=False)
    assert r.status_code == 404 and public(r)["code"] == "not_found"


@pytest.mark.parametrize("path", [
    "/api/tiles/silent-valley/forest/1700/0/0/0",
    "/api/tiles/silent-valley/forest/20200/0/0/0",
    "/api/tiles/silent-valley/forest/2020/25/0/0",
    "/api/tiles/silent-valley/forest/2020/1/-1/0",
    "/api/tiles/silent-valley/secret/2020/0/0/0",
    "/api/tiles/Silent_Valley/forest/2020/0/0/0",
    "/api/imagery?aoi=..%2F..%2Fx&year=2020",
    "/api/imagery/availability?aoi=a%20b",
    "/api/imagery/availability?aoi=" + "a" * 81,
    "/api/aoi/" + "a" * 81,
    "/api/progress/short",
    "/api/progress/" + "x" * 65,
])
def test_malformed_params_are_refused(no_earth_engine, path):
    r = client.get(path, follow_redirects=False)
    assert r.status_code in (404, 422), (path, r.status_code)
    if r.status_code == 422:
        public(r)


def test_job_request_with_malformed_aoi_id_is_refused(no_earth_engine):
    r = client.post("/api/analysis-jobs", json={"aoi_id": "../../etc", "baseline": 2018, "comparison": 2025})
    assert r.status_code == 404 and public(r)["code"] == "not_found"


def test_aoi_input_errors_are_not_retryable(no_earth_engine):
    bad = {"type": "Polygon", "coordinates": [[[999, 999], [1, 1], [2, 2], [999, 999]]]}
    r = client.post("/api/aoi", json={"geometry": bad})
    assert r.status_code == 422 and public(r)["retryable"] is False


def test_valid_tile_year_still_reaches_the_tile_service(monkeypatch, fake_ee_tiles):
    """The bounds must not block real layers: a composite year passes through to the tile service."""
    year = imagery.candidate_years()[-1]
    monkeypatch.setattr(analysis.ee_provider, "tile_url", lambda *a, **k: "https://ee.example/{z}/{x}/{y}")
    r = client.get(f"/api/tiles/silent-valley/forest/{year}/3/7/7", follow_redirects=False)
    assert r.status_code == 200 and fake_ee_tiles.urls == ["https://ee.example/3/7/7"]


def test_oversized_request_bodies_are_refused_before_parsing():
    from app.config import settings
    big = b'{"geometry": {"type": "Polygon", "coordinates": [' + b"[0,0]," * (settings.max_request_bytes // 6 + 10) + b"[0,0]]}}"
    r = client.post("/api/aoi", content=big, headers={"Content-Type": "application/json"})
    assert r.status_code == 413 and public(r)["code"] == "invalid_request" and public(r)["retryable"] is False

    def chunked():   # no Content-Length: the body is counted as it arrives
        for i in range(0, len(big), 65536):
            yield big[i:i + 65536]
    r = client.post("/api/aoi", content=chunked(), headers={"Content-Type": "application/json"})
    assert r.status_code == 413


def test_normal_bodies_still_pass_the_size_limit():
    from app.services.geometry import bbox_polygon
    r = client.post("/api/aoi/preview", json={"geometry": bbox_polygon((76.4, 11.0, 76.5, 11.1))})
    assert r.status_code == 200 and r.json()["valid"] is True
