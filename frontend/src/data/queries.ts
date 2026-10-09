import { useEffect, useMemo, useRef } from 'react';
import { skipToken, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, client } from './client';
import type { AnalysisBundle, AnalysisResult, ChangeEvent, ExplanationFacts, StudyArea } from './contracts';
import { selectCandidate, useUi } from '../state/store';
import { DEFAULT_ANALYSIS_WINDOW } from '../lib/time';
import { fmtKm2 } from '../lib/format';

// While the backend is unreachable, re-check every 5 s — also in a background tab — so the UI notices it is back.
export const useHealth = () => useQuery({
  queryKey: ['health'], queryFn: () => client.health(), staleTime: 20000,
  refetchInterval: (q) => (q.state.data?.backend === false ? 5000 : 30000),
  refetchIntervalInBackground: true,
});

/**
 * Regression (2026-10-09): after a backend outage the UI stayed in UI-preview mode until a manual reload — data
 * loaded through the offline fallback (featured list, basemaps) is cached forever and error states (imagery "could
 * not be reached") were never re-requested. When health flips from unreachable to reachable, refetch everything once
 * from the live backend. Nothing is substituted in between: offline states stay explicit until real data arrives.
 */
export function useBackendRecovery(): void {
  const qc = useQueryClient();
  const up = useHealth().data?.backend;
  const prev = useRef(up);
  useEffect(() => {
    if (prev.current === false && up === true) void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'health' });
    prev.current = up;
  }, [up, qc]);
}

export const useBasemaps = () => useQuery({ queryKey: ['basemaps'], queryFn: () => client.basemaps(), staleTime: Infinity, retry: false });

/** Real imagery for an AOI + year (backend decision). Never an analysis; never triggers one. */
export const useImageryDecision = (aoi: string | null, year: number) =>
  useQuery({
    queryKey: ['imagery', aoi, year], queryFn: aoi ? () => client.imagery(aoi, year) : skipToken, staleTime: 10 * 60_000,
    // Only a 429 (throttled) is retried, exactly once; every other failure is shown as it is.
    retry: (n, e) => n < 1 && e instanceof ApiError && e.status === 429, retryDelay: 1500,
  });

/**
 * The candidate selection (search / drawn / clicked area, no study yet) registered with the backend so its
 * live imagery can load before any analysis. Registration is cheap (validation only) and never analyses.
 */
export function useCandidateAoi(): StudyArea | null {
  const candidate = useUi(selectCandidate);
  const geometry = candidate?.geometry ?? null;
  const q = useQuery({
    queryKey: ['aoi-register', geometry ? JSON.stringify(geometry.coordinates) : null],
    queryFn: geometry ? () => client.registerAoi(geometry, candidate?.name) : skipToken,
    staleTime: Infinity, retry: false,
  });
  return geometry ? q.data ?? null : null;
}

export type CardStatus = 'Not run' | 'Processing' | 'Analysis ready' | 'Scientific validation required' | 'Analysis failed' | 'Area exceeds limit' | 'Unavailable' | '…';

/**
 * Featured card status, derived from REAL state — never a static label:
 *   1. the live investigation, when this study is the one open (running / its result / its error);
 *   2. otherwise the backend's stored outcome for the default window (/api/analysis-status — read-only).
 */
export function useStudyCardStatus(id: string): CardStatus {
  return useStudyCard(id).status;
}

/** Card status plus a short, factual detail (why validation failed / why unavailable) and the full reason. */
/**
 * Stored outcome + headline KPIs of every featured investigation for its DEFAULT window (read-only). Re-read whenever
 * the open investigation's analysis settles, so returning to the cards / overview shows the new state.
 */
export function useFeaturedSummary() {
  const health = useHealth().data;
  const settled = useUi((s) => `${s.investigation.study?.id ?? ''}:${s.investigation.analysisStatus}:${s.investigation.analysisRequestId ?? ''}`);
  return useQuery({
    queryKey: ['featured-summary', settled],
    queryFn: health?.backend === false ? skipToken : () => client.featuredSummary(),
    staleTime: 30_000, retry: false, placeholderData: (prev) => prev,
  });
}

