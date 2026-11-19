"""Explanation service: measured facts in → analyst briefing out.

Providers
  offline  deterministic template; can only restate supplied facts (always available)
  claude   Claude via the Anthropic API (server-side key), constrained prompt + numeric fact-check

The model never detects change, never computes numbers and never attributes
cause; any draft containing a number absent from the facts is rejected and the
offline briefing is returned instead, with a notice.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from ...config import settings
from ...providers.ai import claude

log = logging.getLogger("terratrace.explain")
PROMPT_VERSION = "explain-v2"
CACHE_DIR = settings.cache_dir / "explanations"
NUMBER = re.compile(r"(?<![\w.])[-−+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?")

LAND = {
    "water": "water", "trees": "trees", "grass": "grass / pasture", "flooded_vegetation": "flooded vegetation", "crops": "cropland",
    "shrub_and_scrub": "shrub & scrub", "built": "built-up land", "bare": "bare ground", "snow_and_ice": "snow & ice",
}


# --------------------------------------------------------------------------- fact check
def _parse(token: str) -> float:
    return float(token.replace(",", "").replace("−", "-").replace("+", ""))


def _fact_numbers(obj: Any) -> list[float]:
    if isinstance(obj, bool) or obj is None:
        return []
    if isinstance(obj, (int, float)):
        return [float(obj)]
    if isinstance(obj, str):
        return [_parse(t) for t in NUMBER.findall(obj)]
    if isinstance(obj, dict):
        return [n for v in obj.values() for n in _fact_numbers(v)]
    if isinstance(obj, list):
        return [n for v in obj for n in _fact_numbers(v)]
    return []


def fact_check(text: str, facts: dict[str, Any]) -> list[str]:
    """Every number in `text` that cannot be traced to the facts (rounding / % allowed)."""
    cands: list[tuple[float, float]] = []
    for v in _fact_numbers(facts):
        for a in (v, abs(v)):
            cands.append((a, 0.006 if abs(a) < 2 else 0.51))
            cands.append((a * 100, 0.51))
    bad = []
    for tok in NUMBER.findall(text):
        x = _parse(tok)
        if not any(abs(x - a) <= t or abs(abs(x) - a) <= t for a, t in cands):
            bad.append(tok)
    return bad


def count_leaves(obj: Any) -> int:
    if isinstance(obj, dict):
        return sum(count_leaves(v) for v in obj.values())
    if isinstance(obj, list):
        return sum(count_leaves(v) for v in obj)
    return 1


# --------------------------------------------------------------------------- offline briefing
def offline_briefing(f: dict[str, Any]) -> str:
    def f2(v: float) -> str:
        return f"{v:.2f}"

    def sign(v: float) -> str:
        return f"+{v:.2f}" if v > 0 else f"{v:.2f}"

    def pct(v: float) -> str:
        return f"{round(v * 100)}%"

    fire = f.get("change_type") == "fire"
    after = LAND.get(f["land_cover"]["after"], f["land_cover"]["after"])
    area = f["area"]
    what = (
        f"What changed: Between the {f['period']['from_year']} and {f['period']['to_year']} satellite composites "
        f"({f['period']['composite_window']}), TERRATRACE detected {'a burn scar' if fire else 'forest-cover change'} covering "
        f"{area['hectares']:,.1f} ha ({area['square_km']:.2f} km²) in Sector {f['sector']} of {f['study_area']}. "
        f"About {pct(f['share_of_forest_converted'])} of the forest pixels in the patch no longer qualify as forest, and the "
        f"dominant land cover changed from trees to {after}."
    )
    signature = (
        f"The NBR drop is larger than the NDVI drop, the spectral pattern expected after burning; the severity basis is: {f['severity']['basis']}."
        if fire else
        f"All three indicators fell together, which is consistent with removal of tree cover{' and exposure of bare ground' if f['land_cover']['after'] == 'bare' else ''}."
    )
    ev = (
        f"Evidence: Vegetation greenness (NDVI) fell from {f2(f['ndvi']['before'])} to {f2(f['ndvi']['after'])} ({sign(f['ndvi']['change'])}), "
        f"the burn-sensitive index NBR from {f2(f['nbr']['before'])} to {f2(f['nbr']['after'])} ({sign(f['nbr']['change'])}), and the modelled "
        f"tree probability from {f2(f['tree_probability']['before'])} to {f2(f['tree_probability']['after'])}. {signature}"
    )
    failed = [e["check"].lower() for e in f.get("evidence", []) if e.get("passed") is False]
    p = f.get("persistence_next_year")
    persist = (
        "Whether the change persists cannot be checked until the next annual composite." if p is None else
        f"{pct(p)} of the changed area was still non-forest in the following year." if p >= 0.7 else
        f"Only {pct(p)} of the changed area was still non-forest in the following year, which lowers the evidence level."
    )
    ref = f.get("reference_overlap_hansen")
    reference = (
        "External reference data for this period is not yet available." if ref is None else
        f"{pct(ref)} of the patch overlaps independent Hansen forest-loss data"
        + (", which records mainly stand-replacing loss rather than burns." if fire and ref < 0.3 else ".")
    )
    c = f["confidence"]
    conf = (
        f"Confidence & limits: The evidence level is {c['class']} (score {pct(c['score'])}), with {c['checks_passed']} of "
        f"{c['checks_evaluated']} evaluated checks passed{f' (not met: ' + ', '.join(failed) + ')' if failed else ''}. "
        f"{persist} {reference} These measurements show that a change occurred; they do not show who or what caused it."
    )
    return "\n\n".join([what, ev, conf])


def _offline(facts: dict[str, Any], notice: str | None) -> dict[str, Any]:
    return {
        "text": offline_briefing(facts), "source": "template", "model": None, "fact_check": {"passed": True, "unmatched": []},
        "facts_used": count_leaves(facts), "generated_at": datetime.now(timezone.utc).isoformat(), "cached": False,
        "notice": notice, "prompt_version": PROMPT_VERSION,
    }


NO_ANALYSIS = (
    "I don't have a completed satellite analysis for this area yet. A completed Earth Engine analysis is required "
    "before I can interpret any results — I will not describe changes that have not been measured."
)


def _is_measured(facts: dict[str, Any]) -> bool:
    """Only facts from a READY live Earth Engine analysis may be explained."""
    return facts.get("data_mode") == "LIVE" and facts.get("analysis_status") == "READY"


def withheld() -> dict[str, Any]:
    """The refusal returned when the facts are not those of a completed live analysis."""
    return {
        "text": NO_ANALYSIS, "source": "none", "model": None, "fact_check": None,
        "facts_used": 0, "generated_at": datetime.now(timezone.utc).isoformat(), "cached": False,
        "notice": "Explanation withheld: no published analysis.", "prompt_version": PROMPT_VERSION,
    }


def matches_event(facts: dict[str, Any], props: dict[str, Any]) -> bool:
    """Do the client-sent facts carry the STORED event's identity and core measurements? The facts arrive from the
    browser, so `data_mode`/`analysis_status` alone prove nothing: the event must exist in a READY result and its
    period, type and area must be the stored ones (facts.ts builds them from exactly these properties)."""
    period, area = facts.get("period"), facts.get("area")
    if not isinstance(period, dict) or not isinstance(area, dict):
        return False
    return (period.get("from_year") == props.get("year_from") and period.get("to_year") == props.get("year_to")
            and facts.get("change_type") == props.get("change_type")
            and area.get("hectares") == props.get("area_ha") and area.get("square_km") == props.get("area_km2"))


async def explain(facts: dict[str, Any], prefer: str = "auto") -> dict[str, Any]:
    """Return an explanation; never raises for provider problems (falls back to offline).
    The caller must already have verified the facts against the stored event (matches_event)."""
    if not _is_measured(facts):
        return withheld()
    if prefer == "offline" or not claude.configured():
        note = None if prefer == "offline" else "Showing the deterministic TERRATRACE briefing, generated from the measured facts."
        return _offline(facts, note)

    key = hashlib.sha256(json.dumps({"p": PROMPT_VERSION, "m": settings.llm_model, "f": facts}, sort_keys=True).encode()).hexdigest()[:24]
    path = CACHE_DIR / f"{key}.json"
    if path.exists():
        return {**json.loads(path.read_text(encoding="utf-8")), "cached": True}

    try:
        text, model = await claude.draft(facts)
    except claude.ProviderError as e:
        log.warning("AI provider unavailable: %s", e)   # provider detail stays server-side
        return _offline(facts, "The language-model briefing is unavailable right now — showing the deterministic TERRATRACE briefing.")

    unmatched = fact_check(text, facts)
    if unmatched:
        log.warning("AI draft rejected by fact-check: %s", unmatched)
        return _offline(facts, f"AI draft rejected by the numeric fact-check (unsupported: {', '.join(unmatched[:6])}) — showing the deterministic briefing.")

    result = {
        "text": text, "source": "llm", "model": model, "fact_check": {"passed": True, "unmatched": []},
        "facts_used": count_leaves(facts), "generated_at": datetime.now(timezone.utc).isoformat(),
        "notice": None, "prompt_version": PROMPT_VERSION,
    }
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    return {**result, "cached": False}
