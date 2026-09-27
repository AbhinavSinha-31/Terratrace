import type { ExplanationFacts } from '../data/contracts';
import { landCoverLabel } from '../lib/format';

const f2 = (v: number) => v.toFixed(2);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const sign = (v: number) => (v > 0 ? `+${f2(v)}` : f2(v));
const ha = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 1 });

/**
 * Deterministic, offline explanation. It is grounded by construction: every
 * sentence is a template slot filled from ExplanationFacts, so it can never
 * state something the measurements do not support. Used when the LLM service
 * is unavailable or its draft fails the numeric fact-check.
 */
export function groundedNarrative(f: ExplanationFacts): string {
  const isFire = f.change_type === 'fire';
  const after = landCoverLabel(f.land_cover.after).toLowerCase();

  const what =
    `What changed: Between the ${f.period.from_year} and ${f.period.to_year} satellite composites (${f.period.composite_window}), ` +
    `TERRATRACE detected ${isFire ? 'a burn scar' : 'forest clearing'} covering ${ha(f.area.hectares)} ha ` +
    `(${f.area.square_km.toFixed(2)} km²) in Sector ${f.sector} of ${f.study_area}. ` +
    `About ${pct(f.share_of_forest_converted)} of the forest pixels in the patch no longer qualify as forest, and the dominant ` +
    `land cover changed from trees to ${after}.`;

  const signature = isFire
    ? `The NBR drop is larger than the NDVI drop, the spectral pattern expected after burning; the severity basis is: ${f.severity.basis}.`
    : `All three indicators fell together, which is consistent with removal of tree cover${f.land_cover.after === 'bare' ? ' and exposure of bare ground' : ''}.`;
  const evidence =
    `Evidence: Vegetation greenness (NDVI) fell from ${f2(f.ndvi.before)} to ${f2(f.ndvi.after)} (${sign(f.ndvi.change)}), ` +
    `the burn-sensitive index NBR from ${f2(f.nbr.before)} to ${f2(f.nbr.after)} (${sign(f.nbr.change)}), and the modelled ` +
    `tree probability from ${f2(f.tree_probability.before)} to ${f2(f.tree_probability.after)}. ${signature}`;

  const failed = f.evidence.filter((e) => e.passed === false).map((e) => e.check.toLowerCase());
  const persistence =
    f.persistence_next_year === null
      ? 'Whether the change persists cannot be checked until the next annual composite.'
      : f.persistence_next_year >= 0.7
        ? `${pct(f.persistence_next_year)} of the changed area was still non-forest in the following year.`
        : `Only ${pct(f.persistence_next_year)} of the changed area was still non-forest in the following year, which lowers confidence.`;
  const reference =
    f.reference_overlap_hansen === null
      ? 'External reference data for this period is not yet available.'
      : `${pct(f.reference_overlap_hansen)} of the patch overlaps independent Hansen forest-loss data${isFire && f.reference_overlap_hansen < 0.3 ? ', which records mainly stand-replacing loss rather than burns' : ''}.`;
  const confidence =
    `Confidence & limits: Confidence is ${f.confidence.class} (${pct(f.confidence.score)}), with ${f.confidence.checks_passed} of ` +
    `${f.confidence.checks_evaluated} evaluated evidence checks passed${failed.length ? ` (not met: ${failed.join(', ')})` : ''}. ` +
    `${persistence} ${reference} These measurements show that a change occurred; they do not show who or what caused it.`;

  return [what, evidence, confidence].join('\n\n');
}
