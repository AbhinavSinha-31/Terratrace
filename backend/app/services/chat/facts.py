"""Citable facts for the AI chat: the selected area's own TerraTrace data, and the curated reference library.

Place facts come only from what TerraTrace already stored for that area and window (a READY result, its cautions,
the cached reference context) — read-only, nothing is computed or estimated here. A withheld or unavailable result
contributes its status only, never a number. Reference facts are the method and dataset facts in
app/data/reference_facts.json (each with its source).
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from .. import analysis, carbon_series, context as area_context, land_metrics, quickscan, science as sc
from ..units import fmt_share
from .validator import NUMBER, PROPORTION, QUANTIFIER, Fact, _num_value, _unit_of

REFERENCE_FILE = Path(__file__).resolve().parents[2] / "data" / "reference_facts.json"
RESULT = "terratrace_result"
CONTEXT = "reference_context"
QUICK = "quick_scan"
KIND_TEXT = {RESULT: "TerraTrace result", CONTEXT: "Reference context, not a TerraTrace result",
             QUICK: "Quick scan from public datasets — not validated for this area, not a TerraTrace classification"}
MAX_QUICK_SCANS = 3        # most recent stored scans of an area offered to the chat


def _ha(v: float) -> str:
    return f"{v:,.1f} ha"


class _Builder:
    def __init__(self) -> None:
        self.prompt: list[dict[str, Any]] = []     # what the model sees
        self.index: dict[str, Fact] = {}          # what the validator checks against
        self.public: dict[str, dict[str, Any]] = {}  # what the UI shows as a citation

    def add(self, label: str, display: str | None, *, values: tuple[tuple[float, str | None], ...] = (),
            years: tuple[int, ...] = (), dataset: str, year: str | None, kind: str, direction: str | None = None,
            tags: tuple[str, ...] = ()) -> None:
        fid = f"P{len(self.prompt) + 1}"
        item = {"id": fid, "label": label, "value": display, "dataset": dataset, "year": year, "kind": KIND_TEXT[kind]}
        self.prompt.append(item)
        self.index[fid] = Fact(fid, values, years, direction, (), tags + ((QUICK,) if kind == QUICK else ()))
        self.public[fid] = {"id": fid, "label": label, "value": display, "dataset": dataset, "year": year, "kind": kind,
                            "source": None}

    def area(self, label: str, ha: float | None, **kw: Any) -> None:
        """An area fact: hectares, also citable in km²."""
        if ha is None:
            return
        self.add(label, _ha(ha), values=((ha, "ha"), (ha / 100, "km2")), **kw)

    def share(self, label: str, pct: float | None, **kw: Any) -> None:
        if pct is None:
            return
        self.add(label, fmt_share(pct), values=((pct, "%"),), **kw)


def _result_facts(b: _Builder, aoi: dict[str, Any], win: tuple[int, int]) -> None:
    env = analysis.stored_envelope(aoi["id"], *win)
    if env is None:
        b.add(f"No TerraTrace analysis has been run for {win[0]}–{win[1]} in this area", None, years=win,
              dataset="TerraTrace", year=f"{win[0]}–{win[1]}", kind=RESULT)
        return
    status = env.get("analysisStatus")
    if status != "READY" or not env.get("summary"):
        msg = (env.get("error") or {}).get("user_message") or "no result"
        b.add(f"TerraTrace analysis {win[0]}–{win[1]}: {status} — {msg} (no measurements)", None, years=win,
              dataset="TerraTrace", year=f"{win[0]}–{win[1]}", kind=RESULT)
        return
    s = env["summary"]
    k = s.get("kpis") or {}
    kb, kc = k.get("baseline_year"), k.get("latest_year")
    ds = "TerraTrace forest mask (Sentinel-2 + Dynamic World)"
    span = f"{kb}–{kc}"
    b.add(f"TerraTrace analysis window (years with sufficient clear observations): {span}", span, years=(kb, kc),
          dataset="TerraTrace", year=span, kind=RESULT)
    for row in s.get("years") or []:
        y = row.get("year")
        if row.get("era") != "modern" or not row.get("passes_quality") or not (kb <= y <= kc):
            continue
        b.area(f"TerraTrace forest area, {y}", row.get("forest_ha"), years=(y,), dataset=ds, year=str(y), kind=RESULT)
        b.share(f"TerraTrace forest share of the observed area, {y}", row.get("forest_pct"), years=(y,), dataset=ds,
                year=str(y), kind=RESULT)
        b.share(f"Share of the area observed (enough clear views), {y}", row.get("coverage_pct"), years=(y,), dataset=ds,
                year=str(y), kind=RESULT)
    yrs = (kb, kc)
    b.area(f"Gross forest-loss transitions {span} (sum of year-to-year loss; not permanent deforestation)",
           k.get("gross_loss_ha"), years=yrs, dataset=ds, year=span, kind=RESULT, direction="loss")
    b.area(f"Gross forest-gain transitions {span} (may be classification flicker or crops, not new forest)",
           k.get("gross_gain_ha"), years=yrs, dataset=ds, year=span, kind=RESULT, direction="gain")
    if k.get("net_change_ha") is not None:
        v = k["net_change_ha"]
        b.add(f"Net forest change {span}, over the area observed in both years", f"{v:+,.1f} ha",
              values=((v, "ha"), (v / 100, "km2")), years=yrs, dataset=ds, year=span, kind=RESULT, direction="signed")
    if k.get("net_change_pct") is not None:
        v = k["net_change_pct"]
        b.add(f"Net forest change {span}, % of the {kb} forest", f"{v:+.2f} %", values=((v, "%"),), years=yrs,
              dataset=ds, year=span, kind=RESULT, direction="signed")
    b.area(f"Area observed in both {kb} and {kc} (where change was measured)", k.get("compared_ha"), years=yrs,
           dataset=ds, year=span, kind=RESULT)
    feats = (env.get("events") or {}).get("features") or []
    b.add(f"Change events detected {span} (each at least {sc.MMU_HA:g} ha)", str(len(feats)),
          values=((float(len(feats)), None), (sc.MMU_HA, "ha")), years=yrs, dataset=ds, year=span, kind=RESULT)
    if feats:
        b.area(f"Total area of the change events {span}", round(sum(f["properties"]["area_ha"] for f in feats), 1),
               years=yrs, dataset=ds, year=span, kind=RESULT, direction="loss")
        hi = k.get("high_severity_count")
        if hi is not None:
            b.add(f"High or critical severity events {span}", str(hi), values=((float(hi), None),), years=yrs,
                  dataset=ds, year=span, kind=RESULT)
    for c in env.get("cautions") or []:
        # A caution is TerraTrace's own text: its figures are citable with it (number + unit as written there).
        vals = []
        for m in NUMBER.finditer(c["message"]):
            nv = _num_value(m.group(0))
            if nv is not None:
                vals.append((nv[0], _unit_of(c["message"], m.end())))
        cy = tuple(int(v) for v, u in vals if u is None and v == int(v) and 1800 <= v <= 2100)
        b.add(f"TerraTrace {c.get('kind', 'caution')} ({c['code']}): {c['message']}", None, values=tuple(vals),
              years=yrs + cy, dataset=", ".join(c.get("datasets") or []) or "TerraTrace", year=span, kind=RESULT)
    b.add(s.get("historical_statement") or sc.PROXY_STATEMENT, None, years=(1984, 2015, 2016),
          dataset="TerraTrace", year="1984–2015", kind=RESULT)


def _context_facts(b: _Builder, aoi: dict[str, Any]) -> None:
    ctx = area_context.cached(aoi["id"])
    if not ctx or ctx.get("status") != "READY":
        return

    def src(part: dict[str, Any]) -> tuple[str, str]:
        s = part.get("source") or {}
        return s.get("dataset") or "reference dataset", s.get("year_label") or s.get("year") or ""

    t = ctx.get("terrain") or {}
    if t.get("status") == "READY":
        ds, yl = src(t)
        e = t.get("elevation_m") or {}
        for key, label in (("min", "minimum"), ("mean", "mean"), ("max", "maximum")):
            if e.get(key) is not None:
                b.add(f"Elevation, {label} (surface model: includes the canopy over forest)", f"{e[key]:,.0f} m",
                      values=((e[key], "m"),), dataset=ds, year=yl, kind=CONTEXT)
        if t.get("slope_mean_deg") is not None:
            b.add("Mean slope", f"{t['slope_mean_deg']:.1f}°", values=((t["slope_mean_deg"], "deg"),), dataset=ds, year=yl,
                  kind=CONTEXT)
        if t.get("steep_share_pct") is not None:
            th = t.get("steep_threshold_deg") or 30
            b.add(f"Share of the area steeper than {th}°", fmt_share(t["steep_share_pct"]),
                  values=((t["steep_share_pct"], "%"), (th, "deg")), dataset=ds, year=yl, kind=CONTEXT)
    f = ctx.get("forest") or {}
    tc = f.get("tree_cover_2000") or {}
    if tc.get("status") == "READY":
        ds, yl = src(tc)
        th = tc.get("canopy_threshold_pct") or 30
        b.share(f"Hansen tree cover (canopy ≥ {th} %) in 2000, share of land", tc.get("share_of_land_pct"),
                years=(2000,), dataset=ds, year=yl, kind=CONTEXT)
        b.area(f"Hansen tree cover (canopy ≥ {th} %) in 2000, area", tc.get("area_ha"), years=(2000,), dataset=ds,
               year=yl, kind=CONTEXT)
    lo = f.get("loss_by_year") or {}
    if lo.get("status") == "READY":
        ds, yl = src(lo)
        b.area("Hansen tree-cover loss 2001–2025, total (stand-replacing canopy removal, not necessarily deforestation)",
               lo.get("total_ha"), years=(2001, 2025), dataset=ds, year=yl, kind=CONTEXT, direction="loss")
        b.share("Hansen tree-cover loss 2001–2025, share of the 2000 tree cover", lo.get("share_of_2000_tree_cover_pct"),
                years=(2000, 2001, 2025), dataset=ds, year=yl, kind=CONTEXT)
    g = f.get("gain_2000_2012") or {}
    if g.get("status") == "READY":
        ds, yl = src(g)
        b.area("Hansen tree-cover gain 2000–2012 (not updated after 2012)", g.get("area_ha"), years=(2000, 2012),
               dataset=ds, year=yl, kind=CONTEXT, direction="gain")
    wc = f.get("worldcover_2021") or {}
    if wc.get("status") == "READY":
        ds, yl = src(wc)
        b.share("ESA WorldCover tree cover in 2021, share of land", wc.get("share_of_land_pct"), years=(2021,), dataset=ds,
                year=yl, kind=CONTEXT)
        b.area("ESA WorldCover tree cover in 2021, area", wc.get("area_ha"), years=(2021,), dataset=ds, year=yl, kind=CONTEXT)
    lc = ctx.get("land_cover_2021") or {}
    if lc.get("status") == "READY":
        ds, yl = src(lc)
        for c in lc.get("classes") or []:
            b.add(f"ESA WorldCover 2021 land cover: {c['name']}", f"{fmt_share(c['share_pct'])} ({_ha(c['area_ha'])})",
                  values=((c["share_pct"], "%"), (c["area_ha"], "ha"), (c["area_ha"] / 100, "km2")), years=(2021,),
                  dataset=ds, year=yl, kind=CONTEXT)
    surface = ctx.get("surface") or {}
    if surface.get("message"):
        b.add(f"Surface: {surface['message']}", None, dataset="ESA WorldCover v200 / Copernicus DEM", year="2021",
              kind=CONTEXT)


def _km2(v: float) -> str:
    return f"{v:,.1f} km²" if v >= 10 else f"{v:,.2f} km²"


def _quickscan_facts(b: _Builder, aoi: dict[str, Any]) -> None:
    """The area's stored quick scans (most recent first). Each value carries its dataset and year; the tags keep them
    from being presented as forest cover, total carbon or a TerraTrace classification (validator.quick_scan_misuse)."""
    try:
        version = quickscan.version()
    except Exception:  # noqa: BLE001 — quick scan unavailable on this server: no facts, nothing else changes
        return
    files = sorted(quickscan.CACHE.glob(f"{aoi['id']}-[0-9][0-9][0-9][0-9]-*-{version}.json"),
                   key=lambda p: p.stat().st_mtime, reverse=True)[:MAX_QUICK_SCANS] if quickscan.CACHE.exists() else []
    for f in files:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        y, season = d.get("year"), d.get("season_label") or "all months"
        if not isinstance(y, int) or d.get("quickscan_version") != version:
            continue
        b.add(f"Quick scan {y} ({season}): land cover from Dynamic World, surface temperature from Landsat, carbon from ESA CCI. "
              "Public datasets, not validated for this area; Dynamic World 'Trees' is a land-cover class, not TerraTrace's forest measure.",
              None, years=(y,), dataset="Dynamic World V1, Landsat 8/9 Collection 2, ESA CCI Biomass v6.0", year=str(y), kind=QUICK)
        lc = d.get("landcover") or {}
        if lc.get("status") == "READY":
            ds = lc["source"]["dataset"]
            for c in lc.get("classes") or []:
                if not c.get("area_km2"):
                    continue
                a, sh = c["area_km2"], c["share"] * 100
                note = " (a land-cover class, not forest cover)" if c["key"] == "trees" else ""
                b.add(f"Dynamic World {y} land cover: {c['name']}{note}", f"{_km2(a)} ({sh:.1f} %)",
                      values=((a, "km2"), (a * 100, "ha"), (sh, "%")), years=(y,), dataset=ds, year=str(y), kind=QUICK,
                      tags=("dw_trees",) if c["key"] == "trees" else ())
            if lc.get("low_confidence_share") is not None:
                v = lc["low_confidence_share"] * 100
                b.add(f"Dynamic World {y}: share of the area with low confidence (top probability below 0.5)", f"{v:.1f} %",
                      values=((v, "%"), (0.5, None)), years=(y,), dataset=ds, year=str(y), kind=QUICK)
            for c in land_metrics.advisor_classes(lc) or []:
                if len(c["dynamic_world"]) < 2 or not c["area_km2"]:
                    continue   # single-class groups are the Dynamic World facts above; only merged classes are new numbers
                a, sh = c["area_km2"], (c["share"] or 0) * 100
                b.add(f"{y} land cover, study-design class '{c['name']}' (Dynamic World {' + '.join(c['dynamic_world'])})",
                      f"{_km2(a)} ({sh:.1f} %)", values=((a, "km2"), (a * 100, "ha"), (sh, "%")), years=(y,), dataset=ds,
                      year=str(y), kind=QUICK)
            wc = lc.get("worldcover_agreement")
            if wc:
                v = wc["share"] * 100
                b.add(f"Dynamic World {y} agrees with ESA WorldCover 2021 on this share of the area (a cross-check, not accuracy)",
                      f"{v:.1f} %", values=((v, "%"),), years=(y, 2021), dataset=f"{ds}; ESA WorldCover v200", year=str(y), kind=QUICK)
        else:
            b.add(f"Quick scan {y}: land cover unavailable — {lc.get('reason') or 'no Dynamic World data'}", None, years=(y,),
                  dataset="Dynamic World V1", year=str(y), kind=QUICK)
        lst = d.get("lst") or {}
        if lst.get("status") == "READY":
            ds = lst["source"]["dataset"]
            n = lst["source"].get("scenes")
            when = f"{season} {y}"
            for key, label in (("mean_c", "mean of land"), ("p2_c", "2nd percentile"), ("p98_c", "98th percentile")):
                if lst.get(key) is not None:
                    b.add(f"Land surface temperature, {when}, {label} ({n} Landsat scenes, ~10:30 local overpass)",
                          f"{lst[key]:.1f} °C", values=((lst[key], "C"), (float(n or 0), None)), years=(y,), dataset=ds,
                          year=when, kind=QUICK)
            for c in lst.get("per_class") or []:
                if c.get("water"):
                    continue
                b.add(f"Land surface temperature, {when}, mean over Dynamic World '{c['name']}'", f"{c['mean_c']:.1f} °C",
                      values=((c["mean_c"], "C"),), years=(y,), dataset=f"{ds}; Dynamic World V1", year=when, kind=QUICK)
            u = lst.get("uhi") or {}
            if u.get("status") == "READY":
                b.add(f"{u['label']}, {when}: built-up land minus other land (positive = built-up land is warmer)",
                      f"{u['value_c']:+.1f} °C", values=((u["value_c"], "C"),), years=(y,), dataset=f"{ds}; Dynamic World V1",
                      year=when, kind=QUICK, direction="warmth")
                b.add(f"Mean surface temperature of built-up land / other land, {when}", f"{u['built_mean_c']:.1f} °C / {u['other_mean_c']:.1f} °C",
                      values=((u["built_mean_c"], "C"), (u["other_mean_c"], "C")), years=(y,), dataset=ds, year=when, kind=QUICK)
            elif u.get("reason"):
                b.add(f"No surface heat-island figure for {when}: {u['reason']}", None, years=(y,), dataset=ds, year=when, kind=QUICK)
            v = land_metrics.uhi_vegetated(lst, lc) or {}
            if v.get("status") == "READY":
                b.add(f"Surface UHI against vegetated land, {when}: built-up minus vegetated land, water and bare ground excluded "
                      "(positive = built-up land is warmer)", f"{v['value_c']:+.1f} °C", values=((v["value_c"], "C"),), years=(y,),
                      dataset=f"{ds}; Dynamic World V1", year=when, kind=QUICK, direction="warmth")
                b.add(f"Mean surface temperature of built-up / vegetated land, {when}", f"{v['built_mean_c']:.1f} °C / {v['vegetated_mean_c']:.1f} °C",
                      values=((v["built_mean_c"], "C"), (v["vegetated_mean_c"], "C")), years=(y,), dataset=ds, year=when, kind=QUICK)
        elif lst:
            b.add(f"Land surface temperature, {season} {y}: unavailable — {lst.get('reason') or 'not measured'}", None,
                  years=(y,), dataset="Landsat 8/9 Collection 2", year=str(y), kind=QUICK)
        for comp in (d.get("carbon") or {}).get("components") or []:
            src = comp.get("source") or {}
            cy = src.get("year")
            if comp.get("status") != "READY":
                b.add(f"Above-ground tree biomass carbon: unavailable — {comp.get('reason') or 'not measured'}", None,
                      years=(cy,) if cy else (), dataset=src.get("dataset") or "ESA CCI", year=str(cy or ""), kind=QUICK)
                continue
            scope = "above-ground tree biomass carbon only (roots, dead wood, litter and soil not included)"
            tot, lo, hi = comp["total_t"], comp["range_t"][0], comp["range_t"][1]

            def scaled(v: float) -> tuple[tuple[float, str], ...]:
                return ((v, "tC"), (v / 1e3, "ktC"), (v / 1e6, "MtC"))
            b.add(f"Carbon density, {scope}, ESA CCI {cy} × {comp['carbon_fraction']}", f"{comp['density_t_per_ha']:.1f} t C/ha",
                  values=((comp["density_t_per_ha"], "tC/ha"), (comp["carbon_fraction"], None)), years=(cy,),
                  dataset=src["dataset"], year=str(cy), kind=QUICK, tags=("biomass_carbon",))
            b.add(f"Carbon in the area, {scope}, ESA CCI {cy}, with its range", f"{tot:,.0f} t C (range {lo:,.0f}–{hi:,.0f} t C)",
                  values=scaled(tot) + scaled(lo) + scaled(hi), years=(cy,), dataset=src["dataset"], year=str(cy), kind=QUICK,
                  tags=("biomass_carbon",))
            if comp.get("coverage_share") is not None:
                v = comp["coverage_share"] * 100
                b.add(f"Share of the area with ESA CCI biomass values ({cy})", f"{v:.0f} %", values=((v, "%"),), years=(cy,),
                      dataset=src["dataset"], year=str(cy), kind=QUICK)


def _carbon_series_facts(b: _Builder, aoi: dict[str, Any]) -> None:
    """The area's stored carbon series (ESA CCI epochs), when one was measured. Estimates, tagged like quick-scan carbon."""
    doc = carbon_series.stored(aoi["id"])
    if not doc or doc.get("status") != "READY":
        return
    ds = doc["source"]["dataset"]

    def scaled(v: float) -> tuple[tuple[float, str], ...]:
        return ((v, "tC"), (v / 1e3, "ktC"), (v / 1e6, "MtC"))
    for s in doc.get("series") or []:
        if s.get("status") != "READY":
            continue
        lo, hi = s["range_t"]
        b.add(f"Estimated above-ground tree carbon, ESA CCI {s['year']} × {doc['carbon_fraction']} (estimate, with range)",
              f"{s['total_t']:,.0f} t C (range {lo:,.0f}–{hi:,.0f})", values=scaled(s["total_t"]) + scaled(lo) + scaled(hi),
              years=(s["year"],), dataset=ds, year=str(s["year"]), kind=QUICK, tags=("biomass_carbon",))
    ch = doc.get("change")
    if ch:
        note = "; the two years' ranges overlap, so this is within map uncertainty" if ch["ranges_overlap"] else ""
        b.add(f"Change in estimated above-ground tree carbon, {ch['from_year']}→{ch['to_year']} (ESA CCI){note}",
              f"{ch['change_t']:+,.0f} t C" + (f" ({ch['change_pct']:+.1f} %)" if ch.get("change_pct") is not None else ""),
              values=scaled(ch["change_t"]) + scaled(abs(ch["change_t"])) + (((ch["change_pct"], "%"),) if ch.get("change_pct") is not None else ()),
              years=(ch["from_year"], ch["to_year"]), dataset=ds, year=f"{ch['from_year']}–{ch['to_year']}", kind=QUICK, tags=("biomass_carbon",))


