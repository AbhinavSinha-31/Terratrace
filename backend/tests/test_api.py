"""Backend tests — offline, with every credential removed.

The rule under test: NO SIMULATED SCIENTIFIC RESULTS. Without Earth Engine the
API returns explicit UNAVAILABLE envelopes and never any metrics.

    .venv/Scripts/python -m pytest -q
"""

import os
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="tt-test-")
for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "EE_PROJECT", "EE_SERVICE_ACCOUNT_KEY"):
    os.environ.pop(k, None)
os.environ["ANTHROPIC_CONFIG_DIR"] = str(Path(_tmp) / "no-anthropic")
os.environ["EARTHENGINE_CREDENTIALS"] = str(Path(_tmp) / "no-ee")
os.environ["TT_CACHE_DIR"] = _tmp
os.environ["TT_GEOCODER"] = "off"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.services import analysis  # noqa: E402
from app.services.explanation.service import fact_check  # noqa: E402
from app.services.geometry import AoiError, bbox_polygon, validate_aoi  # noqa: E402

client = TestClient(app)
REPO = Path(__file__).resolve().parents[2]
SMALL = bbox_polygon((76.40, 11.00, 76.48, 11.08))  # ~77 km², Western Ghats
METRIC_KEYS = {"summary", "events", "layers"}
FEATURED = ["rondonia-frontier", "hasdeo-arand", "similipal", "silent-valley"]


# ----------------------------------------------------------------------------- no simulation anywhere
def test_no_simulation_code_or_data_in_repository():
    assert not (REPO / "backend" / "app" / "providers" / "demo").exists(), "demo/simulator provider must not exist"
    assert not (REPO / "frontend" / "scripts" / "generate-demo-data.mjs").exists(), "demo data generator must not exist"
    assert not (REPO / "frontend" / "public" / "data" / "aoi").exists(), "simulated per-AOI results must not exist"
    for py in (REPO / "backend" / "app").rglob("*.py"):
        text = py.read_text(encoding="utf-8").lower()
        assert "simulat" not in text or "never" in text or "no simulated" in text, f"{py.name} mentions simulation"


def test_featured_investigations_carry_no_metrics():
    items = client.get("/api/study-areas").json()["items"]
    assert [a["id"] for a in items] == FEATURED
    for a in items:
        assert not ({"kpis", "event_count", "total_loss_ha", "net_change_pct", "events"} & set(a)), f"{a['id']} carries metrics"
        assert a["featured"] is True and a["geometry"]["type"] == "Polygon"


def test_health_reports_live_mode_unconfigured():
    h = client.get("/api/health").json()
    assert h["dataMode"] == "LIVE"
    assert h["analysis"]["status"] == "unconfigured"
    assert "demo" not in str(h).lower()


# ----------------------------------------------------------------------------- unavailable envelopes
@pytest.mark.parametrize("aid", FEATURED)
def test_featured_analysis_unavailable_without_earth_engine(aid):
    r = client.get(f"/api/analysis/{aid}")
    assert r.status_code == 200
    env = r.json()
    assert env["dataMode"] == "LIVE" and env["analysisStatus"] == "UNAVAILABLE"
    # Deterministic AOI validation comes first, whatever the service state — on what is ANALYSED (a featured region's
    # declared subset, else the AOI itself).
    assert env["analysis_area"]["area_km2"] <= env["aoi"]["area_km2"]
    if env["analysis_area"]["area_km2"] > 1500:
        assert env["reasonCode"] == "analysis_too_large" and env["error"]["retryable"] is False
        assert "exceeds TerraTrace's 1,500 km² limit" in env["reason"]
    else:
        assert env["reasonCode"] == "service_unavailable" and env["error"]["retryable"] is True
        assert env["reason"].startswith("Live Earth observation is temporarily unavailable")
    assert not any(env.get(k) for k in METRIC_KEYS), "no metrics may be returned when unavailable"
    assert env["source"] == {"landsat": False, "sentinel2": False, "dynamicWorld": False, "hansen": False}
    assert env["aoi"]["id"] == aid


