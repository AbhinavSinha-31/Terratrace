import { useEffect } from 'react';
import { useUi, type InvestigationImageryStatus } from '../state/store';
import { ApiError } from './client';
import { useImageryDecision } from './queries';

/**
 * Mirrors the backend imagery decision for the investigation's study + imagery year into
 * InvestigationState.imageryStatus. Imagery only: it never reads or changes the analysis.
 *
 *   loading      request in flight
 *   available    READY — real Earth Engine imagery with a tile URL
 *   insufficient READY imagery, but the measured timeline coverage for that year is below the rule
 *   unavailable  UNAVAILABLE (zero scenes or a classified failure) — no imagery is drawn
 *   unknown      the imagery request failed (see imageryErrorMessage for the exact class)
 */
export function useImagerySync() {
  const studyId = useUi((s) => s.investigation.study?.id ?? null);
  const year = useUi((s) => s.investigation.imageryYear);
  const q = useImageryDecision(studyId, year);
  const d = q.data;
  const status: InvestigationImageryStatus = q.isFetching && !d ? 'loading'
    : !d ? (q.isError ? 'unknown' : 'loading')
    : d.status !== 'READY' ? 'unavailable'
    : d.imageryStatus === 'INSUFFICIENT' ? 'insufficient' : 'available';
  useEffect(() => {
    if (studyId) useUi.getState().setImageryStatus({ studyId, year }, status);
  }, [studyId, year, status]);
}

/**
 * Public wording for a FAILED imagery request, by failure class (never raw server text):
 * connection failure / 404 / 500 / 429 / anything else.
 */
export function imageryErrorMessage(e: unknown): string {
  const err = e instanceof ApiError ? e : null;
  if (!err || err.status === undefined) return 'Imagery service could not be reached.';
  if (err.status === 429) return 'Satellite imagery is temporarily throttled. Retrying…';
  if (err.status === 404) return err.code === 'not_found' ? 'Imagery request failed: area not found.' : 'Imagery request failed: endpoint not found.';
  if (err.status === 500) return 'Imagery service returned an internal error.';
  return 'Imagery request failed.';
}