export function useStudyCard(id: string): { status: CardStatus; detail: string | null; reason: string | null } {
  const inv = useUi((s) => s.investigation);
  const health = useHealth().data;
  const summary = useFeaturedSummary();
  const item = summary.data?.items.find((i) => i.id === id);
  const win = item?.default_window ?? [DEFAULT_ANALYSIS_WINDOW.start, DEFAULT_ANALYSIS_WINDOW.end];
  const isThis = inv.study?.id === id && inv.baselineYear === win[0] && inv.comparisonYear === win[1];
  const stored = { data: item, isError: summary.isError };
  // The card shows the REAL failure category from the backend: an oversized area is a deterministic AOI validation
  // result, never a scientific one; a failed validity check is never shown as "unavailable".
  const fromResult = (s: string | undefined | null, code?: string | null): CardStatus | null =>
    code === 'analysis_too_large' ? 'Area exceeds limit'
      // ERROR = the computation failed (e.g. timed out); UNAVAILABLE = a required service/data is missing. Never merged.
      : s === 'READY' ? 'Analysis ready' : s === 'INVALID_ANALYSIS' ? 'Scientific validation required' : s === 'ERROR' ? 'Analysis failed'
      : s === 'UNAVAILABLE' ? 'Unavailable' : s === 'RUNNING' || s === 'PROCESSING' ? 'Processing' : null;
  // The status already says the area is too large; the detail adds the limit itself — the backend's interactive
  // analysis limit (the value the check uses), never the larger selection limit (max_aoi_km2).
  const limitDetail = (max?: number | null) => {
    const limit = max ?? health?.limits.interactive_max_km2;
    return limit ? `max ${fmtKm2(limit)} km²` : null;
  };
  const pairs = (ys: number[][] | undefined) => (ys?.length ? `unstable forest mask ${ys.map(([a, b]) => `${a}→${String(b).slice(2)}`).join(', ')}` : null);
  const card = (status: CardStatus, detail: string | null = null, reason: string | null = null) => ({ status, detail, reason });
  if (isThis) {
    const r = inv.analysisResult;
    if (inv.analysisStatus === 'running') return card('Processing', 'live Earth Engine computation');
    if (inv.analysisStatus === 'complete') {
      const s = fromResult(r?.status, r?.reasonCode) ?? 'Unavailable';
      return card(s, s === 'Scientific validation required' ? pairs(r?.quality?.issues.map((i) => i.years)) : s === 'Area exceeds limit' ? limitDetail() : s === 'Unavailable' || s === 'Analysis failed' ? r?.reason ?? null : null, r?.reason ?? null);
    }
    if (inv.analysisStatus === 'error') {
      // No envelope came back: a service that could not be reached is Unavailable; anything else is a failed analysis.
      const code = inv.analysisError?.code;
      const unreachable = !code || ['earth_engine_unreachable', 'service_unavailable'].includes(code);
      return card(unreachable ? 'Unavailable' : 'Analysis failed', inv.analysisError?.message ?? null, inv.analysisError?.message ?? null);
    }
  }
  if (!health) return card('…');
  if (health.backend === false) return card('Unavailable', 'backend offline');
  const d = stored.data;
  const s = fromResult(d?.status, d?.reasonCode);
  if (s) return card(s, s === 'Scientific validation required' ? pairs(d?.issueYears) : s === 'Area exceeds limit' ? limitDetail(d?.maximum_area_km2) : s === 'Unavailable' ? d?.reason ?? null : null, d?.reason ?? null);
  if (d?.status === 'NOT_RUN') return health.analysis.status === 'ready' ? card('Not run', 'click to run live analysis') : card('Unavailable', 'Earth Engine unavailable');
  return card(stored.isError ? 'Unavailable' : '…');
}

/**
 * Reference context (terrain, forest cover) of the open area — shown whatever the analysis status. An UNAVAILABLE
 * context (Earth Engine throttled, …) is re-requested after a minute; it is never filled in.
 */
export const useAreaContext = (aoi: string | null) => {
  const backend = useHealth().data?.backend;
  return useQuery({
    queryKey: ['area-context', aoi],
    queryFn: aoi && backend !== false ? () => client.areaContext(aoi) : skipToken,
    staleTime: (q) => (q.state.data?.status === 'UNAVAILABLE' ? 60_000 : Infinity),
    refetchInterval: (q) => (q.state.data?.status === 'UNAVAILABLE' ? 60_000 : false),
    retry: false,
  });
};

