import { motion, type PanInfo } from 'framer-motion';
import { ArrowDown, ArrowRight, ArrowUp, ChevronLeft, ChevronRight, Crosshair, FileText, Flame, SplitSquareHorizontal, TreeDeciduous } from 'lucide-react';
import type { ChangeEvent, EvidenceItem, IndexChange, StudyArea } from '../../data/contracts';
import { useFilteredEvents, useSelectedAoi } from '../../data/queries';
import { useUi } from '../../state/store';
import { SignalChart } from '../../components/charts/SignalChart';
import { SIGNAL } from '../../lib/palette';
import { fmtCoord, fmtDelta, fmtHa, fmtIndex, fmtPct, landCoverLabel } from '../../lib/format';
import { AnimatedNumber, Button, EvidenceBadge, IconButton, SectionLabel, SeverityBadge, Tooltip } from '../../design';
import { useBreakpoint } from '../../lib/useLayout';
import { Briefing } from './Briefing';

const LO = -0.3, HI = 1;
const x = (v: number) => `${((Math.min(HI, Math.max(LO, v)) - LO) / (HI - LO)) * 100}%`;

function IndexCell({ label, hint, color, v }: { label: string; hint: string; color: string; v: IndexChange }) {
  const down = v.change < 0;
  return (
    <div className="bg-surface px-3.5 py-3">
      <div className="t-label flex items-center gap-1.5 text-ink-3"><span className="h-[2px] w-2.5" style={{ background: color }} />{label}</div>
      <div className="mt-1.5 flex items-center gap-1 t-data text-[20px] font-medium leading-none">
        {down ? <ArrowDown size={14} className="text-[#ff8a6b]" /> : <ArrowUp size={14} className="text-good" />}
        <AnimatedNumber value={v.change} format={(n) => fmtDelta(n)} />
      </div>
      <div className="t-data mt-1.5 text-[10.5px] text-ink-3">{fmtIndex(v.before)} → {fmtIndex(v.after)} · {hint}</div>
      <div className="relative mt-2 h-1 rounded-full bg-white/[0.06]" aria-hidden>
        <div className="absolute inset-y-0 rounded-full opacity-40" style={{ background: color, left: x(Math.min(v.before, v.after)), right: `calc(100% - ${x(Math.max(v.before, v.after))})` }} />
        <div className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] bg-[#0b0f12]" style={{ left: x(v.before), borderColor: color }} />
        <div className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: x(v.after), background: color, boxShadow: '0 0 0 2px #0b0f12' }} />
      </div>
    </div>
  );
}

function evidenceValue(it: EvidenceItem) {
  if (it.value === null) return 'pending next composite';
  if (typeof it.value === 'boolean') return it.value ? 'yes' : 'no';
  if (it.key === 'reference' || it.key === 'persistence') return fmtPct(it.value);
  if (it.key === 'clear_obs') return `${it.value} scenes`;
  return fmtDelta(it.value);
}
function evidenceRule(it: EvidenceItem) {
  if (it.threshold === null) return 'required';
  if (it.key === 'reference' || it.key === 'persistence') return `≥ ${fmtPct(it.threshold)}`;
  if (it.key === 'clear_obs') return `≥ ${it.threshold}`;
  return `≤ ${fmtDelta(it.threshold)}`;
}