@pytest.mark.parametrize("path", ["events", "stats", "layers"])
def test_removed_subset_endpoints_are_gone(path):
    """Dead routes removed in the canonical rebuild (no product consumer)."""
    assert client.get(f"/api/analysis/similipal/{path}").status_code == 404


def test_analyze_custom_aoi_returns_unavailable_with_the_same_geometry():
    r = client.post("/api/analyze", json={"geometry": SMALL, "baseline_period": {"year": 2018}, "comparison_period": {"year": 2025}, "name": "Test AOI"})
    assert r.status_code == 200, r.text
    env = r.json()
    assert env["analysisStatus"] == "UNAVAILABLE" and not any(env.get(k) for k in METRIC_KEYS)
    assert env["analysis_id"].startswith("aoi-")
    assert env["aoi"]["geometry"]["coordinates"] == SMALL["coordinates"], "the analysed geometry must be exactly the user's"
    assert env["aoi"]["area_km2"] == pytest.approx(validate_aoi(SMALL).area_km2, abs=0.01)
    # The AOI is registered, so a refresh / shared link resolves to the same area.
    again = client.get(f"/api/analysis/{env['analysis_id']}").json()
    assert again["aoi"]["geometry"] == env["aoi"]["geometry"]


def test_unknown_analysis_404():
    r = client.get("/api/analysis/does-not-exist")
    assert r.status_code == 404 and r.json()["detail"]["code"] == "not_found"


def test_analyze_rejects_huge_and_invalid_aoi():
    r = client.post("/api/analyze", json={"geometry": bbox_polygon((-70, -10, -60, 0))})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "aoi_too_large"
    assert "smaller area" in r.json()["detail"]["message"]
    r = client.post("/api/analyze", json={"geometry": {"type": "Point", "coordinates": [0, 0]}})
    assert r.json()["detail"]["code"] == "unsupported_geometry"
    r = client.post("/api/analyze", json={"geometry": {"type": "Polygon", "coordinates": [[[0, 0], [200, 0], [0, 1], [0, 0]]]}})
    assert r.json()["detail"]["code"] == "invalid_coordinates"
    r = client.post("/api/analyze", json={"geometry": SMALL, "baseline_period": {"year": 2024}, "comparison_period": {"year": 2020}})
    assert r.status_code == 422


# ----------------------------------------------------------------------------- LIVE pass-through (stubbed EE)
def test_ready_results_come_only_from_the_earth_engine_provider(monkeypatch):
    """With EE available, the envelope carries exactly what the EE provider measured."""
    measured = {"status": "READY", "reasonCode": None, "reason": None, "quality": {"method_version": "x"},
                "summary": {"aoi": {"id": "x"}, "kpis": {"total_loss_ha": 12.7}}, "events": {"type": "FeatureCollection", "features": []}, "layers": {"imagery": []}}
    calls = []
    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("ready", None))

    def fake_analyze(aoi, aid, name, b, c, deadline=None, **_):
        calls.append((aid, b, c))
        return measured

    monkeypatch.setattr(analysis.ee_provider, "analyze", fake_analyze)
    monkeypatch.setattr(analysis, "_save_result", lambda *a, **k: None)
    env = client.get("/api/analysis/silent-valley", params={"baseline": 2019, "comparison": 2024}).json()
    assert calls == [("silent-valley", 2019, 2024)]
    assert env["analysisStatus"] == "READY" and env["dataMode"] == "LIVE"
    assert env["summary"]["kpis"]["total_loss_ha"] == 12.7
    assert env["source"]["sentinel2"] and env["source"]["landsat"] and env["source"]["dynamicWorld"]


def test_earth_engine_error_returns_error_state_without_metrics(monkeypatch):
    from app.providers.earth_engine.provider import EarthEngineError

    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("ready", None))

    def boom(*a, **k):
        raise EarthEngineError("no_imagery", "No Sentinel-2 observations found for 2019 over this area.")

    monkeypatch.setattr(analysis.ee_provider, "analyze", boom)
    analysis._results.clear()
    env = client.get("/api/analysis/hasdeo-arand", params={"baseline": 2019, "comparison": 2020}).json()
    assert env["analysisStatus"] == "UNAVAILABLE" and env["reasonCode"] == "insufficient_imagery"
    assert not any(env.get(k) for k in METRIC_KEYS)


