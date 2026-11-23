"""PDF report and data download for the website's case study — offline, from the case study's exported files only.

    .venv\\Scripts\\python export_report.py

No Earth Engine. Every number comes from frontend/public/case-studies/<id>/case-study.json — the file the website page
reads, written by export_case_study.py from outputs/tables — so the PDF, the page and outputs/results_summary.md cannot
disagree. Before writing anything it checks that the JSON is newer than every table and that its findings and
limitations appear verbatim in results_summary.md. Maps and charts are the full-resolution figures in outputs/maps and
outputs/charts (the website shows web-sized copies of the same files).

Writes, next to the case study's other static files:
  <report.pdf_file>     A4 report, light and print-friendly
  <report.data_file>    the CSV tables, a README.md explaining every column and its unit, and results_summary.md
  downloads.json        file names, sizes and page count, for the page's download card
Author line, title and status line come from config.toml [report]; the TerraTrace version from frontend/package.json.

When case-study.json has "lst_enabled": false (config.toml [lst] enabled = false, since 1.0.2) the PDF has no surface-heat,
UHI or temperature-correlation pages, no temperature masking, no November–February composites and no heat-island
references, and the ZIP leaves out the LST tables (LST_TABLES); they stay in analysis/outputs/tables.
"""

from __future__ import annotations

import io
import json
import re
import sys
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

import matplotlib
import pandas as pd
from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (CondPageBreak, Flowable, Image, KeepTogether, ListFlowable, ListItem, PageBreak,
                                Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle)

sys.path.insert(0, str(Path(__file__).resolve().parent))

from terratrace_analysis import __version__, config as config_mod  # noqa: E402

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "outputs"
CASE_ID = "noida-ghaziabad"
DEST = ROOT.parent / "frontend" / "public" / "case-studies" / CASE_ID
PACKAGE_JSON = ROOT.parent / "frontend" / "package.json"

# ----------------------------------------------------------------------------- look
INK, INK_2, INK_3 = colors.HexColor("#1b1f23"), colors.HexColor("#4a525a"), colors.HexColor("#7a838c")
LINE, PANEL = colors.HexColor("#d9dee2"), colors.HexColor("#f2f4f6")
ACCENT, WARN, WARN_BG = colors.HexColor("#0f7d74"), colors.HexColor("#8a5a00"), colors.HexColor("#fff4dc")
PAGE_W, PAGE_H = A4
MARGIN_X, MARGIN_TOP, MARGIN_BOTTOM = 18 * mm, 20 * mm, 18 * mm
TEXT_W = PAGE_W - 2 * MARGIN_X
SEASON = {"summer": "April–June (primary)", "winter": "November–February (secondary)"}
# Tables of the land surface temperature / UHI analysis: left out of the ZIP while it is switched off.
LST_TABLES = {"lst_summary.csv", "lst_per_class.csv", "uhi_intensity.csv", "conversion_lst_change.csv", "lst_correlations.csv",
              "lst_mask_impact.csv"}
SEASON_SHORT = {"summer": "Apr–Jun", "winter": "Nov–Feb"}
SEASON_ROLE = {"summer": "Apr–Jun (primary)", "winter": "Nov–Feb (secondary)"}


def fonts() -> None:
    """DejaVu Sans (the charts' font, shipped with matplotlib): it has −, →, ≥, Δ, κ, ², ° — the base-14 fonts do not."""
    d = Path(matplotlib.__file__).parent / "mpl-data" / "fonts" / "ttf"
    for name, file in (("DV", "DejaVuSans.ttf"), ("DV-B", "DejaVuSans-Bold.ttf"), ("DV-I", "DejaVuSans-Oblique.ttf"),
                       ("DV-BI", "DejaVuSans-BoldOblique.ttf")):
        pdfmetrics.registerFont(TTFont(name, str(d / file)))
    pdfmetrics.registerFontFamily("DV", normal="DV", bold="DV-B", italic="DV-I", boldItalic="DV-BI")


def styles() -> dict[str, ParagraphStyle]:
    base = ParagraphStyle("body", fontName="DV", fontSize=9.2, leading=13.2, textColor=INK, alignment=TA_LEFT)
    return {
        "body": base,
        "small": ParagraphStyle("small", parent=base, fontSize=7.8, leading=10.6, textColor=INK_2),
        "caption": ParagraphStyle("caption", parent=base, fontSize=7.6, leading=10.2, textColor=INK_3, spaceBefore=2),
        "cell": ParagraphStyle("cell", parent=base, fontSize=8.2, leading=10.6),
        "cell_r": ParagraphStyle("cell_r", parent=base, fontSize=8.2, leading=10.6, alignment=2),
        "head": ParagraphStyle("head", parent=base, fontName="DV-B", fontSize=7.8, leading=10, textColor=INK_2),
        "head_r": ParagraphStyle("head_r", parent=base, fontName="DV-B", fontSize=7.8, leading=10, textColor=INK_2, alignment=2),
        "h1": ParagraphStyle("h1", parent=base, fontName="DV-B", fontSize=15, leading=19, spaceAfter=6),
        "h2": ParagraphStyle("h2", parent=base, fontName="DV-B", fontSize=10.5, leading=14, spaceBefore=8, spaceAfter=4),
        "kicker": ParagraphStyle("kicker", parent=base, fontName="DV-B", fontSize=8, leading=11, textColor=ACCENT),
        "title": ParagraphStyle("title", parent=base, fontName="DV-B", fontSize=24, leading=30, spaceAfter=8),
        "subtitle": ParagraphStyle("subtitle", parent=base, fontSize=12, leading=16, textColor=INK_2),
        "value": ParagraphStyle("value", parent=base, fontName="DV-B", fontSize=19, leading=22),
        "period": ParagraphStyle("period", parent=base, fontName="DV-B", fontSize=7.4, leading=9, textColor=INK_3, alignment=2),
        "card_title": ParagraphStyle("card_title", parent=base, fontName="DV-B", fontSize=10, leading=13),
        "ref": ParagraphStyle("ref", parent=base, fontSize=7.6, leading=10, leftIndent=10, firstLineIndent=-10, spaceAfter=2),
    }


# ----------------------------------------------------------------------------- numbers (the summary's formats)
def km2(v: float) -> str:
    return f"{v:,.1f}"


def signed(v: float, d: int = 1) -> str:
    return f"{v:+,.{d}f}"


def degc(v: float) -> str:
    return f"{v:.1f}\u00a0°C"


def x(s: str) -> str:
    """Data text → Paragraph markup."""
    return escape(str(s))


# ----------------------------------------------------------------------------- building blocks
def jpeg(path: Path, width_px: int) -> io.BytesIO:
    """A print-sized JPEG copy of a pipeline figure (keeps the PDF small enough to e-mail)."""
    im = PILImage.open(path).convert("RGB")
    if im.width > width_px:
        im = im.resize((width_px, round(im.height * width_px / im.width)), PILImage.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85, optimize=True, progressive=True)
    buf.seek(0)
    return buf


