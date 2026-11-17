import { Suspense, lazy, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Header } from '../features/shell/Header';
import { Landing } from '../features/explore/Landing';
import { AnalysisProgressOverlay } from '../features/analysis/AnalyzingOverlay';
import { BootSplash } from '../features/shell/BootSplash';
import { useUi } from '../state/store';
import { useChat } from '../state/chat';
import { MapErrorBoundary } from './ErrorBoundary';
import { useUrlSync } from '../lib/urlState';
import { useAnalysisRunner } from '../data/analysisRunner';
import { useImagerySync } from '../data/imagerySync';
import { useBackendRecovery } from '../data/queries';
import { useBreakpoint, CHROME } from '../lib/useLayout';

// Loaded on demand, so the first paint does not wait for MapLibre (~1 MB) or pages nobody has opened yet. (ECharts is
// loaded by the first chart: components/charts/EChart.tsx.) No idle prefetch: evaluating a prefetched view on the main
// thread raised desktop Total Blocking Time from 0.7 s to 1.6 s (Lighthouse, 2026-10-25).
const MapStage = lazy(() => import('../features/map/MapStage').then((m) => ({ default: m.MapStage })));
const AnalysisView = lazy(() => import('../features/analysis/AnalysisView').then((m) => ({ default: m.AnalysisView })));
const AskPage = lazy(() => import('../features/chat/AskPage').then((m) => ({ default: m.AskPage })));
const CaseStudyPage = lazy(() => import('../features/casestudy/CaseStudyPage').then((m) => ({ default: m.CaseStudyPage })));
const AboutModal = lazy(() => import('../features/shell/AboutModal').then((m) => ({ default: m.AboutModal })));

/** True from the first time `flag` is true: a page stays mounted after its first opening (its own exit animation runs). */
function useOpenedOnce(flag: boolean): boolean {
  const [opened, setOpened] = useState(flag);
  if (flag && !opened) setOpened(true);
  return opened || flag;
}

function ViewLoading() {
  return (
    <div className="absolute inset-0 z-20 grid place-items-center" role="status" aria-live="polite">
      <span className="flex items-center gap-2 rounded-md bg-base/80 px-3 py-2 text-[12.5px] text-ink-2"><Loader2 size={14} className="animate-spin" aria-hidden="true" />Loading…</span>
    </div>
  );
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, select, textarea, [contenteditable], [role="dialog"]')) return;
      const ui = useUi.getState();
      if (e.key === 'Escape') {
        if (ui.drawTool) ui.setDrawTool(null);
        else if (ui.selectedEventId) ui.selectEvent(null);
        else if (ui.compare) ui.setCompare(false);
        else if (ui.presentation.active) ui.setPresentation({ active: false, step: 0 });
        return;
      }
      if (e.key === '/') { e.preventDefault(); if (ui.view !== 'explore') ui.goExplore('explore'); window.setTimeout(() => window.dispatchEvent(new CustomEvent('tt:focus-search')), 80); return; }
      if (!ui.investigation.study || ui.view === 'explore') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); ui.stepYear(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); ui.stepYear(1); }
      else if (e.key === ' ' && !t.closest('button')) { e.preventDefault(); ui.setPlaying(!ui.playing); }
      else if (e.key.toLowerCase() === 'c' && !e.metaKey && !e.ctrlKey) ui.setCompare(!ui.compare);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  useShortcuts();
  useUrlSync();
  useAnalysisRunner();   // the only executor of analysis requests
  useImagerySync();      // imagery status (independent of analysis)
  useBackendRecovery();  // a backend that comes back after an outage is used again without a reload
  const askMounted = useOpenedOnce(useChat((s) => s.askOpen));
  const caseStudyMounted = useOpenedOnce(useUi((s) => !!s.caseStudy));
  const aboutMounted = useOpenedOnce(useUi((s) => s.aboutOpen));
  const view = useUi((s) => s.view);
  const hasStudy = useUi((s) => !!s.investigation.study);
  const drawerOpen = useUi((s) => s.drawerOpen);
  const bp = useBreakpoint();

  // Keep map attribution clear of floating panels.
  const inAnalysis = view !== 'explore' && hasStudy;
  const drawerW = bp === 'wide' ? CHROME.drawer.wide : bp === 'desktop' ? CHROME.drawer.desktop : CHROME.drawer.tablet;
  const attrib = bp === 'mobile'
    ? { bottom: inAnalysis ? '37vh' : '57vh', right: '8px' }
    : inAnalysis ? { bottom: `${CHROME.dock + 20}px`, right: `${drawerOpen ? drawerW + 24 : 16}px` } : { bottom: '8px', right: '8px' };

  return (
    <div className="relative h-full overflow-hidden bg-base" style={{ '--attrib-bottom': attrib.bottom, '--attrib-right': attrib.right } as React.CSSProperties}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[300] focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-[#03201d]">Skip to content</a>
      <div className="absolute inset-x-0 top-0 z-50"><Header /></div>
      <main id="main" className="absolute inset-0">
        <MapErrorBoundary><Suspense fallback={null}><MapStage /></Suspense></MapErrorBoundary>
        <div className="tt-vignette pointer-events-none absolute inset-0 z-[5]" />
        {view === 'explore' ? <Landing /> : <Suspense fallback={<ViewLoading />}><AnalysisView /></Suspense>}
        <AnalysisProgressOverlay />
        <Suspense fallback={null}>
          {askMounted && <AskPage />}
          {caseStudyMounted && <CaseStudyPage />}
        </Suspense>
      </main>
      {aboutMounted && <Suspense fallback={null}><AboutModal /></Suspense>}
      <BootSplash />
    </div>
  );
}
