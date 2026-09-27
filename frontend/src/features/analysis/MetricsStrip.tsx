import { AnimatePresence, motion } from 'framer-motion';
import { CloudOff, CloudSun, Satellite, SatelliteDish } from 'lucide-react';
import { useCurrentAnalysis, useCurrentBundle, useWindowKpis } from '../../data/queries';
import { useUi } from '../../state/store';
import { fmtHa, fmtKm2 } from '../../lib/format';
import { evidenceDistribution } from '../../lib/windowStats';
import { eraOf, sourceLabel } from '../../lib/time';
import { Metric, useAnimatedNumber } from '../../design';

function Divider() {
  return <div className="w-px self-stretch bg-line" aria-hidden />;
}

/** Compact, animated metric modules for the active window / year. */
export function MetricsStrip() {
  const result = useCurrentAnalysis().data;
  const analysis = useCurrentBundle();
  const k = useWindowKpis();
  const year = useUi((s) => s.year);
  const win = useUi((s) => s.window);
  if (result && !analysis) return <NoMetrics preview={result.uiPreview} status={result.status} />;
  if (!analysis || !k) return <div className="h-full" />;
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
          caption={!ys || !ys.passes_quality ? 'Insufficient clear observations' : deltaPct !== null ? `vs ${win.start}, observed in both` : `${ys.coverage_pct?.toFixed(0) ?? '—'}% of area observed`}
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
        <div className="mt-2 flex h-1.5 w-[150px] overflow-hidden rounded-full bg-white/[0.06]" aria-label={`Evidence: ${dist.high} high, ${dist.medium} medium, ${dist.low} low`}>
          <motion.span className="bg-forest" animate={{ width: `${(dist.high / total) * 100}%` }} />
          <motion.span className="bg-warn" animate={{ width: `${(dist.medium / total) * 100}%` }} />
          <motion.span className="bg-bad" animate={{ width: `${(dist.low / total) * 100}%` }} />
        </div>
      </div>
      <Divider />
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
    </div>
  );
}

/** Without a READY analysis the strip carries no metrics — only what is actually shown. */
function NoMetrics({ preview, status }: { preview: boolean; status: string }) {
  const year = useUi((s) => s.year);
  const hires = useUi((s) => s.imagery === 'hires');
  return (
    <div className="flex h-full items-center gap-5 px-5" data-testid="no-metrics">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <SatelliteDish size={16} className="shrink-0 text-warn" />
        <div className="min-w-0">
          <div className="t-label text-warn">{preview ? 'Live analysis unavailable' : status === 'INVALID_ANALYSIS' ? 'Analysis failed scientific validation' : status === 'ERROR' ? 'Analysis could not be completed' : 'No measurements available'}</div>
          <div className="mt-1 truncate text-[11.5px] text-ink-3">No result means no result: forest-change measurements appear only for completed, validated analyses.</div>
        </div>
      </div>
      <Divider />
      <div className="hidden min-w-[210px] lg:block">
        <div className="t-label flex items-center gap-1.5 text-ink-3"><Satellite size={11} /> Real imagery</div>
        <div className="t-data mt-1.5 text-[14px] leading-none text-ink">{hires ? 'Esri World Imagery' : `Sentinel-2 cloudless ${year}`}</div>
        <div className="mt-1 text-[11px] text-ink-3">{hires ? 'current, not dated' : 'EOX annual mosaic · imagery only'}</div>
      </div>
    </div>
  );
}

/** Big time-machine readout over the map: YEAR · DATA SOURCE · FOREST COVER (READY analyses only). */
export function TimeMachineHud() {
  const view = useUi((s) => s.view);
  const playing = useUi((s) => s.playing);
  const year = useUi((s) => s.year);
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
