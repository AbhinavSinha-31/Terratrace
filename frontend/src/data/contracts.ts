/**
 * TERRATRACE data contracts (schema 2.0).
 *
 * The boundary between the UI and the scientific pipeline. Scientific results
 * come from exactly one source — the backend's Google Earth Engine pipeline —
 * wrapped in an AnalysisEnvelope. Metrics exist ONLY when analysisStatus is
 * READY; there is no simulated or demonstration data anywhere. Mirrored in
 * backend/app/schemas.py.
 */
import type { Polygon, MultiPolygon } from 'geojson';

/** READY = computed AND scientifically valid. INVALID_ANALYSIS = computed but failed validity checks. */
export type AnalysisStatus = 'READY' | 'UNAVAILABLE' | 'INVALID_ANALYSIS' | 'PROCESSING' | 'ERROR';
export type Severity = 'low' | 'moderate' | 'high' | 'critical';
export type ChangeType = 'clearing' | 'fire' | 'degradation' | 'unknown';
export type ConfidenceClass = 'high' | 'medium' | 'low';
export type ImageryStatus = 'good' | 'cloud_limited' | 'insufficient';
export type ChangeLevel = 'low' | 'moderate' | 'high';
export type LandCover =
  | 'water' | 'trees' | 'grass' | 'flooded_vegetation' | 'crops'
  | 'shrub_and_scrub' | 'built' | 'bare' | 'snow_and_ice';
export type AoiGeometry = Polygon | MultiPolygon;

export const SEVERITIES: Severity[] = ['low', 'moderate', 'high', 'critical'];

export interface Provenance {
  dataMode: 'LIVE';
  pipeline_version: string;
  generated_at: string;
  sources: { name: string; role: string; real: boolean }[];
  note?: string;
}


/** An area of interest: geometry + descriptive metadata only. Never carries results. */
export interface StudyArea {
  id: string;
  code?: string;
  name: string;
  short_name: string;
  region: string;
  country: string | null;
  biome: string | null;
  description: string;
  tags: string[];
  bbox: [number, number, number, number];
  center: [number, number];
  geometry: AoiGeometry;
  /** Geodesic area of the geometry (measured, not a result). */
  area_ha: number;
  area_km2: number;
  thumbnail_url: string;
  featured?: boolean;
  custom?: boolean;
  /** Featured only: the standard window moved inward to MEASURED analysable years (absent offline). */
  default_window?: [number, number];
}

/** Headline figures of a stored READY result (GET /api/featured/summary) — the result's own values. */
export interface StoredKpis {
  event_area_ha: number;
  event_count: number;
  baseline_year: number | null;
  latest_year: number | null;
  gross_loss_ha: number | null;
  gross_gain_ha: number | null;
  net_change_ha: number | null;
}

/** Stored outcome of one featured investigation for its default window. Read-only; never runs an analysis. */
export interface FeaturedSummaryItem {
  id: string;
  default_window: [number, number];
  status: 'READY' | 'INVALID_ANALYSIS' | 'UNAVAILABLE' | 'RUNNING' | 'NOT_RUN' | string;
  reasonCode: string | null;
  reason: string | null;
  issueYears?: number[][];
  selected_area_km2?: number;
  maximum_area_km2?: number;
  kpis?: StoredKpis;
}

export interface StudyAreaIndex {
  schema_version: string;
  items: StudyArea[];
}

/**
 * One composite year. Every statistic is null unless it was measured: years that fail the
 * observation-quality rule carry no forest/loss/gain values (null is never 0).
 */
