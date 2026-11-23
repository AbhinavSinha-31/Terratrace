"""Publication charts from the CSV tables (and, for the scatter plots, the rasters).

No chart uses two y-axes: population and built-up area are shown as one scatter (population on x, built-up km² on y),
so neither scale can be stretched to suggest a relationship.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pandas as pd
from matplotlib import pyplot as plt

from . import figstyle
from .config import Config
from .stats import WATER, load_year

log = logging.getLogger("analysis.charts")


def builtup_trend(cfg: Config, tables: Path, out: Path) -> None:
    a = pd.read_csv(tables / "class_areas.csv")
    b = a[a.class_code == 1].sort_values("year")
    fig, ax = plt.subplots(figsize=(4.6, 3.2))
    color = next(c.color for c in cfg.classes if c.code == 1)
    ax.plot(b.year, b.percent_of_classified, color=color, marker="o", lw=1.6)
    for r in b.itertuples():
        ax.annotate(f"{r.percent_of_classified:.1f} %\n({r.area_km2:.0f} km²)", (r.year, r.percent_of_classified),
                    textcoords="offset points", xytext=(0, 8), ha="center", fontsize=7.5, color=figstyle.INK)
    ax.set_xticks(b.year)
    ax.set_ylim(0, max(b.percent_of_classified) * 1.35)
    ax.set_ylabel("Built-up (% of classified area)")
    ax.set_title("Built-up area by year")
    fig.savefig(out / "builtup_percent_by_year.png")
    plt.close(fig)


def class_composition(cfg: Config, tables: Path, out: Path) -> None:
    a = pd.read_csv(tables / "class_areas.csv")
    a = a[a.class_code > 0]
    years = sorted(a.year.unique())
    fig, ax = plt.subplots(figsize=(5.2, 1.1 + 0.55 * len(years)))
    for i, y in enumerate(years):
        left = 0.0
        for c in cfg.classes:
            v = float(a[(a.year == y) & (a.class_code == c.code)].percent_of_classified.iloc[0])
            ax.barh(i, v, left=left, color=c.color, edgecolor="white", linewidth=1.0, height=0.6)
            if v >= 6:
                ax.text(left + v / 2, i, f"{v:.0f} %", ha="center", va="center", fontsize=7,
                        color="white" if c.code in (1, 2, 4) else figstyle.INK)
            left += v
    ax.set_yticks(range(len(years)), [str(y) for y in years])
    ax.set_xlim(0, 100)
    ax.set_xlabel("% of classified area")
    ax.grid(axis="y", visible=False)
    ax.legend(handles=[plt.Rectangle((0, 0), 1, 1, color=c.color) for c in cfg.classes], labels=[c.name for c in cfg.classes],
              loc="upper center", bbox_to_anchor=(0.5, -0.35 if len(years) < 3 else -0.25), ncol=3, fontsize=7)
    ax.set_title("Land use / land cover composition")
    fig.savefig(out / "lulc_composition.png")
    plt.close(fig)


def lst_by_class(cfg: Config, tables: Path, out: Path) -> None:
    """Mean LST per class per year — one panel per season (small multiples, separate y-scales are labelled)."""
    t = pd.read_csv(tables / "lst_per_class.csv")
    fig, axes = plt.subplots(1, 2, figsize=(8.2, 3.4))
    for ax, s in zip(axes, ("summer", "winter")):
        d = t[t.season == s]
        years = sorted(d.year.unique())
        for c in cfg.classes:
            dc = d[d.class_code == c.code].sort_values("year")
            ax.plot(dc.year, dc.mean_c, color=c.color, marker="o", lw=1.6, label=c.name)
            last = dc.dropna(subset=["mean_c"]).tail(1)
            if len(last):
                ax.annotate(f"{last.mean_c.iloc[0]:.1f}", (last.year.iloc[0], last.mean_c.iloc[0]), textcoords="offset points",
                            xytext=(6, 0), va="center", fontsize=7, color=figstyle.INK)
        ax.set_xticks(years, [composite_tick(cfg, s, y) for y in years])
        ax.set_xlim(min(years) - 1, max(years) + 3)
        ax.set_title(figstyle.SEASON_LABEL[s], fontsize=9.5)
        ax.set_ylabel("Mean land surface temperature (°C)")
    axes[0].legend(loc="upper center", bbox_to_anchor=(1.1, -0.15), ncol=5, fontsize=7)
    fig.suptitle("Land surface temperature by land-cover class", fontweight="bold", fontsize=11)
    figstyle.source_note(fig, "Absolute temperatures differ between years partly because of the weather of that season; "
                              "compare classes within a year, or use the UHI intensity and the conversion analysis across years.", y=-0.1)
    fig.savefig(out / "lst_by_class_and_year.png")
    plt.close(fig)


def composite_tick(cfg: Config, season: str, year: int) -> str:
    """Axis label of one composite: '2015' for April–June, '2014–15' for the winter that ends in 2015."""
    label = cfg.season_label(season, int(year))
    return label.replace("winter ", "") if label.startswith("winter") else str(year)


def uhi_trend(cfg: Config, tables: Path, out: Path) -> None:
    u = pd.read_csv(tables / "uhi_intensity.csv")
    fig, axes = plt.subplots(1, 2, figsize=(8.2, 3.2), sharey=True)
    for ax, s in zip(axes, ("summer", "winter")):
        d = u[u.season == s]
        for i, (m, dm) in enumerate(d.groupby("method", sort=False)):
            dm = dm.sort_values("year")
            ax.plot(dm.year, dm.uhi_intensity_c, color=figstyle.SERIES[i], marker="o", lw=1.6, label=m)
            for r in dm.itertuples():
                ax.annotate(f"{r.uhi_intensity_c:+.2f}", (r.year, r.uhi_intensity_c), textcoords="offset points",
                            xytext=(0, 7 if i == 0 else -12), ha="center", fontsize=7, color=figstyle.INK)
        ax.axhline(0, color=figstyle.INK_2, lw=0.8)
        ax.set_xticks(sorted(d.year.unique()), [composite_tick(cfg, s, y) for y in sorted(d.year.unique())])
        ax.set_title(figstyle.SEASON_LABEL[s], fontsize=9.5)
    axes[0].set_ylabel("UHI intensity (°C, urban − rural)")
    axes[0].legend(loc="upper center", bbox_to_anchor=(1.05, -0.15), ncol=2, fontsize=7.5)
    fig.suptitle("Surface urban heat island intensity", fontweight="bold", fontsize=11)
    figstyle.source_note(fig, "Below zero = the urban area is cooler than its surroundings at the Landsat overpass (~10:30 local time).", y=-0.1)
    fig.savefig(out / "uhi_intensity_by_year.png")
    plt.close(fig)


def population_vs_builtup(cfg: Config, tables: Path, out: Path) -> None:
    p = tables / "population_vs_builtup.csv"
    if not p.exists():
        return
    d = pd.read_csv(p)
    fig, ax = plt.subplots(figsize=(4.8, 3.6))
    ax.plot(d.population / 1e6, d.ghsl_built_km2, color=figstyle.SERIES[0], marker="o", lw=1.4, label="GHSL built-up surface")
    s = d.dropna(subset=["builtup_km2_this_study"])
    ax.plot(s.population / 1e6, s.builtup_km2_this_study, color=figstyle.SERIES[1], marker="s", lw=1.4, ls="--",
            label="Built-up class, this study (Landsat RF)")
    for r in d.itertuples():
        tag = f"{r.epoch}{'*' if r.projection_not_estimate else ''}"
        ax.annotate(tag, (r.population / 1e6, r.ghsl_built_km2), textcoords="offset points", xytext=(-4, 6), ha="right", fontsize=7)
    ax.set_xlabel("Population, GHSL (millions)")
    ax.set_ylabel("Built-up area (km²)")
    ax.legend(loc="upper left", fontsize=7)
    ax.set_title("Population vs built-up area")
    figstyle.source_note(fig, "GHSL GHS-POP / GHS-BUILT-S P2023A, summed over the study area. * = GHSL projection, not an estimate. "
                              "GHSL counts built surface inside each 100 m cell; this study counts 30 m pixels classified built-up.")
    fig.savefig(out / "population_vs_builtup.png")
    plt.close(fig)


def scatter(cfg: Config, cache: Path, tables: Path, out: Path, years: list[int], season: str) -> None:
    """NDVI–LST and NDBI–LST density scatter, one panel per year, with OLS line and Pearson r."""
    aoi = np.load(cache / "aoi_mask.npy").astype(bool)
    cor = pd.read_csv(tables / "lst_correlations.csv")
    fig, axes = plt.subplots(2, len(years), figsize=(3.3 * len(years), 6.4), squeeze=False)
    for j, y in enumerate(years):
        d = load_year(cache, y)
        lst = d[f"lst_{season}"]
        land = aoi & (d["lulc"] > 0) & (d["lulc"] != WATER) & np.isfinite(lst)
        for i, idx in enumerate(("ndvi", "ndbi")):
            ax = axes[i, j]
            x = d[f"{idx}_{season}"]
            m = land & np.isfinite(x)
            ax.hexbin(x[m], lst[m], gridsize=70, bins="log", mincnt=1, cmap="Blues", linewidths=0)
            r = cor[(cor.year == y) & (cor.season == season) & (cor["index"] == idx.upper())].iloc[0]
            xs = np.linspace(np.nanpercentile(x[m], 0.5), np.nanpercentile(x[m], 99.5), 50)
            ax.plot(xs, r.slope_c_per_unit * xs + r.intercept_c, color=figstyle.SERIES[1], lw=1.6)
            ax.text(0.03, 0.96, f"r = {r.r:+.2f}\nslope {r.slope_c_per_unit:+.1f} °C/unit\nn = {r.n_pixels:,}",
                    transform=ax.transAxes, va="top", fontsize=7, color=figstyle.INK,
                    bbox=dict(facecolor="white", edgecolor="none", alpha=0.8, pad=1.5))
            ax.set_xlabel(idx.upper())
            if j == 0:
                ax.set_ylabel("LST (°C)")
            if i == 0:
                ax.set_title(cfg.season_label(season, y).capitalize() if season == "winter" else cfg.season_label(season, y), fontsize=10)
    fig.suptitle(f"LST vs NDVI and NDBI — {figstyle.SEASON_LABEL[season]}", fontweight="bold", fontsize=11)
    figstyle.source_note(fig, "Density of 30 m land pixels (water excluded; darker = more pixels, log scale). Line: least squares. "
                              "r over all pixels; see lst_correlations.csv for p-values on a thinned grid.")
    fig.tight_layout()
    fig.savefig(out / f"scatter_lst_indices_{season}.png")
    plt.close(fig)


def conversion_chart(cfg: Config, tables: Path, out: Path) -> None:
    p = tables / "conversion_lst_change.csv"
    if not p.exists():
        return
    c = pd.read_csv(p)
    for period, dp in c.groupby("period"):
        fig, axes = plt.subplots(1, 2, figsize=(8.4, 3.4), sharey=True)
        for ax, s in zip(axes, ("summer", "winter")):
            d = dp[(dp.season == s) & (dp.n_pixels > 0)].iloc[::-1]
            ax.barh(d.group, d.mean_delta_z, color=figstyle.SEASON_COLOR[s], height=0.6)
            ax.axvline(0, color=figstyle.INK_2, lw=0.8)
            for k, r in enumerate(d.itertuples()):
                ax.text(r.mean_delta_z, k, f" {r.mean_delta_z:+.2f} ({r.area_km2:.0f} km²) ", va="center",
                        ha="left" if r.mean_delta_z >= 0 else "right", fontsize=6.8, color=figstyle.INK)
            pa, pb = (int(v) for v in period.split("-"))
            title = f"{cfg.season_label(s, pa)} → {cfg.season_label(s, pb)}"
            ax.set_title(title[0].upper() + title[1:], fontsize=9.5)
            ax.set_xlabel("Change in normalised LST (z-score)")
            ax.grid(axis="y", visible=False)
            lim = max(0.3, float(np.nanmax(np.abs(d.mean_delta_z))) * 1.6)
            ax.set_xlim(-lim, lim)
        fig.suptitle(f"Did land that became built-up warm relative to the rest? ({period.replace('-', ' → ')})", fontweight="bold", fontsize=10.5)
        figstyle.source_note(fig, "z-score = (LST − study-area mean) / SD for that season and year, so a hotter or cooler year as a whole "
                                  "does not count as warming. Positive = the group became warmer relative to the study area.")
        fig.savefig(out / f"conversion_lst_change_{period}.png")
        plt.close(fig)


def run(cfg: Config, cache: Path, tables: Path, out: Path, years: list[int]) -> None:
    figstyle.apply()
    out.mkdir(parents=True, exist_ok=True)
    years = [y for y in years if (cache / str(y) / "meta.json").exists()]
    builtup_trend(cfg, tables, out)
    class_composition(cfg, tables, out)
    population_vs_builtup(cfg, tables, out)
    # LST / UHI charts only while config.toml [lst] enabled = true (existing ones in `out` are left as they are).
    if cfg.lst_enabled:
        lst_by_class(cfg, tables, out)
        uhi_trend(cfg, tables, out)
        for s in ("summer", "winter"):
            scatter(cfg, cache, tables, out, years, s)
        conversion_chart(cfg, tables, out)
    log.info("charts: written to %s", out)
