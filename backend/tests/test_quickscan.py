"""Quick scan (docs/QUICKSCAN_PLAN.md) — offline: Earth Engine is never called.

RAW below is a SYNTHETIC fixture in the exact shape of providers/earth_engine/quickscan.measure's response (round
numbers chosen so every derived value can be checked by hand). It is test data, never a measurement, and is never
served to users.
"""

import concurrent.futures
import json
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.providers.earth_engine import provider as P
from app.providers.earth_engine import quickscan as Q
from app.services import analysis, quickscan

client = TestClient(app, raise_server_exceptions=False)
LEAKS = ["Traceback", "C:\\", "googleapis", "EEException", "token", "credential", "project", "boom"]


def _g(cls, area, low, lst_ha, mean):
    return {"class": cls, "sum": [area, low, lst_ha, lst_ha * mean]}


# 100 km² area: water 2 km², trees 30, crops 40, built 20, bare 8 (ha below). LST means 30 / 32 / 36 / 38 / 40 °C.
RAW = {
    "counts": {"landsat_scenes": 12, "landsat_by_spacecraft": {"LANDSAT_8": 7, "LANDSAT_9": 5},
               "landsat_first_ms": 1735776000000, "landsat_last_ms": 1766880000000, "dw_images": 60, "cci_images": 1},
    "aoi": {"area_ha": 10000.0},
    "classes": {"groups": [_g(0, 200, 10, 200, 30.0), _g(1, 3000, 300, 3000, 32.0), _g(4, 4000, 400, 3900, 36.0),
                           _g(6, 2000, 100, 2000, 38.0), _g(7, 800, 80, 800, 40.0)]},
    "lst": {"lst_mean": 35.2, "lst_p2": 29.1, "lst_p50": 35.0, "lst_p98": 41.7, "lst_count": 110000, "valid_ha": 9900.0},
    "carbon": {"area_ha": 10000.0, "covered_ha": 9500.0, "agb_x_ha": 9500.0 * 50, "sd_x_ha": 9500.0 * 20},
    "worldcover": {"compared_ha": 9900.0, "agree_ha": 7000.0},
}


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    """Empty scan state; jobs run inline; Earth Engine 'configured' (never called: measure is replaced per test)."""
    quickscan._memory.clear()
    quickscan._failures.clear()
    quickscan._running.clear()
    for f in quickscan.CACHE.glob("*.json") if quickscan.CACHE.exists() else []:
        f.unlink()

    def inline(fn, *a):
        fut = concurrent.futures.Future()
        fn(*a)
        fut.set_result(None)
        return fut
    monkeypatch.setattr(quickscan, "_submit", inline)
    monkeypatch.setattr(P.EarthEngineProvider, "credentials_configured", staticmethod(lambda: True))
    monkeypatch.setitem(P.RESTRICTED_MODE, "seen_at", None)
    yield
    quickscan._memory.clear()
    quickscan._failures.clear()
    quickscan._running.clear()


@pytest.fixture
def ee_scan(monkeypatch):
    calls = []
    monkeypatch.setattr(Q, "measure", lambda geometry, year, season: (calls.append((year, season)), json.loads(json.dumps(RAW)))[1])
    return calls


# ----------------------------------------------------------------------------- the research pipeline's code, reused
def test_lst_uses_the_research_pipelines_landsat_code_and_thresholds():
    landsat, cfg = Q.pipeline()
    assert landsat.__name__ == "terratrace_analysis.landsat"
    assert callable(landsat.scenes) and callable(landsat.prepare)
    p = Q.method_parameters()["landsat"]
    assert (p["max_st_uncertainty_k"], p["min_st_emissivity"], p["max_cloud_cover"]) == (
        cfg.max_st_uncertainty_k, cfg.min_st_emissivity, cfg.max_cloud_cover) == (5.0, 0.90, 60)
    assert p["qa_mask"] == landsat.QA_MASK and p["collections"] == ["LANDSAT/LC08/C02/T1_L2", "LANDSAT/LC09/C02/T1_L2"]
    # No masking logic of its own: the quick scan must not re-implement the pipeline's scene masking.
    src = (Q.__file__ and open(Q.__file__, encoding="utf-8").read())
    for copied in ("bitwiseAnd", 'select("QA_', 'select("ST_', "0.00341802", "273.15"):
        assert copied not in src, copied