def figure(path: Path, width: float, *, max_height: float | None = None) -> Image:
    with PILImage.open(path) as im:
        w, h = im.size
    height = width * h / w
    if max_height and height > max_height:
        width, height = max_height * w / h, max_height
    return Image(jpeg(path, round(width / 72 * 300)), width=width, height=height)   # 300 dpi at the printed width


def side_by_side(items: list[tuple[Flowable, str]], S, gap: float = 6 * mm) -> Table:
    """Figures next to each other, each with its caption below."""
    col = (TEXT_W - gap * (len(items) - 1)) / len(items)
    cells = [[f, Paragraph(cap, S["caption"])] for f, cap in items]
    widths = []
    row = []
    for i, c in enumerate(cells):
        row.append(c)
        widths.append(col)
        if i < len(cells) - 1:
            row.append("")
            widths.append(gap)
    t = Table([row], colWidths=widths)
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                           ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
    return t


def data_table(head: list[str], rows: list[list[str]], widths: list[float], S, right: set[int] = frozenset(),
               zebra: bool = True) -> Table:
    def cell(v, i, header):
        st = ("head_r" if i in right else "head") if header else ("cell_r" if i in right else "cell")
        return Paragraph(v if isinstance(v, str) else str(v), S[st])
    data = [[cell(h, i, True) for i, h in enumerate(head)]] + [[cell(v, i, False) for i, v in enumerate(r)] for r in rows]
    t = Table(data, colWidths=widths, repeatRows=1)
    st = [("LINEBELOW", (0, 0), (-1, 0), 0.8, INK_3), ("LINEBELOW", (0, 1), (-1, -1), 0.3, LINE),
          ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 2.6), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.6),
          ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3)]
    if zebra:
        st += [("BACKGROUND", (0, r), (-1, r), PANEL) for r in range(2, len(data), 2)]
    t.setStyle(TableStyle(st))
    return t


def box(flowables: list[Flowable], bg=PANEL, border=None, pad: float = 8) -> Table:
    t = Table([[flowables]], colWidths=[TEXT_W])
    st = [("BACKGROUND", (0, 0), (-1, -1), bg), ("LEFTPADDING", (0, 0), (-1, -1), pad), ("RIGHTPADDING", (0, 0), (-1, -1), pad),
          ("TOPPADDING", (0, 0), (-1, -1), pad - 2), ("BOTTOMPADDING", (0, 0), (-1, -1), pad)]
    if border is not None:
        st.append(("BOX", (0, 0), (-1, -1), 0.8, border))
    t.setStyle(TableStyle(st))
    return t


def bullets(items: list[str], S, style: str = "body", numbered: bool = False) -> ListFlowable:
    return ListFlowable([ListItem(Paragraph(i, S[style]), leftIndent=12) for i in items],
                        bulletType="1" if numbered else "bullet", start="1" if numbered else "•", leftIndent=12,
                        bulletFontName="DV", bulletFontSize=8.5 if numbered else 7, bulletColor=ACCENT, spaceBefore=1)


class NumberedCanvas(rl_canvas.Canvas):
    """Page furniture with 'page n of N' (the total is only known after the last page)."""

    furniture: dict = {}
    pages_total = 0

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self._saved: list[dict] = []

    def showPage(self):
        self._saved.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        NumberedCanvas.pages_total = len(self._saved)
        for state in self._saved:
            self.__dict__.update(state)
            self._furniture()
            super().showPage()
        super().save()

    def _furniture(self):
        f, n = NumberedCanvas.furniture, self._pageNumber
        self.saveState()
        self.setStrokeColor(LINE)
        self.setLineWidth(0.5)
        if n > 1:
            self.setFont("DV-B", 7.5)
            self.setFillColor(INK_2)
            self.drawString(MARGIN_X, PAGE_H - 12 * mm, f["header_left"])
            self.setFillColor(WARN)
            self.drawRightString(PAGE_W - MARGIN_X, PAGE_H - 12 * mm, f["status"])
            self.line(MARGIN_X, PAGE_H - 13.8 * mm, PAGE_W - MARGIN_X, PAGE_H - 13.8 * mm)
        self.line(MARGIN_X, 12.5 * mm, PAGE_W - MARGIN_X, 12.5 * mm)
        self.setFont("DV", 7.2)
        self.setFillColor(INK_3)
        self.drawString(MARGIN_X, 8.5 * mm, f["footer_left"])
        self.drawRightString(PAGE_W - MARGIN_X, 8.5 * mm, f"Page {n} of {NumberedCanvas.pages_total}")
        self.restoreState()


# ----------------------------------------------------------------------------- checks
def check_inputs(doc: dict, summary_md: str) -> None:
    newest_table = max(p.stat().st_mtime for p in (OUT / "tables").glob("*.csv"))
    generated = datetime.fromisoformat(doc["generated_utc"]).timestamp()
    if generated < newest_table:
        raise SystemExit("case-study.json is older than outputs/tables: run export_case_study.py first.")
    for s in doc["findings"]:
        if s not in summary_md:
            raise SystemExit(f"A finding in case-study.json is not in results_summary.md: {s[:100]}…")
    for lim in doc["limitations"]:
        if f"**{lim['title']}**" not in summary_md or lim["text"] not in summary_md:
            raise SystemExit(f"A limitation in case-study.json is not in results_summary.md: {lim['title']}")


# ----------------------------------------------------------------------------- report
def population(doc: dict, S, charts: Path) -> list[Flowable]:
    """Population table and chart (GHSL), kept together."""
    head = ["Epoch", "Residents (million)", "GHSL built-up surface km²", "Built-up km², this study"]
    rows = [[f"{p['epoch']}{' *' if p['projection'] else ''}", f"{p['population'] / 1e6:.2f}", f"{p['ghsl_built_km2']:.0f}",
             km2(p["builtup_km2_this_study"]) if p["builtup_km2_this_study"] is not None else "—"] for p in doc["population"]]
    tab = [data_table(head, rows, [16 * mm, 26 * mm, 30 * mm, 28 * mm], S, right={1, 2, 3}),
           Paragraph("* GHSL model projection, not a census-based estimate. GHSL counts built surface inside each 100 m cell; this "
                     "study counts 30 m pixels classified built-up, so the two differ in level. Two time points describe co-occurring "
                     "growth, not a cause.", S["caption"])]
    t = Table([[tab, figure(charts / "population_vs_builtup.png", TEXT_W - 106 * mm)]], colWidths=[106 * mm, TEXT_W - 106 * mm])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (0, 0), 6 * mm)]))
    return [KeepTogether([Paragraph("Population", S["h2"]),
                          Paragraph("GHSL GHS-POP and GHS-BUILT-S (release P2023A), summed over the study area.", S["small"]),
                          Spacer(1, 2 * mm), t])]


