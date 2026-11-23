import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, Building2, ChevronRight, Database, Layers3, ShieldCheck, Trees } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useFeaturedSummary, useHealth, useStudyAreas, useStudyCard } from '../../data/queries';
import { client } from '../../data/client';
import { ChatLauncher } from '../chat/ChatLauncher';
import { selectCandidate, useUi } from '../../state/store';
import type { StudyArea } from '../../data/contracts';
import { fmtHa, fmtKm2, shortBiome } from '../../lib/format';
import { useBreakpoint } from '../../lib/useLayout';
import { DEFAULT_ANALYSIS_WINDOW, ERAS } from '../../lib/time';
import { Badge, IconButton, Segmented, Skeleton, StateView, TerratraceMark, Tooltip } from '../../design';
import { AnimatedNumber } from '../../design/Metric';
import { DrawHint, SearchBar } from './SearchBar';
import { SelectionPanel } from './SelectionPanel';
import { CaseStudyCard } from '../casestudy/CaseStudyCard';
import { CASE_STUDIES, useCaseStudy } from '../casestudy/data';

const EASE = [0.22, 1, 0.36, 1] as const;

// ---------------------------------------------------------------- hero
function Hero({ search = true }: { search?: boolean }) {
  return (
    <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.6, ease: EASE }} className="pointer-events-auto max-w-[580px]" aria-labelledby="hero-title" data-map-occluder>
      <div className="t-label flex flex-wrap gap-x-3 gap-y-1 text-ink-3">
        {['Forests', 'Cities', 'Land cover', 'Evidence'].map((w, i) => (
          <span key={w} className="flex items-center gap-3">{i > 0 && <span className="text-ink-4">•</span>}{w}</span>
        ))}
      </div>
      <h1 id="hero-title" className="tt-hero-title mt-[clamp(12px,2.2vh,20px)] max-w-[11.6em]">
        See how the land
        <br /> is changing —
        <br /><span className="tt-hero-accent">and the evidence<br />behind it.</span>
      </h1>
      <p className="mt-[clamp(14px,2.4vh,24px)] max-w-[500px] text-[clamp(13.5px,1.65vh,15.5px)] leading-[1.6] text-ink-2 lg:[@media(max-height:760px)]:hidden">
        TERRATRACE turns decades of archived satellite data into transparent evidence of forest loss, urban expansion and changing land cover — anywhere on Earth.
      </p>
      {/* The main call to action: search a place, or draw an area (the old "Explore Earth" / "Explore anywhere" entries). */}
      {search && <div className="mt-[clamp(16px,2.8vh,28px)] max-w-[560px]" data-testid="hero-search"><SearchBar /></div>}
      <QuickStart />
      <div className="mt-[clamp(20px,3.2vh,36px)] grid max-w-[560px] grid-cols-3 gap-4 [@media(max-height:960px)]:hidden">
        {[
          { icon: Database, t: 'Decades of data', d: 'Landsat + Sentinel-2' },
          { icon: Layers3, t: 'Scientific analysis', d: 'NDVI • Land cover • Heat' },
          { icon: ShieldCheck, t: 'Explainable insights', d: 'Evidence-based AI' },
        ].map(({ icon: Icon, t, d }) => (
          <div key={t} className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.35)]"><Icon size={18} /></span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-ink">{t}</span>
              <span className="block text-[11.5px] text-ink-2">{d}</span>
            </span>
          </div>
        ))}
      </div>
    </motion.section>
  );
}

