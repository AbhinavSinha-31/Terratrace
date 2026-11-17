import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRightLeft, Flame, Gauge, History, Leaf, Loader2, RotateCcw, ScanSearch, Trees } from 'lucide-react';
import { Button, Menu, Switch } from '../../design';
import { useCarbonSeries, useQuickScan, useQuickScanCompare, useRunQuickScan } from '../../data/queries';
import { ApiError } from '../../data/client';
import type { QuickScan, QuickScanLayer, QuickScanSeason, QuickScanSource } from '../../data/contracts';
import { useUi } from '../../state/store';
import { TierBadge } from '../shell/TierBadge';

const SEASONS: { value: QuickScanSeason; label: string }[] = [
  { value: 'all', label: 'All months' }, { value: 'mam', label: 'Mar–May' }, { value: 'jja', label: 'Jun–Aug' },
  { value: 'son', label: 'Sep–Nov' }, { value: 'djf', label: 'Dec–Feb' },
];

const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)} %`);
const km2 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v >= 100 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(v >= 10 ? 1 : 2)} km²`);
const degC = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)} °C`);
const signedC = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} °C`;
/** Tonnes of carbon in a readable unit (t, kt, Mt). */
const tonnes = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} Mt` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} kt` : `${Math.round(v)} t`);

/** Dataset · date range · resolution — printed under every value. */
function Source({ source, extra }: { source: QuickScanSource; extra?: string }) {
  const when = source.period?.label ?? (source.year ? String(source.season_label ? `${source.season_label} ${source.year}` : source.year) : null);
  const parts = [source.dataset, when, `${source.resolution_m} m`, extra].filter(Boolean);
  return <p className="mt-2 text-[10.5px] leading-snug text-ink-4" data-testid="qs-source">{parts.join(' · ')}</p>;
}

/** "Agreement, not accuracy" — under every quick-scan value. */
function Disclaimer({ text }: { text?: string }) {
  return text ? <p className="mt-1.5 text-[10.5px] leading-snug text-ink-4" data-testid="qs-disclaimer">{text}</p> : null;
}