class _Expr:
    """Records an Earth Engine expression instead of building one (no client library initialisation needed)."""

    def __init__(self, desc):
        self.desc = desc

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Expr(f"{self.desc}.{name}")

    def __call__(self, *a, **k):
        return _Expr(f"{self.desc}()")


def test_measure_builds_one_request_from_the_pipelines_scenes(monkeypatch):
    landsat, cfg = Q.pipeline()
    seen = {}

    class FakeLandsat:
        def scenes(self, c, geom, sensors, ranges):
            seen.update(cfg=c, sensors=sensors, ranges=ranges)
            return _Expr("scenes")

    requests = []
    ee = _Expr("ee")
    monkeypatch.setattr(Q, "pipeline", lambda: (FakeLandsat(), cfg))
    monkeypatch.setattr(Q, "_ee", lambda: ee)
    monkeypatch.setattr(P.provider, "initialize", lambda: None)
    monkeypatch.setattr(_Expr, "getInfo", lambda self: requests.append(self.desc) or {}, raising=False)
    Q.measure({"type": "Polygon", "coordinates": []}, 2025, "jja")
    assert seen == {"cfg": cfg, "sensors": ("LC08", "LC09"), "ranges": [("2025-06-01", "2025-09-01")]}
    assert len(requests) == 1, "a quick scan is ONE Earth Engine request"


@pytest.mark.parametrize("season,expected", [("all", ("2025-01-01", "2026-01-01")), ("mam", ("2025-03-01", "2025-06-01")),
                                             ("son", ("2025-09-01", "2025-12-01")), ("djf", ("2024-12-01", "2025-03-01"))])
def test_season_ranges(season, expected):
    assert Q.season_range(2025, season) == expected


def test_method_version_changes_with_the_method():
    assert quickscan.version().startswith("qs-1-")
    assert Q.method_version({"x": 1}) != Q.method_version()


def test_datasets_and_constants():
    assert Q.CCI_AGB == "ESA/CCI/Above_Ground_Biomass/V6_0" and Q.CCI_YEAR == 2022 and Q.CARBON_FRACTION == 0.47
    assert P.DW == "GOOGLE/DYNAMICWORLD/V1" and P.WORLDCOVER == "ESA/WorldCover/v200"
    assert Q.MIN_SCENES == 5 and Q.LOW_CONFIDENCE == 0.5 and Q.SCALE == 30
    assert [c[0] for c in quickscan.DW_CLASSES] == P.DW_LABELS


# ----------------------------------------------------------------------------- interpretation
def test_parse_land_cover_from_dynamic_world():
    d = quickscan.parse(RAW, year=2025, season="all")
    lc = d["landcover"]
    assert lc["status"] == "READY" and lc["label"] == "Land cover from Dynamic World (Google/WRI), 2025"
    by = {c["key"]: c for c in lc["classes"]}
    assert by["built"]["area_km2"] == 20.0 and by["built"]["share"] == 0.2 and by["trees"]["area_km2"] == 30.0
    assert by["snow_and_ice"]["area_km2"] == 0.0 and by["snow_and_ice"]["low_confidence_share"] is None
    assert round(sum(c["share"] for c in lc["classes"]), 4) == 1.0
    assert lc["low_confidence_share"] == 0.089 and by["trees"]["low_confidence_share"] == 0.1
    assert lc["worldcover_agreement"]["share"] == 0.7071 and "not accuracy" in lc["worldcover_agreement"]["note"]
    assert lc["source"]["id"] == "GOOGLE/DYNAMICWORLD/V1" and lc["source"]["year"] == 2025 and lc["source"]["resolution_m"] == 10


