"""Claude explanation provider (Anthropic API, server-side credentials only)."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import anthropic

from ...config import settings

log = logging.getLogger("terratrace.claude")

SYSTEM_PROMPT = """You are the explanation module of TERRATRACE, a satellite forest-change monitoring platform. Your readers are visitors at a university innovation expo and non-specialist decision makers.

You receive one JSON object with the measurements of a single detected change event. Write an analyst briefing using ONLY those measurements.

Rules:
- Every number you write must appear in the JSON. You may round it or express a 0-1 fraction as a percentage (0.62 -> 62%), but do not compute new quantities such as rates, sums, differences or shares of the study area.
- Do not name or speculate about who or what caused the change, why it happened, or whether it was legal. Say what the measurements are consistent with, for example "consistent with burning" or "consistent with removal of tree cover". Use the term "forest-cover change" unless the change type is a burn scar.
- Do not mention places, dates, satellites, datasets or events that are not in the JSON.
- The confidence score is an evidence score, not a calibrated probability; call it the evidence level.
- If a value is null, say it is not yet available instead of guessing.
- Explain each index in plain words the first time you use it: NDVI is vegetation greenness, NBR is a burn-sensitive index, tree probability is the model-estimated likelihood that a pixel is tree cover.

Format: exactly three short paragraphs of plain text (no markdown, no bullet points), 120-170 words in total, separated by blank lines. Begin them with the labels "What changed:", "Evidence:" and "Confidence & limits:"."""


class ProviderError(RuntimeError):
    def __init__(self, user_message: str):
        super().__init__(user_message)
        self.user_message = user_message


def configured() -> bool:
    if any(os.environ.get(k) for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE")):
        return True
    cfg = os.environ.get("ANTHROPIC_CONFIG_DIR")
    return Path(cfg).exists() if cfg else (Path.home() / ".config" / "anthropic").exists()


async def draft(facts: dict[str, Any]) -> tuple[str, str]:
    """Return (text, model). Raises ProviderError with a user-facing message."""
    try:
        client = anthropic.AsyncAnthropic()
        response = await client.with_options(timeout=40.0).beta.messages.create(
            model=settings.llm_model,
            max_tokens=4000,
            system=SYSTEM_PROMPT,
            output_config={"effort": settings.llm_effort},
            # If a safety classifier declines, the API retries on a fallback model within the same call.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": "Measurements for one detected change event (JSON):\n\n" + json.dumps(facts, indent=2, ensure_ascii=False)}],
        )
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.CredentialsError):
        raise ProviderError("AI credentials are not valid for this model") from None
    except anthropic.RateLimitError:
        raise ProviderError("AI service is rate-limited") from None
    except anthropic.BadRequestError as e:
        log.error("LLM rejected the request: %s", e.message)
        raise ProviderError("AI service rejected the request") from None
    except anthropic.APIStatusError as e:
        log.error("LLM API error %s: %s", e.status_code, e.message)
        raise ProviderError("AI service returned an error") from None
    except anthropic.APIConnectionError:
        raise ProviderError("AI service is unreachable") from None
    except (anthropic.AnthropicError, TypeError) as e:  # TypeError: no auth method resolvable
        log.warning("LLM unavailable: %s", e)
        raise ProviderError("AI credentials are not configured") from None

    if response.stop_reason == "refusal":
        raise ProviderError("AI model declined to explain this event")
    text = "\n\n".join(b.text.strip() for b in response.content if b.type == "text").strip()
    if not text:
        raise ProviderError("AI model returned no text")
    log.info("explained %s with %s (request %s)", facts.get("event_id"), response.model, response._request_id)
    return text, response.model
