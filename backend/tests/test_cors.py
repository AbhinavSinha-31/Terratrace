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


def test_allowed_origins_env_is_read_too(monkeypatch):
    """Render / Vercel deployments set ALLOWED_ORIGINS; the older TT_CORS_ORIGINS still works alongside it."""
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://terratrace.vercel.app, https://*.vercel.app")
    monkeypatch.setenv("TT_CORS_ORIGINS", "https://terratrace.example.org")
    origins = config._cors_origins()
    assert origins == (*config.DEV_ORIGINS, "https://terratrace.vercel.app", "https://terratrace.example.org")


def test_key_file_path_from_google_application_credentials(monkeypatch):
    import importlib
    monkeypatch.delenv("EE_SERVICE_ACCOUNT_KEY", raising=False)
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/etc/secrets/ee-service-account.json")
    fresh = importlib.reload(config)
    try:
        assert fresh.settings.ee_service_account_key == "/etc/secrets/ee-service-account.json"
    finally:
        monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS")
        importlib.reload(config)
