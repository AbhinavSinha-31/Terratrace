"""Public error contract: nothing internal ever reaches the browser.

Every non-READY envelope carries {code, user_message, retryable}; raw exception text, stack
traces, paths, dataset names, environment variables and setup instructions never appear in
API responses. No credentials needed (Earth Engine is faked).
"""

import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient

from app import errors
from app.main import app
from app.services import analysis

client = TestClient(app, raise_server_exceptions=False)

LEAKS = ["Traceback", "EE_PROJECT", "EE_SERVICE_ACCOUNT_KEY", "earthengine", "uvicorn", ".venv", ".env", "backend/",
         "service account", "service-account", "credential", "COPERNICUS/", "GOOGLE/", "reduceRegion", "getInfo", "ya29.",
         "C:\\", "/home/", "localhost", "Exception", "File \""]


def no_leaks(payload) -> list[str]:
    text = json.dumps(payload)
    return [s for s in LEAKS if s.lower() in text.lower()]


@pytest.fixture
def ee_ready(monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("ready", "internal detail: project secret-proj · user credentials"))
    monkeypatch.setattr(analysis, "_save_result", lambda *a, **k: None)
    analysis._results.clear()


def test_every_public_code_has_product_language():
    for code, (msg, retry) in errors.PUBLIC_MESSAGES.items():
        assert msg and isinstance(retry, bool) and not no_leaks(msg), code


def test_raw_exception_text_never_reaches_the_browser(ee_ready, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("Traceback: ee.EEException at C:\\Users\\x\\backend\\.venv reduceRegion getInfo token ya29.SECRET")
    monkeypatch.setattr(analysis.ee_provider, "analyze", boom)
    env = client.get("/api/analysis/silent-valley", params={"baseline": 2018, "comparison": 2025}).json()
    assert env["analysisStatus"] == "ERROR" and env["error"] == errors.public_error("analysis_failed")
    assert env["reason"] == env["error"]["user_message"] and not no_leaks({k: env[k] for k in ("reason", "error")})
    assert "diagnostics" not in env, "diagnostics only with DEV_DIAGNOSTICS=true"
    assert "SECRET" not in json.dumps(env)


def test_timeout_returns_the_public_timeout_state(ee_ready, monkeypatch):
    monkeypatch.setattr(analysis.settings.__class__, "ee_timeout_s", 0.2, raising=False)
    object.__setattr__(analysis.settings, "ee_timeout_s", 0.2)
    try:
        monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, **k: time.sleep(1.0))
        env = client.get("/api/analysis/hasdeo-arand", params={"baseline": 2019, "comparison": 2025}).json()
    finally:
        object.__setattr__(analysis.settings, "ee_timeout_s", 120.0)
    assert env["analysisStatus"] == "ERROR" and env["reasonCode"] == "analysis_timeout"
    assert env["reason"].startswith("The requested analysis exceeded the available computation window")
    assert env["error"]["retryable"] is True and not env.get("summary") and not no_leaks(env["error"])


def test_large_aoi_is_refused_before_any_computation(ee_ready, monkeypatch, oversized_aoi):
    aid, km2 = oversized_aoi
    called = []
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, **k: called.append(1))
    env = client.get(f"/api/analysis/{aid}", params={"baseline": 1984, "comparison": 2025}).json()   # ≈ 1,983 km²
    assert called == [], "no Earth Engine work may start for an over-limit AOI"
    assert env["analysisStatus"] == "UNAVAILABLE" and env["reasonCode"] == "analysis_too_large"
    assert env["reason"].startswith(f"Analysis area exceeds TerraTrace's 1,500 km² limit (selected area: {int(km2 + 0.5):,} km²)")
    assert env["limits"] == {"selected_area_km2": pytest.approx(km2, abs=0.1), "maximum_area_km2": 1500}
    assert env["aoi"]["area_km2"] == pytest.approx(km2, abs=1), "the AOI is never silently reduced"
    assert env["analysis_area"]["subset"] is False, "a drawn AOI is analysed as drawn, never cut to fit"
    assert env["window"] == {"baseline_year": 1984, "comparison_year": 2025}, "the window is never silently reduced"


def test_identical_concurrent_requests_share_one_computation(ee_ready, monkeypatch):
    calls = []

    def slow(*a, **k):
        calls.append(1)
        time.sleep(0.3)
        return {"status": "INVALID_ANALYSIS", "reasonCode": "unstable_forest_mask", "reason": "r", "quality": {}}

    monkeypatch.setattr(analysis.ee_provider, "analyze", slow)

    async def both():
        return await asyncio.gather(analysis.run("hasdeo-arand", 2019, 2024), analysis.run("hasdeo-arand", 2019, 2024))

    a, b = asyncio.run(both())
    assert len(calls) == 1 and a["analysisStatus"] == b["analysisStatus"] == "INVALID_ANALYSIS"


