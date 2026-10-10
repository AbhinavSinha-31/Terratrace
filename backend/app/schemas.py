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


class ContextSource(BaseModel):
    """Dataset behind a reference-context value: name, catalogue ID and the year(s) the value describes."""
    model_config = ConfigDict(extra="allow")
    dataset: str
    id: str
    year: str | None = None
    year_label: str | None = None
    resolution_m: int | None = None
    note: str | None = None


class TerrainContext(BaseModel):
    model_config = ConfigDict(extra="allow")
    status: Literal["READY", "UNAVAILABLE"]
    reason: str | None = None
    source: ContextSource
    elevation_m: dict[str, float | None] | None = None      # min, p5, mean, p95, max
    slope_mean_deg: float | None = None
    steep_share_pct: float | None = None
    steep_threshold_deg: float
    dem_coverage_pct: float | None = None


class ForestCoverValue(BaseModel):
    """One dated reference value (Hansen year-2000 baseline, loss per year 2001–2025, gain 2000–2012, WorldCover 2021)."""
    model_config = ConfigDict(extra="allow")
    status: Literal["READY", "UNAVAILABLE"]
    reason: str | None = None
    source: ContextSource


class ForestCoverContext(BaseModel):
    tree_cover_2000: ForestCoverValue
    loss_by_year: ForestCoverValue
    gain_2000_2012: ForestCoverValue
    worldcover_2021: ForestCoverValue


class ContextLayer(BaseModel):
    id: str
    label: str
    dataset: str
    year_label: str
    reference: Literal[True] = True
    tiles: list[str]


class AreaContext(BaseModel):
    """Terrain and forest cover from REFERENCE datasets (services/context.py) — never a TerraTrace result."""
    model_config = ConfigDict(extra="allow")
    status: Literal["READY", "UNAVAILABLE"]
    reason: str | None = None
    label: str
    context_version: str
    computed_at: str | None = None
    area_ha: float | None = None
    terrain: TerrainContext | None = None
    forest: ForestCoverContext | None = None
    layers: list[ContextLayer] | None = None


class Caution(BaseModel):
    """A statement ('no forest to monitor') or reliability caution for a READY result; names the datasets + years."""
    model_config = ConfigDict(extra="allow")
    code: Literal["no_forest_to_monitor", "little_forest", "datasets_disagree"]
    kind: Literal["statement", "caution"]
    message: str
    datasets: list[str]
    applies_to: list[str] | None = None
    gain_note: str | None = None


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
    # Reference context of the area (cached; null until measured). Present whatever the analysis status.
    context: AreaContext | None = None
    cautions: list[Caution] = []


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
    chat: ProviderStatus | None = None


# ----------------------------------------------------------------------------- AI chat (POST /api/chat)
class ChatTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    text: str = Field(..., min_length=1, max_length=1000)


class ChatRequest(BaseModel):
    """The conversation so far (untrusted; capped), optionally with the area and window the user is looking at."""
    model_config = ConfigDict(extra="forbid")
    messages: list[ChatTurn] = Field(..., min_length=1, max_length=8)
    aoi_id: str | None = Field(None, min_length=1, max_length=80)
    baseline: int | None = Field(None, ge=1984, le=2100)
    comparison: int | None = Field(None, ge=1984, le=2100)

    @field_validator("messages")
    @classmethod
    def _shape(cls, v: list[ChatTurn]) -> list[ChatTurn]:
        if v[-1].role != "user":
            raise ValueError("the last message must be the user's question")
        if sum(len(t.text) for t in v) > 4000:
            raise ValueError("the conversation is too long")
        return v


class ChatCitation(BaseModel):
    id: str
    label: str
    value: str | None = None
    dataset: str | None = None
    year: str | None = None
    kind: Literal["terratrace_result", "reference_context", "method", "dataset"]
    source: str | None = None


class ChatSegment(BaseModel):
    kind: Literal["general", "place", "reference"]
    text: str
    citations: list[ChatCitation] = []


class ChatResponse(BaseModel):
    status: Literal["answered", "withheld", "declined", "unavailable"]
    segments: list[ChatSegment] = []
    message: str | None = None
    reason_code: str | None = None
    error: dict[str, Any] | None = None
    notice: str
    model: str | None = None
    prompt_version: str | None = None
