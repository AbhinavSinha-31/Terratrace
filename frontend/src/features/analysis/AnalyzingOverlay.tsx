import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, X } from 'lucide-react';
import { cancelRunningAnalysis } from '../../data/analysisRunner';
import type { AnalysisJobStage } from '../../data/contracts';
import { useSelectedAoi } from '../../data/queries';
import { useUi } from '../../state/store';
import { Button, Panel, StateView } from '../../design';
import { AREA_REFUSALS } from './Unavailable';

/**
 * REAL analysis stages of the backend job (GET /api/analysis-jobs/{id}, polled by the analysis runner).
 * No percentage is shown: the duration of an Earth Engine computation cannot be predicted, so the indicator
 * is indeterminate and only the actual current stage is highlighted.
 */
const STAGES: [AnalysisJobStage, string][] = [
  ['VALIDATING', 'Validating area'],
  ['PREPARING_IMAGERY', 'Preparing imagery'],
  ['MEASURING_OBSERVATION_COVERAGE', 'Measuring observation coverage & forest cover'],
  // Reported only when a separate request runs (transitions that skip a year without usable imagery).
  ['MEASURING_FOREST_COVER', 'Measuring forest transitions (skipped year)'],
  ['DETECTING_CHANGE', 'Detecting change'],
  ['VALIDATING_RESULT', 'Validating result'],
];
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function StageProgress({ title, subtitle }: { title: string; subtitle: React.ReactNode }) {
  const job = useUi((s) => s.investigation.analysisJob);
  // Elapsed time comes from the backend job; it ticks locally between polls.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [job?.elapsedS]);
  const stage = job?.stage ?? 'QUEUED';
  // Show the optional transitions step only when the backend actually ran it.
  const shown = STAGES.filter(([k]) => k !== 'MEASURING_FOREST_COVER' || job?.stages.some((s) => s.stage === k));
  const idx = shown.findIndex(([k]) => k === stage);
  const label = stage === 'QUEUED' ? 'Waiting for an analysis worker' : shown[idx]?.[1] ?? stage;
  const elapsed = (job?.elapsedS ?? 0) + tick;
  return (
    <div role="status" aria-live="polite" aria-label={`${title}: ${label}`} data-testid="stage-progress" data-stage={stage}>
      <div className="t-label text-accent">Live analysis</div>
      <div className="mt-1 flex items-baseline justify-between gap-3">
        <div className="t-h2">{title}</div>
        <div className="t-data text-[11px] text-ink-3" title="Elapsed time" data-testid="elapsed">Elapsed {mmss(elapsed)}</div>
      </div>
      <div className="mt-1 text-[12px] text-ink-3">{subtitle}</div>
      <div className="tt-indeterminate mt-4 h-1 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden>
        <motion.div className="h-full w-1/3 rounded-full bg-accent" animate={{ x: ['-100%', '300%'] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }} />
      </div>
      <div className="mt-3 text-[12px] text-ink-2">Current stage: <span className="text-ink" data-testid="current-stage">{label}</span></div>
      <ol className="mt-3 space-y-1.5 text-[12px]">
        {shown.map(([k, lbl], i) => {
          const done = idx > i;
          const active = idx === i;
          const took = job?.stages.find((s) => s.stage === k)?.duration_s;
          return (
            <li key={k} className={`flex items-center gap-2.5 ${active ? 'text-ink' : done ? 'text-ink-2' : 'text-ink-4'}`}>
              <span className={`grid h-4 w-4 place-items-center rounded-full ${done ? 'bg-accent/20 text-accent' : active ? 'shadow-[0_0_0_1.5px_rgba(69,208,196,0.8)]' : 'shadow-[0_0_0_1px_rgba(255,255,255,0.15)]'}`}>
                {done ? <Check size={10} /> : active ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> : null}
              </span>
              {lbl}
              {done && took != null && <span className="t-data ml-auto text-[10.5px] text-ink-4">{took.toFixed(1)}s</span>}
            </li>
          );
        })}
      </ol>
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-[11px] leading-relaxed text-ink-4">No partial or estimated results are shown.</p>
        <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => void cancelRunningAnalysis()} data-testid="cancel-analysis">Cancel analysis</Button>
      </div>
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
    const refused = !!code && (AREA_REFUSALS.has(code) || code === 'invalid_request');
    // Retry is offered only when it can succeed (never for an area refused as drawn).
    const canRetry = error.retryable !== false && !refused;
    return (
      <Overlay>
        <StateView
          kind={refused ? 'error' : 'service-unavailable'}
          title={refused ? 'Area cannot be analysed'
            : code === 'analysis_timeout' ? 'Analysis could not be completed' : 'Live analysis unavailable'}
          onRetry={canRetry ? () => useUi.getState().requestAnalysis() : undefined}
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
      <StageProgress title="Processing" subtitle={<>{featured?.name ?? study?.name ?? aoiName ?? 'Selected area'} · {years}</>} />
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
