import { useUi, useAnalysisWindow } from '../state/store';
import { useBasemaps, useCandidateAoi, useCurrentAnalysis, useCurrentBundle, useImageryDecision } from './queries';
import { imageryErrorMessage } from './imagerySync';

/**
 * Two INDEPENDENT states, never derived from each other:
 *
 *   imageryState  — the raster the map is ACTUALLY rendering right now (imagery only, never a result).
 *   analysisState — the TERRATRACE analysis for the selected analysis WINDOW (job / envelope status).
 *
 * Every imagery label (map header, Layers panel, timeline, bottom status) is derived from imageryState, and every
 * scientific-result label from analysisState. "Imagery available" never implies "analysis available", and changing
 * the viewed imagery never changes the analysis state.
 */

export type ImageryStateName = 'AVAILABLE' | 'UNAVAILABLE' | 'LOADING' | 'ERROR' | 'OFF' | 'NONE';
export type AnalysisStateName = 'NOT_RUN' | 'PROCESSING' | 'READY' | 'VALIDATION_REQUIRED' | 'UNAVAILABLE' | 'ERROR';

export interface ImageryState {
  state: ImageryStateName;
  /** Which raster is on the map: Esri current basemap, the live Earth Engine composite, or the READY analysis' composite. */
  source: 'esri-current' | 'ee-live' | 'ee-analysis-composite' | null;
  provider: string | null;      // 'Esri World Imagery' | 'Google Earth Engine'
  dataset: string | null;       // 'Esri World Imagery' | 'Sentinel-2' | 'Landsat' | sensor label
  /** The year the displayed imagery represents — null when undated (Esri current) or nothing is displayed. */
  year: number | null;
  dateLabel: string | null;     // 'current, undated' | '2025 annual composite'
  /** Only for the live Earth Engine composite that is actually displayed (never borrowed from another dataset). */
  sceneCount: number | null;
  /** Stand-in reference imagery (not the composite of the selected year). */
  reference: boolean;
  mode: 'IMAGERY_ONLY';
  /** One canonical line, e.g. "Sentinel-2 · 2025 · 175 scenes" or "Esri World Imagery · current, undated". */
  label: string;
  message: string | null;
  /** The year selected on the timeline (what imagery is REQUESTED for; not necessarily what is displayed). */
  requestedYear: number;
}

export interface AnalysisState {
  state: AnalysisStateName;
  window: { start: number; end: number };
  /** The years actually analysed (may be narrower than the window when a year fails the quality rules). */
  analysedWindow: [number, number] | null;
  reason: string | null;
}

/** Human name of a backend imagery dataset id (e.g. COPERNICUS/S2_SR_HARMONIZED -> Sentinel-2). */
export function datasetName(id: string | undefined | null): string | null {
  if (!id) return null;
  if (/S2/i.test(id)) return 'Sentinel-2';
  if (/LANDSAT|LC0|LE0|LT0/i.test(id)) return 'Landsat';
  return id;
}

/** "Esri World Imagery (current, undated)" -> { name: "Esri World Imagery", date: "current, undated" } */
function splitBasemapLabel(label: string | undefined): { name: string; date: string } {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(label ?? '');
  return m ? { name: m[1], date: m[2] } : { name: label || 'Esri World Imagery', date: 'current, undated' };
}

/**
 * The imagery the map renders — the SAME precedence as TerraMap.showImagery/ensureImagery:
 *   satellite off -> nothing; 'hires' -> Esri current basemap; else the live Earth Engine composite (READY for this
 *   AOI + year), else the READY analysis' own composite for that year, else nothing (unavailable / loading / error).
 */