def test_parse_lst_per_class_and_simple_uhi():
    lst = quickscan.parse(RAW, year=2025, season="all")["lst"]
    assert lst["status"] == "READY" and lst["mean_c"] == 35.2 and (lst["p2_c"], lst["p98_c"]) == (29.1, 41.7)
    assert lst["valid_share"] == 0.99 and lst["source"]["scenes"] == 12 and lst["source"]["first_scene"] == "2025-01-02"
    per = {c["key"]: c for c in lst["per_class"]}
    assert per["crops"]["mean_c"] == 36.0 and per["crops"]["area_km2"] == 39.0 and per["water"]["water"] is True
    u = lst["uhi"]
    # built 38 °C vs other land (trees, crops, bare; water excluded) area-weighted: (3000·32 + 3900·36 + 800·40) / 7700
    assert u["status"] == "READY" and u["built_mean_c"] == 38.0 and u["other_mean_c"] == 34.86 and u["value_c"] == 3.14
    assert u["label"] == "Simple surface UHI (built − non-built land, water excluded)"


@pytest.mark.parametrize("built_ha,why", [(400.0, "share"), (150.0, "area")])
def test_uhi_needs_enough_built_up_land(built_ha, why):
    raw = json.loads(json.dumps(RAW))
    if why == "share":   # 400 ha built of a large land area: ≥ 2 km² but < 5 %
        raw["classes"]["groups"] = [_g(1, 9600, 0, 9600, 32.0), _g(6, built_ha, 0, built_ha, 38.0)]
    else:                # 150 ha: under 2 km² although > 5 % of a small area
        raw["classes"]["groups"] = [_g(1, 1000, 0, 1000, 32.0), _g(6, built_ha, 0, built_ha, 38.0)]
    u = quickscan.parse(raw, year=2025, season="all")["lst"]["uhi"]
    assert u["status"] == "UNAVAILABLE" and "value_c" not in u and "Not enough built-up land" in u["reason"]


def test_fewer_than_five_scenes_makes_lst_unavailable_not_estimated():
    raw = json.loads(json.dumps(RAW))
    raw["counts"]["landsat_scenes"], raw["lst"] = 4, None
    d = quickscan.parse(raw, year=2025, season="jja")
    assert d["lst"]["status"] == "UNAVAILABLE" and "mean_c" not in d["lst"]
    assert d["lst"]["reason"] == "Only 4 usable Landsat scenes over this area for June–August 2025; a quick scan needs at least 5."
    assert d["status"] == "READY" and d["landcover"]["status"] == "READY" and d["carbon"]["status"] == "READY"


def test_parse_biomass_carbon_from_esa_cci():
    c = quickscan.parse(RAW, year=2025, season="all")["carbon"]
    comp = c["components"][0]
    assert c["status"] == "READY" and comp["id"] == "agb_trees" and comp["label"] == "Above-ground tree biomass carbon (ESA CCI)"
    # 475,000 Mg biomass × 0.47 = 223,250 t C over 9,500 ha; ± 190,000 × 0.47 = 89,300 t
    assert comp["total_t"] == 223250 and comp["density_t_per_ha"] == 23.5 and comp["range_t"] == [133950, 312550]
    assert comp["coverage_share"] == 0.95 and comp["carbon_fraction"] == 0.47
    assert "soil" in comp["excludes"] and comp["source"] == {"dataset": "ESA CCI Above-Ground Biomass v6.0",
                                                             "id": "ESA/CCI/Above_Ground_Biomass/V6_0", "year": 2022, "resolution_m": 100}
    assert "components" in c and "soil" in c["scope"]   # designed for further carbon pools