export interface YearStat {
  year: number;
  era: 'historical' | 'modern';
  /** The analysable year this one is compared with (same era); a gap means years were skipped. */
  previous_year: number | null;
  passes_quality: boolean;
  quality_reason: string | null;
  scenes: Record<string, number | null>;
  valid_ha: number | null;
  /** % of the AOI with enough clear observations (not a scene count). */
  coverage_pct: number | null;
  forest_ha: number | null;
  /** % of the OBSERVED area. */
  forest_pct: number | null;
  loss_ha: number | null;
  gain_ha: number | null;
  /** Area observed in both this year and previous_year — where loss/gain were measured. */
  compared_ha: number | null;
  net_change_ha: number | null;
  event_count: number;
  loss_by_severity: Record<Severity, number>;
  loss_by_type: Partial<Record<ChangeType, number>>;
  mean_ndvi: number | null;
  mean_nbr: number | null;
  /** Landsat era (1984–2015): forest and change figures are withheld (imagery only); the backend sends null for them. */
  forest_withheld?: boolean;
  clear_obs_median: number | null;
  dw_obs_median: number | null;
  imagery_status: ImageryStatus;
  /** Sensor provenance */
  sensor: string;
  source: 'landsat' | 'sentinel-2';
  resolution_m: number;
  forest_method: 'landsat_ndvi_proxy' | 'dynamic_world';
  dw_available: boolean;
  composite_window: string;
}

export interface AoiKpis {
  baseline_year: number;
  latest_year: number;
  forest_baseline_ha: number | null;
  forest_latest_ha: number | null;
  /** Area observed in both baseline and comparison years (net change is measured there). */
  compared_ha?: number | null;
  net_change_ha: number | null;
  net_change_pct: number | null;
  total_loss_ha: number | null;
  total_gain_ha: number | null;
  event_count: number;
  high_severity_count: number;
  mean_confidence: number | null;
}

export interface ChangePeriod {
  from_year: number;
  to_year: number;
  loss_ha: number;
  gain_ha: number;
  net_change_ha: number;
  rate_pct_per_year: number;
  level: ChangeLevel;
  sensors: string;
  label: string;
}

export interface History {
  first_year: number;
  last_year?: number;
  forest_first_ha: number | null;
  net_change_ha: number | null;
  net_change_pct: number | null;
  note: string;
}

/** Observation quality — measured metadata, shown for every status (never forest/change metrics). */
export interface QualityYear {
  year: number;
  era: 'historical' | 'modern';
  sensor: string;
  scenes: Record<string, number | null>;
  clear_obs_median: number | null;
  dw_obs_median: number | null;
  coverage_pct: number | null;
  /** Modern era (method tt-ee-2.2): % of the area with >= 1 clear observation in each calendar quarter (Jan–Mar … Oct–Dec). */
  seasonal_coverage_pct?: (number | null)[] | null;
  passes: boolean;
  reason: string | null;
}

export interface QualityIssue {
  rule: string;
  years: number[];
  message: string;
  /** The measured value that failed the check (unstable_forest_mask: gain % of the compared area per year). */
  evidence?: {
    measured_pct_per_year: number; threshold_pct_per_year: number; gain_ha: number; compared_ha: number;
    /** Which half of the forest mask moved (measured), and by how many percentage points of the observed area. */
    driver?: 'tree_prob' | 'leafon_ndvi' | 'both';
    component_change_pts?: { tree_prob: number; leafon_ndvi: number };
  };
}

export interface AnalysisQuality {
  method_version: string;
  status: AnalysisStatus;
  requested_window: [number, number];
  analyzable_window: [number, number] | null;
  years: QualityYear[];
  issues: QualityIssue[];
  thresholds: Record<string, number>;
}

export interface MethodInfo {
  forest_rule: string;
  change_rule: string;
  history_rule?: string;
  mmu_ha: number;
  thresholds: { d_ndvi: number; d_nbr: number; d_tree_prob: number; min_clear_obs: number } & Record<string, number>;
  version?: string;
  eras?: string;
  cloud_masking?: string;
  no_data?: string;
  coverage_rule?: string;
  transition_rule?: string;
  validity_rules?: string;
  severity: string;
  confidence: string;
}

export interface AoiSummary {
  schema_version: string;
  aoi: StudyArea;
  kpis: AoiKpis;
  history?: History;
  years: YearStat[];
  periods?: ChangePeriod[];
  method: MethodInfo;
  provenance: Provenance;
  analysis_window?: { baseline_year: number; comparison_year: number; event_window?: [number, number]; requested?: [number, number] };
  /** Composite years with no input imagery over the AOI — omitted, never estimated. */
  unavailable_years?: { year: number; sources: Record<string, number | null>; reason: string }[];
  /** Why 1984–2015 is imagery only (no forest figures). */
  historical_statement?: string;
  quality?: AnalysisQuality;
  /** Input scene counts per composite year and source (Earth Engine metadata). */
  source_counts?: Record<string, Record<string, number>>;
}

