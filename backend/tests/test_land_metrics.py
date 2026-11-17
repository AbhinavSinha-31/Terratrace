"""Advisor-requested metrics: study-design LULC classes, vegetated-reference UHI, change between scanned years, the
ESA CCI carbon series and the NDVI-change heatmap layer. Offline: Earth Engine is never called.

Inputs are the SYNTHETIC quick-scan fixture of test_quickscan.py (hand-checkable round numbers) and variants of it —
test data only, never a measurement, never served to users.
"""

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.providers.earth_engine import provider as P
from app.providers.earth_engine import quickscan as Q
from app.services import carbon_series, land_metrics, quickscan
from tests import test_quickscan
from tests.test_quickscan import RAW, _g

fresh = test_quickscan.fresh   # autouse fixture: empty scan state, inline jobs

client = TestClient(app, raise_server_exceptions=False)


def scan(raw=RAW, year=2025, season="all", aid="hasdeo-arand"):
    doc = quickscan.parse(json.loads(json.dumps(raw)), year=year, season=season)
    return quickscan.present({**quickscan._envelope(aid, year, season, doc["status"]), **doc, "aoi_id": aid,
                              "quickscan_version": "test"})


def variant(**over):
    return {**json.loads(json.dumps(RAW)), **over}


# 100 km² without forest: water 2, crops 50, built 30, bare 18 km² (a peri-urban plain).
NO_FOREST = variant(classes={"groups": [_g(0, 200, 0, 200, 29.0), _g(4, 5000, 100, 5000, 35.0), _g(6, 3000, 50, 3000, 39.0),
                                        _g(7, 1800, 30, 1800, 42.0)]},
                    carbon={"area_ha": 10000.0, "covered_ha": 0.0, "agb_x_ha": 0.0, "sd_x_ha": 0.0})
# Cloud-heavy: only 3 usable Landsat scenes → no LST composite (and no UHI), land cover still READY.
CLOUDY = variant(counts={**RAW["counts"], "landsat_scenes": 3}, lst=None)


# ----------------------------------------------------------------------------- LULC in the study-design classes
def test_advisor_classes_shape_and_values():
    classes = scan()["landcover"]["advisor_classes"]
    assert [c["key"] for c in classes] == ["forest", "cropland", "built", "water", "barren", "grass_shrub", "wetland", "snow_ice"]
    got = {c["key"]: (c["area_km2"], c["share"]) for c in classes}
    assert got["forest"] == (30.0, 0.3) and got["cropland"] == (40.0, 0.4) and got["built"] == (20.0, 0.2)
    assert got["water"] == (2.0, 0.02) and got["barren"] == (8.0, 0.08) and got["grass_shrub"] == (0.0, 0.0)
    assert sum(c["area_km2"] for c in classes) == pytest.approx(100.0)
    assert sum(c["share"] for c in classes) == pytest.approx(1.0)
    assert all(c["color"].startswith("#") and len(c["color"]) == 7 for c in classes)


def test_grass_and_shrub_are_one_class():
    raw = variant(classes={"groups": [_g(2, 1000, 0, 1000, 33.0), _g(5, 500, 0, 500, 34.0), _g(6, 8500, 0, 8500, 38.0)]})
    gs = next(c for c in scan(raw)["landcover"]["advisor_classes"] if c["key"] == "grass_shrub")
    assert gs["area_km2"] == 15.0 and gs["dynamic_world"] == ["grass", "shrub_and_scrub"]


def test_area_without_forest_still_has_lulc_lst_and_uhi():
    doc = scan(NO_FOREST)
    forest = next(c for c in doc["landcover"]["advisor_classes"] if c["key"] == "forest")
    assert forest["area_km2"] == 0.0 and forest["share"] == 0.0           # a measured zero, shown — not missing
    assert doc["lst"]["status"] == "READY" and doc["lst"]["uhi_vegetated"]["status"] == "READY"
    assert doc["lst"]["uhi_vegetated"]["value_c"] == pytest.approx(39.0 - 35.0)   # crops are the only vegetation
    assert doc["carbon"]["components"][0]["status"] == "UNAVAILABLE"      # no CCI values: unavailable, never 0


# ----------------------------------------------------------------------------- UHI against vegetated land
def test_uhi_vegetated_by_hand():
    lst = scan()["lst"]
    v = lst["uhi_vegetated"]
    veg = (30.0 * 32.0 + 39.0 * 36.0) / 69.0                              # trees + crops, by valid-LST area
    assert v["status"] == "READY" and v["vegetated_mean_c"] == pytest.approx(round(veg, 2))
    assert v["value_c"] == pytest.approx(round(38.0 - veg, 2))
    assert v["value_c"] > lst["uhi"]["value_c"]          # bare ground (40 °C) is in the stored figure's reference, not here
    assert -30 < v["value_c"] < 30 and v["reference_classes"] == list(land_metrics.VEGETATED)