def test_carbon_range_never_goes_below_zero():
    raw = json.loads(json.dumps(RAW))
    raw["carbon"]["sd_x_ha"] = raw["carbon"]["agb_x_ha"] * 3
    assert quickscan.parse(raw, year=2025, season="all")["carbon"]["components"][0]["range_t"][0] == 0


@pytest.mark.parametrize("missing", ["classes", "carbon"])
def test_missing_datasets_are_unavailable_never_zero(missing):
    raw = json.loads(json.dumps(RAW))
    raw[missing] = None
    d = quickscan.parse(raw, year=2025, season="all")
    section = d["landcover"] if missing == "classes" else d["carbon"]["components"][0]
    assert section["status"] == "UNAVAILABLE" and section["reason"]
    assert "classes" not in section and "total_t" not in section


def test_every_value_carries_its_dataset_year_and_is_never_a_terratrace_classification():
    d = quickscan.parse(RAW, year=2025, season="all")
    text = json.dumps(d)
    assert "TerraTrace classification" not in text and d["tier"] == "quick_scan"
    assert d["label"] == "Quick scan · public datasets, not validated for this area"
    for section in (d["landcover"], d["lst"], d["carbon"]["components"][0]):
        src = section["source"]
        assert src.get("dataset") and src.get("year") and src.get("resolution_m"), src


# ----------------------------------------------------------------------------- service: jobs, cache, refusals
def test_run_quick_scan_stores_it_and_opens_it_again_without_earth_engine(ee_scan):
    r = client.post("/api/quickscan/hasdeo-arand?year=2025&season=all")
    assert r.status_code == 200 and r.json()["status"] == "READY", r.json()
    doc = r.json()
    assert doc["quickscan_version"] == quickscan.version() and doc["aoi_id"] == "hasdeo-arand" and doc["computed_at"]
    assert ee_scan == [(2025, "all")]
    assert list(quickscan.CACHE.glob("hasdeo-arand-2025-all-qs-1-*.json"))
    quickscan._memory.clear()                                   # from disk this time
    again = client.get("/api/quickscan/hasdeo-arand?year=2025&season=all").json()
    assert again["status"] == "READY" and again["landcover"] == doc["landcover"]
    assert client.post("/api/quickscan/hasdeo-arand?year=2025&season=all").json()["status"] == "READY"
    assert ee_scan == [(2025, "all")], "a stored scan is never recomputed"


def test_status_never_computes(ee_scan):
    r = client.get("/api/quickscan/hasdeo-arand")
    assert r.status_code == 200 and r.json()["status"] == "NOT_RUN" and r.json()["year"] == quickscan.last_year()
    assert ee_scan == []


def test_a_failed_scan_is_unavailable_with_a_public_reason_and_not_stored(monkeypatch):
    def boom(*a):
        raise RuntimeError("boom: googleapis token C:\\secret Traceback")
    monkeypatch.setattr(Q, "measure", boom)
    r = client.post("/api/quickscan/hasdeo-arand?year=2025").json()
    assert r["status"] == "UNAVAILABLE" and r["retryable"] is True and r["reason_code"] == "quickscan_failed"
    assert not any(w in json.dumps(r) for w in LEAKS)
    assert not list(quickscan.CACHE.glob("*.json")) if quickscan.CACHE.exists() else True
    # after the back-off window a new request runs again
    calls = []
    monkeypatch.setattr(Q, "measure", lambda *a: (calls.append(a), json.loads(json.dumps(RAW)))[1])
    key = next(iter(quickscan._failures))
    reason, code, _t = quickscan._failures[key]
    quickscan._failures[key] = (reason, code, time.monotonic() - quickscan.FAILURE_TTL_S - 1)
    assert client.post("/api/quickscan/hasdeo-arand?year=2025").json()["status"] == "READY" and len(calls) == 1


