"""Public error contract.

Everything that can reach the browser is one of these structured errors:

    {"code": "...", "user_message": "...", "retryable": true|false}

`user_message` is product language only — never exception text, stack traces, file paths,
request IDs, dataset/reducer names, environment variables or setup instructions. Detailed
diagnostics stay in the server log. With DEV_DIAGNOSTICS=true (local development only) a
`diagnostics` block with non-secret facts (stage, error type, elapsed time) is added.
"""

from __future__ import annotations

from typing import Any

from .config import settings

PUBLIC_MESSAGES: dict[str, tuple[str, bool]] = {
    # Live analysis cannot run at all (backend reachable but Earth Engine unavailable / misconfigured).
    "service_unavailable": ("Live Earth observation is temporarily unavailable for this investigation. "
                            "TERRATRACE does not display estimated, simulated, or placeholder measurements.", True),
    "analysis_timeout": ("The requested analysis exceeded the available computation window. "
                         "No forest-change measurements were generated.", True),
    "analysis_too_large": ("This investigation covers a large area or time range that cannot be completed interactively. "
                           "Try a smaller area or shorter analysis window.", False),
    "insufficient_imagery": ("Insufficient usable imagery: there is not enough satellite imagery over this area for the requested years. "
                             "No forest-change measurements were generated.", False),
    "analysis_failed": ("The analysis could not be completed. No forest-change measurements were generated.", True),
    # Earth Engine could not be reached at all (DNS / network down on the machine running TERRATRACE).
    "earth_engine_unreachable": ("Live Earth observation could not be reached — the network connection to Google Earth Engine failed. "
                                 "Check the internet connection and try again. No forest-change measurements were generated.", True),
    # Earth Engine answered 429: the project's concurrency quota is exhausted (noncommercial Restricted Mode).
    "earth_engine_throttled": ("Google Earth Engine is throttling requests for this project right now. "
                               "Try again in a minute. No forest-change measurements were generated.", True),
    "internal_error": ("Something went wrong while preparing this request. No measurements were generated.", True),
    "not_found": ("This area is not available. Select or draw the area again.", False),
    "invalid_request": ("The request could not be processed. Check the selected area and years.", False),
    "tiles_unavailable": ("Analysis imagery is temporarily unavailable.", True),
    "imagery_check_failed": ("Imagery availability could not be checked right now.", True),
    # Read-only lookup of a stored result that does not exist (GET /api/analysis-result).
    "not_run": ("This analysis has not been run yet.", False),
    # Analysis RESULTS (not refusals) for areas where no satellite imagery can exist; retrying cannot change them.
    "outside_sentinel2_coverage": ("No Sentinel-2 imagery at this latitude: Sentinel-2 systematically images land between 56° S "
                                   "and 82.8° N, so there is nothing to analyse here.", False),
    "open_water": ("Sentinel-2 does not image the open ocean, so there is no imagery to analyse here.", False),
    # Accounts (app/auth.py).
    "auth_required": ("Sign in to do this.", False),
    "auth_expired": ("Your session has expired. Sign in again.", False),
    "auth_unconfigured": ("Accounts are not set up on this server.", False),
    # AI chat (POST /api/chat). Never contains chat text, model output or provider error text.
    "chat_disabled": ("The AI chat is switched off on this server.", False),
    "chat_unavailable": ("The AI chat is not available right now. Try again later.", True),
    "chat_busy": ("The AI chat is busy right now. Please try again shortly.", True),
    "chat_daily_limit": ("The AI chat has reached its limit for today. Try again tomorrow.", False),
    # Per-client request limit reached (app/ratelimit.py). Explicit, retryable — the request was not processed.
    "rate_limited": ("Too many requests in a short time. Wait a moment and try again.", True),
}


def public_error(code: str, user_message: str | None = None, retryable: bool | None = None) -> dict[str, Any]:
    """Structured public error. `user_message` may only be text TERRATRACE itself wrote."""
    default_msg, default_retry = PUBLIC_MESSAGES.get(code, PUBLIC_MESSAGES["internal_error"])
    return {"code": code, "user_message": user_message or default_msg, "retryable": default_retry if retryable is None else retryable}


def diagnostics(**facts: Any) -> dict[str, Any] | None:
    """Developer diagnostics — only when DEV_DIAGNOSTICS=true. Callers pass non-secret facts only
    (stage names, exception TYPE, elapsed seconds); never exception messages, paths or credentials."""
    return {k: v for k, v in facts.items() if v is not None} if settings.dev_diagnostics else None
