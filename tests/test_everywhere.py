"""TerraTrace works for every location on Earth (requirement change 2026-10-10).

Areas without forest open, run and report zero forest honestly; low-forest areas carry a caution; open ocean and
areas outside Sentinel-2's band get an explicit result; change is never reported outside the forest mask.
Reference-context fixtures are REAL Earth Engine responses recorded 2026-10-10 (tests/data/).
"""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.providers.earth_engine import provider as P
from app.services import analysis, context
from app.services import science as sc
from app.services.geometry import bbox_polygon
from app.services.units import fmt_share

client = TestClient(app, raise_server_exceptions=False)
DATA = Path(__file__).parent / "data"
RAW = {n: json.loads((DATA / f"context_{n}_raw_2026-10-10.json").read_text(encoding="utf-8"))
       for n in ("egypt_cropland", "open_ocean", "greenland_ice", "hasdeo")}


def square(lon, lat, half=0.045):
    return bbox_polygon((lon - half, lat - half, lon + half, lat + half))


EGYPT, OCEAN, GREENLAND = square(30.849, 30.997), square(-30.0, -10.0), square(-40.0, 72.0, 0.05)


@pytest.fixture(autouse=True)
def fresh():
    context._memory.clear()
    context._failures.clear()
    analysis._results.clear()
    for f in list(context.CACHE.glob("*.json")) if context.CACHE.exists() else []:
        f.unlink()
    yield
    context._memory.clear()
    context._failures.clear()
    analysis._results.clear()


def ready_result(aid, forest_by_year: dict[int, float], valid_ha=10000.0, events=()):
    """A READY analysis result as the provider returns it (only the fields the envelope and cautions read)."""
    years = [{"year": y, "era": "modern", "passes_quality": True, "forest_ha": f, "valid_ha": valid_ha, "gain_ha": 0.0,
              "loss_ha": 0.0, "previous_year": None} for y, f in forest_by_year.items()]
    ys = sorted(forest_by_year)
    return {"status": "READY", "reasonCode": None, "reason": None, "quality": {"years": [], "issues": []},
            "summary": {"aoi": {"id": aid}, "years": years,
                        "kpis": {"baseline_year": ys[0], "latest_year": ys[-1], "forest_baseline_ha": forest_by_year[ys[0]],
                                 "total_loss_ha": 0.0, "total_gain_ha": 0.0, "gross_loss_ha": 0.0, "gross_gain_ha": 0.0, "event_count": len(events)}},
            "events": {"type": "FeatureCollection", "features": list(events)}, "layers": {}}


def run_job(monkeypatch, geometry, ctx_raw, result=None):
    """Register an area and run its analysis job with Earth Engine faked: context = a recorded response, analysis =
    `result` (None: the analysis must not be called at all)."""
    calls = []
    monkeypatch.setattr(P.provider, "area_context", lambda g: ctx_raw)
    monkeypatch.setattr(analysis.ee_provider, "status", lambda: ("ready", None))
    monkeypatch.setattr(analysis, "_save_result", lambda *a, **k: None)

    def analyze(*a, **k):
        calls.append(1)
        if result is None:
            raise AssertionError("no analysis may run here")
        return result
    monkeypatch.setattr(analysis.ee_provider, "analyze", analyze)
    aid, _ = analysis.register_aoi(geometry, None)
    if result is not None:
        result["summary"]["aoi"]["id"] = aid
    job = analysis.create_job(aid, 2019, 2025)
    job.future.result(timeout=30)
    return job.envelope, calls