def build_pdf(cfg, doc: dict, summary_md: str, dest: Path) -> int:
    S = styles()
    rep = cfg.raw["report"]
    st = doc["study"]
    years = st["years"]
    a, b = years[0], years[-1]
    span = f"{a}–{b}"
    title = f"{rep['title']}, {span}"
    tt_version = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["version"]
    m = re.search(r"Generated (\d{4}-\d{2}-\d{2})", summary_md)
    computed = m.group(1) if m else doc["generated_utc"][:10]
    today = date.today()
    heat = bool(doc.get("lst_enabled", True))
    classes = st["classes"]
    built, veg, crop = (classes[i]["name"] for i in range(3))
    area = lambda y, c: next(r for r in doc["areas"] if r["year"] == y and r["class_code"] == c)  # noqa: E731
    net = lambda c: next(r for r in doc["net_change"] if r["from_year"] == a and r["to_year"] == b and r["class_code"] == c)  # noqa: E731
    tr = next(t for t in doc["transitions"] if t["from_year"] == a and t["to_year"] == b)
    uhi = lambda y, s, primary=True: next(u for u in doc["uhi"] if u["year"] == y and u["season"] == s and u["primary"] == primary)  # noqa: E731
    cor = lambda y, s, i: next(c for c in doc["correlations"] if c["year"] == y and c["season"] == s and c["index"] == i)  # noqa: E731
    winter = lambda y: f"{x(comp('winter', y))}: {scenes(y, 'winter')}, " if heat else ""  # noqa: E731
    pop = {p["epoch"]: p for p in doc["population"]}
    scenes = lambda y, s: next(r["scenes"] for r in st["scenes"] if r["year"] == y and r["season"] == s)  # noqa: E731
    comp = lambda s, y, short=False: st["composites"][s][str(y)]["short" if short else "label"]  # noqa: E731
    cap = lambda t: t[:1].upper() + t[1:]  # noqa: E731
    maps, charts = OUT / "maps", OUT / "charts"

    NumberedCanvas.furniture = {"header_left": f"TerraTrace case study · {st['short_name']} · {span}", "status": rep["status"],
                                "footer_left": f"{rep['author']} · {today.strftime('%d %B %Y')}"}
    story: list[Flowable] = []
    P = lambda t, s="body": Paragraph(t, S[s])  # noqa: E731

    # --- 1. title page
    story += [Spacer(1, 18 * mm), P("TERRATRACE CASE STUDY · PRECOMPUTED ANALYSIS", "kicker"), Spacer(1, 3 * mm), P(x(title), "title"),
              P(x(st["name"]), "subtitle"), Spacer(1, 8 * mm),
              box([P(f"<b>{x(rep['status'])}.</b> These results come from a reproducible analysis pipeline and have not "
                     "been peer reviewed. Classification accuracy is reported only as <i>agreement with reference labels</i>, "
                     "not accuracy against ground truth.", "body")], bg=WARN_BG, border=colors.HexColor("#e2b44c")),
              Spacer(1, 8 * mm)]
    sensors = "; ".join(f"{y}: {st['sensors'][str(y)]}" for y in years)
    facts = [
        ["Author", x(rep["author"])],
        ["Study area", f"{st['area_km2']:,.0f} km² (sum of the classified 30 m pixels) · {x(' + '.join(st['districts']))} districts "
                       f"({x(st['boundary_source'])})"],
        ["Years and sensors", x(sensors) + " — Landsat Collection 2 Level-2, Tier 1, 30 m"],
        ["Scenes used", "; ".join(f"{x(comp('summer', y, True))}: {scenes(y, 'summer')}, {winter(y)}"
                                  f"whole year {y}: {scenes(y, 'annual')}" for y in years)],
        ["Report date", today.strftime("%d %B %Y").lstrip("0") + f" (Earth Engine results downloaded {doc['earth_engine_downloaded_utc'][:10]}; "
                        f"tables and summary regenerated {computed})"],
        ["Versions", f"TerraTrace {x(tt_version)} · analysis pipeline {x(doc['pipeline_version'])}"],
    ]
    t = Table([[P(k, "head"), P(v, "cell")] for k, v in facts], colWidths=[34 * mm, TEXT_W - 34 * mm])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.3, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                           ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    cite = (f"{x(rep['author'])} ({today.year}). <i>{x(title)}</i>. TerraTrace case study report — {x(rep['status'].lower())}. "
            f"TerraTrace {x(tt_version)}, analysis pipeline {x(doc['pipeline_version'])}. File: {x(rep['pdf_file'])}.")
    story += [t, Spacer(1, 8 * mm), P("About this report", "h2"),
              P(f"Computed from Landsat satellite data with TerraTrace's analysis pipeline. Results are fixed for "
                f"{' and '.join(str(y) for y in years)}. These figures are a fixed {a} vs {b} analysis; the live analysis tool on "
                f"the site works separately. {x(st['method_summary'])}"),
              Spacer(1, 3 * mm),
              P("Every result in this report is read from the pipeline's output tables; contextual figures from other sources "
                "are cited. The tables are the same files behind the TerraTrace case-study web page and <i>results_summary.md</i>; "
                "no result is typed by hand. The CSV tables are "
                f"available as a separate download ({x(rep['data_file'])}).", "small"),
              Spacer(1, 6 * mm), box([P("How to cite", "kicker"), Spacer(1, 1.5 * mm), P(cite, "small")], bg=PANEL),
              PageBreak()]

    # --- 2. key findings: the headline cards of the web page (case-study.json), two per row
    c2b = tr["cropland_to_built"]
    card_w = (TEXT_W - 6 * mm) / 2

    def card(h: dict) -> Table:
        t = Table([[Paragraph(f"<b>{x(h['value'])}</b>", S["value"]), Paragraph(x(h["period"]), S["period"])],
                   [Paragraph(x(h["title"]), S["card_title"]), ""], [Paragraph(x(h["text"]), S["small"]), ""]],
                  colWidths=[card_w - 30 * mm, 30 * mm])
        t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PANEL), ("SPAN", (0, 1), (1, 1)), ("SPAN", (0, 2), (1, 2)),
                               ("VALIGN", (0, 0), (-1, 0), "BOTTOM"), ("VALIGN", (0, 1), (-1, -1), "TOP"),
                               ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                               ("TOPPADDING", (0, 0), (-1, 0), 8), ("TOPPADDING", (0, 1), (-1, -1), 2), ("BOTTOMPADDING", (0, -1), (-1, -1), 9)]))
        return t
    cards = [card(h) for h in doc["headlines"]]
    rows = [cards[i:i + 2] + [""] * (2 - len(cards[i:i + 2])) for i in range(0, len(cards), 2)]
    grid = Table([[r[0], "", r[1]] for r in rows], colWidths=[card_w, 6 * mm, card_w])
    grid.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                              ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 6 * mm)]))
    story += [P("Key findings", "h1"), P(f"{span} · from Landsat satellite data", "kicker"), Spacer(1, 4 * mm), grid,
              P("How these figures were made, and what they cannot show, is set out in <i>Method and limitations</i>, together with "
                "the detailed findings for researchers.", "small"), PageBreak()]

    # --- 3. land cover
    mapw = (TEXT_W - 6 * mm) / 2
    story += [P("Land cover", "h1"),
              P(f"Random Forest classification at 30 m into {len(classes)} classes. Barren/open land is merged with built-up land into "
                f"one class, {x(built)}, in every year (too few reference pixels to train it as a class), so construction sites and "
                "cleared plots count as built-up.", "small"),
              Spacer(1, 3 * mm),
              side_by_side([(figure(maps / f"lulc_{y}.png", mapw, max_height=118 * mm), f"Land use / land cover, {y}.") for y in years], S),
              Spacer(1, 4 * mm), P(f"Class areas and net change, {a} → {b}", "h2")]
    head = ["Class"] + [f"{y} km² (%)" for y in years] + ["Net km²", "Percentage points", "Relative"]
    rows = []
    for c in classes:
        n = net(c["code"])
        rows.append([x(c["name"])] + [f"{km2(area(y, c['code'])['area_km2'])} ({area(y, c['code'])['percent']:.1f})" for y in years]
                    + [signed(n["delta_km2"]), signed(n["delta_pp"]), f"{n['delta_rel_pct']:+.0f} %" if n["delta_rel_pct"] is not None else "—"])
    story += [data_table(head, rows, [52 * mm, 28 * mm, 28 * mm, 20 * mm, 23 * mm, 23 * mm], S, right={1, 2, 3, 4, 5}),
              P("Percentages are of the classified area. Relative change = net change ÷ the class's area in the first year.", "caption"),
              PageBreak()]

    # --- 4. change
    into = ", ".join(f"{km2(i['km2'])} km² from {x(i['from'])}" for i in tr["into_built"])
    right = [P(f"Change {a} → {b}", "h2"),
             P(f"<b>Cropland that became built-up, net: {km2(c2b['net_km2'])} km².</b>", "body"),
             Spacer(1, 2 * mm),
             P(f"<b>Land that became {x(built)}</b> (gross): {into}.", "small"),
             Spacer(1, 2 * mm),
             P("Why the net figures are used, and how to read the gross transitions: see <i>Method and limitations</i>.", "small")]
    t = Table([[figure(maps / f"change_{a}_{b}.png", 92 * mm, max_height=150 * mm), right]], colWidths=[98 * mm, TEXT_W - 98 * mm])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (0, 0), 6 * mm)]))
    story += [P("Land-cover change", "h1"), t, Spacer(1, 2 * mm),
              P("Pixel-by-pixel comparison of the two land-cover maps on the same 30 m grid.", "caption"), Spacer(1, 5 * mm)]
    story += population(doc, S, charts) + [PageBreak()]
    if heat:
        story += heat_pages(cfg, doc, S, comp, cap, uhi, cor)
    story += method_pages(cfg, doc, S, comp, cap, heat, classes, st, a, b)

    pdf = SimpleDocTemplate(str(dest), pagesize=A4, leftMargin=MARGIN_X, rightMargin=MARGIN_X, topMargin=MARGIN_TOP,
                            bottomMargin=MARGIN_BOTTOM, title=title, author=rep["author"],
                            subject=f"TerraTrace case study — {rep['status']}",
                            creator=f"TerraTrace analysis pipeline v{doc['pipeline_version']} (export_report.py)",
                            keywords="land use land cover, " + ("urban heat island, " if heat else "urban growth, ") + "Landsat, Noida, Ghaziabad, Delhi NCR")
    pdf.build(story, canvasmaker=NumberedCanvas)
    return NumberedCanvas.pages_total


