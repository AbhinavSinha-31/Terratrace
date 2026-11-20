import { useHealth } from '../../data/queries';
import { useUi } from '../../state/store';
import { Kbd, Modal, TerratraceLogo, TerratraceMark } from '../../design';
import { ERAS } from '../../lib/time';

const FOREST_STEPS = [
  'Cloud-masked annual composites (Cloud Score+, Landsat QA)',
  'Forest mask (2016 onward): Dynamic World trees ≥ 0.5 ∧ leaf-on NDVI ≥ 0.6; before 2016 forest figures are withheld (imagery only)',
  'Change: forest loss with ΔNDVI / ΔNBR and a tree-probability drop; minimum mapping unit 2 ha',
  'Severity (USGS dNBR for burns) and a weighted evidence score',
];
const URBAN_STEPS = [
  'Land cover from Dynamic World (from 2016) in six classes: Forest, Cropland, Built-up, Water, Barren, Grass/Shrub',
  'Urban expansion: change in built-up area between two scanned years of the same area',
  'Land surface temperature from Landsat 8/9 (from 2013), cloud-masked, in °C',
  'Surface urban heat island: built-up minus all other land, and minus vegetated land',
];

/** Only what this repository actually uses (frontend/package.json, backend/requirements.txt, the Earth Engine dataset
 *  ids in backend/app/providers/earth_engine, render.yaml, frontend/vercel.json). Keep in step when a tool is added or dropped. */
const BUILT_WITH: { group: string; items: string[] }[] = [
  { group: 'Frontend', items: ['React', 'TypeScript', 'Vite', 'Tailwind CSS', 'MapLibre GL JS', 'Apache ECharts', 'TanStack Query', 'Zustand', 'Framer Motion', 'Lucide icons', 'React Markdown'] },
  { group: 'Backend', items: ['Python', 'FastAPI', 'Uvicorn', 'Pydantic', 'HTTPX', 'PyJWT', 'OpenStreetMap Nominatim'] },
  { group: 'Satellite data', items: ['Google Earth Engine', 'Landsat 5 · 7 · 8 · 9', 'Sentinel-2', 'Cloud Score+', 'Dynamic World', 'ESA WorldCover', 'ESA CCI Biomass', 'Hansen Global Forest Change', 'Copernicus DEM GLO-30', 'Sentinel-2 cloudless (EOX)', 'Esri World Imagery'] },
  { group: 'AI', items: ['Google Gemini'] },
  { group: 'Database & auth', items: ['Supabase', 'PostgreSQL', 'Supabase Auth', 'Supabase Storage'] },
  { group: 'Hosting', items: ['Vercel', 'Render'] },
];

