import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Braces, Check, ChevronDown, Clock3, X } from 'lucide-react';
import type { ChangeEventProps, StudyArea } from '../../data/contracts';
import { useExplanation } from '../../data/queries';
import { buildFacts } from '../../explain/facts';
import { landCoverLabel } from '../../lib/format';
import { PipelineLoader, TerratraceMark, useStagedProgress } from '../../design';

const LABELS = ['What changed:', 'Evidence:', 'Confidence & limits:'];

function useReveal(text: string | undefined, ms = 1200) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!text) return;
    setN(0);
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      setN(Math.round(k * text.length));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, ms]);
  return text ? text.slice(0, n) : '';
}

/** Evidence chips derived from the measured evidence items (never from the text). */
export function evidenceChips(e: ChangeEventProps) {
  const get = (k: string) => e.confidence.evidence.find((x) => x.key === k);
  return [
    { label: 'NDVI reduction', state: get('ndvi')?.passed },
    { label: 'NBR reduction', state: get('nbr')?.passed },
    { label: `${landCoverLabel(e.land_cover.before)} → ${landCoverLabel(e.land_cover.after).toLowerCase()} transition`, state: get('tree_prob')?.passed },
    { label: 'Persistent across observations', state: get('persistence')?.passed },
    { label: 'Independent reference agreement', state: get('reference')?.passed },
  ] as { label: string; state: boolean | null | undefined }[];
}

export function EvidenceChip({ label, state }: { label: string; state: boolean | null | undefined }) {
  return (
    <span className={`inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-[11.5px] ${state ? 'text-ink shadow-[0_0_0_1px_rgba(76,183,130,0.4)] bg-forest/[0.07]' : state === false ? 'text-ink-2 shadow-[0_0_0_1px_rgba(229,88,79,0.35)]' : 'text-ink-3 shadow-[0_0_0_1px_rgba(255,255,255,0.1)]'}`}>
      {state ? <Check size={12} className="text-forest" strokeWidth={3} /> : state === false ? <X size={12} className="text-bad" /> : <Clock3 size={12} />}
      {label}
    </span>
  );
}

/** TERRATRACE ANALYSIS — an analyst briefing grounded only in measured facts. */
export function Briefing({ event, aoi }: { event: ChangeEventProps; aoi: StudyArea }) {
  const facts = useMemo(() => buildFacts(event, aoi), [event, aoi]);
  const q = useExplanation(facts, true);
  const shown = useReveal(q.data?.text);
  const [showFacts, setShowFacts] = useState(false);
  const done = useStagedProgress([true, true, !!q.data], 520, event.id);
  const llm = q.data?.source === 'llm';
  const fire = event.change_type === 'fire';

  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="tt-briefing overflow-hidden rounded-lg" aria-label="TERRATRACE analysis briefing">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <TerratraceMark size={16} />
        <span className="t-label text-ink">TERRATRACE analysis</span>
        {q.data && (
          <span className="t-label ml-auto !text-[9px] text-ink-3">{llm ? `${q.data.model ?? 'Model'} · fact-checked` : 'Deterministic briefing'}</span>
        )}
      </div>
      <div className="px-4 pb-4 pt-4" aria-live="polite">
        {q.isError ? (
          <p className="text-[12px] leading-relaxed text-ink-3">The briefing service did not respond ({(q.error as Error).message}). No explanation is shown rather than an unverified one.</p>
        ) : q.data?.source === 'none' ? (
          <p className="text-[12.5px] leading-relaxed text-ink-2" data-testid="explanation-withheld">{q.data.text}</p>
        ) : (!q.data || done < 3) ? (
          <PipelineLoader title="Preparing briefing" steps={['Compiling measured facts', 'Drafting analyst briefing', 'Fact-checking every number']} done={done} subtitle={`${Object.keys(facts).length} measurement groups · no other inputs`} />
        ) : (
          <>
            <div className="t-label text-accent">{fire ? 'Burn scar detected' : 'Forest-cover change detected'}</div>
            <div className="mt-3 space-y-3.5">
              {shown.split(/\n\s*\n/).map((para, i) => {
                const label = LABELS.find((l) => para.startsWith(l));
                return (
                  <div key={i}>
                    {label && <div className="t-label mb-1 !text-[9px] text-ink-3">{label.replace(':', '')}</div>}
                    <p className="text-[12.5px] leading-[1.7] text-ink-2">{label ? para.slice(label.length).trim() : para}</p>
                  </div>
                );
              })}
            </div>
            <div className="mt-5 border-t border-line pt-3.5">
              <div className="t-label mb-2.5 text-ink-3">Evidence</div>
              <div className="flex flex-wrap gap-1.5">{evidenceChips(event).map((c) => <EvidenceChip key={c.label} {...c} />)}</div>
            </div>
            {q.data.notice && <p className="mt-3.5 rounded-md bg-white/[0.02] px-3 py-2 text-[10.5px] leading-relaxed text-ink-3 shadow-[0_0_0_1px_rgba(255,255,255,0.07)]">{q.data.notice}</p>}
          </>
        )}
      </div>
      <button onClick={() => setShowFacts(!showFacts)} aria-expanded={showFacts} className="flex w-full items-center gap-2 border-t border-line px-4 py-2.5 text-[11px] text-ink-3 transition hover:bg-hover hover:text-ink-2">
        <Braces size={12} /> Based only on {q.data?.facts_used ?? '…'} supplied measurements · view facts
        <ChevronDown size={13} className={`ml-auto transition ${showFacts ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {showFacts && (
          <motion.pre initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="scroll-thin t-data max-h-60 overflow-auto border-t border-line bg-black/30 px-4 py-3 text-[10px] leading-relaxed text-ink-2">
            {JSON.stringify(facts, null, 2)}
          </motion.pre>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