def heat_pages(cfg, doc: dict, S, comp, cap, uhi, cor) -> list[Flowable]:
    """Surface heat, UHI, conversion test and temperature correlations (only while the LST analysis is switched on)."""
    st, story = doc["study"], []
    years, classes = st["years"], st["classes"]
    a, b = years[0], years[-1]
    P = lambda t, s="body": Paragraph(t, S[s])  # noqa: E731
    mapw = (TEXT_W - 6 * mm) / 2
    maps, charts = OUT / "maps", OUT / "charts"
    # --- 5–6. surface heat
    lst_mean = lambda y, s: next(r["mean_land_c"] for r in doc["lst_summary"] if r["year"] == y and r["season"] == s)  # noqa: E731
    lst_cls = lambda y, s, c: next(r["mean_c"] for r in doc["lst_per_class"] if r["year"] == y and r["season"] == s and r["class_code"] == c)  # noqa: E731
    story += [P("Surface heat", "h1"),
              P("Landsat land surface temperature (LST) at the ~10:30 local overpass; per-pixel median of clear observations. "
                f"April–June is the primary season; November–February ({x(comp('winter', a))} and {x(comp('winter', b))}) is secondary. "
                "One colour range per season, shared by both years.", "small"),
              Spacer(1, 3 * mm),
              side_by_side([(figure(maps / f"lst_summer_{y}.png", mapw, max_height=112 * mm),
                             f"LST, {x(comp('summer', y))} · study-area land mean {degc(lst_mean(y, 'summer'))}.") for y in years], S),
              Spacer(1, 3 * mm), P("Mean LST per class", "h2")]
    head = ["Class"] + [x(cap(comp(s, y, True))) for s in ("summer", "winter") for y in years]
    rows = [["Study area (land)"] + [degc(lst_mean(y, s)) for s in ("summer", "winter") for y in years]]
    rows += [[x(c["name"])] + [degc(lst_cls(y, s, c["code"])) for s in ("summer", "winter") for y in years] for c in classes]
    story += [data_table(head, rows, [62 * mm] + [28.5 * mm] * 4, S, right={1, 2, 3, 4}),
              P("Absolute LST differs between years partly because of each season's weather: compare classes within a year, "
                "or use the UHI intensity across years.", "caption")]
    if "weather_2025" in doc["context"]:
        story += [Spacer(1, 3 * mm), box([P("Weather context (cited — not a result of this study)", "kicker"), Spacer(1, 1 * mm),
                                          P(x(doc["context"]["weather_2025"]["text"]), "small")], bg=WARN_BG)]
    story += [PageBreak()]

    story += [P("Surface heat — winter, and urban heat island intensity", "h1"),
              side_by_side([(figure(maps / f"lst_winter_{y}.png", mapw, max_height=112 * mm),
                             f"LST, {x(comp('winter', y))} (November–February) · study-area land mean {degc(lst_mean(y, 'winter'))}.") for y in years], S),
              Spacer(1, 3 * mm), P("Urban heat island (UHI) intensity, urban − rural", "h2")]
    head = ["Composite", "Urban core − rural ring (primary)", "Built-up − non-built-up", "Result"]
    rows = []
    for s in ("summer", "winter"):
        for y in years:
            p_, q_ = uhi(y, s), uhi(y, s, False)
            rows.append([f"{x(cap(comp(s, y)))} ({'primary' if s == 'summer' else 'secondary'})", f"{signed(p_['uhi_c'], 2)}\u00a0°C ({p_['urban_mean_c']:.1f} vs {p_['rural_mean_c']:.1f}; ring to {p_['ring_outer_km']:.1f}\u00a0km)",
                         f"{signed(q_['uhi_c'], 2)}\u00a0°C", f"<b>{x(p_['result'])}</b>"])
    u = cfg.uhi
    story += [data_table(head, rows, [46 * mm, 68 * mm, 32 * mm, TEXT_W - 146 * mm], S, right={1, 2}),
              P("Urban core minus the countryside around it. How the core and ring are drawn, and why the summer value changes "
                "sign: see <i>Method and limitations</i>.", "caption"),
              PageBreak()]

    # --- 7. key test + correlations
    def pair(c: dict) -> str:
        pa, pb = (int(v) for v in c["period"].split("-"))
        la, lb = comp(c["season"], pa, True), comp(c["season"], pb, True)
        return x(cap(la) + " → " + (lb.split(" ")[-1] if c["season"] == "summer" else lb.replace("winter ", "")))
    head = ["Composites", "Group", "Area km²", "Mean ΔLST", "Mean Δ normalised LST"]
    rows = [[pair(c), x(c["group"]), km2(c["area_km2"]), f"{signed(c['delta_lst_c'], 2)} °C", f"{signed(c['delta_z'], 2)} SD"]
            for c in doc["conversion"]]
    story += [P("Did land that became built-up warm?", "h1"),
              P(f"LST change {a} → {b} of pixels that became built-up, against pixels that kept their class. Normalised LST = "
                "(LST − study-area mean) ÷ SD for that season and year, so a hotter year as a whole does not count as warming.", "small"),
              Spacer(1, 2 * mm), data_table(head, rows, [42 * mm, 56 * mm, 20 * mm, 24 * mm, 32 * mm], S, right={2, 3, 4}),
              Spacer(1, 6 * mm), P("Temperature against vegetation and built-up indices", "h2")]
    head = ["Composite", "LST vs NDVI r", "LST vs NDBI r", "Land pixels", "Thinned grid (for p)"]
    rows = [[f"{x(cap(comp(s, y)))} ({'primary' if s == 'summer' else 'secondary'})", f"{cor(y, s, 'NDVI')['r']:+.3f}", f"{cor(y, s, 'NDBI')['r']:+.3f}", f"{cor(y, s, 'NDVI')['n_pixels']:,}",
             f"{cor(y, s, 'NDVI')['n_thinned']:,} px, p &lt; 0.001" if max(cor(y, s, i)["p_thinned"] for i in ("NDVI", "NDBI")) < 0.001
             else f"{cor(y, s, 'NDVI')['n_thinned']:,} px"] for s in ("summer", "winter") for y in years]
    spacing = doc["correlations"][0]["thin_spacing_m"]
    story += [data_table(head, rows, [48 * mm, 24 * mm, 24 * mm, 28 * mm, TEXT_W - 124 * mm], S, right={1, 2, 3}),
              P(f"Pearson r over every land pixel (water excluded). The p-value uses a {spacing} m thinned grid, because neighbouring "
                "30 m pixels are not independent; with this many pixels the size of r is what matters.", "caption"),
              Spacer(1, 3 * mm),
              side_by_side([(figure(charts / "scatter_lst_indices_summer.png", (TEXT_W - 6 * mm) / 2), "April–June (primary)."),
                            (figure(charts / "scatter_lst_indices_winter.png", (TEXT_W - 6 * mm) / 2),
                             f"{x(cap(comp('winter', a)))} and {x(comp('winter', b))} (November–February, secondary).")], S),
              PageBreak()]
    return story


