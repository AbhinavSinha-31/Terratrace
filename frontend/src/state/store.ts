import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { AnalysisHistory, AnalysisJobStage, AnalysisResult, AoiGeometry, ChangeType, QuickScanLayer, QuickScanSeason, Severity } from '../data/contracts';
import { newRid } from '../data/client';
import { DEFAULT_ANALYSIS_WINDOW, DEFAULT_YEARS } from '../lib/time';

export type View = 'explore' | 'analysis' | 'timemachine';
export type ExplorePhase = 'intro' | 'explore';
export type ImageryMode = 'sentinel' | 'hires';
export type PanelTab = 'overview' | 'events' | 'land' | 'ask';
export type SheetSnap = 'peek' | 'half' | 'full';
export type DrawTool = 'rect' | 'polygon' | null;

export interface LayerToggles {
  satellite: boolean;
  forest: boolean;
  ndvi: boolean;
  change: boolean;
  intensity: boolean;
  boundary: boolean;
  labels: boolean;
  /** Global tree-cover reference on the explorer globe (Hansen 2000). */
  globalForest: boolean;
  forestOpacity: number;
}
export type LayerKey = Exclude<keyof LayerToggles, 'forestOpacity'>;

export interface CameraRequest {
  kind: 'aoi' | 'event' | 'home' | 'bbox' | 'point' | 'zoom-in' | 'zoom-out' | 'north';
  id?: string;
  bbox?: [number, number, number, number];
  point?: [number, number];
  nonce: number;
}

/** Geometry under investigation: a registered study's AOI, or a drawn / searched / clicked candidate. */
export interface Selection {
  geometry: AoiGeometry;
  source: 'study' | 'draw' | 'search' | 'click';
  name?: string;
  /** The exact searched / located point [lon, lat] (shown as a pin while this selection is active). */
  point?: [number, number];
}

/** A registered area (featured study or a custom AOI the backend has registered). */
export interface StudyRef {
  id: string;
  name?: string;
}

export type InvestigationAnalysisStatus = 'idle' | 'running' | 'complete' | 'error';
/** Imagery availability for (AOI, imageryYear). 'unknown' until the availability service exists. */
export type InvestigationImageryStatus = 'unknown' | 'loading' | 'available' | 'insufficient' | 'unavailable';

/**
 * THE single source of truth for the active investigation.
 *
 * - URL state mirrors it (lib/urlState.ts) and writes back only through the actions below.
 * - React Query is only the fetch cache used by the analysis runner (data/analysisRunner.ts).
 * - A result/error is accepted only if requestId, baseline, comparison and study still match
 *   (acceptAnalysis / failAnalysis); anything else is a stale response and is discarded.
 * - Changing study, AOI, baseline or comparison resets the analysis (incompatible result).
 *   Changing the imagery year does not (the analysis is baseline -> comparison).
 */
export interface InvestigationState {
  study: StudyRef | null;
  aoi: Selection | null;
  imageryYear: number;
  baselineYear: number;
  comparisonYear: number;
  imageryStatus: InvestigationImageryStatus;
  analysisStatus: InvestigationAnalysisStatus;
  analysisRequestId: string | null;
  analysisResult: AnalysisResult | null;
  analysisError: { code?: string; message: string; retryable?: boolean } | null;
  /** REAL progress of the running analysis job (backend stage + elapsed time); null when no job is running. */
  analysisJob: AnalysisJobProgress | null;
}

export interface AnalysisJobProgress {
  id: string;
  stage: AnalysisJobStage;
  elapsedS: number;
  stages: { stage: AnalysisJobStage; duration_s: number | null }[];
}

/** Identity of an analysis request; a response is applied only if it still matches the state. */
export interface AnalysisRequestMeta {
  requestId: string;
  studyId: string | null;
  baselineYear: number;
  comparisonYear: number;
}

export type OverlayPage =
  | { kind: 'scans' }
  | { kind: 'community'; tag?: string }
  | { kind: 'post'; id: string }
  | { kind: 'new-post' };