# ----------------------------------------------------------------------------- AI
MEASURED_FACTS = {
    "data_mode": "LIVE", "analysis_status": "READY",
    "event_id": "TT-X-2021-01", "study_area": "Test", "region": "R", "biome": "B", "sector": "01",
    "change_type": "clearing", "change_label": "Forest-cover change",
    "period": {"from_year": 2020, "to_year": 2021, "composite_window": "Annual composites"},
    "area": {"hectares": 12.7, "square_km": 0.127}, "share_of_forest_converted": 1.0,
    "ndvi": {"before": 0.8, "after": 0.49, "change": -0.31}, "nbr": {"before": 0.6, "after": 0.38, "change": -0.22},
    "tree_probability": {"before": 0.85, "after": 0.2, "change": -0.65},
    "land_cover": {"before": "trees", "after": "bare"},
    "severity": {"class": "high", "score": 0.66, "basis": "Composite of NDVI decline, share of forest converted and patch size"},
    "confidence": {"class": "high", "score": 0.86, "checks_passed": 5, "checks_evaluated": 5, "checks_pending": 1},
    "evidence": [], "persistence_next_year": 0.86, "min_clear_observations": 12, "reference_overlap_hansen": 0.7,
}


def test_ai_refuses_to_interpret_unavailable_analysis():
    for facts in ({"event_id": "x"}, {**MEASURED_FACTS, "analysis_status": "UNAVAILABLE"}, {**MEASURED_FACTS, "data_mode": "DEMO"}):
        d = client.post("/api/explain", json={"facts": facts}).json()
        assert d["source"] == "none" and d["facts_used"] == 0
        assert "don't have a completed satellite analysis" in d["text"]


# The stored properties of MEASURED_FACTS' event in a READY result (what find_ready_event returns).
STORED_EVENT = {"id": "TT-X-2021-01", "year_from": 2020, "year_to": 2021, "change_type": "clearing", "area_ha": 12.7, "area_km2": 0.127}


def test_ai_explains_measured_facts_with_grounded_briefing(monkeypatch):
    monkeypatch.setattr(analysis, "find_ready_event", lambda eid: STORED_EVENT if eid == STORED_EVENT["id"] else None)
    d = client.post("/api/explain", json={"facts": MEASURED_FACTS}).json()
    assert d["source"] == "template" and d["text"].startswith("What changed:")
    assert fact_check(d["text"], MEASURED_FACTS) == []


def test_ai_withholds_facts_not_backed_by_a_stored_ready_event(monkeypatch):
    """The facts come from the browser: claiming LIVE/READY is not enough. An event that no stored READY result
    contains, or a real event with altered measurements, is never explained."""
    monkeypatch.setattr(analysis, "find_ready_event", lambda eid: STORED_EVENT if eid == STORED_EVENT["id"] else None)
    forged = [
        {**MEASURED_FACTS, "event_id": "TT-FAKE-2021-01"},                       # no such stored event
        {**MEASURED_FACTS, "area": {"hectares": 9999.0, "square_km": 99.99}},   # real event, inflated area
        {**MEASURED_FACTS, "period": {"from_year": 2001, "to_year": 2021, "composite_window": "x"}},
        {**MEASURED_FACTS, "change_type": "fire"},
    ]
    for facts in forged:
        d = client.post("/api/explain", json={"facts": facts}).json()
        assert d["source"] == "none" and d["facts_used"] == 0, facts


def test_ai_rejects_oversized_facts():
    r = client.post("/api/explain", json={"facts": {**MEASURED_FACTS, "notes": "x" * 50_000}})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_request"


def test_fact_check_flags_invented_numbers():
    assert fact_check("About 3,500 ha burned in 2019.", {"area": 20.9, "year": 2021}) == ["3,500", "2019"]


