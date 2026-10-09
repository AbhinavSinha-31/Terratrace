"""Asynchronous analysis jobs: POST creates a job and returns at once; GET reports REAL stages; terminal states carry
the envelope; failures end in UNAVAILABLE / ERROR with a real reason; cancel works. Earth Engine is replaced by fakes."""

import os
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

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
from app.services import analysis  # noqa: E402
from app.services.geometry import bbox_polygon  # noqa: E402

client = TestClient(app)
READY = {"status": "READY", "reasonCode": None, "reason": None, "quality": {"method_version": "x", "issues": []},
         "summary": {"aoi": {"id": "x"}, "kpis": {"total_loss_ha": 1.5}}, "events": {"type": "FeatureCollection", "features": []}, "layers": {"imagery": []}}


@pytest.fixture(autouse=True)
def ee_ready(monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("ready", None))
    monkeypatch.setattr(analysis, "_save_result", lambda *a, **k: None)
    analysis._results.clear()
    yield
    analysis._results.clear()


def poll(job_id, until=("READY", "INVALID_ANALYSIS", "UNAVAILABLE", "ERROR", "CANCELLED"), timeout=10.0):
    seen, t0 = [], time.time()
    while time.time() - t0 < timeout:
        j = client.get(f"/api/analysis-jobs/{job_id}").json()
        if not seen or seen[-1] != j["stage"]:
            seen.append(j["stage"])
        if j["status"] in until:
            return j, seen
        time.sleep(0.02)
    raise AssertionError(f"job did not finish: {seen}")


def test_job_returns_immediately_and_reports_real_stages(monkeypatch):
    gate = threading.Event()

    def staged(*a, on_stage=None, **k):
        for s in ("preparing_imagery", "measuring_coverage", "measuring_forest", "detecting_change", "validating_result"):
            on_stage(s)
            gate.wait(0.08)
        return READY

    monkeypatch.setattr(analysis.ee_provider, "analyze", staged)
    t0 = time.time()
    r = client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2018, "comparison": 2025})
    assert r.status_code == 200 and time.time() - t0 < 1.0, "POST must not wait for the computation"
    job = r.json()
    assert job["status"] in ("QUEUED", "PROCESSING") and job["result"] is None and len(job["job_id"]) == 16
    final, seen = poll(job["job_id"])
    assert final["status"] == "READY" and final["result"]["analysisStatus"] == "READY"
    assert final["result"]["summary"]["kpis"]["total_loss_ha"] == 1.5
    real = ["VALIDATING", "PREPARING_IMAGERY", "MEASURING_OBSERVATION_COVERAGE", "MEASURING_FOREST_COVER", "DETECTING_CHANGE", "VALIDATING_RESULT"]
    assert [s for s in seen if s in real] == [s for s in real if s in seen] and "MEASURING_FOREST_COVER" in seen
    assert [s["stage"] for s in final["stages"]] == real and all(s["duration_s"] is not None for s in final["stages"])


def test_validating_does_no_earth_engine_work(monkeypatch, oversized_aoi):
    calls = []
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, on_stage=None, **k: calls.append(1) or READY)
    job = client.post("/api/analysis-jobs", json={"aoi_id": oversized_aoi[0]}).json()   # over the interactive limit
    final, _ = poll(job["job_id"])
    assert final["status"] == "UNAVAILABLE" and final["result"]["reasonCode"] == "analysis_too_large" and calls == []


def test_identical_requests_join_one_job(monkeypatch):
    calls, gate = [], threading.Event()

    def slow(*a, on_stage=None, **k):
        calls.append(1)
        on_stage("preparing_imagery")
        gate.wait(2)
        return READY

    monkeypatch.setattr(analysis.ee_provider, "analyze", slow)
    a = client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2019, "comparison": 2024}).json()
    b = client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2019, "comparison": 2024}).json()
    assert a["job_id"] == b["job_id"]
    gate.set()
    final, _ = poll(a["job_id"])
    assert final["status"] == "READY" and calls == [1]