interface UiState {
  view: View;
  phase: ExplorePhase;
  /** A static case study shown full page over the map (null = none). Independent of the investigation; no backend. */
  caseStudy: string | null;
  openCaseStudy(id: string): void;
  closeCaseStudy(): void;
  /** The account page (#/profile): sign in, or see and edit your profile. Full page over the map; replaces a case study. */
  profileOpen: boolean;
  openProfile(): void;
  closeProfile(): void;
  /** A full page over the map: My scans (#/scans) or the community (#/community, #/community/<post>, #/community/new). */
  page: OverlayPage | null;
  openPage(page: OverlayPage): void;
  closePage(): void;
  /** The active investigation — the only source of study / AOI / years / analysis state. */
  investigation: InvestigationState;
  /** Selectable timeline years (UI option list; per-year availability comes from the backend later). */
  years: number[];
  playing: boolean;
  compare: boolean;
  imagery: ImageryMode;
  layers: LayerToggles;
  drawTool: DrawTool;
  selectedEventId: string | null;
  hoveredEventId: string | null;
  hoveredAoiId: string | null;
  severityFilter: Record<Severity, boolean>;
  typeFilter: Partial<Record<ChangeType, boolean>>;
  tab: PanelTab;
  drawerOpen: boolean;
  layersOpen: boolean;
  aboutOpen: boolean;
  presentation: { active: boolean; step: number };
  explainRequested: Record<string, boolean>;
  reportEventId: string | null;
  sheet: SheetSnap;
  camera: CameraRequest | null;
  reducedMotion: boolean;

  setView(v: View): void;
  setPhase(p: ExplorePhase): void;
  /**
   * Open a registered study: populates the investigation (study, AOI, default or given years) and leaves
   * the analysis IDLE ("Ready to analyze"). It NEVER starts an analysis — only requestAnalysis() does.
   */
  /** Open a study. `run: true` (Featured investigation cards only) also starts its REAL analysis immediately. */
  openAnalysis(id: string, opts?: { view?: View; window?: { start: number; end: number }; name?: string; geometry?: AoiGeometry; imageryYear?: number; run?: boolean }): void;
  goExplore(phase?: ExplorePhase): void;
  setYears(years: number[]): void;
  /** Set baseline/comparison. Resets an incompatible analysis to idle; never starts one. */
  setWindow(start: number, end: number): void;
  setYear(y: number): void;
  /** Imagery status from the backend imagery decision; ignored unless study + year still match. */
  setImageryStatus(meta: { studyId: string; year: number }, status: InvestigationImageryStatus): void;
  stepYear(delta: number): void;
  /**
   * The ONLY action that starts an analysis (explicit user action: Run / Retry). Sets `running` with a
   * new request id; the analysis runner executes exactly that request.
   */
  requestAnalysis(): void;
  acceptAnalysis(meta: AnalysisRequestMeta, result: AnalysisResult): boolean;
  /** Show a STORED result (read-only lookup, no analysis run) — only while idle on exactly that study + window. */
  loadStoredAnalysis(meta: { studyId: string; baselineYear: number; comparisonYear: number }, result: AnalysisResult): boolean;
  failAnalysis(meta: AnalysisRequestMeta, error: { code?: string; message: string; retryable?: boolean }): boolean;
  /** Real job progress for the current request (ignored for a stale request). */
  setAnalysisJob(meta: AnalysisRequestMeta, job: AnalysisJobProgress): boolean;
  /** Merge measured out-of-window years (history) into the current READY result (ignored when stale). */
  mergeHistory(meta: { studyId: string; baselineYear: number; comparisonYear: number; resultId: string }, history: AnalysisHistory): boolean;
  /** Discard the analysis (e.g. closing a failed custom-area request). */
  resetAnalysis(): void;
  setPlaying(p: boolean): void;
  setCompare(on: boolean): void;
  setImagery(m: ImageryMode): void;
  setLayer(k: LayerKey, on: boolean): void;
  /** Reference context map layers (hillshade, slope, Hansen tree cover 2000, Hansen loss year), off by default. */
  contextLayers: Record<string, boolean>;
  setContextLayer(id: string, on: boolean): void;
  /** Quick scan (public datasets, on request) of ONE area: the year (null = latest complete year) and season (null = the
   *  backend's default, all months) shown, and the one visible quick-scan map layer (null = none). Reset when the area
   *  changes, so a season picked for one area never carries over to another. */
  quickScan: { aoi: string | null; year: number | null; season: QuickScanSeason | null; layer: QuickScanLayer['id'] | null };
  setQuickScan(p: Partial<{ aoi: string | null; year: number | null; season: QuickScanSeason | null; layer: QuickScanLayer['id'] | null }>): void;
  setForestOpacity(v: number): void;
  setSelection(s: Selection | null): void;
  setDrawTool(t: DrawTool): void;
  selectEvent(id: string | null, opts?: { fly?: boolean }): void;
  hoverEvent(id: string | null): void;
  hoverAoi(id: string | null): void;
  toggleSeverity(s: Severity): void;
  toggleType(t: ChangeType): void;
  resetFilters(): void;
  setTab(t: PanelTab): void;
  setDrawerOpen(o: boolean): void;
  setLayersOpen(o: boolean): void;
  setAboutOpen(o: boolean): void;
  setPresentation(p: { active: boolean; step: number }): void;
  requestExplanation(eventId: string): void;
  openReport(eventId: string | null): void;
  setSheet(s: SheetSnap): void;
  requestCamera(req: Omit<CameraRequest, 'nonce'>): void;
}

