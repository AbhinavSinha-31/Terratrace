import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Pause, Play, SkipBack, SkipForward, SplitSquareHorizontal } from 'lucide-react';
import { useAnalysisWindow, useUi } from '../../state/store';
import { useCurrentAnalysis, useCurrentBundle, useImageryAvailability } from '../../data/queries';
import type { ChangeLevel, YearStat } from '../../data/contracts';
import { ERAS, PENDING_YEAR, TIMELINE_START, axisPos, axisYear, eraOf, sourceLabel } from '../../lib/time';
import { fmtHa } from '../../lib/format';
import { SEVERITY_COLOR } from '../../lib/palette';
import { Button, IconButton, Menu, Tooltip } from '../../design';
import { compareBlockedReason, useAnalysisState, useImageryState } from '../../data/viewState';

const LEVEL: Record<ChangeLevel, { fill: string; line: string; label: string }> = {
  low: { fill: 'rgba(76,183,130,0.10)', line: 'rgba(76,183,130,0.55)', label: 'Low change' },
  moderate: { fill: 'rgba(227,164,63,0.12)', line: 'rgba(227,164,63,0.6)', label: 'Moderate change' },
  high: { fill: 'rgba(212,69,47,0.16)', line: 'rgba(255,107,82,0.7)', label: 'High change' },
};
const ERA_COLOR = { L: '#5aa2ff', S: '#4cb782', D: '#a78bfa' };

/** History playback: advance one composite every 1.4 s until the window end. */
function usePlayback() {
  const playing = useUi((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const s = useUi.getState();
      const next = s.years.find((y) => y > s.investigation.imageryYear);
      const stop = s.view === 'timemachine' ? s.years[s.years.length - 1] : s.investigation.comparisonYear;
      if (!next || next > stop) s.setPlaying(false);
      else s.setYear(next);
    }, 1400);
    return () => window.clearInterval(id);
  }, [playing]);
}