@pytest.mark.parametrize("error,status,code", [
    (EarthEngineError("no_imagery", "No Sentinel-2 observations found for 2019 over this area."), "UNAVAILABLE", "insufficient_imagery"),
    (RuntimeError("HTTPSConnectionPool: Max retries exceeded (NameResolutionError getaddrinfo failed)"), "UNAVAILABLE", "earth_engine_unreachable"),
    (RuntimeError("Too Many Requests: Exceeded Earth Engine concurrency limit."), "ERROR", "earth_engine_throttled"),
    (EarthEngineError("analysis_timeout", "deadline passed before events"), "ERROR", "analysis_timeout"),
])
def test_failures_end_in_a_terminal_state_with_a_real_reason(monkeypatch, error, status, code):
    def boom(*a, on_stage=None, **k):
        on_stage("preparing_imagery")
        raise error

    monkeypatch.setattr(analysis.ee_provider, "analyze", boom)
    job = client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2020, "comparison": 2025}).json()
    final, _ = poll(job["job_id"])
    env = final["result"]
    assert final["status"] == status and env["reasonCode"] == code and env["error"]["user_message"]
    assert not env.get("summary") and not env.get("events"), "no measurement on failure"


def test_dynamic_world_unavailable_year_is_reported_not_filled(monkeypatch):
    """A modern year without Dynamic World scenes is excluded with its reason; nothing is estimated for it."""
    from app.providers.earth_engine import provider as p
    counts = {"2018": {"sentinel2": 40, "dynamicWorld": 0}, "2025": {"sentinel2": 120, "dynamicWorld": 60}}
    available, unavailable = p.split_available([2018, 2025], counts)
    assert available == [2025] and unavailable[0]["year"] == 2018 and "Dynamic World" in unavailable[0]["reason"]


def test_honest_timeout_when_earth_engine_never_answers(monkeypatch):
    gate = threading.Event()

    def hung(*a, on_stage=None, **k):
        on_stage("measuring_coverage")
        gate.wait(3)
        return READY

    monkeypatch.setattr(analysis.ee_provider, "analyze", hung)
    monkeypatch.setattr(analysis, "settings", SimpleNamespace(**{**vars(analysis.settings), "ee_timeout_s": 0.2, "ee_request_deadline_s": 0.2}))
    job = client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2019, "comparison": 2023}).json()
    final, _ = poll(job["job_id"], timeout=5)
    gate.set()
    assert final["status"] == "ERROR" and final["result"]["reasonCode"] == "analysis_timeout"
    assert "timed out" in final["result"]["reason"] and not final["result"].get("summary")


def test_invalid_geometry_is_rejected_before_any_job():
    r = client.post("/api/analysis-jobs", json={"geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [0, 0]]]}})
    assert r.status_code == 422 and r.json()["detail"]["code"] in ("invalid_geometry", "invalid_coordinates", "degenerate_polygon", "unsupported_geometry")
    r = client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2025, "comparison": 2018})
    assert r.status_code == 422
    assert client.post("/api/analysis-jobs", json={"aoi_id": "no-such-area"}).status_code == 404


def test_new_geometry_is_registered_and_analysed(monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, on_stage=None, **k: READY)
    job = client.post("/api/analysis-jobs", json={"geometry": bbox_polygon((76.40, 11.00, 76.48, 11.08)), "name": "Test"}).json()
    assert job["analysis_id"].startswith("aoi-")
    final, _ = poll(job["job_id"])
    assert final["status"] == "READY"


def test_insufficient_observation_coverage_is_unavailable_without_measurements(monkeypatch):
    unavailable = {"status": "UNAVAILABLE", "reasonCode": "insufficient_clear_observations",
                   "reason": "Insufficient clear observations: fewer than two modern years in the requested window meet the analysis-quality requirements, so no change detection is possible.",
                   "quality": {"issues": []}}
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, on_stage=None, **k: unavailable)
    final, _ = poll(client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2021, "comparison": 2022}).json()["job_id"])
    assert final["status"] == "UNAVAILABLE" and final["result"]["reasonCode"] == "insufficient_clear_observations" and not final["result"].get("summary")


