import { useMemo } from 'react';
import { skipToken, useQueries, useQuery } from '@tanstack/react-query';
import { ApiError, client } from './client';
import type { AnalysisBundle, AnalysisResult, ChangeEvent, ExplanationFacts, StudyArea } from './contracts';
import { useUi } from '../state/store';
import { DEFAULT_ANALYSIS_WINDOW } from '../lib/time';

export const useHealth = () => useQuery({ queryKey: ['health'], queryFn: () => client.health(), staleTime: 20000, refetchInterval: 30000 });

export const useBasemaps = () => useQuery({ queryKey: ['basemaps'], queryFn: () => client.basemaps(), staleTime: Infinity, retry: false });

/** Real imagery for an AOI + year (backend decision). Never an analysis; never triggers one. */
export const useImageryDecision = (aoi: string | null, year: number) =>
  useQuery({
    queryKey: ['imagery', aoi, year], queryFn: aoi ? () => client.imagery(aoi, year) : skipToken, staleTime: 10 * 60_000,
    // Only a 429 (throttled) is retried, exactly once; every other failure is shown as it is.
    retry: (n, e) => n < 1 && e instanceof ApiError && e.status === 429, retryDelay: 1500,
  });

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

/** The StudyArea of the active investigation (featured list entry or the analysis' own AOI). */
export function useSelectedAoi(): StudyArea | null {
  const id = useUi((s) => s.investigation.study?.id ?? null);
  const featured = useStudyAreas().data?.items.find((a) => a.id === id);
  const analysis = useUi((s) => s.investigation.analysisResult);
  return featured ?? (analysis && analysis.id === id ? analysis.aoi : null);
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
