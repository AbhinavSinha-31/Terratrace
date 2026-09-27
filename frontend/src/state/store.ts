import { create } from 'zustand';
import type { AnalyzeRequest, AoiGeometry, ChangeType, Severity } from '../data/contracts';
import { DEFAULT_ANALYSIS_WINDOW, DEFAULT_YEARS } from '../lib/time';

export type View = 'explore' | 'analysis' | 'timemachine';
export type ExplorePhase = 'intro' | 'explore';
export type ImageryMode = 'sentinel' | 'hires';
export type PanelTab = 'overview' | 'events';
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

export interface Selection {
  geometry: AoiGeometry;
  source: 'draw' | 'search' | 'click';
  name?: string;
}

interface UiState {
  view: View;
  phase: ExplorePhase;
  aoiId: string | null;
  entryNonce: number;
  /** Selectable composite years (always 1984 → present; availability per year comes from the analysis). */
  years: number[];
  /**
   * The ONE canonical REQUESTED analysis window: sent to the backend, shown in the Time Machine
   * selectors and in the URL. The backend's analysable window is displayed separately and labelled.
   */
  window: { start: number; end: number };
  year: number;
  playing: boolean;
  compare: boolean;
  imagery: ImageryMode;
  layers: LayerToggles;
  selection: Selection | null;
  drawTool: DrawTool;
  pending: { request: AnalyzeRequest; nonce: number } | null;
  selectedEventId: string | null;
  hoveredEventId: string | null;
  hoveredAoiId: string | null;
  severityFilter: Record<Severity, boolean>;
  typeFilter: Partial<Record<ChangeType, boolean>>;
  tab: PanelTab;
  drawerOpen: boolean;
  layersOpen: boolean;
  aboutOpen: boolean;
  /**
   * Window selected in the Time Machine but NOT yet analysed. Exploring the timeline never starts a
   * computation; the analysis runs only when the user explicitly requests it (commitPendingWindow).
   */
  pendingWindow: { start: number; end: number } | null;
  /** Request id of the in-flight featured/area analysis (used to poll its REAL backend stage). */
  activeRid: string | null;
  presentation: { active: boolean; step: number };
  explainRequested: Record<string, boolean>;
  reportEventId: string | null;
  sheet: SheetSnap;
  camera: CameraRequest | null;
  reducedMotion: boolean;

