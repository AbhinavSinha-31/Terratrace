"""Per-client rate limits (app/ratelimit.py) are applied to every route that can start Earth Engine or LLM work."""

import pytest
from fastapi.testclient import TestClient

from app import ratelimit
from app.main import app

client = TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize("method,path,group", [
    ("POST", "/api/analysis-jobs", "analysis"),
    ("POST", "/api/analyze", "analysis"),
    ("GET", "/api/analysis/silent-valley", "analysis"),
    ("GET", "/api/analysis/silent-valley/history", "compute"),
    ("GET", "/api/imagery/availability", "compute"),
    ("GET", "/api/imagery", "compute"),
    ("POST", "/api/aoi", "compute"),
    ("POST", "/api/aoi/preview", "compute"),
    ("GET", "/api/search", "search"),
    ("POST", "/api/explain", "explain"),
])
def test_expensive_routes_are_limited(method, path, group):
    assert ratelimit.group_of(method, path) == group


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/health"), ("GET", "/api/analysis-jobs/0123456789abcdef"), ("GET", "/api/analysis-status/silent-valley"),
    ("GET", "/api/imagery/basemaps"), ("GET", "/api/tiles/silent-valley/forest/2020/1/0/0"),
])
def test_cheap_reads_are_not_limited(method, path):
    assert ratelimit.group_of(method, path) is None


def test_over_the_limit_returns_a_public_429_with_retry_after(monkeypatch):
    monkeypatch.setattr(ratelimit, "limit_for", lambda group: 2)
    codes = [client.get("/api/search", params={"q": "hasdeo"}).status_code for _ in range(3)]
    assert codes[:2] == [200, 200] and codes[2] == 429
    r = client.get("/api/search", params={"q": "hasdeo"})
    d = r.json()["detail"]
    assert d["code"] == "rate_limited" and d["retryable"] is True and int(r.headers["Retry-After"]) >= 1


def test_limits_are_per_client_and_per_group():
    lim = ratelimit.RateLimiter()
    for _ in range(ratelimit.limit_for("explain")):
        assert lim.check("a", "explain", now=0.0) is None
    assert lim.check("a", "explain", now=1.0) is not None
    assert lim.check("b", "explain", now=1.0) is None          # another client
    assert lim.check("a", "search", now=1.0) is None           # another group
    assert lim.check("a", "explain", now=61.0) is None         # window has passed