def method_pages(cfg, doc: dict, S, comp, cap, heat: bool, classes, st, a, b) -> list[Flowable]:
    """Method and limitations, quality control, sources, references, changelog."""
    story: list[Flowable] = []
    P = lambda t, s="body": Paragraph(t, S[s])  # noqa: E731
    u = cfg.uhi
    # --- 8. method and quality control
    rf = cfg.rf
    acc_rows = [[str(r["year"]), f"{r['overall_agreement'] * 100:.1f} %", f"{r['kappa']:.3f}", f"{r['n_test']}",
                 "; ".join(f"{x(c['a'])} ↔ {x(c['b'])} ({c['n']})" for c in r["most_confused"])] for r in doc["accuracy"]]
    method = [
        (f"<b>Imagery.</b> Landsat Collection 2 Level-2 (Tier 1) surface reflectance and surface temperature at 30 m, cloud, shadow "
         "and snow masked with QA_PIXEL. Per-pixel medians for April–June (also the spectral features for classification), "
         "November–February, and the whole year (NDVI percentiles separate cropland from bare land).") if heat else
        ("<b>Imagery.</b> Landsat Collection 2 Level-2 (Tier 1) surface reflectance at 30 m, cloud, shadow and snow masked with "
         "QA_PIXEL. Per-pixel medians for April–June (the spectral features for classification) and the whole year (NDVI "
         "percentiles separate cropland from bare land).") ,
        f"<b>Classification.</b> {len(classes)}-class Random Forest (Breiman, 2001; {rf['trees']} trees) in Google Earth Engine, trained "
        f"on up to {rf['points_per_class']} points per class ({rf['train_fraction'] * 100:.0f}/{(1 - rf['train_fraction']) * 100:.0f} "
        "train/test split) sampled from GLC-FCS30D pixels (Zhang et al., 2024) whose class is stable over several years and agrees "
        "with independent products (ESA WorldCover, Zanaga et al., 2022; Dynamic World, Brown et al., 2022).",
        "<b>Reference labels, exactly.</b> " + "; ".join(f"<b>{r['year']} map:</b> {x(r['text'])}" for r in st["reference_labels"]) + "."
        + (" Not every year matches the map year: see <i>Limitations</i>." if st["reference_label_mismatches"] else ""),
    ]
    if heat:
        method.append("<b>Land surface temperature and UHI.</b> LST from the Landsat thermal band; UHI intensity as urban core minus an "
                      "equal-area rural ring (primary; after Peng et al., 2012, and Chakraborty &amp; Lee, 2019) and as built-up minus "
                      "non-built-up land (secondary); water is excluded from all land statistics.")
        method.append(f"<b>Urban core and rural ring.</b> Core: pixels whose built-up fraction within {u['core_radius_m']} m is ≥ "
                      f"{u['core_threshold'] * 100:.0f} %, in patches of at least {u['core_min_km2']:g} km². Ring: the nearest non-built-up, "
                      "non-water land of equal area inside the study area (East Delhi, west of the study area, is itself urban). A negative "
                      "value means the city is cooler than its surroundings by day.")
    timing_rows = [[x(cap(r["composite"])), x(r["months"]), str(r["total"]), x(r["median"])] for r in st["scene_timing"]]
    timing = [P("Scenes per month and median acquisition date", "h2"),
              data_table(["Composite", "Scenes per calendar month", "Total", "Median date"], timing_rows,
                         [40 * mm, 76 * mm, 18 * mm, TEXT_W - 134 * mm], S, right={2}),
              P("Landsat scenes that passed the scene cloud filter (clouds inside them are masked per pixel); neighbouring path/rows on "
                "one date count as separate scenes. Counted from the scene lists saved with the Earth Engine run. A CAUTION flag is "
                "raised automatically when a month's share of a season's scenes differs between years by more than "
                f"{cfg.checks['max_month_share_diff_pp']} percentage points.", "caption")]
    story += [P("Method and limitations", "h1"), P("How to read these results", "h2"),
              bullets([f"<b>{x(c['title'])}.</b> {x(c['text'])}" for c in doc["caveats"]], S, "small"), Spacer(1, 2 * mm),
              P("Method", "h2"), bullets(method, S, "small"), Spacer(1, 3 * mm), KeepTogether(timing), Spacer(1, 3 * mm),
              P("Classification — agreement with reference labels", "h2"),
              data_table(["Year", "Agreement with reference labels", "Kappa", "Held-out points", "Most confused pairs (test points)"],
                         acc_rows, [12 * mm, 36 * mm, 15 * mm, 22 * mm, TEXT_W - 85 * mm], S, right={1, 2, 3}),
              P("Agreement with GLC-FCS30D-derived reference labels on held-out points, not accuracy against ground truth. "
                "Stable pixels are easier than changing ones, so these figures are optimistic.", "caption")]
    if heat:
        mrows = [[x(cap(comp(r["season"], r["year"], True))), f"{r['pixels_removed_entirely']:,} ({r['pixels_removed_entirely'] / r['pixels_with_lst_before'] * 100:.3f} %)",
                  f"{r['max_land_lst_before_c']:.1f} → {r['max_land_lst_after_c']:.1f} °C",
                  f"{signed(r['uhi_core_ring_before_c'], 2)} → {signed(r['uhi_core_ring_after_c'], 2)} °C"] for r in doc["masking"]["impact"]]
        story += [Spacer(1, 3 * mm), P("Temperature masking", "h2"), P(x(doc["masking"]["rule"]), "small"),
                  Spacer(1, 2 * mm), data_table(["Composite", "Pixels that lost their LST", "Max land LST", "UHI core vs ring, before → after"],
                                                mrows, [26 * mm, 46 * mm, 40 * mm, TEXT_W - 112 * mm], S, right={1, 2, 3})]
    story += [Spacer(1, 3 * mm), KeepTogether([P("Quality flags raised by the pipeline's checks", "h2"),
                                               bullets([f"<b>{x(f['level'])}</b> ({x(f['topic'])}): {x(f['message'])}" for f in doc["flags"]], S, "small")]),
              Spacer(1, 3 * mm), P("Cross-checks run before the summary was written (all passed)", "h2"),
              bullets([x(c) for c in doc["cross_checks"]], S, "small"), Spacer(1, 3 * mm),
              KeepTogether([P("Detailed findings (for researchers)", "h2"),
                            P("Verbatim from <i>results_summary.md</i>, which the pipeline generates from the same tables.", "small"),
                            Spacer(1, 1.5 * mm), bullets([x(f) for f in doc["findings"]], S, "small", numbered=True)]),
              Spacer(1, 4 * mm)]

    # --- 9–10. limitations, sources, references, citation
    lims = [f"<b>{x(l_['title'])}</b>{'' if re.match(r'^[;,.:]', l_['text']) else ' '}{x(l_['text'])}" for l_ in doc["limitations"]]
    sources = [
        "Landsat 8 and 9 Collection 2 Level-2, Tier 1 (U.S. Geological Survey) — Earth Engine LANDSAT/LC08/C02/T1_L2, LANDSAT/LC09/C02/T1_L2.",
        f"GLC-FCS30D annual global land cover, 30 m (Zhang et al., 2024) — {x(cfg.labels['glc_collection'])}.",
        "ESA WorldCover 10 m 2021 v200 (Zanaga et al., 2022) — ESA/WorldCover/v200.",
        "Dynamic World V1 (Brown et al., 2022) — GOOGLE/DYNAMICWORLD/V1.",
        f"GHSL GHS-POP and GHS-BUILT-S, release P2023A (European Commission, Joint Research Centre) — {x(cfg.raw['population']['collection'])}, "
        f"{x(cfg.raw['population']['built_collection'])}.",
        f"FAO Global Administrative Unit Layers (GAUL) 2025, level 2 (study-area boundary) — {x(cfg.study['gaul_collection'])}.",
        "JRC Global Surface Water (Pekel et al., 2016) — used only to check seasonal ponds during quality control.",
        *([f"Weather context (cited, not used in any computation): {x(doc['context']['weather_2025']['source'])}."]
          if "weather_2025" in doc["context"] else []),
        "Processing: Google Earth Engine (Gorelick et al., 2017) for compositing, sampling and classification; statistics, maps and "
        f"this report computed locally by the TerraTrace analysis pipeline v{x(doc['pipeline_version'])}.",
    ]
    refs = [
        "Breiman, L. (2001). Random forests. <i>Machine Learning</i>, 45(1), 5–32. https://doi.org/10.1023/A:1010933404324",
        "Brown, C. F., Brumby, S. P., Guzder-Williams, B., et al. (2022). Dynamic World, near real-time global 10 m land use land "
        "cover mapping. <i>Scientific Data</i>, 9, 251. https://doi.org/10.1038/s41597-022-01307-4",
        *(["Chakraborty, T., &amp; Lee, X. (2019). A simplified urban-extent algorithm to characterize surface urban heat islands on a "
           "global scale and examine vegetation control on their spatiotemporal variability. <i>International Journal of Applied "
           "Earth Observation and Geoinformation</i>, 74, 269–280. https://doi.org/10.1016/j.jag.2018.09.015"] if heat else []),
        *([doc["context"]["weather_2025"]["reference"]] if "weather_2025" in doc["context"] else []),
        "Gorelick, N., Hancher, M., Dixon, M., Ilyushchenko, S., Thau, D., &amp; Moore, R. (2017). Google Earth Engine: "
        "Planetary-scale geospatial analysis for everyone. <i>Remote Sensing of Environment</i>, 202, 18–27. "
        "https://doi.org/10.1016/j.rse.2017.06.031",
        "Olofsson, P., Foody, G. M., Herold, M., Stehman, S. V., Woodcock, C. E., &amp; Wulder, M. A. (2014). Good practices for "
        "estimating area and assessing accuracy of land change. <i>Remote Sensing of Environment</i>, 148, 42–57. "
        "https://doi.org/10.1016/j.rse.2014.02.015",
        "Pekel, J.-F., Cottam, A., Gorelick, N., &amp; Belward, A. S. (2016). High-resolution mapping of global surface water and its "
        "long-term changes. <i>Nature</i>, 540, 418–422. https://doi.org/10.1038/nature20584",
        *(["Peng, S., Piao, S., Ciais, P., et al. (2012). Surface urban heat island across 419 global big cities. <i>Environmental "
           "Science &amp; Technology</i>, 46(2), 696–703. https://doi.org/10.1021/es2030438",
           "Shastri, H., Barik, B., Ghosh, S., Venkataraman, C., &amp; Sadavarte, P. (2017). Flip flop of day-night and summer-winter "
           "surface urban heat island intensity in India. <i>Scientific Reports</i>, 7, 40178. https://doi.org/10.1038/srep40178"] if heat else []),
        "Zanaga, D., Van De Kerchove, R., Daems, D., et al. (2022). <i>ESA WorldCover 10 m 2021 v200</i> [Dataset]. Zenodo. "
        "https://doi.org/10.5281/zenodo.7254221",
        "Zhang, X., Zhao, T., Xu, H., Liu, W., Wang, J., Chen, X., &amp; Liu, L. (2024). GLC_FCS30D: the first global 30 m land-cover "
        "dynamics monitoring product with a fine classification system for the period from 1985 to 2022 generated using "
        "dense-time-series Landsat imagery and the continuous change-detection method. <i>Earth System Science Data</i>, 16, "
        "1353–1381. https://doi.org/10.5194/essd-16-1353-2024",
    ]
    story += [CondPageBreak(70 * mm), P("Limitations", "h2"), bullets(lims, S, "small"), Spacer(1, 2 * mm),
              P("Data sources", "h2"), bullets(sources, S, "small"), Spacer(1, 2 * mm),
              P("References", "h2")] + [P(r, "ref") for r in refs]
    story += [Spacer(1, 3 * mm), P("Changelog", "h2")] + [P(f"<b>v{x(c['version'])}</b> {x(c['text'])}", "ref") for c in doc["changelog"]]
    return story