# ----------------------------------------------------------------------------- non-forest area (Egypt, Nile delta)
def test_non_forest_reference_context_has_a_meaningful_land_cover_breakdown():
    c = context.parse(RAW["egypt_cropland"])
    assert c["status"] == "READY" and c["surface"]["kind"] == "land"
    lc = c["land_cover_2021"]
    assert lc["status"] == "READY" and lc["source"]["dataset"] == "ESA WorldCover v200" and lc["source"]["year"] == "2021"
    shares = {x["name"]: x["share_pct"] for x in lc["classes"]}
    assert round(shares["Cropland"], 1) == 86.9 and round(shares["Built-up"], 1) == 10.6 and shares["Tree cover"] > 0
    assert [x["name"] for x in lc["classes"]][0] == "Cropland", "largest class first"
    assert abs(sum(shares.values()) - 100) < 0.01
    # tiny but non-zero: never shown as 0, never with false precision
    assert fmt_share(c["forest"]["tree_cover_2000"]["share_of_land_pct"]) == "< 1 %"
    assert fmt_share(shares["Permanent water bodies"]) == "< 1 %"


def test_non_forest_area_opens_runs_and_reports_zero_forest_honestly(monkeypatch):
    env, calls = run_job(monkeypatch, EGYPT, RAW["egypt_cropland"], ready_result("x", {2019: 0.0, 2021: 0.0, 2025: 0.0}))
    assert calls == [1], "the analysis ran"
    assert env["analysisStatus"] == "READY" and env["error"] is None, "a real result, not a failure"
    assert env["events"]["features"] == [] and env["summary"]["kpis"]["forest_baseline_ha"] == 0.0
    codes = [c["code"] for c in env["cautions"]]
    assert codes[0] == "no_forest_to_monitor" and env["cautions"][0]["kind"] == "statement"
    assert "little or no forest to monitor" in env["cautions"][0]["message"] and "0.0 ha in 2019" in env["cautions"][0]["message"]
    assert "not a failure" in env["cautions"][0]["message"]
    assert codes == ["no_forest_to_monitor"], "no redundant little-forest box next to the statement"
    assert "not new forest" in env["cautions"][0]["gain_note"], "the gain figure still carries its warning"
    assert env["context"]["land_cover_2021"]["status"] == "READY"


# ----------------------------------------------------------------------------- low-forest caution
def test_low_forest_area_shows_the_caution_with_datasets_and_years(monkeypatch):
    env, _ = run_job(monkeypatch, EGYPT, RAW["egypt_cropland"], ready_result("x", {2019: 50.0, 2021: 52.0, 2025: 49.0}))
    little = next(c for c in env["cautions"] if c["code"] == "little_forest")
    assert little["kind"] == "caution" and "TerraTrace forest mask 2019" in little["datasets"]
    assert "0.5 %" not in little["message"] and "< 1 %" in little["message"] and "50.0 ha" in little["message"]
    assert little["applies_to"] == ["gross_gain_ha"] and "not new forest" in little["gain_note"]
    assert "no_forest_to_monitor" not in [c["code"] for c in env["cautions"]], "50 ha is above the 2 ha statement threshold"


@pytest.mark.parametrize("forest_ha,valid_ha,expect", [
    (1.9, 10000, {"no_forest_to_monitor"}),           # the statement supersedes the little-forest caution
    (2.0, 10000, {"little_forest"}),                   # exactly one MMU: no longer "no forest"
    (99.9, 500, {"little_forest"}),                    # 20 % of the area but under 100 ha
    (100.0, 1000, set()),                              # 100 ha and 10 %: neither threshold crossed
    (150.0, 2000, {"little_forest"}),                  # 7.5 % of the area
])
def test_caution_thresholds(forest_ha, valid_ha, expect):
    r = ready_result("x", {2019: forest_ha}, valid_ha=valid_ha)
    assert {c["code"] for c in sc.cautions(r["summary"], None)} == expect


