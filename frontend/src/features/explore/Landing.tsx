import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, ChevronRight, Database, Layers3, ScanSearch, ShieldCheck, Trees } from 'lucide-react';
import { useFeaturedSummary, useHealth, useStudyAreas, useStudyCard } from '../../data/queries';
import { ChatLauncher } from '../chat/ChatLauncher';
import { selectCandidate, useUi } from '../../state/store';
import type { StudyArea } from '../../data/contracts';
import { fmtHa, fmtKm2, shortBiome } from '../../lib/format';
import { useBreakpoint } from '../../lib/useLayout';
import { DEFAULT_ANALYSIS_WINDOW, ERAS } from '../../lib/time';
import { Badge, Button, IconButton, Skeleton, StateView, TerratraceMark, Tooltip } from '../../design';
import { AnimatedNumber } from '../../design/Metric';
import { DrawHint, SearchBar } from './SearchBar';
import { SelectionPanel } from './SelectionPanel';
import { CaseStudyCard } from '../casestudy/CaseStudyCard';
import { CASE_STUDIES } from '../casestudy/data';

const EASE = [0.22, 1, 0.36, 1] as const;

// ---------------------------------------------------------------- hero
function Hero() {
  const setPhase = useUi((s) => s.setPhase);
  return (
    <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.6, ease: EASE }} className="pointer-events-auto max-w-[580px]" aria-labelledby="hero-title" data-map-occluder>
      <div className="t-label flex flex-wrap gap-x-3 gap-y-1 text-ink-3">
        {['Forests', 'Satellites', 'Change', 'Evidence'].map((w, i) => (
          <span key={w} className="flex items-center gap-3">{i > 0 && <span className="text-ink-4">•</span>}{w}</span>
        ))}
      </div>
      <h1 id="hero-title" className="tt-hero-title mt-[clamp(12px,2.2vh,20px)] max-w-[11.6em]">
        See where forests
        <br /> are changing —
        <br /><span className="tt-hero-accent">and the evidence<br />behind it.</span>
      </h1>
      <p className="mt-[clamp(14px,2.4vh,24px)] max-w-[500px] text-[clamp(13.5px,1.65vh,15.5px)] leading-[1.6] text-ink-2 lg:[@media(max-height:760px)]:hidden">
        TERRATRACE uses decades of satellite data, advanced analysis and explainable AI to detect, quantify and investigate forest-cover change anywhere on Earth.
      </p>
      <div className="mt-[clamp(16px,2.8vh,30px)] flex flex-wrap gap-3">
        <Button variant="brand" size="lg" className="!h-[50px] !px-6 !text-[14.5px]" icon={<ScanSearch size={18} />} trailing={<ArrowRight size={17} />} onClick={() => setPhase('explore')}>
          Explore Earth
        </Button>
      </div>
      <div className="mt-[clamp(20px,3.2vh,36px)] grid max-w-[560px] grid-cols-3 gap-4 [@media(max-height:960px)]:hidden">
        {[
          { icon: Database, t: 'Decades of data', d: 'Landsat + Sentinel-2' },
          { icon: Layers3, t: 'Scientific analysis', d: 'NDVI • NBR • Land cover' },
          { icon: ShieldCheck, t: 'Explainable insights', d: 'Evidence-based AI' },
        ].map(({ icon: Icon, t, d }) => (
          <div key={t} className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.35)]"><Icon size={18} /></span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-ink">{t}</span>
              <span className="block text-[11px] text-ink-3">{d}</span>
            </span>
          </div>
        ))}
      </div>
    </motion.section>
  );
}

