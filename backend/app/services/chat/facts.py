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

from .. import analysis, context as area_context, science as sc
from ..units import fmt_share
from .validator import NUMBER, PROPORTION, QUANTIFIER, Fact, _num_value, _unit_of

REFERENCE_FILE = Path(__file__).resolve().parents[2] / "data" / "reference_facts.json"
RESULT = "terratrace_result"
CONTEXT = "reference_context"


def _ha(v: float) -> str:
    return f"{v:,.1f} ha"


class _Builder:
    def __init__(self) -> None:
        self.prompt: list[dict[str, Any]] = []     # what the model sees
        self.index: dict[str, Fact] = {}          # what the validator checks against
        self.public: dict[str, dict[str, Any]] = {}  # what the UI shows as a citation

    def add(self, label: str, display: str | None, *, values: tuple[tuple[float, str | None], ...] = (),
            years: tuple[int, ...] = (), dataset: str, year: str | None, kind: str, direction: str | None = None) -> None:
        fid = f"P{len(self.prompt) + 1}"
        item = {"id": fid, "label": label, "value": display, "dataset": dataset, "year": year,
                "kind": "TerraTrace result" if kind == RESULT else "Reference context, not a TerraTrace result"}
        self.prompt.append(item)
        self.index[fid] = Fact(fid, values, years, direction)
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


def place_facts(aid: str, window: tuple[int, int]) -> tuple[list[dict[str, Any]], dict[str, Fact], dict[str, dict[str, Any]], set[str], str]:
    """(facts for the prompt, validator index, public citations, area names, area display name). Read-only.
    Raises analysis.AnalysisNotFound for an unknown id."""
    aoi = analysis.aoi_doc(aid)
    b = _Builder()
    area = analysis.analysis_target(aoi).get("area_ha") or aoi.get("area_ha")
    b.area("Area analysed (geodesic)", area, dataset="TerraTrace", year=None, kind=RESULT)
    _result_facts(b, aoi, window)
    _context_facts(b, aoi)
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
