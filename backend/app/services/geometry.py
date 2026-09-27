"""AOI validation and geodesic measurement (no GIS dependencies)."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any

from ..config import settings

EARTH_RADIUS_M = 6378137.0


class AoiError(ValueError):
    """Invalid or unsupported AOI. `code` is machine-readable for the UI."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Aoi:
    geometry: dict[str, Any]
    area_m2: float
    bbox: tuple[float, float, float, float]
    centroid: tuple[float, float]

    @property
    def area_km2(self) -> float:
        return self.area_m2 / 1e6

    @property
    def area_ha(self) -> float:
        return self.area_m2 / 1e4

    def fingerprint(self) -> str:
        return hashlib.sha1(json.dumps(self.geometry, sort_keys=True).encode()).hexdigest()[:12]


def _ring_area(ring: list[list[float]]) -> float:
    """Spherical ring area in m² (same formulation as turf.js `ringArea`)."""
    n = len(ring)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        lon1, _ = ring[i]
        _, lat2 = ring[(i + 1) % n]
        lon3, _ = ring[(i + 2) % n]
        total += (math.radians(lon3) - math.radians(lon1)) * math.sin(math.radians(lat2))
    return abs(total * EARTH_RADIUS_M * EARTH_RADIUS_M / 2.0)


def _polygons(geometry: dict[str, Any]) -> list[list[list[list[float]]]]:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon":
        return [coords]
    if gtype == "MultiPolygon":
        return list(coords)
    if gtype == "Feature":
        return _polygons(geometry.get("geometry") or {})
    raise AoiError("unsupported_geometry", "Select an area (rectangle or polygon) — points and lines cannot be analysed.")


def validate_aoi(geometry: dict[str, Any], *, enforce_limits: bool = True) -> Aoi:
    """Validate a GeoJSON polygon AOI and measure it. Raises AoiError with a user-facing message."""
    if not isinstance(geometry, dict):
        raise AoiError("invalid_geometry", "The selected area is not valid GeoJSON.")
    if geometry.get("type") == "Feature":
        geometry = geometry.get("geometry") or {}
    try:
        polys = _polygons(geometry)
    except (TypeError, AttributeError):
        raise AoiError("invalid_geometry", "The selected area is not valid GeoJSON.") from None

    clean: list[list[list[list[float]]]] = []
    lons: list[float] = []
    lats: list[float] = []
    area = 0.0
    for poly in polys:
        if not isinstance(poly, list) or not poly:
            raise AoiError("invalid_geometry", "The polygon has no coordinates.")
        rings: list[list[list[float]]] = []
        for r_i, ring in enumerate(poly):
            pts: list[list[float]] = []
            for p in ring:
                if not isinstance(p, (list, tuple)) or len(p) < 2:
                    raise AoiError("invalid_coordinates", "The polygon contains malformed coordinates.")
                lon, lat = float(p[0]), float(p[1])
                if not (math.isfinite(lon) and math.isfinite(lat)) or not (-180 <= lon <= 180) or not (-85 <= lat <= 85):
                    raise AoiError("invalid_coordinates", "Coordinates must be within longitude −180…180 and latitude −85…85.")
                pts.append([round(lon, 6), round(lat, 6)])
            if pts and pts[0] != pts[-1]:
                pts.append(pts[0])
            if len(pts) < 4:
                raise AoiError("invalid_geometry", "A polygon needs at least three distinct corners.")
            rings.append(pts)
            a = _ring_area(pts[:-1])
            area += a if r_i == 0 else -a
            if r_i == 0:
                lons.extend(q[0] for q in pts)
                lats.extend(q[1] for q in pts)
        clean.append(rings)

    if max(lons) - min(lons) > 180:
        raise AoiError("antimeridian", "Areas crossing the antimeridian are not supported in the prototype.")
    area_km2 = area / 1e6
    if enforce_limits and area_km2 < settings.min_aoi_km2:
        raise AoiError("aoi_too_small", f"The selected area is {area_km2:.2f} km². Please select at least {settings.min_aoi_km2:g} km².")
    if enforce_limits and area_km2 > settings.max_aoi_km2:
        raise AoiError(
            "aoi_too_large",
            f"The selected area is {area_km2:,.0f} km². Please select a smaller area for analysis (up to {settings.max_aoi_km2:,.0f} km²).",
        )

    geom = {"type": "Polygon", "coordinates": clean[0]} if len(clean) == 1 else {"type": "MultiPolygon", "coordinates": clean}
    bbox = (min(lons), min(lats), max(lons), max(lats))
    outer = clean[0][0][:-1]
    centroid = (round(sum(p[0] for p in outer) / len(outer), 5), round(sum(p[1] for p in outer) / len(outer), 5))
    return Aoi(geometry=geom, area_m2=area, bbox=bbox, centroid=centroid)


def bbox_polygon(b: tuple[float, float, float, float]) -> dict[str, Any]:
    w, s, e, n = b
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


def point_in_polygon(x: float, y: float, ring: list[list[float]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def in_aoi(lon: float, lat: float, geometry: dict[str, Any]) -> bool:
    polys = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    for poly in polys:
        if point_in_polygon(lon, lat, poly[0]) and not any(point_in_polygon(lon, lat, h) for h in poly[1:]):
            return True
    return False