// ---------------------------------------------------------------- right panels
function OverviewPanel() {
  const areas = useStudyAreas();
  const summary = useFeaturedSummary();
  const { data: health } = useHealth();
  const items = areas.data?.items ?? [];
  // Control sites (stable forest, tagged in the featured data) measure the false-alarm rate: their detections are
  // reported separately and never added to the detected-change total.
  const isControl = (id: string) => !!items.find((a) => a.id === id)?.tags.some((t) => /control site/i.test(t));
  // STORED READY results of the featured investigations (pre-computed by the backend for each default window) — the
  // results' own figures, read-only. INVALID / UNAVAILABLE sites contribute nothing.
  const ready = (summary.data?.items ?? []).filter((i) => i.status === 'READY' && i.kpis);
  const counted = ready.filter((r) => !isControl(r.id));
  const controls = ready.filter((r) => isControl(r.id));
  // "Detected change" = area of the detected change events (the polygons drawn on the map) of completed live
  // analyses — not gross loss, which sums year-to-year forest-mask transitions (including reversals).
  const areaOf = (rs: typeof ready) => rs.reduce((a, r) => a + (r.kpis?.event_area_ha ?? 0), 0);
  const countOf = (rs: typeof ready) => rs.reduce((a, r) => a + (r.kpis?.event_count ?? 0), 0);
  const events = countOf(counted);
  const n = items.length;
  const eeReady = health?.analysis.status === 'ready';
  return (
    <section className="tt-panel pointer-events-auto px-5 py-4" aria-labelledby="gfo" data-map-occluder>
      <div className="flex items-center gap-2.5">
        <Trees size={16} className="text-forest" />
        <h2 id="gfo" className="t-label text-ink">Global forest overview</h2>
      </div>
      <div className="mt-4">
        <div className="text-[12px] text-ink-3">World forest area</div>
        <div className="mt-1 flex items-end justify-between gap-3">
          <div className="t-data text-[26px] font-medium leading-none">40.6 <span className="text-[16px] text-ink-2">M km²</span></div>
          <div className="text-right">
            <div className="t-data text-[15px] text-forest">31%</div>
            <div className="text-[10.5px] text-ink-3">of land area</div>
          </div>
        </div>
        <div className="mt-1.5 text-[10.5px] text-ink-4">Reference · FAO FRA 2020</div>
      </div>
      <div className="my-3.5 h-px bg-line" />
      <div data-testid="overview-detected-change">
        <div className="text-[12px] text-ink-3">Detected change · TERRATRACE</div>
        {counted.length > 0 ? (
          <>
            <div className="mt-1 flex items-end justify-between gap-3">
              <div className="t-data text-[26px] font-medium leading-none text-[#ff8a6b]">
                <AnimatedNumber value={areaOf(counted)} format={(v) => fmtHa(v)} /> <span className="text-[16px] text-ink-2">ha</span>
              </div>
              <div className="text-right">
                <div className="t-data text-[15px] text-ink">{events}</div>
                <div className="text-[10.5px] text-ink-3">events · {counted.length} live {counted.length === 1 ? 'analysis' : 'analyses'}</div>
              </div>
            </div>
            <div className="mt-1.5 text-[10.5px] text-ink-4">Area of detected change events{controls.length ? ' · control sites excluded' : ''}</div>
          </>
        ) : (
          <div className="mt-1.5">
            <div className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
              <span className={`h-1.5 w-1.5 rounded-full ${eeReady ? 'bg-live' : 'bg-warn'}`} />
              {controls.length ? 'No change-site analyses yet' : 'No completed live analyses'}
            </div>
            <div className="mt-1 text-[10.5px] leading-snug text-ink-4">{eeReady && health?.backend ? 'Open an area to run a live analysis.' : 'Live analysis is temporarily unavailable.'}</div>
          </div>
        )}
        {controls.map((r) => {
          const n = countOf([r]);
          const name = items.find((a) => a.id === r.id)?.short_name ?? r.id;
          return (
            <div key={r.id} className="mt-2 text-[10.5px] leading-snug text-ink-3" data-testid="overview-control">
              Control site · {name}: {n} {n === 1 ? 'detection' : 'detections'} ({fmtHa(areaOf([r]))} ha) — false-alarm check, not counted
            </div>
          );
        })}
      </div>
      <div className="my-3.5 h-px bg-line" />
      <div>
        <div className="text-[12px] text-ink-3">Featured investigations</div>
        <div className="t-data mt-1 text-[26px] font-medium leading-none">{n ? String(n).padStart(2, '0') : '—'}</div>
        <div className="mt-1 text-[10.5px] text-ink-4">Any area on Earth can be analysed</div>
      </div>
    </section>
  );
}
function DataSourcesPanel() {
  const colors = { L: '#5aa2ff', S: '#4cb782', D: '#a78bfa' };
  return (
    <section className="tt-panel pointer-events-auto px-5 py-4 [@media(max-height:940px)]:hidden" aria-labelledby="ds" data-map-occluder>
      <div className="flex items-center gap-2.5">
        <Layers3 size={15} className="text-accent" />
        <h2 id="ds" className="t-label text-ink">Data sources</h2>
      </div>
      <ul className="mt-3 space-y-0.5">
        {ERAS.map((e) => (
          <li key={e.key}>
            <Tooltip content={e.note} side="left">
              <button onClick={() => useUi.getState().setAboutOpen(true)} className="tt-press flex w-full items-center gap-3 rounded-md px-1.5 py-1.5 text-left hover:bg-hover">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colors[e.key], boxShadow: `0 0 8px ${colors[e.key]}` }} />
                <span className="flex-1 text-[12.5px] text-ink">{e.name}</span>
                <span className="t-data text-[11px] text-ink-3">{Math.floor(e.from)} – present</span>
                <ChevronRight size={14} className="text-ink-4" />
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- featured
function FeaturedCard({ area, index, highlight }: { area: StudyArea; index: number; highlight: boolean }) {
  const open = useUi((s) => s.openAnalysis);
  const hover = useUi((s) => s.hoverAoi);
  const hovered = useUi((s) => s.hoveredAoiId === area.id);
  const [state, ...rest] = area.region.split(',').map((s) => s.trim());
  // Static thumbnail from the backend's study metadata (imagery only; URLs are never built here).
  const img = area.thumbnail_url;
  const { status, detail, reason } = useStudyCard(area.id);
  const tone = status === 'Analysis ready' ? 'text-live' : status === 'Processing' ? 'text-accent' : status === 'Scientific validation required' || status === 'Analysis failed' ? 'text-bad' : 'text-warn';
  const dot = status === 'Analysis ready' ? 'bg-live' : status === 'Processing' ? 'bg-accent animate-pulse' : status === 'Scientific validation required' || status === 'Analysis failed' ? 'bg-bad' : 'bg-warn';
  return (
    <motion.button
      initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + index * 0.07, duration: 0.5, ease: EASE }}
      onClick={() => {
        if (import.meta.env.DEV) console.debug('[analysis] featured card click', { id: area.id, bbox: area.bbox, window: DEFAULT_ANALYSIS_WINDOW });
        // The site's default window (measured-analysable years): a stored result for it opens instantly.
        open(area.id, { name: area.name, geometry: area.geometry, window: area.default_window ? { start: area.default_window[0], end: area.default_window[1] } : undefined, run: true });
      }}
      data-card-status={status}
      onMouseEnter={() => hover(area.id)} onMouseLeave={() => hover(null)} onFocus={() => hover(area.id)} onBlur={() => hover(null)}
      className={`tt-card group relative flex min-w-[260px] flex-col xl:min-w-0 overflow-hidden rounded-lg text-left ${hovered || highlight ? 'is-hover' : ''}`}
      aria-label={`Open featured investigation: ${area.name}`}
    >
      <div className="relative h-[clamp(76px,10.5vh,124px)] overflow-hidden">
        <img src={img} alt="" loading="lazy" className="h-full w-full scale-105 object-cover transition duration-700 ease-out group-hover:scale-[1.12]" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/5 via-transparent to-[#0b0f12]" />
        <div className="absolute left-3 top-3 flex gap-1.5">
          <span className="tt-img-badge">{area.country}</span>
          <span className="tt-img-badge">{rest.length ? state : area.region}</span>
        </div>
      </div>
      <div className="flex flex-1 flex-col px-4 pb-3.5 pt-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold tracking-[-0.005em] text-ink">{area.name}</div>
            <div className="mt-0.5 truncate text-[12px] text-ink-3">{area.tags[0] ?? area.biome}</div>
          </div>
          <ChevronRight size={18} className="mt-0.5 shrink-0 text-ink-3 transition group-hover:translate-x-1 group-hover:text-accent" />
        </div>
        <div className="mt-[clamp(8px,1.4vh,14px)] grid grid-cols-2 divide-x divide-line">
          {/* AOI facts only — measured results appear inside the analysis once it is READY. */}
          {[
            [`${fmtKm2(area.area_km2)} km²`, 'area of interest', null],
            [shortBiome(area.biome), 'biome', area.biome],
          ].map(([v, l, full], i) => (
            <div key={l} className={`min-w-0 ${i === 0 ? 'pr-3' : 'px-3'}`}>
              <div className={`t-data text-[14px] font-medium text-ink ${i === 1 ? 'line-clamp-2 leading-tight' : 'truncate'}`} title={full ?? v ?? undefined}>{v}</div>
              <div className="text-[10.5px] text-ink-3">{l}</div>
            </div>
          ))}
        </div>
        {/* Live analysis state. The detail gets its own line: next to the long status label it had no room left. */}
        <div className="mt-2.5 min-w-0 border-t border-line pt-2" title={reason ?? detail ?? status} data-testid="card-status">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
            <span className={`t-data min-w-0 truncate text-[12.5px] font-medium ${tone}`}>{status}</span>
            {!detail?.trim() && <LiveAnalysisLabel />}
          </div>
          {detail?.trim() && (
            <div className="mt-0.5 flex min-w-0 items-center gap-2 pl-4">
              <span className="min-w-0 truncate text-[11px] text-ink-3">{detail}</span>
              <LiveAnalysisLabel />
            </div>
          )}
        </div>
      </div>
    </motion.button>
  );
}

const LiveAnalysisLabel = () => <span className="ml-auto shrink-0 text-[10.5px] text-ink-4">live analysis</span>;

function Featured() {
  const { data, isLoading, isError, error, refetch } = useStudyAreas();
  const setPhase = useUi((s) => s.setPhase);
  const frontPage = useUi((s) => s.view === 'explore' && s.phase === 'intro');
  const [highlight, setHighlight] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const on = () => {
      setHighlight(true);
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      window.setTimeout(() => setHighlight(false), 1600);
    };
    window.addEventListener('tt:featured', on);
    return () => window.removeEventListener('tt:featured', on);
  }, []);
  return (
    <section ref={ref} className="pointer-events-auto" aria-labelledby="fi" data-map-occluder>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <div className="flex items-center gap-2.5">
            <TerratraceMark size={18} />
            <h2 id="fi" className="t-label text-[11px] leading-none text-ink">Featured investigations</h2>
          </div>
          <p className="mt-1.5 text-[12px] text-ink-3">Real-world examples to explore. You can also select any area on Earth.</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button onClick={() => setPhase('explore')} className="tt-press flex shrink-0 items-center gap-1.5 text-[12px] text-accent hover:underline">
            Explore anywhere <ArrowRight size={14} />
          </button>
          {/* In the header row (normal flow): never over a card, at any width. */}
          {frontPage && <ChatLauncher />}
        </div>
      </div>
      {/* Live investigations from the backend, then the static case studies — which need no backend, so they stay
          visible (and are never counted in the live totals) even when the investigations cannot be loaded. */}
      <div className="no-scrollbar -mx-1 flex gap-4 overflow-x-auto px-1 pb-1 xl:grid xl:grid-cols-5 xl:overflow-visible">
        {isError && (
          <div className="tt-panel min-w-[260px] xl:col-span-4"><StateView kind="service-unavailable" title="Investigations unavailable" onRetry={() => refetch()}>{(error as Error)?.message}</StateView></div>
        )}
        {isLoading && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[200px] min-w-[260px] rounded-lg" />)}
        {data?.items.map((a, i) => <FeaturedCard key={a.id} area={a} index={i} highlight={highlight} />)}
        {CASE_STUDIES.map((c, i) => <CaseStudyCard key={c.id} meta={c} index={(data?.items.length ?? 4) + i} />)}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- composition
export function Landing() {
  const phase = useUi((s) => s.phase);
  const selection = useUi(selectCandidate);
  const drawTool = useUi((s) => s.drawTool);
  const setPhase = useUi((s) => s.setPhase);
  const { data: health } = useHealth();
  const bp = useBreakpoint();

  if (bp === 'mobile') return <MobileLanding />;

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <AnimatePresence mode="wait">
        {phase === 'intro' ? (
          // Column layout: [header] [top region] [featured row]. Everything is in normal flow, so the top region is
          // always at least as tall as the hero and the featured row always starts below it. When the viewport is too
          // short for both, the overlay scrolls instead of overlapping.
          // Top region (lg+): grid [hero | globe slot over search bar | panels (≥1320 px)]. The globe is framed inside
          // the measured `data-globe-slot` (lib/useLayout.landingInset), so the search bar never covers it.
          <motion.div key="intro" className="no-scrollbar absolute inset-0 flex flex-col overflow-y-auto pt-16" exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
            <div className="tt-hero-scrim absolute inset-y-0 left-0 w-[46%]" />
            <div className="tt-featured-scrim absolute inset-x-0 bottom-0 h-[42%]" />
            <div className="relative flex-1 px-6 pt-4 lg:grid min-[1024px]:grid-cols-[minmax(0,540px)_minmax(0,1fr)] lg:gap-x-8 lg:pl-10 xl:pl-14 min-[1320px]:grid-cols-[minmax(0,540px)_minmax(0,1fr)_292px]">
              <div className="pt-[clamp(0px,calc(4.5vh-24px),24px)]">
                <Hero />
              </div>
              <div className="hidden min-h-[240px] flex-col lg:flex">
                <GlobeSlot />
                <div className="pointer-events-auto mx-auto w-full max-w-[720px] pt-3" data-map-occluder><SearchBar /></div>
              </div>
              <motion.div initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25, duration: 0.6, ease: EASE }}
                className="hidden space-y-3 self-start min-[1320px]:block">
                <OverviewPanel />
                <DataSourcesPanel />
              </motion.div>
            </div>
            <div className="relative shrink-0 px-6 pb-4 pt-4 xl:px-10">
              <div className="pointer-events-auto mb-4 lg:hidden"><SearchBar /></div>
              <Featured />
            </div>
          </motion.div>
        ) : (
          <motion.div key="explore" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute left-1/2 top-[84px] w-[min(760px,calc(100vw-48px))] -translate-x-1/2 space-y-3">
              <div className="pointer-events-auto flex items-center gap-2">
                <Tooltip content="Back to overview">
                  <IconButton variant="secondary" label="Back to overview" size="lg" onClick={() => { setPhase('intro'); useUi.getState().setSelection(null); useUi.getState().setDrawTool(null); }}>
                    <ArrowLeft size={17} />
                  </IconButton>
                </Tooltip>
                <SearchBar compact />
              </div>
              <div className="flex justify-center"><DrawHint /></div>
            </div>
            {/* ONE right-hand column: the selection panel (scrolls when tall) above the legend — they can never overlap.
                The column itself lets clicks through to the map; only its panels take pointer events. */}
            <div className="pointer-events-none absolute bottom-6 right-6 top-[160px] flex w-[360px] flex-col items-end gap-3" data-testid="explore-right-column">
              <AnimatePresence>
                {selection && !drawTool && (
                  <div className="scroll-thin pointer-events-auto min-h-0 w-full shrink overflow-y-auto rounded-lg" data-testid="selection-panel-wrap"><SelectionPanel /></div>
                )}
              </AnimatePresence>
              <div className="mt-auto shrink-0"><MapLegendChip /></div>
            </div>
            {!selection && !drawTool && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
                className="tt-panel pointer-events-auto absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-4 px-5 py-3.5">
                <span className="t-label text-accent">Explore anywhere</span>
                <span className="text-[12.5px] text-ink-2">Search a place, click the map at regional zoom, or use <b className="font-medium text-ink">Draw Area</b> to define an area of interest.</span>
              </motion.div>
            )}
            {health && !health.backend && <div className="absolute bottom-6 left-6"><Badge tone="warn">Live analysis unavailable</Badge></div>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The area the landing globe is framed into. When its size changes (window resize, panels or cards appearing),
 * the globe is re-framed so it stays fully inside — the map reads the slot's rectangle in landingInset().
 */
function GlobeSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let t = 0, last = '';
    const ro = new ResizeObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        const size = `${Math.round(r.width)}x${Math.round(r.height)}`;
        const s = useUi.getState();
        if (size === last || s.phase !== 'intro' || selectCandidate(s) || s.drawTool) return;
        last = size;
        s.requestCamera({ kind: 'home' });
      }, 200);
    });
    ro.observe(el);
    return () => { window.clearTimeout(t); ro.disconnect(); };
  }, []);
  return (
    <div ref={ref} data-globe-slot className="relative min-h-0 flex-1">
      <div className="absolute bottom-2 right-0" data-map-occluder><LandingMapControls /></div>
    </div>
  );
}

