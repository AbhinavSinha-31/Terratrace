import { AnimatePresence } from 'framer-motion';
import { ArrowUpRight, MessageSquarePlus, Trash2 } from 'lucide-react';
import { Button, Skeleton, StateView } from '../../design';
import { fmtHa, fmtKm2 } from '../../lib/format';
import { useUi } from '../../state/store';
import { openSignIn, useAuth } from '../../state/auth';
import { FullPage } from '../shell/FullPage';
import { startDiscussion } from '../community/compose';
import { useDeleteScan, useSavedScans, type SavedScan } from './scans';

const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtHa(Math.abs(v))} ha`;

function ScanRow({ scan }: { scan: SavedScan }) {
  const del = useDeleteScan();
  const s = scan.summary;
  const reopen = () => {
    useUi.getState().closePage();
    useUi.getState().openAnalysis(scan.aoi_id, { name: scan.name, window: { start: scan.baseline, end: scan.comparison } });
  };
  return (
    <li className="tt-panel flex flex-wrap items-center gap-x-5 gap-y-3 p-4" data-testid="saved-scan">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold text-ink">{scan.name}</div>
        <div className="t-data mt-0.5 text-[11.5px] text-ink-3">{scan.baseline}–{scan.comparison} · saved {scan.created_at.slice(0, 10)}{s.area_km2 ? ` · ${fmtKm2(s.area_km2)} km²` : ''}</div>
      </div>
      <dl className="flex gap-5 text-[11.5px]">
        <div><dt className="text-ink-4">Status</dt><dd className="t-data text-ink-2">{s.status}</dd></div>
        {s.net_change_ha != null && <div><dt className="text-ink-4">Net forest change</dt><dd className="t-data text-ink">{signed(s.net_change_ha)}</dd></div>}
        {s.event_count != null && <div><dt className="text-ink-4">Events</dt><dd className="t-data text-ink">{s.event_count}</dd></div>}
      </dl>
      <div className="flex gap-2">
        <Button size="sm" variant="brand" icon={<ArrowUpRight size={14} />} onClick={reopen} data-testid="reopen-scan">Open</Button>
        <Button size="sm" variant="secondary" icon={<MessageSquarePlus size={14} />} onClick={() => startDiscussion({ aoiId: scan.aoi_id, name: scan.name, baseline: scan.baseline, comparison: scan.comparison, scanId: scan.id, bbox: scan.bbox })}>Discuss</Button>
        <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={del.isPending} onClick={() => { if (window.confirm(`Remove "${scan.name}" from My scans?`)) del.mutate(scan.id); }} aria-label={`Remove ${scan.name}`} />
      </div>
    </li>
  );
}

function Body() {
  const status = useAuth((s) => s.status);
  const { data, isLoading, isError, refetch } = useSavedScans();
  if (status === 'unconfigured') return <StateView kind="empty" title="Accounts are not available yet">Saving scans needs an account, which is not switched on for this version.</StateView>;
  if (status !== 'signed-in') {
    return <StateView kind="empty" title="Sign in to see your scans" action={<Button size="sm" variant="brand" onClick={() => openSignIn('Sign in to see the scans you saved.')}>Sign in</Button>}>Saved scans belong to your account.</StateView>;
  }
  if (isLoading) return <div className="space-y-3"><Skeleton className="h-20 rounded-md" /><Skeleton className="h-20 rounded-md" /></div>;
  if (isError) return <StateView kind="error" title="Your scans could not be loaded" onRetry={() => refetch()}>Check your connection and try again.</StateView>;
  if (!data?.length) return <StateView kind="empty" title="No saved scans yet">Open an analysis and press “Save scan” to keep it here.</StateView>;
  return <ul className="space-y-3">{data.map((s) => <ScanRow key={s.id} scan={s} />)}</ul>;
}

/** #/scans — the signed-in user's saved analyses (Supabase, owner-only). */
export function MyScansPage() {
  const open = useUi((s) => s.page?.kind === 'scans');
  return (
    <AnimatePresence>
      {open && (
        <FullPage pageKey="scans" titleId="scans-title" testId="scans-page" onBack={() => useUi.getState().closePage()}>
          <h1 id="scans-title" className="t-h1 mb-1 text-ink">My scans</h1>
          <p className="mb-6 text-[12.5px] text-ink-3">The figures here are a snapshot from when you saved; opening a scan shows the stored analysis itself.</p>
          <Body />
        </FullPage>
      )}
    </AnimatePresence>
  );
}
