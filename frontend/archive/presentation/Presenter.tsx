import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useUi } from '../../state/store';
import { useCurrentAnalysis, useCurrentBundle } from '../../data/queries';
import { IconButton, TerratraceMark } from '../../design';

interface Step {
  title: string;
  narration: string;
  /** Step shows measured results, which exist only for a READY live analysis. */
  needsAnalysis?: boolean;
  run(): void;
}

const FEATURED = 'rondonia-frontier';
const topEvent = () => {
  const q = (window as unknown as { __ttTopEvent?: string }).__ttTopEvent;
  return q ?? null;
};

/** Guided tour — every step drives the real product. Result steps say so when no live analysis exists. */
const STEPS: Step[] = [
  { title: 'Explore Earth', narration: 'The globe shows reference forest cover (Hansen) and, once live analyses have run, the change TERRATRACE detected.', run: () => { const s = useUi.getState(); s.goExplore('intro'); s.setSelection(null); } },
  { title: 'Select an area', narration: 'Search anywhere, draw a rectangle or polygon, or open a featured investigation — here, the Rondônia frontier.', run: () => { const s = useUi.getState(); s.goExplore('intro'); s.hoverAoi(FEATURED); window.dispatchEvent(new CustomEvent('tt:featured')); } },
  { title: 'Analyze · 1984 → 2025', narration: 'TERRATRACE builds cloud-masked composites from Landsat and Sentinel-2 and applies the forest and change rules.', run: () => useUi.getState().openAnalysis(FEATURED, { view: 'timemachine' }) },
  { title: 'Go back decades', needsAnalysis: true, narration: 'The time machine replays four decades: Landsat before 2015, Sentinel-2 and Dynamic World after. Sensors are labelled, never mixed silently.', run: () => { const s = useUi.getState(); s.setYear(s.window.start); s.setPlaying(true); } },
  { title: 'Detected change', needsAnalysis: true, narration: 'In the modern era change is detected as events — each one a polygon with area, period, severity and evidence.', run: () => { const s = useUi.getState(); s.setPlaying(false); s.setView('analysis'); s.setYear(2025); s.setTab('events'); } },
  { title: 'Investigate an event', needsAnalysis: true, narration: 'Selecting an event focuses the camera and opens the inspector with its measured signals.', run: () => { const id = topEvent(); if (id) useUi.getState().selectEvent(id); } },
  { title: 'Before / after', needsAnalysis: true, narration: 'Drag the divider to compare the composites that bracket the event.', run: () => { const s = useUi.getState(); const id = s.selectedEventId ?? topEvent(); if (id && !s.selectedEventId) s.selectEvent(id); s.setCompare(true); } },
  { title: 'Evidence', needsAnalysis: true, narration: 'NDVI, NBR, tree probability, persistence and reference agreement combine into an evidence level — not an unverifiable “AI confidence”.', run: () => { useUi.getState().setCompare(false); document.querySelector('#tt-drawer-scroll')?.scrollTo({ top: 620, behavior: 'smooth' }); } },
  { title: 'Analyst briefing', needsAnalysis: true, narration: 'The explanation is generated from the measured facts only, and every number is fact-checked before it is shown.', run: () => { const s = useUi.getState(); const id = s.selectedEventId ?? topEvent(); if (id) s.requestExplanation(id); window.setTimeout(() => document.querySelector('#tt-briefing')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150); } },
];

export function Presenter() {
  const pres = useUi((s) => s.presentation);
  const analysis = useCurrentBundle();
  const result = useCurrentAnalysis().data;

  // Expose the most significant event so steps can open it without coupling to React state.
  useEffect(() => {
    const ev = analysis?.events.features.slice().sort((a, b) => b.properties.area_ha * b.properties.confidence.score - a.properties.area_ha * a.properties.confidence.score)
      .find((e) => e.properties.change_type === 'clearing');
    (window as unknown as { __ttTopEvent?: string }).__ttTopEvent = ev?.id;
  }, [analysis]);

  const go = (i: number) => {
    const step = Math.max(0, Math.min(STEPS.length - 1, i));
    useUi.getState().setPresentation({ active: true, step });
    STEPS[step].run();
  };
  useEffect(() => { if (pres.active) STEPS[pres.step].run(); /* run the first step on start */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pres.active]);
  useEffect(() => {
    if (!pres.active) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'PageDown' || (e.key.toLowerCase() === 'n' && !(e.target as HTMLElement).closest('input'))) { e.preventDefault(); go(pres.step + 1); }
      if (e.key === 'PageUp' || (e.key.toLowerCase() === 'p' && !(e.target as HTMLElement).closest('input'))) { e.preventDefault(); go(pres.step - 1); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  return (
    <AnimatePresence>
      {pres.active && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
          className="tt-panel fixed bottom-[212px] left-1/2 z-[70] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 max-md:bottom-auto max-md:top-[72px]" role="region" aria-label="Presentation mode">
          <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
            <TerratraceMark size={16} />
            <span className="t-label text-ink">Presentation</span>
            <div className="ml-2 flex gap-1" aria-hidden>
              {STEPS.map((_, i) => <span key={i} className={`h-1 rounded-full transition-all ${i === pres.step ? 'w-5 bg-accent' : i < pres.step ? 'w-2 bg-accent/50' : 'w-2 bg-white/15'}`} />)}
            </div>
            <span className="t-data ml-auto text-[11px] text-ink-3">{pres.step + 1} / {STEPS.length}</span>
            <IconButton label="Exit presentation" size="sm" onClick={() => useUi.getState().setPresentation({ active: false, step: 0 })}><X size={14} /></IconButton>
          </div>
          <div className="flex items-center gap-4 px-4 py-3.5">
            <IconButton label="Previous step" variant="secondary" disabled={pres.step === 0} onClick={() => go(pres.step - 1)}><ChevronLeft size={16} /></IconButton>
            <motion.div key={pres.step} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} className="min-w-0 flex-1" aria-live="polite">
              <div className="t-h2">{STEPS[pres.step].title}</div>
              <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">{STEPS[pres.step].narration}</div>
              {STEPS[pres.step].needsAnalysis && result && !analysis && (
                <div className="mt-1.5 text-[11.5px] leading-relaxed text-warn">No completed live analysis here, so no results are shown — TERRATRACE never simulates them.</div>
              )}
            </motion.div>
            <IconButton label="Next step" variant="secondary" disabled={pres.step === STEPS.length - 1} onClick={() => go(pres.step + 1)} className="!bg-accent !text-[#03201d]"><ChevronRight size={16} /></IconButton>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
