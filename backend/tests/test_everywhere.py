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


# ----------------------------------------------------------------------------- historical proxy in non-forest areas
def test_historical_landsat_proxy_is_withheld_where_there_is_little_or_no_forest(monkeypatch):
    """Regression (2026-10-10, Nile delta): the Landsat NDVI >= 0.60 proxy read irrigated cropland as 52-63 % 'forest'
    and showed 'high change' periods 1984-2015 — change on non-forest pixels. Withheld, never computed."""
    env, _ = run_job(monkeypatch, EGYPT, RAW["egypt_cropland"], ready_result("x", {2018: 0.0, 2025: 0.0}))
    aid = env["analysis_id"]
    analysis._results[analysis._key(aid, 2018, 2025)] = ready_result(aid, {2018: 0.0, 2025: 0.0})
    monkeypatch.setattr(analysis, "_compute_history", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not compute")))
    r = client.get(f"/api/analysis/{aid}/history", params={"baseline": 2018, "comparison": 2025})
    d = r.json()["detail"]
    assert r.status_code == 422 and d["code"] == "history_withheld" and d["retryable"] is False
    assert "cannot tell green crops from forest" in d["user_message"]
    assert "not shown here" in env["cautions"][0]["message"], "the statement says why the history is absent"


def test_forested_areas_keep_their_historical_record(monkeypatch):
    aid = "hasdeo-arand"
    analysis._results[analysis._key(aid, 2019, 2025)] = ready_result(aid, {2019: 6800.0, 2025: 6750.0})
    computed = []
    monkeypatch.setattr(analysis, "_service_unavailable", lambda: False)
    monkeypatch.setattr(analysis, "_compute_history", lambda *a, **k: computed.append(1) or {"years": [], "periods": [], "history": None, "quality_years": []})
    monkeypatch.setattr(analysis, "_describe_history", lambda doc, aoi: {"years": doc["years"]})
    r = client.get(f"/api/analysis/{aid}/history", params={"baseline": 2019, "comparison": 2025})
    assert r.status_code == 200 and computed == [1]
