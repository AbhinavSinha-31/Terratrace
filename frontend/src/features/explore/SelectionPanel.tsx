import { useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Eraser, Hexagon, SquareDashed, Trees } from 'lucide-react';
import { client } from '../../data/client';
import { useAreaContext, useCandidateRegistration, useHealth } from '../../data/queries';
import { fmtShare } from '../../lib/format';
import { selectCandidate, useAnalysisWindow, useUi } from '../../state/store';
import { geometryAreaKm2, geometryCentroid, fmtLatLon } from '../../lib/geo';
import { DEFAULT_YEARS, sourceLabel } from '../../lib/time';
import { Badge, Button, IconButton, Menu, StateView, Tooltip } from '../../design';
import { AnimatedNumber } from '../../design/Metric';

/**
 * Reference tree cover of the selection — the area's Earth Engine context (the SAME measurement and cache as the
 * analysis view's Area context panel). Loading while it is measured, "unavailable" if it fails; never a sampled or
 * guessed number. Labelled reference context with dataset and year.
 */
function SelectionReference() {
  const reg = useCandidateRegistration();
  const offline = useHealth().data?.backend === false;
  const ctx = useAreaContext(reg.data?.id ?? null);
  const c = ctx.data;
  const unavailable = offline || reg.isError || ctx.isError || c?.status === 'UNAVAILABLE';
  const loading = !unavailable && !c;
  const tc = c?.forest?.tree_cover_2000, wc = c?.forest?.worldcover_2021;
  const line = (label: string, v: { status: string } | undefined, pct: number | null | undefined, src: string) => (
    <div className="mt-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10.5px] text-ink-3">{label}</span>
        <span className="t-data text-[13px] text-ink-2">{v?.status === 'READY' ? fmtShare(pct) : 'Unavailable'}</span>
      </div>
      <div className="t-data text-[9px] text-ink-4">{src}</div>
    </div>
  );
  return (
    <div className="bg-surface px-3.5 py-3" data-testid="reference-tree-cover" data-status={loading ? 'LOADING' : unavailable ? 'UNAVAILABLE' : 'READY'}>
      <div className="t-label flex items-center gap-1.5 text-ink-4"><Trees size={11} />Reference context</div>
      {loading ? (
        <div aria-busy="true"><div className="skeleton mt-2 h-4 w-full" /><div className="skeleton mt-2 h-4 w-full" /><div className="mt-1.5 text-[10px] text-ink-4">Measuring in Earth Engine…</div></div>
      ) : unavailable ? (
        <div className="mt-1.5 text-[11px] leading-snug text-warn" data-testid="reference-unavailable">Unavailable{c?.reason ? ` — ${c.reason}` : reg.isError ? ' — the area could not be registered.' : ''}</div>
      ) : (
        <>
          {line('Tree cover · 2000', tc, tc?.share_of_land_pct, 'Hansen GFC v1.13 · 2000 baseline')}
          {line('Tree cover · 2021', wc, wc?.share_of_land_pct, 'ESA WorldCover v200 · 2021')}
          {c?.surface?.message && <div className="mt-1.5 text-[10px] leading-snug text-ink-3" data-testid="reference-surface">{c.surface.message}</div>}
        </>
      )}
      <div className="mt-1.5 text-[9.5px] leading-snug text-ink-4">Not a TerraTrace result · not current forest cover</div>
    </div>
  );
}

/**
 * SELECTED AREA. Regression (2026-10-10): clearing a selection crashed the app ("Cannot read properties of null
 * (reading 'geometry')") — the panel's exit animation keeps it mounted after the selection becomes null. The panel
 * now keeps the last selection while it animates out, so it never renders without one.
 */
export function SelectionPanel() {
  const current = useUi(selectCandidate);
  const last = useRef(current);
  if (current) last.current = current;
  return last.current ? <SelectionPanelBody selection={last.current} /> : null;
}

