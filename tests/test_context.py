"""Area context: terrain + forest cover from reference datasets — never TerraTrace results, never estimated.

The fixture tests/data/context_hasdeo_raw_2026-10-09.json is the REAL Earth Engine response of
provider.area_context for Hasdeo Arand (recorded 2026-10-09), so parsing is tested against the actual shape.
"""

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.providers.earth_engine import provider as P
from app.services import analysis, context

client = TestClient(app, raise_server_exceptions=False)
RAW = json.loads((Path(__file__).parent / "data" / "context_hasdeo_raw_2026-10-09.json").read_text(encoding="utf-8"))
LEAKS = ["Traceback", "C:\\", "googleapis", "EEException", "token", "credential", "project"]


@pytest.fixture(autouse=True)
def fresh():
    context._memory.clear()
    context._failures.clear()
    for f in context.CACHE.glob("*.json") if context.CACHE.exists() else []:
        f.unlink()
    yield
    context._memory.clear()
    context._failures.clear()


@pytest.fixture
def ee_context(monkeypatch):
    """provider.area_context answering with the recorded response; counts calls."""
    calls = []
    monkeypatch.setattr(P.provider, "area_context", lambda geometry: (calls.append(geometry), RAW)[1])
    return calls


# ----------------------------------------------------------------------------- datasets
def test_datasets_are_the_approved_current_versions():
    assert P.DEM == "COPERNICUS/DEM/GLO30_2024_1", "COPERNICUS/DEM/GLO30 is deprecated in the catalogue"
    assert P.HANSEN == "UMD/hansen/global_forest_change_2025_v1_13"
    assert P.WORLDCOVER == "ESA/WorldCover/v200"
    assert P.HANSEN_CANOPY == 30 and P.WORLDCOVER_TREE == 10


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


def test_slope_uses_one_mosaic_with_the_tiles_own_projection(monkeypatch):
    """Terrain functions on an unprojected mosaic compute slope at the wrong scale."""
    monkeypatch.setattr(P, "_ee", lambda: _Expr("ee"))
    expr = repr(P.EarthEngineProvider._dem())
    assert "ImageCollection('COPERNICUS/DEM/GLO30_2024_1').select('DEM').mosaic().setDefaultProjection(" in expr
    assert ".first().projection()" in expr


# ----------------------------------------------------------------------------- parsing (real response)
def test_parse_reads_the_real_hasdeo_measurements():
    c = context.parse(RAW)
    assert c["status"] == "READY" and c["label"] == "Reference context, not a TerraTrace result"
    t = c["terrain"]
    assert t["status"] == "READY" and t["elevation_m"] == {"min": 351, "p5": 410, "mean": 514, "p95": 626, "max": 987}
    assert t["slope_mean_deg"] == 6.2 and t["steep_share_pct"] == 0.7 and t["dem_coverage_pct"] == 100.0
    f = c["forest"]
    # Shares keep 4 decimals; rounding happens once, at display (units.fmt_share / lib/format.ts fmtShare).
    assert f["tree_cover_2000"]["share_of_land_pct"] == 22.4525 and f["tree_cover_2000"]["area_ha"] == 27007.6
    assert f["worldcover_2021"]["share_of_land_pct"] == 61.0287
    assert f["gain_2000_2012"]["area_ha"] == 0.7
    years = f["loss_by_year"]["years"]
    assert [y["year"] for y in years] == list(range(2001, 2026))
    assert next(y for y in years if y["year"] == 2025)["loss_ha"] == 80.5
    total = sum(g["sum"] for g in RAW["loss_by_year"]["groups"])
    assert f["loss_by_year"]["total_ha"] == round(total, 1)


def test_a_loss_year_absent_from_the_grouped_sum_is_a_measured_zero():
    """2022 has no group in the real response: every pixel was evaluated and none was lost that year."""
    assert all(g["lossyear"] != 22 for g in RAW["loss_by_year"]["groups"])
    years = {y["year"]: y["loss_ha"] for y in context.parse(RAW)["forest"]["loss_by_year"]["years"]}
    assert years[2022] == 0.0


def test_every_value_carries_its_dataset_and_year():
    c = context.parse(RAW)
    t, f = c["terrain"], c["forest"]
    assert t["source"]["dataset"] == "Copernicus DEM GLO-30" and t["source"]["year"] == "2024_1"
    assert f["tree_cover_2000"]["source"]["year"] == "2000" and "year-2000 baseline" in f["tree_cover_2000"]["source"]["year_label"]
    assert f["loss_by_year"]["source"]["year"] == "2001–2025"
    assert f["gain_2000_2012"]["source"]["year"] == "2000–2012" and "only" in f["gain_2000_2012"]["source"]["year_label"]
    assert f["worldcover_2021"]["source"]["year"] == "2021"
    for v in [t, *f.values()]:
        assert v["source"]["dataset"] and v["source"]["id"], v
    assert "remaining" not in json.dumps(c).lower(), "no derived 'remaining tree cover' figure"