def test_cancel_stops_at_the_next_stage(monkeypatch):
    gate, stages_after_cancel = threading.Event(), []

    def slow(*a, on_stage=None, **k):
        on_stage("preparing_imagery")
        gate.wait(3)
        try:
            on_stage("measuring_coverage")   # the next stage boundary: cancellation takes effect here
        except analysis.AnalysisCancelled:
            stages_after_cancel.append("stopped")
            raise
        return READY

    monkeypatch.setattr(analysis.ee_provider, "analyze", slow)
    job = client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2018, "comparison": 2024}).json()
    time.sleep(0.1)
    c = client.post(f"/api/analysis-jobs/{job['job_id']}/cancel").json()
    assert c["status"] == "CANCELLED" and c["result"] is None
    gate.set()
    time.sleep(0.2)
    assert stages_after_cancel == ["stopped"]
    assert client.get(f"/api/analysis-jobs/{job['job_id']}").json()["status"] == "CANCELLED"
    assert analysis._key("silent-valley", 2018, 2024) not in analysis._results, "a cancelled job stores nothing"


def test_cached_result_finishes_immediately(monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, **k: pytest.fail("cached results never recompute"))
    analysis._results[analysis._key("silent-valley", 2018, 2025)] = READY
    final, _ = poll(client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley"}).json()["job_id"])
    assert final["status"] == "READY"


def test_unknown_job_is_404():
    assert client.get("/api/analysis-jobs/0123456789abcdef").status_code == 404


def test_history_is_separate_and_never_changes_the_window_result(monkeypatch):
    rows = [{"year": 2016, "era": "modern", "passes_quality": True, "forest_ha": 9000.0, "loss_ha": None}]   # out-of-window modern year
    calls = []

    def hist(*a, scope="window", **k):
        calls.append(scope)
        return {"status": "HISTORY", "years": rows, "periods": [], "history": None, "quality_years": []}

    monkeypatch.setattr(analysis.ee_provider, "analyze", hist)
    analysis._history.clear()
    r = client.get("/api/analysis/silent-valley/history", params={"baseline": 2018, "comparison": 2025})
    assert r.status_code == 200 and r.json()["years"] == rows and calls == ["history"]
    client.get("/api/analysis/silent-valley/history", params={"baseline": 2018, "comparison": 2025})
    assert calls == ["history"], "history is cached"
    analysis._history.clear()


def test_history_without_earth_engine_is_an_error(monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("unconfigured", None))
    analysis._history.clear()
    r = client.get("/api/analysis/silent-valley/history", params={"baseline": 2018, "comparison": 2024})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "service_unavailable"


# ----------------------------------------------------------------------------- request validation on the job API
@pytest.mark.parametrize("body", [
    {"aoi_id": "silent-valley", "baseline": 2025, "comparison": 2018},        # reversed dates
    {"aoi_id": "silent-valley", "baseline": 2020, "comparison": 2020},        # empty window
    {"aoi_id": "silent-valley", "baseline": 1900, "comparison": 2020},        # before the archive
    {"aoi_id": "silent-valley", "baseline": "soon"},                          # malformed type
    {"baseline": 2018, "comparison": 2025},                                   # no area at all
    {"geometry": {"type": "Point", "coordinates": [76.4, 11.0]}},             # not an area
    {"geometry": bbox_polygon((20.0, 0.0, 21.0, 1.0))},                       # ~12,300 km²: far over the 1,500 km² limit
])
def test_bad_requests_are_rejected_before_any_job(monkeypatch, body):
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, **k: pytest.fail("no computation for a rejected request"))
    before = len(analysis._jobs)
    r = client.post("/api/analysis-jobs", json=body)
    assert r.status_code == 422 and len(analysis._jobs) == before


def test_malformed_job_ids_and_unknown_jobs():
    assert client.get("/api/analysis-jobs/not-a-job").status_code == 422
    assert client.post("/api/analysis-jobs/0123456789abcdef/cancel").status_code == 404


