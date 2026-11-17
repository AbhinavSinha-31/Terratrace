"""Featured investigations open with real stored results; the overview totals come from stored READY results.

Regression (2026-10-09): the Explore overview said "No completed live analyses" — it only counted results this
browser had run in this session, featured results were never pre-computed, and cards queried a fixed 2018→2025
window that some sites cannot analyse.
"""


import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import analysis, featured, imagery
from app.services import science as sc

client = TestClient(app, raise_server_exceptions=False)


def avail(aid: str, analysable: dict[int, bool]) -> None:
    """Store a MEASURED availability document for `aid` (as imagery.availability would)."""
    years = imagery.candidate_years()
    doc = {"aoi_id": aid, "method_version": sc.METHOD_VERSION, "years": [{"year": y, "analysable": analysable.get(y, True)} for y in years]}
    imagery._save(imagery._cache_key(aid, years), doc)


@pytest.fixture(autouse=True)
def clean():
    imagery._availability.clear()
    analysis._results.clear()
    for f in list(analysis.RESULTS.glob("*.json")) if analysis.RESULTS.exists() else []:
        f.unlink()
    for f in list(imagery.CACHE.glob("*.json")) if imagery.CACHE.exists() else []:
        f.unlink()
    yield
    imagery._availability.clear()
    analysis._results.clear()


def ready_result(aid: str = "hasdeo-arand", events_ha=(12.5, 30.0)) -> dict:
    """The shape of a stored READY result (only the fields these tests read)."""
    feats = [{"id": f"TT-X-2025-{i:02d}", "properties": {"area_ha": a}} for i, a in enumerate(events_ha, 1)]
    return {"status": "READY", "reasonCode": None, "reason": None, "quality": {"years": [], "issues": []},
            "summary": {"aoi": {"id": aid}, "kpis": {"baseline_year": 2019, "latest_year": 2025, "gross_loss_ha": 900.0, "gross_gain_ha": 800.0,
                                 "net_change_ha": -100.0, "total_loss_ha": 900.0, "total_gain_ha": 800.0}, "years": []},
            "events": {"type": "FeatureCollection", "features": feats}, "layers": {}}


def store(aid, b, c, result):
    analysis._save_result(analysis._key(aid, b, c), result, analysis.aoi_doc(aid)["geometry"])


def test_default_window_moves_inward_to_measured_analysable_years():
    assert featured.default_window("hasdeo-arand") == analysis.DEFAULT_WINDOW, "unmeasured: the standard window"
    avail("hasdeo-arand", {2018: False, 2024: False})
    assert featured.default_window("hasdeo-arand") == (2019, 2025), "2018 not analysable -> 2019; 2025 is"
    avail("similipal", {})
    assert featured.default_window("similipal") == (2018, 2025)


def test_study_areas_carry_their_default_window():
    avail("hasdeo-arand", {2018: False})
    items = {a["id"]: a for a in client.get("/api/study-areas").json()["items"]}
    assert items["hasdeo-arand"]["default_window"] == [2019, 2025] and items["similipal"]["default_window"] == [2018, 2025]