export interface IndexChange {
  before: number;
  after: number;
  change: number;
}

export interface EvidenceItem {
  key: 'ndvi' | 'nbr' | 'tree_prob' | 'persistence' | 'clear_obs' | 'reference' | string;
  label: string;
  value: number | boolean | null;
  threshold: number | null;
  unit: string;
  weight: number;
  score: number;
  /** null = not yet verifiable (e.g. latest year, reference not released) */
  passed: boolean | null;
}

export interface SignalPoint {
  year: number;
  ndvi: number;
  nbr: number;
  tree_prob: number;
}

export interface ChangeEventProps {
  id: string;
  aoi_id: string;
  title: string;
  sector: string;
  change_type: ChangeType;
  change_label: string;
  year_from: number;
  year_to: number;
  composite_window: string;
  area_ha: number;
  area_km2: number;
  conversion_fraction: number;
  centroid: [number, number];
  bbox: [number, number, number, number];
  indices: { ndvi: IndexChange; nbr: IndexChange; tree_prob: IndexChange };
  land_cover: { before: LandCover; after: LandCover };
  severity: { class: Severity; score: number; basis: string };
  /** Evidence score (weighted, not a calibrated probability) and its components. */
  confidence: { score: number; class: ConfidenceClass; evidence: EvidenceItem[] };
  /** Share of converted pixels still non-forest one composite later; null for the latest year. */
  persistence: number | null;
  clear_obs_min: number;
  reference_overlap: number | null;
  timeseries: SignalPoint[];
}

export interface ChangeEvent {
  type: 'Feature';
  id: string;
  geometry: AoiGeometry;
  properties: ChangeEventProps;
}

export interface EventCollection {
  type: 'FeatureCollection';
  schema_version: string;
  aoi_id: string;
  features: ChangeEvent[];
}

export interface ImageryLayer {
  year: number;
  label: string;
  tiles: string[];
  tile_size: number;
  max_zoom: number;
  attribution: string;
  real: boolean;
  /** True when this is stand-in reference imagery, not the composite of `year`. */
  reference?: boolean;
  sensor?: string;
  note?: string;
}

export interface GradientLegend {
  type: 'gradient';
  title: string;
  stops: [number, string][];
  min_label: string;
  max_label: string;
  note?: string;
}

export interface OverlayLayer {
  kind: 'forest' | 'ndvi';
  label: string;
  /** 'image' = one georeferenced image per year; 'raster-tiles' = XYZ tiles per year */
  source: 'image' | 'raster-tiles';
  coordinates?: [[number, number], [number, number], [number, number], [number, number]];
  by_year: Record<string, string>;
  tiles_by_year?: Record<string, string[]>;
  legend: GradientLegend;
}

export interface LayerCatalog {
  aoi_id: string;
  years: number[];
  imagery: ImageryLayer[];
  overlays: OverlayLayer[];
  severity_colors: Record<Severity, string>;
}

/** The measured results of one READY Earth Engine analysis. */
export interface AnalysisBundle {
  id: string;
  summary: AoiSummary;
  events: EventCollection;
  layers: LayerCatalog;
}

export interface AnalysisSources {
  landsat: boolean;
  sentinel2: boolean;
  dynamicWorld: boolean;
  hansen: boolean;
}

/** Structured public error (backend app/errors.py). The UI shows only user_message. */
export interface PublicError {
  code: string;
  user_message: string;
  retryable: boolean;
}

