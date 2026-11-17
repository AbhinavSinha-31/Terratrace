import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Hourglass, Layers, LayoutDashboard, Leaf, ListTree, MessagesSquare, ScanSearch } from 'lucide-react';
import { useCurrentAnalysis, useSelectedAoi, useSelectedEvent, useStudyAreas } from '../../data/queries';
import { DEFAULT_YEARS } from '../../lib/time';
import { fmtKm2 } from '../../lib/format';
import { AnalysisErrorPanel, AnalysisUnavailable, statusCopy } from './Unavailable';
import { useUi } from '../../state/store';
import { useBreakpoint, CHROME } from '../../lib/useLayout';
import { Button, IconButton, Panel, StateView, Tooltip } from '../../design';
import { TimeMachine } from './TimeMachine';
import { MetricsStrip, TimeMachineHud } from './MetricsStrip';
import { Overview } from './Overview';
import { EventList } from './EventList';
import { EventInspector } from './EventInspector';
import { LayerPanel } from './LayerPanel';
import { ReportModal } from './ReportModal';
import { AreaContextPanel } from './AreaContext';
import { AreaChat } from '../chat/AreaChat';
import { QuickScanPanel } from '../quickscan/QuickScanPanel';

function DrawerBody() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const selected = useSelectedEvent();
  const aoi = useSelectedAoi();
  const q = useCurrentAnalysis();
  const count = q.data?.bundle?.events.features.length;
  // Years changed / study just opened: no result exists; nothing runs until the user asks.
  if (q.status === 'idle') return <ReadyToAnalyze name={aoi?.name} />;
  // The request produced no result (e.g. backend unavailable): truthful error, no synthetic result.
  if (q.status === 'error' && q.error) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-line px-5 pb-3 pt-4">
          <div className="t-label text-ink-3">No analysis result</div>
          <div className="mt-1 truncate text-[15px] font-semibold text-ink">{aoi?.name ?? 'Selected area'}</div>
        </div>
        <div className="scroll-thin min-h-0 flex-1 space-y-6 overflow-y-auto p-5"><AnalysisErrorPanel error={q.error} onRetry={() => q.refetch()} /><AreaContextPanel /><QuickScanPanel /><AreaChat inline /></div>
      </div>
    );
  }
  // No READY analysis → no tabs, no metrics: an explicit status panel instead.
  if (q.data && !q.data.bundle) {
    const { title } = statusCopy(q.data);
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-line px-5 pb-3 pt-4">
          <div className="t-label text-ink-3">{title}</div>
          <div className="mt-1 truncate text-[15px] font-semibold text-ink">{aoi?.name ?? q.data.aoi.name}</div>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5">
          <AnalysisUnavailable result={q.data} onRetry={() => q.refetch()} />
          <div className="mt-6"><AreaContextPanel /></div>
          <div className="mt-6"><QuickScanPanel /></div>
          <div className="mt-6"><AreaChat inline /></div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {!selected && (
        <div className="shrink-0 border-b border-line px-5 pb-0 pt-4">
          <div className="t-label text-ink-3">Intelligence</div>
          <div className="mt-1 truncate text-[15px] font-semibold text-ink">{aoi?.name ?? '—'}</div>
          <div className="no-scrollbar -mx-1 mt-3 flex gap-1 overflow-x-auto px-1" role="tablist">
            {([['overview', 'Overview', LayoutDashboard], ['events', 'Events', ListTree], ['land', 'Land, heat & carbon', Leaf], ['ask', 'Ask', MessagesSquare]] as const).map(([k, label, Icon]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`tt-press relative flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-2 text-[12.5px] font-medium ${tab === k ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
                <Icon size={13} />{label}
                {k === 'events' && count !== undefined && <span className="t-data rounded-xs bg-white/10 px-1.5 text-[10px] text-ink-2">{count}</span>}
                {tab === k && <motion.span layoutId="drawer-tab" className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-accent" />}
              </button>
            ))}
          </div>
        </div>
      )}
      {!selected && tab === 'ask' ? (
        <div className="min-h-0 flex-1 p-5"><AreaChat /></div>
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5" id="tt-drawer-scroll">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={selected ? `ev-${selected.id}` : tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              {selected ? <EventInspector event={selected} /> : tab === 'overview' ? <><Overview /><div className="mt-6"><AreaContextPanel /></div></> : tab === 'land' ? <QuickScanPanel /> : <EventList />}
            </motion.div>
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

/** Shown under Analysis / Time Machine when no area is open yet. */
function NoAreaState() {
  const view = useUi((s) => s.view);
  const featured = useStudyAreas().data?.items ?? [];
  const tm = view === 'timemachine';
  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center p-6">
      <Panel className="pointer-events-auto w-[min(520px,100%)] p-7">
        <div className="grid h-11 w-11 place-items-center rounded-md bg-accent/12 text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.35)]">{tm ? <Hourglass size={20} /> : <ScanSearch size={20} />}</div>
        <h2 className="t-h1 mt-5">{tm ? 'Travel back to 1984' : 'No area under analysis'}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          {tm ? 'The Time Machine replays four decades of satellite imagery — Landsat since 1984 — and measures forest cover from 2016 with Sentinel-2 and Dynamic World, for any analysed area.' : 'Open a featured investigation, or explore Earth and draw an area to analyse.'}
        </p>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {featured.map((a) => (
            <button key={a.id} onClick={() => useUi.getState().openAnalysis(a.id, { view: tm ? 'timemachine' : 'analysis', name: a.name, geometry: a.geometry, window: a.default_window ? { start: a.default_window[0], end: a.default_window[1] } : undefined, run: true })}
              className="tt-press flex items-center justify-between rounded-md px-3.5 py-3 text-left shadow-[0_0_0_1px_rgba(255,255,255,0.08)] hover:-translate-y-px hover:bg-hover">
              <span><span className="block text-[12.5px] font-medium text-ink">{a.short_name}</span><span className="block text-[10.5px] text-ink-3">{a.country} · {fmtKm2(a.area_km2)} km²</span></span>
              <ChevronRight size={15} className="text-ink-3" />
            </button>
          ))}
        </div>
        <Button variant="outline" className="mt-4" icon={<ScanSearch size={15} />} onClick={() => useUi.getState().goExplore('explore')}>Explore Earth instead</Button>
      </Panel>
    </div>
  );
}

/** Idle investigation: explicit request required (no result is shown for other years). */
function ReadyToAnalyze({ name }: { name?: string }) {
  const b = useUi((s) => s.investigation.baselineYear);
  const c = useUi((s) => s.investigation.comparisonYear);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ready-to-analyze">
      <div className="shrink-0 border-b border-line px-5 pb-3 pt-4">
        <div className="t-label text-ink-3">Ready to analyze</div>
        <div className="mt-1 truncate text-[15px] font-semibold text-ink">{name ?? 'Selected area'}</div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          Baseline <b className="t-data text-ink">{b}</b> → comparison <b className="t-data text-ink">{c}</b>. No analysis has been run for these years yet.
        </p>
        <Button variant="brand" onClick={() => useUi.getState().requestAnalysis()}>Run live analysis {b} → {c}</Button>
        <div className="pt-2"><AreaContextPanel /></div>
        <div className="pt-2"><QuickScanPanel /></div>
      </div>
    </div>
  );
}

export function AnalysisView() {
  const hasStudy = useUi((s) => !!s.investigation.study);
  const q = useCurrentAnalysis();
  const drawerOpen = useUi((s) => s.drawerOpen);
  const layersOpen = useUi((s) => s.layersOpen);
  const presentation = useUi((s) => s.presentation.active);
  const ui = useUi.getState;
  const bp = useBreakpoint();

  // The timeline always offers every composite year from 1984 (DEFAULT_YEARS); per-year availability
  // comes from the analysis. The requested window is never rewritten here — it is the canonical
  // store window that was sent to the backend.
  useEffect(() => {
    ui().setYears(DEFAULT_YEARS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!hasStudy) return <NoAreaState />;

  // Unknown/expired area (e.g. a stale link) is the only error that replaces the layout.
  if (q.isError && q.error?.code === 'not_found') {
    return (
      <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center p-6">
        <Panel className="pointer-events-auto w-[min(460px,100%)]">
          <StateView kind="empty" title="Area not found"
            action={<Button size="sm" variant="secondary" onClick={() => ui().goExplore('explore')}>Back to Explore</Button>}>
            This area is not available. The link may be incorrect or expired — select or draw the area again.
          </StateView>
        </Panel>
      </div>
    );
  }

  const drawerW = bp === 'wide' ? CHROME.drawer.wide : bp === 'desktop' ? CHROME.drawer.desktop : CHROME.drawer.tablet;
  const showLayers = layersOpen && !presentation;
  const showDrawer = drawerOpen && !presentation;

  if (bp === 'mobile') return <MobileAnalysis />;

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <TimeMachineHud />

      {/* layers */}
      <AnimatePresence initial={false}>
        {showLayers ? (
          <motion.aside key="layers" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}
            className="tt-panel scroll-thin pointer-events-auto absolute left-3 top-[76px] overflow-y-auto p-3"
            style={{ width: CHROME.layers, maxHeight: `calc(100% - ${CHROME.dock + 100}px)` }} aria-label="Map layers">
            <LayerPanel onCollapse={() => ui().setLayersOpen(false)} />
          </motion.aside>
        ) : !presentation && (
          <motion.div key="layers-btn" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-auto absolute left-3 top-[76px]">
            <Tooltip content="Show layers" side="right">
              <IconButton label="Show layers" variant="secondary" size="lg" onClick={() => ui().setLayersOpen(true)}><Layers size={17} /></IconButton>
            </Tooltip>
          </motion.div>
        )}
      </AnimatePresence>

      {/* drawer */}
      <AnimatePresence initial={false}>
        {showDrawer ? (
          <motion.aside key="drawer" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 30 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="tt-panel pointer-events-auto absolute right-3 top-[76px] overflow-hidden" style={{ width: drawerW, bottom: CHROME.dock + 24 }} aria-label="Intelligence drawer">
            <DrawerBody />
            <button aria-label="Collapse drawer" onClick={() => ui().setDrawerOpen(false)} className="tt-press absolute -left-px top-1/2 grid h-14 w-6 -translate-y-1/2 place-items-center rounded-r-sm bg-hover text-ink-3 hover:text-ink">
              <ChevronRight size={12} />
            </button>
          </motion.aside>
        ) : !presentation && (
          <motion.button key="drawer-tab" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => ui().setDrawerOpen(true)}
            className="tt-panel tt-press pointer-events-auto absolute right-3 top-[76px] flex items-center gap-2 px-3 py-2.5 text-[12px] text-ink-2 hover:text-ink">
            <ChevronLeft size={14} /> Intelligence
          </motion.button>
        )}
      </AnimatePresence>

      {/* dock */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.05 }}
        className="tt-panel pointer-events-auto absolute inset-x-3 bottom-3 flex flex-col overflow-visible" style={{ height: CHROME.dock }}>
        <div className="min-h-0 flex-1"><TimeMachine compact={bp === 'tablet'} /></div>
        <div className="h-[62px] shrink-0 border-t border-line"><MetricsStrip /></div>
      </motion.div>


      <ReportModal />
    </div>
  );
}

function MobileAnalysis() {
  const sheet = useUi((s) => s.sheet);
  const setSheet = useUi((s) => s.setSheet);
  const heights = { peek: 0.36, half: 0.6, full: 0.9 };
  const h = heights[sheet];
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <TimeMachineHud />
      <motion.section
        className="pointer-events-auto absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-xl bg-[#090c0f]/97 shadow-[0_-20px_40px_-10px_rgba(0,0,0,.8),0_0_0_1px_rgba(255,255,255,.07)]"
        // initial={false}: the sheet opens at its height instead of growing from its content height (a layout shift of
        // 1.0 on phones, Lighthouse 2026-10-25); changes after a drag or tap still animate.
        initial={false} animate={{ height: `${h * 100}vh` }} transition={{ type: 'spring', stiffness: 280, damping: 34 }}
        drag="y" dragConstraints={{ top: 0, bottom: 0 }} dragElastic={0.15}
        onDragEnd={(_, info) => {
          const order: (keyof typeof heights)[] = ['peek', 'half', 'full'];
          const i = order.indexOf(sheet);
          if (info.offset.y < -50 && i < 2) setSheet(order[i + 1]);
          if (info.offset.y > 50 && i > 0) setSheet(order[i - 1]);
        }}
        aria-label="Analysis sheet"
      >
        {/* 48 x 24 px tap target around the 6 px handle */}
        <button className="mx-auto grid h-6 w-12 shrink-0 place-items-center" aria-label="Resize panel" onClick={() => setSheet(sheet === 'full' ? 'peek' : sheet === 'peek' ? 'half' : 'full')}>
          <span className="h-1.5 w-12 rounded-full bg-white/20" aria-hidden="true" />
        </button>
        <div className="h-[132px] shrink-0 overflow-x-auto no-scrollbar" tabIndex={0} role="region" aria-label="Timeline (scrolls sideways)"><div className="h-full min-w-[640px]"><TimeMachine compact /></div></div>
        <div className="h-[62px] shrink-0 overflow-x-auto border-y border-line no-scrollbar" tabIndex={0} role="region" aria-label="Key figures (scroll sideways)"><div className="h-full min-w-[520px]"><MetricsStrip /></div></div>
        <div className="min-h-0 flex-1"><DrawerBody /></div>
      </motion.section>
      <ReportModal />
    </div>
  );
}