function EventBody({ event, aoi }: { event: ChangeEvent; aoi: StudyArea }) {
  const p = event.properties;
  const ui = useUi.getState;
  const explained = useUi((s) => !!s.explainRequested[event.id]);
  const fire = p.change_type === 'fire';
  const Icon = fire ? Flame : TreeDeciduous;
  const passed = p.confidence.evidence.filter((e) => e.passed === true).length;
  const evaluated = p.confidence.evidence.filter((e) => e.passed !== null).length;

  const compareThis = () => {
    // Before = the analysis baseline (= the event's year_from), after = the year it was detected.
    // The analysis years are NOT changed here: that would discard the result this event belongs to.
    const s = ui();
    s.setYear(p.year_to);
    s.setCompare(true);
    s.requestCamera({ kind: 'event', id: event.id });
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="t-data text-[11px] tracking-[0.06em] text-accent">EVENT #{p.id}</div>
        <div className="t-label mt-3 flex items-center gap-2 !text-[11px] text-ink"><Icon size={14} className={fire ? 'text-sev-moderate' : 'text-forest'} />{fire ? 'Burn scar' : 'Forest-cover change'}</div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="t-data text-[42px] font-medium leading-none tracking-[-0.03em]"><AnimatedNumber value={p.area_ha} format={(v) => fmtHa(v)} /></span>
          <span className="text-[14px] text-ink-2">ha affected</span>
        </div>
        <div className="t-data mt-1 text-[11.5px] text-ink-3">{p.area_km2.toFixed(2)} km² · Sector {p.sector} · {aoi.short_name}</div>
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <EvidenceBadge level={p.confidence.class} />
          <SeverityBadge severity={p.severity.class} />
        </div>
        <div className="t-data mt-4 flex items-center gap-2 text-[15px] text-ink">
          {p.year_from} <ArrowRight size={14} className="text-ink-3" /> {p.year_to}
          <span className="font-sans text-[11px] text-ink-3">· {p.composite_window}</span>
        </div>
        <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
          <Button variant="brand" icon={<SplitSquareHorizontal size={15} />} onClick={compareThis}>Before / After</Button>
          <Tooltip content="Focus camera on this event"><IconButton label="Focus camera on this event" variant="secondary" onClick={() => ui().requestCamera({ kind: 'event', id: event.id })}><Crosshair size={16} /></IconButton></Tooltip>
        </div>
      </div>

      <section>
        <SectionLabel>Measured signals</SectionLabel>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md bg-line">
          <IndexCell label="NDVI" hint="greenness" color={SIGNAL.ndvi} v={p.indices.ndvi} />
          <IndexCell label="NBR" hint={fire ? `dNBR ${(-p.indices.nbr.change).toFixed(2)}` : 'burn index'} color={SIGNAL.nbr} v={p.indices.nbr} />
          <IndexCell label="Tree prob." hint="Dynamic World" color={SIGNAL.tree_prob} v={p.indices.tree_prob} />
          <div className="bg-surface px-3.5 py-3">
            <div className="t-label text-ink-3">Persistence</div>
            <div className="t-data mt-1.5 text-[20px] font-medium leading-none">{p.persistence === null ? <span className="text-[13px] text-ink-3">Pending</span> : <AnimatedNumber value={p.persistence * 100} format={(v) => `${Math.round(v)}%`} />}</div>
            <div className="mt-1.5 text-[10.5px] text-ink-3">{p.persistence === null ? 'next composite not yet available' : 'still non-forest one year later'}</div>
          </div>
          <div className="col-span-2 flex items-center gap-3 bg-surface px-3.5 py-3">
            <div className="t-label shrink-0 text-ink-3">Land-cover transition</div>
            <div className="ml-auto flex items-center gap-2 text-[12px]">
              <span className="rounded-xs bg-forest/10 px-2 py-0.5 text-forest shadow-[0_0_0_1px_rgba(76,183,130,0.3)]">{landCoverLabel(p.land_cover.before)}</span>
              <ArrowRight size={13} className="text-ink-3" />
              <span className="rounded-xs bg-[#ff8a6b]/10 px-2 py-0.5 text-[#ffb59e] shadow-[0_0_0_1px_rgba(255,138,107,0.3)]">{landCoverLabel(p.land_cover.after)}</span>
            </div>
          </div>
        </div>
      </section>

      <section>
        <SectionLabel aside="mean over patch">Signal history</SectionLabel>
        <div className="tt-well px-2 pt-2"><SignalChart event={p} /></div>
      </section>

      <section>
        <SectionLabel aside={`${passed}/${evaluated} checks`}>Evidence</SectionLabel>
        <div className="overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(255,255,255,0.065)]">
          <div className="flex items-center gap-3 border-b border-line px-3.5 py-3">
            <div className="t-data text-[24px] font-medium leading-none">{Math.round(p.confidence.score * 100)}</div>
            <div className="min-w-0 flex-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]"><motion.div className={`h-full rounded-full ${p.confidence.class === 'high' ? 'bg-forest' : p.confidence.class === 'medium' ? 'bg-warn' : 'bg-bad'}`} initial={{ width: 0 }} animate={{ width: `${p.confidence.score * 100}%` }} transition={{ duration: 0.8 }} /></div>
              <div className="mt-1 text-[10.5px] text-ink-3">Evidence score — weighted agreement of the checks below; not a calibrated probability.</div>
            </div>
          </div>
          <ul className="tt-divide">
            {p.confidence.evidence.map((it) => (
              <li key={it.key} className="flex items-center gap-2.5 px-3.5 py-2">
                <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] font-bold ${it.passed ? 'bg-forest/15 text-forest' : it.passed === false ? 'bg-bad/15 text-bad' : 'bg-white/[0.06] text-ink-3'}`} aria-label={it.passed ? 'passed' : it.passed === false ? 'not met' : 'pending'}>
                  {it.passed ? '✓' : it.passed === false ? '×' : '·'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] text-ink">{it.label}</div>
                  <div className="t-data text-[10px] text-ink-3">{evidenceValue(it)} · rule {evidenceRule(it)}</div>
                </div>
                <div className="w-12 shrink-0" title={`Weight ${it.weight} · strength ${it.score}`}>
                  <div className="h-1 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-accent/70" style={{ width: `${it.score * 100}%` }} /></div>
                  <div className="t-data mt-0.5 text-right text-[9px] text-ink-4">w {it.weight.toFixed(2)}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="tt-briefing">
        {explained ? (
          <Briefing event={p} aoi={aoi} />
        ) : (
          <button onClick={() => ui().requestExplanation(event.id)} className="tt-explain group flex w-full items-center gap-3 rounded-lg px-4 py-4 text-left">
            <span className="grid h-10 w-10 place-items-center rounded-md bg-accent/12 text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.35)]"><TerratraceGlyph /></span>
            <span className="min-w-0 flex-1">
              <span className="t-label block text-ink">Explain this detection</span>
              <span className="mt-1 block text-[11.5px] text-ink-3">Analyst briefing generated from the measured facts only</span>
            </span>
            <ArrowRight size={17} className="text-accent transition group-hover:translate-x-1" />
          </button>
        )}
      </section>

      <div className="space-y-1 pb-1 text-[10.5px] leading-relaxed text-ink-4">
        <div>Severity basis: {p.severity.basis}</div>
        <div className="t-data">Centroid {fmtCoord(p.centroid[0], p.centroid[1])}</div>
      </div>
    </div>
  );
}

function TerratraceGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M27.28 11.9A12 12 0 1 1 20.1 4.72" stroke="currentColor" strokeWidth="2.4" />
      <path d="M4.1 14H12.2L15.2 17.6H27.8" stroke="currentColor" strokeWidth="2.3" />
      <path d="M7.6 22H24.4" stroke="currentColor" strokeWidth="2.3" />
      <path d="M24.5 4.9L27.1 7.5L24.5 10.1L21.9 7.5Z" fill="currentColor" />
    </svg>
  );
}

/** Event investigation panel (slides in; swipe left/right on touch to move between events). */
export function EventInspector({ event }: { event: ChangeEvent }) {
  const aoi = useSelectedAoi();
  const list = useFilteredEvents();
  const bp = useBreakpoint();
  const ui = useUi.getState;
  if (!aoi) return null;
  const idx = list.findIndex((e) => e.id === event.id);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x < -70 && next) ui().selectEvent(next.id);
    else if (info.offset.x > 70 && prev) ui().selectEvent(prev.id);
  };

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-5 -mt-5 mb-5 flex items-center gap-1 border-b border-line bg-[#0b0f12]/95 px-3 py-2 backdrop-blur">
        <button onClick={() => ui().selectEvent(null)} className="tt-press flex h-8 items-center gap-1 rounded-sm px-2 text-[12px] text-ink-2 hover:bg-hover hover:text-ink">
          <ChevronLeft size={15} /> Events
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label="Previous event" size="sm" disabled={!prev} onClick={() => prev && ui().selectEvent(prev.id)}><ChevronLeft size={15} /></IconButton>
          <span className="t-data w-12 text-center text-[10.5px] text-ink-3">{idx + 1} / {list.length}</span>
          <IconButton label="Next event" size="sm" disabled={!next} onClick={() => next && ui().selectEvent(next.id)}><ChevronRight size={15} /></IconButton>
          <div className="mx-1 h-5 w-px bg-line" />
          <Tooltip content="Export event brief"><IconButton label="Export event brief" size="sm" onClick={() => ui().openReport(event.id)}><FileText size={15} /></IconButton></Tooltip>
        </div>
      </div>
      <motion.div
        key={event.id}
        initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        drag={bp === 'mobile' ? 'x' : false} dragConstraints={{ left: 0, right: 0 }} dragElastic={0.25} onDragEnd={onDragEnd}
      >
        <EventBody event={event} aoi={aoi} />
      </motion.div>
    </div>
  );
}
