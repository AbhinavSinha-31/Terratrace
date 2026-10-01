"""TERRATRACE API contracts (Pydantic).

Analysis responses are envelopes (see services/analysis.py): `dataMode` is always
"LIVE" and `analysisStatus` says whether measurements exist. Scientific payloads
(`summary`, `events`, `layers`) are present only when `analysisStatus == "READY"`.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# READY = computed AND scientifically valid; INVALID_ANALYSIS = computed but failed validity checks.
AnalysisStatus = Literal["READY", "UNAVAILABLE", "INVALID_ANALYSIS", "PROCESSING", "ERROR"]


class PeriodSpec(BaseModel):
    """A composite period. Months are 1-12 and inclusive; default is the full year."""

    year: int = Field(..., ge=1984, le=2100)
    months: tuple[int, int] | None = None

    @field_validator("months")
    @classmethod
    def _months(cls, v: tuple[int, int] | None) -> tuple[int, int] | None:
        if v is not None and not (1 <= v[0] <= 12 and 1 <= v[1] <= 12):
            raise ValueError("months must be within 1..12")
        return v


class AnalyzeRequest(BaseModel):
    geometry: dict[str, Any] = Field(..., description="GeoJSON Polygon or MultiPolygon, [longitude, latitude] (EPSG:4326)")
    baseline_period: PeriodSpec = PeriodSpec(year=2018)
    comparison_period: PeriodSpec = PeriodSpec(year=2025)
    name: str | None = Field(None, max_length=120)

    @field_validator("comparison_period")
    @classmethod
    def _order(cls, v: PeriodSpec, info: Any) -> PeriodSpec:
        base = info.data.get("baseline_period")
        if base is not None and v.year <= base.year:
            raise ValueError("comparison_period must be after baseline_period")
        return v


class AnalysisEnvelope(BaseModel):
    model_config = ConfigDict(extra="allow")
    analysis_id: str
    dataMode: Literal["LIVE"] = "LIVE"
    analysisStatus: AnalysisStatus
    reason: str | None = None
    reasonCode: str | None = None
    aoi: dict[str, Any]
    window: dict[str, int]
    source: dict[str, bool]
    summary: dict[str, Any] | None = None
    events: dict[str, Any] | None = None
    layers: dict[str, Any] | None = None


class AoiPreviewRequest(BaseModel):
    geometry: dict[str, Any]


class AnalysisJobRequest(BaseModel):
    """Start an analysis job for a registered area (`aoi_id`) or a new area (`geometry`, registered first)."""
    aoi_id: str | None = Field(None, max_length=80)
    geometry: dict[str, Any] | None = None
    name: str | None = Field(None, max_length=120)
    baseline: int = Field(2018, ge=1984, le=2100)
    comparison: int = Field(2025, ge=1984, le=2100)


class AoiRegisterRequest(BaseModel):
    geometry: dict[str, Any]
    name: str | None = Field(None, max_length=120)


class AoiPreview(BaseModel):
    valid: bool
    message: str | None = None
    code: str | None = None
    area_km2: float | None = None
    area_ha: float | None = None
    centroid: tuple[float, float] | None = None
    bbox: tuple[float, float, float, float] | None = None
    forest_cover_pct: float | None = None
    forest_source: str | None = None


class ExplainRequest(BaseModel):
    facts: dict[str, Any] = Field(..., description="ExplanationFacts built from a READY live analysis")


class Explanation(BaseModel):
    text: str
    source: Literal["llm", "template", "none"]
    model: str | None = None
    fact_check: dict[str, Any] | None = None
    facts_used: int
    generated_at: str
    cached: bool = False
    notice: str | None = None
    prompt_version: str | None = None


class SearchResult(BaseModel):
    name: str
    detail: str | None = None
    kind: Literal["featured", "place", "forest", "coordinates"]
    center: tuple[float, float]
    bbox: tuple[float, float, float, float] | None = None
    study_area_id: str | None = None
    source: str


class ProviderStatus(BaseModel):
    status: Literal["ready", "unconfigured", "error", "offline"]
    detail: str | None = None


class Health(BaseModel):
    status: Literal["operational", "degraded"]
    version: str
    engine: str = "TERRATRACE ENGINE"
    dataMode: Literal["LIVE"] = "LIVE"
    analysis: ProviderStatus
    explainer: ProviderStatus
    explainer_model: str | None = None
    geocoder: ProviderStatus
    limits: dict[str, float]