# ----------------------------------------------------------------------------- geometry & search
def test_aoi_preview_measures_area():
    r = client.post("/api/aoi/preview", json={"geometry": SMALL}).json()
    assert r["valid"] and 70 < r["area_km2"] < 85
    big = client.post("/api/aoi/preview", json={"geometry": bbox_polygon((-70, -10, -60, 0))}).json()
    assert big["valid"] is False and big["code"] == "aoi_too_large" and big["area_km2"] > 100000


def test_geometry_area_is_geodesic():
    aoi = validate_aoi(bbox_polygon((0, 0, 1, 1)), enforce_limits=False)
    assert 12300 < aoi.area_km2 < 12400  # 1°×1° at the equator ≈ 12,364 km²
    with pytest.raises(AoiError):
        validate_aoi({"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [0, 0]]]})


def test_search_coordinates_and_featured():
    r = client.get("/api/search", params={"q": "23.123, 77.456"}).json()
    assert r["results"][0]["kind"] == "coordinates" and r["results"][0]["center"] == [77.456, 23.123]
    r = client.get("/api/search", params={"q": "hasdeo"}).json()
    assert r["results"][0]["study_area_id"] == "hasdeo-arand"
    r = client.get("/api/search", params={"q": "Similipal National Park"}).json()
    assert r["results"][0]["study_area_id"] == "similipal", "a featured short name inside a longer query still matches"
    r = client.get("/api/search", params={"q": "western ghats"}).json()
    assert any(x["kind"] == "forest" for x in r["results"])


def test_retry_joins_a_still_running_analysis_instead_of_duplicating_it(monkeypatch):
    """Regression (2026-09-27, Patna 403 km²): after the interactive window ended, a Retry started a second,
    identical Earth Engine computation while the first was still running. A Retry must join the running one."""
    import threading
    import time as _time
    from types import SimpleNamespace

    measured = {"status": "READY", "reasonCode": None, "reason": None, "quality": {"method_version": "x"},
                "summary": {"aoi": {"id": "x"}, "kpis": {"total_loss_ha": 1.0}}, "events": {"type": "FeatureCollection", "features": []}, "layers": {"imagery": []}}
    calls, release = [], threading.Event()

    def slow_analyze(*a, **k):
        calls.append(1)
        release.wait(5)
        return measured

    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("ready", None))
    monkeypatch.setattr(analysis.ee_provider, "analyze", slow_analyze)
    monkeypatch.setattr(analysis, "_save_result", lambda *a, **k: None)
    monkeypatch.setattr(analysis, "settings", SimpleNamespace(**{**vars(analysis.settings), "ee_timeout_s": 0.3}))
    analysis._results.clear()
    params = {"baseline": 2019, "comparison": 2023}
    with TestClient(app) as tc:   # one event loop for all requests, like the real server
        first = tc.get("/api/analysis/silent-valley", params=params).json()
        assert first["analysisStatus"] == "ERROR" and first["reasonCode"] == "analysis_timeout"
        retry = tc.get("/api/analysis/silent-valley", params=params).json()   # still running -> joins it
        assert retry["reasonCode"] == "analysis_timeout" and not retry.get("summary")
        assert len(calls) == 1, "a Retry must not start a duplicate Earth Engine computation"
        release.set()
        _time.sleep(0.3)
        done = tc.get("/api/analysis/silent-valley", params=params).json()
        assert done["analysisStatus"] == "READY" and len(calls) == 1
    analysis._results.clear()


def test_aoi_endpoint_returns_geometry_without_analysis(monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, **k: pytest.fail("the AOI endpoint must never analyse"))
    d = client.get("/api/aoi/similipal").json()
    assert d["id"] == "similipal" and d["geometry"]["type"] == "Polygon" and not ({"summary", "events", "kpis"} & set(d))
    assert client.get("/api/aoi/does-not-exist").status_code == 404


def test_register_aoi_is_cheap_stable_and_matches_analyze(monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, **k: pytest.fail("registering an area must never analyse"))
    a = client.post("/api/aoi", json={"geometry": SMALL, "name": "Search area"}).json()
    b = client.post("/api/aoi", json={"geometry": SMALL}).json()
    assert a["id"].startswith("aoi-") and a["id"] == b["id"], "same geometry -> same id"
    assert a["geometry"]["coordinates"] == SMALL["coordinates"] and not ({"summary", "events", "kpis"} & set(a))
    assert client.get(f"/api/aoi/{a['id']}").json()["id"] == a["id"]
    # the id is exactly the one an explicit Analyze of the same area uses
    env = client.post("/api/analyze", json={"geometry": SMALL, "baseline_period": {"year": 2018}, "comparison_period": {"year": 2025}}).json()
    assert env["analysis_id"] == a["id"]
    too_big = client.post("/api/aoi", json={"geometry": bbox_polygon((-70, -10, -60, 0))})
    assert too_big.status_code == 422 and too_big.json()["detail"]["code"] == "aoi_too_large"


def test_a_stuck_computation_is_not_joined_forever(monkeypatch):
    """Regression: an Earth Engine request hung for hours; every Retry joined it and timed out. A computation older
    than the join window (interactive window + per-request deadline) is abandoned and a fresh one starts."""
    import threading
    from types import SimpleNamespace

    measured = {"status": "READY", "reasonCode": None, "reason": None, "quality": {"method_version": "x"},
                "summary": {"aoi": {"id": "x"}, "kpis": {}}, "events": {"type": "FeatureCollection", "features": []}, "layers": {"imagery": []}}
    calls, hang = [], threading.Event()

    def analyze(*a, **k):
        calls.append(1)
        if len(calls) == 1:
            hang.wait(5)          # the stuck request
            raise RuntimeError("request deadline exceeded")
        return measured

    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("ready", None))
    monkeypatch.setattr(analysis.ee_provider, "analyze", analyze)
    monkeypatch.setattr(analysis, "_save_result", lambda *a, **k: None)
    monkeypatch.setattr(analysis, "settings", SimpleNamespace(**{**vars(analysis.settings), "ee_timeout_s": 0.3, "ee_request_deadline_s": 0.2}))
    analysis._results.clear()
    params = {"baseline": 2020, "comparison": 2024}
    with TestClient(app) as tc:
        assert tc.get("/api/analysis/silent-valley", params=params).json()["reasonCode"] == "analysis_timeout"
        import time as _t
        _t.sleep(0.3)        # older than the join window (0.5 s) — the stuck computation must not be joined
        again = tc.get("/api/analysis/silent-valley", params=params).json()
        assert again["analysisStatus"] == "READY" and len(calls) == 2
        hang.set()   # release the stuck worker before the client shuts its executor down
    analysis._results.clear()


