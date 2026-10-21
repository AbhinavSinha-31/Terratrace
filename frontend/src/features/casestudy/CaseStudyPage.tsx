import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, ArrowLeft, BookOpenText, Info, ShieldCheck, X } from 'lucide-react';
import { Badge, IconButton, Segmented, Skeleton, StateView, Tooltip } from '../../design';
import { fmtDelta } from '../../lib/format';
import { useUi } from '../../state/store';
import { caseStudyAsset, caseStudyMeta, useCaseStudy, yearSpan, type CaseStudyDoc, type ImageRef } from './data';
import { CaseStudyMap } from './CaseStudyMap';
import { TierBadge } from '../shell/TierBadge';
import { DownloadCard } from './DownloadCard';

// Number formats match results_summary.md (1 decimal for km² and %, 2 for UHI, 3 for r and kappa).
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const km2 = (v: number) => nf1.format(v);
const pct1 = (v: number) => v.toFixed(1);
const degC = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} °C`;
const signedC = (v: number) => `${fmtDelta(v, 2)} °C`;
const signedR = (v: number) => fmtDelta(v, 3);
const SEASON = { summer: 'April–June (primary)', winter: 'November–February (secondary)' } as const;
type Season = keyof typeof SEASON;

function Section({ id, title, kicker, children }: { id: string; title: string; kicker?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="scroll-mt-20">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="t-h2 text-ink">{title}</h2>
        {kicker && <p className="text-[12px] text-ink-3">{kicker}</p>}
      </div>
      {children}
    </section>
  );
}

/** A publication figure (light background PNG/WebP from the pipeline), opening full size in a new tab. */
function Figure({ id, img, alt, caption }: { id: string; img: ImageRef | undefined; alt: string; caption?: ReactNode }) {
  if (!img) return null;
  const src = caseStudyAsset(id, img.file);
  return (
    <figure className="min-w-0">
      <a href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md bg-white shadow-[0_0_0_1px_rgba(255,255,255,0.1)]" title="Open full size">
        <img src={src} alt={alt} width={img.width} height={img.height} loading="lazy" className="h-auto w-full" />
      </a>
      {caption && <figcaption className="mt-1.5 text-[11.5px] leading-snug text-ink-3">{caption}</figcaption>}
    </figure>
  );
}

function Table({ children, minWidth = 520 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="no-scrollbar -mx-1 overflow-x-auto px-1">
      <table className="w-full border-collapse text-[12.5px]" style={{ minWidth }}>{children}</table>
    </div>
  );
}
/** Phones (< 640 px): a table's rows as cards, so no column is ever off-screen. The table itself is shown from sm up. */
interface PhoneCard { key: string; title: ReactNode; aside?: ReactNode; rows: [ReactNode, ReactNode][] }
function PhoneCards({ items, testId }: { items: PhoneCard[]; testId: string }) {
  return (
    <ul className="space-y-2 sm:hidden" data-testid={testId}>
      {items.map((it) => (
        <li key={it.key} className="rounded-md border border-line px-3 py-2.5 text-[12.5px]">
          <div className="flex items-center justify-between gap-2"><span className="text-ink">{it.title}</span>{it.aside}</div>
          {it.rows.map(([label, value], i) => (
            <div key={i} className={`${i ? 'mt-0.5' : 'mt-1.5'} flex justify-between gap-3 text-ink-2`}><span>{label}</span><span className="t-data shrink-0 text-ink">{value}</span></div>
          ))}
        </li>
      ))}
    </ul>
  );
}
const seasonShort = (s: Season) => (s === 'summer' ? 'Apr–Jun' : 'Nov–Feb');

const th = 'border-b border-line px-2 py-1.5 text-left font-medium text-ink-3';
const thr = `${th} text-right`;
const td = 'border-b border-line/60 px-2 py-1.5 text-ink-2';
const tdr = `${td} t-data text-right text-ink`;

function IslandBadge({ result }: { result: string }) {
  const tone = result === 'heat island' ? 'warn' : result === 'cool island' ? 'accent' : 'neutral';
  return <Badge tone={tone}>{result}</Badge>;
}

// ---------------------------------------------------------------- sections
function Header({ d, onClose }: { d: CaseStudyDoc; onClose(): void }) {
  const meta = caseStudyMeta(d.id);
  const years = yearSpan(d.study.years);
  const scenes = (y: number, s: string) => d.study.scenes.find((x) => x.year === y && x.season === s)?.scenes;
  return (
    <header className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <button onClick={onClose} className="tt-press flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink"><ArrowLeft size={15} /> Back</button>
        <IconButton label="Close case study" onClick={onClose}><X size={17} /></IconButton>
      </div>
      <div className="flex flex-wrap gap-2">
        <TierBadge tier="research" />
        <Badge tone="accent" icon={<BookOpenText size={11} />}>Landsat {years}</Badge>
        <span className="inline-flex items-center gap-1">
          <Badge>Precomputed analysis · interactive map</Badge>
          <Tooltip content={`Computed from Landsat satellite data with TerraTrace's analysis pipeline. Results are fixed for ${d.study.years.join(' and ')}; live re-analysis is coming later.`}>
            <button type="button" aria-label="About these results" className="tt-press grid h-6 w-6 place-items-center rounded-full text-ink-3 hover:text-ink">
              <Info size={13} />
            </button>
          </Tooltip>
        </span>
      </div>
      <div>
        <h1 id="case-study-title" className="t-h1 text-ink">{meta?.name ?? d.study.short_name}</h1>
        <p className="mt-1 text-[13px] text-ink-2">{meta?.subtitle} — {d.study.name}</p>
      </div>
      <dl className="grid grid-cols-1 gap-3 text-[12.5px] sm:grid-cols-3">
        <div className="tt-panel p-3">
          <dt className="t-label text-ink-3">Study area</dt>
          <dd className="mt-1 text-ink"><span className="t-data">{Math.round(d.study.area_km2).toLocaleString('en-US')} km²</span><span className="text-ink-3"> · {d.study.districts.join(' + ')} districts ({d.study.boundary_source})</span></dd>
        </div>
        <div className="tt-panel p-3">
          <dt className="t-label text-ink-3">Years and sensors</dt>
          <dd className="mt-1 space-y-0.5 text-ink">{d.study.years.map((y) => <div key={y}><span className="t-data">{y}</span><span className="text-ink-3"> · {d.study.sensors[y]}</span></div>)}</dd>
        </div>
        <div className="tt-panel p-3">
          <dt className="t-label text-ink-3">Scenes used</dt>
          <dd className="mt-1 space-y-0.5 text-ink">{d.study.years.map((y) => (
            <div key={y}><span className="t-data">{y}</span><span className="text-ink-3"> · {scenes(y, 'summer')} Apr–Jun · {scenes(y, 'winter')} Nov–Feb · {scenes(y, 'annual')} whole year</span></div>
          ))}</dd>
        </div>
      </dl>
    </header>
  );
}