/** Backend response for any analysis request. summary/events/layers only when READY. */
// ---------------------------------------------------------------- area context (reference datasets)
/** Dataset behind a reference value: every value is shown with its dataset and year. */
export interface ContextSource {
  dataset: string;
  id: string;
  year: string | null;
  year_label: string | null;
  resolution_m?: number | null;
  note?: string | null;
}
interface ContextValue { status: 'READY' | 'UNAVAILABLE'; reason: string | null; source: ContextSource }
export interface TerrainContext extends ContextValue {
  elevation_m: { min: number | null; p5: number | null; mean: number | null; p95: number | null; max: number | null } | null;
  slope_mean_deg: number | null;
  steep_share_pct: number | null;
  steep_threshold_deg: number;
  dem_coverage_pct: number | null;
}
export interface ForestCoverContext {
  tree_cover_2000: ContextValue & { canopy_threshold_pct: number; area_ha: number | null; share_of_land_pct: number | null };
  loss_by_year: ContextValue & { years: { year: number; loss_ha: number }[] | null; total_ha: number | null; share_of_2000_tree_cover_pct: number | null };
  gain_2000_2012: ContextValue & { area_ha: number | null };
  worldcover_2021: ContextValue & { area_ha: number | null; share_of_land_pct: number | null };
}
export interface LandCoverClass { class: number; name: string; area_ha: number; share_pct: number }
/** What kind of surface the area is, from measured reference data (open water / mostly water / snow and ice / land). */
export interface ContextSurface { kind: 'open_water' | 'mostly_water' | 'snow_ice' | 'land'; message: string | null; hansen_no_data: boolean }
export interface ContextLayer { id: string; label: string; dataset: string; year_label: string; reference: true; tiles: string[] }
/** Terrain + forest cover from REFERENCE datasets — "Reference context, not a TerraTrace result". */
export interface AreaContext {
  status: 'READY' | 'UNAVAILABLE';
  reason: string | null;
  label: string;
  context_version: string;
  computed_at?: string | null;
  area_ha?: number | null;
  terrain: TerrainContext | null;
  forest: ForestCoverContext | null;
  /** ESA WorldCover v200 (2021) land-cover breakdown, share of the mapped area (water included). */
  land_cover_2021?: (ContextValue & { mapped_ha: number | null; classes: LandCoverClass[] | null }) | null;
  surface?: ContextSurface | null;
  layers: ContextLayer[] | null;
}

/** Statement ("no forest to monitor") or reliability caution of a READY result; names the datasets and years. */
export interface Caution {
  code: 'no_forest_to_monitor' | 'little_forest' | 'datasets_disagree';
  kind: 'statement' | 'caution';
  message: string;
  datasets: string[];
  applies_to?: string[] | null;
  gain_note?: string | null;
}

export interface AnalysisEnvelope {
  analysis_id: string;
  dataMode: 'LIVE';
  analysisStatus: AnalysisStatus;
  reason: string | null;
  reasonCode: string | null;
  aoi: StudyArea;
  window: { baseline_year: number; comparison_year: number };
  source: AnalysisSources;
  /** Public error for every non-READY status (product language only). */
  error?: PublicError | null;
  /** Developer diagnostics — present only when the backend runs with DEV_DIAGNOSTICS=true. */
  diagnostics?: Record<string, unknown>;
  quality?: AnalysisQuality | null;
  summary?: AoiSummary;
  events?: EventCollection;
  layers?: LayerCatalog;
  /** Reference context of the area (null until measured) — present whatever the analysis status. */
  context?: AreaContext | null;
  /** READY results only: statements / reliability cautions (display only; never change a number). */
  cautions?: Caution[];
}

/** What the UI holds for an open area. `bundle` is non-null only when status === 'READY'. */
export interface AnalysisResult {
  id: string;
  status: AnalysisStatus;
  reason: string | null;
  reasonCode: string | null;
  aoi: StudyArea;
  window: { baseline_year: number; comparison_year: number };
  source: AnalysisSources;
  error: PublicError | null;
  diagnostics: Record<string, unknown> | null;
  quality: AnalysisQuality | null;
  bundle: AnalysisBundle | null;
  cautions: Caution[];
}