export function useImageryState(): ImageryState {
  const studyId = useUi((s) => s.investigation.study?.id ?? null);
  const year = useUi((s) => s.investigation.imageryYear);
  const satellite = useUi((s) => s.layers.satellite);
  const hires = useUi((s) => s.imagery === 'hires');
  const drawing = useUi((s) => !!s.drawTool);
  const candidate = useCandidateAoi();
  const imageryAoiId = studyId ?? (drawing ? null : candidate?.id ?? null);
  const q = useImageryDecision(imageryAoiId, year);
  const bundle = useCurrentBundle();
  const basemap = useBasemaps().data?.hires;
  const base = { mode: 'IMAGERY_ONLY' as const, requestedYear: year, reference: false, message: null, sceneCount: null };

  if (!satellite) return { ...base, state: 'OFF', source: null, provider: null, dataset: null, year: null, dateLabel: null, label: 'Satellite imagery off' };
  if (hires) {
    const { name, date } = splitBasemapLabel(basemap?.label);
    return { ...base, state: 'AVAILABLE', source: 'esri-current', provider: name, dataset: name, year: null, dateLabel: date, label: `${name} · ${date}` };
  }
  if (!imageryAoiId) return { ...base, state: 'NONE', source: null, provider: null, dataset: null, year: null, dateLabel: null, label: 'Base imagery' };
  const d = q.data;
  if (d?.status === 'READY' && d.tileUrl && d.aoi_id === imageryAoiId && d.year === year) {
    const ds = datasetName(d.dataset) ?? 'Earth Engine composite';
    return { ...base, state: 'AVAILABLE', source: 'ee-live', provider: 'Google Earth Engine', dataset: ds, year, dateLabel: `${year} annual composite`,
             sceneCount: d.sceneCount ?? null, label: [ds, String(year), d.sceneCount != null ? `${d.sceneCount} scenes` : null].filter(Boolean).join(' · ') };
  }
  const own = bundle && bundle.id === studyId ? bundle.layers.imagery.find((i) => i.year === year) : undefined;
  if (own) {
    const ds = own.sensor ?? 'Earth Engine composite';
    return { ...base, state: 'AVAILABLE', source: 'ee-analysis-composite', provider: 'Google Earth Engine', dataset: ds, year: own.reference ? null : year,
             dateLabel: own.reference ? `stand-in reference, not ${year}` : `${year} analysis composite`, reference: !!own.reference,
             label: own.reference ? `${own.label} · stand-in reference (not ${year})` : `${ds} · ${year} · analysis composite` };
  }
  const empty = { ...base, source: null, provider: null, dataset: null, year: null, dateLabel: null };
  if (d) return { ...empty, state: 'UNAVAILABLE', label: `${year} · imagery unavailable`, message: d.message ?? 'No imagery for this year' };
  if (q.isError) return { ...empty, state: 'ERROR', label: 'Imagery unavailable', message: imageryErrorMessage(q.error) };
  return { ...empty, state: 'LOADING', label: `Loading imagery · ${year}` };
}

export function useAnalysisState(): AnalysisState {
  const status = useUi((s) => s.investigation.analysisStatus);
  const error = useUi((s) => s.investigation.analysisError);
  const win = useAnalysisWindow();
  const r = useCurrentAnalysis().data;
  const window = { start: win.start, end: win.end };
  const analysedWindow = r?.quality?.analyzable_window ?? null;
  if (status === 'running') return { state: 'PROCESSING', window, analysedWindow: null, reason: null };
  if (status === 'error') return { state: 'ERROR', window, analysedWindow: null, reason: error?.message ?? null };
  if (status !== 'complete' || !r) return { state: 'NOT_RUN', window, analysedWindow: null, reason: null };
  const state: AnalysisStateName = r.status === 'READY' ? 'READY' : r.status === 'INVALID_ANALYSIS' ? 'VALIDATION_REQUIRED'
    : r.status === 'ERROR' ? 'ERROR' : r.status === 'PROCESSING' ? 'PROCESSING' : 'UNAVAILABLE';
  return { state, window, analysedWindow, reason: r.status === 'READY' ? null : r.reason };
}

/** Why Before / After is unavailable (null = available: only a READY analysis has a validated comparison). */
export function compareBlockedReason(a: AnalysisState): string | null {
  switch (a.state) {
    case 'READY': return null;
    case 'VALIDATION_REQUIRED': return 'Unavailable — analysis failed validation';
    case 'PROCESSING': return 'Unavailable — analysis in progress';
    case 'ERROR': return 'Unavailable — analysis failed';
    case 'UNAVAILABLE': return 'Unavailable — no analysis result';
    default: return 'Unavailable — run the analysis first';
  }
}
