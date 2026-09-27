import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, ChevronRight, Database, Layers3, Play, ScanSearch, ShieldCheck, Trees } from 'lucide-react';
import { useHealth, useReadyResults, useStudyAreas } from '../../data/queries';
import { useUi } from '../../state/store';
import type { StudyArea } from '../../data/contracts';
import { fmtKm2 } from '../../lib/format';
import { useBreakpoint } from '../../lib/useLayout';
import { ERAS } from '../../lib/time';
import { Badge, Button, IconButton, Skeleton, StateView, TerratraceMark, Tooltip } from '../../design';
import { AnimatedNumber } from '../../design/Metric';
import { DrawHint, SearchBar } from './SearchBar';
import { SelectionPanel } from './SelectionPanel';
import { startPresentation } from '../shell/Header';

const EASE = [0.22, 1, 0.36, 1] as const;

function tileFor(lon: number, lat: number, z: number, year = 2025) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${year}_3857/default/g/${z}/${y}/${x}.jpg`;
}

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
      <p className="mt-[clamp(14px,2.4vh,24px)] max-w-[500px] text-[clamp(13.5px,1.65vh,15.5px)] leading-[1.6] text-ink-2">
        TERRATRACE uses decades of satellite data, advanced analysis and explainable AI to detect, quantify and investigate forest-cover change anywhere on Earth.
      </p>
      <div className="mt-[clamp(16px,2.8vh,30px)] flex flex-wrap gap-3">
        <Button variant="brand" size="lg" className="!h-[50px] !px-6 !text-[14.5px]" icon={<ScanSearch size={18} />} trailing={<ArrowRight size={17} />} onClick={() => setPhase('explore')}>
          Explore Earth
        </Button>
        <Button variant="outline" size="lg" className="!h-[50px] !px-6 !text-[14.5px]" icon={<Play size={16} />} onClick={startPresentation}>
          Guided tour
        </Button>
      </div>
      <div className="mt-[clamp(20px,3.2vh,36px)] grid max-w-[560px] grid-cols-3 gap-4 [@media(max-height:820px)]:hidden">
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
  const ready = useReadyResults();
  const { data: health } = useHealth();
  // Detected change is summed ONLY over completed live analyses — never estimated.
  const totalLoss = ready.reduce((a, r) => a + (r.bundle?.summary.kpis.total_loss_ha ?? 0), 0);
  const events = ready.reduce((a, r) => a + (r.bundle?.events.features.length ?? 0), 0);
  const n = areas.data?.items.length ?? 0;
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
        {ready.length > 0 ? (
          <div className="mt-1 flex items-end justify-between gap-3">
            <div className="t-data text-[26px] font-medium leading-none text-[#ff8a6b]">
              −<AnimatedNumber value={totalLoss} format={(v) => Math.round(v).toLocaleString('en-US')} /> <span className="text-[16px] text-ink-2">ha</span>
            </div>
            <div className="text-right">
              <div className="t-data text-[15px] text-ink">{events}</div>
              <div className="text-[10.5px] text-ink-3">events · {ready.length} live {ready.length === 1 ? 'analysis' : 'analyses'}</div>
            </div>
          </div>
        ) : (
          <div className="mt-1.5">
            <div className="flex items-center gap-2 text-[13px] font-medium text-ink-2"><span className={`h-1.5 w-1.5 rounded-full ${eeReady ? 'bg-live' : 'bg-warn'}`} />No completed live analyses</div>
            <div className="mt-1 text-[10.5px] leading-snug text-ink-4">{eeReady && health?.backend ? 'Open an area to run a live analysis.' : 'Live analysis is temporarily unavailable.'}</div>
          </div>
        )}
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
    <section className="tt-panel pointer-events-auto px-5 py-4 [@media(max-height:860px)]:hidden" aria-labelledby="ds" data-map-occluder>
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
  const img = useMemo(() => tileFor(area.center[0], area.center[1], 11), [area.center]);
  const ready = useReadyResults().some((r) => r.id === area.id);
  const { data: health } = useHealth();
  const status = ready ? 'Ready' : !health ? '…' : health.backend && health.analysis.status === 'ready' ? 'Not run' : 'Unavailable';
  return (
    <motion.button
      initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + index * 0.07, duration: 0.5, ease: EASE }}
      onClick={() => open(area.id)}
      onMouseEnter={() => hover(area.id)} onMouseLeave={() => hover(null)} onFocus={() => hover(area.id)} onBlur={() => hover(null)}
      className={`tt-card group relative flex min-w-[260px] flex-col overflow-hidden rounded-lg text-left ${hovered || highlight ? 'is-hover' : ''}`}
      aria-label={`Open featured investigation: ${area.name}`}
    >
      <div className="relative h-[clamp(64px,10vh,104px)] overflow-hidden">
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
        <div className="mt-[clamp(8px,1.4vh,14px)] grid grid-cols-3 divide-x divide-line">
          {/* AOI facts only — measured results appear inside the analysis once it is READY. */}
          {[
            [`${fmtKm2(area.area_km2)} km²`, 'area of interest', 'text-ink'],
            [area.biome?.split(/[—–(]/)[0].trim() || '—', 'biome', 'text-ink'],
            [status, 'live analysis', ready ? 'text-live' : 'text-warn'],
          ].map(([v, l, c], i) => (
            <div key={l} className={`min-w-0 ${i === 0 ? 'pr-3' : 'px-3'}`}>
              <div className={`t-data truncate text-[14px] font-medium ${c}`} title={v}>{v}</div>
              <div className="text-[10.5px] text-ink-3">{l}</div>
            </div>
          ))}
        </div>
      </div>
    </motion.button>
  );
}

function Featured() {
  const { data, isLoading, isError, error, refetch } = useStudyAreas();
  const setPhase = useUi((s) => s.setPhase);
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
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <TerratraceMark size={22} />
          <div>
            <h2 id="fi" className="t-label text-[11px] text-ink">Featured investigations</h2>
            <p className="mt-1 text-[12px] text-ink-3">Real-world examples to explore. You can also select any area on Earth.</p>
          </div>
        </div>
        <button onClick={() => setPhase('explore')} className="tt-press flex shrink-0 items-center gap-1.5 text-[12px] text-accent hover:underline">
          Explore anywhere <ArrowRight size={14} />
        </button>
      </div>
      {isError ? (
        <div className="tt-panel"><StateView kind="service-unavailable" title="Investigations unavailable" onRetry={() => refetch()}>{(error as Error)?.message}</StateView></div>
      ) : (
        <div className="no-scrollbar -mx-1 flex gap-4 overflow-x-auto px-1 pb-1 lg:grid lg:grid-cols-4 lg:overflow-visible">
          {isLoading && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[200px] min-w-[260px] rounded-lg" />)}
          {data?.items.map((a, i) => <FeaturedCard key={a.id} area={a} index={i} highlight={highlight} />)}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- composition
export function Landing() {
  const phase = useUi((s) => s.phase);
  const selection = useUi((s) => s.selection);
  const drawTool = useUi((s) => s.drawTool);
  const setPhase = useUi((s) => s.setPhase);
  const { data: health } = useHealth();
  const bp = useBreakpoint();

  if (bp === 'mobile') return <MobileLanding />;

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <AnimatePresence mode="wait">
        {phase === 'intro' ? (
          // Column layout: [header] [top region: hero · globe · panels · search] [featured row].
          // The featured row is its own block, so nothing in the top region can overlap it.
          <motion.div key="intro" className="absolute inset-0 flex flex-col pt-16" exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
            <div className="tt-hero-scrim absolute inset-y-0 left-0 w-[46%]" />
            <div className="tt-featured-scrim absolute inset-x-0 bottom-0 h-[42%]" />
            <div className="relative min-h-0 flex-1">
              <div className="absolute left-10 top-[clamp(20px,4.5vh,48px)] xl:left-14">
                <Hero />
              </div>
              <motion.div initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25, duration: 0.6, ease: EASE }}
                className="absolute right-6 top-5 hidden w-[292px] space-y-3 min-[1320px]:block">
                <OverviewPanel />
                <DataSourcesPanel />
              </motion.div>
              {/* Search sits between the hero column and the right panels, overlapping the lower globe. */}
              <div className="absolute bottom-3 left-[max(600px,44%)] right-6 hidden lg:block min-[1320px]:right-[332px] [@media(min-height:821px)]:left-[max(648px,44%)]">
                <div className="mx-auto max-w-[720px]" data-map-occluder><SearchBar /></div>
              </div>
              <div className="absolute bottom-[84px] right-6 hidden lg:block min-[1320px]:right-[332px]" data-map-occluder><LandingMapControls /></div>
            </div>
            <div className="relative shrink-0 px-6 pb-5 pt-4 xl:px-10">
              <div className="mb-4 lg:hidden"><SearchBar /></div>
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
            <AnimatePresence>
              {selection && !drawTool && (
                <div className="absolute right-6 top-[160px] w-[360px]"><div className="pointer-events-auto"><SelectionPanel /></div></div>
              )}
            </AnimatePresence>
            {!selection && !drawTool && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
                className="tt-panel pointer-events-auto absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-4 px-5 py-3.5">
                <span className="t-label text-accent">Explore anywhere</span>
                <span className="text-[12.5px] text-ink-2">Search a place, click the map at regional zoom, or use <b className="font-medium text-ink">Draw Area</b> to define an area of interest.</span>
              </motion.div>
            )}
            <MapLegendChip />
            {health && !health.backend && <div className="absolute bottom-6 left-6"><Badge tone="warn">Live analysis unavailable</Badge></div>}
          </motion.div>
        )}
      </AnimatePresence>
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
    <div className="tt-panel pointer-events-auto absolute bottom-6 right-6 space-y-1.5 px-3.5 py-3 text-[11px] text-ink-2">
      <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-[2px] bg-[#1f9d57]" /> Forest cover · reference (Hansen 2000)</div>
      <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[#ff6b52] shadow-[0_0_8px_#ff6b52]" /> Detected change · completed live analyses only</div>
    </div>
  );
}

function MobileLanding() {
  const phase = useUi((s) => s.phase);
  const selection = useUi((s) => s.selection);
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