/** The only information the explanation module may use. */
export interface ExplanationFacts {
  /** The AI refuses to interpret anything that is not a READY live analysis. */
  data_mode: 'LIVE';
  analysis_status: 'READY';
  event_id: string;
  study_area: string;
  region: string;
  biome: string;
  sector: string;
  change_type: ChangeType;
  change_label: string;
  period: { from_year: number; to_year: number; composite_window: string };
  area: { hectares: number; square_km: number };
  share_of_forest_converted: number;
  ndvi: IndexChange;
  nbr: IndexChange;
  tree_probability: IndexChange;
  land_cover: { before: LandCover; after: LandCover };
  severity: { class: Severity; score: number; basis: string };
  confidence: { class: ConfidenceClass; score: number; checks_passed: number; checks_evaluated: number; checks_pending: number };
  evidence: { check: string; value: number | boolean | null; threshold: number | null; passed: boolean | null }[];
  persistence_next_year: number | null;
  min_clear_observations: number;
  reference_overlap_hansen: number | null;
}

export interface Explanation {
  text: string;
  source: 'llm' | 'template' | 'none';
  model?: string | null;
  fact_check?: { passed: boolean; unmatched: string[] } | null;
  facts_used: number;
  generated_at: string;
  cached?: boolean;
  notice?: string | null;
}

export type ProviderState = 'ready' | 'unconfigured' | 'error' | 'offline';

export interface SystemHealth {
  /** false when the backend is unreachable: UI PREVIEW only, no analysis possible. */
  backend: boolean;
  status: 'operational' | 'degraded';
  version: string;
  engine: string;
  dataMode: 'LIVE';
  /** Earth Engine analysis provider. */
  analysis: { status: ProviderState; detail?: string | null };
  explainer: { status: ProviderState; detail?: string | null };
  explainer_model?: string | null;
  geocoder: { status: ProviderState; detail?: string | null };
  limits: { max_aoi_km2: number; min_aoi_km2: number; interactive_max_km2?: number };
  /** AI chat (POST /api/chat): 'offline' = switched off on the server. */
  chat?: { status: ProviderState; detail?: string | null } | null;
}

export interface SearchResult {
  name: string;
  detail?: string | null;
  kind: 'featured' | 'place' | 'forest' | 'coordinates';
  center: [number, number];
  bbox?: [number, number, number, number] | null;
  study_area_id?: string | null;
  source: string;
}

export interface AoiPreview {
  valid: boolean;
  message?: string | null;
  code?: string | null;
  area_km2?: number | null;
  area_ha?: number | null;
  centroid?: [number, number] | null;
  bbox?: [number, number, number, number] | null;
}

// ----------------------------------------------------------------------------- imagery (backend-owned; never an analysis)
export type ImageryYearStatus = 'AVAILABLE' | 'INSUFFICIENT' | 'UNAVAILABLE';

/** Per-year imagery availability MEASURED by the backend (GET /api/imagery/availability). */
export interface ImageryYearAvailability {
  year: number;
  era: 'historical' | 'modern';
  status: ImageryYearStatus;
  source: string;
  composite: string;
  sceneCount: number;
  scenes: Record<string, number>;
  /** Share of the AOI with enough clear observations (0–1), null when not measured. */
  coverage: number | null;
  reason: string | null;
  /** Could a forest-change analysis use this year (the analysis' own rule, incl. seasonal coverage)? Measured. */
  analysable?: boolean;
  analysisReason?: string | null;
  /** Share of the AOI with >= 1 clear observation per calendar quarter (modern era), null when not measured. */
  seasonalCoverage?: [number, number, number, number] | null;
}

export interface ImageryAvailability {
  aoi_id: string;
  method_version: string;
  provider: string;
  thresholds: { min_pixel_clear_obs: number; min_pixel_dw_obs: number; min_year_coverage: number };
  computed_at: string;
  years: ImageryYearAvailability[];
}

/** Real satellite imagery for one AOI and year (GET /api/imagery). READY only with scenes and a tile URL. */
export interface ImageryDecision {
  aoi_id: string;
  year: number;
  status: 'READY' | 'UNAVAILABLE';
  code: string | null;
  message: string | null;
  source: 'Earth Engine';
  is_analysis: false;
  tileUrl: string | null;
  imageryStatus: ImageryYearStatus | null;
  dataset?: string;
  dateRange?: { start: string; end: string };
  sceneCount?: number;
  visualization?: { bands: string[]; min: number; max: number; gamma: number; units: string };
  cloudMask?: string;
  label?: string;
  attribution?: string;
  max_zoom?: number;
}

