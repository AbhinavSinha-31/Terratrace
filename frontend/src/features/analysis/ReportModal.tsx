import { useMemo } from 'react';
import { Printer } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentBundle, useSelectedAoi } from '../../data/queries';
import { useUi } from '../../state/store';
import type { Explanation } from '../../data/contracts';
import { buildFacts } from '../../explain/facts';
import { groundedNarrative } from '../../explain/narrative';
import { fmtCoord, fmtDelta, fmtHa, fmtPct, landCoverLabel, severityLabel } from '../../lib/format';
import { Button, Modal, TerratraceLogo } from '../../design';
import { evidenceChips } from './Briefing';

function tile(lon: number, lat: number, year: number) {
  const z = 13, n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  const layer = year >= 2017 ? `s2cloudless-${year}_3857` : 's2cloudless_3857';
  return `https://tiles.maps.eox.at/wmts/1.0.0/${layer}/default/g/${z}/${y}/${x}.jpg`;
}

/** Printable EVENT BRIEF (browser print → PDF). */
export function ReportModal() {
  const id = useUi((s) => s.reportEventId);
  const close = () => useUi.getState().openReport(null);
  // Reports exist only for events of a READY live analysis.
  const analysis = useCurrentBundle();
  const aoi = useSelectedAoi();
  const qc = useQueryClient();
  const ev = analysis?.events.features.find((f) => f.id === id);
  const text = useMemo(() => {
    if (!ev || !aoi) return '';
    const cached = qc.getQueryData<Explanation>(['explanation', ev.id]);
    return cached?.text ?? groundedNarrative(buildFacts(ev.properties, aoi));
  }, [ev, aoi, qc]);

  if (!ev || !aoi || !analysis) return null;
  const p = ev.properties;

  return (
    <Modal open={!!id} onClose={close} title={`Event brief · ${p.id}`} eyebrow="Export" width={820} className="tt-print"
      footer={<><Button variant="ghost" onClick={close}>Close</Button><Button variant="brand" icon={<Printer size={15} />} onClick={() => window.print()}>Print / save as PDF</Button></>}>
      <article className="space-y-6 px-7 py-6 print:text-black">
        <header className="flex items-start justify-between gap-6 border-b border-line pb-5">
          <TerratraceLogo size="md" />
          <div className="text-right">
            <div className="t-label text-ink-3">Event brief</div>
            <div className="t-data mt-1 text-[14px] text-ink">#{p.id}</div>
            <div className="text-[11px] text-ink-3">Generated {new Date().toISOString().slice(0, 10)} · Live Earth Engine analysis</div>
          </div>
        </header>
        <section className="grid grid-cols-2 gap-4">
          {[p.year_from, p.year_to].map((y, i) => (
            <figure key={y}>
              <img src={tile(p.centroid[0], p.centroid[1], y)} alt={`Sentinel-2 cloudless imagery ${y} around the event`} className="aspect-[4/3] w-full rounded-md object-cover" />
              <figcaption className="t-label mt-1.5 text-ink-3">{i === 0 ? 'Before' : 'After'} · {y}{y < 2016 ? ' (no EOX mosaic — 2016 shown)' : ''}</figcaption>
            </figure>
          ))}
        </section>
        <section className="grid grid-cols-3 gap-px overflow-hidden rounded-md bg-line text-[12px]">
          {[
            ['Change type', p.change_label],
            ['Affected area', `${fmtHa(p.area_ha)} ha (${p.area_km2.toFixed(2)} km²)`],
            ['Period', `${p.year_from} → ${p.year_to}`],
            ['NDVI change', `${fmtDelta(p.indices.ndvi.change)} (${p.indices.ndvi.before.toFixed(2)} → ${p.indices.ndvi.after.toFixed(2)})`],
            ['NBR change', `${fmtDelta(p.indices.nbr.change)} (${p.indices.nbr.before.toFixed(2)} → ${p.indices.nbr.after.toFixed(2)})`],
            ['Tree probability', `${fmtDelta(p.indices.tree_prob.change)}`],
            ['Land cover', `${landCoverLabel(p.land_cover.before)} → ${landCoverLabel(p.land_cover.after)}`],
            ['Persistence', p.persistence === null ? 'pending' : fmtPct(p.persistence)],
            ['Evidence · severity', `${p.confidence.class} (${Math.round(p.confidence.score * 100)}) · ${severityLabel[p.severity.class]}`],
          ].map(([k, v]) => (
            <div key={k} className="bg-surface px-3 py-2.5"><div className="t-label !text-[9px] text-ink-3">{k}</div><div className="mt-1 text-ink">{v}</div></div>
          ))}
        </section>
        <section>
          <div className="t-label mb-2 text-ink-3">TERRATRACE analysis</div>
          {text.split(/\n\s*\n/).map((para, i) => <p key={i} className="mb-2 text-[12.5px] leading-relaxed text-ink-2">{para}</p>)}
        </section>
        <section>
          <div className="t-label mb-2 text-ink-3">Evidence</div>
          <ul className="grid grid-cols-2 gap-1 text-[12px] text-ink-2">
            {evidenceChips(p).map((c) => <li key={c.label}>{c.state ? '✓' : c.state === false ? '✗' : '○'} {c.label}</li>)}
          </ul>
        </section>
        <footer className="border-t border-line pt-4 text-[10.5px] leading-relaxed text-ink-3">
          {aoi.name} · centroid {fmtCoord(p.centroid[0], p.centroid[1])} · {analysis.summary.method.change_rule}. Evidence score is a weighted agreement of measured checks, not a calibrated probability. Measurements indicate that a change occurred, not its cause. Imagery: Sentinel-2 cloudless by EOX (contains modified Copernicus Sentinel data).
        </footer>
      </article>
    </Modal>
  );
}