def test_uhi_vegetated_needs_enough_built_and_vegetated_land():
    rural = variant(classes={"groups": [_g(1, 9700, 0, 9700, 30.0), _g(6, 300, 0, 300, 35.0)]})
    v = scan(rural)["lst"]["uhi_vegetated"]
    assert v["status"] == "UNAVAILABLE" and "value_c" not in v and v["reason"]


def test_cloud_heavy_area_has_no_temperature_and_no_uhi_but_keeps_land_cover():
    doc = scan(CLOUDY)
    assert doc["lst"]["status"] == "UNAVAILABLE" and "uhi_vegetated" not in doc["lst"]
    assert doc["landcover"]["status"] == "READY" and doc["landcover"]["advisor_classes"]


# ----------------------------------------------------------------------------- change between years
def test_compare_two_years():
    later = variant(classes={"groups": [_g(0, 200, 0, 200, 30.0), _g(1, 2500, 0, 2500, 32.5), _g(4, 3500, 0, 3500, 36.5),
                                        _g(6, 3000, 0, 3000, 39.0), _g(7, 800, 0, 800, 41.0)]})
    c = land_metrics.compare(scan(year=2016), scan(later, year=2025))
    rows = {r["key"]: r for r in c["landcover"]["classes"]}
    assert rows["built"]["change_km2"] == 10.0 and rows["built"]["change_pct"] == 50.0 and rows["built"]["change_pp"] == 10.0
    assert rows["forest"]["change_km2"] == -5.0 and rows["cropland"]["change_km2"] == -5.0
    assert sum(r["change_km2"] for r in rows.values()) == pytest.approx(0.0)       # same area, classes trade places
    assert c["landcover"]["built_expansion_km2"] == 10.0
    assert c["lst"]["status"] == "READY" and c["lst"]["uhi_vegetated_change_c"] is not None


def test_compare_with_a_cloudy_year_keeps_land_cover_and_says_why_lst_is_missing():
    c = land_metrics.compare(scan(year=2016), scan(CLOUDY, year=2025))
    assert c["landcover"]["status"] == "READY" and c["lst"]["status"] == "UNAVAILABLE" and c["lst"]["reason"]


def test_compare_refuses_reversed_years_and_other_seasons():
    with pytest.raises(ValueError):
        land_metrics.compare(scan(year=2025), scan(year=2016))
    with pytest.raises(ValueError):
        land_metrics.compare(scan(year=2016), scan(year=2025, season="mam"))


def test_compare_endpoint_never_computes(monkeypatch):
    monkeypatch.setattr(Q, "measure", lambda *a: (_ for _ in ()).throw(AssertionError("must not call Earth Engine")))
    r = client.get("/api/quickscan/hasdeo-arand/compare?from=2016&to=2025")
    assert r.status_code == 200 and r.json()["status"] == "NOT_RUN" and r.json()["missing_years"] == [2016, 2025]
    assert client.get("/api/quickscan/hasdeo-arand/compare?from=2025&to=2016").status_code == 422
    assert client.get("/api/quickscan/nowhere-xyz/compare?from=2016&to=2025").status_code == 404


def test_compare_endpoint_with_two_stored_scans(monkeypatch):
    monkeypatch.setattr(Q, "measure", lambda geometry, year, season: json.loads(json.dumps(RAW)))
    for y in (2016, 2025):
        assert client.post(f"/api/quickscan/hasdeo-arand?year={y}&season=all").json()["status"] == "READY"
    c = client.get("/api/quickscan/hasdeo-arand/compare?from=2016&to=2025").json()
    assert c["status"] == "READY" and c["landcover"]["built_expansion_km2"] == 0.0 and c["disclaimer"]


# ----------------------------------------------------------------------------- carbon over time (ESA CCI)
def cci(year_sums):
    return {str(y): ({"area_ha": 10000.0, "covered_ha": cov, "agb_x_ha": cov * agb, "sd_x_ha": cov * sd} if cov is not None else None)
            for y, (cov, agb, sd) in year_sums.items()}


def test_carbon_series_values_ranges_and_change():
    raw = cci({2007: (None, 0, 0), 2010: (2000.0, 100, 10), 2015: (9000.0, 100, 20), 2022: (9000.0, 80, 20)})
    d = carbon_series.parse(raw)
    by = {s["year"]: s for s in d["series"]}
    assert [s["year"] for s in d["series"]] == list(Q.CCI_YEARS)
    assert by[2007]["status"] == "UNAVAILABLE" and by[2016]["status"] == "UNAVAILABLE"       # missing epochs are never 0
    assert by[2015]["total_t"] == pytest.approx(9000 * 100 * 0.47) and by[2015]["density_t_per_ha"] == pytest.approx(47.0)
    for s in d["series"]:
        if s["status"] == "READY":
            assert 0 <= s["range_t"][0] <= s["total_t"] <= s["range_t"][1] and 0 < s["coverage_share"] <= 1
    assert by[2010]["usable_for_change"] is False                     # covers 20 % of the area: shown, not used for change
    ch = d["change"]
    assert (ch["from_year"], ch["to_year"]) == (2015, 2022) and ch["change_t"] == pytest.approx(9000 * -20 * 0.47)
    assert d["estimate"] is True and d["tier1"]["status"] == "NOT_COMPUTED" and d["caveat"]