const allSeverities = { low: true, moderate: true, high: true, critical: true };
const allTypes = { clearing: true, fire: true, degradation: true, unknown: true };
let nonce = 0;
const wide = () => typeof window !== 'undefined' && window.innerWidth >= 1320;
const prefersReduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const ANALYSIS_WINDOW = { ...DEFAULT_ANALYSIS_WINDOW };

const IDLE_ANALYSIS = {
  analysisStatus: 'idle' as InvestigationAnalysisStatus,
  analysisRequestId: null,
  analysisResult: null,
  analysisError: null,
  analysisJob: null,
};

const EMPTY_INVESTIGATION: InvestigationState = {
  study: null,
  aoi: null,
  imageryYear: ANALYSIS_WINDOW.end,
  baselineYear: ANALYSIS_WINDOW.start,
  comparisonYear: ANALYSIS_WINDOW.end,
  imageryStatus: 'unknown',
  ...IDLE_ANALYSIS,
};

/** A response may be applied only if it belongs to the CURRENT request and selection. */
export function requestMatches(inv: InvestigationState, m: AnalysisRequestMeta): boolean {
  return inv.analysisStatus === 'running' && inv.analysisRequestId === m.requestId
    && inv.baselineYear === m.baselineYear && inv.comparisonYear === m.comparisonYear
    && (inv.study?.id ?? null) === m.studyId;
}

const snapTo = (years: number[], y: number) => years.reduce((best, v) => (Math.abs(v - y) < Math.abs(best - y) ? v : best), years[0]);

