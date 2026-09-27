import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Eraser, Hexagon, SquareDashed, Trees } from 'lucide-react';
import { client } from '../../data/client';
import { useHealth } from '../../data/queries';
import { useUi } from '../../state/store';
import { geometryAreaKm2, geometryCentroid, fmtLatLon } from '../../lib/geo';
import { DEFAULT_YEARS, sourceLabel } from '../../lib/time';
import { Badge, Button, IconButton, Menu, StateView, Tooltip } from '../../design';
import { AnimatedNumber } from '../../design/Metric';

/** SELECTED AREA — measurement, reference forest share, time range and the Analyze action. */
export function SelectionPanel() {
  const selection = useUi((s) => s.selection)!;
  const setSelection = useUi((s) => s.setSelection);
  const setDrawTool = useUi((s) => s.setDrawTool);
  const start = useUi((s) => s.startAnalysis);
  const { data: health } = useHealth();
  const [baseline, setBaseline] = useState(2018);
  const [comparison, setComparison] = useState(2025);

  const area = geometryAreaKm2(selection.geometry);
  const centroid = geometryCentroid(selection.geometry);
  const key = useMemo(() => JSON.stringify(selection.geometry), [selection.geometry]);
  const preview = useQuery({ queryKey: ['preview', key], queryFn: () => client.preview(selection.geometry), staleTime: Infinity, retry: 0 });

  const max = health?.limits.max_aoi_km2 ?? 2500;
  const min = health?.limits.min_aoi_km2 ?? 0.5;
  const tooLarge = area > max;
  const tooSmall = area < min;
  const eeReady = health?.analysis.status === 'ready';
  const backendDown = health && !health.backend;
  // Largest area the backend can analyse interactively (public limit from /api/health; never silently reduced).
  const interactiveMax = health?.limits.interactive_max_km2;
  const tooHeavy = !tooLarge && interactiveMax !== undefined && area > interactiveMax;
  const blocked = tooLarge || tooSmall || tooHeavy || !!backendDown;
  const yearOpt = (y: number) => ({ value: y, label: String(y), meta: sourceLabel(y).title === 'LANDSAT' ? 'Landsat' : 'S2 · DW' });

  return (
    <motion.section
      initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="tt-panel w-full p-5"
      aria-label="Selected area"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="t-label text-accent">Selected area</div>
          <div className="t-h2 mt-1.5 truncate">{selection.name ?? (selection.source === 'draw' ? 'Custom area of interest' : 'Selected location')}</div>
          <div className="t-data mt-1 text-[11px] text-ink-3">{fmtLatLon(centroid[0], centroid[1], 3)}</div>
        </div>
        <Tooltip content="Clear selection" side="left">
          <IconButton label="Clear selection" size="sm" onClick={() => setSelection(null)}><Eraser size={14} /></IconButton>
        </Tooltip>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-md bg-line">
        <div className="bg-surface px-3.5 py-3">
          <div className="t-label text-ink-3">Area</div>
          <div className="mt-1.5 flex items-baseline gap-1">
            <span className="t-data text-[22px] font-medium leading-none"><AnimatedNumber value={area} format={(v) => (v >= 100 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(1))} /></span>
            <span className="text-[11px] text-ink-3">km²</span>
          </div>
          <div className="t-data mt-1 text-[10.5px] text-ink-3">{(area * 100).toLocaleString('en-US', { maximumFractionDigits: 0 })} ha</div>
        </div>
        <div className="bg-surface px-3.5 py-3">
          {/* REFERENCE DATA (Hansen 2000), deliberately styled unlike a TERRATRACE measurement. */}
          <div className="t-label flex items-center gap-1.5 text-ink-4" data-testid="reference-tree-cover"><Trees size={11} /> Reference data</div>
          <div className="mt-1.5 flex items-baseline gap-1">
            {preview.isLoading ? <span className="skeleton h-5 w-14" /> : preview.data?.forest_cover_pct != null ? (
              <><span className="t-data text-[16px] leading-none text-ink-3">{preview.data.forest_cover_pct.toFixed(0)}</span><span className="text-[11px] text-ink-4">% tree cover</span></>
            ) : <span className="text-[12px] text-ink-4">Not available</span>}
          </div>
          <div className="mt-1 text-[10.5px] leading-snug text-ink-4" title={preview.data?.forest_source ?? undefined}>Hansen 2000 tree cover (≥ 30 % canopy) — not a TERRATRACE result</div>
        </div>
      </div>

      <div className="mt-5">
        <div className="t-label text-ink-3">Time range</div>
        <div className="mt-2 flex items-center gap-2">
          <Menu label="Baseline year" value={baseline} options={DEFAULT_YEARS.filter((y) => y < comparison).map(yearOpt)} onChange={(v) => setBaseline(Number(v))} className="h-9 flex-1 justify-between px-3 text-[13px]" />
          <ArrowRight size={14} className="shrink-0 text-ink-3" />
          <Menu label="Comparison year" value={comparison} options={DEFAULT_YEARS.filter((y) => y > baseline).map(yearOpt)} onChange={(v) => setComparison(Number(v))} className="h-9 flex-1 justify-between px-3 text-[13px]" align="right" />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          {baseline < 2016 ? 'Historical years (1984–2015) use Landsat (30 m); change events are detected only between analysable Sentinel-2 / Dynamic World years (2016 onward, where available).' : 'Sentinel-2 composites with Dynamic World tree evidence, where available for this area.'}
        </p>
      </div>

      <div className="mt-5 space-y-3">
        {tooLarge && <StateView compact kind="error" title="Area too large">Please select a smaller area for analysis — up to {max.toLocaleString()} km² (this selection is {area.toLocaleString('en-US', { maximumFractionDigits: 0 })} km²).</StateView>}
        {tooSmall && <StateView compact kind="error" title="Area too small">Select at least {min} km² so change regions can exceed the minimum mapping unit.</StateView>}
        {tooHeavy && <StateView compact kind="error" title="Analysis too large for interactive mode">This investigation covers a large area or time range that cannot be completed interactively. Try a smaller area (up to {interactiveMax?.toLocaleString()} km²) or shorter analysis window.</StateView>}
        {!tooLarge && !tooSmall && !tooHeavy && backendDown && <StateView compact kind="service-unavailable" title="Live analysis unavailable">Live Earth observation is temporarily unavailable. TERRATRACE does not display estimated, simulated, or placeholder measurements.</StateView>}
        {!tooLarge && !tooSmall && !tooHeavy && !backendDown && health && !eeReady && (
          <StateView compact kind="service-unavailable" title="Live analysis unavailable">
            Live Earth observation is temporarily unavailable. You can still open the area to explore real imagery — no measurements will be shown.
          </StateView>
        )}
        <Button
          variant="brand" size="lg" block disabled={blocked}
          trailing={<ArrowRight size={16} />}
          onClick={() => start({ geometry: selection.geometry, baseline_period: { year: baseline }, comparison_period: { year: comparison }, name: selection.name })}
        >
          {eeReady || !health ? 'Analyze forest change' : 'Open area · imagery only'}
        </Button>
        <div className="flex items-center justify-between">
          <Badge tone={eeReady ? 'forest' : 'warn'}>{eeReady ? 'Live Earth observation' : 'Live analysis unavailable'}</Badge>
          <div className="flex gap-1">
            <Tooltip content="Redraw as rectangle"><IconButton label="Redraw as rectangle" size="sm" onClick={() => setDrawTool('rect')}><SquareDashed size={14} /></IconButton></Tooltip>
            <Tooltip content="Redraw as polygon"><IconButton label="Redraw as polygon" size="sm" onClick={() => setDrawTool('polygon')}><Hexagon size={14} /></IconButton></Tooltip>
          </div>
        </div>
      </div>
    </motion.section>
  );
}