# ----------------------------------------------------------------------------- data download
COMMON = """\
Units and conventions used in every table:

- Areas are km² on the study's 30 m UTM zone 43N grid (pixel count × 900 m² ÷ 10⁶).
{temperature}- `season`: `summer` = April–June of the study year (primary; e.g. "April–June 2015"); `winter` = November of the previous year to
  February of the study year ({winter_role}), named by both years it spans (study year 2015 = "winter 2014–15"); `annual` = the whole
  calendar year. Tables keep the study year in `year`; the `composite` column, where present, gives the name.
- Class codes: 1 Built-up and bare land, 2 Vegetation/Trees, 3 Agriculture/Cropland, 4 Water (0 = not classified).
- Shares (`overall_agreement`, `producers_*`, `users_*`, `f1_*`, `*_fraction_*`) are 0–1; `percent_*` columns are 0–100.
- Accuracy columns are AGREEMENT WITH REFERENCE LABELS (held-out GLC-FCS30D-derived points), not accuracy against ground truth.
"""

DOCS: dict[str, tuple[str, dict[str, str]]] = {
    "class_areas.csv": ("Area of each land-cover class per year.", {
        "year": "study year", "class_code": "class code (0 = not classified)", "class": "class name",
        "pixels": "number of 30 m pixels", "area_km2": "area, km²", "percent_of_classified": "share of the classified area, %"}),
    "transition_2015_2025_km2.csv": ("Transition matrix: area (km²) that was class *row* in the first year and class *column* in the second.", {
        "from \\ to": "class in the first year (rows); the other columns are the class in the second year, values in km²"}),
    "accuracy_metrics.csv": ("Agreement of the Random Forest map with held-out reference points, per year.", {
        "year": "study year", "overall_agreement": "overall agreement with reference labels, 0–1", "kappa": "Cohen's kappa",
        "n_test_points": "held-out test points", "n_test_<class>": "test points of that class",
        "producers_<class>": "producer's agreement (reference class correctly mapped), 0–1",
        "users_<class>": "user's agreement (mapped class matching the reference), 0–1", "f1_<class>": "F1 score, 0–1",
        "per_class_withheld": "classes with too few test points for per-class figures (empty = none)"}),
    "confusion_matrix_2015.csv": ("Confusion matrix of the held-out test points, 2015 (counts of points).", {
        "reference \\ predicted": "reference class (rows); the other columns are the mapped class, values are point counts"}),
    "confusion_matrix_2025.csv": ("Confusion matrix of the held-out test points, 2025 (counts of points).", {
        "reference \\ predicted": "reference class (rows); the other columns are the mapped class, values are point counts"}),
    "feature_importance.csv": ("Random Forest feature importance (Earth Engine `explain()`), per year.", {
        "year": "study year", "feature": "input band (Apr–Jun reflectance blue…swir2, indices ndvi/ndbi/mndwi, whole-year NDVI percentiles ndvi_p10/p50/p90)",
        "importance": "importance score (unitless, larger = more used)"}),
    "training_labels.csv": ("Reference-label pixels available and points drawn per class.", {
        "year": "study year", "class": "class name", "reference_label_pixels": "stable GLC-FCS30D reference pixels in the study area",
        "train_points": "training points", "test_points": "held-out test points"}),
    "scenes.csv": ("Landsat scenes in each composite.", {
        "year": "study year", "season": "summer / winter / annual", "composite": "name of the composite (e.g. winter 2014–15)",
        "sensors": "LC08 = Landsat 8, LC09 = Landsat 9", "scenes": "number of scenes", "first_date": "first scene date",
        "last_date": "last scene date", "median_date": "median scene date (midpoint of the two middle dates for an even count)",
        "date_ranges": "composite date range(s), end exclusive"}),
    "scene_months.csv": ("Landsat scenes per calendar month in each seasonal composite (from the scene lists of the Earth Engine run).", {
        "year": "study year", "season": "summer / winter", "composite": "name of the composite", "month": "calendar month, YYYY-MM",
        "month_of_season": "1 = first month of the season", "month_name": "month abbreviation", "scenes": "scenes acquired in that month",
        "share_of_composite": "share of the composite's scenes, 0–1"}),
    "lst_summary.csv": ("Study-area land surface temperature (water excluded), per year and season.", {
        "year": "study year", "season": "summer / winter", "mean_land_c": "mean LST of land pixels, °C", "sd_land_c": "standard deviation, °C",
        "p1_c": "1st percentile, °C", "p99_c": "99th percentile, °C", "valid_fraction_of_study_area": "share of the study area with a valid LST, 0–1",
        "classified_fraction_of_study_area": "share of the study area that is classified, 0–1"}),
    "lst_per_class.csv": ("Land surface temperature per land-cover class.", {
        "year": "study year", "season": "summer / winter", "class_code": "class code", "class": "class name", "n_pixels": "pixels with a valid LST",
        "mean_c": "mean LST, °C", "sd_c": "standard deviation, °C", "median_c": "median LST, °C"}),
    "uhi_intensity.csv": ("Surface urban heat island intensity (urban − rural), two methods.", {
        "year": "study year", "season": "summer / winter",
        "method": "`urban core vs rural ring` (primary) or `built-up vs non-built-up land` (secondary)",
        "uhi_intensity_c": "urban mean − rural mean, °C (negative = urban cool island)", "urban_mean_c": "urban mean LST, °C",
        "rural_mean_c": "rural mean LST, °C", "urban_km2": "urban area, km²", "rural_km2": "rural area, km²",
        "ring_outer_km": "outer distance of the rural ring from the core, km (core-vs-ring only)",
        "ring_capped": "True if the ring hit its maximum distance before reaching the core's area"}),
    "conversion_lst_change.csv": ("LST change of pixels that became built-up vs pixels that kept their class.", {
        "period": "first year–second year", "season": "summer / winter", "group": "transition or stable class",
        "from_code": "class code in the first year", "to_code": "class code in the second year", "n_pixels": "pixels",
        "area_km2": "area, km²", "mean_lst_a_c": "mean LST in the first year, °C", "mean_lst_b_c": "mean LST in the second year, °C",
        "mean_delta_lst_c": "mean LST change, °C",
        "mean_delta_z": "mean change of normalised LST, z = (LST − study-area mean) ÷ SD, in standard deviations"}),
    "lst_correlations.csv": ("Pearson correlation of LST with NDVI and NDBI over land pixels (water excluded).", {
        "year": "study year", "season": "summer / winter", "index": "NDVI or NDBI", "r": "Pearson r over all land pixels",
        "n_pixels": "land pixels used", "slope_c_per_unit": "least-squares slope, °C per index unit", "intercept_c": "intercept, °C",
        "r_thinned": "r on the thinned grid", "p_thinned": "two-sided p-value on the thinned grid", "n_thinned": "pixels on the thinned grid",
        "thin_spacing_m": "spacing of the thinned grid, m (neighbouring 30 m pixels are not independent)"}),
    "lst_mask_impact.csv": ("Effect of the LST quality mask (ST_QA > 5 K or ST_EMIS < 0.90 dropped) on each composite.", {
        "year": "study year", "season": "summer / winter", "pixels_with_lst_before": "pixels with an LST before the mask",
        "pixels_with_lst_after": "pixels with an LST after the mask", "pixels_removed_entirely": "pixels that lost their LST",
        "pixels_changed_over_1c": "pixels whose LST changed by more than 1 °C", "pixels_over_55c_before": "pixels above 55 °C before",
        "pixels_over_55c_after": "pixels above 55 °C after", "max_land_lst_before_c": "maximum land LST before, °C",
        "max_land_lst_after_c": "maximum land LST after, °C", "p99_before_c": "99th percentile before, °C", "p99_after_c": "99th percentile after, °C",
        "uhi_core_ring_before_c": "UHI core vs ring before, °C", "uhi_core_ring_after_c": "UHI core vs ring after, °C",
        "uhi_builtup_before_c": "UHI built-up vs non-built-up before, °C", "uhi_builtup_after_c": "UHI built-up vs non-built-up after, °C"}),
    "population.csv": ("GHSL population and built-up surface summed over the study area, per epoch.", {
        "epoch": "GHSL epoch (year)", "population": "residents (GHS-POP)", "ghsl_built_km2": "GHSL built-up surface, km² (GHS-BUILT-S)",
        "source": "dataset and release", "projection_not_estimate": "True = GHSL model projection, not a census-based estimate"}),
    "population_vs_builtup.csv": ("population.csv joined with this study's built-up area for the study years.", {
        "epoch": "GHSL epoch (year)", "population": "residents (GHS-POP)", "ghsl_built_km2": "GHSL built-up surface, km²",
        "source": "dataset and release", "projection_not_estimate": "True = GHSL model projection",
        "builtup_km2_this_study": "built-up area in this study's map, km² (empty for non-study years)",
        "builtup_percent_this_study": "built-up share of the classified area in this study's map, %"}),
}