def test_duplicate_polling_is_read_only(monkeypatch):
    calls = []
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, on_stage=None, **k: calls.append(1) or READY)
    final, _ = poll(client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2021, "comparison": 2025}).json()["job_id"])
    again = [client.get(f"/api/analysis-jobs/{final['job_id']}").json() for _ in range(5)]
    assert all(j["status"] == "READY" and j["result"] == final["result"] for j in again) and calls == [1]


# ----------------------------------------------------------------------------- lifecycle guarantees
def test_a_cancelled_job_never_becomes_ready_even_if_the_computation_finishes(monkeypatch):
    gate = threading.Event()

    def ignores_cancel(*a, on_stage=None, **k):
        on_stage("detecting_change")
        gate.wait(3)            # an in-flight Earth Engine request cannot be aborted; it returns later
        return READY            # ... and never reaches another stage boundary

    monkeypatch.setattr(analysis.ee_provider, "analyze", ignores_cancel)
    job = client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2018, "comparison": 2023}).json()
    time.sleep(0.1)
    assert client.post(f"/api/analysis-jobs/{job['job_id']}/cancel").json()["status"] == "CANCELLED"
    gate.set()
    time.sleep(0.3)
    after = client.get(f"/api/analysis-jobs/{job['job_id']}").json()
    assert after["status"] == "CANCELLED" and after["result"] is None
    # A NEW request gets a new job (never the cancelled one) and the deterministic result.
    again = client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2018, "comparison": 2023}).json()
    assert again["job_id"] != job["job_id"] and poll(again["job_id"])[0]["status"] == "READY"


def test_cancelling_a_finished_job_changes_nothing(monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, on_stage=None, **k: READY)
    final, _ = poll(client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2019, "comparison": 2025}).json()["job_id"])
    assert client.post(f"/api/analysis-jobs/{final['job_id']}/cancel").json()["status"] == "READY"


@pytest.mark.parametrize("error,code", [
    (EarthEngineError("analysis_timeout", "deadline passed before statistics"), "analysis_timeout"),
    (RuntimeError("Too Many Requests: Exceeded Earth Engine concurrency limit."), "earth_engine_throttled"),
    (ConnectionResetError("Connection aborted: connection reset by peer"), "earth_engine_unreachable"),
])
def test_retryable_failures_are_not_cached_and_retry_recomputes(monkeypatch, error, code):
    attempts = []

    def flaky(*a, on_stage=None, **k):
        on_stage("measuring_coverage")
        attempts.append(1)
        if len(attempts) == 1:
            raise error
        return READY

    monkeypatch.setattr(analysis.ee_provider, "analyze", flaky)
    body = {"aoi_id": "silent-valley", "baseline": 2020, "comparison": 2024}
    first, seen = poll(client.post("/api/analysis-jobs", json=body).json()["job_id"])
    env = first["result"]
    assert env["reasonCode"] == code and env["error"]["retryable"] is True and not env.get("summary")
    assert "VALIDATING" not in seen[-1] and analysis._key("silent-valley", 2020, 2024) not in analysis._results
    retry, _ = poll(client.post("/api/analysis-jobs", json=body).json()["job_id"])
    assert retry["status"] == "READY" and len(attempts) == 2


def test_dns_failure_is_explicit_and_does_not_lock_the_job(monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, on_stage=None, **k: READY)
    monkeypatch.setattr(analysis, "_ee_reachable", lambda: False)
    body = {"aoi_id": "silent-valley", "baseline": 2018, "comparison": 2022}
    down, _ = poll(client.post("/api/analysis-jobs", json=body).json()["job_id"], timeout=3)
    assert down["status"] == "UNAVAILABLE" and down["result"]["reasonCode"] == "earth_engine_unreachable" and not down["result"].get("summary")
    monkeypatch.setattr(analysis, "_ee_reachable", lambda: True)
    up, _ = poll(client.post("/api/analysis-jobs", json=body).json()["job_id"])
    assert up["status"] == "READY"