def test_analysis_status_is_read_only_and_reflects_stored_results(monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, **k: pytest.fail("the status endpoint must never analyse"))
    analysis._results.clear()
    params = {"baseline": 2018, "comparison": 2025}
    assert client.get("/api/analysis-status/silent-valley", params=params).json()["status"] == "NOT_RUN"
    analysis._results[analysis._key("silent-valley", 2018, 2025)] = {"status": "INVALID_ANALYSIS", "reasonCode": "unstable_forest_mask", "reason": "2019→2020: …"}
    s = client.get("/api/analysis-status/silent-valley", params=params).json()
    assert s["status"] == "INVALID_ANALYSIS" and s["reasonCode"] == "unstable_forest_mask" and "summary" not in s
    assert client.get("/api/analysis-status/nope").status_code == 404
    analysis._results.clear()


def test_unreachable_earth_engine_fails_fast_with_a_clear_reason(monkeypatch):
    """Regression (2026-09-28): DNS for earthengine.googleapis.com failed; the user waited for a generic timeout."""
    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("ready", None))
    monkeypatch.setattr(analysis, "_ee_reachable", lambda: False)
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, **k: pytest.fail("no computation without a network"))
    analysis._results.clear()
    env = client.get("/api/analysis/silent-valley", params={"baseline": 2020, "comparison": 2023}).json()
    assert env["analysisStatus"] == "UNAVAILABLE" and env["reasonCode"] == "earth_engine_unreachable"
    assert env["error"]["retryable"] is True and "network connection" in env["reason"] and not env.get("summary")


