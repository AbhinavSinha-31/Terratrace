import { AlertTriangle, CalendarRange, Check, Clock, Loader2, Maximize2, RotateCcw, Satellite, ScanSearch, ShieldAlert, X } from 'lucide-react';
import type { AnalysisQuality, AnalysisResult, QualityIssue } from '../../data/contracts';
import { useUi } from '../../state/store';
import { fmtKm2 } from '../../lib/format';
import { Button } from '../../design';

/**
 * Public status copy. Product language only — never setup instructions, commands, paths,
 * environment variables or raw errors. The message body is the backend's public user_message.
 */
export function statusCopy(r: AnalysisResult) {
  const code = r.error?.code ?? r.reasonCode;
  if (r.status === 'PROCESSING') return { title: 'Analysis in progress', Icon: Loader2, tone: 'text-accent' };
  if (r.status === 'INVALID_ANALYSIS') return { title: 'Scientific validation failed', Icon: ShieldAlert, tone: 'text-bad' };
  if (code === 'analysis_timeout') return { title: 'Analysis could not be completed', Icon: Clock, tone: 'text-warn' };
  if (code === 'earth_engine_unreachable') return { title: 'Earth Engine could not be reached', Icon: AlertTriangle, tone: 'text-warn' };
  if (code === 'earth_engine_throttled') return { title: 'Earth Engine is throttling requests', Icon: Clock, tone: 'text-warn' };
  if (code === 'analysis_too_large') return { title: 'Analysis area exceeds the interactive limit', Icon: Maximize2, tone: 'text-warn' };
  if (code === 'insufficient_imagery' || code === 'insufficient_clear_observations') return { title: 'Insufficient usable imagery', Icon: AlertTriangle, tone: 'text-warn' };
  if (r.status === 'ERROR') return { title: 'Analysis could not be completed', Icon: AlertTriangle, tone: 'text-warn' };
  return { title: 'Live analysis unavailable', Icon: AlertTriangle, tone: 'text-warn' };
}

/**
 * Shown in place of every analytical panel when the live analysis is not READY.
 * States what is and is not available — and shows no metrics (no result means no result).
 */
/**
 * A request that produced NO analysis result (backend unreachable, timeout, failure). Built only from the
 * error and study metadata — the frontend never constructs a result or any measurement.
 */
/** Codes for an area that can never be analysed as drawn (pre-flight / limits): retrying cannot succeed. */
export const AREA_REFUSALS = new Set(['outside_sentinel2_coverage', 'no_forest', 'aoi_too_large', 'aoi_too_small', 'invalid_geometry', 'invalid_coordinates', 'unsupported_geometry', 'antimeridian']);

export function AnalysisErrorPanel({ error, onRetry }: { error: { code?: string; message: string; retryable?: boolean }; onRetry(): void }) {
  const ui = useUi.getState;
  const b = useUi((s) => s.investigation.baselineYear);
  const c = useUi((s) => s.investigation.comparisonYear);
  const title = error.code === 'earth_engine_unreachable' ? 'Earth Engine could not be reached'
    : error.code === 'earth_engine_throttled' ? 'Earth Engine is throttling requests'
    : error.code === 'analysis_timeout' || error.code === 'analysis_failed' ? 'Analysis could not be completed'
    : error.code === 'analysis_too_large' ? 'Analysis area exceeds the interactive limit'
    : error.code && AREA_REFUSALS.has(error.code) ? 'Area cannot be analysed' : 'Live analysis unavailable';
  // Retry only when it can succeed: the backend says so (retryable), or a refusal code says it cannot.
  const canRetry = error.retryable !== false && !(error.code && AREA_REFUSALS.has(error.code));
  return (
    <div className="space-y-5" data-testid="analysis-unavailable" data-status="ERROR" data-code={error.code ?? ''}>
      <section>
        <div className="t-label flex items-center gap-2 text-warn" data-testid="status-title"><AlertTriangle size={14} /> {title}</div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2" data-testid="status-message">{error.message}</p>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-3">No analysis result exists for {b} → {c}; no measurements are shown.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {canRetry && <Button size="sm" variant="brand" icon={<RotateCcw size={13} />} onClick={onRetry} data-testid="retry">Retry</Button>}
          <Button size="sm" variant="ghost" icon={<Satellite size={13} />} onClick={() => ui().setDrawerOpen(false)}>Continue exploring imagery</Button>
        </div>
      </section>
    </div>
  );
}