/** Scrolls the case study to a section (an in-page #anchor would replace the app's own #/case-study/… route). */
const goTo = (id: string) => {
  const el = document.getElementById(id);
  // The id is the section's heading; its <section> carries the scroll margin that clears the app header.
  (el?.closest('section') ?? el)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function ToMethod({ children }: { children: ReactNode }) {
  return <button type="button" onClick={() => goTo('cs-method')} className="tt-press text-accent hover:underline">{children}</button>;
}

function Headlines({ d }: { d: CaseStudyDoc }) {
  return (
    <Section id="cs-findings" title="Key findings" kicker={`${yearSpan(d.study.years)} · from Landsat satellite data`}>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="case-study-headlines">
        {d.headlines.map((h) => (
          <li key={h.id} className="tt-panel flex flex-col p-4" data-headline={h.id}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="t-data text-[28px] font-semibold leading-none text-ink">{h.value}</span>
              <span className="t-label shrink-0 text-ink-3">{h.period}</span>
            </div>
            <h3 className="mt-3 text-[14px] font-semibold leading-snug text-ink">{h.title}</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{h.text}</p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] text-ink-3">How these figures were made, and what they cannot show: <ToMethod>Method &amp; limitations</ToMethod>.</p>
    </Section>
  );
}

function DetailedFindings({ d }: { d: CaseStudyDoc }) {
  return (
    <details className="tt-panel group p-4" data-testid="case-study-findings">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[13px] font-medium text-ink">
        Detailed findings (for researchers)
        <span className="text-[11.5px] font-normal text-ink-3 group-open:hidden">Show</span>
        <span className="hidden text-[11.5px] font-normal text-ink-3 group-open:inline">Hide</span>
      </summary>
      <p className="mt-2 text-[11.5px] text-ink-3">Verbatim from the pipeline's results summary, which is generated from the same tables.</p>
      <ol className="mt-3 space-y-2">
        {d.findings.map((f, i) => (
          <li key={i} className="flex gap-3 text-[12.5px] leading-relaxed text-ink-2">
            <span className="t-data grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/12 text-[11px] text-accent">{i + 1}</span>
            <span>{f}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function LandCoverMaps({ d }: { d: CaseStudyDoc }) {
  const ys = d.study.years;
  return (
    <Section id="cs-landcover" title={`Land cover, ${ys.join(' and ')}`} kicker="Satellite classification at 30 m · bare land is counted as built-up">
      <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${ys.length > 2 ? 'lg:grid-cols-3' : ''}`}>
        {ys.map((y) => <Figure key={y} id={d.id} img={d.images.lulc[String(y)]} alt={`Land use / land cover map, ${y}`} caption={`Land use / land cover, ${y}`} />)}
      </div>
    </Section>
  );
}

function LandCoverChange({ d }: { d: CaseStudyDoc }) {
  const ys = d.study.years;
  const pairs = d.transitions;
  const main = pairs.find((t) => t.from_year === ys[0] && t.to_year === ys[ys.length - 1]) ?? pairs[0];
  const area = (y: number, code: number) => d.areas.find((a) => a.year === y && a.class_code === code);
  const net = (code: number) => d.net_change.find((n) => n.from_year === main.from_year && n.to_year === main.to_year && n.class_code === code);
  const built = d.study.classes[0]?.name;
  if (!main) return null;
  return (
    <Section id="cs-change" title="Land-cover change" kicker={`${main.from_year} → ${main.to_year} · net change per class`}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Figure id={d.id} img={d.images.change[`${main.from_year}-${main.to_year}`]} alt={`Land-cover change ${main.from_year} to ${main.to_year}`}
          caption="Pixel-by-pixel comparison of the two land-cover maps." />
        <div className="space-y-4">
          <div className="tt-panel p-4" data-testid="case-study-net">
            <div className="t-label text-ink-3">Net change {main.from_year} → {main.to_year}</div>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
              <span className="t-data text-[26px] font-semibold text-ink">{fmtDelta(net(1)?.delta_km2 ?? 0, 1)} km²</span>
              <span className="text-[13px] text-ink-2">{built} ({fmtDelta(net(1)?.delta_pp ?? 0, 1)} percentage points)</span>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
              Cropland that became built-up, net: <b className="t-data font-medium text-ink">{km2(main.cropland_to_built.net_km2)} km²</b>.
              {' '}Why net figures are used: <ToMethod>Method &amp; limitations</ToMethod>.
            </p>
          </div>
          <Table minWidth={460}>
            <thead><tr><th className={th}>Class</th>{ys.map((y) => <th key={y} className={thr}>{y} km² (%)</th>)}<th className={thr}>Net km²</th><th className={thr}>pp</th></tr></thead>
            <tbody data-testid="case-study-areas">
              {d.study.classes.map((c) => (
                <tr key={c.code}>
                  <td className={td}><span className="mr-2 inline-block h-2.5 w-2.5 rounded-[2px] align-middle" style={{ background: c.color }} />{c.name}</td>
                  {ys.map((y) => { const a = area(y, c.code); return <td key={y} className={tdr}>{a ? `${km2(a.area_km2)} (${pct1(a.percent)})` : '—'}</td>; })}
                  <td className={tdr}>{net(c.code) ? fmtDelta(net(c.code)!.delta_km2, 1) : '—'}</td>
                  <td className={tdr}>{net(c.code) ? fmtDelta(net(c.code)!.delta_pp, 1) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </div>
    </Section>
  );
}

function Population({ d }: { d: CaseStudyDoc }) {
  const ys = d.study.years;
  const rows = d.population;
  const p = (y: number) => rows.find((r) => r.epoch === y);
  const [a, b] = [ys[0], ys[ys.length - 1]];
  const growth = p(a) && p(b) ? (p(b)!.population / p(a)!.population - 1) * 100 : null;
  const bgrowth = p(a)?.builtup_km2_this_study && p(b)?.builtup_km2_this_study ? (p(b)!.builtup_km2_this_study! / p(a)!.builtup_km2_this_study! - 1) * 100 : null;
  if (!rows.length) return null;
  return (
    <Section id="cs-population" title="Population" kicker="GHSL GHS-POP P2023A, summed over the study area">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Table minWidth={380}>
            <thead><tr><th className={th}>Epoch</th><th className={thr}>Residents (million)</th><th className={thr}>GHSL built-up km²</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.epoch} className={ys.includes(r.epoch) ? 'bg-white/[0.03]' : ''}>
                  <td className={td}>{r.epoch}{r.projection && <span className="text-warn"> *</span>}</td>
                  <td className={tdr}>{(r.population / 1e6).toFixed(2)}</td>
                  <td className={tdr}>{r.ghsl_built_km2.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="text-[12.5px] leading-relaxed text-ink-2">
            {growth !== null && <>Population {a} → {b}: <b className="t-data font-medium text-ink">{fmtDelta(growth, 1)}%</b>{bgrowth !== null && <>; built-up area (this study) <b className="t-data font-medium text-ink">{fmtDelta(bgrowth, 1)}%</b></>}. </>}
            <span className="text-warn">*</span> GHSL projection, not a census-based estimate. Two time points describe co-occurring growth, not a cause.
          </p>
        </div>
        <Figure id={d.id} img={d.images.charts.population_vs_builtup} alt="Population versus built-up area" />
      </div>
    </Section>
  );
}

function Heat({ d }: { d: CaseStudyDoc }) {
  const [season, setSeason] = useState<Season>('summer');
  const ys = d.study.years;
  const lst = (y: number) => d.lst_summary.find((r) => r.year === y && r.season === season);
  const cls = (y: number, c: number) => d.lst_per_class.find((r) => r.year === y && r.season === season && r.class_code === c);
  const imgs = season === 'summer' ? d.images.lst_summer : d.images.lst_winter;
  return (
    <Section id="cs-heat" title="Surface heat" kicker="Landsat land surface temperature at the ~10:30 overpass">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="w-full max-w-[420px]">
          <Segmented<Season> label="Season" size="md" value={season} onChange={setSeason}
            options={[{ value: 'summer', label: 'April–June (primary)' }, { value: 'winter', label: 'Nov–Feb (secondary)' }]} />
        </div>
      </div>
      <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${ys.length > 2 ? 'lg:grid-cols-3' : ''}`}>
        {ys.map((y) => <Figure key={y} id={d.id} img={imgs[String(y)]} alt={`Land surface temperature ${SEASON[season]} ${y}`} caption={`${SEASON[season]}, ${y} · mean land ${lst(y) ? degC(lst(y)!.mean_land_c) : '—'}`} />)}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div>
          <h3 className="t-label mb-2 text-ink-3">Mean LST per class · {SEASON[season]}</h3>
          <Table minWidth={360}>
            <thead><tr><th className={th}>Class</th>{ys.map((y) => <th key={y} className={thr}>{y}</th>)}</tr></thead>
            <tbody>
              <tr><td className={`${td} text-ink`}>Study area (land)</td>{ys.map((y) => <td key={y} className={tdr}>{lst(y) ? degC(lst(y)!.mean_land_c) : '—'}</td>)}</tr>
              {d.study.classes.map((c) => (
                <tr key={c.code}><td className={td}>{c.name}</td>{ys.map((y) => <td key={y} className={tdr}>{cls(y, c.code) ? degC(cls(y, c.code)!.mean_c) : '—'}</td>)}</tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-[11.5px] leading-snug text-ink-3">Absolute LST differs between years partly because of each season's weather; compare classes within a year, or use UHI intensity across years.</p>
        </div>
        <div>
          <h3 className="t-label mb-2 text-ink-3">Urban heat island intensity (urban − rural)</h3>
          <PhoneCards testId="case-study-uhi-cards" items={(['summer', 'winter'] as Season[]).flatMap((s) => ys.flatMap((y): PhoneCard[] => {
            const core = d.uhi.find((u) => u.year === y && u.season === s && u.primary);
            const bu = d.uhi.find((u) => u.year === y && u.season === s && !u.primary);
            return core ? [{ key: `${s}-${y}`, title: `${y} · ${seasonShort(s)}`, aside: <IslandBadge result={core.result} />,
              rows: [['Core − ring (primary)', signedC(core.uhi_c)], ['Built-up − rest', bu ? signedC(bu.uhi_c) : '—']] }] : [];
          }))} />
          <div className="hidden sm:block">
            <Table minWidth={460}>
              <thead><tr><th className={th}>Year · season</th><th className={thr}>Core − ring (primary)</th><th className={thr}>Built-up − rest</th><th className={th}>Result</th></tr></thead>
              <tbody data-testid="case-study-uhi">
                {(['summer', 'winter'] as Season[]).flatMap((s) => ys.map((y) => {
                  const core = d.uhi.find((u) => u.year === y && u.season === s && u.primary);
                  const bu = d.uhi.find((u) => u.year === y && u.season === s && !u.primary);
                  if (!core) return null;
                  return (
                    <tr key={`${s}-${y}`}>
                      <td className={td}>{y} · {s === 'summer' ? 'Apr–Jun' : 'Nov–Feb'}</td>
                      <td className={tdr}>{signedC(core.uhi_c)}</td>
                      <td className={tdr}>{bu ? signedC(bu.uhi_c) : '—'}</td>
                      <td className={td}><IslandBadge result={core.result} /></td>
                    </tr>
                  );
                }))}
              </tbody>
            </Table>
          </div>
          <p className="mt-2 text-[11.5px] leading-snug text-ink-3">
            Urban core minus the countryside around it. How the core and ring are drawn, and why the summer value changes sign: <ToMethod>Method &amp; limitations</ToMethod>.
          </p>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Figure id={d.id} img={d.images.uhi_zones[String(ys[ys.length - 1])]} alt="Urban core and rural ring zones" caption={`UHI zones (urban core and rural ring), ${ys[ys.length - 1]}`} />
        <div className="space-y-2">
          <h3 className="t-label text-ink-3">Did land that became built-up warm? (key test)</h3>
          <p className="text-[11.5px] text-ink-3 sm:hidden">{SEASON[season]}</p>
          <PhoneCards testId="case-study-conversion-cards" items={d.conversion.filter((c) => c.season === season).map((c) => ({
            key: `${c.period}-${c.group}`, title: c.group,
            rows: [['Area', `${km2(c.area_km2)} km²`], ['ΔLST', signedC(c.delta_lst_c)], ['Δ normalised', `${fmtDelta(c.delta_z, 2)} SD`]],
          }))} />
          <div className="hidden sm:block">
            <Table minWidth={420}>
              <thead><tr><th className={th}>Group · {SEASON[season]}</th><th className={thr}>km²</th><th className={thr}>ΔLST</th><th className={thr}>Δ normalised</th></tr></thead>
              <tbody>
                {d.conversion.filter((c) => c.season === season).map((c) => (
                  <tr key={`${c.period}-${c.group}`}><td className={td}>{c.group}</td><td className={tdr}>{km2(c.area_km2)}</td><td className={tdr}>{signedC(c.delta_lst_c)}</td><td className={tdr}>{fmtDelta(c.delta_z, 2)} SD</td></tr>
                ))}
              </tbody>
            </Table>
          </div>
          <p className="text-[11.5px] leading-snug text-ink-3">Normalised LST = (LST − study-area mean) / SD for that season and year, so a hotter year as a whole does not count as warming.</p>
        </div>
      </div>
    </Section>
  );
}

function Correlations({ d }: { d: CaseStudyDoc }) {
  const ys = d.study.years;
  const r = (y: number, s: Season, i: 'NDVI' | 'NDBI') => d.correlations.find((c) => c.year === y && c.season === s && c.index === i);
  return (
    <Section id="cs-correlations" title="Temperature vs vegetation and built-up indices" kicker="Pearson r over all land pixels (water excluded)">
      <PhoneCards testId="case-study-correlation-cards" items={(['summer', 'winter'] as Season[]).flatMap((s) => ys.map((y): PhoneCard => ({
        key: `${s}-${y}`, title: `${y} · ${seasonShort(s)}`,
        rows: [['LST vs NDVI r', r(y, s, 'NDVI') ? signedR(r(y, s, 'NDVI')!.r) : '—'], ['LST vs NDBI r', r(y, s, 'NDBI') ? signedR(r(y, s, 'NDBI')!.r) : '—'],
          ['Pixels', r(y, s, 'NDVI')?.n_pixels.toLocaleString('en-US') ?? '—']],
      })))} />
      <div className="hidden sm:block">
        <Table minWidth={460}>
          <thead><tr><th className={th}>Year · season</th><th className={thr}>LST vs NDVI r</th><th className={thr}>LST vs NDBI r</th><th className={thr}>Pixels</th></tr></thead>
          <tbody data-testid="case-study-correlations">
            {(['summer', 'winter'] as Season[]).flatMap((s) => ys.map((y) => (
              <tr key={`${s}-${y}`}>
                <td className={td}>{y} · {s === 'summer' ? 'Apr–Jun' : 'Nov–Feb'}</td>
                <td className={tdr}>{r(y, s, 'NDVI') ? signedR(r(y, s, 'NDVI')!.r) : '—'}</td>
                <td className={tdr}>{r(y, s, 'NDBI') ? signedR(r(y, s, 'NDBI')!.r) : '—'}</td>
                <td className={tdr}>{r(y, s, 'NDVI')?.n_pixels.toLocaleString('en-US') ?? '—'}</td>
              </tr>
            )))}
          </tbody>
        </Table>
      </div>
      <p className="mt-2 text-[11.5px] leading-snug text-ink-3">All p &lt; 0.001 on a 300 m thinned grid (neighbouring 30 m pixels are not independent); with this many pixels the size of r is what matters.</p>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Figure id={d.id} img={d.images.charts.scatter_lst_indices_summer} alt="LST against NDVI and NDBI, April–June" caption="April–June (primary)" />
        <Figure id={d.id} img={d.images.charts.scatter_lst_indices_winter} alt="LST against NDVI and NDBI, November–February" caption="November–February (secondary)" />
      </div>
    </Section>
  );
}

function MethodLimitations({ d }: { d: CaseStudyDoc }) {
  const removed = d.masking.impact.map((m) => Number(m.pixels_removed_entirely) / Number(m.pixels_with_lst_before) * 100);
  return (
    <Section id="cs-method" title="Method & limitations" kicker="What the numbers can and cannot claim">
      <h3 className="t-label mb-2 text-ink-3">How to read these results</h3>
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2" data-testid="case-study-caveats">
        {d.caveats.map((c) => (
          <li key={c.title} className="tt-panel p-4 text-[12.5px] leading-relaxed text-ink-2">
            <b className="block text-[13px] font-semibold text-ink">{c.title}</b>
            <span className="mt-1 block">{c.text}</span>
          </li>
        ))}
      </ul>
      <div className="tt-panel mt-4 p-4 text-[12.5px] leading-relaxed text-ink-2">
        <h3 className="t-label mb-1.5 text-ink-3">Method</h3>
        <p>{d.study.method_summary}</p>
        <p className="mt-2">
          Urban core: pixels whose built-up fraction within 500 m is at least 50 %, in patches of at least 1 km². Rural ring: the nearest
          non-built-up, non-water land of equal area inside the study area (East Delhi, west of the study area, is itself urban). A negative
          value means the city is cooler than its surroundings by day.
        </p>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="tt-panel p-4">
          <h3 className="t-label flex items-center gap-1.5 text-ink-3"><ShieldCheck size={13} /> Classification — agreement with reference labels</h3>
          <ul className="mt-2 space-y-2 text-[12.5px] text-ink-2" data-testid="case-study-accuracy">
            {d.accuracy.map((a) => (
              <li key={a.year}>
                <span className="t-data text-ink">{a.year}</span>: agreement with reference labels <b className="t-data font-medium text-ink">{(a.overall_agreement * 100).toFixed(1)}%</b>,
                kappa <b className="t-data font-medium text-ink">{a.kappa.toFixed(3)}</b> ({a.n_test} held-out points). Most confused: {a.most_confused.map((c) => `${c.a} ↔ ${c.b} (${c.n})`).join('; ')}.
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11.5px] leading-snug text-ink-3">These are agreement with GLC-FCS30D-derived reference labels, not accuracy against ground truth. Independent validation points are prepared but not yet interpreted.</p>
        </div>
        <div className="tt-panel p-4">
          <h3 className="t-label flex items-center gap-1.5 text-ink-3"><Info size={13} /> Temperature masking rule</h3>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">{d.masking.rule}</p>
          {removed.length > 0 && (
            <p className="mt-2 text-[11.5px] leading-snug text-ink-3">
              Pixels that lost their temperature: {Math.min(...removed).toFixed(3)}–{Math.max(...removed).toFixed(3)}% per composite; UHI values moved by at most{' '}
              {Math.max(...d.masking.impact.map((m) => Math.abs(Number(m.uhi_core_ring_after_c) - Number(m.uhi_core_ring_before_c)))).toFixed(2)} °C.
            </p>
          )}
        </div>
      </div>
      <div className="tt-panel mt-4 p-4">
        <h3 className="t-label mb-2 flex items-center gap-1.5 text-ink-3"><AlertTriangle size={13} /> Quality flags</h3>
        <ul className="space-y-1.5 text-[12.5px] leading-relaxed" data-testid="case-study-flags">
          {d.flags.map((f, i) => (
            <li key={i} className="flex gap-2">
              <span className="shrink-0"><Badge tone={f.level === 'WARNING' ? 'bad' : f.level === 'CAUTION' ? 'warn' : 'neutral'}>{f.level}</Badge></span>
              <span className="text-ink-2">{f.message}</span>
            </li>
          ))}
        </ul>
      </div>
      <h3 id="cs-limitations" className="t-label mb-2 mt-6 text-ink-3">Limitations</h3>
      <ul className="tt-panel space-y-2 p-4 text-[12.5px] leading-relaxed text-ink-2" data-testid="case-study-limitations">
        {/* Joined exactly as in results_summary.md: the bold lead carries its own punctuation. */}
        {d.limitations.map((l, i) => <li key={i}><b className="font-medium text-ink">{l.title}</b>{/^[;,.:]/.test(l.text) ? '' : ' '}{l.text}</li>)}
      </ul>
      <div className="mt-4"><DetailedFindings d={d} /></div>
    </Section>
  );
}

// ---------------------------------------------------------------- page
/** A static case study, full page over the map. Needs no backend: everything comes from its exported files. */
export function CaseStudyPage() {
  const id = useUi((s) => s.caseStudy);
  const close = useUi((s) => s.closeCaseStudy);
  const { data, isLoading, isError, refetch } = useCaseStudy(id);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!id) return;
    scroller.current?.scrollTo({ top: 0 });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, close]);
  return (
    <AnimatePresence>
      {id && (
        <motion.div key={id} ref={scroller} role="dialog" aria-modal="true" aria-labelledby="case-study-title" data-testid="case-study-page"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
          className="absolute inset-0 z-40 overflow-y-auto bg-base">
          <div className="mx-auto w-full max-w-[1120px] space-y-10 px-4 pb-16 pt-20 sm:px-6">
            {isLoading && <div className="space-y-4" aria-busy="true" aria-label="Loading the case study"><Skeleton className="h-8 w-2/3 rounded-md" /><Skeleton className="h-24 rounded-md" /><Skeleton className="h-64 rounded-md" /></div>}
            {isError && (
              <div className="tt-panel"><StateView kind="service-unavailable" title="Case study unavailable" onRetry={() => refetch()}>The case study's files could not be loaded.</StateView></div>
            )}
            {data && (
              <>
                <Header d={data} onClose={close} />
                <Headlines d={data} />
                <DownloadCard id={data.id} place="top" />
                <Section id="cs-map" title="Interactive map" kicker="Precomputed tiles from the 30 m analysis rasters">
                  <CaseStudyMap d={data} />
                </Section>
                <LandCoverMaps d={data} />
                <LandCoverChange d={data} />
                <Population d={data} />
                <Heat d={data} />
                <Correlations d={data} />
                <MethodLimitations d={data} />
                <DownloadCard id={data.id} place="bottom" />
                <footer className="border-t border-line pt-4 text-[11.5px] leading-relaxed text-ink-4">
                  Precomputed case study generated {data.generated_utc.slice(0, 10)} by the TerraTrace analysis pipeline v{data.pipeline_version} from
                  precomputed tables (Landsat Collection 2 via Google Earth Engine; GLC-FCS30D, ESA WorldCover, Dynamic World labels; GHSL population).
                  It is not a live TerraTrace analysis and is not counted in the homepage totals.
                </footer>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