function LandingMapControls() {
  const req = useUi((s) => s.requestCamera);
  return (
    <div className="tt-panel pointer-events-auto flex flex-col p-1">
      <Tooltip content="Zoom in" side="left"><IconButton label="Zoom in" size="sm" onClick={() => req({ kind: 'zoom-in' })}><span className="text-[16px] leading-none">+</span></IconButton></Tooltip>
      <Tooltip content="Zoom out" side="left"><IconButton label="Zoom out" size="sm" onClick={() => req({ kind: 'zoom-out' })}><span className="text-[16px] leading-none">−</span></IconButton></Tooltip>
      <div className="mx-1.5 my-1 h-px bg-line" />
      <Tooltip content="Reset globe" side="left"><IconButton label="Reset globe" size="sm" onClick={() => req({ kind: 'home' })}><ArrowLeft size={14} className="rotate-45" /></IconButton></Tooltip>
    </div>
  );
}

/** Distinguishes reference forest cover from TERRATRACE-detected change. */
function MapLegendChip() {
  return (
    <div className="tt-panel pointer-events-auto space-y-1.5 px-3.5 py-3 text-[11px] text-ink-2" data-testid="map-legend">
      <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-[2px] bg-[#1f9d57]" /> Forest cover · reference (Hansen 2000)</div>
      <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[#ff6b52] shadow-[0_0_8px_#ff6b52]" /> Detected change · completed live analyses only</div>
    </div>
  );
}

function MobileLanding() {
  const phase = useUi((s) => s.phase);
  const selection = useUi(selectCandidate);
  const drawTool = useUi((s) => s.drawTool);
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <div className="absolute inset-x-3 top-[74px] space-y-2">
        <div className="pointer-events-auto"><SearchBar compact /></div>
        <div className="flex justify-center"><DrawHint /></div>
      </div>
      <div className="scroll-thin pointer-events-auto absolute inset-x-0 bottom-0 max-h-[56vh] overflow-y-auto rounded-t-xl bg-[#07090c]/96 px-4 pb-6 pt-5 shadow-[0_-20px_40px_-10px_rgba(0,0,0,.8),0_0_0_1px_rgba(255,255,255,.06)]">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/15" />
        {selection && !drawTool ? <SelectionPanel /> : phase === 'intro' ? (
          <div className="space-y-6"><Hero /><Featured /><OverviewPanel /><DataSourcesPanel /></div>
        ) : (
          <div className="space-y-6"><Featured /></div>
        )}
      </div>
    </div>
  );
}