def test_throttling_has_its_own_public_reason(monkeypatch):
    monkeypatch.setattr(Q, "measure", lambda *a: (_ for _ in ()).throw(RuntimeError("429 Too Many Requests")))
    r = client.post("/api/quickscan/hasdeo-arand?year=2025").json()
    assert r["reason_code"] == "ee_throttled" and "throttling" in r["reason"]


def test_restricted_mode_refuses_new_scans_but_stored_scans_still_open(ee_scan, monkeypatch):
    assert client.post("/api/quickscan/hasdeo-arand?year=2025").json()["status"] == "READY"
    monkeypatch.setitem(P.RESTRICTED_MODE, "seen_at", time.time() - 60)
    r = client.post("/api/quickscan/similipal?year=2025").json()
    assert r["status"] == "UNAVAILABLE" and r["reason_code"] == "quota_restricted" and r["retryable"] is True
    assert client.get("/api/quickscan/hasdeo-arand?year=2025").json()["status"] == "READY"
    assert ee_scan == [(2025, "all")]
    # an old restricted-mode warning (outside the window) no longer blocks
    monkeypatch.setitem(P.RESTRICTED_MODE, "seen_at", time.time() - quickscan.RESTRICTED_RECENT_S - 5)
    assert client.post("/api/quickscan/similipal?year=2025").json()["status"] == "READY"


def test_area_over_the_interactive_limit_is_refused(oversized_aoi, ee_scan):
    aid, area = oversized_aoi
    r = client.post(f"/api/quickscan/{aid}?year=2025").json()
    assert r["status"] == "UNAVAILABLE" and r["reason_code"] == "area_too_large" and "1,500 km²" in r["reason"]
    assert ee_scan == []


def test_without_earth_engine_a_scan_is_refused(ee_scan, monkeypatch):
    monkeypatch.setattr(P.EarthEngineProvider, "credentials_configured", staticmethod(lambda: False))
    r = client.post("/api/quickscan/hasdeo-arand?year=2025").json()
    assert r["status"] == "UNAVAILABLE" and r["reason_code"] == "ee_unconfigured" and ee_scan == []


@pytest.mark.parametrize("query", ["year=2015", f"year={quickscan.last_year() + 1}", "season=monsoon"])
def test_invalid_year_or_season_is_a_public_422(query, ee_scan):
    r = client.post(f"/api/quickscan/hasdeo-arand?{query}")
    assert r.status_code == 422 and ee_scan == []


def test_unknown_area_is_404(ee_scan):
    assert client.post("/api/quickscan/aoi-000000000000?year=2025").status_code == 404
    assert client.get("/api/quickscan/aoi-000000000000").status_code == 404


def test_stored_scans_are_keyed_by_method_version(ee_scan):
    assert client.post("/api/quickscan/hasdeo-arand?year=2025").json()["status"] == "READY"
    path = next(quickscan.CACHE.glob("hasdeo-arand-2025-all-*.json"))
    doc = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps({**doc, "quickscan_version": "qs-1-oldmethod"}), encoding="utf-8")
    quickscan._memory.clear()
    assert client.get("/api/quickscan/hasdeo-arand?year=2025").json()["status"] == "NOT_RUN"


def test_quick_scan_starts_are_rate_limited_and_reads_are_not():
    from app import ratelimit
    assert ratelimit.group_of("POST", "/api/quickscan/hasdeo-arand") == "quickscan"
    assert ratelimit.group_of("GET", "/api/quickscan/hasdeo-arand") is None
    assert ratelimit.limit_for("quickscan") == 6


def test_a_quick_scan_never_touches_the_forest_analysis_results(ee_scan):
    before = sorted(p.name for p in analysis.RESULTS.glob("*.json")) if analysis.RESULTS.exists() else []
    assert client.post("/api/quickscan/hasdeo-arand?year=2025").json()["status"] == "READY"
    after = sorted(p.name for p in analysis.RESULTS.glob("*.json")) if analysis.RESULTS.exists() else []
    assert before == after
