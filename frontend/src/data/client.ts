/**
 * TERRATRACE data client.
 *
 * Talks to the backend (/api). Scientific results come only from the backend's
 * Earth Engine pipeline. When the backend is unreachable the app runs as a
 * UI PREVIEW: featured AOI definitions (geometry only, public/data/featured.json)
 * and real reference imagery — never metrics, events or narratives.
 */
import type {
  AnalysisEnvelope, AnalysisResult, AoiGeometry, AoiPreview, Basemaps, Explanation, ExplanationFacts,
  AnalysisHistory, AnalysisJob, ImageryAvailability, ImageryDecision, LayerCatalog, StudyArea, SearchResult, StudyAreaIndex, SystemHealth,
} from './contracts';
import { geometryAreaKm2, geometryBbox, geometryCentroid } from '../lib/geo';

// Same-origin "/api" in dev (Vite proxy) and single-port mode; the backend's public URL + "/api" when the frontend is
// hosted separately (e.g. VITE_API_BASE=https://api.example.com/api). A public URL only — never a credential.
const API = (import.meta.env.VITE_API_BASE || '/api').replace(/\/+$/, '');

/** Resolve a backend-relative path ("/api/tiles/…", as the backend returns tile templates) against the API base. */
export const apiUrl = (path: string) => (path.startsWith('/api/') ? `${API}${path.slice(4)}` : path);
const BASE = import.meta.env.BASE_URL;
const ANALYSIS_TIMEOUT_MS = 200000;

/** Public product language (mirrors backend app/errors.py). Never engineering or setup text. */
export const PUBLIC = {
  unavailable: 'Live Earth observation is temporarily unavailable for this investigation. TERRATRACE does not display estimated, simulated, or placeholder measurements.',
  timeout: 'The requested analysis exceeded the available computation window. No forest-change measurements were generated.',
  failed: 'The analysis could not be completed. No forest-change measurements were generated.',
} as const;

export class ApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
  get offline() {
    return this.status === undefined || this.status === 502 && this.code === undefined || this.status === 504;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      let code: string | undefined;
      let message: string = PUBLIC.failed;
      if (type.includes('json')) {
        const body = await res.json().catch(() => null);
        const d = body?.detail;
        // Only the backend's public user_message is ever shown (never raw server text).
        if (d && typeof d === 'object') { code = d.code; message = d.user_message ?? d.message ?? PUBLIC.failed; }
        else message = PUBLIC.failed;
      }
      throw new ApiError(message, res.status, code);
    }
    // Vite answers unknown paths with index.html — treat as "backend not running".
    if (type.includes('text/html')) throw new ApiError(PUBLIC.unavailable, undefined, 'service_unavailable');
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error).name === 'AbortError') throw new ApiError(PUBLIC.timeout, 504, 'analysis_timeout');
    throw new ApiError(PUBLIC.unavailable, undefined, 'service_unavailable');
  } finally {
    clearTimeout(timer);
  }
}

/** Proxy errors from the dev server (backend down) look like 500/502 without a JSON body. */
const isOffline = (e: unknown) => e instanceof ApiError && (e.status === undefined || ((e.status === 500 || e.status === 502) && !e.code));

let backend: boolean | null = null;

async function withFallback<T>(live: () => Promise<T>, offline: () => Promise<T>): Promise<T> {
  if (backend === false) return offline();
  try {
    const v = await live();
    backend = true;
    return v;
  } catch (e) {
    if (isOffline(e)) { backend = false; return offline(); }
    throw e;
  }
}

const resolveAsset = (p: string) => (p.startsWith('http') || p.startsWith('/') ? p : `${BASE}${p}`);

function normalizeLayers(cat: LayerCatalog): LayerCatalog {
  return { ...cat, overlays: cat.overlays.map((o) => ({ ...o, by_year: Object.fromEntries(Object.entries(o.by_year).map(([y, p]) => [y, resolveAsset(p)])) })) };
}


/** Envelope → UI result. Metrics are only ever taken from a READY envelope. */
export function fromEnvelope(env: AnalysisEnvelope): AnalysisResult {
  const ready = env.analysisStatus === 'READY' && !!env.summary && !!env.events && !!env.layers;
  return {
    id: env.analysis_id,
    status: ready ? 'READY' : env.analysisStatus === 'READY' ? 'ERROR' : env.analysisStatus,
    reason: ready ? null : env.error?.user_message ?? env.reason ?? PUBLIC.failed,
    reasonCode: ready ? null : env.error?.code ?? env.reasonCode ?? 'analysis_failed',
    aoi: env.aoi,
    window: env.window,
    source: env.source,
    error: ready ? null : env.error ?? { code: env.reasonCode ?? 'analysis_failed', user_message: env.reason ?? PUBLIC.failed, retryable: true },
    // Diagnostics are sent only by a DEV_DIAGNOSTICS backend, and shown only in development builds.
    diagnostics: import.meta.env.DEV ? env.diagnostics ?? null : null,
    quality: env.quality ?? null,
    bundle: ready ? { id: env.analysis_id, summary: env.summary!, events: env.events!, layers: normalizeLayers(env.layers!) } : null,
  };
}

