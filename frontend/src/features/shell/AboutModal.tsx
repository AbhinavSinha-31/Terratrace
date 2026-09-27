import { useHealth } from '../../data/queries';
import { useUi } from '../../state/store';
import { Kbd, Modal, TerratraceLogo, TerratraceMark } from '../../design';
import { ERAS } from '../../lib/time';

export function AboutModal() {
  const open = useUi((s) => s.aboutOpen);
  const { data: h } = useHealth();
  const close = () => useUi.getState().setAboutOpen(false);
  const status = (s?: string) => (s === 'ready' ? 'Operational' : s === undefined ? '—' : 'Unavailable');
  return (
    <Modal open={open} onClose={close} title="About TERRATRACE" eyebrow="Earth observation intelligence" width={760}>
      <div className="space-y-7 px-7 py-6">
        <div className="flex items-center gap-5">
          <TerratraceLogo size="lg" />
        </div>
        <p className="max-w-[62ch] text-[13.5px] leading-relaxed text-ink-2">
          TERRATRACE is an explainable satellite forest-change intelligence platform. It answers <b className="text-ink">what</b> changed, <b className="text-ink">where</b>,{' '}
          <b className="text-ink">when</b> and <b className="text-ink">how much</b> — and shows the measured evidence behind every detection. It does not attribute causes to people or organisations.
        </p>

        <section className="grid gap-px overflow-hidden rounded-md bg-line sm:grid-cols-4">
          {[
            ['System', h?.status === 'operational' ? 'Operational' : 'Degraded'],
            ['Data', 'Landsat · Sentinel-2 · Dynamic World'],
            ['Analysis', h?.engine ?? 'TERRATRACE ENGINE'],
            ['Version', h?.version ?? '0.1.0'],
          ].map(([k, v]) => (
            <div key={k} className="bg-surface px-4 py-3"><div className="t-label text-ink-3">{k}</div><div className="mt-1 text-[12.5px] text-ink">{v}</div></div>
          ))}
        </section>

        <section>
          <h3 className="t-label mb-3 text-ink-3">Pipeline</h3>
          <ol className="grid gap-2 text-[12px] text-ink-2 sm:grid-cols-2">
            {['Cloud-masked annual / multi-year composites (Cloud Score+, Landsat QA)', 'Forest mask: Dynamic World trees ≥ 0.5 ∧ NDVI ≥ 0.6 (Landsat NDVI proxy in the 1984–2015 era); unobserved pixels stay no-data', 'Change: forest loss with ΔNDVI / ΔNBR and tree-probability drop, persistence check', 'Minimum mapping unit 2 ha → vectorised events → area in ha / km²', 'Severity (USGS dNBR for burns) and a weighted evidence score', 'Explanation from measured facts only, with a numeric fact-check'].map((s, i) => (
              <li key={s} className="flex gap-3"><span className="t-data text-accent">{String(i + 1).padStart(2, '0')}</span>{s}</li>
            ))}
          </ol>
        </section>

        <section>
          <h3 className="t-label mb-3 text-ink-3">Data sources & services</h3>
          <ul className="space-y-2 text-[12px] text-ink-2">
            {ERAS.map((e) => <li key={e.key}><b className="text-ink">{e.name}</b> — {e.note}</li>)}
            <li><b className="text-ink">Hansen et al. Global Forest Change</b> — tree cover 2000 & loss year, used as an independent reference (CC BY 4.0)</li>
            <li><b className="text-ink">Sentinel-2 cloudless (EOX)</b> — annual basemap mosaics (CC BY-NC-SA 4.0 / CC BY 4.0 for 2016)</li>
          </ul>
          <div className="mt-4 grid gap-2 text-[11.5px] sm:grid-cols-3">
            {[
              ['Live analysis', h && !h.backend ? 'Unavailable' : status(h?.analysis.status)],
              ['AI briefings', h?.explainer.status === 'ready' ? `Operational · ${h.explainer_model}` : 'Deterministic briefing (completed analyses only)'],
              ['Place search', status(h?.geocoder.status)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-md px-3 py-2 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"><div className="text-ink-3">{k}</div><div className="text-ink">{v}</div></div>
            ))}
          </div>
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
            It never simulates scientific results: every metric, event and explanation comes from a completed live Google Earth Engine analysis. Without one, only real imagery and the area's geometry are shown.
          </p>
        </footer>
      </div>
    </Modal>
  );
}
