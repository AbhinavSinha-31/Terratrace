"""AI chat orchestration: limits -> facts -> model call (+ one fallback call on 503) -> deterministic checks ->
answer, decline or withhold.

Nothing the user or the model wrote is logged, counted or put in an error message: only outcome and reason codes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from ...config import settings
from ...errors import public_error
from ...providers.ai import gemini
from . import counters, facts as chat_facts, translation
from .prompt import LEAK_MARKERS, PROMPT_VERSION, RESPONSE_SCHEMA, system_instruction
from .validator import validate

log = logging.getLogger("terratrace.chat")

NOTICE = ("Don't enter personal information. AI explanations can be wrong; figures come from TerraTrace data with "
          "their dataset and year.")
DECLINE = translation.DECLINE["en"]
Progress = Callable[[str], Awaitable[None]]   # streaming: "asking" | "fallback" | "checking" (stage names only, no text)


async def _no_progress(_: str) -> None:
    return None
WITHHELD: dict[str, str] = {
    "forest_figure_in_general": "it gave a forest figure that does not come from TerraTrace's data.",
    "place_change_claim_in_general": "it made a claim about forest change in a specific place without TerraTrace data behind it.",
    "other_place_in_place_segment": "it used this area's data to talk about another place.",
    "unsupported_number": "it stated a number that does not match TerraTrace's data.",
    "uncited_place_claim": "it made a claim about this area without citing TerraTrace's data.",
    "uncited_reference": "it quoted a method or dataset figure without a verified source.",
    "place_in_reference": "it mixed a place into a method or dataset fact.",
    "non_english": "answers can only be checked in English for now.",
    "malformed": "the answer could not be checked.",
    "prompt_leak": "the answer could not be checked.",
}


class ChatRefused(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status, self.code = status, code


class _Caps:
    """Per-client daily, whole-backend per-minute and per-day caps (UTC day). In-process, like app/ratelimit.py."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._day = ""
        self._per_client: dict[str, int] = {}
        self._global_day = 0
        self._minute: deque[float] = deque()

    def take(self, client: str, now: float | None = None) -> str | None:
        now = time.monotonic() if now is None else now
        day = datetime.now(timezone.utc).date().isoformat()
        with self._lock:
            if day != self._day:
                self._day, self._per_client, self._global_day = day, {}, 0
            while self._minute and now - self._minute[0] >= 60:
                self._minute.popleft()
            if settings.chat_global_per_day and self._global_day >= settings.chat_global_per_day:
                return "chat_daily_limit"
            if settings.chat_per_client_per_day and self._per_client.get(client, 0) >= settings.chat_per_client_per_day:
                return "chat_daily_limit"
            if settings.chat_global_per_min and len(self._minute) >= settings.chat_global_per_min:
                return "chat_busy"
            self._minute.append(now)
            self._global_day += 1
            self._per_client[client] = self._per_client.get(client, 0) + 1
            if len(self._per_client) > 50_000:
                self._per_client.clear()
            return None

    def reset(self) -> None:
        with self._lock:
            self._day, self._per_client, self._global_day = "", {}, 0
            self._minute.clear()


caps = _Caps()


class _Cooldown:
    """After Gemini answers 429 (quota exhausted), nothing is sent to Gemini for chat_cooldown_s: requests answer
    "busy" at once instead of hammering the quota. A question costs one provider request — two only when the primary
    model answers 503 and the fallback model is tried once; a 429 is never retried."""

    def __init__(self) -> None:
        self._until = 0.0
        self._lock = threading.Lock()

    def active(self, now: float | None = None) -> bool:
        with self._lock:
            return (time.monotonic() if now is None else now) < self._until

    def start(self, seconds: float, now: float | None = None) -> None:
        with self._lock:
            self._until = (time.monotonic() if now is None else now) + seconds

    def reset(self) -> None:
        with self._lock:
            self._until = 0.0


cooldown = _Cooldown()


def status() -> tuple[str, str | None]:
    """(status, product-language detail) for /api/health."""
    if not settings.chat_enabled:
        return "offline", "AI chat is switched off"
    if settings.chat_provider != "gemini" or not gemini.configured():
        return "unconfigured", "AI chat is not available"
    return "ready", None


def _unavailable(code: str, counted: str | None = None) -> dict[str, Any]:
    """`code` is the public error; `counted` an optional finer code for the counters (e.g. chat_timeout)."""
    counters.record("unavailable", counted or code)
    err = public_error(code)
    return {"status": "unavailable", "segments": [], "message": err["user_message"], "reason_code": code, "error": err,
            "notice": NOTICE, "model": None}


