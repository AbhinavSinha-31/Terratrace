import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { client, newRid } from './client';
import type { AnalysisBundle, AnalysisResult, ChangeEvent, ExplanationFacts, StudyArea } from './contracts';
import { useUi } from '../state/store';
import { windowKpis } from '../lib/windowStats';
import { DEFAULT_ANALYSIS_WINDOW } from '../lib/time';

export const useHealth = () => useQuery({ queryKey: ['health'], queryFn: () => client.health(), staleTime: 20000, refetchInterval: 30000 });

export const useStudyAreas = () => useQuery({ queryKey: ['study-areas'], queryFn: () => client.listStudyAreas(), staleTime: Infinity });

type Win = { start: number; end: number };
const req = (w: Win) => ({ baseline_year: w.start, comparison_year: w.end });

/** Query key = area + REQUESTED window (the store's canonical window). Custom analyses are seeded here by the analyze flow. */
export const analysisKey = (id: string | null, w: Win) => ['analysis', id, w.start, w.end] as const;

export function useAnalysis(id: string | null) {
  const win = useUi((s) => s.window);
  return useQuery({
    queryKey: analysisKey(id, win),
    queryFn: () => {
      const rid = newRid();
      useUi.setState({ activeRid: rid });
      return client.getAnalysis(id!, req(win), rid);
    },
    enabled: !!id,
    staleTime: Infinity,
    retry: 0,
  });
}

export function useCurrentAnalysis() {
  const id = useUi((s) => s.aoiId);
  return useAnalysis(id);
}

/** Measured results of the open area — null unless the live analysis is READY. */
export function useCurrentBundle(): AnalysisBundle | null {
  return useCurrentAnalysis().data?.bundle ?? null;
}

/** READY analyses already in the cache (for global hotspots). Never triggers analysis. */
export function useReadyResults(): AnalysisResult[] {
  const areas = useStudyAreas().data?.items ?? [];
  const results = useQueries({
    queries: areas.map((a) => ({ queryKey: analysisKey(a.id, DEFAULT_ANALYSIS_WINDOW), queryFn: () => client.getAnalysis(a.id, req(DEFAULT_ANALYSIS_WINDOW)), enabled: false, staleTime: Infinity })),
  });
  const ready = results.map((r) => r.data).filter((r): r is AnalysisResult => r?.status === 'READY');
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

/** The StudyArea for the open analysis (featured list entry or the analysis' own AOI). */
export function useSelectedAoi(): StudyArea | null {
  const id = useUi((s) => s.aoiId);
  const featured = useStudyAreas().data?.items.find((a) => a.id === id);
  const analysis = useCurrentAnalysis().data;
  return featured ?? analysis?.aoi ?? null;
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

/** KPIs for the active analysis window — null unless READY. */
export function useWindowKpis() {
  const win = useUi((s) => s.window);
  const bundle = useCurrentBundle();
  return useMemo(() => (bundle ? windowKpis(bundle.summary, bundle.events.features, win.start, win.end) : null), [bundle, win.start, win.end]);
}
