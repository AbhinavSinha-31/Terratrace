"""Supabase access-token verification (app/auth.py) and the protected GET /api/me."""

import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app import auth
from app.main import app

client = TestClient(app)
SECRET = "test-jwt-secret-with-at-least-32-characters!"
USER = "6f1c2a4e-1d2b-4c3d-9e8f-0a1b2c3d4e5f"


def token(key=SECRET, alg="HS256", **over):
    claims = {"sub": USER, "aud": "authenticated", "role": "authenticated", "email": "a@example.org", "exp": int(time.time()) + 600, **over}
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, key, algorithm=alg)


def configure(monkeypatch, url=None, secret=None):
    monkeypatch.setattr(auth, "settings", SimpleNamespace(**{**vars(auth.settings), "supabase_url": url, "supabase_jwt_secret": secret}))


@pytest.fixture
def secret(monkeypatch):
    configure(monkeypatch, secret=SECRET)


def get_me(tok=None):
    return client.get("/api/me", headers={"Authorization": f"Bearer {tok}"} if tok else {})


def test_unconfigured_is_503_not_a_crash(monkeypatch):
    configure(monkeypatch)
    r = get_me(token())
    assert r.status_code == 503 and r.json()["detail"]["code"] == "auth_unconfigured"


def test_valid_hs256_token_returns_the_user(secret):
    r = get_me(token())
    assert r.status_code == 200 and r.json() == {"id": USER, "email": "a@example.org"}


@pytest.mark.parametrize("tok, code", [
    (None, "auth_required"),
    ("not-a-jwt", "auth_required"),
    (lambda: token(key="another-secret-of-sufficient-length-123456"), "auth_required"),
    (lambda: token(exp=int(time.time()) - 5), "auth_expired"),
    (lambda: token(aud="something-else"), "auth_required"),
    (lambda: token(role="service_role"), "auth_required"),      # service_role is never accepted as a user
    (lambda: token(role="anon"), "auth_required"),
    (lambda: token(exp=None), "auth_required"),
])
def test_bad_tokens_are_401(secret, tok, code):
    r = get_me(tok() if callable(tok) else tok)
    assert r.status_code == 401 and r.json()["detail"]["code"] == code
    assert r.headers.get("www-authenticate") == "Bearer"
    assert "eyJ" not in r.text   # the token is never echoed


def test_alg_none_is_refused(secret):
    unsigned = jwt.encode({"sub": USER, "aud": "authenticated", "role": "authenticated", "exp": int(time.time()) + 600}, None, algorithm="none")
    assert get_me(unsigned).status_code == 401


def test_asymmetric_token_is_verified_with_the_project_jwks(monkeypatch):
    priv = ec.generate_private_key(ec.SECP256R1())
    configure(monkeypatch, url="https://proj.supabase.co")

    class FakeJwks:
        def get_signing_key_from_jwt(self, _):
            return type("K", (), {"key": priv.public_key()})()

    monkeypatch.setattr(auth, "_jwks_client", lambda url: FakeJwks())
    assert get_me(token(key=priv, alg="ES256")).status_code == 200
    other = ec.generate_private_key(ec.SECP256R1())
    assert get_me(token(key=other, alg="ES256")).status_code == 401
    assert get_me(token()).status_code == 401   # HS256 without a configured secret


def test_optional_user_never_fails(secret):
    from starlette.requests import Request
    req = lambda h: Request({"type": "http", "headers": [(b"authorization", h.encode())] if h else []})
    assert auth.optional_user(req(None)) is None
    assert auth.optional_user(req("Bearer junk")) is None
    assert auth.optional_user(req(f"Bearer {token()}")).id == USER