@pytest.mark.parametrize("broken,section", [
    ({"elevation": {}, "slope": {}}, "terrain"),
    ({"hansen": {"land_ha": None, "forest2000_ha": None, "gain_ha": None}}, "hansen"),
    ({"loss_by_year": {}}, "hansen"),
    ({"worldcover": {"land_ha": 0, "tree_ha": 0}}, "worldcover"),
])
def test_unmeasured_values_are_unavailable_never_zero(broken, section):
    c = context.parse({**RAW, **broken})
    if section == "terrain":
        assert c["terrain"]["status"] == "UNAVAILABLE" and c["terrain"]["elevation_m"] is None and c["terrain"]["slope_mean_deg"] is None
    elif section == "hansen":
        for k in ("tree_cover_2000", "loss_by_year"):
            v = c["forest"][k]
            assert v["status"] == "UNAVAILABLE" and v["reason"]
        assert c["forest"]["loss_by_year"]["years"] is None and c["forest"]["loss_by_year"]["total_ha"] is None
        assert c["forest"]["tree_cover_2000"]["share_of_land_pct"] is None
    else:
        v = c["forest"]["worldcover_2021"]
        assert v["status"] == "UNAVAILABLE" and v["share_of_land_pct"] is None
    assert c["status"] == "READY", "the other datasets are still reported"


def test_nothing_measured_is_unavailable_overall():
    c = context.parse({})
    assert c["status"] == "UNAVAILABLE" and c["reason"]
    assert c["terrain"]["elevation_m"] is None and c["forest"]["tree_cover_2000"]["area_ha"] is None


# ----------------------------------------------------------------------------- route + cache
def test_aoi_route_returns_context_only_when_asked_and_measures_once(ee_context):
    plain = client.get("/api/aoi/hasdeo-arand").json()
    assert "context" not in plain and ee_context == []
    a = client.get("/api/aoi/hasdeo-arand", params={"include": "context"}).json()
    ctx = a["context"]
    assert ctx["status"] == "READY" and ctx["label"] == context.LABEL and ctx["forest"]["worldcover_2021"]["share_of_land_pct"] == 61.0287
    assert [l["id"] for l in ctx["layers"]] == ["hillshade", "slope", "treecover2000", "lossyear"]
    assert all(l["reference"] and l["tiles"][0].startswith("/api/tiles/hasdeo-arand/context/") for l in ctx["layers"])
    client.get("/api/aoi/hasdeo-arand", params={"include": "context"})
    assert len(ee_context) == 1, "cached after the first measurement"
    assert client.get("/api/aoi/hasdeo-arand", params={"include": "other"}).status_code == 422


def test_a_failed_measurement_is_unavailable_with_a_public_reason_and_retried_later(monkeypatch):
    calls = []

    def boom(geometry):
        calls.append(1)
        raise RuntimeError("Too Many Requests: Exceeded Earth Engine concurrency limit. project terratrace-x C:\\Users\\x token=abc")

    monkeypatch.setattr(P.provider, "area_context", boom)
    ctx = client.get("/api/aoi/hasdeo-arand", params={"include": "context"}).json()["context"]
    assert ctx["status"] == "UNAVAILABLE" and ctx["terrain"] is None and ctx["forest"] is None
    assert "throttling" in ctx["reason"] and not any(s.lower() in json.dumps(ctx).lower() for s in LEAKS)
    assert not list(context.CACHE.glob("*.json")) if context.CACHE.exists() else True, "a failure is never stored"
    client.get("/api/aoi/hasdeo-arand", params={"include": "context"})
    assert len(calls) == 1, "no Earth Engine hammering inside the back-off window"
    monkeypatch.setattr(context, "FAILURE_TTL_S", 0)
    client.get("/api/aoi/hasdeo-arand", params={"include": "context"})
    assert len(calls) == 2, "measured again after the back-off"


def test_context_cache_is_keyed_by_dataset_version(ee_context):
    client.get("/api/aoi/hasdeo-arand", params={"include": "context"})
    files = [f.name for f in context.CACHE.glob("*.json")]
    assert files == [f"hasdeo-arand-{context.CONTEXT_VERSION}.json"]
    assert context.CONTEXT_VERSION.startswith("ctx-2-")   # 2: land-cover breakdown, Hansen mask, surface


