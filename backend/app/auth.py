"""Supabase access-token verification: the FastAPI dependency every backend WRITE that belongs to a user goes through.

    @router.post("/something")
    def write(user: AuthUser = Depends(require_user)): ...

Analysis stays public (no dependency). Tokens are verified locally — signature, expiry and audience "authenticated" —
with the project's JWKS (ES256/RS256, current Supabase default) or the legacy HS256 JWT secret. The service_role key is
never used or accepted: a token whose role is not "authenticated" is refused.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache

import jwt
from fastapi import HTTPException, Request

from .config import settings
from .errors import public_error

log = logging.getLogger("terratrace.auth")

ASYMMETRIC = ("ES256", "RS256", "EdDSA")


@dataclass(frozen=True)
class AuthUser:
    id: str
    email: str | None


def _fail(status: int, code: str, message: str) -> HTTPException:
    body = {**public_error(code, message, False), "message": message}
    headers = {"WWW-Authenticate": "Bearer"} if status == 401 else None
    return HTTPException(status_code=status, detail=body, headers=headers)


@lru_cache(maxsize=1)
def _jwks_client(url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{url}/auth/v1/.well-known/jwks.json", cache_keys=True, lifespan=3600, timeout=10)


def configured() -> bool:
    return bool(settings.supabase_url or settings.supabase_jwt_secret)


def verify(token: str) -> AuthUser:
    """The user a Supabase access token belongs to. Raises HTTPException 401 (bad token) or 503 (not configured)."""
    if not configured():
        raise _fail(503, "auth_unconfigured", "Accounts are not set up on this server.")
    try:
        alg = jwt.get_unverified_header(token).get("alg")
        if alg == "HS256" and settings.supabase_jwt_secret:
            key = settings.supabase_jwt_secret
        elif alg in ASYMMETRIC and settings.supabase_url:
            key = _jwks_client(settings.supabase_url).get_signing_key_from_jwt(token).key
        else:
            raise jwt.InvalidAlgorithmError(f"unsupported token algorithm {alg!r}")
        claims = jwt.decode(token, key, algorithms=[alg], audience="authenticated", options={"require": ["exp", "sub"]})
    except jwt.ExpiredSignatureError:
        raise _fail(401, "auth_expired", "Your session has expired. Sign in again.") from None
    except (jwt.PyJWTError, ValueError) as e:
        log.info("Rejected access token: %s", type(e).__name__)   # never the token itself
        raise _fail(401, "auth_required", "Sign in to do this.") from None
    if claims.get("role") != "authenticated":
        raise _fail(401, "auth_required", "Sign in to do this.")
    return AuthUser(id=str(claims["sub"]), email=claims.get("email"))


def _bearer(request: Request) -> str | None:
    scheme, _, token = (request.headers.get("authorization") or "").partition(" ")
    return (token.strip() or None) if scheme.lower() == "bearer" else None


def require_user(request: Request) -> AuthUser:
    """FastAPI dependency: the signed-in user, or 401."""
    token = _bearer(request)
    if not token:
        if not configured():
            raise _fail(503, "auth_unconfigured", "Accounts are not set up on this server.")
        raise _fail(401, "auth_required", "Sign in to do this.")
    return verify(token)


def optional_user(request: Request) -> AuthUser | None:
    """FastAPI dependency: the signed-in user when a valid token is sent, else None (never fails the request)."""
    token = _bearer(request)
    if not token or not configured():
        return None
    try:
        return verify(token)
    except HTTPException:
        return None