/** Measured per-year availability for the timeline. */
export const useImageryAvailability = (aoi: string | null) =>
  useQuery({ queryKey: ['imagery-availability', aoi], queryFn: aoi ? () => client.imageryAvailability(aoi) : skipToken, staleTime: 10 * 60_000, retry: false });

export const useStudyAreas = () => useQuery({ queryKey: ['study-areas'], queryFn: () => client.listStudyAreas(), staleTime: Infinity });

type Win = { start: number; end: number };

/** Query key = area + REQUESTED window (the store's canonical window). Custom analyses are seeded here by the analyze flow. */
export const analysisKey = (id: string | null, w: Win) => ['analysis', id, w.start, w.end] as const;

/**
 * The active investigation's analysis — a READ-ONLY view of InvestigationState (state/store.ts).
 * Requests are executed only by the analysis runner (data/analysisRunner.ts); `refetch` issues a
 * new explicit request. The shape mirrors a query result so components stay unchanged.
 */
export function useCurrentAnalysis() {
  const status = useUi((s) => s.investigation.analysisStatus);
  const result = useUi((s) => s.investigation.analysisResult);
  const error = useUi((s) => s.investigation.analysisError);
  return {
    data: result ?? undefined,
    status,
    isLoading: status === 'running',
    isFetching: status === 'running',
    isError: status === 'error',
    error,
    refetch: () => useUi.getState().requestAnalysis(),
  };
}

/** Measured results of the open area — null unless the live analysis is READY. */
export function useCurrentBundle(): AnalysisBundle | null {
  return useUi((s) => s.investigation.analysisResult?.bundle ?? null);
}

/** READY analyses already in the cache (for global hotspots). Never triggers analysis. */
export function useReadyResults(): AnalysisResult[] {
  const areas = useStudyAreas().data?.items ?? [];
  const results = useQueries({
    // Cache-ONLY (skipToken): reads results the user explicitly ran; this can never fetch an analysis.
    queries: areas.map((a) => ({ queryKey: analysisKey(a.id, DEFAULT_ANALYSIS_WINDOW), queryFn: skipToken, staleTime: Infinity })),
  });
  const ready = results.map((r) => r.data as AnalysisResult | undefined).filter((r): r is AnalysisResult => r?.status === 'READY');
  const key = ready.map((r) => r.id).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ready, [key]);
}

export const useExplanation = (facts: ExplanationFacts | null, enabled: boolean) =>
  useQuery({
    queryKey: ['explanation', facts?.event_id],
    queryFn: () => client.explain(facts!),
    enabled: !!facts && enabled,
    staleTime: Infinity,
    retry: false,
  });

/**
 * The StudyArea of the active investigation: featured list entry, the analysis' own AOI, or — for a custom
 * area opened before any analysis (link / reload) — its registered definition from /api/aoi/{id}.
 */
export function useSelectedAoi(): StudyArea | null {
  const id = useUi((s) => s.investigation.study?.id ?? null);
  const featuredList = useStudyAreas().data;
  const featured = featuredList?.items.find((a) => a.id === id);
  const analysis = useUi((s) => s.investigation.analysisResult);
  const fromResult = analysis && analysis.id === id ? analysis.aoi : null;
  const needDoc = !!id && !!featuredList && !featured && !fromResult;
  const doc = useQuery({ queryKey: ['aoi', id], queryFn: needDoc ? () => client.getAoi(id!) : skipToken, staleTime: Infinity, retry: false });
  return featured ?? fromResult ?? (doc.data && doc.data.id === id ? doc.data : null);
}

/** Events passing the severity/type filters (all years). Empty unless READY. */
export function useFilteredEvents(): ChangeEvent[] {
  const sev = useUi((s) => s.severityFilter);
  const types = useUi((s) => s.typeFilter);
  const bundle = useCurrentBundle();
  return useMemo(
    () => (bundle?.events.features ?? []).filter((f) => sev[f.properties.severity.class] && types[f.properties.change_type] !== false),
    [bundle, sev, types],
  );
}

export function useSelectedEvent(): ChangeEvent | null {
  const id = useUi((s) => s.selectedEventId);
  const bundle = useCurrentBundle();
  return bundle?.events.features.find((f) => f.id === id) ?? null;
}
