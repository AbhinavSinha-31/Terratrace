"""Publication maps: LULC per year, LST per year and season, LULC change, and the UHI zones (urban core / rural ring).

Every map has a title, legend or colour bar, scale bar, north arrow, study-area outline and a source line.
Coordinates are UTM zone 43N (km). Grid north differs from true north by about 1.2° here (meridian convergence).
"""

from __future__ import annotations

import json
import logging
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd
from matplotlib import colors as mcolors
from matplotlib import pyplot as plt
from matplotlib.patches import FancyArrow, Patch, Rectangle

from . import figstyle
from .config import Config
from .stats import AGRI, BUILT, VEG, WATER, load_meta, load_year
from .download import Grid

log = logging.getLogger("analysis.maps")
NO_CHANGE = "#ecebe7"
MAP_NOTE_Y = -0.075   # figure coordinates: below the legend that sits under the map


def _outline(ax, cache: Path) -> None:
    coords = json.loads((cache / "aoi_outline_utm.json").read_text(encoding="utf-8"))
    polys = coords if isinstance(coords[0][0][0], list) else [coords]   # MultiPolygon or Polygon
    for poly in polys:
        ring = np.array(poly[0])
        ax.plot(ring[:, 0], ring[:, 1], color=figstyle.INK, lw=0.7)


def _legend_below(ax, handles, title: str) -> None:
    """Legends sit under the map so they never cover any part of the study area."""
    ax.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.5, -0.075), ncol=2, title=title, title_fontsize=8,
              frameon=False, fontsize=8, columnspacing=1.6)


def _furniture(ax, grid: Grid) -> None:
    """Scale bar (10 km), north arrow, km tick labels."""
    left, right, bottom, top = grid.extent()
    w, h = right - left, top - bottom
    x, y = left + 0.05 * w, bottom + 0.04 * h
    ax.add_patch(Rectangle((x, y), 5000, 0.006 * h, facecolor=figstyle.INK, edgecolor=figstyle.INK, lw=0.5))
    ax.add_patch(Rectangle((x + 5000, y), 5000, 0.006 * h, facecolor="white", edgecolor=figstyle.INK, lw=0.5))
    for dx, t in ((0, "0"), (5000, "5"), (10000, "10 km")):
        ax.text(x + dx, y + 0.012 * h, t, ha="center", va="bottom", fontsize=7, color=figstyle.INK)
    ax_x, ax_y = right - 0.08 * w, top - 0.13 * h
    ax.add_patch(FancyArrow(ax_x, ax_y, 0, 0.07 * h, width=0.012 * w, head_width=0.04 * w, head_length=0.03 * h,
                            length_includes_head=True, color=figstyle.INK))
    ax.text(ax_x, ax_y + 0.075 * h, "N", ha="center", va="bottom", fontsize=10, fontweight="bold")
    ax.set_xlim(left, right)
    ax.set_ylim(bottom, top)
    ax.set_aspect("equal")
    ax.grid(False)
    ax.xaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v / 1000:.0f}"))
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v / 1000:.0f}"))
    ax.set_xlabel("Easting (km, UTM 43N)")
    ax.set_ylabel("Northing (km, UTM 43N)")
    for s in ax.spines.values():
        s.set_visible(True)


def _sensor(meta: dict) -> str:
    names = {"LT05": "Landsat 5 TM", "LE07": "Landsat 7 ETM+", "LC08": "Landsat 8", "LC09": "Landsat 9"}
    yrs = meta["pooled_years"]
    span = f"{yrs[0]}–{yrs[-1]}" if len(yrs) > 1 else str(yrs[0])
    return f"{' + '.join(names[s] for s in meta['sensors'])} Collection 2 Level-2, {span}"