def test_cached_results_do_not_need_the_network(monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("ready", None))
    monkeypatch.setattr(analysis, "_ee_reachable", lambda: False)
    analysis._results[analysis._key("silent-valley", 2020, 2023)] = {"status": "INVALID_ANALYSIS", "reasonCode": "unstable_forest_mask", "reason": "r",
                                                                       "quality": {"analyzable_window": [2020, 2023], "issues": [{"rule": "unstable_forest_mask", "years": [2021, 2022], "message": "m"}]}}
    env = client.get("/api/analysis/silent-valley", params={"baseline": 2020, "comparison": 2023}).json()
    assert env["analysisStatus"] == "INVALID_ANALYSIS"
    analysis._results.clear()


@pytest.mark.parametrize("exc,code", [
    (RuntimeError("HTTPSConnectionPool(host='earthengine.googleapis.com', port=443): Max retries exceeded (Caused by NameResolutionError(...getaddrinfo failed))"), "earth_engine_unreachable"),
    (RuntimeError("Too Many Requests: Exceeded Earth Engine concurrency limit. Your project is in Restricted Mode."), "earth_engine_throttled"),
    (RuntimeError("Image.select: Pattern 'x' did not match any bands."), "analysis_failed"),
])
def test_failures_are_classified_by_their_real_cause(monkeypatch, exc, code):
    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("ready", None))

    def boom(*a, **k):
        raise exc

    monkeypatch.setattr(analysis.ee_provider, "analyze", boom)
    analysis._results.clear()
    env = client.get("/api/analysis/silent-valley", params={"baseline": 2019, "comparison": 2022}).json()
    assert env["reasonCode"] == code and env["error"]["retryable"] is True and not env.get("summary")
    assert "getaddrinfo" not in env["reason"] and "Restricted Mode" not in env["reason"], "raw error text never reaches the UI"


def test_a_slow_analysis_may_finish_in_the_background(monkeypatch):
    """Regression: the provider was stopped at the interactive window (120 s), so an analysis needing a bit longer
    could never succeed — every Retry restarted and hit the same wall. The computation must be allowed the whole
    join window, so it finishes, is cached, and a Retry (which joins it) returns the real result."""
    import time as _t
    from types import SimpleNamespace

    seen = {}
    measured = {"status": "READY", "reasonCode": None, "reason": None, "quality": {"method_version": "x"},
                "summary": {"aoi": {"id": "x"}, "kpis": {}}, "events": {"type": "FeatureCollection", "features": []}, "layers": {"imagery": []}}

    def analyze(*a, deadline=None, **k):
        seen["budget"] = deadline - _t.monotonic()
        return measured

    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("ready", None))
    monkeypatch.setattr(analysis.ee_provider, "analyze", analyze)
    monkeypatch.setattr(analysis, "_save_result", lambda *a, **k: None)
    monkeypatch.setattr(analysis, "settings", SimpleNamespace(**{**vars(analysis.settings), "ee_timeout_s": 120.0, "ee_request_deadline_s": 180.0}))
    analysis._results.clear()
    client.get("/api/analysis/silent-valley", params={"baseline": 2021, "comparison": 2024})
    assert 290 < seen["budget"] <= 300, f"background budget {seen['budget']:.0f} s must cover the join window, not only the 120 s wait"
    analysis._results.clear()


def test_liveness_answers_without_earth_engine(monkeypatch):
    from app.providers.earth_engine.provider import provider as ee_provider
    monkeypatch.setattr(ee_provider, "status", lambda: (_ for _ in ()).throw(AssertionError("no Earth Engine call")))
    r = client.get("/api/health/live")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_liveness_fails_when_the_cache_is_not_writable(monkeypatch):
    from app.api import routes
    monkeypatch.setattr(routes, "_cache_writable", lambda: False)
    r = client.get("/api/health/live")
    assert r.status_code == 503 and r.json()["status"] == "cache_not_writable"