function Section({ icon, title, layer, children, testId }: { icon: ReactNode; title: string; layer?: QuickScanLayer['id']; children: ReactNode; testId: string }) {
  const on = useUi((s) => (layer ? s.quickScan.layer === layer : false));
  const setQs = useUi((s) => s.setQuickScan);
  return (
    <section className="rounded-md p-3.5 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]" data-testid={testId}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">{icon}{title}</h3>
        {layer && (
          <label className="flex shrink-0 items-center gap-2 text-[10.5px] text-ink-3">
            Map <Switch on={on} onChange={(v) => setQs({ layer: v ? layer : null })} label={`Show ${title} on the map`} />
          </label>
        )}
      </div>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function Unavailable({ reason }: { reason?: string | null }) {
  return <p className="text-[12px] leading-relaxed text-ink-3">{reason ?? 'Not available for this area.'}</p>;
}

/**
 * What a quick scan could not do, in quick-scan words, with the next step. `code` is the backend's reason code; the
 * backend's own sentence is shown as the detail. Never the forest-analysis wording.
 */
const NEXT_STEP: Record<string, { title: string; next: string }> = {
  quota_restricted: { title: 'Earth Engine refused the request (quota)', next: 'Run the quick scan again in a few minutes. Stored scans still open.' },
  ee_unconfigured: { title: 'Earth Engine is off on this server', next: 'Quick scans need live Earth Engine. Ask whoever runs this server to configure it.' },
  area_too_large: { title: 'Area too large for a quick scan', next: 'Draw a smaller area (up to 1,500 km²) and run the quick scan there.' },
  ee_throttled: { title: 'Earth Engine is busy', next: 'Wait a few minutes, then run the quick scan again.' },
  ee_timeout: { title: 'Earth Engine took too long', next: 'Run it again; All months or a smaller area usually finishes faster.' },
  quickscan_failed: { title: 'The quick scan could not be computed', next: 'Run it again in a few minutes. Nothing was stored, so no stale values are shown.' },
  quickscan_unavailable: { title: 'Quick scan not installed on this server', next: "This server is missing the research pipeline's Landsat code (analysis/), so quick scans cannot run here." },
  rate_limited: { title: 'Too many quick scans in a short time', next: 'Wait a minute, then run it again.' },
  service: { title: 'The quick-scan service did not answer', next: 'The server may be offline or running an older version without quick scans. Check back once it has been restarted.' },
};

const SHOW_DETAIL = new Set(['area_too_large', 'rate_limited']);

function Notice({ code, detail, onRetry }: { code: string; detail?: string | null; onRetry?: () => void }) {
  const n = NEXT_STEP[code] ?? NEXT_STEP.quickscan_failed;
  return (
    <div className="rounded-md bg-warn/[0.06] p-3 shadow-[0_0_0_1px_rgba(227,164,63,0.28)]" data-testid="qs-notice" data-code={code}>
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink"><AlertTriangle size={14} className="shrink-0 text-warn" />{n.title}</div>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{n.next}</p>
      {/* The backend's sentence only where it adds facts (e.g. the area's size); otherwise it would repeat the above. */}
      {detail && SHOW_DETAIL.has(code) && <p className="mt-1 text-[11px] leading-snug text-ink-3">{detail}</p>}
      {onRetry && <Button size="sm" variant="secondary" className="mt-2" icon={<RotateCcw size={13} />} onClick={onRetry}>Check again</Button>}
    </div>
  );
}

const dur = (s: number) => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);
const fmtEstimate = (e?: QuickScan['estimate']) => {
  if (e?.restricted) {
    if (e.seconds !== null) return `Estimated time in restricted mode: about ${dur(e.seconds)} (${e.basis}).`;
    if (e.range_s) return `Estimated time in restricted mode: about ${dur(e.range_s[0])}–${dur(e.range_s[1])} (${e.basis}).`;
    return 'Estimated time in restricted mode: several minutes (not yet measured on this server; forest analyses ran about 5–6× slower in restricted mode).';
  }
  return !e || e.seconds === null
    ? 'Estimated time: usually under a minute (not yet measured on this server); several minutes when Earth Engine is busy.'
    : `Estimated time: about ${dur(e.seconds)} (${e.basis}); longer when Earth Engine is busy.`;
};

/** Earth Engine restricted mode: information, not a refusal — the button stays enabled and says the scan is slower. */
function SlowMode({ message }: { message: string }) {
  return (
    <div className="flex gap-2 rounded-md bg-white/[0.03] p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.1)]" data-testid="qs-slow-mode">
      <Gauge size={14} className="mt-0.5 shrink-0 text-accent" />
      <p className="text-[12px] leading-relaxed text-ink-2">{message}</p>
    </div>
  );
}

function LandCover({ d }: { d: QuickScan }) {
  const lc = d.landcover!;
  if (lc.status !== 'READY' || !lc.classes) return <Section icon={<Trees size={14} className="text-forest" />} title="Land cover" testId="qs-landcover"><Unavailable reason={lc.reason} /><Source source={lc.source} /></Section>;
  const shown = lc.classes.filter((c) => c.area_km2 > 0).sort((a, b) => b.share - a.share);
  const study = lc.advisor_classes ?? null;
  return (
    <Section icon={<Trees size={14} className="text-forest" />} title="Land cover (LULC)" layer="landcover" testId="qs-landcover">
      <div className="flex h-2.5 overflow-hidden rounded-full" aria-hidden>
        {(study ?? shown).filter((c) => (c.share ?? 0) > 0).map((c) => <span key={c.key} style={{ width: `${(c.share ?? 0) * 100}%`, background: c.color }} />)}
      </div>
      {study && (
        <table className="mt-2.5 w-full text-[12px]" data-testid="qs-lulc-table">
          <thead><tr className="text-[10.5px] text-ink-4"><th className="text-left font-normal">Class</th><th className="text-right font-normal">Area</th><th className="w-16 text-right font-normal">Share</th></tr></thead>
          <tbody>
            {study.filter((c) => !['wetland', 'snow_ice'].includes(c.key) || c.area_km2 > 0).map((c) => (
              <tr key={c.key}>
                <td className="py-0.5"><span className="mr-2 inline-block h-2.5 w-2.5 rounded-[2px] align-middle" style={{ background: c.color }} /><span className="text-ink-2">{c.name}</span></td>
                <td className="t-data text-right text-ink">{km2(c.area_km2)}</td>
                <td className="t-data text-right text-ink-3">{pct(c.share)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details className="mt-2 text-[11.5px]" open={!study}>
        <summary className="cursor-pointer text-ink-3 hover:text-ink">Dynamic World classes</summary>
        <ul className="mt-1.5 space-y-1 text-[12px]">
          {shown.map((c) => (
            <li key={c.key} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: c.color }} />
              <span className="min-w-0 flex-1 truncate text-ink-2">{c.name}</span>
              <span className="t-data shrink-0 text-ink">{km2(c.area_km2)}</span>
              <span className="t-data w-14 shrink-0 text-right text-ink-3">{pct(c.share)}</span>
            </li>
          ))}
        </ul>
      </details>
      <p className="mt-2 text-[11px] leading-snug text-ink-3">
        Low confidence (Dynamic World probability below 0.5): {pct(lc.low_confidence_share)} of the area.
        {lc.worldcover_agreement && <> Agrees with ESA WorldCover 2021 on {pct(lc.worldcover_agreement.share, 0)} of the area (a cross-check, not accuracy).</>}
      </p>
      <Source source={lc.source} extra={`statistics at ${String(lc.source.statistics_resolution_m ?? 30)} m`} />
      <Disclaimer text={d.disclaimer} />
    </Section>
  );
}

function Heat({ d }: { d: QuickScan }) {
  const lst = d.lst!;
  const setQs = useUi((s) => s.setQuickScan);
  const first = lst.source.first_scene as string | null | undefined, last = lst.source.last_scene as string | null | undefined;
  const scenes = `${lst.source.scenes as number} scenes${first && last ? ` (${first} to ${last})` : ''}`;
  if (lst.status !== 'READY') {
    return (
      <Section icon={<Flame size={14} className="text-warn" />} title="Surface temperature" testId="qs-lst">
        {lst.reason_code === 'too_few_scenes' ? (
          <div data-testid="qs-too-few-scenes">
            <p className="text-[12px] leading-relaxed text-ink-2">
              Too few clear Landsat scenes: <b className="t-data text-ink">{lst.scenes_found}</b> found for {d.season_label} {d.year}, at least <b className="t-data text-ink">{lst.min_scenes}</b> needed. No temperature is shown rather than one from too few scenes.
            </p>
            {lst.suggest_season && (
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => setQs({ season: lst.suggest_season ?? 'all', layer: null })} data-testid="qs-switch-all-months">
                Try All months (more clear scenes)
              </Button>
            )}
          </div>
        ) : <Unavailable reason={lst.reason} />}
        <Source source={lst.source} extra={scenes} />
      </Section>
    );
  }
  const per = [...(lst.per_class ?? [])].filter((c) => !c.water && c.area_km2 >= 0.05).sort((a, b) => b.mean_c - a.mean_c);
  const u = lst.uhi;
  return (
    <Section icon={<Flame size={14} className="text-warn" />} title="Surface temperature" layer="lst" testId="qs-lst">
      <div className="flex items-baseline justify-between gap-3">
        <div><span className="t-data text-[24px] font-semibold text-ink">{degC(lst.mean_c)}</span><span className="ml-2 text-[11px] text-ink-3">mean of land</span></div>
        <div className="t-data text-right text-[11px] text-ink-3">{degC(lst.p2_c)} – {degC(lst.p98_c)}<div className="text-[10px] text-ink-4">2nd–98th percentile</div></div>
      </div>
      {per.length > 0 && (
        <ul className="mt-2.5 space-y-0.5 text-[12px]">
          {per.map((c) => (
            <li key={c.key} className="flex justify-between gap-3"><span className="text-ink-2">{c.name}</span><span className="t-data text-ink">{degC(c.mean_c)}</span></li>
          ))}
        </ul>
      )}
      <div className="mt-2.5 rounded-sm bg-white/[0.03] px-2.5 py-2 text-[11.5px] leading-snug" data-testid="qs-uhi">
        {u?.status === 'READY' && u.value_c !== undefined
          ? <><span className="text-ink-2">{u.label}: </span><b className="t-data text-ink">{signedC(u.value_c)}</b><span className="text-ink-3"> (built {degC(u.built_mean_c)} vs other land {degC(u.other_mean_c)})</span></>
          : <span className="text-ink-3">{u?.reason ?? 'No heat-island figure for this area.'}</span>}
        {lst.uhi_vegetated && (
          <div className="mt-1.5 border-t border-line pt-1.5" data-testid="qs-uhi-vegetated">
            {lst.uhi_vegetated.status === 'READY' && lst.uhi_vegetated.value_c !== undefined
              ? <><span className="text-ink-2">UHI against vegetated land: </span><b className="t-data text-ink">{signedC(lst.uhi_vegetated.value_c)}</b><span className="text-ink-3"> (built {degC(lst.uhi_vegetated.built_mean_c)} vs vegetated {degC(lst.uhi_vegetated.vegetated_mean_c)}; bare ground and water excluded)</span></>
              : <span className="text-ink-3">UHI against vegetated land: {lst.uhi_vegetated.reason}</span>}
          </div>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-snug text-ink-3">Landsat passes over at about 10:30 local time; water is left out of the land statistics. Clear-sky coverage: {pct(lst.valid_share, 0)} of the area.</p>
      <Source source={lst.source} extra={scenes} />
      <Disclaimer text={d.disclaimer} />
    </Section>
  );
}

function Carbon({ d }: { d: QuickScan }) {
  const c = d.carbon!.components[0];
  if (c.status !== 'READY') return <Section icon={<Leaf size={14} className="text-forest" />} title="Carbon" testId="qs-carbon"><Unavailable reason={c.reason} /><Source source={c.source} /></Section>;
  return (
    <Section icon={<Leaf size={14} className="text-forest" />} title="Carbon" layer="carbon" testId="qs-carbon">
      <div className="text-[11px] text-ink-2">{c.label}</div>
      <div className="mt-1 flex items-baseline justify-between gap-3">
        <div><span className="t-data text-[24px] font-semibold text-ink">{c.density_t_per_ha?.toFixed(1)}</span><span className="ml-1.5 text-[11px] text-ink-3">t C/ha</span></div>
        {c.total_t !== undefined && c.range_t && (
          <div className="t-data text-right text-[11px] text-ink-2">{tonnes(c.total_t)} C in total<div className="text-[10px] text-ink-4">range {tonnes(c.range_t[0])} – {tonnes(c.range_t[1])}</div></div>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-snug text-ink-3">
        Biomass × {c.carbon_fraction} (IPCC carbon fraction). {c.excludes} Biomass values cover {pct(c.coverage_share, 0)} of the area.
        {c.source.year !== undefined && c.source.year !== d.year && <> The biomass map is from {c.source.year}, the latest ESA CCI year; the scan year is {d.year}.</>}
      </p>
      <Source source={c.source} />
      <Disclaimer text={d.disclaimer} />
    </Section>
  );
}

const signed = (v: number, unit: string, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)} ${unit}`;

/** Change between this scan's year and an earlier one (both scanned, same season): LULC, built-up expansion, LST, UHI. */
function CompareYears({ d }: { d: QuickScan }) {
  const earlier = Array.from({ length: d.year - d.first_year }, (_, i) => d.first_year + i);
  const [from, setFrom] = useState<number | null>(earlier[0] ?? null);
  const c = useQuickScanCompare(d.aoi_id, from, d.year, d.season);
  const runEarlier = useRunQuickScan(d.aoi_id, from, d.season);
  const [busy, setBusy] = useState(false);
  const prior = useQuickScan(d.aoi_id, from, d.season);   // polls while the earlier scan runs
  const priorReady = prior.data?.status === 'READY';
  const refetch = c.refetch;
  useEffect(() => { if (priorReady) void refetch(); }, [priorReady, refetch]);
  if (!earlier.length) return null;
  const x = c.data;
  return (
    <Section icon={<ArrowRightLeft size={14} className="text-accent" />} title="Change between years" testId="qs-compare">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
        From <Menu<number> label="Compare from year" value={from ?? earlier[0]} onChange={setFrom} options={earlier.map((y) => ({ value: y, label: String(y) }))} /> to <b className="t-data text-ink">{d.year}</b>
        <span className="text-ink-4">({d.season_label})</span>
      </div>
      {c.isLoading && <p className="mt-2 text-[12px] text-ink-3">Loading…</p>}
      {x?.status === 'NOT_RUN' && (
        <div className="mt-2 space-y-2">
          <p className="text-[12px] text-ink-3">{x.reason}</p>
          {prior.data?.status === 'PROCESSING'
            ? <p className="flex items-center gap-2 text-[12px] text-ink-2"><Loader2 size={14} className="animate-spin text-accent" />Scanning {from}…</p>
            : <Button size="sm" variant="secondary" icon={<ScanSearch size={14} />} disabled={busy} data-testid="qs-scan-earlier"
                onClick={async () => { setBusy(true); try { await runEarlier(); await prior.refetch(); } finally { setBusy(false); } }}>Scan {from}</Button>}
        </div>
      )}
      {x?.status === 'READY' && (
        <div className="mt-2.5 space-y-2.5" data-testid="qs-compare-ready">
          {x.landcover?.status === 'READY' && x.landcover.classes && (
            <>
              {x.landcover.built_expansion_km2 != null && (
                <p className="text-[12px] text-ink-2">Built-up {x.landcover.built_expansion_km2 >= 0 ? 'expansion' : 'change'}: <b className="t-data text-ink">{signed(x.landcover.built_expansion_km2, 'km²', 2)}</b>
                  {x.landcover.built_expansion_pct != null && <span className="text-ink-3"> ({signed(x.landcover.built_expansion_pct, '%')})</span>}</p>
              )}
              <table className="w-full text-[11.5px]">
                <thead><tr className="text-[10.5px] text-ink-4"><th className="text-left font-normal">Class</th><th className="text-right font-normal">{x.from_year}</th><th className="text-right font-normal">{x.to_year}</th><th className="text-right font-normal">Change</th></tr></thead>
                <tbody>
                  {x.landcover.classes.filter((r) => r.from_km2 > 0 || r.to_km2 > 0).map((r) => (
                    <tr key={r.key}>
                      <td className="py-0.5 text-ink-2"><span className="mr-1.5 inline-block h-2 w-2 rounded-[2px] align-middle" style={{ background: r.color }} />{r.name}</td>
                      <td className="t-data text-right text-ink-3">{km2(r.from_km2)}</td>
                      <td className="t-data text-right text-ink-3">{km2(r.to_km2)}</td>
                      <td className={`t-data text-right ${r.change_km2 && r.change_km2 > 0 ? 'text-accent' : r.change_km2 && r.change_km2 < 0 ? 'text-warn' : 'text-ink-3'}`}>{r.change_km2 == null ? '—' : signed(r.change_km2, 'km²', 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[10.5px] leading-snug text-ink-4">{x.landcover.note}</p>
            </>
          )}
          {x.lst?.status === 'READY' ? (
            <p className="text-[12px] leading-relaxed text-ink-2">
              Mean land surface temperature {degC(x.lst.from_mean_c)} → {degC(x.lst.to_mean_c)}
              {x.lst.uhi_change_c != null && <> · UHI (vs other land) {signed(x.lst.uhi_change_c, '°C', 2)}</>}
              {x.lst.uhi_vegetated_change_c != null && <> · UHI (vs vegetated) {signed(x.lst.uhi_vegetated_change_c, '°C', 2)}</>}
              <span className="mt-1 block text-[10.5px] text-ink-4">{x.lst.note}</span>
            </p>
          ) : <p className="text-[12px] text-ink-3">{x.lst?.reason}</p>}
          <Disclaimer text={x.disclaimer} />
        </div>
      )}
    </Section>
  );
}

/** Estimated above-ground tree carbon per ESA CCI epoch (2007–2022) and its change — on request (one EE request). */
function CarbonOverTime({ aoi }: { aoi: string }) {
  const c = useCarbonSeries(aoi);
  const [busy, setBusy] = useState(false);
  const d = c.data;
  return (
    <Section icon={<History size={14} className="text-forest" />} title="Carbon over time (estimate)" testId="qs-carbon-series">
      {c.isLoading && <p className="text-[12px] text-ink-3">Loading…</p>}
      {d && (d.status === 'NOT_RUN' || (d.status === 'UNAVAILABLE' && !d.series)) && (
        <div className="space-y-2">
          {d.reason && <p className="text-[12px] text-ink-3">{d.reason}</p>}
          <p className="text-[12px] leading-relaxed text-ink-2">Estimate above-ground tree carbon for every ESA CCI biomass year (2007, 2010, 2015–2022) and how it changed. One Earth Engine request; the result is stored.</p>
          <Button size="sm" variant="secondary" icon={busy ? <Loader2 size={14} className="animate-spin" /> : <Leaf size={14} />} disabled={busy || d.retryable === false}
            onClick={async () => { setBusy(true); try { await c.run(); } finally { setBusy(false); } }} data-testid="qs-run-carbon">Estimate carbon over time</Button>
        </div>
      )}
      {d?.status === 'PROCESSING' && <p className="flex items-center gap-2 text-[12px] text-ink-2"><Loader2 size={14} className="animate-spin text-accent" />Reading ESA CCI biomass for every epoch…</p>}
      {d?.series && (
        <div className="space-y-2" data-testid="qs-carbon-series-ready">
          {d.change && (
            <p className="text-[12px] text-ink-2">
              {d.change.from_year} → {d.change.to_year}: <b className="t-data text-ink">{d.change.change_t >= 0 ? '+' : '−'}{tonnes(Math.abs(d.change.change_t))} C</b>
              {d.change.change_pct != null && <span className="text-ink-3"> ({signed(d.change.change_pct, '%')})</span>}
              {d.change.ranges_overlap && <span className="block text-[11px] text-warn">The two years' uncertainty ranges overlap: this change is within map uncertainty.</span>}
            </p>
          )}
          <table className="w-full text-[11.5px]">
            <thead><tr className="text-[10.5px] text-ink-4"><th className="text-left font-normal">Year</th><th className="text-right font-normal">Carbon</th><th className="text-right font-normal">Range</th><th className="text-right font-normal">t C/ha</th></tr></thead>
            <tbody>
              {d.series.map((s) => (
                <tr key={s.year} className={s.status === 'READY' && !s.usable_for_change ? 'opacity-60' : ''}>
                  <td className="t-data py-0.5 text-ink-2">{s.year}</td>
                  {s.status === 'READY' && s.total_t !== undefined && s.range_t ? (
                    <><td className="t-data text-right text-ink">{tonnes(s.total_t)}</td><td className="t-data text-right text-ink-3">{tonnes(s.range_t[0])}–{tonnes(s.range_t[1])}</td><td className="t-data text-right text-ink-3">{s.density_t_per_ha?.toFixed(1)}</td></>
                  ) : <td colSpan={3} className="text-right text-ink-4">not available</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10.5px] leading-snug text-ink-4">{d.method} {d.excludes} {d.caveat}</p>
          {d.tier1 && <p className="text-[10.5px] leading-snug text-ink-4">IPCC Tier 1 cross-check: {d.tier1.reason}</p>}
          {d.source && <p className="text-[10.5px] leading-snug text-ink-4">{d.source.citation}</p>}
        </div>
      )}
    </Section>
  );
}

/** "Land, heat & carbon": the quick scan of the open area — behind a "Run quick scan" button, never automatic. */
export function QuickScanPanel() {
  const aoi = useUi((s) => s.investigation.study?.id ?? null);
  const qs = useUi((s) => s.quickScan);
  const setQs = useUi((s) => s.setQuickScan);
  // A new area starts from the defaults (latest year, all months, no layer) — choices never carry over between areas.
  useEffect(() => { if (qs.aoi !== aoi) setQs({ aoi, year: null, season: null, layer: null }); }, [aoi, qs.aoi, setQs]);
  const q = useQuickScan(aoi, qs.year, qs.season);
  const run = useRunQuickScan(aoi, qs.year, qs.season);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ code: string; message: string } | null>(null);
  const d = q.data;
  const years = d ? Array.from({ length: d.last_year - d.first_year + 1 }, (_, i) => d.last_year - i) : [];
  const start = async () => {
    setBusy(true); setErr(null);
    try { await run(); } catch (e) { setErr({ code: e instanceof ApiError && e.code === 'rate_limited' ? 'rate_limited' : 'service', message: (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3" data-testid="quickscan-panel" data-status={d?.status ?? 'loading'}>
      <div>
        <h2 className="text-[13.5px] font-semibold text-ink">Land, heat &amp; carbon</h2>
        <div className="mt-1.5"><TierBadge tier="quick" /></div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {d && <Menu<number> label="Scan year" value={d.year} onChange={(y) => setQs({ year: y })} options={years.map((y) => ({ value: y, label: String(y) }))} />}
        <Menu<QuickScanSeason> label="Season (temperature)" value={d?.season ?? qs.season ?? 'all'} onChange={(s) => setQs({ season: s, layer: null })} options={SEASONS} />
      </div>
      {d?.season_hint && <p className="text-[11px] leading-snug text-warn" data-testid="qs-season-hint">{d.season_hint}</p>}
      {q.isLoading && <p className="text-[12px] text-ink-3">Loading…</p>}
      {/* The service did not answer at all: a quick-scan message, never the forest-analysis text. */}
      {q.isError && (
        <div className="space-y-2.5" data-testid="qs-service-error">
          <Notice code="service" onRetry={() => q.refetch()} />
          <Button variant="brand" icon={<ScanSearch size={15} />} disabled data-testid="run-quick-scan">Run quick scan</Button>
        </div>
      )}
      {d && (d.status === 'NOT_RUN' || (d.status === 'UNAVAILABLE' && !d.landcover)) && (() => {
        // No stored scan: the button is always shown; disabled only when a run cannot succeed on this server.
        const problem = d.status === 'UNAVAILABLE' ? { reason_code: d.reason_code ?? 'quickscan_failed', reason: d.reason ?? null, retryable: !!d.retryable } : d.blocked;
        const canRun = !problem || problem.retryable;
        return (
          <div className="space-y-2.5" data-testid="qs-not-run" data-blocked={problem?.reason_code ?? ''}>
            {problem && <Notice code={problem.reason_code} detail={problem.reason} />}
            {!problem && d.restricted_mode && <SlowMode message={d.restricted_mode.message} />}
            <p className="text-[12px] leading-relaxed text-ink-2">
              Not scanned yet for {d.year}{d.season !== 'all' ? ` (temperature: ${d.season_label})` : ''}. A quick scan measures land cover (Dynamic World), surface temperature (Landsat) and above-ground tree biomass carbon (ESA CCI) in one Earth Engine request; the result is stored and opens instantly afterwards.
            </p>
            <Button variant="brand" icon={busy ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />} disabled={busy || !canRun} onClick={start} data-testid="run-quick-scan">
              {d.restricted_mode && !problem ? 'Run quick scan (slower this month)' : 'Run quick scan'}
            </Button>
            <p className="text-[10.5px] leading-snug text-ink-4" data-testid="qs-estimate">{fmtEstimate(d.estimate)}</p>
            {err && <Notice code={err.code} detail={err.code === 'service' ? null : err.message} />}
          </div>
        );
      })()}
      {d?.status === 'PROCESSING' && (
        <div className="space-y-1.5" data-testid="qs-processing" data-queued={d.queued ? 'true' : 'false'}>
          <p className="flex items-center gap-2 text-[12px] text-ink-2">
            <Loader2 size={14} className="animate-spin text-accent" />
            {d.queued ? 'Waiting for another quick scan to finish (they run one at a time)…' : `Scanning Landsat, Dynamic World and ESA CCI for ${d.year}…`}
          </p>
          {d.restricted_mode && <p className="text-[11px] leading-snug text-ink-3">Earth Engine is in its slower restricted mode this month, so this may take several minutes. You can leave this tab open or come back later: the result is stored.</p>}
          <p className="text-[10.5px] leading-snug text-ink-4">{fmtEstimate(d.estimate)}</p>
        </div>
      )}
      {/* A stored scan (READY, or measured with every dataset unavailable): each section shows its value or its reason. */}
      {d && d.landcover && d.lst && d.carbon && (
        <div className="space-y-3" data-testid="qs-ready">
          <LandCover d={d} />
          <Heat d={d} />
          <Carbon d={d} />
          {d.status === 'READY' && <CompareYears d={d} />}
          {d.status === 'READY' && <CarbonOverTime aoi={d.aoi_id} />}
          <p className="text-[10px] leading-snug text-ink-4">
            Scanned {d.computed_at?.slice(0, 10)}{d.elapsed_s !== undefined ? ` in ${d.elapsed_s.toFixed(0)} s` : ''} · {d.area_km2 !== undefined ? km2(d.area_km2) : ''} · method {d.quickscan_version}. Not counted in TerraTrace's forest totals.
          </p>
        </div>
      )}
    </div>
  );
}
