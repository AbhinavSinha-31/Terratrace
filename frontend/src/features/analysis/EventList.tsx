import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useCurrentAnalysis, useFilteredEvents } from '../../data/queries';
import { useUi } from '../../state/store';
import { SEVERITIES, type ChangeType } from '../../data/contracts';
import { Menu, Skeleton, StateView } from '../../design';
import { SEVERITY_COLOR, SEVERITY_LINE } from '../../lib/palette';
import { changeTypeLabel, fmtHa, severityLabel } from '../../lib/format';

type Sort = 'newest' | 'largest' | 'severe' | 'evidence';
const RANK = { low: 0, moderate: 1, high: 2, critical: 3 };

export function EventList() {
  const q = useCurrentAnalysis();
  const filtered = useFilteredEvents();
  const year = useUi((s) => s.year);
  const win = useUi((s) => s.window);
  const sev = useUi((s) => s.severityFilter);
  const types = useUi((s) => s.typeFilter);
  const ui = useUi.getState;
  const hovered = useUi((s) => s.hoveredEventId);
  const selected = useUi((s) => s.selectedEventId);
  const [sort, setSort] = useState<Sort>('newest');

  const all = q.data?.bundle?.events.features ?? [];
  const presentTypes = useMemo(() => [...new Set(all.map((e) => e.properties.change_type))] as ChangeType[], [all]);
  const sorted = useMemo(() => {
    const visibleFirst = (a: (typeof filtered)[number], b: (typeof filtered)[number]) => Number(a.properties.year_to > year) - Number(b.properties.year_to > year);
    const by: Record<Sort, (a: (typeof filtered)[number], b: (typeof filtered)[number]) => number> = {
      newest: (a, b) => b.properties.year_to - a.properties.year_to || b.properties.area_ha - a.properties.area_ha,
      largest: (a, b) => b.properties.area_ha - a.properties.area_ha,
      severe: (a, b) => RANK[b.properties.severity.class] - RANK[a.properties.severity.class] || b.properties.severity.score - a.properties.severity.score,
      evidence: (a, b) => b.properties.confidence.score - a.properties.confidence.score,
    };
    return [...filtered].sort((a, b) => visibleFirst(a, b) || by[sort](a, b));
  }, [filtered, sort, year]);

  if (q.isLoading) return <div className="space-y-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[58px]" />)}</div>;
  if (q.isError) return <StateView kind="service-unavailable" onRetry={() => q.refetch()}>{(q.error as Error)?.message}</StateView>;
  if (all.length === 0) {
    return (
      <StateView kind="no-change">
        No forest-change events passed the detection rule between the analysable years {q.data?.bundle?.summary.analysis_window?.event_window?.join(' and ') ?? `${win.start} and ${win.end}`} (measured over pixels observed in both years).
      </StateView>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {SEVERITIES.map((s) => (
          <button key={s} aria-pressed={sev[s]} onClick={() => ui().toggleSeverity(s)}
            className={`tt-press flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-[11.5px] shadow-[0_0_0_1px_rgba(255,255,255,0.1)] ${sev[s] ? 'bg-white/[0.06] text-ink' : 'text-ink-3'}`}>
            <span className="h-2 w-2 rounded-[2px]" style={{ background: SEVERITY_COLOR[s], boxShadow: `0 0 0 1px ${SEVERITY_LINE[s]}`, opacity: sev[s] ? 1 : 0.3 }} />
            {severityLabel[s]}
          </button>
        ))}
        {presentTypes.length > 1 && presentTypes.map((t) => (
          <button key={t} aria-pressed={types[t] !== false} onClick={() => ui().toggleType(t)}
            className={`tt-press h-7 rounded-sm px-2.5 text-[11.5px] shadow-[0_0_0_1px_rgba(255,255,255,0.1)] ${types[t] !== false ? 'bg-white/[0.06] text-ink' : 'text-ink-3'}`}>
            {changeTypeLabel[t]}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between text-[11px] text-ink-3">
        <span className="t-data">{sorted.filter((e) => e.properties.year_to <= year).length} of {sorted.length} on map at {year}</span>
        <Menu label="Sort events" value={sort} onChange={(v) => setSort(v as Sort)} align="right"
          options={[{ value: 'newest', label: 'Newest' }, { value: 'largest', label: 'Largest' }, { value: 'severe', label: 'Most severe' }, { value: 'evidence', label: 'Strongest evidence' }]} />
      </div>
      {sorted.length === 0 ? (
        <StateView kind="filtered" action={<button className="text-[12px] text-accent hover:underline" onClick={() => ui().resetFilters()}>Reset filters</button>}>Turn a severity class or change type back on.</StateView>
      ) : (
        <ul className="space-y-1.5">
          {sorted.map((e, i) => {
            const p = e.properties;
            const future = p.year_to > year;
            return (
              <motion.li key={e.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.02 }}>
                <button
                  onClick={() => ui().selectEvent(e.id)}
                  onMouseEnter={() => ui().hoverEvent(e.id)}
                  onMouseLeave={() => ui().hoverEvent(null)}
                  className={`tt-press relative flex w-full items-center gap-3 overflow-hidden rounded-md py-2.5 pl-4 pr-3 text-left shadow-[0_0_0_1px_rgba(255,255,255,0.065)] hover:-translate-y-px hover:bg-hover hover:shadow-[0_0_0_1px_rgba(255,255,255,0.14)] ${hovered === e.id || selected === e.id ? 'bg-hover' : ''} ${future ? 'opacity-45' : ''}`}
                >
                  <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: SEVERITY_COLOR[p.severity.class] }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium">{p.change_label}</div>
                    <div className="t-data mt-0.5 truncate text-[10.5px] text-ink-3">{e.id} · {p.year_from}→{p.year_to} · {future ? <span className="text-warn/80">after {year}</span> : severityLabel[p.severity.class]}</div>
                  </div>
                  <div className="text-right">
                    <div className="t-data text-[12.5px]">{fmtHa(p.area_ha)} <span className="text-ink-3">ha</span></div>
                    <div className="t-data text-[10.5px] text-ink-3 capitalize">{p.confidence.class} evidence</div>
                  </div>
                </button>
              </motion.li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
