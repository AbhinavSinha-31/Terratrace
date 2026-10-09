import { Layers3, Mountain, Trees } from 'lucide-react';
import type { AreaContext, ContextSource } from '../../data/contracts';
import { useAreaContext, useHealth } from '../../data/queries';
import { useUi } from '../../state/store';
import { fmtHa, fmtShare } from '../../lib/format';

/** "dataset · year" — printed under EVERY reference value (never a bare number). */
function Src({ s, extra }: { s: ContextSource; extra?: string }) {
  return (
    <div className="t-data mt-0.5 text-[9.5px] leading-snug text-ink-4" data-testid="context-source">
      {s.dataset} · {s.year_label ?? s.year}{extra ? ` · ${extra}` : ''}
    </div>
  );
}

function Row({ label, value, source, extra, unavailable }: { label: string; value: React.ReactNode; source: ContextSource; extra?: string; unavailable?: string | null }) {
  return (
    <div className="border-t border-line px-3.5 py-2.5 first:border-t-0" data-testid="context-row">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11.5px] text-ink-3">{label}</span>
        {unavailable
          ? <span className="text-right text-[11px] text-warn" data-testid="context-unavailable">Unavailable</span>
          : <span className="t-data text-right text-[12.5px] text-ink">{value}</span>}
      </div>
      {unavailable && <div className="mt-0.5 text-[10.5px] leading-snug text-ink-3">{unavailable}</div>}
      <Src s={source} extra={extra} />
    </div>
  );
}

/** Hansen loss per year 2001–2025 (measured hectares; a 0 is a measured zero). Inline SVG, one bar per year. */
function LossBars({ years }: { years: { year: number; loss_ha: number }[] }) {
  const max = Math.max(...years.map((y) => y.loss_ha), 0);
  const w = 6, gap = 2, h = 38;
  return (
    <figure className="px-3.5 pb-2.5" aria-label="Hansen tree cover loss per year, 2001 to 2025">
      <svg width={years.length * (w + gap)} height={h + 12} className="block" role="img">
        {years.map((y, i) => {
          const bh = max > 0 ? Math.max(y.loss_ha > 0 ? 1 : 0, (y.loss_ha / max) * h) : 0;
          return (
            <rect key={y.year} x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={1} fill="#e8743b" opacity={0.85}>
              <title>{`${y.year}: ${fmtHa(y.loss_ha)} ha`}</title>
            </rect>
          );
        })}
        <text x={0} y={h + 10} className="fill-current text-ink-4" fontSize={8}>2001</text>
        <text x={years.length * (w + gap) - 18} y={h + 10} className="fill-current text-ink-4" fontSize={8}>2025</text>
      </svg>
      <figcaption className="t-data text-[9.5px] text-ink-4">peak {fmtHa(max)} ha/yr · hover a bar for its year</figcaption>
    </figure>
  );
}