def test_datasets_disagree_uses_the_same_year_and_names_both_datasets():
    ctx = context.parse(RAW["hasdeo"])                 # WorldCover 2021: 61.0 % tree cover of land
    agree = ready_result("x", {2019: 5677.0, 2021: 5644.0}, valid_ha=10000)          # 56.4 % in 2021: 4.6 points
    assert "datasets_disagree" not in {c["code"] for c in sc.cautions(agree["summary"], ctx)}
    gap = ready_result("x", {2019: 3000.0, 2021: 3000.0}, valid_ha=10000)            # 30.0 %: 31 points
    c = next(c for c in sc.cautions(gap["summary"], ctx) if c["code"] == "datasets_disagree")
    assert c["datasets"] == ["TerraTrace forest mask 2021", "ESA WorldCover v200 2021"]
    assert "30.0 %" in c["message"] and "61.0 %" in c["message"]
    no2021 = ready_result("x", {2019: 3000.0, 2022: 3000.0}, valid_ha=10000)
    c = next(c for c in sc.cautions(no2021["summary"], ctx) if c["code"] == "datasets_disagree")
    assert c["datasets"][0] == "TerraTrace forest mask 2022" and "2021 is not analysable here, so 2022 is compared" in c["message"]


def test_cautions_never_change_a_status_or_a_number(monkeypatch):
    r = ready_result("x", {2019: 50.0, 2025: 49.0})
    before = json.dumps(r["summary"], sort_keys=True)
    sc.cautions(r["summary"], context.parse(RAW["egypt_cropland"]))
    assert json.dumps(r["summary"], sort_keys=True) == before


# ----------------------------------------------------------------------------- edges: ocean, ice, outside the band
def test_open_ocean_gets_an_explicit_answer_and_no_analysis_work(monkeypatch):
    c = context.parse(RAW["open_ocean"])
    assert c["status"] == "READY" and c["surface"]["kind"] == "open_water" and "Open water" in c["surface"]["message"]
    assert c["terrain"]["status"] == "UNAVAILABLE" and "open water" in c["terrain"]["reason"]
    assert "not the open ocean" in c["forest"]["worldcover_2021"]["reason"]
    env, calls = run_job(monkeypatch, OCEAN, RAW["open_ocean"])
    assert calls == [], "no analysis is attempted over open ocean"
    assert env["analysisStatus"] == "UNAVAILABLE" and env["reasonCode"] == "open_water" and env["error"]["retryable"] is False
    assert "Sentinel-2 does not image the open ocean" in env["reason"] and env["context"]["surface"]["kind"] == "open_water"


def test_ice_sheet_is_snow_and_ice_and_hansen_no_data_is_not_water():
    c = context.parse(RAW["greenland_ice"])
    assert c["surface"]["kind"] == "snow_ice" and "snow and ice" in c["surface"]["message"] and c["surface"]["hansen_no_data"]
    assert c["terrain"]["status"] == "READY" and c["terrain"]["elevation_m"]["mean"] > 3000
    reason = c["forest"]["tree_cover_2000"]["reason"]
    assert "no data for this area" in reason and "water" not in reason


def test_ice_sheet_analysis_runs_and_reports_zero_forest(monkeypatch):
    env, calls = run_job(monkeypatch, GREENLAND, RAW["greenland_ice"], ready_result("x", {2019: 0.0, 2025: 0.0}))
    assert calls == [1] and env["analysisStatus"] == "READY" and env["cautions"][0]["code"] == "no_forest_to_monitor"


def test_outside_the_sentinel2_band_is_a_result_not_a_refusal(monkeypatch):
    env, calls = run_job(monkeypatch, square(89.48, -84.95), RAW["greenland_ice"])
    assert calls == [] and env["analysisStatus"] == "UNAVAILABLE" and env["reasonCode"] == "outside_sentinel2_coverage"
    assert "No Sentinel-2 imagery at this latitude" in env["reason"] and env["context"] is not None


# ----------------------------------------------------------------------------- change only inside the forest mask
class _Expr:
    def __init__(self, desc):
        self.desc = desc

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Expr(("attr", self, name))

    def __call__(self, *a, **k):
        return _Expr(("call", self, a))

    def __repr__(self):
        if isinstance(self.desc, str):
            return self.desc
        kind, parent, x = self.desc
        return f"{parent!r}.{x}" if kind == "attr" else f"{parent!r}({', '.join(repr(a) for a in x)})"