async def _generate(system: str, messages: list[dict[str, str]], progress: Progress = _no_progress) -> tuple[str, str]:
    """(raw answer, model that produced it). The primary model first; if it answers 503 (overloaded) and a different
    fallback model is configured, that model is tried ONCE. Its error, if any, is the one the caller sees."""
    def call(model: str):
        return asyncio.to_thread(gemini.generate, model, system, messages, RESPONSE_SCHEMA, settings.chat_timeout_s,
                                 settings.chat_thinking, settings.chat_max_output_tokens)
    try:
        return await call(settings.chat_model), settings.chat_model
    except gemini.ChatProviderError as e:
        fallback = settings.chat_fallback_model
        if e.code != "overloaded" or not fallback or fallback == settings.chat_model:
            raise
        log.info("chat: primary model overloaded (503); one attempt on the fallback model")
        await progress("fallback")
        return await call(fallback), fallback


def _render(answer: dict[str, Any], public: dict[str, dict[str, Any]], show_local: bool) -> list[dict[str, Any]]:
    out = []
    for s in answer["segments"]:
        cites = [public[c] for c in dict.fromkeys(s.get("fact_ids") or []) if c in public] if s["kind"] != "general" else []
        out.append({"kind": s["kind"], "text": s["text"].strip(), "citations": cites,
                    "text_local": s["text_local"].strip() if show_local else None})
    return out


async def answer(messages: list[dict[str, str]], aoi_id: str | None, window: tuple[int, int] | None, client: str,
                 progress: Progress = _no_progress) -> dict[str, Any]:
    """`progress` receives stage names while the answer is being made (for /api/chat/stream); the result is the same
    with or without it. Nothing is ever shown before every check has passed."""
    st, _ = status()
    if st == "offline":
        return _unavailable("chat_disabled")
    if st != "ready":
        return _unavailable("chat_unavailable")
    if aoi_id:
        place, place_index, place_public, area_names, area_name = await asyncio.to_thread(chat_facts.place_facts, aoi_id, window)
    else:
        place, place_index, place_public, area_names, area_name = [], {}, {}, set(), None
    if cooldown.active():
        return _unavailable("chat_busy", "chat_cooldown")
    refused = caps.take(client)
    if refused:
        counters.record("unavailable", refused)
        raise ChatRefused(429, refused)
    ref_prompt, ref_index, ref_public = chat_facts.reference_facts()
    system = system_instruction(area_name, place, ref_prompt)
    lang = translation.detect(messages[-1]["text"])   # the user's language, from their own words (not the model's)
    await progress("asking")
    try:
        raw, used_model = await _generate(system, messages, progress)
    except gemini.ChatProviderError as e:
        if e.code == "busy":          # 429: quota — cool down, then "busy, try again shortly"
            cooldown.start(settings.chat_cooldown_s)
            return _unavailable("chat_busy", "chat_quota_429")
        if e.code == "overloaded":    # 503 on the primary (and the fallback, if any): temporary — "busy, try again shortly"
            return _unavailable("chat_busy", "chat_overloaded_503")
        return _unavailable("chat_unavailable", f"chat_{e.code}")
    await progress("checking")
    try:
        parsed = json.loads(raw)
    except ValueError:
        parsed = None
    verdict = validate(parsed, place_index, ref_index, area_names, LEAK_MARKERS)   # checks the ENGLISH text, unchanged
    base = {"notice": NOTICE, "model": used_model, "prompt_version": PROMPT_VERSION, "error": None, "language": lang,
            "translation": "none"}
    if not verdict.ok:
        counters.record("withheld", verdict.reason)
        return {**base, "status": "withheld", "segments": [], "reason_code": verdict.reason,
                "message": f"Answer withheld: {WITHHELD[verdict.reason]}"}
    if parsed["in_scope"] is False:
        counters.record("declined")
        return {**base, "status": "declined", "segments": [], "reason_code": None, "message": translation.DECLINE[lang]}
    counters.record("answered")
    # The user's language: shown only if EVERY segment's translation passes the checks against its checked English.
    show_local, note = False, None
    if lang != "en":
        why = translation.check(parsed["segments"], lang, LEAK_MARKERS)
        show_local = why is None
        if why:
            log.info("chat translation dropped: %s", why)   # reason code only
            note = translation.DROPPED_NOTE[lang]
        base["translation"] = "shown" if show_local else "dropped"
    return {**base, "status": "answered", "segments": _render(parsed, {**place_public, **ref_public}, show_local),
            "reason_code": None, "message": note}