def documented(file: str, col: str) -> bool:
    cols = DOCS[file][1]
    if col in cols:
        return True
    if file.startswith(("transition_", "confusion_")):
        return True   # the class columns of a matrix, described by its first column
    return any(k.endswith("<class>") and col.startswith(k[:-7]) for k in cols)


def build_zip(cfg, doc: dict, dest: Path) -> int:
    heat = bool(doc.get("lst_enabled", True))
    tables = sorted(p for p in (OUT / "tables").glob("*.csv") if heat or p.name not in LST_TABLES)
    missing = [p.name for p in tables if p.name not in DOCS]
    undocumented = [f"{p.name}: {c}" for p in tables if p.name in DOCS for c in pd.read_csv(p, nrows=0).columns if not documented(p.name, c)]
    if missing or undocumented:
        raise SystemExit(f"README is missing tables {missing} or columns {undocumented}")
    rep, st = cfg.raw["report"], doc["study"]
    lines = [f"# {st['name']} — data tables", "",
             f"{rep['status']}. TerraTrace {'LULC + urban heat island' if heat else 'land use / land cover'} case study, {st['years'][0]}–{st['years'][-1]}; "
             f"{rep['author']}. Analysis pipeline v{doc['pipeline_version']}; tables generated {doc['generated_utc'][:10]}.", "",
             "Every result in the PDF report and on the case-study web page comes from these tables; contextual figures from other "
             "sources are cited there. `results_summary.md` is the "
             "pipeline's own summary of them (written by the pipeline, not by hand).", "",
             COMMON.format(
                 temperature=("- Temperatures are land surface temperature (LST) in °C from the Landsat thermal band (surface temperature "
                              "× 0.00341802 + 149 K − 273.15),\n  per-pixel median of clear observations at the ~10:30 local overpass.\n") if heat else "",
                 winter_role="secondary" if heat else "the composite of the withdrawn surface-temperature analysis; not used by the land-cover maps"),
             "## Files", ""]
    for p in tables:
        desc, cols = DOCS[p.name]
        lines += [f"### tables/{p.name}", "", desc, "", "| Column | Meaning and unit |", "|---|---|"]
        lines += [f"| `{c}` | {m} |" for c, m in cols.items()] + [""]
    readme = "\n".join(lines)
    folder = dest.stem
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr(f"{folder}/README.md", readme)
        z.write(OUT / "results_summary.md", f"{folder}/results_summary.md")
        for p in tables:
            z.write(p, f"{folder}/tables/{p.name}")
    return len(tables) + 2


