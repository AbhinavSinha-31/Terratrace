"""Shared test setup: the suite must not depend on the test machine's network.

The analysis path checks that the Earth Engine host resolves before computing (app.services.analysis._ee_reachable).
Tests stub Earth Engine itself, so that DNS check is stubbed to "reachable" unless a test says otherwise.
"""

import pytest


@pytest.fixture(autouse=True)
def _earth_engine_host_resolves(monkeypatch):
    from app.services import analysis
    monkeypatch.setattr(analysis, "_ee_reachable", lambda: True)


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    """Each test starts with empty per-client request counters (the suite itself sends many requests)."""
    from app import ratelimit
    ratelimit.limiter.reset()
    yield
    ratelimit.limiter.reset()


# A real custom AOI over the interactive limit (and under the 2,500 km² selection limit), with no declared analysis
# subset — the case "too large to analyse interactively" that featured regions no longer exercise.
OVERSIZED_BBOX = (10.0, 0.0, 10.4, 0.4)   # ≈ 1,970 km² at the equator


@pytest.fixture
def oversized_aoi():
    from app.services import analysis
    from app.services.geometry import bbox_polygon
    aid, doc = analysis.register_aoi(bbox_polygon(OVERSIZED_BBOX), "Oversized test area")
    assert 1500 < doc["area_km2"] < 2500
    return aid, doc["area_km2"]
