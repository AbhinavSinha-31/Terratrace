import { AlertTriangle, Check, Clock, Loader2, Maximize2, RotateCcw, Satellite, ScanSearch, ShieldAlert, X } from 'lucide-react';
import type { AnalysisQuality, AnalysisResult } from '../../data/contracts';
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
  if (r.status === 'INVALID_ANALYSIS') return { title: 'Analysis failed scientific validation', Icon: ShieldAlert, tone: 'text-bad' };
  if (code === 'analysis_timeout') return { title: 'Analysis could not be completed', Icon: Clock, tone: 'text-warn' };
  if (code === 'analysis_too_large') return { title: 'Analysis too large for interactive mode', Icon: Maximize2, tone: 'text-warn' };
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
export function AnalysisErrorPanel({ error, onRetry }: { error: { code?: string; message: string }; onRetry(): void }) {
  const ui = useUi.getState;
  const b = useUi((s) => s.investigation.baselineYear);
  const c = useUi((s) => s.investigation.comparisonYear);
  const title = error.code === 'analysis_timeout' || error.code === 'analysis_failed' ? 'Analysis could not be completed'
    : error.code === 'analysis_too_large' ? 'Analysis too large for interactive mode' : 'Live analysis unavailable';
  return (
    <div className="space-y-5" data-testid="analysis-unavailable" data-status="ERROR" data-code={error.code ?? ''}>
      <section>
        <div className="t-label flex items-center gap-2 text-warn" data-testid="status-title"><AlertTriangle size={14} /> {title}</div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2" data-testid="status-message">{error.message}</p>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-3">No analysis result exists for {b} → {c}; no measurements are shown.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="brand" icon={<RotateCcw size={13} />} onClick={onRetry}>Retry</Button>
          <Button size="sm" variant="ghost" icon={<Satellite size={13} />} onClick={() => ui().setDrawerOpen(false)}>Continue exploring imagery</Button>
        </div>
      </section>
    </div>
  );
}

export function AnalysisUnavailable({ result, onRetry }: { result: AnalysisResult; onRetry(): void }) {
  const { title, Icon, tone } = statusCopy(result);
  const code = result.error?.code ?? result.reasonCode;
  const retryable = result.error?.retryable ?? true;
  const aoi = result.aoi;
  const ui = useUi.getState;
  const smaller = code === 'analysis_timeout' || code === 'analysis_too_large';
  return (
    <div className="space-y-5" data-testid="analysis-unavailable" data-status={result.status} data-code={code ?? ''}>
      <section>
        <div className={`t-label flex items-center gap-2 ${tone}`} data-testid="status-title">
          <Icon size={14} className={result.status === 'PROCESSING' ? 'animate-spin' : ''} /> {title}
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2" data-testid="status-message">{result.reason}</p>
        {result.status === 'INVALID_ANALYSIS' && (
          <p className="mt-2 text-[12px] leading-relaxed text-ink-3">The results failed TERRATRACE’s scientific validity checks, so they are withheld rather than shown as findings. This is not a “no change” result.</p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {retryable && <Button size="sm" variant="brand" icon={<RotateCcw size={13} />} onClick={onRetry}>Retry</Button>}
          {smaller && <Button size="sm" variant="secondary" icon={<ScanSearch size={13} />} onClick={() => ui().goExplore('explore')}>Try a smaller area</Button>}
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
        <span><b className="text-ink-2">What the map shows:</b> real imagery only — Sentinel-2 cloudless annual mosaics (2016–2025). It is not a TERRATRACE analysis and carries no measurements.</span>
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
/** Observation quality per composite year + failed validity checks (measured metadata, not forest metrics). */
function QualityReport({ q }: { q: AnalysisQuality }) {
  return (
    <>
      {q.issues.length > 0 && (
        <section className="overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(255,107,82,0.35)]" data-testid="validity-issues">
          <div className="t-label border-b border-line px-3.5 py-2.5 text-bad">Failed validity checks</div>
          <ul className="space-y-2 px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-2">
            {q.issues.map((i) => <li key={`${i.rule}-${i.years.join('-')}`} className="flex gap-2"><X size={12} className="mt-1 shrink-0 text-bad" />{i.message}</li>)}
          </ul>
        </section>
      )}
      <section className="overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(255,255,255,0.065)]" data-testid="quality-table">
        <div className="t-label flex items-center justify-between border-b border-line px-3.5 py-2.5 text-ink-3">
          <span>Observation quality</span><span className="!normal-case !tracking-normal text-ink-4">method {q.method_version}</span>
        </div>
        <table className="w-full text-[11px]">
          <thead className="text-ink-4">
            <tr><th className="px-3.5 py-1.5 text-left font-normal">Year</th><th className="py-1.5 text-left font-normal">Era</th><th className="py-1.5 text-right font-normal">Observed</th><th className="px-3.5 py-1.5 text-right font-normal">Usable</th></tr>
          </thead>
          <tbody>
            {q.years.map((y) => (
              <tr key={y.year} className="border-t border-line align-top" title={y.reason ?? undefined}>
                <td className="t-data px-3.5 py-1.5 text-ink">{y.year}</td>
                <td className="py-1.5 text-ink-3">{y.era === 'historical' ? 'Landsat' : 'S2 + DW'}</td>
                <td className="t-data py-1.5 text-right text-ink-2">{y.coverage_pct === null ? '—' : `${y.coverage_pct.toFixed(0)}%`}</td>
                <td className="px-3.5 py-1.5 text-right">{y.passes ? <Check size={12} className="ml-auto text-live" /> : <X size={12} className="ml-auto text-warn" />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-line px-3.5 py-2.5 text-[10.5px] leading-relaxed text-ink-4">
          Observed = share of the area with ≥ {q.thresholds.min_pixel_clear_obs ?? 3} clear observations (and Dynamic World observations in the modern era) — not a scene count.
          A year is usable at ≥ {Math.round((q.thresholds.min_year_coverage ?? 0.8) * 100)}%. Hover a row for the reason.
        </p>
      </section>
    </>
  );
}