def test_jobs_beyond_the_worker_pool_wait_visibly_and_then_run(monkeypatch):
    gate, started = threading.Event(), []

    def slow(*a, on_stage=None, **k):
        started.append(1)
        on_stage("preparing_imagery")
        gate.wait(5)
        return READY

    monkeypatch.setattr(analysis.ee_provider, "analyze", slow)
    workers = analysis._POOL._max_workers
    try:
        jobs = [client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2016 + i, "comparison": 2025}).json()
                for i in range(workers + 1)]
        time.sleep(0.3)
        extra = client.get(f"/api/analysis-jobs/{jobs[-1]['job_id']}").json()
        assert len(started) == workers and extra["status"] == "QUEUED" and extra["stage"] == "QUEUED" and extra["result"] is None
    finally:
        gate.set()
    assert all(poll(j["job_id"])[0]["status"] == "READY" for j in jobs)


def test_history_failure_never_touches_the_window_result(monkeypatch):
    analysis._results[analysis._key("silent-valley", 2017, 2025)] = READY
    analysis._history.clear()

    def hist_fails(*a, scope="window", **k):
        assert scope == "history"
        raise RuntimeError("Too Many Requests: Exceeded Earth Engine concurrency limit.")

    monkeypatch.setattr(analysis.ee_provider, "analyze", hist_fails)
    r = client.get("/api/analysis/silent-valley/history", params={"baseline": 2017, "comparison": 2025})
    assert r.status_code >= 500 and "years" not in r.json()
    final, _ = poll(client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2017, "comparison": 2025}).json()["job_id"])
    assert final["status"] == "READY" and final["result"]["summary"]["kpis"]["total_loss_ha"] == 1.5


# ----------------------------------------------------------------------------- deterministic AOI validation (area limit)
STALE_INVALID = {**READY, "status": "INVALID_ANALYSIS", "reasonCode": "unstable_forest_mask", "reason": "stale",
                 "quality": {"method_version": "x", "issues": [{"rule": "unstable_forest_mask", "years": [2019, 2020], "message": "x"}]}}


@pytest.mark.parametrize("stored", ["invalid", "ready"])
def test_oversized_area_is_too_large_even_with_a_stored_result(monkeypatch, oversized_aoi, stored):
    """A result stored before the limit applied must never be served for an area over the limit (no exceptions)."""
    aid = oversized_aoi[0]
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, **k: pytest.fail("an oversized area is never analysed"))
    analysis._results[analysis._key(aid, 2018, 2025)] = STALE_INVALID if stored == "invalid" else READY
    final, seen = poll(client.post("/api/analysis-jobs", json={"aoi_id": aid, "baseline": 2018, "comparison": 2025}).json()["job_id"])
    env = final["result"]
    assert final["status"] == "UNAVAILABLE" and env["reasonCode"] == "analysis_too_large" and env["error"]["retryable"] is False
    assert env["limits"]["maximum_area_km2"] == 1500 and env["limits"]["selected_area_km2"] > 1500
    assert "exceeds TerraTrace's 1,500 km² limit" in env["reason"] and not env.get("summary")
    st = client.get(f"/api/analysis-status/{aid}", params={"baseline": 2018, "comparison": 2025}).json()
    assert st["status"] == "UNAVAILABLE" and st["reasonCode"] == "analysis_too_large" and st["selected_area_km2"] > 1500
    h = client.get(f"/api/analysis/{aid}/history", params={"baseline": 2018, "comparison": 2025})
    assert h.status_code == 422 and h.json()["detail"]["code"] == "analysis_too_large"


@pytest.mark.parametrize("aid", ["hasdeo-arand", "silent-valley"])
def test_areas_within_the_limit_proceed_to_the_scientific_analysis(monkeypatch, aid):
    calls = []
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, on_stage=None, **k: calls.append(1) or STALE_INVALID)
    final, _ = poll(client.post("/api/analysis-jobs", json={"aoi_id": aid, "baseline": 2018, "comparison": 2025}).json()["job_id"])
    assert calls == [1] and final["status"] == "INVALID_ANALYSIS" and final["result"]["reasonCode"] == "unstable_forest_mask"
    assert not final["result"].get("summary"), "no measurement outside READY"