/** A static base layer from the backend (GET /api/imagery/basemaps). Never live, never an analysis. */
export interface BaseLayer {
  kind: 'basemap' | 'reference';
  year: number | null;
  tiles: string[];
  tile_size: number;
  max_zoom: number;
  label: string;
  attribution: string;
  aoi_verified: boolean;
  is_analysis: false;
}

export interface Basemaps {
  schema_version: string;
  globe: BaseLayer;
  hires: BaseLayer;
  labels: BaseLayer;
  reference_forest: BaseLayer;
}

// ----------------------------------------------------------------------------- asynchronous analysis jobs
/** Real backend job stage (never estimated). */
export type AnalysisJobStage = 'QUEUED' | 'VALIDATING' | 'PREPARING_IMAGERY' | 'MEASURING_OBSERVATION_COVERAGE' | 'MEASURING_FOREST_COVER'
  | 'DETECTING_CHANGE' | 'VALIDATING_RESULT' | 'READY' | 'INVALID_ANALYSIS' | 'UNAVAILABLE' | 'ERROR' | 'CANCELLED';

export interface AnalysisJob {
  job_id: string;
  analysis_id: string;
  window: { baseline_year: number; comparison_year: number };
  /** QUEUED | PROCESSING while running; the analysis status once terminal. */
  status: 'QUEUED' | 'PROCESSING' | 'READY' | 'INVALID_ANALYSIS' | 'UNAVAILABLE' | 'ERROR' | 'CANCELLED';
  stage: AnalysisJobStage;
  elapsed_s: number;
  stages: { stage: AnalysisJobStage; duration_s: number | null }[];
  /** The analysis envelope — only once the job is terminal. */
  result: AnalysisEnvelope | null;
}

/** Measured statistics for the years OUTSIDE the analysed window (Time Machine / charts only). */
export interface AnalysisHistory {
  aoi_id: string;
  window: [number, number];
  years: YearStat[];
  periods: ChangePeriod[];
  history: AoiSummary['history'] | null;
  historical_statement?: string;
}

/* ---------------------------------------------------------------- AI chat (POST /api/chat) */
export interface ChatTurn { role: 'user' | 'assistant'; text: string }
export interface ChatCitation {
  id: string;
  label: string;
  value: string | null;
  dataset: string | null;
  year: string | null;
  /** terratrace_result / reference_context: this area's data; method / dataset: the curated reference library. */
  kind: 'terratrace_result' | 'reference_context' | 'quick_scan' | 'method' | 'dataset';
  source: string | null;
}
/** general = AI explanation (no forest figures); place = this area, from TerraTrace data; reference = method/dataset fact. */
export interface ChatSegment {
  kind: 'general' | 'place' | 'reference';
  /** English: the text TerraTrace's checks ran on. */
  text: string;
  citations: ChatCitation[];
  /** The same segment in the user's language (Hindi / Hinglish) — present only when it passed the translation checks. */
  text_local?: string | null;
}
/** Progress while the answer is made (POST /api/chat/stream). Stages carry no model text. */
export type ChatStage = 'sending' | 'asking' | 'fallback' | 'checking';
export interface ChatReply {
  status: 'answered' | 'withheld' | 'declined' | 'unavailable';
  segments: ChatSegment[];
  /** Withheld: why (never the withheld text). Declined / unavailable: TerraTrace's own message. */
  message: string | null;
  reason_code: string | null;
  notice: string;
  model?: string | null;
  /** The user's language, detected by the backend from their own message. */
  language?: 'en' | 'hi' | 'hinglish' | null;
  /** shown = every translation passed its checks; dropped = the checked English answer is shown instead. */
  translation?: 'shown' | 'dropped' | 'none' | null;
}

