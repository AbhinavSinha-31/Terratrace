import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HEALTH_INTERVAL_MS, useHealth } from '../../data/queries';
import type { SystemHealth } from '../../data/contracts';
import { supabase } from '../../lib/supabase';

/** The nav badge. "online" only when the last completed health check succeeded AND Earth Engine reported ready. */
export type BadgeState = 'online' | 'waking' | 'offline';

/** A check that has not answered after this long is shown as "waking up" (a sleeping free-tier backend). */
export const SLOW_CHECK_MS = 3000;

export function badgeState(health: SystemHealth | undefined, checking: boolean, slow: boolean): BadgeState {
  if (!health) return checking ? 'waking' : 'offline';   // first check still running
  if (checking && slow) return 'waking';
  return health.backend && health.analysis.status === 'ready' ? 'online' : 'offline';
}

export const BADGE: Record<BadgeState, { label: string; short: string; dot: string }> = {
  online: { label: 'Live analysis online', short: 'Online', dot: 'bg-live' },
  waking: { label: 'Waking up…', short: 'Waking', dot: 'bg-warn' },
  offline: { label: 'Analysis offline', short: 'Offline', dot: 'bg-ink-4' },
};

export type Tone = 'ok' | 'pending' | 'down' | 'off';
export interface ServiceRow { key: string; name: string; state: string; tone: Tone; checkedAt: number | null }

/** One row per service, from the last completed check (null = never checked yet). */
export function serviceRows(health: SystemHealth | undefined, healthAt: number | null, community: CommunityCheck): ServiceRow[] {
  const api: Pick<ServiceRow, 'state' | 'tone'> = !health ? { state: 'Checking…', tone: 'pending' }
    : health.backend ? { state: 'Online', tone: 'ok' } : { state: 'Unreachable', tone: 'down' };
  const viaApi = (s: string | undefined, labels: Partial<Record<string, [string, Tone]>>): Pick<ServiceRow, 'state' | 'tone'> => {
    if (!health) return { state: 'Checking…', tone: 'pending' };
    if (!health.backend) return { state: 'Not reachable (API offline)', tone: 'down' };
    const [state, tone] = labels[s ?? ''] ?? ['Unavailable', 'down'];
    return { state, tone };
  };
  return [
    { key: 'api', name: 'Analysis API', ...api, checkedAt: healthAt },
    { key: 'ee', name: 'Earth Engine', checkedAt: healthAt,
      ...viaApi(health?.analysis.status, { ready: ['Ready', 'ok'], unconfigured: ['Not configured', 'off'] }) },
    { key: 'chat', name: 'Ask TerraTrace chat', checkedAt: healthAt,
      ...viaApi(health?.chat?.status, { ready: ['Ready', 'ok'], offline: ['Switched off', 'off'], unconfigured: ['Not configured', 'off'] }) },
    { key: 'community', name: 'Community database', checkedAt: community.checkedAt, state: community.state, tone: community.tone },
  ];
}

export interface CommunityCheck { state: string; tone: Tone; checkedAt: number | null }

/** Reads one row of the public feed (the same view the Community page reads). Online only if that read succeeded. */
function useCommunityCheck(): CommunityCheck {
  const q = useQuery({
    queryKey: ['service-status', 'community'],
    enabled: !!supabase,
    queryFn: async () => {
      const { error } = await supabase!.from('post_feed').select('id').limit(1);
      if (error) throw error;
      return true;
    },
    retry: 2,
    staleTime: HEALTH_INTERVAL_MS - 5000,
    refetchInterval: HEALTH_INTERVAL_MS,
  });
  if (!supabase) return { state: 'Not configured', tone: 'off', checkedAt: null };
  if (q.isSuccess) return { state: 'Online', tone: 'ok', checkedAt: q.dataUpdatedAt };
  if (q.isError) {
    const code = (q.error as { code?: string } | null)?.code;
    const notSetUp = code === 'PGRST205' || code === '42P01';
    return { state: notSetUp ? 'Not set up' : 'Unavailable', tone: 'down', checkedAt: q.errorUpdatedAt };
  }
  return { state: 'Checking…', tone: 'pending', checkedAt: null };
}

/** True once the current fetch has been running for longer than SLOW_CHECK_MS. */
function useSlow(fetching: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!fetching) { setSlow(false); return; }
    const t = window.setTimeout(() => setSlow(true), SLOW_CHECK_MS);
    return () => window.clearTimeout(t);
  }, [fetching]);
  return slow;
}

export function useServiceStatus() {
  const q = useHealth();
  const checking = q.fetchStatus === 'fetching';
  const slow = useSlow(checking);
  const community = useCommunityCheck();
  const healthAt = q.data ? q.dataUpdatedAt : null;
  return {
    health: q.data,
    checking,
    badge: badgeState(q.data, checking, slow),
    rows: serviceRows(q.data, healthAt, community),
  };
}

/** "just now", "40 s ago", "3 min ago" — relative to `now`. */
export function ago(t: number | null, now: number): string {
  if (t == null) return 'not checked yet';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return 'checked just now';
  if (s < 60) return `checked ${s} s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `checked ${m} min ago` : `checked ${Math.floor(m / 60)} h ago`;
}
