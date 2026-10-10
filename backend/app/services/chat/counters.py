"""Chat outcome counters: reason CODES and counts only — never chat text, never client addresses.

Persisted to cache_dir/chat_counters.json so a restart keeps the totals. GET /api/chat/stats reads them.
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any

from ...config import settings
from .validator import REASONS

log = logging.getLogger("terratrace.chat")
FILE = settings.cache_dir / "chat_counters.json"
OUTCOMES = ("answered", "declined", "withheld", "unavailable")
_lock = threading.Lock()


def _empty() -> dict[str, Any]:
    return {"since": datetime.now(timezone.utc).isoformat(timespec="seconds"), "answered": 0, "declined": 0,
            "withheld": {r: 0 for r in REASONS}, "unavailable": {}}


def _load() -> dict[str, Any]:
    try:
        doc = json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _empty()
    base = _empty()
    base.update({k: doc[k] for k in base if k in doc})
    base["withheld"] = {r: int((doc.get("withheld") or {}).get(r, 0)) for r in REASONS}
    return base


_state: dict[str, Any] | None = None


def record(outcome: str, code: str | None = None) -> None:
    """Count one outcome. `code` must be a reason/error code (validated against known codes; free text is refused)."""
    global _state
    if outcome not in OUTCOMES:
        raise ValueError("unknown outcome")
    if outcome == "withheld" and code not in REASONS:
        raise ValueError("unknown reason")
    if outcome == "unavailable" and (not code or not code.replace("_", "").isalnum() or len(code) > 40):
        raise ValueError("bad code")
    with _lock:
        if _state is None:
            _state = _load()
        if outcome in ("answered", "declined"):
            _state[outcome] += 1
        elif outcome == "withheld":
            _state["withheld"][code] += 1
        else:
            _state["unavailable"][code] = _state["unavailable"].get(code, 0) + 1
        try:
            FILE.parent.mkdir(parents=True, exist_ok=True)
            FILE.write_text(json.dumps(_state), encoding="utf-8")
        except OSError as e:
            log.warning("Chat counters not saved (%s)", type(e).__name__)
    log.info("chat %s%s", outcome, f" {code}" if code else "")


def snapshot() -> dict[str, Any]:
    global _state
    with _lock:
        if _state is None:
            _state = _load()
        return json.loads(json.dumps(_state))


def reset() -> None:
    """Tests only."""
    global _state
    with _lock:
        _state = _empty()
        FILE.unlink(missing_ok=True)