def test_analysis_envelopes_carry_cached_context_without_computing_it(monkeypatch):
    monkeypatch.setattr(P.provider, "area_context", lambda g: (_ for _ in ()).throw(AssertionError("must not compute")))
    env = analysis._envelope("hasdeo-arand", analysis.aoi_doc("hasdeo-arand"), 2019, 2025, "UNAVAILABLE", code="service_unavailable")
    assert env["context"] is None, "not measured yet: null, never estimated"
    context._memory["hasdeo-arand"] = context.parse(RAW)
    env = analysis._envelope("hasdeo-arand", analysis.aoi_doc("hasdeo-arand"), 2019, 2025, "UNAVAILABLE", code="service_unavailable")
    assert env["context"]["status"] == "READY", "shown whatever the analysis status"


def test_a_job_measures_context_and_a_context_failure_never_fails_the_job(monkeypatch):
    monkeypatch.setattr(P.provider, "area_context", lambda g: (_ for _ in ()).throw(RuntimeError("boom")))
    stored = {"status": "UNAVAILABLE", "reasonCode": "insufficient_imagery", "reason": "x",
              "quality": {"years": [], "issues": []}, "method_version": analysis.sc.METHOD_VERSION}
    monkeypatch.setattr(analysis, "_load_result", lambda key: stored)
    job = analysis.create_job("hasdeo-arand", 2019, 2025)
    job.future.result(timeout=30)
    assert job.envelope["analysisStatus"] == "UNAVAILABLE" and job.envelope["context"]["status"] == "UNAVAILABLE"


# ----------------------------------------------------------------------------- context tiles
@pytest.fixture
def no_earth_engine(monkeypatch):
    def forbidden(*a, **k):
        raise AssertionError("Earth Engine must not be called")
    monkeypatch.setattr(P.provider, "context_tile_url", forbidden)


@pytest.mark.parametrize("path,code", [
    ("/api/tiles/hasdeo-arand/context/secret/3/1/1", 404),
    ("/api/tiles/hasdeo-arand/context/slope/3/8/1", 404),        # x >= 2^z
    ("/api/tiles/hasdeo-arand/context/slope/25/1/1", 422),
    ("/api/tiles/../context/slope/3/1/1", 404),
    ("/api/tiles/aoi-000000000000/context/slope/3/1/1", 404),    # unknown area
])
def test_context_tile_route_validates_like_the_tile_routes(no_earth_engine, path, code):
    r = client.get(path)
    assert r.status_code == code
    if r.headers.get("content-type", "").startswith("application/json") and isinstance(r.json().get("detail"), dict):
        assert set(r.json()["detail"]) >= {"code", "user_message", "retryable"}


def test_context_tiles_are_cached_and_never_shadowed_by_the_year_route(monkeypatch, fake_ee_tiles):
    builds = []
    monkeypatch.setattr(P.provider, "context_tile_url", lambda aid, layer, g: (builds.append(layer), "https://earthengine.example/ctx/{z}/{x}/{y}")[1])
    r = client.get("/api/tiles/hasdeo-arand/context/hillshade/3/5/3")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and builds == ["hillshade"]
    assert client.get("/api/tiles/hasdeo-arand/context/hillshade/3/5/3").content == r.content
    assert len(fake_ee_tiles.urls) == 1, "second request served from the tile cache"


def test_context_tile_failures_are_public_errors(monkeypatch, fake_ee_tiles):
    monkeypatch.setattr(P.provider, "context_tile_url", lambda *a: (_ for _ in ()).throw(RuntimeError("ee.EEException C:\\secret token")))
    r = client.get("/api/tiles/hasdeo-arand/context/slope/3/5/3")
    assert r.status_code == 503 and r.json()["detail"]["code"] == "tiles_unavailable" and r.json()["detail"]["retryable"] is True
    assert not any(s.lower() in r.text.lower() for s in LEAKS)


def test_context_reads_are_rate_limited_as_compute():
    from app import ratelimit
    assert ratelimit.group_of("GET", "/api/aoi/hasdeo-arand") == "compute"
    assert ratelimit.group_of("GET", "/api/tiles/hasdeo-arand/context/slope/3/1/1") is None, "tiles: same policy as the other tile routes"


def test_terrain_card_shows_only_catalogue_backed_dem_labels():
    """2026-10-10: "acquired 2011–2015" is not stated on the DEM's Earth Engine catalogue page and is no longer shown —
    also for context files stored before the change (labels are applied when served; measured values are untouched)."""
    stored = context.parse(RAW)
    stored["terrain"]["source"] = {**stored["terrain"]["source"], "year": "2011–2015", "year_label": "acquired 2011–2015 (2024 release)"}
    context._memory["hasdeo-arand"] = stored
    try:
        served = context.cached("hasdeo-arand")
    finally:
        context._memory.pop("hasdeo-arand", None)
    src = served["terrain"]["source"]
    assert "2011" not in json.dumps(src) and src["year"] == "2024_1" and "2010-12-01 – 2020-11-13" in src["year_label"]
    assert served["terrain"]["elevation_m"] == stored["terrain"]["elevation_m"]
    assert all("2011" not in l["year_label"] for l in served["layers"])