def main() -> None:
    cfg = config_mod.load()
    rep = cfg.raw["report"]
    doc = json.loads((DEST / "case-study.json").read_text(encoding="utf-8"))
    summary_md = (OUT / "results_summary.md").read_text(encoding="utf-8")
    check_inputs(doc, summary_md)
    fonts()
    pdf_path, zip_path = DEST / rep["pdf_file"], DEST / rep["data_file"]
    pages = build_pdf(cfg, doc, summary_md, pdf_path)
    n_files = build_zip(cfg, doc, zip_path)
    downloads = {
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"), "pipeline_version": __version__,
        "pdf": {"file": pdf_path.name, "bytes": pdf_path.stat().st_size, "pages": pages, "title": f"{rep['title']}, {doc['study']['years'][0]}–{doc['study']['years'][-1]}"},
        "data": {"file": zip_path.name, "bytes": zip_path.stat().st_size, "files": n_files},
    }
    (DEST / "downloads.json").write_text(json.dumps(downloads, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"PDF: {pdf_path.relative_to(ROOT.parent).as_posix()} — {pages} pages, {pdf_path.stat().st_size / 1e6:.2f} MB")
    print(f"ZIP: {zip_path.relative_to(ROOT.parent).as_posix()} — {n_files} files, {zip_path.stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