/** SELECTED AREA — measurement, reference context, time range and the Analyze action. */
function SelectionPanelBody({ selection }: { selection: NonNullable<ReturnType<typeof selectCandidate>> }) {
  const setSelection = useUi((s) => s.setSelection);
  const setDrawTool = useUi((s) => s.setDrawTool);
  const requestAnalysis = useUi((s) => s.requestAnalysis);
  const { data: health } = useHealth();
  // Baseline/comparison are the investigation's own years (no local copy).
  const { start: baseline, end: comparison } = useAnalysisWindow();
  const setWindow = useUi((s) => s.setWindow);

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
  // Every area can be analysed (no forest / latitude refusal). Only a geometry the backend cannot accept blocks Run.
  const invalidShape = !tooLarge && !tooSmall && !tooHeavy && preview.data && !preview.data.valid && preview.data.message ? preview.data : null;
  const blocked = tooLarge || tooSmall || tooHeavy || !!invalidShape || !!backendDown;
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
          <div className="mt-1 text-[10px] text-ink-4" data-testid="area-limits">Analysable: {min}–{(interactiveMax ?? max).toLocaleString()} km²</div>
        </div>
        <SelectionReference />
      </div>

      <div className="mt-5">
        <div className="t-label text-ink-3">Time range</div>
        <div className="mt-2 flex items-center gap-2">
          <Menu label="Baseline year" value={baseline} options={DEFAULT_YEARS.filter((y) => y < comparison).map(yearOpt)} onChange={(v) => setWindow(Number(v), comparison)} className="h-9 flex-1 justify-between px-3 text-[13px]" />
          <ArrowRight size={14} className="shrink-0 text-ink-3" />
          <Menu label="Comparison year" value={comparison} options={DEFAULT_YEARS.filter((y) => y > baseline).map(yearOpt)} onChange={(v) => setWindow(baseline, Number(v))} className="h-9 flex-1 justify-between px-3 text-[13px]" align="right" />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          {baseline < 2016 ? 'Historical years (1984–2015) show Landsat imagery (30 m) only, without forest figures; forest and change are measured only between analysable Sentinel-2 / Dynamic World years (2016 onward, where available).' : 'Sentinel-2 composites with Dynamic World tree evidence, where available for this area.'}
        </p>
      </div>

      <div className="mt-5 space-y-3">
        {tooLarge && <StateView compact kind="error" title="Area too large">Please select a smaller area for analysis — up to {max.toLocaleString()} km² (this selection is {area.toLocaleString('en-US', { maximumFractionDigits: 0 })} km²).</StateView>}
        {tooSmall && <StateView compact kind="error" title="Area too small">Select at least {min} km² so change regions can exceed the minimum mapping unit.</StateView>}
        {invalidShape && <StateView compact kind="error" title="Invalid area shape"><span data-testid="area-invalid" data-code={invalidShape.code ?? ''}>{invalidShape.message}</span></StateView>}
        {tooHeavy && <StateView compact kind="error" title="Analysis area exceeds the interactive limit">Analysis area exceeds TerraTrace's {interactiveMax?.toLocaleString()} km² limit. Select a smaller area — no forest-change analysis is run for this one.</StateView>}
        {!tooLarge && !tooSmall && !tooHeavy && backendDown && <StateView compact kind="service-unavailable" title="Live analysis unavailable">Live Earth observation is temporarily unavailable. TERRATRACE does not display estimated, simulated, or placeholder measurements.</StateView>}
        {!tooLarge && !tooSmall && !tooHeavy && !backendDown && health && !eeReady && (
          <StateView compact kind="service-unavailable" title="Live analysis unavailable">
            Live Earth observation is temporarily unavailable. You can still open the area to explore real imagery — no measurements will be shown.
          </StateView>
        )}
        <Button
          variant="brand" size="lg" block disabled={blocked}
          trailing={<ArrowRight size={16} />}
          onClick={() => requestAnalysis()}
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
