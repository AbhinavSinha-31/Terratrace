"""CORS: only the local dev server and explicitly configured exact origins; never a wildcard."""

from fastapi.testclient import TestClient

from app import config
from app.main import app

client = TestClient(app)


def test_dev_origin_is_allowed_and_foreign_origin_is_not():
    ok = client.get("/api/imagery/basemaps", headers={"Origin": "http://localhost:5173"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    bad = client.get("/api/imagery/basemaps", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in bad.headers
    pre = client.options("/api/aoi", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in pre.headers


def test_configured_origins_are_exact_and_wildcards_are_ignored(monkeypatch):
    monkeypatch.setenv("TT_CORS_ORIGINS", " https://terratrace.vercel.app/ , *, https://*.vercel.app, javascript:alert(1), http://x.test:8080")
    origins = config._cors_origins()
    assert origins == (*config.DEV_ORIGINS, "https://terratrace.vercel.app", "http://x.test:8080")
    assert "*" not in origins


def test_no_wildcard_in_the_running_app():
    assert "*" not in config.settings.cors_origins and all(o.startswith("http") for o in config.settings.cors_origins)
