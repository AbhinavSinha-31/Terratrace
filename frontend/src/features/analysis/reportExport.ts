/**
 * Downloadable EVENT BRIEF: one self-contained HTML file (styles inline, imagery embedded as data URIs) that opens
 * offline in any browser and prints cleanly to PDF. It carries exactly what the on-screen brief shows — measured
 * values of a READY live analysis — and never fills a gap: an image that cannot be fetched is labelled as missing.
 */

export interface ReportImage { caption: string; src: string | null; alt: string; missing: string }

export interface ReportContent {
  eventId: string;
  generated: string;
  aoiName: string;
  images: ReportImage[];
  rows: [string, string][];
  paragraphs: string[];
  evidence: { label: string; state: boolean | null | undefined }[];
  footer: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Fetch an image (following the backend's redirect to Earth Engine) as a data URI; null when it cannot be read. */
async function toDataUri(src: string | null): Promise<string | null> {
  if (!src) return null;
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function render(c: ReportContent, images: (string | null)[]): string {
  const figs = c.images.map((im, i) => `
      <figure>
        ${images[i] ? `<img src="${images[i]}" alt="${esc(im.alt)}">` : `<div class="noimg">${esc(im.missing)}</div>`}
        <figcaption>${esc(im.caption)}</figcaption>
      </figure>`).join('');
  const rows = c.rows.map(([k, v]) => `<div class="cell"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
  const paras = c.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
  const ev = c.evidence.map((e) => `<li>${e.state ? '✓' : e.state === false ? '✗' : '○'} ${esc(e.label)}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TERRATRACE event brief #${esc(c.eventId)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f4f5f2; color: #16191a; font: 13px/1.55 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 820px; margin: 24px auto; background: #fff; padding: 28px 32px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; border-bottom: 1px solid #dde0dc; padding-bottom: 18px; }
  .brand { font: 700 18px/1 "Space Grotesk", system-ui, sans-serif; letter-spacing: .12em; }
  .brand small { display: block; margin-top: 6px; font: 500 10px/1 system-ui, sans-serif; letter-spacing: .14em; color: #5d6662; }
  .meta { text-align: right; }
  .label, .k { font-size: 9.5px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: #5d6662; }
  .id { font: 500 14px/1.4 "JetBrains Mono", ui-monospace, monospace; margin-top: 4px; }
  .small { font-size: 11px; color: #5d6662; }
  section { margin-top: 22px; }
  .figs { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  figure { margin: 0; }
  figure img, .noimg { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 6px; }
  .noimg { display: flex; align-items: center; justify-content: center; background: #eef0ec; color: #5d6662; font-size: 11px; }
  figcaption { margin-top: 6px; font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: #5d6662; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: #dde0dc; border: 1px solid #dde0dc; border-radius: 6px; overflow: hidden; }
  .cell { background: #fff; padding: 9px 12px; }
  .v { margin-top: 3px; font-size: 12px; }
  p { margin: 0 0 8px; font-size: 12.5px; color: #2b302e; }
  ul { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 12px; }
  footer { margin-top: 24px; border-top: 1px solid #dde0dc; padding-top: 14px; font-size: 10.5px; color: #5d6662; }
  @media (max-width: 640px) { main { margin: 0; border-radius: 0; padding: 20px 16px; } .figs, ul { grid-template-columns: 1fr; } .grid { grid-template-columns: 1fr 1fr; } }
  @media print { body { background: #fff; } main { margin: 0; max-width: none; box-shadow: none; padding: 0; } section, figure, .grid { break-inside: avoid; } }
</style>
</head>
<body>
<main>
  <header>
    <div class="brand">TERRATRACE<small>Forest-change intelligence</small></div>
    <div class="meta">
      <div class="label">Event brief</div>
      <div class="id">#${esc(c.eventId)}</div>
      <div class="small">${esc(c.aoiName)}</div>
      <div class="small">Generated ${esc(c.generated)} · Google Earth Engine analysis</div>
    </div>
  </header>
  <section class="figs">${figs}</section>
  <section class="grid">${rows}</section>
  <section><div class="label" style="margin-bottom:8px">TERRATRACE analysis</div>${paras}</section>
  <section><div class="label" style="margin-bottom:8px">Evidence</div><ul>${ev}</ul></section>
  <footer>${esc(c.footer)}</footer>
</main>
</body>
</html>
`;
}

/** Build the report file and hand it to the browser as a download. */
export async function downloadReport(c: ReportContent): Promise<void> {
  const images = await Promise.all(c.images.map((im) => toDataUri(im.src)));
  const blob = new Blob([render(c, images)], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `terratrace-event-${c.eventId.replace(/[^\w.-]+/g, '_')}-${c.generated}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