export function AnalysisUnavailable({ result, onRetry }: { result: AnalysisResult; onRetry(): void }) {
  const { title, Icon, tone } = statusCopy(result);
  const code = result.error?.code ?? result.reasonCode;
  const retryable = (result.error?.retryable ?? true) && !(code && AREA_REFUSALS.has(code));
  const aoi = result.aoi;
  const ui = useUi.getState;
  const smaller = code === 'analysis_timeout' || code === 'analysis_too_large';
  const invalid = result.status === 'INVALID_ANALYSIS';
  // The backend reason repeats the generic sentence before the specific rule; show the specific part as the reason.
  const specific = result.quality?.issues.map((i) => i.message).join(' ');
  const validationReason = specific || result.reason;
  /** Hands focus to the timeline's start-year selector (the analysis window lives there). */
  const focusWindow = () => {
    ui().setDrawerOpen(false);
    window.setTimeout(() => (document.querySelector('[aria-label="Start year"]') as HTMLElement | null)?.focus(), 50);
  };
  return (
    <div className="space-y-5" data-testid="analysis-unavailable" data-status={result.status} data-code={code ?? ''}>
      <section>
        <div className={`t-label flex items-center gap-2 ${tone}`} data-testid="status-title">
          <Icon size={14} className={result.status === 'PROCESSING' ? 'animate-spin' : ''} /> {title}
        </div>
        <p className="t-data mt-2 text-[12px] text-ink-2" data-testid="analysis-window-line">
          <span className="t-label mr-1.5 !text-[9px] text-ink-3">Analysis window</span>{result.window.baseline_year} → {result.window.comparison_year}
          {result.quality?.analyzable_window && result.quality.analyzable_window.join('-') !== `${result.window.baseline_year}-${result.window.comparison_year}` &&
            <span className="text-ink-3"> · analysable years {result.quality.analyzable_window.join(' → ')}</span>}
        </p>
        {invalid ? (
          <>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-2" data-testid="status-message"><span className="t-label mr-1.5 !text-[9px] text-ink-3">Reason · validation diagnostic</span>{validationReason}</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3" data-testid="diagnostic-note">
              The percentages above are <b className="text-ink-2">validation diagnostics</b> — measurements of the forest classification's stability used to
              decide whether results can be trusted. They are not forest-change results and must not be read as loss or gain.
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-3" data-testid="invalid-explanation">
              The computation completed, but TERRATRACE withheld the result because the observations/classification did not satisfy the scientific validity checks.
            </p>
            <p className="mt-2 rounded-sm bg-bad/10 px-2.5 py-1.5 text-[11.5px] font-medium text-bad" data-testid="not-no-change">Not a “no change” result — no forest-change measurement is reported for this window.</p>
          </>
        ) : (
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2" data-testid="status-message">{result.reason}</p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {retryable && <Button size="sm" variant="brand" icon={<RotateCcw size={13} />} onClick={onRetry}>Retry</Button>}
          {smaller && <Button size="sm" variant="secondary" icon={<ScanSearch size={13} />} onClick={() => ui().goExplore('explore')}>Try a smaller area</Button>}
          {invalid && <Button size="sm" variant="secondary" icon={<ScanSearch size={13} />} onClick={() => ui().goExplore('explore')}>Change analysis area</Button>}
          {invalid && <Button size="sm" variant="secondary" icon={<CalendarRange size={13} />} onClick={focusWindow}>Change analysis window</Button>}
          <Button size="sm" variant="ghost" icon={<Satellite size={13} />} onClick={() => ui().setDrawerOpen(false)}>Continue exploring imagery</Button>
        </div>
      </section>

      {result.quality && <QualityReport q={result.quality} />}

      <section className="overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(255,255,255,0.065)]">
        <div className="t-label border-b border-line px-3.5 py-2.5 text-ink-3">Area of interest</div>
        <dl className="grid grid-cols-2 gap-y-2 px-3.5 py-3 text-[12px]">
          <dt className="text-ink-3">Name</dt><dd className="truncate text-right text-ink">{aoi.name}</dd>
          <dt className="text-ink-3">Location</dt><dd className="t-data truncate text-right text-ink-2">{aoi.center[1].toFixed(3)}°, {aoi.center[0].toFixed(3)}°</dd>
          <dt className="text-ink-3">Area (from geometry)</dt><dd className="t-data text-right text-ink">{fmtKm2(aoi.area_km2)} km²</dd>
          <dt className="text-ink-3">Requested window</dt><dd className="t-data text-right text-ink-2">{result.window.baseline_year} → {result.window.comparison_year}</dd>
          {result.quality && <><dt className="text-ink-3">Analysable window</dt><dd className="t-data text-right text-ink-2">{result.quality.analyzable_window ? result.quality.analyzable_window.join(' → ') : 'none'}</dd></>}
        </dl>
      </section>

      <section className="flex gap-3 rounded-md bg-white/[0.03] p-3.5 text-[11.5px] leading-relaxed text-ink-3 shadow-[0_0_0_1px_rgba(255,255,255,0.065)]">
        <Satellite size={15} className="mt-0.5 shrink-0 text-ink-2" />
        <span><b className="text-ink-2">What the map shows:</b> raw satellite imagery only — Earth Engine annual composites (Sentinel-2 from 2017, Landsat before) for the year you are viewing on the timeline.
          It stays available for exploration, but it is not a TerraTrace result: forest, NDVI and change layers appear only for a validated analysis.</span>
      </section>

      {import.meta.env.DEV && result.diagnostics && (
        <details className="rounded-md p-3 text-[11px] text-ink-3 shadow-[0_0_0_1px_rgba(255,255,255,0.065)]" data-testid="dev-diagnostics">
          <summary className="cursor-pointer">Developer diagnostics (development build only)</summary>
          <pre className="t-data mt-2 whitespace-pre-wrap">{JSON.stringify(result.diagnostics, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
const QUARTERS = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'];
const fmtPts = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} pts`;
/** Lowest measured quarter (one decimal, so 79.8 % never reads as the 80 % threshold); '—' when not measured / not applicable. */
const minSeason = (s: (number | null)[] | null | undefined) =>
  !s || s.some((v) => v === null) ? '—' : `${Math.min(...(s as number[])).toFixed(1)}%`;

/** Observation quality per composite year + failed validity checks (measured metadata, not forest metrics). */
function QualityReport({ q }: { q: AnalysisQuality }) {
  return (
    <>
      {q.issues.length > 0 && (
        <section className="overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(255,107,82,0.35)]" data-testid="validity-issues">
          <div className="t-label flex items-center justify-between border-b border-line px-3.5 py-2.5 text-bad">
            <span>Failed validity checks</span><span className="!normal-case !tracking-normal text-ink-4">validation diagnostics · not results</span>
          </div>
          <ul className="space-y-2 px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-2">
            {q.issues.map((i) => <IssueItem key={`${i.rule}-${i.years.join('-')}`} issue={i} q={q} />)}
          </ul>
        </section>
      )}
      <section className="overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(255,255,255,0.065)]" data-testid="quality-table">
        <div className="t-label flex items-center justify-between border-b border-line px-3.5 py-2.5 text-ink-3">
          <span>Observation quality</span><span className="!normal-case !tracking-normal text-ink-4">method {q.method_version}</span>
        </div>
        <table className="w-full text-[11px]">
          <thead className="text-ink-4">
            <tr><th className="px-3.5 py-1.5 text-left font-normal">Year</th><th className="py-1.5 text-left font-normal">Era</th><th className="py-1.5 text-right font-normal">Observed</th><th className="py-1.5 text-right font-normal">Clear obs</th><th className="py-1.5 text-right font-normal" title="Lowest share of the area observed in any calendar quarter">Seasons</th><th className="px-3.5 py-1.5 text-right font-normal">Usable</th></tr>
          </thead>
          <tbody>
            {q.years.map((y) => (
              <tr key={y.year} className="border-t border-line align-top" title={y.reason ?? undefined}>
                <td className="t-data px-3.5 py-1.5 text-ink">{y.year}</td>
                <td className="py-1.5 text-ink-3">{y.era === 'historical' ? 'Landsat' : 'S2 + DW'}</td>
                <td className="t-data py-1.5 text-right text-ink-2">{y.coverage_pct === null ? '—' : `${y.coverage_pct.toFixed(0)}%`}</td>
                <td className="t-data py-1.5 text-right text-ink-2" title="Median clear observations per pixel">{y.clear_obs_median ?? '—'}</td>
                <td className="t-data py-1.5 text-right text-ink-2" data-testid="seasonal-cell"
                  title={y.seasonal_coverage_pct ? y.seasonal_coverage_pct.map((v, i) => `${QUARTERS[i]}: ${v === null ? '—' : `${v.toFixed(1)}%`}`).join(' · ') : 'Not applicable (Landsat era)'}>
                  {minSeason(y.seasonal_coverage_pct)}
                </td>
                <td className="px-3.5 py-1.5 text-right">{y.passes ? <Check size={12} className="ml-auto text-live" /> : <X size={12} className="ml-auto text-warn" />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-line px-3.5 py-2.5 text-[10.5px] leading-relaxed text-ink-4">
          Observed = share of the area with ≥ {q.thresholds.min_pixel_clear_obs ?? 3} clear observations (and Dynamic World observations in the modern era) — not a scene count.
          Clear obs = median number of clear observations per pixel. Seasons = lowest share of the area observed in any calendar quarter
          (the leaf-on forest test needs the whole year). A year is usable at ≥ {Math.round((q.thresholds.min_year_coverage ?? 0.8) * 100)}% for both.
        </p>
        {q.years.some((y) => !y.passes && y.reason) && (
          <ul className="space-y-1 border-t border-line px-3.5 py-2.5 text-[10.5px] leading-relaxed text-ink-3" data-testid="excluded-years">
            {q.years.filter((y) => !y.passes && y.reason).map((y) => <li key={y.year}><b className="t-data text-ink-2">{y.year} excluded:</b> {y.reason}</li>)}
          </ul>
        )}
      </section>
    </>
  );
}

/** One failed validity check with its measured evidence and the observation quality of both years (never a finding). */
function IssueItem({ issue, q }: { issue: QualityIssue; q: AnalysisQuality }) {
  const e = issue.evidence;
  const yrs = issue.years.map((y) => q.years.find((r) => r.year === y)).filter((r): r is NonNullable<typeof r> => !!r);
  return (
    <li className="flex gap-2" data-testid="validity-issue" data-rule={issue.rule}>
      <X size={12} className="mt-1 shrink-0 text-bad" />
      <div className="min-w-0">
        <div className="t-data text-ink">{issue.years.join(' → ')}</div>
        <div>{issue.rule === 'unstable_forest_mask' ? 'Forest-mask gain exceeded the plausibility threshold.' : issue.message}</div>
        {e?.driver && e.component_change_pts && (
          <div className="mt-1 text-[11px] text-ink-2" data-testid="issue-driver">
            Cause: {e.driver === 'tree_prob' ? 'the Dynamic World tree-probability classification' : e.driver === 'leafon_ndvi' ? 'leaf-on canopy greenness (NDVI)' : 'both forest-mask components'}
            <span className="t-data text-ink-3"> · tree probability {fmtPts(e.component_change_pts.tree_prob)} · leaf-on NDVI {fmtPts(e.component_change_pts.leafon_ndvi)} of the observed area</span>
          </div>
        )}
        {e && (
          <div className="t-data mt-1 text-[11px] text-ink-3" data-testid="issue-evidence">
            Diagnostic: classification gain {e.measured_pct_per_year.toFixed(2)}% of the compared area per year · allowed ≤ {e.threshold_pct_per_year}% · compared area {Math.round(e.compared_ha).toLocaleString('en-US')} ha
          </div>
        )}
        {yrs.length > 0 && (
          <div className="t-data text-[11px] text-ink-3">
            {yrs.map((r) => `${r.year}: ${r.coverage_pct === null ? '—' : `${r.coverage_pct.toFixed(0)}%`} observed, ${r.clear_obs_median ?? '—'} clear obs`).join(' · ')}
          </div>
        )}
      </div>
    </li>
  );
}
