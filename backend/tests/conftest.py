"""Shared test setup: the suite must not depend on the test machine's network.

The analysis path checks that the Earth Engine host resolves before computing (app.services.analysis._ee_reachable).
Tests stub Earth Engine itself, so that DNS check is stubbed to "reachable" unless a test says otherwise.
"""

import os
import tempfile
from pathlib import Path

# Isolate EVERY test run (whichever test file is collected first) before any app module reads its settings:
# no credentials, no network geocoder, and a throwaway cache dir — never the real backend/.cache.
_tmp = tempfile.mkdtemp(prefix="tt-test-")
for _k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "EE_PROJECT", "EE_SERVICE_ACCOUNT_KEY"):
    os.environ.pop(_k, None)
os.environ["ANTHROPIC_CONFIG_DIR"] = str(Path(_tmp) / "no-anthropic")
os.environ["EARTHENGINE_CREDENTIALS"] = str(Path(_tmp) / "no-ee")
os.environ["TT_CACHE_DIR"] = _tmp
os.environ["TT_GEOCODER"] = "off"

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _earth_engine_host_resolves(monkeypatch):
    from app.services import analysis
    monkeypatch.setattr(analysis, "_ee_reachable", lambda: True)


PNG = b"\x89PNG\r\n\x1a\n" + b"fake-tile"


class FakeEeTiles:
    """Stands in for Earth Engine's tile server: records requested URLs; `status` maps URL substrings to a list of
    HTTP statuses to answer in turn (default 200 with PNG bytes that encode the URL)."""

    def __init__(self):
        import threading
        self.urls: list[str] = []
        self.status: dict[str, list[int]] = {}
        self.delay = 0.0
        self.active = self.peak = 0
        self._lock = threading.Lock()

    def handler(self, request):
        import time

        import httpx
        url = str(request.url)
        with self._lock:
            self.urls.append(url)
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            if self.delay:
                time.sleep(self.delay)
            for frag, codes in self.status.items():
                if frag in url and codes:
                    code = codes.pop(0)
                    if code != 200:
                        return httpx.Response(code, headers={"content-type": "application/json"}, content=b"{}")
            return httpx.Response(200, headers={"content-type": "image/png"}, content=PNG + url.encode())
        finally:
            with self._lock:
                self.active -= 1


@pytest.fixture(autouse=True)
def fake_ee_tiles(monkeypatch):
    """No test reaches the real Earth Engine tile server; every test starts with an empty tile cache."""
    import shutil

    import httpx

    from app.services import tiles
    assert tiles.TILES.parent.name.startswith("tt-test-"), "tile cache must be a test temporary dir, never backend/.cache"
    fake = FakeEeTiles()
    monkeypatch.setattr(tiles, "_client", httpx.Client(transport=httpx.MockTransport(fake.handler)))
    monkeypatch.setattr(tiles, "BACKOFF_S", (0.01, 0.01, 0.01, 0.01))
    tiles._memory.clear()
    shutil.rmtree(tiles.TILES, ignore_errors=True)
    yield fake
    tiles._memory.clear()


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
