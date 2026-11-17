import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../state/auth';
import type { AnalysisResult } from '../../data/contracts';

/** A row of public.saved_scans (supabase/migrations/20261117120000_saved_scans.sql). RLS: the owner only. */
export interface SavedScan {
  id: string;
  user_id: string;
  aoi_id: string;
  name: string;
  baseline: number;
  comparison: number;
  /** Headline figures at save time — a snapshot for the list. Reopening always reads the backend's stored result. */
  summary: ScanSummary;
  bbox: [number, number, number, number] | null;
  created_at: string;
}

export interface ScanSummary {
  status: string;
  forest_baseline_ha?: number | null;
  forest_latest_ha?: number | null;
  net_change_ha?: number | null;
  net_change_pct?: number | null;
  total_loss_ha?: number | null;
  total_gain_ha?: number | null;
  event_count?: number;
  area_km2?: number | null;
}

/** The figures a saved scan keeps: only measured values from the result itself (nothing computed here). */
export function scanSummary(res: AnalysisResult): ScanSummary {
  const k = res.bundle?.summary.kpis;
  return {
    status: res.status,
    ...(k ? {
      forest_baseline_ha: k.forest_baseline_ha, forest_latest_ha: k.forest_latest_ha, net_change_ha: k.net_change_ha,
      net_change_pct: k.net_change_pct, total_loss_ha: k.total_loss_ha, total_gain_ha: k.total_gain_ha, event_count: k.event_count,
    } : {}),
    area_km2: res.aoi.area_km2 ?? null,
  };
}

const userId = () => useAuth.getState().session?.user.id ?? null;

export function useSavedScans() {
  const uid = useAuth((s) => s.session?.user.id ?? null);
  return useQuery({
    queryKey: ['saved-scans', uid],
    queryFn: uid && supabase
      ? async () => {
        const { data, error } = await supabase!.from('saved_scans').select('*').order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        return data as SavedScan[];
      }
      : skipToken,
    staleTime: 30_000,
  });
}

export function useSaveScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (res: AnalysisResult) => {
      if (!supabase || !userId()) throw new Error('Sign in to save scans.');
      const row = {
        aoi_id: res.id, name: res.aoi.name.slice(0, 120),
        baseline: res.window.baseline_year, comparison: res.window.comparison_year,
        summary: scanSummary(res), bbox: res.aoi.bbox ?? null,
      };
      // Saving the same area + window again refreshes its figures instead of failing on the unique key.
      const { data, error } = await supabase.from('saved_scans').upsert(row, { onConflict: 'user_id,aoi_id,baseline,comparison' }).select().single();
      if (error) throw error;
      return data as SavedScan;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-scans'] }),
  });
}

export function useDeleteScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) throw new Error('Not signed in.');
      const { error } = await supabase.from('saved_scans').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-scans'] }),
  });
}

/** Is this area + window already in My scans? */
export function useIsSaved(aoiId: string | undefined, b: number, c: number) {
  const { data } = useSavedScans();
  return !!data?.some((s) => s.aoi_id === aoiId && s.baseline === b && s.comparison === c);
}
