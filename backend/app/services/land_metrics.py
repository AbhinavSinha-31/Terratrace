"""Advisor-requested land metrics, DERIVED from a stored quick scan (services/quickscan.py) — no Earth Engine call.

    advisor_classes   Dynamic World's nine classes grouped into the six LULC classes of the study design
                      (Forest, Cropland, Built-up, Water, Barren, Grass/Shrub) plus the two that fit none of them.
    uhi_vegetated     Surface urban heat island against a VEGETATED rural reference:
                      mean LST of built-up land − mean LST of vegetated land (trees, crops, grass, shrub, flooded veg.),
                      area-weighted. Complements the stored "built − all other land" figure, whose reference includes
                      bare ground (often the hottest surface in a dry season — the "urban cool island" effect).
    compare           Change between two stored scans of the same area and season: per-class area change, built-up
                      expansion, mean LST and UHI change.

Everything is computed when a scan is SERVED from values the scan stored, so scans stored before this module existed
get these figures too and no stored scan is invalidated. A value that cannot be derived is null with a reason.
"""

from __future__ import annotations

from typing import Any

# (key, display name, Dynamic World class keys, colour). Order = the study design's class list.
ADVISOR_GROUPS: list[tuple[str, str, tuple[str, ...], str]] = [
    ("forest", "Forest", ("trees",), "#397d49"),
    ("cropland", "Cropland", ("crops",), "#e49635"),
    ("built", "Built-up", ("built",), "#c4281b"),
    ("water", "Water", ("water",), "#419bdf"),
    ("barren", "Barren", ("bare",), "#a59b8f"),
    ("grass_shrub", "Grass / Shrub", ("grass", "shrub_and_scrub"), "#88b053"),
    ("wetland", "Flooded vegetation", ("flooded_vegetation",), "#7a87c6"),
    ("snow_ice", "Snow and ice", ("snow_and_ice",), "#b39fe1"),
]
VEGETATED = ("trees", "crops", "grass", "shrub_and_scrub", "flooded_vegetation")
BUILT = "built"
# Same minimum sizes as the stored built − other-land UHI (services/quickscan.py UHI_MIN_*), so both figures appear together.
UHI_MIN_SHARE = 0.05
UHI_MIN_KM2 = 2.0


def _r(v: float | None, n: int) -> float | None:
    return None if v is None else round(v, n)


def advisor_classes(landcover: dict[str, Any] | None) -> list[dict[str, Any]] | None:
    """Area and share of each study-design class (from the scan's Dynamic World classes), or None when not READY."""
    if not landcover or landcover.get("status") != "READY":
        return None
    by_key = {c["key"]: c for c in landcover.get("classes") or []}
    total = sum(float(c.get("area_km2") or 0.0) for c in by_key.values())
    out = []
    for key, name, members, color in ADVISOR_GROUPS:
        area = sum(float((by_key.get(m) or {}).get("area_km2") or 0.0) for m in members)
        out.append({"key": key, "name": name, "color": color, "dynamic_world": list(members),
                    "area_km2": _r(area, 3), "share": _r(area / total, 4) if total > 0 else None})
    return out


def uhi_vegetated(lst: dict[str, Any] | None, landcover: dict[str, Any] | None) -> dict[str, Any] | None:
    """Built-up mean LST − vegetated mean LST (area-weighted by the area with a valid temperature in each class)."""
    if not lst or lst.get("status") != "READY":
        return None
    label = "Surface UHI against vegetated land (built − vegetated, water and bare ground excluded)"
    per = {c["key"]: c for c in lst.get("per_class") or []}
    built = per.get(BUILT)
    veg = [per[k] for k in VEGETATED if k in per and per[k].get("mean_c") is not None and (per[k].get("area_km2") or 0) > 0]
    veg_km2 = sum(float(c["area_km2"]) for c in veg)
    land_km2 = sum(float(c.get("area_km2") or 0.0) for c in (landcover or {}).get("classes") or [] if c.get("key") != "water")
    built_land_km2 = next((float(c.get("area_km2") or 0.0) for c in (landcover or {}).get("classes") or [] if c.get("key") == BUILT), 0.0)
    share = built_land_km2 / land_km2 if land_km2 else 0.0
    base = {"label": label, "reference": "vegetated", "reference_classes": list(VEGETATED)}
    if share < UHI_MIN_SHARE or built_land_km2 < UHI_MIN_KM2 or veg_km2 < UHI_MIN_KM2:
        return {**base, "status": "UNAVAILABLE", "built_km2": _r(built_land_km2, 3), "vegetated_km2": _r(veg_km2, 3),
                "reason": f"Needs built-up land of at least {UHI_MIN_SHARE:.0%} of the land and {UHI_MIN_KM2:g} km², and at least "
                          f"{UHI_MIN_KM2:g} km² of vegetated land with a valid temperature."}
    if not built or built.get("mean_c") is None or not built.get("area_km2"):
        return {**base, "status": "UNAVAILABLE", "reason": "Built-up land has no valid surface temperature in this scan."}
    v = sum(float(c["mean_c"]) * float(c["area_km2"]) for c in veg) / veg_km2
    b = float(built["mean_c"])
    return {**base, "status": "READY", "value_c": _r(b - v, 2), "built_mean_c": _r(b, 2), "vegetated_mean_c": _r(v, 2),
            "built_km2": _r(float(built["area_km2"]), 3), "vegetated_km2": _r(veg_km2, 3),
            "note": "Derived from the scan's per-class means (rounded to 0.01 °C), so it may differ from a direct computation by ~0.01 °C."}


