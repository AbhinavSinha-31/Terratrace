"""Read config.toml into small typed objects, so every methodological choice is in one file you can cite."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]   # the analysis/ folder


@dataclass(frozen=True)
class YearSpec:
    """One study year: which Landsat sensors to use and how many years either side to pool."""
    year: int
    sensors: tuple[str, ...]
    window: int = 0
    note: str = ""

    @property
    def years(self) -> list[int]:
        """Calendar years pooled into this study year's composites (e.g. 2005 with window 1 → 2004, 2005, 2006)."""
        return list(range(self.year - self.window, self.year + self.window + 1))


@dataclass(frozen=True)
class LulcClass:
    code: int
    name: str
    color: str


@dataclass(frozen=True)
class Config:
    path: Path
    raw: dict[str, Any] = field(repr=False)

    # ------------------------------------------------------------------ study area
    @property
    def study(self) -> dict[str, Any]:
        return self.raw["study_area"]

    @property
    def boundary_path(self) -> Path:
        return ROOT / self.study["boundary_file"]

    @property
    def crs(self) -> str:
        return self.study["crs"]

    @property
    def scale(self) -> int:
        return int(self.study["scale_m"])

    # ------------------------------------------------------------------ years / seasons
    @property
    def years(self) -> list[YearSpec]:
        return [YearSpec(int(y["year"]), tuple(y["sensors"]), int(y.get("window", 0)), y.get("note", "")) for y in self.raw["years"]]

    def year(self, year: int) -> YearSpec:
        for spec in self.years:
            if spec.year == year:
                return spec
        raise KeyError(f"year {year} is not configured in {self.path.name}")

    @property
    def seasons(self) -> dict[str, dict[str, Any]]:
        return self.raw["seasons"]

    @property
    def max_cloud_cover(self) -> float:
        return float(self.raw["scenes"]["max_cloud_cover"])

    @property
    def max_st_uncertainty_k(self) -> float:
        return float(self.raw["scenes"]["max_st_uncertainty_k"])

    @property
    def min_st_emissivity(self) -> float:
        return float(self.raw["scenes"]["min_st_emissivity"])

    # ------------------------------------------------------------------ classes
    @property
    def classes(self) -> list[LulcClass]:
        return [LulcClass(int(c["code"]), c["name"], c["color"]) for c in self.raw["classes"]]

    @property
    def class_codes(self) -> list[int]:
        return [c.code for c in self.classes]

    def class_name(self, code: int) -> str:
        return {c.code: c.name for c in self.classes}[code]

    def code_of(self, name: str) -> int:
        return {c.name: c.code for c in self.classes}[name]

    # ------------------------------------------------------------------ method sections
    @property
    def labels(self) -> dict[str, Any]:
        return self.raw["labels"]

    @property
    def rf(self) -> dict[str, Any]:
        return self.raw["random_forest"]

    @property
    def uhi(self) -> dict[str, Any]:
        return self.raw["uhi"]

    @property
    def population(self) -> dict[str, Any]:
        return self.raw["population"]

    @property
    def validation(self) -> dict[str, Any]:
        return self.raw["validation"]

    @property
    def checks(self) -> dict[str, Any]:
        return self.raw["checks"]


def class_mapping(table: dict[str, list[int]]) -> dict[int, list[int]]:
    """TOML keys are strings: {'1': [190]} → {1: [190]}."""
    return {int(k): [int(v) for v in vals] for k, vals in table.items()}


def load(path: Path | str | None = None) -> Config:
    p = Path(path) if path else ROOT / "config.toml"
    with open(p, "rb") as f:
        return Config(p, tomllib.load(f))
