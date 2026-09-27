import type { AoiKpis, AoiSummary, ChangeEvent, ConfidenceClass } from '../data/contracts';

/**
 * KPIs for an analysis window [start, end].
 *
 * For the backend's analysed window the backend KPIs are returned as-is (net change there
 * is measured over pixels observed in both years). For any other window only measured
 * per-transition loss/gain fully inside the window are summed; net change is NOT derived
 * by subtracting forest areas with different observation coverage, so it is null.
 * Nothing missing is ever replaced by 0.
 */
export function windowKpis(summary: AoiSummary, events: ChangeEvent[], start: number, end: number): AoiKpis {
  const ev = events.filter((e) => e.properties.year_to > start && e.properties.year_to <= end);
  const confs = ev.map((e) => e.properties.confidence.score);
  const counts = {
    event_count: ev.length,
    high_severity_count: ev.filter((e) => ['high', 'critical'].includes(e.properties.severity.class)).length,
    mean_confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
  };
  const w = summary.analysis_window;
  if (w && w.baseline_year === start && w.comparison_year === end) return { ...summary.kpis, ...counts };

  const row = (y: number) => summary.years.find((r) => r.year === y && r.passes_quality) ?? null;
  const inside = summary.years.filter((r) => r.passes_quality && r.previous_year !== null && r.previous_year >= start && r.year <= end && r.loss_ha !== null);
  const sum = (k: 'loss_ha' | 'gain_ha') => (inside.length ? inside.reduce((a, r) => a + (r[k] as number), 0) : null);
  return {
    baseline_year: start,
    latest_year: end,
    forest_baseline_ha: row(start)?.forest_ha ?? null,
    forest_latest_ha: row(end)?.forest_ha ?? null,
    compared_ha: null,
    net_change_ha: null,
    net_change_pct: null,
    total_loss_ha: sum('loss_ha'),
    total_gain_ha: sum('gain_ha'),
    ...counts,
  };
}

export function evidenceDistribution(events: ChangeEvent[]): Record<ConfidenceClass, number> {
  const d = { high: 0, medium: 0, low: 0 };
  for (const e of events) d[e.properties.confidence.class]++;
  return d;
}

/** Nearest available composite year ≤ y (or the first one). */
export function snapYear(years: number[], y: number): number {
  let best = years[0];
  for (const v of years) if (v <= y) best = v;
  return best;
}
