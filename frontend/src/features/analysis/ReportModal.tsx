import { useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { apiUrl } from '../../data/client';
import { useCurrentBundle, useExplanation, useSelectedAoi } from '../../data/queries';
import { useUi } from '../../state/store';
import { buildFacts } from '../../explain/facts';
import { fmtCoord, fmtDelta, fmtHa, fmtPct, landCoverLabel, severityLabel } from '../../lib/format';
import { Button, Modal, TerratraceLogo } from '../../design';
import { evidenceChips } from './Briefing';
import { downloadReport } from './reportExport';

/**
 * One tile of a backend-provided XYZ template (the READY analysis' own Earth Engine composite) around a point.
 * The template comes from the backend; only the tile index is computed here. No template -> no image.
 */
function tileFrom(template: string | undefined, lon: number, lat: number) {
  if (!template) return null;
  const z = 13, n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return apiUrl(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
}

/** EVENT BRIEF: downloadable as a self-contained HTML file, or printable (browser print → PDF). */
export function ReportModal() {
  const id = useUi((s) => s.reportEventId);
  const close = () => useUi.getState().openReport(null);
  // Reports exist only for events of a READY live analysis.
  const analysis = useCurrentBundle();
  const aoi = useSelectedAoi();
  const ev = analysis?.events.features.find((f) => f.id === id);
  // The briefing comes ONLY from the backend explainer (same query/cache as the Briefing panel).
  const facts = useMemo(() => (ev && aoi ? buildFacts(ev.properties, aoi) : null), [ev, aoi]);
  const briefing = useExplanation(facts, !!id && !!facts);
  const text = briefing.data?.text
    ?? (briefing.isError ? 'The briefing is unavailable right now. The measurements below are unaffected.' : 'Preparing the briefing…');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);

  if (!ev || !aoi || !analysis) return null;
  const p = ev.properties;
  const generated = new Date().toISOString().slice(0, 10);
  // One set of content for the on-screen brief, print and the downloaded file.
  const images = [p.year_from, p.year_to].map((y, i) => {
    const layer = analysis.layers.imagery.find((l) => l.year === y && !l.reference);
    return {
      year: y,
      src: tileFrom(layer?.tiles[0], p.centroid[0], p.centroid[1]),
      alt: layer ? `${layer.label} around the event` : '',
      caption: `${i === 0 ? 'Before' : 'After'} · ${y}${layer ? ` · ${layer.sensor ?? 'composite'}` : ''}`,
    };
  });
  const rows: [string, string][] = [
    ['Change type', p.change_label],
    ['Affected area', `${fmtHa(p.area_ha)} ha (${p.area_km2.toFixed(2)} km²)`],
    ['Period', `${p.year_from} → ${p.year_to}`],
    ['NDVI change', `${fmtDelta(p.indices.ndvi.change)} (${p.indices.ndvi.before.toFixed(2)} → ${p.indices.ndvi.after.toFixed(2)})`],
    ['NBR change', `${fmtDelta(p.indices.nbr.change)} (${p.indices.nbr.before.toFixed(2)} → ${p.indices.nbr.after.toFixed(2)})`],
    ['Tree probability', `${fmtDelta(p.indices.tree_prob.change)}`],
    ['Land cover', `${landCoverLabel(p.land_cover.before)} → ${landCoverLabel(p.land_cover.after)}`],
    ['Persistence', p.persistence === null ? 'pending' : fmtPct(p.persistence)],
    ['Evidence · severity', `${p.confidence.class} (${Math.round(p.confidence.score * 100)}) · ${severityLabel[p.severity.class]}`],
  ];
  const paragraphs = text.split(/\n\s*\n/);
  const evidence = evidenceChips(p);
  const footer = `${aoi.name} · centroid ${fmtCoord(p.centroid[0], p.centroid[1])} · ${analysis.summary.method.change_rule.replace(/\.+$/, '')}. Evidence score is a weighted agreement of measured checks, not a calibrated probability. Measurements indicate that a change occurred, not its cause. Imagery: the analysis' own Earth Engine composites (contains modified Copernicus Sentinel data / USGS Landsat).`;
  // The file is offered only once the briefing text is final (never a "Preparing…" placeholder in a download).
  const briefingSettled = !briefing.isLoading && !briefing.isFetching;

  const download = async () => {
    setDownloading(true);
    setDownloadError(false);
    try {
      await downloadReport({
        eventId: p.id, generated, aoiName: aoi.name, rows, paragraphs, evidence, footer,
        images: images.map((im) => ({ caption: im.caption, src: im.src, alt: im.alt, missing: `No imagery for ${im.year}` })),
      });
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal open={!!id} onClose={close} title={`Event brief · ${p.id}`} eyebrow="Export" width={820} className="tt-print"
      footer={<>
        {downloadError && <span className="mr-auto text-[11.5px] text-bad">The report could not be created. Try again.</span>}
        <Button variant="ghost" onClick={close}>Close</Button>
        <Button variant="ghost" icon={<Printer size={15} />} onClick={() => window.print()}>Print / PDF</Button>
        <Button variant="brand" icon={<Download size={15} />} onClick={download} disabled={downloading || !briefingSettled} data-testid="download-report">
          {downloading ? 'Preparing…' : 'Download report'}
        </Button>
      </>}>
      <article className="space-y-6 px-7 py-6 print:text-black">
        <header className="flex items-start justify-between gap-6 border-b border-line pb-5">
          <TerratraceLogo size="md" />
          <div className="text-right">
            <div className="t-label text-ink-3">Event brief</div>
            <div className="t-data mt-1 text-[14px] text-ink">#{p.id}</div>
            <div className="text-[11px] text-ink-3">Generated {generated} · Google Earth Engine analysis</div>
          </div>
        </header>
        <section className="grid grid-cols-2 gap-4">
          {images.map((im) => (
            <figure key={im.year}>
              {im.src
                ? <img src={im.src} alt={im.alt} className="aspect-[4/3] w-full rounded-md object-cover" />
                : <div className="flex aspect-[4/3] w-full items-center justify-center rounded-md bg-white/[0.03] text-[11px] text-ink-3">No imagery for {im.year}</div>}
              <figcaption className="t-label mt-1.5 text-ink-3">{im.caption}</figcaption>
            </figure>
          ))}
        </section>
        <section className="grid grid-cols-3 gap-px overflow-hidden rounded-md bg-line text-[12px]">
          {rows.map(([k, v]) => (
            <div key={k} className="bg-surface px-3 py-2.5"><div className="t-label !text-[9px] text-ink-3">{k}</div><div className="mt-1 text-ink">{v}</div></div>
          ))}
        </section>
        <section>
          <div className="t-label mb-2 text-ink-3">TERRATRACE analysis</div>
          {paragraphs.map((para, i) => <p key={i} className="mb-2 text-[12.5px] leading-relaxed text-ink-2">{para}</p>)}
        </section>
        <section>
          <div className="t-label mb-2 text-ink-3">Evidence</div>
          <ul className="grid grid-cols-2 gap-1 text-[12px] text-ink-2">
            {evidence.map((c) => <li key={c.label}>{c.state ? '✓' : c.state === false ? '✗' : '○'} {c.label}</li>)}
          </ul>
        </section>
        <footer className="border-t border-line pt-4 text-[10.5px] leading-relaxed text-ink-3">{footer}</footer>
      </article>
    </Modal>
  );
}