def test_change_events_require_baseline_forest(monkeypatch):
    """Events are vectorised from change_mask: every condition is AND-ed onto 'forest in the baseline year', so a pixel
    that was crop, bare soil or water in the baseline can never be a change event."""
    monkeypatch.setattr(P, "_ee", lambda: _Expr("ee"))
    expr = repr(P.change_mask(_Expr("B"), _Expr("A")))
    assert expr.startswith("B.select('forest').And(A.select('forest').Not()).And(")
    assert ".Or(" in expr and expr.count(".And(") >= 3, "the spectral test is OR-ed inside, never with the forest condition"
    assert expr.split(".selfMask()")[0].startswith("B.select('forest')")


def test_yearly_loss_is_counted_only_inside_the_earlier_forest_mask():
    loss = repr(P.transition_bands(_Expr("FA"), _Expr("FB"), _Expr("AREA"), "t")[0])
    assert loss.startswith("FA.And(FB.Not())")


# ----------------------------------------------------------------------------- one rounding rule
@pytest.mark.parametrize("v,shown", [(None, "—"), (0, "0 %"), (0.0, "0 %"), (0.37, "< 1 %"), (0.95, "< 1 %"), (0.999, "< 1 %"),
                                     (1, "1.0 %"), (22.4525, "22.5 %"), (61.0287, "61.0 %"), (100, "100.0 %")])
def test_one_rounding_rule_for_shares(v, shown):
    assert fmt_share(v) == shown


# ----------------------------------------------------------------------------- before 2016: imagery only (option F)
def hist_row(year, forest_ha, prev=None, gain_ha=0.0, loss_ha=0.0):
    return {"year": year, "era": sc.era_of(year), "passes_quality": True, "valid_ha": 10000.0, "coverage_pct": 99.0,
            "forest_ha": forest_ha, "forest_pct": forest_ha / 100, "previous_year": prev, "loss_ha": loss_ha, "gain_ha": gain_ha,
            "compared_ha": 10000.0 if prev else None, "net_change_ha": gain_ha - loss_ha if prev else None,
            "forest_components": None, "forest_components_change_pts": None, "mean_ndvi": 0.71, "mean_nbr": 0.42}


PROXY_PERIOD = {"from_year": 1984, "to_year": 1995, "loss_ha": 500.0, "gain_ha": 10.0, "net_change_ha": -490.0,
                "rate_pct_per_year": 0.8, "level": "high", "sensors": "Landsat", "label": "Historical Landsat analysis"}


def assert_no_proxy_figures(years):
    for r in years:
        if r["year"] < 2016:
            assert r["forest_withheld"] is True
            assert all(r[k] is None for k in sc.PROXY_ROW_FIELDS), r
            assert r["passes_quality"] is True and r["coverage_pct"] == 99.0, "imagery availability stays"


def test_withhold_proxy_removes_every_landsat_era_forest_figure_and_keeps_the_modern_era():
    doc = {"years": [hist_row(1984, 6000.0), hist_row(1995, 5200.0, 1984, loss_ha=800.0), hist_row(2018, 4100.0), hist_row(2019, 4000.0, 2018, loss_ha=100.0)],
           "periods": [PROXY_PERIOD], "history": {"first_year": 1984, "net_change_ha": -800.0}, "method": {"version": "old"}}
    out = sc.withhold_proxy(doc)
    assert_no_proxy_figures(out["years"])
    assert out["years"][2] == doc["years"][2] and out["years"][3]["loss_ha"] == 100.0, "modern rows untouched"
    assert out["periods"] == [] and out["history"] is None
    assert "satellite imagery only" in out["historical_statement"] and "cannot tell green crops" in out["historical_statement"]
    assert out["method"] is sc.METHOD and "imagery only" in sc.METHOD["history_rule"]
    assert doc["years"][0]["forest_ha"] == 6000.0, "the stored document is not modified"
    assert sc.withhold_proxy(out) == out, "idempotent"