def test_health_reveals_no_configuration_details(ee_ready):
    h = client.get("/api/health").json()
    assert h["analysis"] == {"status": "ready", "detail": "Live Earth observation available"}
    assert "secret-proj" not in json.dumps(h) and not no_leaks(h)


def test_unconfigured_health_is_public(monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("unconfigured", "set EE_PROJECT in backend/.env and run earthengine authenticate"))
    h = client.get("/api/health").json()
    assert h["analysis"]["detail"] == "Live analysis unavailable" and not no_leaks(h)


def test_validation_errors_are_public():
    r = client.post("/api/analyze", json={"geometry": {"type": "Polygon"}, "baseline_period": {"year": 2024}, "comparison_period": {"year": 2020}})
    d = r.json()["detail"]
    assert r.status_code == 422 and set(d) >= {"code", "user_message", "retryable"} and "errors" not in d and not no_leaks(d)


def test_unexpected_server_error_is_generic(monkeypatch):
    def explode():
        raise RuntimeError("secret internals at C:\\backend\\.env")
    monkeypatch.setattr(analysis.registry, "featured", explode)
    r = client.get("/api/study-areas")
    assert r.status_code == 500 and r.json()["detail"]["code"] == "internal_error" and "secret" not in r.text and not no_leaks(r.json())


def test_diagnostics_only_when_explicitly_enabled(monkeypatch):
    assert errors.diagnostics(stage="x") is None
    object.__setattr__(errors.settings, "dev_diagnostics", True)
    try:
        assert errors.diagnostics(stage="earth_engine", error_type="EEException", elapsed_s=3.2) == {"stage": "earth_engine", "error_type": "EEException", "elapsed_s": 3.2}
    finally:
        object.__setattr__(errors.settings, "dev_diagnostics", False)


def test_progress_reports_real_stages_only(ee_ready, monkeypatch):
    seen = []

    def staged(*a, on_stage=None, **k):
        for s in ("preparing_imagery", "measuring_coverage", "measuring_forest", "validating_result"):
            on_stage(s)
            seen.append(analysis.progress("rid-test-0001")["stage"])
        return {"status": "INVALID_ANALYSIS", "reasonCode": "unstable_forest_mask", "reason": "r", "quality": {}}

    monkeypatch.setattr(analysis.ee_provider, "analyze", staged)
    env = asyncio.run(analysis.run("silent-valley", 2020, 2025, "rid-test-0001"))
    assert seen == ["preparing_imagery", "measuring_coverage", "measuring_forest", "validating_result"]
    assert env["analysisStatus"] == "INVALID_ANALYSIS"
    assert analysis.progress("rid-test-0001") == {"stage": None, "elapsed_s": None}, "no stage once finished"
    assert client.get("/api/progress/unknown-rid-123").json() == {"stage": None, "elapsed_s": None}


def test_late_result_is_cached_for_retry(ee_ready, monkeypatch):
    """A computation that finishes after the interactive window is kept, so Retry does not recompute."""
    saved = {}
    monkeypatch.setattr(analysis, "_save_result", lambda key, res, geom: saved.setdefault(key, res))
    object.__setattr__(analysis.settings, "ee_timeout_s", 0.2)
    calls = []

    def slow(*a, **k):
        calls.append(1)
        time.sleep(0.6)
        return {"status": "INVALID_ANALYSIS", "reasonCode": "unstable_forest_mask", "reason": "r", "quality": {}}

    monkeypatch.setattr(analysis.ee_provider, "analyze", slow)
    try:
        async def scenario():
            first = await analysis.run("silent-valley", 2021, 2025)
            await asyncio.sleep(0.8)                       # the computation completes in the background
            second = await analysis.run("silent-valley", 2021, 2025)
            return first, second
        first, second = asyncio.run(scenario())
    finally:
        object.__setattr__(analysis.settings, "ee_timeout_s", 120.0)
    assert first["reasonCode"] == "analysis_timeout"
    assert second["analysisStatus"] == "INVALID_ANALYSIS" and len(calls) == 1, "retry must reuse the late result"
    assert any(k.startswith("silent-valley-2021-2025") for k in saved)


@pytest.mark.parametrize("aid", ["..%5C..%5C..%5Cfrontend%5Cpackage", "..%2F..%2F..%2Ffrontend%2Fpackage", "aoi-..%5Cx"])
def test_aoi_id_cannot_read_files_outside_the_aoi_cache(aid):
    # The AOI id comes from the URL; only ids the backend generates may map to a file.
    for path in (f"/api/aoi/{aid}", f"/api/analysis-status/{aid}"):
        r = client.get(path)
        assert r.status_code == 404, (path, r.text)
        assert "terratrace-frontend" not in r.text


def test_aoi_id_in_query_cannot_read_files_outside_the_aoi_cache():
    r = client.get("/api/imagery", params={"aoi": "../../../frontend/package", "year": 2020})
    assert r.status_code == 404, r.text
