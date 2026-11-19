import { AnimatePresence, motion } from 'framer-motion';
import { CloudOff, CloudSun, Satellite, SatelliteDish } from 'lucide-react';
import { useCurrentAnalysis, useCurrentBundle } from '../../data/queries';
import { useAnalysisWindow, useUi } from '../../state/store';
import { useAnalysisState, useImageryState } from '../../data/viewState';
import { evidenceDistribution, fmtHa, fmtKm2 } from '../../lib/format';
import { eraOf, sourceLabel } from '../../lib/time';
import { Metric, useAnimatedNumber } from '../../design';
import { ImageryStatus, useImageryCoveredByAnalysis } from '../map/ImageryStatus';

function Divider() {
  return <div className="w-px self-stretch bg-line" aria-hidden />;
}

/** Compact, animated metric modules for the active window / year. */
export function MetricsStrip() {
  const result = useCurrentAnalysis().data;
  const analysis = useCurrentBundle();
  // KPIs come from the backend result, which always belongs to the current baseline/comparison.
  const k = analysis?.summary.kpis ?? null;
  const year = useUi((s) => s.investigation.imageryYear);
  const win = useAnalysisWindow();
  const errCode = useUi((s) => s.investigation.analysisError?.code);
  const imageryIsAnalysis = useImageryCoveredByAnalysis();
  // No measured result (idle, running, error, or non-READY): no metrics — never zeros.
  if (!analysis || !k) return <NoMetrics status={result?.status ?? (errCode === 'service_unavailable' ? 'UNAVAILABLE' : errCode ? 'ERROR' : 'NONE')} />;
  const ys = analysis.summary.years.find((y) => y.year === year);
  const events = analysis.events.features.filter((e) => e.properties.year_to > win.start && e.properties.year_to <= win.end);
  const dist = evidenceDistribution(events);
  const total = events.length || 1;
  const dominant = events.length ? (Object.entries(dist).sort((a, b) => b[1] - a[1])[0][0] as 'high' | 'medium' | 'low') : null;
  // Net change only where the backend measured it (baseline→comparison over pixels observed in both years).
  const deltaPct = year === win.end && year !== win.start ? k.net_change_pct : null;
  const src = sourceLabel(year);

  return (
    <div className="flex h-full items-center gap-5 px-5">
      <div className="min-w-[150px] flex-1">
        <Metric
          label={`Forest cover ${year}`}
          value={ys?.forest_ha ?? null}
          format={(v) => fmtHa(v)}
          unit="ha"
          delta={deltaPct !== null ? { value: `${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(2)}%`, direction: deltaPct < 0 ? 'down' : deltaPct > 0 ? 'up' : 'flat', tone: deltaPct < 0 ? 'bad' : 'neutral' } : undefined}
          caption={ys?.forest_withheld ? 'Imagery only before 2016' : !ys || !ys.passes_quality ? 'Insufficient clear observations' : deltaPct !== null ? `vs ${win.start}, observed in both` : `${ys.coverage_pct?.toFixed(0) ?? '—'}% of area observed`}
        />
      </div>
      <Divider />
      <div className="min-w-[140px] flex-1">
        <Metric label={`Forest loss ${win.start}–${win.end}`} value={k.total_loss_ha} format={(v) => fmtHa(v)} unit="ha"
          caption={k.total_loss_ha === null ? 'No measured transitions in this window' : k.total_loss_ha > 0 ? `${fmtKm2(k.total_loss_ha / 100)} km²${k.net_change_pct !== null ? ` · ${k.net_change_pct.toFixed(2)}% net` : ''}` : 'No forest loss measured'} />
      </div>
      <Divider />
      <div className="min-w-[100px]">
        <Metric label="Events" value={k.event_count} format={(v) => String(Math.round(v)).padStart(2, '0')} caption={k.event_count ? `${k.high_severity_count} high / critical` : win.end < 2016 ? 'detected in the modern era only' : 'none in window'} />
      </div>
      <Divider />
      <div className="hidden min-w-[150px] xl:block">
        <div className="t-label text-ink-3">Evidence</div>
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className={`t-data text-[20px] font-medium uppercase leading-none ${dominant === 'high' ? 'text-forest' : dominant === 'medium' ? 'text-warn' : dominant === 'low' ? 'text-[#ff8a80]' : 'text-ink-3'}`}>{dominant ?? '—'}</span>
          {dominant && <span className="text-[11px] text-ink-3">dominant level</span>}
        </div>
        <div className="mt-2 flex h-1.5 w-[150px] overflow-hidden rounded-full bg-white/[0.06]" role="img" aria-label={`Evidence: ${dist.high} high, ${dist.medium} medium, ${dist.low} low`}>
          <motion.span className="bg-forest" animate={{ width: `${(dist.high / total) * 100}%` }} />
          <motion.span className="bg-warn" animate={{ width: `${(dist.medium / total) * 100}%` }} />
          <motion.span className="bg-bad" animate={{ width: `${(dist.low / total) * 100}%` }} />
        </div>
      </div>
      <Divider />
      {/* Viewing imagery that is NOT the analysis composite (another year, current basemap, throttled/unavailable):
          the imagery honesty label takes this slot — in the bar, never over the map. */}
      {!imageryIsAnalysis ? (
        <div className="hidden w-[260px] shrink-0 lg:block" data-testid="imagery-indicator"><ImageryStatus /></div>
      ) : (
      <div className="hidden min-w-[190px] lg:block">
        <div className="t-label flex items-center gap-1.5 text-ink-3"><Satellite size={11} /> Data source</div>
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className="t-data text-[16px] font-medium leading-none text-ink">{src.title}</span>
          <span className="text-[11px] text-ink-3">{ys?.resolution_m ?? (eraOf(year) === 'historical' ? 30 : 10)} m</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-ink-3">
          {ys?.imagery_status === 'insufficient' ? <><CloudOff size={11} className="text-warn" /> Insufficient clear imagery</>
            : ys?.imagery_status === 'cloud_limited' ? <><CloudSun size={11} className="text-warn" /> Cloud-limited · {ys.clear_obs_median} clear obs.</>
              : <>{ys?.sensor ?? src.subtitle}</>}
        </div>
      </div>
      )}
    </div>
  );
}

