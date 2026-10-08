"""Canonical imagery contract — availability + imagery decision (Earth Engine replaced by fakes).

Rules under test:
- per-year status comes only from REAL measurements (scene counts + observed-area coverage);
- zero usable scenes / insufficient coverage -> NO_USABLE_IMAGERY (no layer, never another year);
- Earth Engine unavailable -> an error, never an invented status;
- imagery is never an analysis; the frontend never builds imagery URLs.
"""

import json
import os
import shutil
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="tt-test-")
os.environ.setdefault("TT_CACHE_DIR", _tmp)
os.environ.setdefault("EARTHENGINE_CREDENTIALS", str(Path(_tmp) / "no-ee"))
os.environ.setdefault("TT_GEOCODER", "off")
for k in ("EE_PROJECT", "EE_SERVICE_ACCOUNT_KEY"):
    os.environ.pop(k, None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.providers.earth_engine.provider import EarthEngineError  # noqa: E402
from app.services import imagery  # noqa: E402
from app.services import science as sc  # noqa: E402

client = TestClient(app)
REPO = Path(__file__).resolve().parents[2]
AID = "silent-valley"   # ~ 90 km², inside the interactive limit
FORBIDDEN_KEYS = {"forest_ha", "forest_pct", "loss_ha", "gain_ha", "kpis", "events", "summary", "total_loss_ha"}

# Measured-shape fixture: {year: {source: scenes}} and reduceRegion sums (ha) as Earth Engine returns them.
AOI_HA = 9000.0
COUNTS = {str(y): ({"landsat": 20} if sc.era_of(y) == "historical" else {"sentinel2": 120, "dynamicWorld": 60}) for y in imagery.candidate_years()}
COUNTS["1995"] = {"landsat": 0}                                # zero scenes -> UNAVAILABLE
COUNTS["2021"] = {"sentinel2": 140, "dynamicWorld": 0}         # a required source missing -> UNAVAILABLE
COVERAGE = {"aoi": AOI_HA, **{f"valid_{y}": AOI_HA * 0.95 for y in imagery.candidate_years()}}
COVERAGE["valid_2018"] = AOI_HA * 0.50                          # scenes exist, coverage below 80 % -> INSUFFICIENT
COVERAGE.pop("valid_2019")                                      # coverage not measurable -> INSUFFICIENT
for y in (1995, 2021):
    COVERAGE.pop(f"valid_{y}")


@pytest.fixture(autouse=True)
def clean_cache():
    imagery._availability.clear()
    shutil.rmtree(imagery.CACHE, ignore_errors=True)
    yield
    imagery._availability.clear()
    shutil.rmtree(imagery.CACHE, ignore_errors=True)


@pytest.fixture
def fake_ee(monkeypatch):
    calls = []
    monkeypatch.setattr(imagery, "_service_unavailable", lambda: False)

    def measure(geometry, years, deadline=None):
        calls.append(list(years))
        return {"counts": COUNTS, "coverage": COVERAGE}

    monkeypatch.setattr(imagery.ee_provider, "measure_imagery", measure)
    return calls


def by_year(doc):
    return {e["year"]: e for e in doc["years"]}


# ----------------------------------------------------------------------------- availability
def test_availability_statuses_come_from_measurements(fake_ee):
    r = client.get("/api/imagery/availability", params={"aoi": AID})
    assert r.status_code == 200, r.text
    doc = r.json()
    y = by_year(doc)
    assert [e["year"] for e in doc["years"]] == imagery.candidate_years()
    assert doc["method_version"] == sc.METHOD_VERSION and doc["thresholds"]["min_year_coverage"] == sc.MIN_YEAR_COVERAGE
    # AVAILABLE: measured coverage >= 80 %
    assert y[2020]["status"] == "AVAILABLE" and y[2020]["coverage"] == 0.95 and y[2020]["sceneCount"] == 120 and y[2020]["reason"] is None
    assert y[2000]["status"] == "AVAILABLE" and y[2000]["sceneCount"] == 20 and "Landsat" in y[2000]["source"]
    # INSUFFICIENT: scenes exist but coverage is below the rule / not measurable
    assert y[2018]["status"] == "INSUFFICIENT" and y[2018]["coverage"] == 0.5 and "50%" in y[2018]["reason"]
    assert y[2019]["status"] == "INSUFFICIENT" and y[2019]["coverage"] is None and y[2019]["reason"] == "Observation coverage could not be measured."
    # UNAVAILABLE: zero scenes of a required source
    assert y[1995]["status"] == "UNAVAILABLE" and y[1995]["sceneCount"] == 0 and y[1995]["coverage"] is None
    assert y[1995]["reason"] == "No Landsat Collection 2 scenes over this area for 1994–1996."
    assert y[2021]["status"] == "UNAVAILABLE" and y[2021]["reason"] == "No Dynamic World scenes over this area in 2021."
    for e in doc["years"]:
        assert e["status"] in ("AVAILABLE", "INSUFFICIENT", "UNAVAILABLE")
        assert not (FORBIDDEN_KEYS & set(e)), "availability must never carry forest/change metrics"


def test_availability_is_measured_once_and_cached(fake_ee):
    client.get("/api/imagery/availability", params={"aoi": AID})
    client.get("/api/imagery/availability", params={"aoi": AID})
    client.get("/api/imagery", params={"aoi": AID, "year": 2020})
    assert len(fake_ee) == 1


def test_availability_without_earth_engine_is_an_error_not_a_status():
    r = client.get("/api/imagery/availability", params={"aoi": AID})
    assert r.status_code == 503
    d = r.json()["detail"]
    assert d["code"] == "service_unavailable" and d["retryable"] is True and "years" not in r.json()


def test_availability_refuses_oversized_area_before_any_computation(fake_ee, oversized_aoi):
    r = client.get("/api/imagery/availability", params={"aoi": oversized_aoi[0]})   # ≈ 1,983 km² > 1,500 km²
    assert r.status_code == 422 and r.json()["detail"]["code"] == "analysis_too_large"
    assert fake_ee == []


def test_availability_unknown_area_404():
    assert client.get("/api/imagery/availability", params={"aoi": "nope"}).status_code == 404


def test_availability_timeout_and_failure_are_errors(monkeypatch):
    monkeypatch.setattr(imagery, "_service_unavailable", lambda: False)

    def timeout(*a, **k):
        raise EarthEngineError("analysis_timeout", "deadline")

    monkeypatch.setattr(imagery.ee_provider, "measure_imagery", timeout)
    r = client.get("/api/imagery/availability", params={"aoi": AID})
    assert r.status_code == 504 and r.json()["detail"]["code"] == "analysis_timeout" and "years" not in r.json()

    def boom(*a, **k):
        raise RuntimeError("ee.EEException: Too many concurrent aggregations /secret/path")

    monkeypatch.setattr(imagery.ee_provider, "measure_imagery", boom)
    r = client.get("/api/imagery/availability", params={"aoi": AID})
    assert r.status_code == 502 and "secret" not in r.text and "EEException" not in r.text


# ----------------------------------------------------------------------------- imagery decision (independent of analysis)
@pytest.fixture
def fake_imagery(monkeypatch):
    """Earth Engine answers with REAL-shaped responses: a scene count and (only if > 0) a map tile template."""
    calls = []
    monkeypatch.setattr(imagery.ee_provider, "status", lambda: ("ready", "ok"))
    scenes = {2020: 118, 2016: 0, 2000: 34}

    def layer(aid, geometry, year):
        calls.append(year)
        n = scenes.get(year, 50)
        url = f"https://earthengine.example/v1/maps/{aid}-{year}/tiles/{{z}}/{{x}}/{{y}}" if n else None
        if url:
            imagery.ee_provider.store_mapid((aid, "aoi-imagery", year), url)
        return {"dataset": "COPERNICUS/S2_SR_HARMONIZED", "dateRange": {"start": f"{year}-01-01", "end": f"{year + 1}-01-01"},
                "sceneCount": n, "bands": ["B4", "B3", "B2"], "tileUrl": url}

    monkeypatch.setattr(imagery.ee_provider, "imagery_layer", layer)
    imagery._decisions.clear()
    yield calls
    imagery._decisions.clear()
    imagery.ee_provider._mapids.clear()


def test_imagery_ready_with_real_scenes(fake_imagery):
    d = client.get("/api/imagery", params={"aoi": AID, "year": 2020}).json()
    assert d["status"] == "READY" and d["source"] == "Earth Engine" and d["dataset"] == "COPERNICUS/S2_SR_HARMONIZED"
    assert d["sceneCount"] == 118 and d["dateRange"] == {"start": "2020-01-01", "end": "2021-01-01"}
    assert d["visualization"]["bands"] == ["B4", "B3", "B2"] and d["visualization"]["max"] == 0.3
    assert d["tileUrl"] == f"/api/imagery/tiles/{AID}/2020/{{z}}/{{x}}/{{y}}"
    assert d["is_analysis"] is False and not (FORBIDDEN_KEYS & set(d))
    # The tile route redirects to the real Earth Engine template (no credentials in the URL we serve).
    r = client.get(f"/api/imagery/tiles/{AID}/2020/10/1/2", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == f"https://earthengine.example/v1/maps/{AID}-2020/tiles/10/1/2"
    assert r.headers["cache-control"] == "private, max-age=600", "tile redirects are cacheable (fewer Earth Engine requests)"


def test_zero_scenes_is_unavailable_without_a_tile_url(fake_imagery):
    d = client.get("/api/imagery", params={"aoi": AID, "year": 2016}).json()
    assert d["status"] == "UNAVAILABLE" and d["code"] == "NO_SENTINEL2_IMAGERY" and d["tileUrl"] is None and d["sceneCount"] == 0
    assert d["message"] == "No Sentinel-2 observations were found for the requested region and period."
    r = client.get(f"/api/imagery/tiles/{AID}/2016/10/1/2", follow_redirects=False)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "tiles_unavailable"


def test_imagery_does_not_depend_on_analysis(fake_imagery, monkeypatch):
    from app.services import analysis
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, **k: pytest.fail("imagery must never run an analysis"))
    d = client.get("/api/imagery", params={"aoi": AID, "year": 2000}).json()
    assert d["status"] == "READY" and d["sceneCount"] == 34


def test_imagery_decision_is_cached(fake_imagery):
    client.get("/api/imagery", params={"aoi": AID, "year": 2020})
    client.get("/api/imagery", params={"aoi": AID, "year": 2020})
    assert fake_imagery == [2020]


def test_invalid_year_and_unknown_area(fake_imagery):
    d = client.get("/api/imagery", params={"aoi": AID, "year": 1986}).json()
    assert d["status"] == "UNAVAILABLE" and d["code"] == "INVALID_DATE_RANGE" and d["tileUrl"] is None
    assert client.get("/api/imagery", params={"aoi": "nope", "year": 2020}).status_code == 404
    assert fake_imagery == []


def test_invalid_geometry(fake_imagery, monkeypatch):
    monkeypatch.setattr(imagery, "aoi_doc", lambda aid: {"geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [0, 0]]]}})
    d = client.get("/api/imagery", params={"aoi": AID, "year": 2020}).json()
    assert d["status"] == "UNAVAILABLE" and d["code"] == "INVALID_GEOMETRY" and fake_imagery == []


def test_earth_engine_unconfigured_is_an_auth_error_never_imagery():
    imagery._decisions.clear()
    d = client.get("/api/imagery", params={"aoi": AID, "year": 2020}).json()
    assert d["status"] == "UNAVAILABLE" and d["code"] == "EARTH_ENGINE_AUTH_ERROR" and d["tileUrl"] is None
    assert "earthengine" not in d["message"].lower() and ".env" not in d["message"]


@pytest.mark.parametrize("detail,code", [
    ("Earth Engine initialisation failed: invalid_grant: Token has been expired or revoked.", "EARTH_ENGINE_AUTH_ERROR"),
    ("Earth Engine initialisation failed: Caller does not have required permission to use project x (403)", "EARTH_ENGINE_PERMISSION_ERROR"),
    ("Earth Engine initialisation failed: HTTPSConnectionPool: Max retries exceeded (NameResolutionError)", "NETWORK_ERROR"),
])
def test_earth_engine_failures_are_classified(monkeypatch, detail, code):
    imagery._decisions.clear()
    monkeypatch.setattr(imagery.ee_provider, "status", lambda: ("error", detail))
    d = client.get("/api/imagery", params={"aoi": AID, "year": 2020}).json()
    assert d["status"] == "UNAVAILABLE" and d["code"] == code and d["tileUrl"] is None
    assert "403" not in d["message"] and "invalid_grant" not in d["message"]


def test_computation_error_is_classified(monkeypatch):
    imagery._decisions.clear()
    monkeypatch.setattr(imagery.ee_provider, "status", lambda: ("ready", "ok"))

    def boom(*a, **k):
        raise RuntimeError("Image.visualize: something failed at /secret/path")

    monkeypatch.setattr(imagery.ee_provider, "imagery_layer", boom)
    d = client.get("/api/imagery", params={"aoi": AID, "year": 2020}).json()
    assert d["status"] == "UNAVAILABLE" and d["code"] == "EARTH_ENGINE_COMPUTATION_ERROR" and "secret" not in str(d)
    assert (AID, 2020) not in imagery._decisions, "failures are not cached"


def test_imagery_reports_measured_timeline_status_when_known(fake_ee, fake_imagery):
    client.get("/api/imagery/availability", params={"aoi": AID})
    d = client.get("/api/imagery", params={"aoi": AID, "year": 2018}).json()
    assert d["status"] == "READY" and d["imageryStatus"] == "INSUFFICIENT"


# ----------------------------------------------------------------------------- basemaps + frontend
def test_basemaps_are_imagery_only_and_match_the_offline_copy():
    b = client.get("/api/imagery/basemaps").json()
    assert {"globe", "hires", "labels", "reference_forest"} <= set(b)
    for k in ("globe", "hires", "labels", "reference_forest"):
        assert b[k]["is_analysis"] is False and b[k]["tiles"]
    # The frontend's offline copy is generated from this endpoint (scripts/export_imagery_config.py) — no drift.
    static = json.loads((REPO / "frontend" / "public" / "data" / "basemaps.json").read_text(encoding="utf-8"))
    assert static == b


IMAGERY_HOSTS = ("tiles.maps.eox.at", "s2cloudless", "arcgisonline.com", "earthenginepartners-hansen", "earthengine.googleapis.com")


def test_frontend_source_constructs_no_imagery_urls():
    offenders = []
    for f in (REPO / "frontend" / "src").rglob("*"):
        if f.suffix in (".ts", ".tsx", ".js", ".mjs"):
            text = f.read_text(encoding="utf-8")
            offenders += [f"{f.relative_to(REPO)}: {h}" for h in IMAGERY_HOSTS if h in text]
    assert offenders == [], offenders


def test_tiles_work_after_a_backend_restart(fake_imagery):
    """Regression (2026-09-28): after a backend restart the in-memory imagery decisions were gone and EVERY tile
    request answered 404, so the map was black everywhere. A tile request must re-create the decision itself."""
    imagery._decisions.clear()
    imagery.ee_provider._mapids.clear()          # nothing in memory, exactly like a fresh process
    r = client.get(f"/api/imagery/tiles/{AID}/2020/10/1/2", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"].endswith("/tiles/10/1/2")
    for x in range(3, 8):                         # the rest of the map's tiles reuse it
        assert client.get(f"/api/imagery/tiles/{AID}/2020/10/{x}/2", follow_redirects=False).status_code == 307
    assert fake_imagery == [2020], "one Earth Engine decision for all tiles"
    # a year without scenes is still refused — never another year's imagery
    assert client.get(f"/api/imagery/tiles/{AID}/2016/10/1/2", follow_redirects=False).status_code == 404


def test_expired_map_ids_are_rebuilt(fake_imagery, monkeypatch):
    client.get("/api/imagery", params={"aoi": AID, "year": 2020})
    monkeypatch.setattr(imagery.ee_provider, "MAPID_TTL_S", -1)       # every cached map id counts as expired
    assert imagery.ee_provider.cached_imagery_url(AID, 2020) is None
    r = client.get(f"/api/imagery/tiles/{AID}/2020/10/1/2", follow_redirects=False)
    assert r.status_code == 307 and fake_imagery == [2020, 2020], "rebuilt from the same real inputs"


def test_tile_failure_caused_by_earth_engine_is_transient(monkeypatch):
    """A network/Earth Engine failure while re-creating a tile's decision is transient (503, retried by the tile
    loader) — only 'no scenes' is a final 404. Otherwise a network blip leaves permanent black tiles."""
    imagery._decisions.clear()
    monkeypatch.setattr(imagery.ee_provider, "status", lambda: ("error", "HTTPSConnectionPool: Max retries exceeded (NameResolutionError)"))
    r = client.get(f"/api/imagery/tiles/{AID}/2020/10/1/2", follow_redirects=False)
    assert r.status_code == 503 and r.json()["detail"]["retryable"] is True