def _delta(a: float | None, b: float | None, n: int) -> float | None:
    return None if a is None or b is None else _r(b - a, n)


def compare(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """Change from stored scan `a` (earlier) to stored scan `b` (later). Both must be presented scans of one area."""
    if a.get("aoi_id") != b.get("aoi_id") or a.get("season") != b.get("season"):
        raise ValueError("compare needs two scans of the same area and season")
    if a["year"] >= b["year"]:
        raise ValueError("the first scan must be the earlier year")
    out: dict[str, Any] = {"aoi_id": a["aoi_id"], "season": a["season"], "from_year": a["year"], "to_year": b["year"]}

    ca, cb = advisor_classes(a.get("landcover")), advisor_classes(b.get("landcover"))
    if ca and cb:
        rows = []
        for x, y in zip(ca, cb):
            rows.append({"key": x["key"], "name": x["name"], "color": x["color"],
                         "from_km2": x["area_km2"], "to_km2": y["area_km2"], "change_km2": _delta(x["area_km2"], y["area_km2"], 3),
                         "from_share": x["share"], "to_share": y["share"],
                         "change_pp": _r((y["share"] - x["share"]) * 100, 2) if x["share"] is not None and y["share"] is not None else None,
                         "change_pct": _r((y["area_km2"] - x["area_km2"]) / x["area_km2"] * 100, 1) if x["area_km2"] else None})
        built = next(r for r in rows if r["key"] == "built")
        out["landcover"] = {"status": "READY", "classes": rows, "built_expansion_km2": built["change_km2"],
                            "built_expansion_pct": built["change_pct"],
                            "note": "Net change in mapped area per class between two independent annual Dynamic World "
                                    "classifications; it is not a pixel-by-pixel transition matrix."}
    else:
        out["landcover"] = {"status": "UNAVAILABLE", "reason": "Land cover is not READY in both scans."}

    la, lb = a.get("lst") or {}, b.get("lst") or {}
    if la.get("status") == "READY" and lb.get("status") == "READY":
        ua, ub = la.get("uhi") or {}, lb.get("uhi") or {}
        va, vb = uhi_vegetated(la, a.get("landcover")) or {}, uhi_vegetated(lb, b.get("landcover")) or {}
        out["lst"] = {
            "status": "READY", "mean_change_c": _delta(la.get("mean_c"), lb.get("mean_c"), 2),
            "from_mean_c": la.get("mean_c"), "to_mean_c": lb.get("mean_c"),
            "uhi_change_c": _delta(ua.get("value_c"), ub.get("value_c"), 2) if ua.get("status") == "READY" and ub.get("status") == "READY" else None,
            "uhi_vegetated_change_c": _delta(va.get("value_c"), vb.get("value_c"), 2) if va.get("status") == "READY" and vb.get("status") == "READY" else None,
            "note": "Single-year composites: weather differs between years, so a change in mean LST is not a trend on its own. "
                    "The UHI difference (built − reference within the same scenes) is less sensitive to the weather of the year.",
        }
    else:
        out["lst"] = {"status": "UNAVAILABLE", "reason": "Surface temperature is not READY in both scans."}
    return out