def lulc_map(cfg: Config, cache: Path, grid: Grid, aoi: np.ndarray, year: int, areas: pd.DataFrame, out: Path) -> None:
    lulc = load_year(cache, year, lst=False)["lulc"]
    meta = load_meta(cache, year)
    cmap = mcolors.ListedColormap(["#ffffff"] + [c.color for c in cfg.classes])
    shown = np.where(aoi, lulc, 0).astype(float)
    shown[~aoi] = np.nan
    fig, ax = plt.subplots(figsize=(6.2, 9))
    ax.imshow(shown, cmap=cmap, vmin=-0.5, vmax=len(cfg.classes) + 0.5, extent=grid.extent(), interpolation="nearest")
    _outline(ax, cache)
    _furniture(ax, grid)
    a = areas[areas.year == year].set_index("class_code")
    handles = [Patch(facecolor=c.color, edgecolor=figstyle.INK_2, lw=0.3,
                     label=f"{c.name}  {a.loc[c.code, 'percent_of_classified']:.1f} %  ({a.loc[c.code, 'area_km2']:.0f} km²)") for c in cfg.classes]
    if a.loc[0, "pixels"] > 0:
        handles.append(Patch(facecolor="#ffffff", edgecolor=figstyle.INK_2, lw=0.3,
                             label=f"Not classified  {a.loc[0, 'area_km2']:.1f} km²"))
    _legend_below(ax, handles, "Land use / land cover (% of classified area)")
    ax.set_title(f"Land use / land cover, {year} — {cfg.study['short_name']}")
    figstyle.source_note(fig, y=MAP_NOTE_Y, text=f"{_sensor(meta)}; Random Forest ({cfg.rf['trees']} trees) in Google Earth Engine, 30 m. "
                              f"Agreement with reference labels {meta['accuracy']['overall_accuracy'] * 100:.1f} % "
                              f"(κ = {meta['accuracy']['kappa']:.2f}); not ground-truth accuracy.")
    fig.savefig(out / f"lulc_{year}.png")
    plt.close(fig)


def lst_map(cfg: Config, cache: Path, grid: Grid, aoi: np.ndarray, year: int, season: str, vmin: float, vmax: float, out: Path) -> None:
    lst = load_year(cache, year)[f"lst_{season}"].copy()
    meta = load_meta(cache, year)
    lst[~aoi] = np.nan
    fig, ax = plt.subplots(figsize=(6.2, 9))
    im = ax.imshow(lst, cmap="inferno", vmin=vmin, vmax=vmax, extent=grid.extent(), interpolation="nearest")
    _outline(ax, cache)
    _furniture(ax, grid)
    cb = fig.colorbar(im, ax=ax, fraction=0.035, pad=0.02, extend="both")
    cb.set_label("Land surface temperature (°C)")
    cb.outline.set_linewidth(0.4)
    label = cfg.season_label(season, year)
    ax.set_title(f"Land surface temperature, {label}" + (" (November–February)" if season == "winter" else ""))
    rng = meta["season_ranges"][season]
    figstyle.source_note(fig, y=MAP_NOTE_Y, text=f"{_sensor(meta)} surface temperature (ST band, ×0.00341802 + 149 K − 273.15), per-pixel median "
                              f"of clear observations {rng[0][0]} … {rng[-1][1]} (end exclusive); "
                              f"{meta['scenes'][season]['count']} scenes. Colour range shared by all years of this season.")
    fig.savefig(out / f"lst_{season}_{year}.png")
    plt.close(fig)


CHANGE_CLASSES = [   # (label, colour) — three validated categorical hues for the story, neutrals for the rest
    ("New built-up from cropland", "#eb6834"),
    ("New built-up from vegetation", "#1baf7a"),
    ("New built-up from water", "#2a78d6"),
    ("Built-up in both years", "#3a3936"),
    ("Other change", "#b5b3ad"),
    ("No change (not built-up)", NO_CHANGE),
]


