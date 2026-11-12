"""Gemini (Google Gen AI SDK, google-genai) for the AI chat.

Stateless: every call is one `models.generate_content` request with the whole (capped) conversation; nothing is
stored on Google's side by TerraTrace (the Interactions API, which stores conversations by default, is not used).
The key is read from GEMINI_API_KEY at call time (backend/.env); it is never logged or returned. Errors are reduced
to a code — provider error text (which may echo input) never leaves this module.
"""

from __future__ import annotations

import logging
import os
from typing import Any

log = logging.getLogger("terratrace.chat")
KEY_ENV = "GEMINI_API_KEY"


class ChatProviderError(Exception):
    """code: "busy" (429 / quota), "overloaded" (503: the model has no capacity right now), "unconfigured" (missing or
    rejected key), "timeout", "truncated", "failed" (anything else)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def configured() -> bool:
    return bool(os.environ.get(KEY_ENV, "").strip())


def generate(model: str, system: str, turns: list[dict[str, str]], schema: dict[str, Any], timeout_s: int,
             thinking: str = "low", max_output_tokens: int = 8192) -> str:
    """One answer as JSON text. `turns` = [{"role": "user"|"assistant", "text": ...}] (already validated and capped).

    Exactly ONE request: the SDK's retry is set to a single attempt (HttpRetryOptions.attempts counts the original
    request), so a 429, a 503 or a timeout is never retried here — the caller decides (services/chat/service.py cools
    down after a 429 and tries the fallback model once after a 503).
    `thinking`: the model's thinking level ("minimal" | "low" | "medium" | "high"; "default" = the model's own). Measured
    2026-10-10 with gemini-3.8-flash: the default thinking used most of a 2,048-token output budget (one answer was cut
    off mid-JSON) and two calls exceeded 30 s.
    """
    key = os.environ.get(KEY_ENV, "").strip()
    if not key:
        raise ChatProviderError("unconfigured")
    from google import genai
    from google.genai import errors, types

    client = genai.Client(api_key=key, http_options=types.HttpOptions(
        timeout=timeout_s * 1000, retry_options=types.HttpRetryOptions(attempts=1)))   # one attempt, no retries
    contents = [types.Content(role="model" if t["role"] == "assistant" else "user", parts=[types.Part(text=t["text"])])
                for t in turns]
    extra: dict[str, Any] = {}
    if thinking != "default":
        extra["thinking_config"] = types.ThinkingConfig(thinking_level=thinking.upper())
    config = types.GenerateContentConfig(system_instruction=system, response_mime_type="application/json",
                                         response_json_schema=schema, temperature=0.2,
                                         max_output_tokens=max_output_tokens, **extra)
    try:
        resp = client.models.generate_content(model=model, contents=contents, config=config)
    except errors.APIError as e:
        log.warning("Gemini error %s %s", type(e).__name__, getattr(e, "code", "?"))
        code = getattr(e, "code", None)
        raise ChatProviderError("busy" if code == 429 else "overloaded" if code == 503
                                else "unconfigured" if code in (401, 403) else "failed") from None
    except Exception as e:  # noqa: BLE001 — transport errors / timeouts; only the type is logged
        log.warning("Gemini request failed: %s", type(e).__name__)
        raise ChatProviderError("timeout" if "timeout" in type(e).__name__.lower() else "failed") from None
    # Diagnostics without content: finish reason and token counts only.
    cand = (getattr(resp, "candidates", None) or [None])[0]
    finish = str(getattr(cand, "finish_reason", None) or "").rsplit(".", 1)[-1]
    usage = getattr(resp, "usage_metadata", None)
    log.info("Gemini answer: finish=%s thoughts=%s output=%s", finish or "?",
             getattr(usage, "thoughts_token_count", None), getattr(usage, "candidates_token_count", None))
    if finish == "MAX_TOKENS":
        raise ChatProviderError("truncated")      # a cut-off answer is a provider failure, not a model answer
    text = getattr(resp, "text", None)
    if not text:
        raise ChatProviderError("failed")
    return text
