import { useEffect, useState } from 'react';
import { Check, Download, FileText, Link2, Table2 } from 'lucide-react';
import { buttonClass } from '../../design';
import { caseStudyAsset, useCaseStudyDownloads } from './data';

/** Decimal units, like the export script's own report (2,153,200 bytes = 2.2 MB). */
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e3))} KB`;

/** The page's own address, so a copied link opens this case study (it works once the site is deployed). */
const pageLink = (id: string) => `${window.location.origin}${window.location.pathname}#/case-study/${encodeURIComponent(id)}`;

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (http:// origin, older browser): the selection fallback.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/**
 * "Download report": the PDF (main) and the CSV data (secondary), with their real sizes from downloads.json, plus a
 * copyable link to this page. Rendered after the key findings and again at the bottom of the page. Nothing is shown
 * if the files' manifest is missing — a download is never offered for a file that is not there.
 */
export function DownloadCard({ id, place }: { id: string; place: 'top' | 'bottom' }) {
  const { data } = useCaseStudyDownloads(id);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 2200);
    return () => window.clearTimeout(t);
  }, [copied]);
  if (!data) return null;
  return (
    <section aria-labelledby={`cs-download-${place}`} className="tt-panel p-4" data-testid={`case-study-download-${place}`}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-accent/12 text-accent"><FileText size={18} /></span>
          <div className="min-w-0">
            <h2 id={`cs-download-${place}`} className="text-[14px] font-semibold text-ink">Download report</h2>
            <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
              A4 PDF, {data.pdf.pages} pages, with the maps, tables, method and limitations · CSV tables with a README of every column.
              <span className="text-warn"> Preliminary results — not peer reviewed.</span>
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_auto_auto] lg:shrink-0">
          <a href={caseStudyAsset(id, data.pdf.file)} download={data.pdf.file} className={buttonClass('brand', 'md')} data-testid="download-pdf">
            <Download size={15} className="-ml-0.5 shrink-0" /> Download PDF report ({mb(data.pdf.bytes)})
          </a>
          <a href={caseStudyAsset(id, data.data.file)} download={data.data.file} className={buttonClass('secondary', 'md')} data-testid="download-data">
            <Table2 size={15} className="-ml-0.5 shrink-0" /> Download data (CSV, {kb(data.data.bytes)})
          </a>
          <button type="button" className={buttonClass('ghost', 'md')} onClick={async () => setCopied((await copy(pageLink(id))) ? 'ok' : 'failed')}
            aria-live="polite" data-testid="copy-link">
            {copied === 'ok' ? <Check size={15} className="-ml-0.5 shrink-0 text-live" /> : <Link2 size={15} className="-ml-0.5 shrink-0" />}
            {copied === 'ok' ? 'Link copied' : copied === 'failed' ? 'Copy failed' : 'Copy link'}
          </button>
        </div>
      </div>
    </section>
  );
}
