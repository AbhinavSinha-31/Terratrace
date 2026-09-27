"""Tests for app.ee_check with a fake `ee` module — no credentials or network needed."""

from app import ee_check
from app.providers.earth_engine import provider as p


class _Val:
    def __init__(self, v):
        self.v = v

    def getInfo(self):
        return self.v


class FakeEE:
    """Minimal stand-in for the earthengine-api surface the checker uses."""

    def __init__(self, assets: dict[str, tuple[str, list[str]]], init_error: Exception | None = None, hansen_listing=()):
        self.assets = assets
        self.init_error = init_error
        self.project = None
        fake = self

        class Data:
            @staticmethod
            def getAsset(aid):
                if aid not in fake.assets:
                    raise Exception(f"Image asset '{aid}' not found (does not exist or caller does not have access).")
                return {"type": fake.assets[aid][0]}

            @staticmethod
            def listAssets(params):
                return {"assets": [{"id": a, "type": "IMAGE"} for a in hansen_listing]}

        self.data = Data()

    def Initialize(self, credentials=None, project=None):
        if self.init_error:
            raise self.init_error
        self.project = project

    def Number(self, n):
        class N:
            def add(_, m):
                return _Val(n + m)
        return N()

    def _img(self, aid):
        class I:
            def bandNames(_):
                return _Val(self.assets[aid][1])
        return I()

    def ImageCollection(self, aid):
        outer = self

        class C:
            def first(_):
                return outer._img(aid)
        return C()

    def Image(self, aid):
        return self._img(aid)


def all_assets():
    return {s.asset_id: (s.kind.upper(), list(s.bands) + ["extra"]) for s in ee_check.dataset_specs()}


def test_specs_cover_every_dataset_in_provider():
    ids = {s.asset_id for s in ee_check.dataset_specs()}
    assert {p.S2, p.CSPLUS, p.DW, p.HANSEN, *p.LANDSAT} == ids


def test_all_pass(monkeypatch):
    monkeypatch.delenv("EE_SERVICE_ACCOUNT_KEY", raising=False)
    fake = FakeEE(all_assets())
    results = ee_check.run(fake, "proj-x")
    assert all(r.ok for r in results) and fake.project == "proj-x"
    assert len(results) == 2 + len(ee_check.dataset_specs())
    assert "10/10 checks passed" in ee_check.report(results, "proj-x", "--project")


def test_invalid_hansen_lists_catalog_ids(monkeypatch):
    monkeypatch.delenv("EE_SERVICE_ACCOUNT_KEY", raising=False)
    assets = all_assets()
    del assets[p.HANSEN]
    fake = FakeEE(assets, hansen_listing=["UMD/hansen/global_forest_change_2023_v1_11", "UMD/hansen/global_forest_change_2024_v1_12"])
    han = next(r for r in ee_check.run(fake, "proj-x") if p.HANSEN in r.name)
    assert not han.ok and "not found" in han.detail
    assert han.extra == ["valid IDs in the Earth Engine catalog: UMD/hansen/global_forest_change_2024_v1_12, UMD/hansen/global_forest_change_2023_v1_11"]


def test_missing_band_and_wrong_type_fail(monkeypatch):
    monkeypatch.delenv("EE_SERVICE_ACCOUNT_KEY", raising=False)
    assets = all_assets()
    assets[p.DW] = ("IMAGE_COLLECTION", ["label"])
    assets[p.CSPLUS] = ("IMAGE", ["cs_cdf"])
    res = {r.name.split(" · ")[1]: r for r in ee_check.run(FakeEE(assets), "proj-x")[2:]}
    assert not res[p.DW].ok and "trees" in res[p.DW].detail
    assert not res[p.CSPLUS].ok and "expected ImageCollection" in res[p.CSPLUS].detail


def test_init_failure_stops_and_redacts_tokens(monkeypatch):
    monkeypatch.delenv("EE_SERVICE_ACCOUNT_KEY", raising=False)
    results = ee_check.run(FakeEE({}, init_error=Exception("invalid_grant ya29.SECRETTOKEN refresh 1//0gSECRET")), "proj-x")
    assert len(results) == 1 and not results[0].ok
    assert "SECRET" not in results[0].detail and "[redacted]" in results[0].detail


def test_resolve_project_prefers_cli_then_env(monkeypatch, tmp_path):
    monkeypatch.setenv("EARTHENGINE_CREDENTIALS", str(tmp_path / "creds"))
    monkeypatch.delenv("EE_PROJECT", raising=False)
    assert ee_check.resolve_project(None) == (None, "not set")
    (tmp_path / "creds").write_text('{"project": "from-cli", "refresh_token": "x"}', encoding="utf-8")
    assert ee_check.resolve_project(None) == ("from-cli", "earthengine set_project")
    monkeypatch.setenv("EE_PROJECT", "from-env")
    assert ee_check.resolve_project(None) == ("from-env", "EE_PROJECT")
    assert ee_check.resolve_project("from-arg") == ("from-arg", "--project")
