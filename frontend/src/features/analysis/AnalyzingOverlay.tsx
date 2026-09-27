import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { client } from '../../data/client';
import { useSelectedAoi } from '../../data/queries';
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

/**
 * Progress for the CURRENT analysis request of the InvestigationState (featured study or candidate AOI).
 * It executes nothing — the analysis runner (data/analysisRunner.ts) does. A failed request for a
 * not-yet-registered candidate AOI is shown here (there is no analysis view for it yet).
 */
export function AnalysisProgressOverlay() {
  const status = useUi((s) => s.investigation.analysisStatus);
  const rid = useUi((s) => s.investigation.analysisRequestId);
  const study = useUi((s) => s.investigation.study);
  const aoiName = useUi((s) => s.investigation.aoi?.name);
  const error = useUi((s) => s.investigation.analysisError);
  const years = useUi((s) => `${s.investigation.baselineYear} → ${s.investigation.comparisonYear}`);
  const featured = useSelectedAoi();
  const [slow, setSlow] = useState(false);
  const running = status === 'running';
  useEffect(() => {
    if (!running) { setSlow(false); return; }
    const t = window.setTimeout(() => setSlow(true), 450);
    return () => window.clearTimeout(t);
  }, [running, rid]);

  if (status === 'error' && !study && error) {
    const code = error.code;
    return (
      <Overlay>
        <StateView
          kind={code === 'aoi_too_large' || code === 'aoi_too_small' ? 'error' : 'service-unavailable'}
          title={code === 'aoi_too_large' || code === 'aoi_too_small' || code === 'invalid_request' ? 'Area cannot be analysed'
            : code === 'analysis_timeout' ? 'Analysis could not be completed' : 'Live analysis unavailable'}
          onRetry={() => useUi.getState().requestAnalysis()}
          action={<Button size="sm" variant="ghost" onClick={() => useUi.getState().resetAnalysis()}>Close</Button>}
        >
          {/* ApiError messages are public product language (data/client.ts) */}
          {error.message}
        </StateView>
      </Overlay>
    );
  }
  if (!running || !slow) return null;
  return (
    <Overlay>
      <StageProgress title="Running live analysis" subtitle={<>{featured?.name ?? study?.name ?? aoiName ?? 'Selected area'} · {years}</>} rid={rid} />
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
