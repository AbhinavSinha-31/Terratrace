import type { ChangeEventProps, ExplanationFacts, StudyArea } from '../data/contracts';

/**
 * Build the complete, closed set of facts the explanation may use.
 * Nothing outside this object reaches the language model. Change events only
 * exist inside a READY live Earth Engine analysis, hence the fixed status.
 */
export function buildFacts(e: ChangeEventProps, aoi: StudyArea): ExplanationFacts {
  const ev = e.confidence.evidence;
  return {
    data_mode: 'LIVE',
    analysis_status: 'READY',
    event_id: e.id,
    study_area: aoi.name,
    region: aoi.region,
    biome: aoi.biome ?? 'not specified',
    sector: e.sector,
    change_type: e.change_type,
    change_label: e.change_label,
    period: { from_year: e.year_from, to_year: e.year_to, composite_window: e.composite_window },
    area: { hectares: e.area_ha, square_km: e.area_km2 },
    share_of_forest_converted: e.conversion_fraction,
    ndvi: e.indices.ndvi,
    nbr: e.indices.nbr,
    tree_probability: e.indices.tree_prob,
    land_cover: e.land_cover,
    severity: e.severity,
    confidence: {
      class: e.confidence.class,
      score: e.confidence.score,
      checks_passed: ev.filter((x) => x.passed === true).length,
      checks_evaluated: ev.filter((x) => x.passed !== null).length,
      checks_pending: ev.filter((x) => x.passed === null).length,
    },
    evidence: ev.map((x) => ({ check: x.label, value: x.value, threshold: x.threshold, passed: x.passed })),
    persistence_next_year: e.persistence,
    min_clear_observations: e.clear_obs_min,
    reference_overlap_hansen: e.reference_overlap,
  };
}

export function countFacts(facts: ExplanationFacts): number {
  let n = 0;
  const walk = (v: unknown) => {
    if (v !== null && typeof v === 'object') Object.values(v as object).forEach(walk);
    else n++;
  };
  walk(facts);
  return n;
}
