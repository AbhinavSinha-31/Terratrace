"""Featured investigations: predefined AOIs only (no analysis results).

A featured investigation is just a curated area of interest with context. Every
measurement shown for it must come from live Earth Engine analysis like any
other AOI.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

REGISTRY = Path(__file__).resolve().parents[1] / "data" / "featured_investigations.json"


@lru_cache(maxsize=1)
def featured() -> dict[str, Any]:
    return json.loads(REGISTRY.read_text(encoding="utf-8"))


def get(area_id: str) -> dict[str, Any] | None:
    return next((a for a in featured()["items"] if a["id"] == area_id), None)