/** Without a READY analysis the strip carries no metrics — only what is actually shown. */
function NoMetrics({ status }: { status: string }) {
  // Two separate indicators: the ANALYSIS of the selected window, and the IMAGERY being viewed. Neither implies the other.
  const analysis = useAnalysisState();
  const imagery = useImageryState();
  return (
    <div className="flex h-full items-center gap-5 px-5" data-testid="no-metrics" data-analysis-state={analysis.state} data-imagery-state={imagery.state}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <SatelliteDish size={16} className="shrink-0 text-warn" />
        <div className="min-w-0">
          <div className="t-label text-warn" data-testid="analysis-state-label">
            {status === 'INVALID_ANALYSIS' ? 'Scientific validation failed' : status === 'ERROR' ? 'Analysis could not be completed' : status === 'UNAVAILABLE' ? 'Analysis unavailable' : 'No measurements available'}
            <span className="ml-2 !normal-case !tracking-normal text-ink-3">· analysis window {analysis.window.start} → {analysis.window.end}</span>
          </div>
          {/* The reason is stated once, in the analysis panel; this bar only names the state. */}
          <div className="mt-1 truncate text-[11.5px] text-ink-3">No forest-change figures for this window.</div>
        </div>
      </div>
      <Divider />
      <div className="hidden w-[300px] shrink-0 sm:block" data-testid="imagery-indicator" data-source={imagery.source ?? ''}>
        <ImageryStatus />
      </div>
    </div>
  );
}

/** Big time-machine readout over the map: YEAR · DATA SOURCE · FOREST COVER (READY analyses only). */
export function TimeMachineHud() {
  const view = useUi((s) => s.view);
  const playing = useUi((s) => s.playing);
  const year = useUi((s) => s.investigation.imageryYear);
  const layersOpen = useUi((s) => s.layersOpen);
  const analysis = useCurrentBundle();
  const ys = analysis?.summary.years.find((y) => y.year === year);
  const measuredForest = ys?.passes_quality ? ys.forest_ha : null;
  const forest = useAnimatedNumber(measuredForest ?? 0, 900);
  const show = !!analysis && (view === 'timemachine' || playing);
  const src = sourceLabel(year);
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }}
          className="pointer-events-none absolute z-20 transition-[left] duration-300"
          style={{ left: layersOpen && window.innerWidth >= 1320 ? 272 + 36 : 28, top: 92 }}
          aria-live="polite"
        >
          <div className="tt-hud">
            <div className="t-label text-ink-3">Year</div>
            <motion.div key={year} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="t-data text-[52px] font-medium leading-[1] tracking-[-0.03em] text-ink">{year}</motion.div>
            <div className="mt-4 grid grid-cols-[auto_auto] gap-x-6 gap-y-3">
              <div>
                <div className="t-label text-ink-3">Data source</div>
                <div className="t-data mt-1 text-[15px] text-accent">{src.title}</div>
                <div className="text-[10.5px] text-ink-3">{src.subtitle}</div>
              </div>
              <div>
                <div className="t-label text-ink-3">Forest cover</div>
                <div className="t-data mt-1 text-[15px] text-ink">{measuredForest === null ? '—' : `${fmtHa(forest)} ha`}</div>
                <div className="text-[10.5px] text-ink-3">{measuredForest === null ? 'Insufficient clear observations' : ys?.forest_method === 'landsat_ndvi_proxy' ? 'Landsat NDVI forest proxy' : 'Dynamic World forest mask'}</div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