def change_codes(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Per-pixel change category (1–6 in CHANGE_CLASSES order; 0 = not classified in one of the years)."""
    out = np.zeros(a.shape, np.uint8)
    both = (a > 0) & (b > 0)
    new = both & (a != BUILT) & (b == BUILT)
    out[new & (a == AGRI)] = 1
    out[new & (a == VEG)] = 2
    out[new & (a == WATER)] = 3
    out[both & (a == BUILT) & (b == BUILT)] = 4
    out[both & (a != b) & (out == 0)] = 5
    out[both & (a == b) & (out == 0)] = 6
    return out


def change_map(cfg: Config, cache: Path, grid: Grid, aoi: np.ndarray, a: int, b: int, out: Path) -> None:
    la, lb = load_year(cache, a, lst=False)["lulc"], load_year(cache, b, lst=False)["lulc"]
    codes = change_codes(la, lb).astype(float)
    codes[~aoi] = np.nan
    cmap = mcolors.ListedColormap(["#ffffff"] + [c for _, c in CHANGE_CLASSES])
    fig, ax = plt.subplots(figsize=(6.2, 9))
    ax.imshow(codes, cmap=cmap, vmin=-0.5, vmax=len(CHANGE_CLASSES) + 0.5, extent=grid.extent(), interpolation="nearest")
    _outline(ax, cache)
    _furniture(ax, grid)
    inside = codes[aoi]
    handles = [Patch(facecolor=c, edgecolor=figstyle.INK_2, lw=0.3,
                     label=f"{name}  {(inside == i).sum() * cfg.scale**2 / 1e6:.1f} km²") for i, (name, c) in enumerate(CHANGE_CLASSES, 1)]
    _legend_below(ax, handles, f"Change {a} → {b}")
    ax.set_title(f"Land-cover change {a} → {b} — {cfg.study['short_name']}")
    figstyle.source_note(fig, y=MAP_NOTE_Y, text="Pixel-by-pixel comparison of the two Random Forest LULC maps (same 30 m grid). "
                              "Per-map classification errors add up in a change map; read small patches with caution.")
    fig.savefig(out / f"change_{a}_{b}.png")
    plt.close(fig)


def uhi_zone_map(cfg: Config, cache: Path, grid: Grid, aoi: np.ndarray, year: int, out: Path) -> None:
    """Methods figure: where the urban core and the summer rural ring are (Method A)."""
    from .stats import rural_ring
    d = load_year(cache, year)
    core = np.load(cache / str(year) / "urban_core.npy")
    lulc, lst = d["lulc"], d["lst_summer"]
    land = aoi & (lulc > 0) & (lulc != WATER) & np.isfinite(lst)
    ring, outer, capped = rural_ring(cfg, core, lulc, lst, aoi, int((core & land).sum()))
    z = np.full(aoi.shape, np.nan)
    z[aoi] = 0
    z[ring] = 1
    z[core & aoi] = 2
    cmap = mcolors.ListedColormap([NO_CHANGE, SERIES_RING, SERIES_CORE])
    fig, ax = plt.subplots(figsize=(6.2, 9))
    ax.imshow(z, cmap=cmap, vmin=-0.5, vmax=2.5, extent=grid.extent(), interpolation="nearest")
    _outline(ax, cache)
    _furniture(ax, grid)
    _legend_below(ax, [Patch(facecolor=SERIES_CORE, label=f"Urban core  {(core & land).sum() * cfg.scale**2 / 1e6:.0f} km²"),
                       Patch(facecolor=SERIES_RING, label=f"Rural ring (to {outer:.1f} km)  {ring.sum() * cfg.scale**2 / 1e6:.0f} km²"),
                       Patch(facecolor=NO_CHANGE, label="Rest of study area")], "UHI method A zones")
    ax.set_title(f"UHI zones (urban core vs rural ring), {year}")
    figstyle.source_note(fig, y=MAP_NOTE_Y, text=f"Core: built-up fraction ≥ {cfg.uhi['core_threshold']:.0%} within {cfg.uhi['core_radius_m']} m, patches ≥ "
                              f"{cfg.uhi['core_min_km2']} km². Ring: nearest non-built-up, non-water land of equal area inside the study area"
                              f"{' (capped at ' + str(cfg.uhi['ring_max_km']) + ' km)' if capped else ''}. The ring uses pixels with a valid April–June LST.")
    fig.savefig(out / f"uhi_zones_{year}.png")
    plt.close(fig)


SERIES_CORE, SERIES_RING = figstyle.SERIES[1], figstyle.SERIES[0]


def lst_range(cache: Path, aoi: np.ndarray, years: list[int], season: str) -> tuple[float, float]:
    """Colour range of one season's LST maps, shared by all years: the 2nd–98th percentile of every study-area pixel."""
    vals = np.concatenate([load_year(cache, y)[f"lst_{season}"][aoi] for y in years])
    vals = vals[np.isfinite(vals)]
    vmin, vmax = np.percentile(vals, [2, 98])
    return float(vmin), float(vmax)


def run(cfg: Config, cache: Path, tables: Path, out: Path, years: list[int]) -> None:
    figstyle.apply()
    out.mkdir(parents=True, exist_ok=True)
    grid = Grid.load(cache / "grid.json")
    aoi = np.load(cache / "aoi_mask.npy").astype(bool)
    years = [y for y in years if (cache / str(y) / "meta.json").exists()]
    areas = pd.read_csv(tables / "class_areas.csv")
    for y in years:
        lulc_map(cfg, cache, grid, aoi, y, areas, out)
        if cfg.lst_enabled:
            uhi_zone_map(cfg, cache, grid, aoi, y, out)
    # LST maps only while config.toml [lst] enabled = true (existing LST maps in `out` are left as they are).
    for season in ("summer", "winter") if cfg.lst_enabled else ():
        vmin, vmax = lst_range(cache, aoi, years, season)
        for y in years:
            lst_map(cfg, cache, grid, aoi, y, season, vmin, vmax, out)
    for a, b in combinations(years, 2):
        change_map(cfg, cache, grid, aoi, a, b, out)
    log.info("maps: written to %s", out)