def test_a_timed_out_job_still_caches_the_result_its_last_request_returned(monkeypatch):
    """Regression (Rondônia, 2026-10-07): the budget expired at 301 s while the LAST Earth Engine request was in flight;
    it returned 9 s later and the finished result was discarded at the pure-Python 'validating_result' stage, so a Retry
    recomputed everything. The job must stay an honest timeout (never READY), and the Retry must get the stored result."""
    gate, calls = threading.Event(), []

    def slow_last_request(*a, on_stage=None, **k):
        calls.append(1)
        if len(calls) == 1:
            on_stage("detecting_change")
            gate.wait(3)                      # the in-flight request outlives the job budget
            on_stage("validating_result")     # no Earth Engine work left
        return READY

    monkeypatch.setattr(analysis.ee_provider, "analyze", slow_last_request)
    monkeypatch.setattr(analysis, "settings", SimpleNamespace(**{**vars(analysis.settings), "ee_timeout_s": 0.2, "ee_request_deadline_s": 0.2}))
    body = {"aoi_id": "silent-valley", "baseline": 2019, "comparison": 2024}
    job = client.post("/api/analysis-jobs", json=body).json()
    final, _ = poll(job["job_id"], timeout=5)
    assert final["status"] == "ERROR" and final["result"]["reasonCode"] == "analysis_timeout"
    gate.set()
    for _ in range(100):                      # the worker finishes in the background and caches the result
        if analysis._results.get(analysis._key("silent-valley", 2019, 2024)):
            break
        time.sleep(0.02)
    assert client.get(f"/api/analysis-jobs/{job['job_id']}").json()["status"] == "ERROR"   # first terminal state kept
    again = client.post("/api/analysis-jobs", json=body).json()
    assert poll(again["job_id"])[0]["status"] == "READY" and len(calls) == 1               # served, not recomputed


@pytest.mark.parametrize("terminal", ["ERROR", "CANCELLED", "INVALID_ANALYSIS", "UNAVAILABLE"])
def test_a_terminal_job_state_never_changes(terminal):
    """Strict state machine: no stage or later outcome can move a job out of a terminal state (never ERROR -> READY)."""
    job = analysis.Job("silent-valley", {"name": "x", "area_km2": 1}, 2019, 2024, "k")
    job.enter("measuring_coverage")
    job.finish({"analysisStatus": terminal} if terminal != "CANCELLED" else None, status=terminal if terminal == "CANCELLED" else None)
    job.enter("validating_result")
    job.finish({"analysisStatus": "READY"})
    assert job.status == terminal and job.public()["status"] == terminal and job.done


def test_processing_reaches_ready_only_with_a_ready_envelope():
    job = analysis.Job("silent-valley", {"name": "x", "area_km2": 1}, 2019, 2024, "k")
    job.enter("measuring_coverage")
    assert job.public()["status"] == "PROCESSING" and job.public()["result"] is None
    job.finish({"analysisStatus": "INVALID_ANALYSIS"})
    assert job.public()["status"] == "INVALID_ANALYSIS"
    job2 = analysis.Job("silent-valley", {"name": "x", "area_km2": 1}, 2019, 2024, "k")
    job2.finish(None)                                   # no envelope at all -> ERROR, never READY
    assert job2.status == "ERROR"


def test_every_finished_job_logs_one_structured_summary_without_secrets(monkeypatch, caplog):
    import json as _json
    import logging
    monkeypatch.setattr(analysis.ee_provider, "analyze", lambda *a, on_stage=None, **k: READY)
    with caplog.at_level(logging.INFO, logger="terratrace.analysis"):
        job = client.post("/api/analysis-jobs", json={"aoi_id": "silent-valley", "baseline": 2019, "comparison": 2022}).json()
        poll(job["job_id"])
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("ANALYSIS_SUMMARY ")]
    assert len(lines) == 1
    rec = _json.loads(lines[0][len("ANALYSIS_SUMMARY "):])
    assert rec["job_id"] == job["job_id"] and rec["analysis_id"] == "silent-valley" and rec["state"] == "READY"
    assert rec["requested_window"] == [2019, 2022] and rec["geometry_bbox"] and rec["investigation"]
    assert not any(s in lines[0].lower() for s in ("token", "credential", "private_key", "password"))
