import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { client, type ApiError } from './client';
import { analysisKey } from './queries';
import { useUi, type AnalysisRequestMeta } from '../state/store';

/** Request ids already dispatched (guards React StrictMode's double effect). */
const dispatched = new Set<string>();

/**
 * The ONLY place an analysis request is executed.
 *
 * Watches InvestigationState; when an analysis is `running` with a new request id it performs the
 * request (GET for a registered study, POST for a candidate AOI) and hands the response back through
 * acceptAnalysis / failAnalysis, which apply it ONLY if it still matches the current request id,
 * study and years (otherwise it is a stale response and is discarded).
 * React Query is used purely as the fetch cache for registered-study results.
 */
export function useAnalysisRunner(): void {
  const qc = useQueryClient();
  const status = useUi((s) => s.investigation.analysisStatus);
  const rid = useUi((s) => s.investigation.analysisRequestId);

  useEffect(() => {
    if (status !== 'running' || !rid || dispatched.has(rid)) return;
    dispatched.add(rid);
    const inv = useUi.getState().investigation;
    const meta: AnalysisRequestMeta = { requestId: rid, studyId: inv.study?.id ?? null, baselineYear: inv.baselineYear, comparisonYear: inv.comparisonYear };
    const window = { start: meta.baselineYear, end: meta.comparisonYear };

    let run: Promise<Awaited<ReturnType<typeof client.getAnalysis>>> | null = null;
    if (inv.study) {
      const key = analysisKey(inv.study.id, window);
      const studyId = inv.study.id;
      run = qc.fetchQuery({
        queryKey: key,
        queryFn: () => client.getAnalysis(studyId, { baseline_year: meta.baselineYear, comparison_year: meta.comparisonYear }, rid),
        staleTime: Infinity,
        // One Run = exactly one request. (fetchQuery would inherit the app-wide `retry: 1` and silently
        // re-send a failed analysis; retrying is the user's explicit Retry action.)
        retry: false,
      }).then((res) => {
        // A computation error (e.g. timeout) is not a deterministic result: never serve it from cache.
        if (res.status === 'ERROR') qc.removeQueries({ queryKey: key, exact: true });
        return res;
      });
    } else if (inv.aoi) {
      run = client.analyze({
        geometry: inv.aoi.geometry,
        baseline_period: { year: meta.baselineYear },
        comparison_period: { year: meta.comparisonYear },
        name: inv.aoi.name,
      }, rid).then((res) => {
        if (res.status !== 'ERROR') qc.setQueryData(analysisKey(res.id, window), res);
        return res;
      });
    }
    if (!run) return;
    run
      .then((res) => useUi.getState().acceptAnalysis(meta, res))
      .catch((e: ApiError) => useUi.getState().failAnalysis(meta, { code: e.code, message: e.message }));
  }, [status, rid, qc]);
}