/** TerratraceTimeline — the scientific time control (1984 → present). */
export function TimeMachine({ compact = false }: { compact?: boolean }) {
  usePlayback();
  // Periods, events and year statistics exist only for a READY live analysis.
  const analysis = useCurrentBundle();
  const result = useCurrentAnalysis().data;
  const years = useUi((s) => s.years);
  const year = useUi((s) => s.investigation.imageryYear);
  const win = useAnalysisWindow();
  const idle = useUi((s) => s.investigation.analysisStatus === 'idle' && !!s.investigation.study);
  // The selectors ARE the investigation's baseline/comparison. Changing them discards the previous
  // (now incompatible) result; the analysis runs only on an explicit request.
  const sel = win;
  const playing = useUi((s) => s.playing);
  const compare = useUi((s) => s.compare);
  const ui = useUi.getState;
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<null | 'cursor' | 'start' | 'end'>(null);
  // Window handles preview while dragging and commit on release (each commit is a new analysis request).
  const [dragWin, setDragWin] = useState<{ start: number; end: number } | null>(null);
  const shownWin = dragWin ?? sel;
  const [hover, setHover] = useState<number | null>(null);

  const studyId = useUi((s) => s.investigation.study?.id ?? null);
  // What is being VIEWED (imagery, any year) — independent of the analysis window selected above.
  const imagery = useImageryState();
  // Before / After = a validated forest-change comparison: available only when the analysis is READY.
  const compareBlocked = compareBlockedReason(useAnalysisState());
  const availability = useImageryAvailability(studyId);
  const stats = analysis?.summary.years ?? [];
  const periods = analysis?.summary.periods ?? [];
  const events = analysis?.events.features ?? [];
  const snap = (p: number, among: number[] = years) => {
    const y = axisYear(Math.min(1, Math.max(0, p)));
    return among.reduce((best, v) => (Math.abs(v - y) < Math.abs(best - y) ? v : best), among[0]);
  };
  const pAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return (clientX - r.left) / r.width;
  };
  const move = (clientX: number) => {
    const y = snap(pAt(clientX), drag === 'cursor' ? years : windowYears);   // window handles land on analysable years only
    if (drag === 'cursor') ui().setYear(y);
    else if (drag === 'start' && y < shownWin.end) setDragWin({ start: y, end: shownWin.end });
    else if (drag === 'end' && y > shownWin.start) setDragWin({ start: shownWin.start, end: y });
  };
  const togglePlay = () => {
    const s = ui();
    const first = s.view === 'timemachine' ? s.years[0] : s.investigation.baselineYear;
    const last = s.view === 'timemachine' ? s.years[s.years.length - 1] : s.investigation.comparisonYear;
    if (!s.playing && s.investigation.imageryYear >= last) s.setYear(first);
    s.setPlaying(!s.playing);
  };
  const hs: YearStat | undefined = hover !== null ? stats.find((s) => s.year === hover) : undefined;
  const pct = (y: number) => `${axisPos(y) * 100}%`;
  const eventsByYear = new Map<number, typeof events>();
  for (const e of events) eventsByYear.set(e.properties.year_to, [...(eventsByYear.get(e.properties.year_to) ?? []), e]);
  /**
   * Per-year imagery availability MEASURED by the backend (/api/imagery/availability) — never assumed.
   * ok: true = AVAILABLE, false = INSUFFICIENT / UNAVAILABLE, null = not measured (no status is guessed).
   */
  const avail = (y: number): { ok: boolean | null; status: string | null; reason: string } => {
    const e = availability.data?.years.find((r) => r.year === y);
    if (e) return { ok: e.status === 'AVAILABLE', status: e.status, reason: e.reason ?? `${e.sceneCount} scenes · ${e.coverage === null ? '—' : Math.round(e.coverage * 100)}% observed` };
    const q = result?.quality?.years.find((r) => r.year === y);
    if (q) return q.passes ? { ok: true, status: 'AVAILABLE', reason: '' } : { ok: false, status: 'INSUFFICIENT', reason: q.reason ?? 'Insufficient clear observations' };
    return { ok: null, status: null, reason: availability.isFetching ? 'Checking imagery availability…' : availability.isError ? 'Imagery availability could not be checked.' : '' };
  };
  /**
   * Can an ANALYSIS use this year? Measured only: the availability's `analysable` (the analysis' own rule, incl.
   * seasonal coverage), else the stored analysis' quality decision; null = not measured yet (never assumed).
   */
  const analysable = (y: number): boolean | null => {
    const q = result?.quality?.years.find((r) => r.year === y);
    if (q) return q.passes;
    const e = availability.data?.years.find((r) => r.year === y);
    return e?.analysable ?? null;
  };
  /** Why a year cannot be used, in plain words (measured reasons only); null when nothing is known against it. */
  const yearBlockReason = (y: number): string | null => {
    if (y === PENDING_YEAR) return `${y} is not complete yet, so its annual composite does not exist.`;
    const a = avail(y);
    if (a.ok === false) return `${a.status === 'UNAVAILABLE' ? 'No imagery' : 'Insufficient imagery'} for ${y}: ${a.reason}`;
    if (analysable(y) === false) {
      const why = result?.quality?.years.find((r) => r.year === y)?.reason ?? availability.data?.years.find((r) => r.year === y)?.analysisReason;
      return `${y} imagery can be viewed, but it cannot be used in an analysis${why ? `: ${why}` : '.'}`;
    }
    return null;
  };
  // The window selectors offer only years an analysis can use (all years only while that is still being measured).
  const windowYears = years.filter((y) => analysable(y) !== false);
  const yearOpts = windowYears.map((y) => ({ value: y, label: String(y), meta: eraOf(y) === 'historical' ? 'Landsat' : 'S2 · DW' }));
  // A window endpoint measured as not analysable moves inward to the nearest analysable year (never outward).
  const measured = !!availability.data || !!result?.quality;
  useEffect(() => {
    if (!measured || !studyId) return;
    const ok = (y: number) => analysable(y) === true;
    if (ok(sel.start) && ok(sel.end)) return;
    const inside = years.filter((y) => y >= sel.start && y <= sel.end && ok(y));
    if (inside.length >= 2 && (inside[0] !== sel.start || inside[inside.length - 1] !== sel.end)) ui().setWindow(inside[0], inside[inside.length - 1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measured, studyId, sel.start, sel.end, availability.data, result?.quality]);

  return (
    <div className="flex h-full items-stretch gap-4 px-4 py-3">
      {/* transport */}
      <div className="flex shrink-0 flex-col justify-center gap-2">
        <div className="flex items-center gap-1">
          <Tooltip content="Previous composite"><IconButton label="Previous composite" size="sm" onClick={() => ui().stepYear(-1)} disabled={year <= years[0]}><SkipBack size={14} /></IconButton></Tooltip>
          <Button variant={playing ? 'accent' : 'brand'} size="md" className="!h-10 !px-4" icon={playing ? <Pause size={15} /> : <Play size={15} />} onClick={togglePlay} aria-label={playing ? 'Pause history' : 'Play history'}>
            {compact ? '' : playing ? 'Pause' : 'Play history'}
          </Button>
          <Tooltip content="Next composite"><IconButton label="Next composite" size="sm" onClick={() => ui().stepYear(1)} disabled={year >= years[years.length - 1]}><SkipForward size={14} /></IconButton></Tooltip>
        </div>
        {!compact && <div className="t-label !text-[9px] text-ink-3" data-testid="analysis-window-label">Analysis window</div>}
        {!compact && (
          <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
            <Menu label="Start year" value={sel.start} options={yearOpts.filter((o) => o.value < sel.end)} onChange={(v) => ui().setWindow(Number(v), sel.end)} className="!h-7" />
            <span>→</span>
            <Menu label="End year" value={sel.end} options={yearOpts.filter((o) => o.value > sel.start)} onChange={(v) => ui().setWindow(sel.start, Number(v))} className="!h-7" />
          </div>
        )}
        <div className="text-[10.5px] text-ink-3" data-testid="viewing-imagery">
          <span className="t-label !text-[9px] text-ink-3">Viewing imagery</span>{' '}
          <span className="t-data text-ink-2" data-source={imagery.source ?? ''}>{imagery.label}</span>
          {imagery.state === 'AVAILABLE' && <span className="text-ink-4"> · imagery only</span>}
        </div>
        {idle && (
          <div className="flex items-center gap-2" data-testid="pending-window">
            <Button size="sm" variant="brand" className="!h-7" onClick={() => ui().requestAnalysis()}>Run live analysis {win.start} → {win.end}</Button>
            <span className="text-[10.5px] text-ink-4">not yet analysed</span>
          </div>
        )}
      </div>

      {/* axis */}
      <div className="relative min-w-0 flex-1 select-none">
        <div
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label="Composite year"
          aria-valuemin={years[0]}
          aria-valuemax={years[years.length - 1]}
          aria-valuenow={year}
          aria-valuetext={`${year}, ${sourceLabel(year).title}`}
          className="absolute inset-x-2 inset-y-0 touch-none outline-none"
          onPointerDown={(e) => {
            const target = (e.target as HTMLElement).dataset.handle as 'start' | 'end' | undefined;
            setDrag(target ?? 'cursor');
            e.currentTarget.setPointerCapture(e.pointerId);
            ui().setPlaying(false);
            if (!target) ui().setYear(snap(pAt(e.clientX)));
          }}
          onPointerMove={(e) => { if (drag) move(e.clientX); setHover(snap(pAt(e.clientX))); }}
          onPointerUp={() => { if (dragWin) ui().setWindow(dragWin.start, dragWin.end); setDragWin(null); setDrag(null); }}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); ui().stepYear(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); ui().stepYear(1); }
          }}
        >
          {/* change periods */}
          <div className="absolute inset-x-0 top-0 h-[18px]">
            {periods.map((p) => (
              <Tooltip key={p.from_year} content={<span><b className="text-ink">{LEVEL[p.level].label}</b> · {p.from_year}–{p.to_year}<br />{fmtHa(p.loss_ha)} ha lost · {p.rate_pct_per_year.toFixed(2)} %/yr · {p.sensors}</span>}>
                <div tabIndex={-1} className="absolute top-0 flex h-[18px] items-center overflow-hidden rounded-[3px] px-1.5" style={{ left: pct(p.from_year), width: `calc(${pct(p.to_year)} - ${pct(p.from_year)} - 2px)`, background: LEVEL[p.level].fill, boxShadow: `inset 0 -1.5px 0 ${LEVEL[p.level].line}` }}>
                  <span className="t-label truncate !text-[8.5px] text-ink-2">{p.from_year >= 2015 ? `Modern · ${p.level}` : LEVEL[p.level].label}</span>
                </div>
              </Tooltip>
            ))}
          </div>

          {/* window range */}
          <div className="absolute top-[24px] h-[34px] rounded-[3px] bg-accent/[0.07] shadow-[inset_0_0_0_1px_rgba(69,208,196,0.22)]" style={{ left: pct(shownWin.start), width: `calc(${pct(shownWin.end)} - ${pct(shownWin.start)})` }} />

          {/* events */}
          {[...eventsByYear.entries()].map(([y, list]) => (
            <div key={y} className="pointer-events-none absolute top-[27px] flex -translate-x-1/2 flex-col-reverse items-center gap-[2px]" style={{ left: pct(y) }}>
              {list.slice(0, 5).map((e) => <span key={e.id} className="h-[4px] w-[4px] rounded-full" style={{ background: SEVERITY_COLOR[e.properties.severity.class], boxShadow: '0 0 0 1px rgba(6,8,10,.9)' }} />)}
              {list.length > 5 && <span className="t-data text-[7.5px] text-ink-3">+{list.length - 5}</span>}
            </div>
          ))}

          {/* rail + ticks */}
          <div className="absolute inset-x-0 top-[62px] h-px bg-line-2" />
          {years.map((y) => (
            <div key={y} className="absolute top-[58px] -translate-x-1/2" style={{ left: pct(y) }}>
              <div className={`mx-auto w-px ${y === year ? 'h-3 bg-accent' : 'h-2 bg-line-3'}`} />
            </div>
          ))}
          <div className="absolute top-[57px] -translate-x-1/2" style={{ left: pct(PENDING_YEAR) }} title="2026 composite in progress">
            <div className="mx-auto h-2 w-px border-l border-dashed border-ink-4" />
          </div>
          {[...years, PENDING_YEAR].map((y) => {
            const hide = y !== year && y !== win.start && y !== win.end && eraOf(y) === 'modern' && y % 2 === 1 && compact;
            const blocked = yearBlockReason(y);
            const label = (
              <button key={`l${y}`} tabIndex={-1} onClick={() => { if (y !== PENDING_YEAR) ui().setYear(y); }} aria-disabled={y === PENDING_YEAR || undefined}
                aria-label={blocked ? `${y}: ${blocked}` : String(y)}
                data-unavailable={avail(y).ok === false || undefined} data-blocked-reason={blocked ?? undefined}
                data-imagery-status={y === PENDING_YEAR ? undefined : avail(y).status ?? 'UNKNOWN'}
                className={`t-data absolute top-[70px] -translate-x-1/2 text-[10.5px] ${hide ? 'hidden' : ''} ${y === year ? 'font-medium text-ink' : y === PENDING_YEAR ? 'text-ink-4' : avail(y).ok === false ? 'text-ink-4 line-through decoration-warn/60' : 'text-ink-3 hover:text-ink-2'}`}
                style={{ left: pct(y) }}>
                {y === TIMELINE_START ? y : `’${String(y).slice(2)}`}
              </button>
            );
            // Disabled / struck-through years explain themselves on hover and focus.
            return blocked ? <Tooltip key={`t${y}`} content={blocked}>{label}</Tooltip> : label;
          })}

          {/* sensor eras */}
          <div className="absolute inset-x-0 top-[88px] space-y-[3px]">
            {ERAS.map((e) => (
              <div key={e.key} className="relative h-[3px]">
                <div className="absolute inset-y-0 rounded-full" style={{ left: pct(e.from), right: 0, background: ERA_COLOR[e.key], opacity: 0.55 }} />
              </div>
            ))}
          </div>
          <div className="t-label pointer-events-none absolute left-0 top-[102px] flex gap-4 !text-[8.5px] text-ink-4">
            <span style={{ color: ERA_COLOR.L }}>L · Landsat</span>
          </div>
          <div className="t-label pointer-events-none absolute top-[102px] flex gap-3 !text-[8.5px]" style={{ left: pct(2015.5) }}>
            <span style={{ color: ERA_COLOR.S }}>S · Sentinel-2</span><span style={{ color: ERA_COLOR.D }}>D · Dynamic World</span>
          </div>

          {/* window handles */}
          {(['start', 'end'] as const).map((h) => (
            <div key={h} data-handle={h} title={h === 'start' ? `Requested baseline ${shownWin.start}` : `Requested comparison ${shownWin.end}`}
              className="absolute top-[22px] z-10 h-[38px] w-[10px] -translate-x-1/2 cursor-ew-resize rounded-[3px] bg-[#0b0f12] shadow-[0_0_0_1px_rgba(69,208,196,0.7)] hover:bg-accent/30"
              style={{ left: pct(h === 'start' ? shownWin.start : shownWin.end) }}>
              <span data-handle={h} className="absolute inset-x-[3px] top-1/2 h-3 -translate-y-1/2 border-x border-accent/70" />
            </div>
          ))}

          {/* cursor */}
          <motion.div className="pointer-events-none absolute top-[20px] z-20 -translate-x-1/2" animate={{ left: pct(year) }} transition={drag ? { duration: 0 } : { type: 'spring', stiffness: 320, damping: 30 }}>
            <div className="mx-auto h-[44px] w-[2px] bg-accent shadow-[0_0_10px_rgba(69,208,196,0.7)]" />
            <div className="absolute -top-[2px] left-1/2 h-[9px] w-[9px] -translate-x-1/2 rotate-45 bg-accent" />
          </motion.div>

          {/* hover preview */}
          {hover !== null && hs && !drag && (
            <div className="pointer-events-none absolute bottom-full z-30 mb-3 w-[210px] -translate-x-1/2 rounded-md bg-[#12181c] px-3 py-2.5 shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_16px_30px_-12px_rgba(0,0,0,.9)]" style={{ left: pct(hover) }}>
              <div className="flex items-baseline justify-between">
                <span className="t-data text-[14px] font-medium text-ink">{hover}</span>
                <span className="t-label !text-[8.5px] text-ink-3">{hs.source === 'landsat' ? 'Landsat' : 'Sentinel-2'} · {hs.resolution_m} m</span>
              </div>
              {!hs.passes_quality || hs.forest_ha === null ? (
                <div className="mt-1.5 text-[11px] leading-snug text-warn">{hs.quality_reason ?? 'Insufficient clear observations'}</div>
              ) : (
                <div className="mt-1.5 grid grid-cols-2 gap-y-0.5 text-[11px]">
                  <span className="text-ink-3">Forest</span><span className="t-data text-right text-ink">{fmtHa(hs.forest_ha)} ha</span>
                  <span className="text-ink-3">Observed</span><span className="t-data text-right text-ink">{hs.coverage_pct === null ? '—' : `${hs.coverage_pct.toFixed(0)}%`}</span>
                  <span className="text-ink-3">Loss since {hs.previous_year ?? '—'}</span><span className="t-data text-right text-ink">{hs.loss_ha === null ? '—' : `${fmtHa(hs.loss_ha)} ha`}</span>
                  <span className="text-ink-3">Events</span><span className="t-data text-right text-ink">{hs.event_count}</span>
                </div>
              )}
              {(hover < win.start || hover > win.end) && (
                <div className="mt-1.5 border-t border-line pt-1.5 text-[10.5px] leading-snug text-ink-4" data-testid="year-context">
                  Single-year context · outside the {win.start} → {win.end} analysis window. The headline figures still describe {win.start} → {win.end}.
                  {hs.source === 'landsat' && ' Landsat NDVI proxy (30 m) — not comparable with the modern forest mask.'}
                </div>
              )}
            </div>
          )}
          {/* hover preview for years without measured statistics */}
          {hover !== null && !hs && !drag && (
            <div className="pointer-events-none absolute bottom-full z-30 mb-3 w-[230px] -translate-x-1/2 rounded-md bg-[#12181c] px-3 py-2.5 shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_16px_30px_-12px_rgba(0,0,0,.9)]" style={{ left: pct(hover) }} data-testid="year-unavailable">
              <div className="flex items-baseline justify-between">
                <span className="t-data text-[14px] font-medium text-ink">{hover}</span>
                <span className="t-label !text-[8.5px] text-ink-3">{eraOf(hover) === 'historical' ? 'Landsat · 30 m' : 'Sentinel-2 + DW · 10 m'}</span>
              </div>
              <div className="mt-1.5 text-[11px] leading-snug text-warn">
                {avail(hover).ok === false ? `${avail(hover).status === 'UNAVAILABLE' ? 'No imagery' : 'Insufficient imagery'} — ${avail(hover).reason}` : avail(hover).ok ? `Imagery available · ${avail(hover).reason}` : avail(hover).reason || 'Imagery availability not measured'}
              </div>
              <div className="mt-1 text-[10.5px] text-ink-4">Imagery only — no analysis measurement for this year.</div>
            </div>
          )}
        </div>
      </div>

      {!compact && (
        <div className="flex shrink-0 flex-col justify-center gap-2 border-l border-line pl-4">
          {(() => {
            const off = !!compareBlocked && !compare;
            const button = (
              <Button size="sm" variant={compare ? 'accent' : 'secondary'} icon={<SplitSquareHorizontal size={13} />} onClick={() => ui().setCompare(!compare)} aria-pressed={compare}
                disabled={off} data-testid="before-after" className={off ? 'pointer-events-none' : undefined}>
                {compare ? 'Exit compare' : 'Before / After'}
              </Button>
            );
            // A disabled button receives no pointer events: the wrapper carries the tooltip (and keyboard focus).
            return off
              ? <Tooltip content={`Before / After compares two years of a validated analysis. ${compareBlocked}.`}><span tabIndex={0} className="inline-flex rounded-md outline-none focus-visible:ring-1 focus-visible:ring-accent" data-testid="before-after-wrapper">{button}</span></Tooltip>
              : button;
          })()}
          {compareBlocked
            ? <div className="max-w-[120px] text-center text-[10px] leading-tight text-warn" data-testid="before-after-blocked">{compareBlocked}</div>
            : <div className="t-data text-center text-[10px] text-ink-4">{win.start} → {compare ? year : win.end}</div>}
        </div>
      )}
    </div>
  );
}