function BuiltWith() {
  return (
    <section data-testid="about-built-with">
      <h3 className="t-label mb-3 text-ink-3">Built with</h3>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {BUILT_WITH.map(({ group, items }) => (
          <div key={group}>
            <div className="mb-2 text-[11.5px] font-medium text-ink-2">{group}</div>
            <ul className="flex flex-wrap gap-1.5">
              {items.map((name) => (
                <li key={name} className="rounded-full px-2.5 py-1 text-[11.5px] leading-none text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.12)]">{name}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

export function AboutModal() {
  const open = useUi((s) => s.aboutOpen);
  const { data: h } = useHealth();
  const close = () => useUi.getState().setAboutOpen(false);
  const status = (s?: string) => (s === 'ready' ? 'Operational' : s === undefined ? '—' : 'Unavailable');
  return (
    <Modal open={open} onClose={close} title="About TERRATRACE" eyebrow="Forests · cities · land cover · evidence" width={760}>
      <div className="space-y-7 px-7 py-6">
        <div className="flex items-center gap-5">
          <TerratraceLogo size="lg" />
        </div>
        <p className="max-w-[62ch] text-[13.5px] leading-relaxed text-ink-2">
          TERRATRACE shows how the land is changing — forest loss and gain, and the growth of cities — from decades of
          satellite archives. It answers <b className="text-ink">what</b> changed, <b className="text-ink">where</b>,{' '}
          <b className="text-ink">when</b> and <b className="text-ink">how much</b>, and shows the measured evidence behind every figure. It does not attribute causes to people or organisations.
        </p>

        <section className="grid gap-px overflow-hidden rounded-md bg-line sm:grid-cols-4">
          {[
            ['System', h?.status === 'operational' ? 'Operational' : 'Degraded'],
            ['Data', 'Landsat · Sentinel-2 · Dynamic World · ESA CCI'],
            ['Processing', 'Google Earth Engine'],
            ['Version', h?.version ?? '0.1.0'],
          ].map(([k, v]) => (
            <div key={k} className="bg-surface px-4 py-3"><div className="t-label text-ink-3">{k}</div><div className="mt-1 text-[12.5px] text-ink">{v}</div></div>
          ))}
        </section>

        <section className="grid gap-6 sm:grid-cols-2">
          {([['Forests', FOREST_STEPS], ['Cities & land cover', URBAN_STEPS]] as const).map(([title, steps]) => (
            <div key={title}>
              <h3 className="t-label mb-3 text-ink-3">{title}</h3>
              <ol className="space-y-2 text-[12px] text-ink-2">
                {steps.map((s, i) => <li key={s} className="flex gap-3"><span className="t-data text-accent">{String(i + 1).padStart(2, '0')}</span>{s}</li>)}
              </ol>
            </div>
          ))}
        </section>

        <section>
          <h3 className="t-label mb-3 text-ink-3">Data sources & services</h3>
          <ul className="space-y-2 text-[12px] text-ink-2">
            {ERAS.map((e) => <li key={e.key}><b className="text-ink">{e.name}</b> — {e.note}</li>)}
            <li><b className="text-ink">Landsat 8/9 Collection 2 surface temperature</b> — land surface temperature and urban heat islands (from 2013)</li>
            <li><b className="text-ink">ESA CCI Biomass v6.0</b> — above-ground carbon estimates (2007, 2010, 2015–2022)</li>
            <li><b className="text-ink">Hansen et al. Global Forest Change</b> — tree cover 2000 & loss year, used as an independent reference (CC BY 4.0)</li>
            <li><b className="text-ink">Sentinel-2 cloudless (EOX)</b> — annual basemap mosaics (CC BY-NC-SA 4.0 / CC BY 4.0 for 2016)</li>
          </ul>
          <div className="mt-4 grid gap-2 text-[11.5px] sm:grid-cols-3">
            {[
              ['Analysis service', h && !h.backend ? 'Unavailable' : status(h?.analysis.status)],
              ['AI briefings', h?.explainer.status === 'ready' ? `Operational · ${h.explainer_model}` : 'Deterministic briefing (published analyses only)'],
              ['Place search', status(h?.geocoder.status)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-md px-3 py-2 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"><div className="text-ink-3">{k}</div><div className="text-ink">{v}</div></div>
            ))}
          </div>
        </section>

        <BuiltWith />

        <section data-testid="about-privacy">
          <h3 className="t-label mb-3 text-ink-3">Privacy</h3>
          <p className="max-w-[66ch] text-[12.5px] leading-relaxed text-ink-2">
            The Ask TerraTrace chat uses Google Gemini&apos;s free tier; Google may use what you type to improve its products, and human reviewers may read it. Don&apos;t enter personal information. AI explanations can be wrong.
          </p>
        </section>

        <section>
          <h3 className="t-label mb-3 text-ink-3">Keyboard</h3>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-ink-2">
            <span><Kbd>←</Kbd> <Kbd>→</Kbd> composite year</span>
            <span><Kbd>Space</Kbd> play history</span>
            <span><Kbd>C</Kbd> before / after</span>
            <span><Kbd>/</Kbd> search</span>
            <span><Kbd>Esc</Kbd> close / cancel</span>
            <span><Kbd>PgDn</Kbd> next presentation step</span>
          </div>
        </section>

        <footer className="flex items-start gap-3 border-t border-line pt-5 text-[11px] leading-relaxed text-ink-3">
          <TerratraceMark size={16} accent={false} />
          <p>
            TERRATRACE is a university innovation-expo prototype. It is not affiliated with, endorsed by or operated for any government agency, space agency or intergovernmental organisation.
            It never simulates scientific results: every metric, event and explanation comes from a completed Google Earth Engine analysis of archived satellite data. Without one, only real imagery and the area&apos;s geometry are shown.
          </p>
        </footer>
      </div>
    </Modal>
  );
}