export const useUi = create<UiState>((set, get) => ({
  view: 'explore',
  phase: 'intro',
  caseStudy: null,
  openCaseStudy: (id) => set({ caseStudy: id, page: null }),
  closeCaseStudy: () => set({ caseStudy: null }),
  profileOpen: false,
  openProfile: () => set({ profileOpen: true, caseStudy: null, page: null }),
  closeProfile: () => set({ profileOpen: false }),
  page: null,
  openPage: (page) => set({ page, profileOpen: false, caseStudy: null }),
  closePage: () => set({ page: null }),
  investigation: EMPTY_INVESTIGATION,
  years: DEFAULT_YEARS,
  playing: false,
  compare: false,
  imagery: 'sentinel',
  layers: { satellite: true, forest: true, ndvi: false, change: true, intensity: true, boundary: true, labels: false, globalForest: true, forestOpacity: 0.3 },
  drawTool: null,
  selectedEventId: null,
  hoveredEventId: null,
  hoveredAoiId: null,
  severityFilter: { ...allSeverities },
  typeFilter: { ...allTypes },
  tab: 'overview',
  drawerOpen: true,
  layersOpen: wide(),
  aboutOpen: false,
  presentation: { active: false, step: 0 },
  explainRequested: {},
  reportEventId: null,
  sheet: 'peek',
  camera: null,
  reducedMotion: !!prefersReduced(),

  setView: (v) => {
    const s = get();
    if (v === 'explore') return get().goExplore();
    if (!s.investigation.study) return set({ view: v });
    // Switching views never changes the analysis years; only the imagery-year cursor moves.
    const imageryYear = v === 'timemachine' ? s.years[0] : s.investigation.comparisonYear;
    set({ view: v, investigation: { ...s.investigation, imageryYear }, compare: false, playing: false, drawerOpen: v !== 'timemachine' || wide() });
  },
  setPhase: (p) => set({ phase: p }),
  openAnalysis: (id, opts) => {
    const view = opts?.view ?? 'analysis';
    const w = opts?.window ?? ANALYSIS_WINDOW;
    set({
      view,
      investigation: {
        study: { id, name: opts?.name },
        aoi: opts?.geometry ? { geometry: opts.geometry, source: 'study', name: opts?.name } : null,
        baselineYear: w.start,
        comparisonYear: w.end,
        imageryYear: opts?.imageryYear ?? (view === 'timemachine' ? DEFAULT_YEARS[0] : w.end),
        imageryStatus: 'unknown',
        ...IDLE_ANALYSIS,   // opening a study never analyses it
      },
      playing: false,
      compare: false,
      selectedEventId: null,
      hoveredEventId: null,
      hoveredAoiId: null,
      drawTool: null,
      tab: 'overview',
      drawerOpen: true,
      severityFilter: { ...allSeverities },
      typeFilter: { ...allTypes },
      sheet: 'peek',
      camera: { kind: 'aoi', id, nonce: ++nonce },
    });
    if (opts?.run) {
      if (import.meta.env.DEV) console.debug('[analysis] featured investigation opened with run', { id, window: w });
      get().requestAnalysis();
    }
  },
  goExplore: (phase) =>
    set((s) => ({
      view: 'explore',
      phase: phase ?? s.phase,
      // Leaving a study ends that investigation; an unregistered candidate AOI (drawn/searched) is kept.
      investigation: s.investigation.study ? { ...EMPTY_INVESTIGATION } : s.investigation,
      compare: false,
      playing: false,
      selectedEventId: null,
      hoveredEventId: null,
      camera: { kind: 'home', nonce: ++nonce },
    })),
  setYears: (years) => set({ years: years.length ? years : DEFAULT_YEARS }),
  setWindow: (start, end) => {
    const inv = get().investigation;
    if (start >= end || !DEFAULT_YEARS.includes(start) || !DEFAULT_YEARS.includes(end)) return;
    if (start === inv.baselineYear && end === inv.comparisonYear) return;
    // New years -> the previous result is incompatible: reset it (any in-flight response is then stale).
    set({ investigation: { ...inv, baselineYear: start, comparisonYear: end, ...IDLE_ANALYSIS }, selectedEventId: null, compare: false });
  },
  setYear: (y) => {
    const s = get();
    set({ investigation: { ...s.investigation, imageryYear: snapTo(s.years, y), imageryStatus: 'unknown' } });
  },
  setImageryStatus: (meta, status) => {
    const inv = get().investigation;
    if (inv.study?.id !== meta.studyId || inv.imageryYear !== meta.year || inv.imageryStatus === status) return;
    set({ investigation: { ...inv, imageryStatus: status } });
  },
  stepYear: (d) => {
    const s = get();
    const i = s.years.indexOf(s.investigation.imageryYear);
    const next = s.years[Math.min(s.years.length - 1, Math.max(0, (i < 0 ? 0 : i) + d))];
    set({ investigation: { ...s.investigation, imageryYear: next, imageryStatus: 'unknown' } });
  },
  requestAnalysis: () => {
    const inv = get().investigation;
    if (!inv.study && !inv.aoi) return;
    set({ investigation: { ...inv, ...IDLE_ANALYSIS, analysisStatus: 'running', analysisRequestId: newRid() }, selectedEventId: null, compare: false });
  },
  loadStoredAnalysis: (meta, result) => {
    const inv = get().investigation;
    if (inv.analysisStatus !== 'idle' || inv.study?.id !== meta.studyId || inv.baselineYear !== meta.baselineYear || inv.comparisonYear !== meta.comparisonYear) return false;
    set({ investigation: { ...inv, analysisStatus: 'complete', analysisResult: result, analysisError: null, analysisJob: null, analysisRequestId: `stored-${newRid()}` } });
    return true;
  },
  acceptAnalysis: (meta, result) => {
    const s = get();
    if (!requestMatches(s.investigation, meta)) return false;   // stale response - discarded
    const wasCustom = !s.investigation.study;
    set({
      investigation: {
        ...s.investigation,
        // A custom AOI becomes a registered study once the backend has accepted it.
        study: s.investigation.study ?? { id: result.id, name: result.aoi.name },
        aoi: s.investigation.aoi ?? { geometry: result.aoi.geometry, source: 'study', name: result.aoi.name },
        analysisStatus: 'complete',
        analysisResult: result,
        analysisError: null,
        analysisJob: null,
      },
      // Before / After exists only for a validated (READY) analysis.
      ...(result.status === 'READY' ? {} : { compare: false }),
      ...(wasCustom ? { view: 'analysis' as View, tab: 'overview' as PanelTab, drawerOpen: true, drawTool: null, sheet: 'peek' as SheetSnap, camera: { kind: 'aoi' as const, id: result.id, nonce: ++nonce } } : {}),
    });
    return true;
  },
  failAnalysis: (meta, error) => {
    const s = get();
    if (!requestMatches(s.investigation, meta)) return false;   // stale response - discarded
    set({ investigation: { ...s.investigation, analysisStatus: 'error', analysisResult: null, analysisError: error, analysisJob: null }, compare: false });
    return true;
  },
  setAnalysisJob: (meta, job) => {
    const s = get();
    if (!requestMatches(s.investigation, meta)) return false;
    set({ investigation: { ...s.investigation, analysisJob: job } });
    return true;
  },
  mergeHistory: (meta, history) => {
    const inv = get().investigation;
    const r = inv.analysisResult;
    if (!r?.bundle || r.id !== meta.resultId || inv.study?.id !== meta.studyId || inv.baselineYear !== meta.baselineYear || inv.comparisonYear !== meta.comparisonYear) return false;
    const own = new Set(r.bundle.summary.years.map((y) => y.year));
    const years = [...r.bundle.summary.years, ...history.years.filter((y) => !own.has(y.year))].sort((a, b) => a.year - b.year);
    const periods = [...(history.periods ?? []), ...(r.bundle.summary.periods ?? []).filter((p) => !(history.periods ?? []).some((h) => h.from_year === p.from_year && h.to_year === p.to_year))];
    // Forest-mask tiles exist for every analysable modern history year too (rebuilt server-side from the registered AOI).
    // Landsat-era years are imagery only: no forest tiles.
    const histOk = history.years.filter((y) => y.passes_quality && !y.forest_withheld && y.era === 'modern' && !own.has(y.year)).map((y) => y.year);
    const overlays = r.bundle.layers.overlays.map((o) => (o.kind === 'forest' && o.tiles_by_year
      ? { ...o, tiles_by_year: { ...Object.fromEntries(histOk.map((y) => [String(y), [`/api/tiles/${r.id}/forest/${y}/{z}/{x}/{y}`]])), ...o.tiles_by_year } }
      : o));
    const summary = { ...r.bundle.summary, years, periods, history: r.bundle.summary.history ?? history.history ?? undefined };
    set({ investigation: { ...inv, analysisResult: { ...r, bundle: { ...r.bundle, summary, layers: { ...r.bundle.layers, overlays } } } } });
    return true;
  },
  resetAnalysis: () => set((s) => ({ investigation: { ...s.investigation, ...IDLE_ANALYSIS } })),
  setPlaying: (p) => set({ playing: p }),
  setCompare: (on) =>
    set((s) => {
      if (!on) return { compare: false };
      const inv = s.investigation;
      // Before / After presents a validated forest-change comparison: only for a READY analysis (never raw imagery of a
      // failed, missing or running analysis). Every entry point (button, 'c' key, event inspector) goes through here.
      if (inv.analysisStatus !== 'complete' || inv.analysisResult?.status !== 'READY') return {};
      // Compare the baseline (before) with the displayed imagery year (after).
      const after = inv.imageryYear > inv.baselineYear ? inv.imageryYear : inv.comparisonYear;
      return { compare: true, playing: false, investigation: { ...inv, imageryYear: after } };
    }),
  setImagery: (m) => set((s) => ({ imagery: m, layers: { ...s.layers, satellite: true } })),
  setLayer: (k, on) => set((s) => ({ layers: { ...s.layers, [k]: on } })),
  contextLayers: {},
  setContextLayer: (id, on) => set((s) => ({ contextLayers: { ...s.contextLayers, [id]: on } })),
  quickScan: { aoi: null, year: null, season: null, layer: null },
  setQuickScan: (p) => set((s) => ({ quickScan: { ...s.quickScan, ...p } })),
  setForestOpacity: (v) => set((s) => ({ layers: { ...s.layers, forestOpacity: v } })),
  // Candidate AOI (drawn / searched / clicked) while no study is open. A new AOI resets the analysis.
  setSelection: (sel) => set((s) => ({
    investigation: { ...EMPTY_INVESTIGATION, baselineYear: s.investigation.baselineYear, comparisonYear: s.investigation.comparisonYear, imageryYear: s.investigation.imageryYear, aoi: sel },
  })),
  setDrawTool: (t) => set({ drawTool: t, phase: t ? 'explore' : get().phase }),
  selectEvent: (id, opts) =>
    set((s) => ({
      selectedEventId: id,
      drawerOpen: id ? true : s.drawerOpen,
      sheet: id ? 'half' : s.sheet,
      camera: id && opts?.fly !== false ? { kind: 'event', id, nonce: ++nonce } : s.camera,
    })),
  hoverEvent: (id) => set({ hoveredEventId: id }),
  hoverAoi: (id) => set({ hoveredAoiId: id }),
  toggleSeverity: (sv) => set((s) => ({ severityFilter: { ...s.severityFilter, [sv]: !s.severityFilter[sv] } })),
  toggleType: (t) => set((s) => ({ typeFilter: { ...s.typeFilter, [t]: !s.typeFilter[t] } })),
  resetFilters: () => set({ severityFilter: { ...allSeverities }, typeFilter: { ...allTypes } }),
  setTab: (t) => set({ tab: t, drawerOpen: true }),
  setDrawerOpen: (o) => set({ drawerOpen: o }),
  setLayersOpen: (o) => set({ layersOpen: o }),
  setAboutOpen: (o) => set({ aboutOpen: o }),
  setPresentation: (p) => set({ presentation: p }),
  requestExplanation: (id) => set((s) => ({ explainRequested: { ...s.explainRequested, [id]: true } })),
  openReport: (id) => set({ reportEventId: id }),
  setSheet: (sh) => set({ sheet: sh }),
  requestCamera: (req) => set({ camera: { ...req, nonce: ++nonce } }),
}));

/** The candidate (not yet registered) AOI while exploring; null once a study is open. */
export const selectCandidate = (s: UiState) => (s.investigation.study ? null : s.investigation.aoi);

/** The analysis years of the active investigation (baseline -> comparison), as a stable {start, end}. */
export const useAnalysisWindow = () =>
  useUi(useShallow((s: UiState) => ({ start: s.investigation.baselineYear, end: s.investigation.comparisonYear })));
