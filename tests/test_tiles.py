"""Earth Engine tiles are fetched by the backend: cached, single-flight, concurrency-capped, retried with backoff.

Regression (2026-10-09): tiles loaded partially with black gaps under "temporarily throttled". Every tile was
recomputed by Earth Engine on every view (the browser was redirected straight to Earth Engine, nothing cached the
pixels), concurrency was capped only per browser tab, and a cold layer built one map ID per concurrent request.
"""

import concurrent.futures
import os
import time

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services import analysis, tiles

client = TestClient(app, raise_server_exceptions=False)
TEMPLATE = "https://earthengine.example/maps/m1/tiles/{z}/{x}/{y}"


@pytest.fixture
def layer(monkeypatch):
    """An analysis layer whose map ID is built by a counted, fake Earth Engine call."""
    builds = []

    def build(key, aid, kind, year, geometry, baseline):
        builds.append(key)
        time.sleep(0.05)   # long enough for concurrent requests to overlap
        analysis.ee_provider.store_mapid(key, TEMPLATE)
        return TEMPLATE

    monkeypatch.setattr(analysis.ee_provider, "_build_tile_url", build)
    analysis.ee_provider._mapids.clear()
    yield builds
    analysis.ee_provider._mapids.clear()


def tile(x=1, y=1, z=3, year=2020):
    return client.get(f"/api/tiles/silent-valley/forest/{year}/{z}/{x}/{y}")


def test_a_cached_tile_is_served_without_any_earth_engine_call(layer, fake_ee_tiles):
    first = tile()
    assert first.status_code == 200 and first.headers["content-type"] == "image/png"
    assert fake_ee_tiles.urls == ["https://earthengine.example/maps/m1/tiles/3/1/1"] and len(layer) == 1
    analysis.ee_provider._mapids.clear()           # like a backend restart: no map ID in memory
    tiles._memory.clear()                          # ... and nothing in memory: the disk cache serves it
    again = tile()
    assert again.status_code == 200 and again.content == first.content
    assert len(fake_ee_tiles.urls) == 1 and len(layer) == 1, "no tile fetch and no map-ID build for a cached tile"


def test_concurrent_requests_for_a_cold_layer_build_one_map_id(layer):
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        codes = list(pool.map(lambda x: tile(x=x).status_code, range(8)))
    assert codes == [200] * 8 and len(layer) == 1, "one getMapId for the whole burst"


def test_identical_concurrent_tile_requests_share_one_fetch(layer, fake_ee_tiles):
    fake_ee_tiles.delay = 0.2
    with concurrent.futures.ThreadPoolExecutor(6) as pool:
        codes = list(pool.map(lambda _: tile().status_code, range(6)))
    assert codes == [200] * 6 and len(fake_ee_tiles.urls) == 1


def test_earth_engine_fetches_never_exceed_the_backend_wide_cap(layer, fake_ee_tiles):
    fake_ee_tiles.delay = 0.1
    with concurrent.futures.ThreadPoolExecutor(12) as pool:
        codes = list(pool.map(lambda x: tile(x=x % 8, y=x // 8).status_code, range(12)))
    assert codes == [200] * 12 and len(fake_ee_tiles.urls) == 12
    assert fake_ee_tiles.peak <= settings.ee_tile_concurrency


def test_throttled_tiles_are_retried_with_backoff(layer, fake_ee_tiles):
    fake_ee_tiles.status["/3/1/1"] = [429, 503]
    r = tile()
    assert r.status_code == 200 and len(fake_ee_tiles.urls) == 3


def test_a_tile_still_throttled_after_the_retries_is_a_retryable_error_never_an_image(layer, fake_ee_tiles):
    fake_ee_tiles.status["/3/1/1"] = [429] * (len(tiles.BACKOFF_S) + 1)
    r = tile()
    assert r.status_code == 503 and r.json()["detail"] == {**r.json()["detail"], "code": "tiles_unavailable", "retryable": True}
    assert len(fake_ee_tiles.urls) == len(tiles.BACKOFF_S) + 1
    assert tiles.cached(tiles.cache_key("forest", "silent-valley", 2020, 3, 1, 1)) is None, "a failure is never cached"
    fake_ee_tiles.status.clear()
    assert tile().status_code == 200, "a later request fetches it normally"


def test_an_expired_map_id_is_rebuilt_once(layer, fake_ee_tiles):
    fake_ee_tiles.status["/3/1/1"] = [403]
    r = tile()
    assert r.status_code == 200 and len(layer) == 2 and len(fake_ee_tiles.urls) == 2


def test_a_map_id_rejected_twice_is_a_retryable_error(layer, fake_ee_tiles):
    fake_ee_tiles.status["/3/1/1"] = [403, 403]
    assert tile().status_code == 503 and len(layer) == 2


def test_tile_cache_keys_carry_the_method_version_and_layer():
    k = tiles.cache_key("change:2019", "silent-valley", 2024, 3, 1, 2)
    assert k.startswith(f"{tiles.sc.METHOD_VERSION}/") and "change-2019" in k
    assert k != tiles.cache_key("forest", "silent-valley", 2024, 3, 1, 2)
    assert tiles.cache_key("forest", "silent-valley", 2024, 3, 1, 2) != tiles.cache_key("forest", "silent-valley", 2023, 3, 1, 2)


def test_eviction_removes_the_oldest_tiles_first():
    for i in range(10):
        tiles._store(f"k{i}", b"x" * 1000)
        p = tiles._path(f"k{i}")
        t = time.time() - 1000 + i
        os.utime(p, (t, t))
    removed = tiles.evict(limit_bytes=5000)
    left = [i for i in range(10) if tiles._path(f"k{i}").exists()]
    assert removed == 6 and left == [6, 7, 8, 9]


def test_a_full_queue_answers_503_immediately(layer, monkeypatch):
    monkeypatch.setattr(tiles, "MAX_QUEUED", 0)
    r = tile()
    assert r.status_code == 503 and r.json()["detail"]["retryable"] is True