/** Random per-request id so the UI can poll the real backend stage of its own request. */
export const newRid = () => globalThis.crypto?.randomUUID?.() ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

let featuredCache: StudyAreaIndex | null = null;
const offlineFeatured = async () => (featuredCache ??= await request<StudyAreaIndex>(`${BASE}data/featured.json`));

export const client = {
  isBackendUp: () => backend,

  async health(): Promise<SystemHealth> {
    // Generous timeout + one retry: during first load the main thread is busy
    // (globe/WebGL start-up) and a short timer can fire before a healthy response is read.
    const probe = () => request<Omit<SystemHealth, 'backend'>>(`${API}/health`, { timeoutMs: 8000 });
    try {
      const h = await probe().catch((e) => (isOffline(e) && e.status === undefined ? Promise.reject(e) : sleep(600).then(probe)));
      backend = true;
      return { ...h, backend: true };
    } catch (e) {
      console.warn('TERRATRACE: backend health check failed — UI preview only', e);
      backend = false;
      return {
        backend: false, status: 'degraded', version: '—', engine: 'TERRATRACE ENGINE', dataMode: 'LIVE',
        analysis: { status: 'offline', detail: 'Live analysis unavailable' },
        explainer: { status: 'offline', detail: 'Unavailable' },
        geocoder: { status: 'offline', detail: 'Offline gazetteer' },
        limits: { max_aoi_km2: 2500, min_aoi_km2: 0.5 },
      };
    }
  },

  /** Featured investigations: AOI definitions only (no results). */
  listStudyAreas(): Promise<StudyAreaIndex> {
    return withFallback(() => request(`${API}/study-areas`), offlineFeatured);
  },

  /** Static base layers (backend-owned URLs). Offline: the backend-generated copy in public/data/basemaps.json. */
  basemaps(): Promise<Basemaps> {
    return withFallback(() => request(`${API}/imagery/basemaps`), () => request(`${BASE}data/basemaps.json`));
  },

  /** Start (or join) an analysis job. Returns immediately; poll getAnalysisJob. */
  async createAnalysisJob(body: { aoi_id?: string; geometry?: AoiGeometry; name?: string; baseline: number; comparison: number }, rid?: string): Promise<AnalysisJob> {
    try {
      const job = await request<AnalysisJob>(`${API}/analysis-jobs${rid ? `?rid=${rid}` : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 20000,
      });
      backend = true;
      return job;
    } catch (e) {
      if (isOffline(e)) { backend = false; throw new ApiError(PUBLIC.unavailable, undefined, 'service_unavailable'); }
      throw e;
    }
  },

  getAnalysisJob(jobId: string): Promise<AnalysisJob> {
    return request<AnalysisJob>(`${API}/analysis-jobs/${encodeURIComponent(jobId)}`, { timeoutMs: 15000 });
  },

  cancelAnalysisJob(jobId: string): Promise<AnalysisJob> {
    return request<AnalysisJob>(`${API}/analysis-jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', timeoutMs: 15000 });
  },

  /** Years outside the analysed window (Time Machine / charts). Never affects the window's result. */
  analysisHistory(id: string, window: { start: number; end: number }): Promise<AnalysisHistory> {
    return request<AnalysisHistory>(`${API}/analysis/${encodeURIComponent(id)}/history?baseline=${window.start}&comparison=${window.end}`, { timeoutMs: ANALYSIS_TIMEOUT_MS });
  },

  /** Stored analysis status (READY / INVALID_ANALYSIS / UNAVAILABLE / RUNNING / NOT_RUN). Read-only: never analyses. */
  analysisStatus(id: string, window: { start: number; end: number }): Promise<{ status: string; reasonCode: string | null; reason: string | null; issueYears?: number[][]; selected_area_km2?: number; maximum_area_km2?: number }> {
    return request(`${API}/analysis-status/${encodeURIComponent(id)}?baseline=${window.start}&comparison=${window.end}`, { timeoutMs: 15000 });
  },

  /** Registers a selected area (no analysis, no Earth Engine) so its live imagery can load before Analyze. */
  registerAoi(geometry: AoiGeometry, name?: string): Promise<StudyArea> {
    return request<StudyArea>(`${API}/aoi`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geometry, name }), timeoutMs: 15000 });
  },

  /** A registered area's geometry + metadata (no analysis). Needed for custom areas opened by link / reload. */
  getAoi(id: string): Promise<StudyArea> {
    return request<StudyArea>(`${API}/aoi/${encodeURIComponent(id)}`, { timeoutMs: 15000 });
  },

  /** Real Earth Engine imagery for an AOI and year. Independent of analysis; never constructed here. */
  async imagery(aoi: string, year: number): Promise<ImageryDecision> {
    if (backend === false) throw new ApiError(PUBLIC.unavailable, undefined, 'service_unavailable');
    try {
      return await request<ImageryDecision>(`${API}/imagery?aoi=${encodeURIComponent(aoi)}&year=${year}`, { timeoutMs: ANALYSIS_TIMEOUT_MS });
    } catch (e) {
      // Connection failure (or the dev proxy's code-less 500/502 when the backend is down) = unreachable.
      // Real HTTP errors (404 / 429 / 500 …) keep their status so the UI can say what actually failed.
      if (isOffline(e)) throw new ApiError(PUBLIC.unavailable, undefined, 'service_unavailable');
      throw e;
    }
  },

  /** Measured per-year imagery availability for the timeline (an error when it cannot be measured). */
  async imageryAvailability(aoi: string): Promise<ImageryAvailability> {
    if (backend === false) throw new ApiError(PUBLIC.unavailable, undefined, 'service_unavailable');
    try {
      return await request<ImageryAvailability>(`${API}/imagery/availability?aoi=${encodeURIComponent(aoi)}`, { timeoutMs: ANALYSIS_TIMEOUT_MS });
    } catch (e) {
      if (isOffline(e)) throw new ApiError(PUBLIC.unavailable, undefined, 'service_unavailable');
      throw e;
    }
  },

  async preview(geometry: AoiGeometry): Promise<AoiPreview> {
    const local = (): AoiPreview => ({
      valid: true, area_km2: geometryAreaKm2(geometry), area_ha: geometryAreaKm2(geometry) * 100,
      centroid: geometryCentroid(geometry), bbox: geometryBbox(geometry), forest_cover_pct: null, forest_source: null,
    });
    if (backend === false) return local();
    try {
      return await request<AoiPreview>(`${API}/aoi/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geometry }), timeoutMs: 15000 });
    } catch (e) {
      if (isOffline(e)) { backend = false; return local(); }
      throw e;
    }
  },

  async search(q: string, featured: StudyAreaIndex | undefined): Promise<{ results: SearchResult[]; notice?: string | null }> {
    const offline = async () => {
      const results: SearchResult[] = [];
      const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (m) {
        const lat = Number(m[1]), lon = Number(m[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) results.push({ name: `${lat}, ${lon}`, detail: 'Coordinates', kind: 'coordinates', center: [lon, lat], bbox: [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05], source: 'input' });
      }
      const nq = q.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
      for (const a of featured?.items ?? []) {
        const hay = `${a.name} ${a.region} ${a.country ?? ''}`.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
        const short = a.short_name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
        if (hay.includes(nq) || nq.includes(short)) results.push({ name: a.name, detail: `Featured investigation · ${a.region}`, kind: 'featured', center: a.center, bbox: a.bbox, study_area_id: a.id, source: 'TERRATRACE' });
      }
      return { results, notice: 'Search is offline — featured investigations and coordinates only.' };
    };
    return withFallback(() => request(`${API}/search?q=${encodeURIComponent(q)}`, { timeoutMs: 9000 }), offline);
  },

  /** Explanations exist only for READY live facts, and only server-side. */
  async explain(facts: ExplanationFacts): Promise<Explanation> {
    const withheld = (notice: string): Explanation => ({ text: NO_ANALYSIS_TEXT, source: 'none', facts_used: 0, generated_at: new Date().toISOString(), notice });
    if (facts.data_mode !== 'LIVE' || facts.analysis_status !== 'READY') return withheld('Explanation withheld: no completed live analysis.');
    if (backend === false) return withheld('Explanations are available only for completed live analyses.');
    return request<Explanation>(`${API}/explain`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ facts }), timeoutMs: 50000 });
  },
};

export const NO_ANALYSIS_TEXT =
  "I don't have a completed satellite analysis for this area yet. Live Earth Engine analysis is required before I can interpret any results — I will not describe changes that have not been measured.";
