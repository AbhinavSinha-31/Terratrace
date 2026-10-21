import { useState, type ReactNode } from 'react';
import { Flame, Leaf, Loader2, ScanSearch, Trees } from 'lucide-react';
import { Button, Menu, Switch } from '../../design';
import { useQuickScan, useRunQuickScan } from '../../data/queries';
import type { QuickScan, QuickScanLayer, QuickScanSeason, QuickScanSource } from '../../data/contracts';
import { useUi } from '../../state/store';
import { TierBadge } from '../shell/TierBadge';

const SEASONS: { value: QuickScanSeason; label: string }[] = [
  { value: 'all', label: 'Whole year' }, { value: 'mam', label: 'Mar–May' }, { value: 'jja', label: 'Jun–Aug' },
  { value: 'son', label: 'Sep–Nov' }, { value: 'djf', label: 'Dec–Feb' },
];

const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)} %`);
const km2 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v >= 100 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(v >= 10 ? 1 : 2)} km²`);
const degC = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)} °C`);
const signedC = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} °C`;
/** Tonnes of carbon in a readable unit (t, kt, Mt). */
const tonnes = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} Mt` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} kt` : `${Math.round(v)} t`);

/** Dataset · year · resolution — printed under every value. */
function Source({ source, extra }: { source: QuickScanSource; extra?: string }) {
  const parts = [source.dataset, source.year ? String(source.season_label ? `${source.season_label} ${source.year}` : source.year) : null,
    `${source.resolution_m} m`, extra].filter(Boolean);
  return <p className="mt-2 text-[10.5px] leading-snug text-ink-4" data-testid="qs-source">{parts.join(' · ')}</p>;
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

function LandCover({ d }: { d: QuickScan }) {
  const lc = d.landcover!;
  if (lc.status !== 'READY' || !lc.classes) return <Section icon={<Trees size={14} className="text-forest" />} title="Land cover" testId="qs-landcover"><Unavailable reason={lc.reason} /><Source source={lc.source} /></Section>;
  const shown = lc.classes.filter((c) => c.area_km2 > 0).sort((a, b) => b.share - a.share);
  return (
    <Section icon={<Trees size={14} className="text-forest" />} title="Land cover" layer="landcover" testId="qs-landcover">
      <div className="flex h-2.5 overflow-hidden rounded-full" aria-hidden>
        {shown.map((c) => <span key={c.key} style={{ width: `${c.share * 100}%`, background: c.color }} />)}
      </div>
      <ul className="mt-2.5 space-y-1 text-[12px]">
        {shown.map((c) => (
          <li key={c.key} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: c.color }} />
            <span className="min-w-0 flex-1 truncate text-ink-2">{c.name}</span>
            <span className="t-data shrink-0 text-ink">{km2(c.area_km2)}</span>
            <span className="t-data w-14 shrink-0 text-right text-ink-3">{pct(c.share)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-snug text-ink-3">
        Low confidence (Dynamic World probability below 0.5): {pct(lc.low_confidence_share)} of the area.
        {lc.worldcover_agreement && <> Agrees with ESA WorldCover 2021 on {pct(lc.worldcover_agreement.share, 0)} of the area (a cross-check, not accuracy).</>}
      </p>
      <Source source={lc.source} extra={`statistics at ${String(lc.source.statistics_resolution_m ?? 30)} m`} />
    </Section>
  );
}

function Heat({ d }: { d: QuickScan }) {
  const lst = d.lst!;
  const scenes = `${lst.source.scenes as number} scenes`;
  if (lst.status !== 'READY') return <Section icon={<Flame size={14} className="text-warn" />} title="Surface temperature" testId="qs-lst"><Unavailable reason={lst.reason} /><Source source={lst.source} extra={scenes} /></Section>;
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
      </div>
      <p className="mt-2 text-[11px] leading-snug text-ink-3">Landsat passes over at about 10:30 local time; water is left out of the land statistics. Clear-sky coverage: {pct(lst.valid_share, 0)} of the area.</p>
      <Source source={lst.source} extra={scenes} />
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
      </p>
      <Source source={c.source} />
    </Section>
  );
}

/** "Land, heat & carbon": the quick scan of the open area — behind a "Run quick scan" button, never automatic. */
export function QuickScanPanel() {
  const aoi = useUi((s) => s.investigation.study?.id ?? null);
  const qs = useUi((s) => s.quickScan);
  const setQs = useUi((s) => s.setQuickScan);
  const q = useQuickScan(aoi, qs.year, qs.season);
  const run = useRunQuickScan(aoi, qs.year, qs.season);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = q.data;
  const years = d ? Array.from({ length: d.last_year - d.first_year + 1 }, (_, i) => d.last_year - i) : [];
  const start = async () => {
    setBusy(true); setErr(null);
    try { await run(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3" data-testid="quickscan-panel" data-status={d?.status ?? 'loading'}>
      <div>
        <h2 className="text-[13.5px] font-semibold text-ink">Land, heat &amp; carbon</h2>
        <div className="mt-1.5"><TierBadge tier="quick" /></div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {d && <Menu<number> label="Scan year" value={d.year} onChange={(y) => setQs({ year: y })} options={years.map((y) => ({ value: y, label: String(y) }))} />}
        <Menu<QuickScanSeason> label="Season (temperature)" value={qs.season} onChange={(s) => setQs({ season: s })} options={SEASONS} />
      </div>
      {q.isLoading && <p className="text-[12px] text-ink-3">Loading…</p>}
      {q.isError && <p className="text-[12px] text-warn">{(q.error as Error).message}</p>}
      {d && (d.status === 'NOT_RUN' || (d.status === 'UNAVAILABLE' && !d.landcover)) && (
        <div className="space-y-2.5" data-testid="qs-not-run">
          <p className="text-[12px] leading-relaxed text-ink-2">
            {d.status === 'UNAVAILABLE' ? d.reason : <>Land cover (Dynamic World), surface temperature (Landsat) and above-ground tree biomass carbon (ESA CCI) for {d.year}{d.season !== 'all' ? `, temperature for ${d.season_label}` : ''}. One Earth Engine request; the result is stored and opens instantly afterwards.</>}
          </p>
          {(d.status === 'NOT_RUN' || d.retryable) && (
            <Button variant="brand" icon={busy ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />} disabled={busy} onClick={start} data-testid="run-quick-scan">
              Run quick scan
            </Button>
          )}
          {err && <p className="text-[11.5px] text-warn">{err}</p>}
        </div>
      )}
      {d?.status === 'PROCESSING' && (
        <p className="flex items-center gap-2 text-[12px] text-ink-2" data-testid="qs-processing"><Loader2 size={14} className="animate-spin text-accent" />Scanning Landsat, Dynamic World and ESA CCI for {d.year}…</p>
      )}
      {/* A stored scan (READY, or measured with every dataset unavailable): each section shows its value or its reason. */}
      {d && d.landcover && d.lst && d.carbon && (
        <div className="space-y-3" data-testid="qs-ready">
          <LandCover d={d} />
          <Heat d={d} />
          <Carbon d={d} />
          <p className="text-[10px] leading-snug text-ink-4">
            Scanned {d.computed_at?.slice(0, 10)}{d.elapsed_s !== undefined ? ` in ${d.elapsed_s.toFixed(0)} s` : ''} · {d.area_km2 !== undefined ? km2(d.area_km2) : ''} · method {d.quickscan_version}. Not counted in TerraTrace's forest totals.
          </p>
        </div>
      )}
    </div>
  );
}