function Body({ ctx }: { ctx: AreaContext }) {
  if (ctx.status === 'UNAVAILABLE' || !ctx.terrain || !ctx.forest) {
    return <p className="px-3.5 py-3 text-[11.5px] leading-relaxed text-warn" data-testid="context-unavailable">Reference context unavailable — {ctx.reason ?? 'it could not be measured.'} Nothing is substituted.</p>;
  }
  const t = ctx.terrain, f = ctx.forest;
  const e = t.elevation_m;
  const tc = f.tree_cover_2000, loss = f.loss_by_year, gain = f.gain_2000_2012, wc = f.worldcover_2021;
  const tu = t.status === 'READY' ? null : t.reason ?? 'Not measured.';
  const lc = ctx.land_cover_2021;
  return (
    <>
      {ctx.surface?.message && (
        <p className="rounded-md bg-white/[0.04] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink-2 shadow-[0_0_0_1px_rgba(255,255,255,0.065)]" data-testid="context-surface" data-kind={ctx.surface.kind}>
          {ctx.surface.message}
        </p>
      )}
      <section className="overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(255,255,255,0.065)]" data-testid="context-terrain">
        <div className="t-label flex items-center gap-1.5 border-b border-line px-3.5 py-2 text-ink-3"><Mountain size={11} />Terrain</div>
        <Row label="Elevation (mean)" value={e?.mean != null ? `${e.mean} m` : '—'} source={t.source} unavailable={tu}
          extra={e?.min != null && e.max != null ? `range ${e.min}–${e.max} m${e.p5 != null && e.p95 != null ? `, 5–95 %: ${e.p5}–${e.p95} m` : ''}` : undefined} />
        <Row label="Slope (mean)" value={t.slope_mean_deg != null ? `${t.slope_mean_deg}°` : '—'} source={t.source} unavailable={tu} />
        <Row label={`Steeper than ${t.steep_threshold_deg}°`} value={t.steep_share_pct != null ? `${fmtShare(t.steep_share_pct)} of the area` : '—'} source={t.source} unavailable={tu} />
        {t.source.note && <p className="border-t border-line px-3.5 py-2 text-[10px] leading-snug text-ink-4">{t.source.note}</p>}
      </section>

      <section className="overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(255,255,255,0.065)]" data-testid="context-forest">
        <div className="t-label flex items-center gap-1.5 border-b border-line px-3.5 py-2 text-ink-3"><Trees size={11} />Forest cover · reference</div>
        <Row label="Tree cover · year-2000 baseline" source={tc.source} extra={`canopy ≥ ${tc.canopy_threshold_pct} %`}
          unavailable={tc.status === 'READY' ? null : tc.reason}
          value={tc.share_of_land_pct != null && tc.area_ha != null ? `${fmtShare(tc.share_of_land_pct)} of land · ${fmtHa(tc.area_ha)} ha` : '—'} />
        <Row label="Tree cover loss · 2001–2025" source={loss.source} unavailable={loss.status === 'READY' ? null : loss.reason}
          value={loss.total_ha != null ? `${fmtHa(loss.total_ha)} ha${loss.share_of_2000_tree_cover_pct != null ? ` · ${fmtShare(loss.share_of_2000_tree_cover_pct)} of the 2000 cover` : ''}` : '—'} />
        {loss.status === 'READY' && loss.years && <LossBars years={loss.years} />}
        <Row label="Tree cover gain · 2000–2012 only" source={gain.source} unavailable={gain.status === 'READY' ? null : gain.reason}
          value={gain.area_ha != null ? `${fmtHa(gain.area_ha)} ha` : '—'} />
        <Row label="Tree cover class · 2021" source={wc.source} unavailable={wc.status === 'READY' ? null : wc.reason}
          value={wc.share_of_land_pct != null && wc.area_ha != null ? `${fmtShare(wc.share_of_land_pct)} of land · ${fmtHa(wc.area_ha)} ha` : '—'} />
        <p className="border-t border-line px-3.5 py-2 text-[10px] leading-snug text-ink-4" data-testid="context-not-current">
          None of these is current forest cover. The datasets define trees differently (Hansen: canopy ≥ {tc.canopy_threshold_pct} % at 30 m;
          WorldCover: a land-cover class at 10 m) and are not comparable with each other or with TerraTrace's forest mask. {loss.source.note}
        </p>
      </section>

      {lc && (
        <section className="overflow-hidden rounded-md shadow-[0_0_0_1px_rgba(255,255,255,0.065)]" data-testid="context-land-cover">
          <div className="t-label flex items-center gap-1.5 border-b border-line px-3.5 py-2 text-ink-3"><Layers3 size={11} />Land cover · reference</div>
          {lc.status === 'READY' && lc.classes ? (
            <ul className="px-3.5 py-2.5" data-testid="context-row">
              {lc.classes.map((k) => (
                <li key={k.class} className="flex items-center gap-2 py-0.5 text-[11.5px]" data-testid="land-cover-class">
                  <span className="w-[46%] truncate text-ink-3">{k.name}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]"><span className="block h-full rounded-full bg-ink-3/70" style={{ width: `${Math.min(100, k.share_pct)}%` }} /></span>
                  <span className="t-data w-[52px] text-right text-ink">{fmtShare(k.share_pct)}</span>
                </li>
              ))}
              <Src s={lc.source} extra="share of the mapped area" />
            </ul>
          ) : (
            <div className="px-3.5 py-2.5" data-testid="context-row">
              <div className="text-[11px] text-warn" data-testid="context-unavailable">Unavailable</div>
              <div className="mt-0.5 text-[10.5px] leading-snug text-ink-3">{lc.reason}</div>
              <Src s={lc.source} />
            </div>
          )}
        </section>
      )}
    </>
  );
}

/**
 * Terrain + forest cover of the open area from REFERENCE datasets — shown whatever the analysis status, always
 * labelled "Reference context, not a TerraTrace result", with the dataset and year on every value.
 */
export function AreaContextPanel() {
  const aoiId = useUi((s) => s.investigation.study?.id ?? null);
  const q = useAreaContext(aoiId);
  const offline = useHealth().data?.backend === false;
  if (!aoiId) return null;
  return (
    <div className="space-y-3" data-testid="area-context" data-status={q.data?.status ?? (q.isError || offline ? 'ERROR' : 'LOADING')}>
      <div className="flex items-baseline justify-between gap-2 pt-1">
        <div className="t-label text-ink-2">Area context</div>
        <div className="text-[10px] text-ink-4" data-testid="context-label">Reference context, not a TerraTrace result</div>
      </div>
      {q.data ? <Body ctx={q.data} />
        : q.isError || offline
          ? <p className="text-[11.5px] leading-relaxed text-warn" data-testid="context-unavailable">Reference context unavailable — {offline ? 'the TerraTrace service could not be reached' : 'it could not be requested right now'}. Nothing is substituted.</p>
          : <div className="space-y-2" aria-busy="true"><div className="skeleton h-20 rounded-md" /><div className="text-[10.5px] text-ink-4">Measuring reference datasets…</div></div>}
    </div>
  );
}
