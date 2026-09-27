"""Geographic regression tests for the featured investigations.

Coordinates are GeoJSON order everywhere: [longitude, latitude]. These tests pin
each featured AOI to its real location so a lat/lon swap (or any drift) fails.
"""

import json
from pathlib import Path

import pytest

from app.providers import registry

# Independent reference boxes (lon_min, lat_min, lon_max, lat_max) around each real site.
KNOWN = {
    "rondonia-frontier": (-64.5, -11.0, -62.5, -9.0),   # Rondônia, Brazil
    "hasdeo-arand": (82.3, 22.4, 83.3, 23.3),           # Hasdeo Arand, Chhattisgarh, India
    "similipal": (85.9, 21.4, 86.8, 22.2),              # Similipal, Odisha, India
    "silent-valley": (76.2, 10.9, 76.7, 11.4),          # Silent Valley NP, Kerala, India (~11.1 N, 76.4 E)
}
FRONTEND_COPY = Path(__file__).resolve().parents[2] / "frontend" / "public" / "data" / "featured.json"


def _areas():
    return {a["id"]: a for a in registry.featured()["items"]}


def test_all_featured_present():
    assert set(_areas()) == set(KNOWN)


@pytest.mark.parametrize("area_id", sorted(KNOWN))
def test_center_is_lon_lat_inside_known_box(area_id):
    lon, lat = _areas()[area_id]["center"]
    w, s, e, n = KNOWN[area_id]
    assert w <= lon <= e and s <= lat <= n, f"{area_id} center {[lon, lat]} is not at its real location (lat/lon swapped?)"


@pytest.mark.parametrize("area_id", sorted(KNOWN))
def test_bbox_and_geometry_consistent(area_id):
    a = _areas()[area_id]
    w, s, e, n = a["bbox"]
    assert w < e and s < n, "bbox must be [west, south, east, north]"
    lon, lat = a["center"]
    assert w <= lon <= e and s <= lat <= n, "center must lie inside the bbox"
    ring = a["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1], "polygon ring must be closed"
    assert all(w - 1e-6 <= p[0] <= e + 1e-6 and s - 1e-6 <= p[1] <= n + 1e-6 for p in ring), "geometry must match bbox ([lon, lat] order)"


def test_silent_valley_is_in_kerala_not_the_ocean():
    lon, lat = _areas()["silent-valley"]["center"]
    assert 10.9 <= lat <= 11.4 and 76.2 <= lon <= 76.7


def test_frontend_offline_copy_matches_backend_registry():
    """The UI-preview copy (used only when the backend is down) must be identical."""
    assert json.loads(FRONTEND_COPY.read_text(encoding="utf-8")) == registry.featured()