// ----------------------------------------------------------------------------- quick scan (backend services/quickscan.py)
/** Tier "Quick scan": land cover, surface temperature and biomass carbon from PUBLIC datasets, on request — not
 *  validated for the area, never a TerraTrace classification, never counted in the forest totals. */
export type QuickScanSeason = 'all' | 'mam' | 'jja' | 'son' | 'djf';
/** The date window a dataset covers (inclusive ISO dates); added by the backend to every served result. */
export interface QuickScanPeriod { start: string; end: string; label: string }
export interface QuickScanSource { dataset: string; id?: string; ids?: string[]; year?: number; resolution_m: number; period?: QuickScanPeriod; [k: string]: unknown }
export interface QuickScanClass { key: string; name: string; color: string; area_km2: number; share: number; low_confidence_share: number | null }
export interface QuickScanLayer {
  id: 'lst' | 'landcover' | 'carbon';
  label: string;
  tiles: string[];
  source: QuickScanSource;
  legend:
    | { type: 'gradient'; unit: string; min: number; max: number; palette: string[]; note: string }
    | { type: 'classes'; classes: { key: string; name: string; color: string }[]; note: string };
}
interface QuickScanSection { status: 'READY' | 'UNAVAILABLE'; reason?: string; label?: string; source: QuickScanSource; method?: string }
export interface QuickScanLandCover extends QuickScanSection {
  classified_km2?: number; coverage_share?: number | null; low_confidence_share?: number; low_confidence_rule?: string;
  classes?: QuickScanClass[];
  worldcover_agreement?: { share: number; compared_km2: number; source: QuickScanSource; note: string } | null;
}
export interface QuickScanUhi {
  status: 'READY' | 'UNAVAILABLE'; label: string; reason?: string; value_c?: number; built_mean_c?: number; other_mean_c?: number;
  built_km2?: number; built_share?: number; other_km2?: number;
}
export interface QuickScanLst extends QuickScanSection {
  reason_code?: string; scenes_found?: number; min_scenes?: number; suggest_season?: QuickScanSeason | null;
  mean_c?: number; p2_c?: number; median_c?: number; p98_c?: number; valid_share?: number | null;
  per_class?: { key: string; name: string; mean_c: number; area_km2: number; water: boolean }[];
  uhi?: QuickScanUhi;
}
export interface QuickScanCarbonComponent extends QuickScanSection {
  id: string; density_t_per_ha?: number; total_t?: number; range_t?: [number, number]; coverage_share?: number;
  carbon_fraction?: number; range_rule?: string; excludes?: string;
}
export interface QuickScan {
  aoi_id: string;
  status: 'NOT_RUN' | 'PROCESSING' | 'READY' | 'UNAVAILABLE';
  tier: 'quick_scan';
  label: string;
  year: number;
  season: QuickScanSeason;
  season_label: string;
  first_year: number;
  last_year: number;
  reason?: string | null;
  reason_code?: string;
  retryable?: boolean;
  area_km2?: number;
  computed_at?: string;
  elapsed_s?: number;
  quickscan_version?: string;
  landcover?: QuickScanLandCover;
  lst?: QuickScanLst;
  carbon?: { status: 'READY' | 'UNAVAILABLE'; label: string; scope: string; components: QuickScanCarbonComponent[] };
  layers?: QuickScanLayer[];
  /** Stored scans: "Agreement, not accuracy" — shown with every result. */
  disclaimer?: string;
  /** NOT_RUN only: what a run would meet right now (checked without Earth Engine). */
  blocked?: { reason_code: string; reason: string; retryable: boolean };
  /** Expected run time from scans this server has timed (in the current mode); seconds null = not yet measured;
   *  range_s = restricted-mode range derived from the normal timing. */
  estimate?: { seconds: number | null; range_s?: [number, number]; restricted?: boolean; basis: string };
  /** Earth Engine restricted mode this quota month: scans still run, slower (never a refusal). */
  restricted_mode?: { active: true; until: string; until_label: string; deadline_s: number; message: string } | null;
  /** PROCESSING only: still waiting behind another quick scan (they run one at a time). */
  queued?: boolean;
  season_hint?: string | null;
}
