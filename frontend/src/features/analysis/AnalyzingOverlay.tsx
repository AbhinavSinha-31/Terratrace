import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { client, ApiError, newRid } from '../../data/client';
import { analysisKey, useCurrentAnalysis, useSelectedAoi } from '../../data/queries';
import { useUi } from '../../state/store';
import { Button, Panel, StateView } from '../../design';

/**
 * REAL analysis stages, reported by the backend for this request (GET /api/progress/<rid>).
 * No percentage is shown: the duration of an Earth Engine computation cannot be predicted,
 * so the indicator is indeterminate and only the actual current stage is highlighted.
 */
const STAGES: [string, string][] = [
  ['validating_aoi', 'Validating area'],
  ['preparing_imagery', 'Preparing imagery'],
  ['measuring_coverage', 'Measuring observation coverage'],
  ['measuring_forest', 'Measuring forest cover'],
  ['detecting_change', 'Detecting change'],
  ['validating_result', 'Validating result'],
];

function StageProgress({ title, subtitle, rid }: { title: string; subtitle: React.ReactNode; rid: string | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [rid]);
  const p = useQuery({
    queryKey: ['progress', rid],
    queryFn: () => client.progress(rid!),
    enabled: !!rid,
    refetchInterval: 1000,
    retry: false,
  });
  const current = p.data?.stage ?? null;
  const idx = current ? STAGES.findIndex(([k]) => k === current) : -1;
  return (
    <div role="status" aria-live="polite" aria-label={`${title}: ${current ? STAGES[idx]?.[1] : 'starting'}`} data-testid="stage-progress" data-stage={current ?? ''}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="t-h2">{title}</div>
        <div className="t-data text-[11px] text-ink-3" title="Elapsed time">{elapsed}s</div>
      </div>
      <div className="mt-1 text-[12px] text-ink-3">{subtitle}</div>
      <div className="tt-indeterminate mt-4 h-1 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden>
        <motion.div className="h-full w-1/3 rounded-full bg-accent" animate={{ x: ['-100%', '300%'] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }} />
      </div>
      <ol className="mt-4 space-y-1.5 text-[12px]">
        {STAGES.map(([k, label], i) => {
          const done = idx > i;
          const active = idx === i;
          return (
            <li key={k} className={`flex items-center gap-2.5 ${active ? 'text-ink' : done ? 'text-ink-2' : 'text-ink-4'}`}>
              <span className={`grid h-4 w-4 place-items-center rounded-full ${done ? 'bg-accent/20 text-accent' : active ? 'shadow-[0_0_0_1.5px_rgba(69,208,196,0.8)]' : 'shadow-[0_0_0_1px_rgba(255,255,255,0.15)]'}`}>
                {done ? <Check size={10} /> : active ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> : null}
              </span>
              {label}
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-[11px] leading-relaxed text-ink-4">
        Live Earth observation typically takes under two minutes for areas around 100 km². No partial or estimated results are shown.
      </p>
    </div>
  );
}

/** Runs a pending custom-AOI analysis. Non-READY results open the area with its status panel. */
export function CustomAnalysisRunner() {
  const pending = useUi((s) => s.pending);
  const qc = useQueryClient();
  const [state, setState] = useState<{ nonce: number; rid: string; error: ApiError | null } | null>(null);

  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const rid = newRid();
    setState({ nonce: pending.nonce, rid, error: null });
    client.analyze(pending.request, rid)
      .then((result) => {
        if (!alive) return;
        const b = pending.request.baseline_period.year, c = pending.request.comparison_period.year;
        qc.setQueryData(analysisKey(result.id, { start: b, end: c }), result);
        useUi.getState().openAnalysis(result.id, { window: { start: b, end: c } });
        useUi.getState().clearPending();
      })
      .catch((e: ApiError) => alive && setState({ nonce: pending.nonce, rid, error: e }));
    return () => { alive = false; };
  }, [pending, qc]);

  if (!pending) return null;
  const retry = () => useUi.getState().startAnalysis(pending.request);

  return (
    <Overlay>
      {state?.error ? (
        <StateView
          kind={state.error.code === 'aoi_too_large' || state.error.code === 'aoi_too_small' ? 'error' : 'service-unavailable'}
          title={state.error.code === 'aoi_too_large' || state.error.code === 'aoi_too_small' || state.error.code === 'invalid_request' ? 'Area cannot be analysed'
            : state.error.code === 'analysis_timeout' ? 'Analysis could not be completed' : 'Live analysis unavailable'}
          onRetry={retry}
          action={<Button size="sm" variant="ghost" onClick={() => useUi.getState().clearPending()}>Close</Button>}
        >
          {/* ApiError messages are public product language (data/client.ts) */}
          {state.error.message}
        </StateView>
      ) : (
        <StageProgress
          title="Running live analysis"
          subtitle={<>{pending.request.name ?? 'Custom area'} · {pending.request.baseline_period.year} → {pending.request.comparison_period.year}</>}
          rid={state?.rid ?? null}
        />
      )}
    </Overlay>
  );
}

/** Shown only while a featured area's analysis request is genuinely in flight (after a short delay). */
export function EntryOverlay() {
  const q = useCurrentAnalysis();
  const aoi = useSelectedAoi();
  const rid = useUi((s) => s.activeRid);
  const [slow, setSlow] = useState(false);
  const loading = q.isLoading;
  useEffect(() => {
    if (!loading) { setSlow(false); return; }
    const t = window.setTimeout(() => setSlow(true), 450);
    return () => window.clearTimeout(t);
  }, [loading]);
  // Custom areas opened from a link have no name until the response arrives — still show progress.
  if (!loading || !slow) return null;
  return (
    <Overlay>
      <StageProgress title="Running live analysis" subtitle={aoi?.name ?? 'Selected area'} rid={rid} />
    </Overlay>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <AnimatePresence>
      <motion.div key="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-0 z-[60] grid place-items-center p-6">
        <motion.div initial={{ y: 12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }} className="pointer-events-auto w-[min(420px,100%)]">
          <Panel className="p-6">{children}</Panel>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