def test_featured_summary_reports_stored_status_and_headline_kpis_without_running_anything(monkeypatch):
    monkeypatch.setattr(analysis, "create_job", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not run")))
    avail("hasdeo-arand", {2018: False})
    store("hasdeo-arand", 2019, 2025, ready_result())
    items = {i["id"]: i for i in client.get("/api/featured/summary").json()["items"]}
    h = items["hasdeo-arand"]
    assert h["status"] == "READY" and h["default_window"] == [2019, 2025]
    assert h["kpis"] == {"event_area_ha": 42.5, "event_count": 2, "baseline_year": 2019, "latest_year": 2025,
                         "gross_loss_ha": 900.0, "gross_gain_ha": 800.0, "net_change_ha": -100.0}
    assert items["similipal"]["status"] == "NOT_RUN" and "kpis" not in items["similipal"]


def test_non_ready_results_carry_no_kpis():
    store("silent-valley", 2018, 2025, {"status": "INVALID_ANALYSIS", "reasonCode": "unstable_forest_mask", "reason": "x",
                                         "quality": {"years": [], "analyzable_window": [2019, 2025],
                                                     "issues": [{"rule": "unstable_forest_mask", "years": [2019, 2020], "message": "x"}]}})
    s = analysis.stored_status("silent-valley", 2018, 2025)
    assert s["status"] == "INVALID_ANALYSIS" and "kpis" not in s


def test_stored_result_endpoint_is_read_only(monkeypatch):
    monkeypatch.setattr(analysis, "create_job", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not run")))
    r = client.get("/api/analysis-result/hasdeo-arand", params={"baseline": 2019, "comparison": 2025})
    assert r.status_code == 200 and r.json() == {"status": "not_computed", "aoi_id": "hasdeo-arand", "window": [2019, 2025]}
    store("hasdeo-arand", 2019, 2025, ready_result())
    env = client.get("/api/analysis-result/hasdeo-arand", params={"baseline": 2019, "comparison": 2025}).json()
    assert env["analysisStatus"] == "READY" and len(env["events"]["features"]) == 2
    assert client.get("/api/analysis-result/../x").status_code == 404
    assert client.get("/api/analysis-result/aoi-000000000000").status_code == 404   # unknown area: still a 404


def test_stored_result_without_years_uses_the_featured_window(monkeypatch):
    """Years omitted → the featured area's own window (its result is stored under it), not the global default."""
    monkeypatch.setattr(featured, "default_window", lambda aid: (2019, 2025))
    store("hasdeo-arand", 2019, 2025, ready_result())
    assert client.get("/api/analysis-result/hasdeo-arand").json()["analysisStatus"] == "READY"
    assert client.get("/api/analysis-status/hasdeo-arand").json()["window"] == [2019, 2025]


def test_precompute_runs_one_site_at_a_time_and_skips_stored_results(monkeypatch):
    running, order = [], []

    class Job:
        def __init__(self, aid, b, c):
            running.append(aid)
            assert len(running) == 1, "never two analyses at once"
            order.append((aid, b, c))
            store(aid, b, c, ready_result(aid))
            running.pop()
            self.future, self.status, self.envelope = None, "COMPLETED", {"analysisStatus": "READY"}

    monkeypatch.setattr(analysis, "create_job", lambda aid, b, c, rid=None: Job(aid, b, c))
    monkeypatch.setattr(featured, "_measure_availability", lambda aid, loop: avail(aid, {2018: aid == "similipal"}))
    store("rondonia-frontier", 2019, 2025, ready_result("rondonia-frontier"))   # already stored -> skipped
    out = dict(featured.precompute())
    assert [o[0] for o in order] == ["hasdeo-arand", "similipal", "silent-valley"]
    assert ("similipal", 2018, 2025) in order and ("hasdeo-arand", 2019, 2025) in order
    assert out["rondonia-frontier"].startswith("stored READY")
    forest = set(featured.forest_ids())
    assert dict(featured.precompute()) == {k: v.replace("READY 2", "stored READY 2") if k in forest and not v.startswith("stored") else v
                                           for k, v in out.items()}


def test_precompute_is_off_in_tests_and_configurable():
    from app.config import settings
    assert settings.precompute_featured is False


def test_a_transient_failure_is_retried_once_after_the_other_sites(monkeypatch):
    """Regression (2026-10-09): Hasdeo's pre-compute hit Earth Engine's Restricted-Mode 429 and stayed NOT_RUN until the
    next restart. A site without a stored outcome is retried once, after the others — never in a loop."""
    attempts = []

    class Job:
        def __init__(self, aid, b, c):
            attempts.append(aid)
            self.future = None
            if aid == "hasdeo-arand" and attempts.count(aid) == 1:   # first attempt: throttled, nothing stored
                self.status, self.envelope = "COMPLETED", {"analysisStatus": "ERROR"}
                return
            store(aid, b, c, ready_result(aid))
            self.status, self.envelope = "COMPLETED", {"analysisStatus": "READY"}

    monkeypatch.setattr(analysis, "create_job", lambda aid, b, c, rid=None: Job(aid, b, c))
    monkeypatch.setattr(featured, "_measure_availability", lambda aid, loop: avail(aid, {2018: False}))
    monkeypatch.setattr(featured, "RETRY_PAUSE_S", 0)
    out = dict(featured.precompute())
    assert attempts.count("hasdeo-arand") == 2 and attempts[-1] == "hasdeo-arand", attempts
    assert out["hasdeo-arand"].startswith("READY") and all(out[k].startswith("READY") for k in featured.forest_ids())
    assert all(out[k].startswith("land") for k in set(out) - set(featured.forest_ids())), "land-focus sites are never retried"


def test_a_site_failing_twice_is_reported_not_retried_forever(monkeypatch):
    calls = []

    class Job:
        def __init__(self, aid, b, c):
            calls.append(aid)
            self.future, self.status, self.envelope = None, "COMPLETED", {"analysisStatus": "ERROR"}

    monkeypatch.setattr(analysis, "create_job", lambda aid, b, c, rid=None: Job(aid, b, c))
    monkeypatch.setattr(featured, "_measure_availability", lambda aid, loop: None)
    monkeypatch.setattr(featured, "RETRY_PAUSE_S", 0)
    out = dict(featured.precompute())
    assert len(calls) == 2 * len(featured.forest_ids()) and all(out[k].startswith("ERROR") for k in featured.forest_ids())