def place_facts(aid: str, window: tuple[int, int]) -> tuple[list[dict[str, Any]], dict[str, Fact], dict[str, dict[str, Any]], set[str], str]:
    """(facts for the prompt, validator index, public citations, area names, area display name). Read-only.
    Raises analysis.AnalysisNotFound for an unknown id."""
    aoi = analysis.aoi_doc(aid)
    b = _Builder()
    area = analysis.analysis_target(aoi).get("area_ha") or aoi.get("area_ha")
    b.area("Area analysed (geodesic)", area, dataset="TerraTrace", year=None, kind=RESULT)
    _result_facts(b, aoi, window)
    _context_facts(b, aoi)
    _quickscan_facts(b, aoi)
    _carbon_series_facts(b, aoi)
    names = {n for n in (aoi.get("name"), aoi.get("short_name"), aoi.get("region"), aoi.get("country")) if n}
    return b.prompt, b.index, b.public, names, aoi.get("name") or "the selected area"


@lru_cache(maxsize=1)
def reference_facts() -> tuple[list[dict[str, Any]], dict[str, Fact], dict[str, dict[str, Any]]]:
    doc = json.loads(REFERENCE_FILE.read_text(encoding="utf-8"))
    prompt, index, public = [], {}, {}
    for f in doc["facts"]:
        phrases = tuple(sorted({re.sub(r"\s+", " ", m.group(0).lower()) for rx in (PROPORTION, QUANTIFIER)
                                for m in rx.finditer(f["text"])}))
        index[f["id"]] = Fact(f["id"], tuple((float(v["v"]), v["unit"]) for v in f["values"]), tuple(f["years"]),
                              None, phrases)
        prompt.append({"id": f["id"], "fact": f["text"], "source": f["source"]})
        public[f["id"]] = {"id": f["id"], "label": f["text"], "value": None, "dataset": None, "year": None,
                           "kind": f["kind"], "source": f["source"]}
    return prompt, index, public