  setView(v: View): void;
  setPhase(p: ExplorePhase): void;
  openAnalysis(id: string, opts?: { view?: View; window?: { start: number; end: number } }): void;
  goExplore(phase?: ExplorePhase): void;
  setYears(years: number[]): void;
  setWindow(start: number, end: number): void;
  setYear(y: number): void;
  stepYear(delta: number): void;
  setPlaying(p: boolean): void;
  setCompare(on: boolean): void;
  setImagery(m: ImageryMode): void;
  setLayer(k: LayerKey, on: boolean): void;
  setForestOpacity(v: number): void;
  setSelection(s: Selection | null): void;
  setDrawTool(t: DrawTool): void;
  startAnalysis(req: AnalyzeRequest): void;
  clearPending(): void;
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
  setPendingWindow(start: number, end: number): void;
  commitPendingWindow(): void;
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

export const useUi = create<UiState>((set, get) => ({
  view: 'explore',
  phase: 'intro',
  aoiId: null,
  entryNonce: 0,
  years: DEFAULT_YEARS,
  window: ANALYSIS_WINDOW,
  year: ANALYSIS_WINDOW.end,
  playing: false,
  compare: false,
  imagery: 'sentinel',
  layers: { satellite: true, forest: true, ndvi: false, change: true, intensity: true, boundary: true, labels: false, globalForest: true, forestOpacity: 0.4 },
  selection: null,
  drawTool: null,
  pending: null,
  selectedEventId: null,
  hoveredEventId: null,
  hoveredAoiId: null,
  severityFilter: { ...allSeverities },
  typeFilter: { ...allTypes },
  tab: 'overview',
  drawerOpen: true,
  layersOpen: wide(),
  aboutOpen: false,
  pendingWindow: null,
  activeRid: null,
  presentation: { active: false, step: 0 },
  explainRequested: {},
  reportEventId: null,
  sheet: 'peek',
  camera: null,
  reducedMotion: !!prefersReduced(),

  setView: (v) => {
    const s = get();
    if (v === 'explore') return get().goExplore();
    if (!s.aoiId) return set({ view: v });
    // Switching views never changes the requested window (one source of truth); only the cursor moves.
    set({ view: v, year: v === 'timemachine' ? s.years[0] : s.window.end, compare: false, playing: false, drawerOpen: v !== 'timemachine' || wide() });
  },
  setPhase: (p) => set({ phase: p }),
  openAnalysis: (id, opts) => {
    const view = opts?.view ?? 'analysis';
    const w = opts?.window ?? ANALYSIS_WINDOW;
    set((s) => ({
      view,
      aoiId: id,
      entryNonce: s.entryNonce + 1,
      window: w,
      pendingWindow: null,
  activeRid: null,
      year: view === 'timemachine' ? DEFAULT_YEARS[0] : w.end,
      playing: false,
      compare: false,
      selectedEventId: null,
      hoveredEventId: null,
      hoveredAoiId: null,
      selection: null,
      drawTool: null,
      tab: 'overview',
      drawerOpen: true,
      severityFilter: { ...allSeverities },
      typeFilter: { ...allTypes },
      sheet: 'peek',
      camera: { kind: 'aoi', id, nonce: ++nonce },
    }));
  },
  goExplore: (phase) =>
    set((s) => ({
      view: 'explore',
      phase: phase ?? s.phase,
      aoiId: null,
      compare: false,
      playing: false,
      selectedEventId: null,
      hoveredEventId: null,
      camera: { kind: 'home', nonce: ++nonce },
    })),
  setYears: (years) => set({ years: years.length ? years : DEFAULT_YEARS }),
  setWindow: (start, end) => {
    if (start >= end || !DEFAULT_YEARS.includes(start) || !DEFAULT_YEARS.includes(end)) return;
    set({ window: { start, end }, pendingWindow: null });
  },
  setYear: (y) => {
    const { years } = get();
    const snapped = years.reduce((best, v) => (Math.abs(v - y) < Math.abs(best - y) ? v : best), years[0]);
    set({ year: snapped });
  },
  stepYear: (d) => {
    const { years, year } = get();
    const i = years.indexOf(year);
    const next = years[Math.min(years.length - 1, Math.max(0, (i < 0 ? 0 : i) + d))];
    set({ year: next });
  },
  setPlaying: (p) => set({ playing: p }),
  setCompare: (on) =>
    set((s) => {
      if (!on) return { compare: false };
      // Compare the window start (before) with the displayed year (after).
      const after = s.year > s.window.start ? s.year : s.window.end;
      return { compare: true, playing: false, year: after };
    }),
  setImagery: (m) => set((s) => ({ imagery: m, layers: { ...s.layers, satellite: true } })),
  setLayer: (k, on) => set((s) => ({ layers: { ...s.layers, [k]: on } })),
  setForestOpacity: (v) => set((s) => ({ layers: { ...s.layers, forestOpacity: v } })),
  setSelection: (sel) => set({ selection: sel }),
  setDrawTool: (t) => set({ drawTool: t, phase: t ? 'explore' : get().phase }),
  startAnalysis: (request) => set({ pending: { request, nonce: ++nonce } }),
  clearPending: () => set({ pending: null }),
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
  setPendingWindow: (start, end) => {
    const w = get().window;
    if (start >= end || !DEFAULT_YEARS.includes(start) || !DEFAULT_YEARS.includes(end)) return;
    set({ pendingWindow: start === w.start && end === w.end ? null : { start, end } });
  },
  commitPendingWindow: () => {
    const p = get().pendingWindow;
    if (p) set({ window: p, pendingWindow: null });
  },
  setPresentation: (p) => set({ presentation: p }),
  requestExplanation: (id) => set((s) => ({ explainRequested: { ...s.explainRequested, [id]: true } })),
  openReport: (id) => set({ reportEventId: id }),
  setSheet: (sh) => set({ sheet: sh }),
  requestCamera: (req) => set({ camera: { ...req, nonce: ++nonce } }),
}));
