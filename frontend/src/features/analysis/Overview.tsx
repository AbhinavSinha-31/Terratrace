import { useState } from 'react';
import { ChevronDown, Info } from 'lucide-react';
import { useCurrentAnalysis, useFilteredEvents, useSelectedAoi } from '../../data/queries';
import { useAnalysisWindow, useUi } from '../../state/store';
import type { ChangeLevel } from '../../data/contracts';
import { ForestCoverChart } from '../../components/charts/ForestCoverChart';
import { YearlyLossChart } from '../../components/charts/YearlyLossChart';
import { evidenceDistribution, fmtHa, fmtKm2, fmtSignedPct } from '../../lib/format';
import { Badge, SectionLabel, SeverityBadge, Skeleton, StateView } from '../../design';
import { SEVERITY_COLOR } from '../../lib/palette';

const LEVEL_TONE: Record<ChangeLevel, 'forest' | 'warn' | 'bad'> = { low: 'forest', moderate: 'warn', high: 'bad' };
const SEV_RANK = { low: 0, moderate: 1, high: 2, critical: 3 };

export function Overview() {
  const q = useCurrentAnalysis();
  const aoi = useSelectedAoi();
  // KPIs come from the backend result, which always belongs to the current baseline/comparison.
  const k = q.data?.bundle?.summary.kpis ?? null;
  const year = useUi((s) => s.investigation.imageryYear);
  const win = useAnalysisWindow();
  const setYear = useUi((s) => s.setYear);
  const selectEvent = useUi((s) => s.selectEvent);
  const setTab = useUi((s) => s.setTab);
  const events = useFilteredEvents();
  const [methodOpen, setMethodOpen] = useState(false);

  if (q.isLoading) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading analysis">
        <Skeleton className="h-16" /><Skeleton className="h-[170px]" /><Skeleton className="h-[190px]" />
      </div>
    );
  }
  // Rendered only for READY analyses (the drawer shows the unavailable panel otherwise).
  if (q.isError || !q.data?.bundle || !k) {
    return <StateView kind="service-unavailable" onRetry={() => q.refetch()}>{(q.error as Error)?.message ?? q.data?.reason}</StateView>;
  }
  const s = q.data.bundle.summary;
  const ys = s.years.find((y) => y.year === year);
  const inWindow = events.filter((e) => e.properties.year_to > win.start && e.properties.year_to <= win.end);
  const top = [...inWindow].sort((a, b) => SEV_RANK[b.properties.severity.class] - SEV_RANK[a.properties.severity.class] || b.properties.area_ha - a.properties.area_ha).slice(0, 3);
  const dist = evidenceDistribution(inWindow);
  // "No change" only when loss was actually measured as ~0 — never when it is missing.
  const noChange = k.total_loss_ha !== null && k.total_loss_ha < 1 && inWindow.length === 0;
  const dash = (v: number | null | undefined, f: (n: number) => string) => (v === null || v === undefined ? '—' : f(v));
  // Observation coverage of the two compared composites (measured; '—' when not measured).
  const cov = (y: number) => s.years.find((r) => r.year === y)?.coverage_pct ?? null;

  return (
    <div className="space-y-6">
      <section>
        <div className="t-label text-ink-3">Analysis window</div>
        <div className="mt-1.5 flex items-baseline justify-between gap-3">
          <div className="t-h1 t-data">{win.start} <span className="text-ink-3">→</span> {win.end}</div>
          <Badge tone="forest">Live · Earth Engine</Badge>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-3">{aoi?.description}</p>
        <div className="mt-4 space-y-3" data-testid="analysis-kpis">
          {([
            ['Analysis window', [
              ['Area analysed', dash(aoi?.area_km2, (v) => `${fmtKm2(v)} km²`)],
              ['Compared area', dash(k.compared_ha, (v) => `${fmtHa(v)} ha`)],
              [`Observed ${win.start} / ${win.end}`, `${dash(cov(win.start), (v) => `${Math.round(v)}%`)} / ${dash(cov(win.end), (v) => `${Math.round(v)}%`)}`],
            ]],
            ['Forest cover', [
              [`Forest ${k.baseline_year}`, dash(k.forest_baseline_ha, (v) => `${fmtHa(v)} ha`)],
              [`Forest ${k.latest_year}`, dash(k.forest_latest_ha, (v) => `${fmtHa(v)} ha`)],
            ]],
            ['Forest change', [
              ['Forest lost', dash(k.total_loss_ha, (v) => `${fmtHa(v)} ha`)],
              ['Forest gained', dash(k.total_gain_ha, (v) => `${fmtHa(v)} ha`)],
              ['Net change', dash(k.net_change_ha, (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtHa(Math.abs(v))} ha`)],
              ['Net change %', dash(k.net_change_pct, (v) => fmtSignedPct(v))],
            ]],
            ['Events', [
              ['Detected events', String(k.event_count)],
              ['High / critical', String(k.high_severity_count)],
              ['Mean evidence', dash(k.mean_confidence, (v) => `${Math.round(v * 100)}%`)],
            ]],
          ] as const).map(([group, cells]) => (
            <div key={group}>
              <div className="t-label mb-1.5 !text-[9px] text-ink-4">{group}</div>
              <div className={`grid gap-px overflow-hidden rounded-md bg-line ${cells.length === 4 ? 'grid-cols-2' : cells.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                {cells.map(([l, v]) => (
                  <div key={l} className="bg-surface px-3 py-2.5" data-kpi={l}>
                    <div className="text-[10.5px] text-ink-3">{l}</div>
                    <div className="t-data mt-0.5 text-[14px] text-ink">{v}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {noChange && (
        <StateView kind="no-change">
          The selected area remained within the expected forest-cover range between {win.start} and {win.end}. Forest cover {win.start}: {dash(k.forest_baseline_ha, fmtHa)} ha · {win.end}: {dash(k.forest_latest_ha, fmtHa)} ha (observed area).
        </StateView>
      )}

      {ys && !ys.passes_quality && (
        <StateView compact kind="insufficient-imagery">Historical imagery available, but {year} does not meet analysis-quality requirements. {ys.quality_reason}</StateView>
      )}
      {ys && ys.passes_quality && ys.imagery_status !== 'good' && (
        <StateView compact kind={ys.imagery_status === 'insufficient' ? 'insufficient-imagery' : 'cloud-limited'}>
          {ys.imagery_status === 'insufficient'
            ? `The ${year} composite has a median of ${ys.clear_obs_median} clear observations per pixel and is excluded from change detection.`
            : `The ${year} composite has a median of ${ys.clear_obs_median} clear observations per pixel; detections in this year carry lower evidence.`}
        </StateView>
      )}

      <section>
        <SectionLabel aside="km² · click to jump">Forest cover over time</SectionLabel>
        <div className="tt-well px-2 pt-2"><ForestCoverChart years={s.years} selectedYear={year} window={win} onSelectYear={setYear} /></div>
        {s.history && <p className="mt-2 text-[10.5px] leading-relaxed text-ink-4">{s.history.note}</p>}
      </section>

      <section>
        <SectionLabel aside="ha per year">Forest loss rate</SectionLabel>
        <div className="tt-well px-2 pt-2"><YearlyLossChart years={s.years} selectedYear={year} onSelectYear={setYear} /></div>
      </section>

      {s.periods && s.periods.length > 0 && (
        <section>
          <SectionLabel>Long-term change periods</SectionLabel>
          <ul className="tt-divide overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(255,255,255,0.065)]">
            {s.periods.map((p) => (
              <li key={p.from_year} className="flex items-center gap-3 px-3 py-2.5">
                <span className="t-data w-[86px] shrink-0 text-[12px] text-ink">{p.from_year}–{p.to_year}</span>
                <Badge tone={LEVEL_TONE[p.level]}>{p.level}</Badge>
                <span className="t-data ml-auto text-right text-[11px] text-ink-2">{fmtHa(p.loss_ha)} ha<br /><span className="text-ink-4">{p.rate_pct_per_year.toFixed(2)} %/yr · {p.sensors.startsWith('Landsat +') ? 'L+S+D' : 'L'}</span></span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {inWindow.length > 0 && (
        <section>
          <SectionLabel>Evidence & severity in window</SectionLabel>
          <div className="space-y-2.5">
            <div className="flex items-center gap-3 text-[11px] text-ink-3">
              <span className="w-16">Evidence</span>
              <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                <span className="bg-forest" style={{ width: `${(dist.high / inWindow.length) * 100}%` }} />
                <span className="bg-warn" style={{ width: `${(dist.medium / inWindow.length) * 100}%` }} />
                <span className="bg-bad" style={{ width: `${(dist.low / inWindow.length) * 100}%` }} />
              </div>
              <span className="t-data w-20 text-right">{dist.high}H · {dist.medium}M · {dist.low}L</span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-ink-3">
              <span className="w-16">Severity</span>
              <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                {(['low', 'moderate', 'high', 'critical'] as const).map((sv) => (
                  <span key={sv} style={{ width: `${(inWindow.filter((e) => e.properties.severity.class === sv).length / inWindow.length) * 100}%`, background: SEVERITY_COLOR[sv] }} />
                ))}
              </div>
              <span className="t-data w-20 text-right">{inWindow.length} events</span>
            </div>
          </div>
        </section>
      )}

      {top.length > 0 && (
        <section>
          <SectionLabel aside={<button className="text-accent hover:underline" onClick={() => setTab('events')}>All events →</button>}>Most severe detections</SectionLabel>
          <div className="space-y-1.5">
            {top.map((e) => (
              <button key={e.id} onClick={() => selectEvent(e.id)} className="tt-press flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left shadow-[0_0_0_1px_rgba(255,255,255,0.065)] hover:-translate-y-px hover:bg-hover hover:shadow-[0_0_0_1px_rgba(255,255,255,0.14)]">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium">{e.properties.change_label}</div>
                  <div className="t-data text-[10.5px] text-ink-3">{e.id} · {e.properties.year_from}→{e.properties.year_to}</div>
                </div>
                <div className="t-data text-right text-[12px]">{fmtHa(e.properties.area_ha)} <span className="text-ink-3">ha</span></div>
                <SeverityBadge severity={e.properties.severity.class} />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(255,255,255,0.065)]">
        <button className="flex w-full items-center gap-2 px-3.5 py-3 text-left" onClick={() => setMethodOpen(!methodOpen)} aria-expanded={methodOpen}>
          <Info size={14} className="text-accent" />
          <span className="text-[12.5px] font-medium">Methodology & provenance</span>
          <ChevronDown size={15} className={`ml-auto text-ink-3 transition ${methodOpen ? 'rotate-180' : ''}`} />
        </button>
        {methodOpen && (
          <div className="space-y-3 border-t border-line px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-2">
            <p><b className="text-ink">Forest mask.</b> {s.method.forest_rule}</p>
            <p><b className="text-ink">Change rule.</b> <span className="t-data text-[11px]">{s.method.change_rule}</span>; minimum mapping unit {s.method.mmu_ha} ha.</p>
            {s.method.history_rule && <p><b className="text-ink">Historical analysis.</b> {s.method.history_rule}</p>}
            <p><b className="text-ink">Severity.</b> {s.method.severity}</p>
            <p><b className="text-ink">Evidence.</b> {s.method.confidence}</p>
            <div>
              <b className="text-ink">Sources.</b>
              <ul className="mt-1 space-y-1">
                {s.provenance.sources.map((src) => (
                  <li key={src.name} className="flex gap-2"><span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${src.real ? 'bg-good' : 'bg-warn'}`} /><span>{src.name} — {src.role}</span></li>
                ))}
              </ul>
            </div>
            {s.provenance.note && <p className="rounded-md bg-warn/[0.06] p-2.5 text-warn/90 shadow-[0_0_0_1px_rgba(227,164,63,0.3)]">{s.provenance.note}</p>}
            <p className="t-data text-[10.5px] text-ink-3">pipeline {s.provenance.pipeline_version} · schema {s.schema_version} · {s.provenance.generated_at}</p>
          </div>
        )}
      </section>
    </div>
  );
}
