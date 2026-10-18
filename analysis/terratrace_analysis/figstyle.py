"""Shared figure style (publication: 300 dpi PNG, white background, recessive axes, ink-coloured text)."""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")   # files only, no window
import matplotlib.pyplot as plt  # noqa: E402

DPI = 300
INK = "#0b0b0b"          # primary text
INK_2 = "#52514e"        # secondary text, axes
GRID = "#e4e3df"         # recessive grid
SURFACE = "#ffffff"
# Seasons: validated categorical pair (blue / orange) — CVD ΔE 24.7, normal-vision ΔE 33.6.
SEASON_COLOR = {"summer": "#eb6834", "winter": "#2a78d6"}
SEASON_LABEL = {"summer": "April–June (primary)", "winter": "November–February (secondary)"}
# Methods / series beyond seasons: first three validated slots (blue, orange, aqua).
SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]


def apply() -> None:
    plt.rcParams.update({
        "figure.dpi": 100, "savefig.dpi": DPI, "savefig.bbox": "tight", "savefig.facecolor": SURFACE,
        "font.family": "DejaVu Sans", "font.size": 9, "axes.titlesize": 11, "axes.titleweight": "bold",
        "axes.labelsize": 9, "axes.labelcolor": INK_2, "axes.edgecolor": INK_2, "axes.linewidth": 0.6,
        "xtick.color": INK_2, "ytick.color": INK_2, "xtick.labelsize": 8, "ytick.labelsize": 8,
        "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "axes.axisbelow": True,
        "axes.spines.top": False, "axes.spines.right": False, "text.color": INK,
        "legend.frameon": False, "legend.fontsize": 8, "lines.linewidth": 1.6, "lines.markersize": 6,
    })


def source_note(fig, text: str, y: float = -0.01) -> None:
    fig.text(0.01, y, text, ha="left", va="top", fontsize=6.5, color=INK_2, wrap=True)
