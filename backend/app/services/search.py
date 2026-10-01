"""Global search: coordinates → featured investigations → forest gazetteer → OpenStreetMap Nominatim."""

from __future__ import annotations

import asyncio
import re
import time
import unicodedata
from typing import Any

import httpx

from ..config import settings
from ..providers import registry

# Navigation extents (approximate) for well-known forest regions. Used to fly the camera, not for analysis.
FORESTS: list[dict[str, Any]] = [
    {"name": "Amazon Rainforest", "detail": "South America · tropical moist forest", "bbox": (-73.5, -15.0, -48.0, 2.5)},
    {"name": "Congo Basin", "detail": "Central Africa · tropical moist forest", "bbox": (12.0, -6.0, 30.0, 5.0)},
    {"name": "Borneo", "detail": "Southeast Asia · tropical rainforest", "bbox": (108.5, -4.5, 119.5, 7.5)},
    {"name": "Sumatra", "detail": "Indonesia · tropical rainforest", "bbox": (95.0, -6.0, 106.0, 6.0)},
    {"name": "New Guinea", "detail": "Oceania · tropical rainforest", "bbox": (131.0, -10.5, 151.0, 0.0)},
    {"name": "Western Ghats", "detail": "India · tropical wet & moist deciduous forest", "bbox": (73.0, 8.0, 77.6, 21.0)},
    {"name": "Sundarbans", "detail": "India / Bangladesh · mangrove forest", "bbox": (88.0, 21.5, 89.9, 22.6)},
    {"name": "Atlantic Forest (Mata Atlântica)", "detail": "Brazil · tropical & subtropical forest", "bbox": (-50.0, -28.0, -35.0, -8.0)},
    {"name": "Gran Chaco", "detail": "South America · dry forest", "bbox": (-65.0, -28.0, -57.0, -18.0)},
    {"name": "Daintree Rainforest", "detail": "Australia · tropical rainforest", "bbox": (145.2, -16.45, 145.5, -16.0)},
    {"name": "Białowieża Forest", "detail": "Poland / Belarus · temperate forest", "bbox": (23.55, 52.55, 24.05, 52.95)},
    {"name": "Black Forest", "detail": "Germany · temperate forest", "bbox": (7.8, 47.6, 8.6, 48.9)},
    {"name": "Tongass National Forest", "detail": "USA · temperate rainforest", "bbox": (-136.5, 54.7, -130.0, 59.5)},
    {"name": "Hyrcanian Forests", "detail": "Iran / Azerbaijan · temperate broadleaf", "bbox": (48.5, 36.0, 56.0, 38.8)},
    {"name": "Kaziranga", "detail": "India · tropical forest & grassland", "bbox": (93.1, 26.55, 93.6, 26.8)},
    {"name": "Sal forests of Chhattisgarh", "detail": "India · tropical dry deciduous", "bbox": (81.5, 21.5, 83.5, 23.5)},
]


def _norm(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower().strip()


COORD = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?\s*$")


def parse_coordinates(q: str) -> tuple[float, float] | None:
    """'23.12, 77.45' | '23.12N 77.45E' | '-9.9 -63.4' → (lon, lat)."""
    m = COORD.match(q)
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(3))
    if m.group(2) and m.group(2).upper() == "S":
        lat = -abs(lat)
    if m.group(4) and m.group(4).upper() == "W":
        lon = -abs(lon)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lon, lat


def _center(b: tuple[float, float, float, float]) -> tuple[float, float]:
    return (round((b[0] + b[2]) / 2, 5), round((b[1] + b[3]) / 2, 5))


_last_call = 0.0
_cache: dict[str, list[dict[str, Any]]] = {}
_lock = asyncio.Lock()


async def _nominatim(q: str) -> list[dict[str, Any]]:
    global _last_call
    key = _norm(q)
    if key in _cache:
        return _cache[key]
    async with _lock:  # Nominatim usage policy: ≤ 1 request / second, identifying User-Agent
        wait = 1.05 - (time.monotonic() - _last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_call = time.monotonic()
        async with httpx.AsyncClient(timeout=6.0, headers={"User-Agent": settings.user_agent}) as client:
            r = await client.get("https://nominatim.openstreetmap.org/search", params={"q": q, "format": "jsonv2", "limit": 6})
            r.raise_for_status()
            data = r.json()
    out = []
    for d in data:
        s, n, w, e = (float(v) for v in d["boundingbox"])
        name, _, rest = d.get("display_name", "").partition(",")
        out.append({
            "name": name.strip() or q, "detail": rest.strip()[:90] or d.get("type"), "kind": "place",
            "center": (round(float(d["lon"]), 5), round(float(d["lat"]), 5)), "bbox": (w, s, e, n), "source": "OpenStreetMap Nominatim",
        })
    _cache[key] = out
    if len(_cache) > 500:   # keyed by free text: bounded, oldest first
        _cache.pop(next(iter(_cache)))
    return out


async def search(q: str) -> tuple[list[dict[str, Any]], str | None]:
    """Results plus an optional notice (e.g. geocoder offline)."""
    q = q.strip()
    if not q:
        return [], None
    coords = parse_coordinates(q)
    if coords:
        lon, lat = coords
        return [{"name": f"{abs(lat):.4f}°{'N' if lat >= 0 else 'S'}, {abs(lon):.4f}°{'E' if lon >= 0 else 'W'}", "detail": "Coordinates",
                 "kind": "coordinates", "center": (lon, lat), "bbox": (lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05), "source": "input"}], None

    nq = _norm(q)
    results: list[dict[str, Any]] = []
    for a in registry.featured()["items"]:
        hay = _norm(" ".join([a["name"], a["short_name"], a["region"], a["country"]]))
        # Also when the study's short name is part of a longer query ("Similipal National Park").
        if nq in hay or any(w.startswith(nq) for w in hay.split()) or _norm(a["short_name"]) in nq:
            results.append({"name": a["name"], "detail": f"Featured investigation · {a['region']}", "kind": "featured",
                            "center": tuple(a["center"]), "bbox": tuple(a["bbox"]), "study_area_id": a["id"], "source": "TERRATRACE"})
    for f in FORESTS:
        if nq in _norm(f["name"]) or nq in _norm(f["detail"]):
            results.append({"name": f["name"], "detail": f["detail"], "kind": "forest", "center": _center(f["bbox"]), "bbox": f["bbox"], "source": "TERRATRACE gazetteer"})

    notice = None
    if settings.geocoder_enabled and len(results) < 6:
        try:
            seen = {_norm(r["name"]) for r in results}
            for r in await _nominatim(q):
                if _norm(r["name"]) not in seen:
                    results.append(r)
        except (httpx.HTTPError, ValueError, KeyError):
            notice = "Place search is offline — showing TERRATRACE gazetteer results only."
    return results[:8], notice
