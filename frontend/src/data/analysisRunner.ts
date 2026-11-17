import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, PUBLIC, client, fromEnvelope } from './client';
import type { AnalysisJob, AnalysisResult } from './contracts';
import { analysisKey } from './queries';
import { pollDelay } from '../lib/poll';
import { useUi, type AnalysisRequestMeta } from '../state/store';

/** Consecutive failed polls tolerated (a network blip) before the job is reported as unreachable. */
const MAX_POLL_FAILURES = 5;
const TERMINAL = new Set(['READY', 'INVALID_ANALYSIS', 'UNAVAILABLE', 'ERROR', 'CANCELLED']);

/** Only deterministic outcomes may be reused from the cache; anything retryable (timeout, network, throttling,
 *  Earth Engine temporarily unavailable) must be requested again when the user presses Retry. */
const cacheable = (res: { status: string; error?: { retryable?: boolean } | null }) =>
  res.status === 'READY' || res.status === 'INVALID_ANALYSIS' || (res.status === 'UNAVAILABLE' && res.error?.retryable === false);

/** Request ids already dispatched (guards React StrictMode's double effect). */
const dispatched = new Set<string>();
/** False once the runner's host unmounts: every polling loop stops at its next check. */
let mounted = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dev = (...a: unknown[]) => { if (import.meta.env.DEV) console.debug('[analysis]', ...a); };

/**
 * The ONLY place an analysis is executed — as an asynchronous backend JOB.
 *
 * When the InvestigationState is `running` with a new request id, the runner creates a job (POST /api/analysis-jobs),
 * polls its REAL stage (~2 s, backing off to 5 s; see pollDelay) (GET /api/analysis-jobs/{id}) and hands the terminal envelope back through
 * acceptAnalysis / failAnalysis — which apply it only if it still matches the current request, study and years
 * (anything else is a stale response and is discarded). No HTTP request is held open for the computation.
 */