def test_carbon_series_without_any_biomass_is_unavailable_not_zero():
    d = carbon_series.parse(cci({y: (0.0, 0, 0) for y in Q.CCI_YEARS}))
    assert d["status"] == "UNAVAILABLE" and d["change"] is None
    assert all(s["status"] == "UNAVAILABLE" and "total_t" not in s for s in d["series"])


def test_carbon_endpoint_runs_once_and_stores(monkeypatch):
    for f in quickscan.CACHE.glob("carbon-series-*.json") if quickscan.CACHE.exists() else []:
        f.unlink()
    carbon_series._memory.clear()
    calls = []
    monkeypatch.setattr(Q, "carbon_series", lambda g: (calls.append(1), cci({2015: (9000.0, 100, 20), 2022: (9000.0, 90, 20)}))[1])
    assert client.get("/api/carbon/hasdeo-arand").json()["status"] == "NOT_RUN" and calls == []
    r = client.post("/api/carbon/hasdeo-arand").json()
    assert r["status"] == "READY" and r["change"]["change_t"] < 0 and calls == [1]
    carbon_series._memory.clear()
    assert client.post("/api/carbon/hasdeo-arand").json()["status"] == "READY" and calls == [1], "stored: never recomputed"
    assert client.get("/api/carbon/nowhere-xyz").status_code == 404


# ----------------------------------------------------------------------------- NDVI change heatmap layer
def test_ndvi_change_layer_is_keyed_by_both_years():
    assert P.layer_key("a", "ndvi_change", 2025, 2019) != P.layer_key("a", "ndvi_change", 2025, 2018)
    assert P.layer_key("a", "ndvi_change", 2025, 2019) != P.layer_key("a", "change", 2025, 2019)
    assert "ndvi_change" in P.LAYER_KINDS and P.NDVI_CHANGE_RANGE > 0 and len(P.NDVI_CHANGE_PALETTE) >= 3


def test_ndvi_change_tiles_need_a_baseline_before_the_year():
    with pytest.raises(P.EarthEngineError):
        P.provider.tile_url("hasdeo-arand", "ndvi_change", 2025, None, None)
    with pytest.raises(P.EarthEngineError):
        P.provider.tile_url("hasdeo-arand", "ndvi_change", 2025, None, 2025)


# ----------------------------------------------------------------------------- the Indian city case study
def test_gurugram_is_a_land_focus_featured_area_inside_the_interactive_limit():
    from app.providers import registry
    from app.services import featured
    g = registry.get("gurugram-urban")
    assert g and g["focus"] == "land" and g["featured"] is True and g["country"] == "India"
    assert "gurugram-urban" in featured.featured_ids() and "gurugram-urban" not in featured.forest_ids()
    assert g["area_km2"] < 1500 and 76.8 < g["center"][0] < 77.2 and 28.3 < g["center"][1] < 28.6
    assert not any(ch.isdigit() for ch in g["description"].replace("2000", "")), "no figures in the description"


def test_land_focus_precompute_runs_quick_scans_and_carbon_not_a_forest_job(monkeypatch):
    from app.services import analysis, featured
    monkeypatch.setattr(analysis, "create_job", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no forest job")))
    monkeypatch.setattr(Q, "measure", lambda geometry, year, season: json.loads(json.dumps(RAW)))
    monkeypatch.setattr(Q, "carbon_series", lambda g: {"2015": {"area_ha": 1.0, "covered_ha": 1.0, "agb_x_ha": 10.0, "sd_x_ha": 1.0}})
    monkeypatch.setattr(featured, "_measure_availability", lambda aid, loop: None)
    monkeypatch.setattr(featured, "featured_ids", lambda: ["gurugram-urban"])
    monkeypatch.setattr("app.services.context.ensure", lambda aid, geometry: None)
    carbon_series._memory.clear()
    for f in quickscan.CACHE.glob("carbon-series-gurugram-urban-*.json") if quickscan.CACHE.exists() else []:
        f.unlink()
    out = dict(featured.precompute())
    assert out["gurugram-urban"].startswith("land") and "2016:READY" in out["gurugram-urban"] and "carbon:READY" in out["gurugram-urban"]
    assert quickscan.stored("gurugram-urban", 2016, "all") and quickscan.stored("gurugram-urban", quickscan.last_year(), "all")
    carbon_series._memory.clear()                       # leave no stored state for other test modules
    for f in quickscan.CACHE.glob("*gurugram-urban*.json"):
        f.unlink()