@pytest.mark.parametrize("aid_kind", ["non_forest", "featured"])
def test_history_is_imagery_only_before_2016_at_every_site(monkeypatch, aid_kind):
    """Option F (2026-10-10): every site, featured ones included, gets its pre-2016 years as imagery availability only.
    A proxy transition that would have failed the gain-stability check raises no issue (the figure is not shown)."""
    if aid_kind == "featured":
        aid = "hasdeo-arand"
    else:
        env, _ = run_job(monkeypatch, EGYPT, RAW["egypt_cropland"], ready_result("x", {2019: 0.0, 2025: 0.0}))
        aid = env["analysis_id"]
    doc = {"years": [hist_row(2010, 300.0), hist_row(2015, 2900.0, 2010, gain_ha=2600.0), hist_row(2016, 50.0), hist_row(2017, 52.0, 2016, gain_ha=2.0)],
           "periods": [PROXY_PERIOD], "history": {"first_year": 2010}, "quality_years": []}
    monkeypatch.setattr(analysis, "_service_unavailable", lambda: False)
    monkeypatch.setattr(analysis, "_compute_history", lambda *a, **k: doc)
    r = client.get(f"/api/analysis/{aid}/history", params={"baseline": 2019, "comparison": 2025})
    assert r.status_code == 200
    d = r.json()
    assert_no_proxy_figures(d["years"])
    assert [y["forest_ha"] for y in d["years"] if y["year"] >= 2016] == [50.0, 52.0], "modern years outside the window keep their figures"
    assert d["periods"] == [] and d["history"] is None and d["stability_issues"] == []
    assert "imagery only" in d["scope_note"] and d["historical_statement"] == sc.PROXY_STATEMENT


def test_window_result_reaching_back_before_2016_shows_no_proxy_forest(monkeypatch):
    res = ready_result("x", {2018: 4100.0, 2025: 4000.0})
    res["summary"]["years"] = [hist_row(2000, 7000.0), hist_row(2015, 6400.0, 2000, loss_ha=600.0)] + res["summary"]["years"]
    res["summary"].update(periods=[PROXY_PERIOD], history={"first_year": 2000, "net_change_ha": -600.0})
    res["layers"] = {"imagery": [{"year": 2000}, {"year": 2018}],
                     "overlays": [{"kind": "forest", "tiles_by_year": {"2000": ["/f/2000"], "2015": ["/f/2015"], "2018": ["/f/2018"], "2025": ["/f/2025"]}}]}
    env, _ = run_job(monkeypatch, EGYPT, RAW["egypt_cropland"], res)
    s = env["summary"]
    assert_no_proxy_figures(s["years"])
    assert s["periods"] == [] and s["history"] is None and s["historical_statement"] == sc.PROXY_STATEMENT
    assert list(env["layers"]["overlays"][0]["tiles_by_year"]) == ["2018", "2025"], "no Landsat-era forest tiles"
    assert [l["year"] for l in env["layers"]["imagery"]] == [2000, 2018], "Landsat imagery stays"
    assert all("1984" not in c["message"] and "Landsat" not in c["message"] for c in env["cautions"])


@pytest.mark.parametrize("path", ["/api/tiles/hasdeo-arand/forest/2000/3/1/1", "/api/tiles/hasdeo-arand/forest/1984/3/1/1",
                                  "/api/tiles/hasdeo-arand/change/2015/3/1/1?baseline=2010",
                                  "/api/tiles/hasdeo-arand/change/2018/3/1/1?baseline=2015"])
def test_landsat_era_forest_and_change_tiles_are_refused(path, monkeypatch):
    monkeypatch.setattr(analysis.ee_provider, "tile_url", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no EE request")))
    r = client.get(path)
    d = r.json()["detail"]
    assert r.status_code == 404 and d["retryable"] is False and "withheld" in d["user_message"]


def test_landsat_era_imagery_tiles_are_not_refused_by_the_rule(monkeypatch):
    seen = []
    monkeypatch.setattr(analysis.ee_provider, "tile_url", lambda *a, **k: seen.append(a[1:3]) or (_ for _ in ()).throw(RuntimeError("stop")))
    r = client.get("/api/tiles/hasdeo-arand/imagery/2000/3/1/1")
    assert seen == [("imagery", 2000)] and r.status_code == 503, "reaches Earth Engine (stopped here by the fake)"