export function useAnalysisRunner(): void {
  const qc = useQueryClient();
  const status = useUi((s) => s.investigation.analysisStatus);
  const rid = useUi((s) => s.investigation.analysisRequestId);
  const studyId = useUi((s) => s.investigation.study?.id ?? null);
  const b = useUi((s) => s.investigation.baselineYear);
  const c = useUi((s) => s.investigation.comparisonYear);

  useEffect(() => { mounted = true; return () => { mounted = false; }; }, []);

  // An opened study with a STORED result for this window shows it at once (GET /api/analysis-result: read-only, never
  // computes — this is not an analysis run). Nothing stored: the study stays "Ready to analyze".
  useEffect(() => {
    if (status !== 'idle' || !studyId) return;
    let alive = true;
    client.storedAnalysis(studyId, { start: b, end: c })
      .then((res) => { if (alive && res && useUi.getState().loadStoredAnalysis({ studyId, baselineYear: b, comparisonYear: c }, res)) dev('stored result', { studyId, b, c, status: res.status }); })
      .catch((e: ApiError) => dev('stored result unavailable', { studyId, code: e.code }));
    return () => { alive = false; };
  }, [status, studyId, b, c]);

  useEffect(() => {
    if (status !== 'running' || !rid || dispatched.has(rid)) return;
    dispatched.add(rid);
    const inv = useUi.getState().investigation;
    const meta: AnalysisRequestMeta = { requestId: rid, studyId: inv.study?.id ?? null, baselineYear: inv.baselineYear, comparisonYear: inv.comparisonYear };
    const window = { start: meta.baselineYear, end: meta.comparisonYear };
    const current = () => mounted && useUi.getState().investigation.analysisRequestId === rid;
    const body = inv.study
      ? { aoi_id: inv.study.id, baseline: window.start, comparison: window.end }
      : inv.aoi ? { geometry: inv.aoi.geometry, name: inv.aoi.name, baseline: window.start, comparison: window.end } : null;
    if (!body) return;
    dev('request', { study: meta.studyId, aoi: inv.aoi?.name ?? null, window, rid });

    const publish = (job: AnalysisJob) =>
      useUi.getState().setAnalysisJob(meta, { id: job.job_id, stage: job.stage, elapsedS: job.elapsed_s, stages: job.stages });

    (async (): Promise<AnalysisResult | null> => {
      let job = await client.createAnalysisJob(body, rid);
      dev('job', { id: job.job_id, status: job.status, stage: job.stage });
      let failures = 0;
      let polls = 0;
      while (!TERMINAL.has(job.status)) {
        if (!current()) return null;                     // superseded, cancelled or unmounted: stop polling
        publish(job);
        await sleep(polls === 0 && job.elapsed_s < 1 ? 400 : pollDelay(polls - 1));   // stored results finish almost at once
        polls++;
        if (!current()) return null;
        try {
          const next = await client.getAnalysisJob(job.job_id);
          if (next.stage !== job.stage) dev('stage', { id: next.job_id, stage: next.stage, elapsed_s: next.elapsed_s });
          job = next;
          failures = 0;
        } catch (e) {
          // 404 = the backend no longer knows the job (e.g. it restarted): report it, never keep polling a ghost.
          if (e instanceof ApiError && e.status === 404) throw new ApiError('The analysis was interrupted (the server restarted). Run it again.', 404, 'analysis_failed');
          if (++failures >= MAX_POLL_FAILURES) throw new ApiError(PUBLIC.unavailable, undefined, 'service_unavailable');
          dev('poll failed — retrying', { id: job.job_id, failures });
        }
      }
      dev('terminal', { id: job.job_id, status: job.status, elapsed_s: job.elapsed_s, stages: job.stages.map((s) => `${s.stage} ${s.duration_s ?? '?'}s`) });
      if (job.status === 'CANCELLED' || !job.result) return null;
      return fromEnvelope(job.result);
    })()
      .then((res) => {
        if (!res) return;
        dev('response', { study: meta.studyId, rid, status: res.status, reasonCode: res.reasonCode, validation: res.quality?.issues?.map((i) => `${i.rule} ${i.years.join('→')}`) ?? [] });
        if (cacheable(res)) qc.setQueryData(analysisKey(res.id, window), res);
        if (!useUi.getState().acceptAnalysis(meta, res)) return;
        // Time Machine / charts: the years OUTSIDE the window come from a separate history request (they never
        // change the window's result). Loaded in the background; if it fails, only the window's years are shown.
        const years = res.bundle?.summary.years ?? [];
        if (res.status === 'READY' && res.bundle && !years.some((y) => y.year < window.start) && window.start > 1984) {
          client.analysisHistory(res.id, window)
            .then((h) => {
              const ok = useUi.getState().mergeHistory({ studyId: res.id, baselineYear: window.start, comparisonYear: window.end, resultId: res.id }, h);
              dev('history', { id: res.id, years: h.years.length, merged: ok });
            })
            .catch((e: ApiError) => dev('history unavailable', { id: res.id, code: e.code, message: e.message }));
        }
      })
      .catch((e: ApiError) => {
        dev('error', { study: meta.studyId, rid, code: e.code, status: e.status, message: e.message });
        useUi.getState().failAnalysis(meta, { code: e.code, message: e.message, retryable: e.retryable });
      });
  }, [status, rid, qc]);
}

/** Cancel the running analysis job (the backend stops at its next stage boundary) and return to "Ready to analyze". */
export async function cancelRunningAnalysis(): Promise<void> {
  const s = useUi.getState();
  const job = s.investigation.analysisJob;
  s.resetAnalysis();   // the runner stops polling (request id no longer current); nothing from this job is shown
  if (job) {
    dev('cancel', { id: job.id });
    await client.cancelAnalysisJob(job.id).catch((e: ApiError) => dev('cancel failed', { id: job.id, message: e.message }));
  }
}