// ---------------------------------------------------------------- right panels
const signed = (v: number, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;

/** One urban study's headline figures — always from TERRATRACE's own stored results, never typed in. */
interface UrbanRow { id: string; name: string; source: string; period: string; built: string | null; heat: string | null; open(): void }

/** Urban studies: land-focus featured areas (from their stored quick scans) and the static urban case studies (from the
 *  research pipeline's published results). A study without stored figures is simply not listed. */
function useUrbanRows(): { rows: UrbanRow[]; loading: boolean } {
  const items = useStudyAreas().data?.items ?? [];
  const land = items.filter((a) => a.focus === 'land');
  const first = land[0]?.id ?? null;
  // Latest stored scan (all months) of the first land-focus area, then its comparison with the first scan year.
  const latest = useQuery({ queryKey: ['overview-qs', first], queryFn: () => client.quickScan(first!, null, 'all'), enabled: !!first, staleTime: 60_000, retry: false });
  const d = latest.data?.status === 'READY' ? latest.data : null;
  const cmp = useQuery({
    queryKey: ['overview-qs-compare', first, d?.first_year, d?.year],
    queryFn: () => client.quickScanCompare(first!, d!.first_year, d!.year, 'all'),
    enabled: !!d && d.first_year < d.year, staleTime: 60_000, retry: false,
  });
  const cs = useCaseStudy(CASE_STUDIES[0]?.id ?? null).data;
  const rows: UrbanRow[] = [];
  const area = land[0];
  if (area && d) {
    const c = cmp.data?.status === 'READY' ? cmp.data.landcover : null;
    const veg = d.lst?.uhi_vegetated;
    rows.push({
      id: area.id, name: area.short_name, source: 'Quick scan · Dynamic World + Landsat',
      period: c ? `${cmp.data!.from_year}→${cmp.data!.to_year}` : String(d.year),
      built: c?.built_expansion_km2 != null ? `${signed(c.built_expansion_km2)} km²${c.built_expansion_pct != null ? ` (${signed(c.built_expansion_pct)} %)` : ''}` : null,
      heat: veg?.status === 'READY' && veg.value_c != null ? `${signed(veg.value_c)} °C vs vegetated land, ${d.year}` : null,
      open: () => { useUi.getState().openAnalysis(area.id, { name: area.name, geometry: area.geometry, run: false }); useUi.getState().setTab('land'); },
    });
  }
  if (cs) {
    const b = cs.net_change.find((n) => /^built/i.test(n.class));
    rows.push({
      id: cs.id, name: CASE_STUDIES[0].name, source: 'Case study · Landsat land-cover pipeline',
      period: b ? `${b.from_year}→${b.to_year}` : '',
      built: b ? `${signed(b.delta_km2)} km²` : null,
      // The case study's surface heat (UHI) results were withdrawn in pipeline 1.0.2, pending a weather-normalised method.
      heat: null,
      open: () => useUi.getState().openCaseStudy(cs.id),
    });
  }
  return { rows: rows.filter((r) => r.built || r.heat), loading: latest.isLoading || cmp.isLoading };
}

function UrbanOverview() {
  const { rows, loading } = useUrbanRows();
  if (loading && !rows.length) return <div className="mt-4 space-y-2"><Skeleton className="h-14 rounded-md" /><Skeleton className="h-14 rounded-md" /></div>;
  if (!rows.length) {
    return (
      <div className="mt-4" data-testid="overview-urban-empty">
        <div className="text-[13px] font-medium text-ink-2">No published urban analyses yet</div>
        <div className="mt-1 text-[11.5px] leading-snug text-ink-3">Built-up expansion and heat-island figures appear here once an urban area has been scanned. Nothing is estimated.</div>
      </div>
    );
  }
  return (
    <ul className="mt-3 space-y-3" data-testid="overview-urban">
      {rows.map((r) => (
        <li key={r.id}>
          <button onClick={r.open} className="tt-press -mx-1.5 block w-[calc(100%+12px)] rounded-md px-1.5 py-1 text-left hover:bg-hover">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[13px] font-medium text-ink">{r.name}</span>
              <span className="t-data shrink-0 text-[11.5px] text-ink-3">{r.period}</span>
            </div>
            {r.built && <div className="mt-0.5 flex items-baseline justify-between gap-2"><span className="text-[12px] text-ink-2">Built-up land</span><span className="t-data text-[15px] text-[#f0a35e]">{r.built}</span></div>}
            {r.heat && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-2">Heat island <span className="t-data text-ink">{r.heat}</span></div>}
            <div className="mt-0.5 text-[11px] text-ink-3">{r.source}</div>
          </button>
        </li>
      ))}
      <li className="text-[11px] leading-snug text-ink-3">TERRATRACE&apos;s own analyses only · different methods, so figures are not added up</li>
    </ul>
  );
}

const isControlArea = (a: StudyArea | undefined) => !!a?.tags.some((t) => /control site/i.test(t));

/** Detected change of the PUBLISHED (stored READY) forest analyses of the featured areas — their own figures, read-only.
 *  Control sites (stable forest) measure the false-alarm rate: reported separately, never added to the total. */
function useForestTotals() {
  const items = useStudyAreas().data?.items ?? [];
  const summary = useFeaturedSummary();
  const ready = (summary.data?.items ?? []).filter((i) => i.status === 'READY' && i.kpis);
  const isControl = (id: string) => isControlArea(items.find((a) => a.id === id));
  const counted = ready.filter((r) => !isControl(r.id));
  const controls = ready.filter((r) => isControl(r.id));
  // "Detected change" = area of the detected change events (the polygons drawn on the map) — not gross loss, which
  // sums year-to-year forest-mask transitions (including reversals).
  const areaOf = (rs: typeof ready) => rs.reduce((a, r) => a + (r.kpis?.event_area_ha ?? 0), 0);
  const countOf = (rs: typeof ready) => rs.reduce((a, r) => a + (r.kpis?.event_count ?? 0), 0);
  return { items, ready, counted, controls, areaOf, countOf, loading: summary.isLoading };
}

/** Exactly the cards shown under "Featured investigations": the featured areas + the case studies. */
function useFeaturedCounts() {
  const items = useStudyAreas().data?.items ?? [];
  const land = items.filter((a) => a.focus === 'land').length;
  return { total: items.length + CASE_STUDIES.length, forest: items.length - land, urban: land + CASE_STUDIES.length };
}

/** Open a featured area as its card does: a forest site opens its stored analysis; an urban one its land & heat tab. */
function openFeatured(area: StudyArea) {
  const land = area.focus === 'land';
  useUi.getState().openAnalysis(area.id, { name: area.name, geometry: area.geometry, window: area.default_window ? { start: area.default_window[0], end: area.default_window[1] } : undefined, run: !land });
  if (land) useUi.getState().setTab('land');
}

/** Quick-start chips under the search: only featured areas with a PUBLISHED result (a stored READY forest analysis,
 *  or an urban area whose stored scans the overview lists). Control sites are left out. */
function QuickStart() {
  const items = useStudyAreas().data?.items ?? [];
  const ready = new Set((useFeaturedSummary().data?.items ?? []).filter((i) => i.status === 'READY').map((i) => i.id));
  const urban = new Set(useUrbanRows().rows.map((r) => r.id));
  const chips = items.filter((a) => (a.focus === 'land' ? urban.has(a.id) : ready.has(a.id) && !isControlArea(a))).slice(0, 5);
  if (!chips.length) return null;
  return (
    <div className="mt-3 flex max-w-[560px] flex-wrap items-center gap-1.5" data-testid="quick-start" data-map-occluder>
      <span className="mr-0.5 text-[11.5px] text-ink-3">Try</span>
      {chips.map((a) => (
        <button key={a.id} type="button" onClick={() => openFeatured(a)} data-testid="quick-start-chip"
          className="tt-press pointer-events-auto inline-flex h-7 items-center gap-1 rounded-full bg-white/[0.04] px-2.5 text-[11.5px] font-medium text-ink-2 shadow-[0_0_0_1px_rgba(255,255,255,0.1)] hover:bg-accent/12 hover:text-accent hover:shadow-[0_0_0_1px_rgba(69,208,196,0.45)]">
          {a.focus === 'land' ? <Building2 size={11} className="text-[#f0a35e]" /> : <Trees size={11} className="text-forest" />}
          {a.short_name}{/Delhi NCR/.test(a.region) ? ' · Delhi NCR' : ''}
        </button>
      ))}
    </div>
  );
}

/** 768–1279 px and phones: the Global Land Overview as a row of stat cards (same figures as the panel). */
function OverviewStrip() {
  const f = useForestTotals();
  const { rows } = useUrbanRows();
  const c = useFeaturedCounts();
  const card = (label: string, value: ReactNode, sub: string, icon: ReactNode, testId: string) => (
    <div className="tt-panel min-w-0 px-4 py-3" data-testid={testId}>
      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-2">{icon}{label}</div>
      <div className="t-data mt-1 truncate text-[20px] font-medium leading-tight">{value}</div>
      <div className="mt-0.5 truncate text-[11.5px] text-ink-3" title={sub}>{sub}</div>
    </div>
  );
  const u = rows[0];
  return (
    <section className="pointer-events-auto grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Global land overview" data-testid="overview-strip" data-map-occluder>
      {card('World forest area', <>40.6 <span className="text-[13px] text-ink-2">M km²</span></>, '31 % of land · FAO FRA 2020', <Trees size={13} className="text-forest" />, 'strip-forest')}
      {card('Detected forest change', f.counted.length ? <span className="text-[#ff8a6b]">{fmtHa(f.areaOf(f.counted))} <span className="text-[13px] text-ink-2">ha</span></span> : '—',
        f.counted.length ? `${f.countOf(f.counted)} events · ${f.counted.length} published` : 'No published analyses yet', <Trees size={13} className="text-[#ff8a6b]" />, 'strip-change')}
      {card('Urban growth', u ? <span className="text-[#f0a35e]">{(u.built ?? u.heat ?? '').split(' (')[0]}</span> : '—',
        u ? `${u.name}${u.built?.includes('(') ? ` ${u.built.slice(u.built.indexOf('('))}` : ''} · ${u.period}${rows.length > 1 ? ` · +${rows.length - 1} more` : ''}` : 'No published urban analyses yet', <Building2 size={13} className="text-[#f0a35e]" />, 'strip-urban')}
      {card('Featured investigations', String(c.total).padStart(2, '0'), `published · ${c.forest} forest · ${c.urban} urban`, <TerratraceMark size={13} />, 'strip-featured')}
    </section>
  );
}

function ForestOverview() {
  const { data: health } = useHealth();
  const { items, counted, controls, areaOf, countOf } = useForestTotals();
  const events = countOf(counted);
  const eeReady = health?.analysis.status === 'ready';
  return (
    <>
      <div className="mt-4">
        <div className="text-[12.5px] text-ink-2">World forest area</div>
        <div className="mt-1 flex items-end justify-between gap-3">
          <div className="t-data text-[26px] font-medium leading-none">40.6 <span className="text-[16px] text-ink-2">M km²</span></div>
          <div className="text-right">
            <div className="t-data text-[15px] text-forest">31%</div>
            <div className="text-[11.5px] text-ink-3">of land area</div>
          </div>
        </div>
        <div className="mt-1.5 text-[11.5px] text-ink-3">Reference · FAO FRA 2020</div>
      </div>
      <div className="my-3.5 h-px bg-line" />
      <div data-testid="overview-detected-change">
        <div className="text-[12.5px] text-ink-2">Detected change · TERRATRACE</div>
        {counted.length > 0 ? (
          <>
            <div className="mt-1 flex items-end justify-between gap-3">
              <div className="t-data whitespace-nowrap text-[26px] font-medium leading-none text-[#ff8a6b]">
                <AnimatedNumber value={areaOf(counted)} format={(v) => fmtHa(v)} /> <span className="text-[16px] text-ink-2">ha</span>
              </div>
              <div className="shrink-0 text-right">
                <div className="t-data text-[15px] text-ink">{events}</div>
                <div className="whitespace-nowrap text-[11.5px] text-ink-3">events · {counted.length} published</div>
              </div>
            </div>
            <div className="mt-1.5 text-[11.5px] text-ink-3">Area of detected change events{controls.length ? ' · control sites excluded' : ''}</div>
          </>
        ) : (
          <div className="mt-1.5">
            <div className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
              <span className={`h-1.5 w-1.5 rounded-full ${eeReady ? 'bg-live' : 'bg-warn'}`} />
              {controls.length ? 'No change-site analyses yet' : 'No published analyses yet'}
            </div>
            <div className="mt-1 text-[11.5px] leading-snug text-ink-3">{eeReady && health?.backend ? 'Open an area to run an analysis.' : 'The analysis service is temporarily unavailable.'}</div>
          </div>
        )}
        {controls.map((r) => {
          const n = countOf([r]);
          const name = items.find((a) => a.id === r.id)?.short_name ?? r.id;
          return (
            <div key={r.id} className="mt-2 text-[11.5px] leading-snug text-ink-3" data-testid="overview-control">
              Control site · {name}: {n} {n === 1 ? 'detection' : 'detections'} ({fmtHa(areaOf([r]))} ha) — false-alarm check, not counted
            </div>
          );
        })}
      </div>
    </>
  );
}

function OverviewPanel() {
  const [tab, setTab] = useState<'forests' | 'urban'>('forests');
  const { total, forest, urban } = useFeaturedCounts();
  return (
    <section className="tt-panel pointer-events-auto px-5 py-4" aria-labelledby="gfo" data-map-occluder>
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5">
          {tab === 'forests' ? <Trees size={16} className="text-forest" /> : <Building2 size={16} className="text-[#f0a35e]" />}
          <h2 id="gfo" className="t-label text-ink">Global land overview</h2>
        </div>
      </div>
      <div className="mt-3" data-testid="overview-tabs">
        <Segmented<'forests' | 'urban'> label="Overview" value={tab} onChange={(v) => setTab(v)} options={[
          { value: 'forests', label: <span className="flex items-center gap-1"><Trees size={12} />Forests</span> },
          { value: 'urban', label: <span className="flex items-center gap-1"><Building2 size={12} />Urban</span> },
        ]} />
      </div>
      {tab === 'forests' ? <ForestOverview /> : <UrbanOverview />}
      <div className="my-3.5 h-px bg-line" />
      <div>
        <div className="text-[12.5px] text-ink-2">Featured investigations</div>
        <div className="mt-1 flex items-baseline gap-2" data-testid="overview-featured-count">
          <span className="t-data text-[26px] font-medium leading-none">{total ? String(total).padStart(2, '0') : '—'}</span>
          <span className="text-[12.5px] text-ink-2">published · {forest} forest · {urban} urban</span>
        </div>
        <div className="mt-1 text-[11.5px] text-ink-3">Any area on Earth can be analysed</div>
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
/**
 * Featured row layout. Phones: a snap-scrolling row (the next card peeks in). From `sm`: a 6-column grid — two cards
 * per row, and from `lg` 3 + 2 (a full row of three spans 2 columns each, a last row of two spans 3, a lone last card
 * the whole row). Cards are never squeezed into one row, so titles and labels are not cut off.
 */
const FEATURED_ROW = 'no-scrollbar -mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-6 sm:overflow-visible sm:px-0';
function featuredCell(i: number, n: number): string {
  const sm = n % 2 === 1 && i === n - 1 ? 'sm:col-span-6' : 'sm:col-span-3';
  const tail = n % 3;
  const lg = i < n - tail ? 'lg:col-span-2' : tail === 2 ? 'lg:col-span-3' : 'lg:col-span-6';
  return `w-[min(300px,82vw)] shrink-0 snap-start sm:w-auto ${sm} ${lg}`;
}

function FeaturedCard({ area, index, highlight, cell }: { area: StudyArea; index: number; highlight: boolean; cell: string }) {
  const open = useUi((s) => s.openAnalysis);
  const hover = useUi((s) => s.hoverAoi);
  const hovered = useUi((s) => s.hoveredAoiId === area.id);
  const [state, ...rest] = area.region.split(',').map((s) => s.trim());
  // Static thumbnail from the backend's study metadata (imagery only; URLs are never built here).
  const img = area.thumbnail_url;
  const card = useStudyCard(area.id);
  // A land / heat case study (e.g. the Indian city): its stored quick scans are the result, not a forest analysis.
  const land = area.focus === 'land';
  const { status, detail, reason } = land ? { status: 'Urban case study' as typeof card.status, detail: 'Urban expansion + land surface temperature', reason: area.focus_note ?? null } : card;
  const tone = land ? 'text-accent' : status === 'Analysis ready' ? 'text-live' : status === 'Processing' ? 'text-accent' : status === 'Scientific validation required' || status === 'Analysis failed' ? 'text-bad' : 'text-warn';
  const dot = land ? 'bg-accent' : status === 'Analysis ready' ? 'bg-live' : status === 'Processing' ? 'bg-accent animate-pulse' : status === 'Scientific validation required' || status === 'Analysis failed' ? 'bg-bad' : 'bg-warn';
  return (
    <motion.button
      initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + index * 0.07, duration: 0.5, ease: EASE }}
      onClick={() => {
        if (import.meta.env.DEV) console.debug('[analysis] featured card click', { id: area.id, bbox: area.bbox, window: DEFAULT_ANALYSIS_WINDOW });
        // The site's default window (measured-analysable years): a stored result for it opens instantly.
        open(area.id, { name: area.name, geometry: area.geometry, window: area.default_window ? { start: area.default_window[0], end: area.default_window[1] } : undefined, run: !land });
        if (land) useUi.getState().setTab('land');
      }}
      data-card-status={status}
      onMouseEnter={() => hover(area.id)} onMouseLeave={() => hover(null)} onFocus={() => hover(area.id)} onBlur={() => hover(null)}
      className={`tt-card group relative flex flex-col overflow-hidden rounded-lg text-left ${cell} ${hovered || highlight ? 'is-hover' : ''}`}
      aria-label={`Open featured investigation: ${area.name}`}
    >
      <div className="relative h-[clamp(76px,10.5vh,124px)] overflow-hidden">
        <img src={img} alt="" loading="lazy" className="h-full w-full scale-105 object-cover transition duration-700 ease-out group-hover:scale-[1.12]" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/5 via-transparent to-[#0b0f12]" />
        <div className="absolute left-3 top-3 flex gap-1.5">
          {land && <span className="tt-img-badge !bg-accent/85 !text-[#03201d]">Urban</span>}
          <span className="tt-img-badge">{area.country}</span>
          <span className="tt-img-badge">{rest.length ? state : area.region}</span>
        </div>
      </div>
      <div className="flex flex-1 flex-col px-4 pb-3.5 pt-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[15px] font-semibold leading-snug tracking-[-0.005em] text-ink" title={area.name}>{area.name}</div>
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
        {/* Analysis state. The detail gets its own line: next to the long status label it had no room left. */}
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

const LiveAnalysisLabel = () => <span className="ml-auto shrink-0 text-[10.5px] text-ink-3">published analysis</span>;

function Featured() {
  const { data, isLoading, isError, error, refetch } = useStudyAreas();
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
          <p className="mt-1.5 text-[12.5px] text-ink-2">Published forest and urban investigations. Search above to analyse any other place.</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/* In the header row (normal flow): never over a card, at any width. */}
          {frontPage && <ChatLauncher />}
        </div>
      </div>
      {/* Published investigations from the backend, then the static case studies — which need no backend, so they stay
          visible even when the investigations cannot be loaded. */}
      <div className={FEATURED_ROW}>
        {isError && (
          <div className="tt-panel w-[min(300px,82vw)] shrink-0 sm:col-span-6 sm:w-auto"><StateView kind="service-unavailable" title="Investigations unavailable" onRetry={() => refetch()}>{(error as Error)?.message}</StateView></div>
        )}
        {isLoading && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className={`h-[200px] rounded-lg ${featuredCell(i, 4 + CASE_STUDIES.length)}`} />)}
        {data?.items.map((a, i) => <FeaturedCard key={a.id} area={a} index={i} highlight={highlight} cell={featuredCell(i, data.items.length + CASE_STUDIES.length)} />)}
        {CASE_STUDIES.map((c, i) => {
          const live = data?.items.length ?? (isLoading ? 4 : 0);
          return <CaseStudyCard key={c.id} meta={c} index={live + i} cell={featuredCell(live + i, live + CASE_STUDIES.length)} />;
        })}
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
          // Top region (lg+): grid [hero | globe slot | panels (≥1280 px)]. The globe is framed inside the measured
          // `data-globe-slot` (lib/useLayout.landingInset), clipped to the viewport.
          <motion.div key="intro" className="no-scrollbar absolute inset-0 flex flex-col overflow-y-auto pt-16" exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
            <div className="tt-hero-scrim absolute inset-y-0 left-0 w-[46%]" />
            <div className="tt-featured-scrim absolute inset-x-0 bottom-0 h-[42%]" />
            {/* Hero row: sized to its content (48–64 px padding), hero centred against the globe, overview panel on the
                right from 1280 px. The globe column has its own height so the globe is never squeezed. */}
            <div className="relative shrink-0 px-6 py-8 md:py-10 lg:grid lg:grid-cols-[minmax(0,540px)_minmax(0,1fr)] lg:items-center lg:gap-x-8 lg:py-12 lg:pl-10 xl:grid-cols-[minmax(0,540px)_minmax(0,1fr)_292px] xl:py-16 xl:pl-14">
              <Hero />
              <div className="hidden h-[clamp(360px,calc(100vh-340px),580px)] flex-col lg:flex" data-testid="globe-column">
                <GlobeSlot />
              </div>
              <motion.div initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25, duration: 0.6, ease: EASE }}
                className="hidden space-y-3 self-center xl:block" data-testid="overview-column">
                <OverviewPanel />
                <DataSourcesPanel />
              </motion.div>
            </div>
            {/* 768–1279 px: the overview as a row of stat cards under the hero. */}
            <div className="relative hidden shrink-0 px-6 pb-2 md:block lg:pl-10 xl:hidden"><OverviewStrip /></div>
            <div className="relative shrink-0 px-6 pb-4 pt-4 xl:px-10">
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
            {health && !health.backend && <div className="absolute bottom-6 left-6"><Badge tone="warn">Analysis unavailable</Badge></div>}
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
      <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-[#ff6b52] shadow-[0_0_8px_#ff6b52]" /> Detected change · published analyses only</div>
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
          <div className="space-y-6"><Hero search={false} /><OverviewStrip /><Featured /><DataSourcesPanel /></div>
        ) : (
          <div className="space-y-6"><Featured /></div>
        )}
      </div>
    </div>
  );
}
