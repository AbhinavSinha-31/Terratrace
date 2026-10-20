import { motion } from 'framer-motion';
import { BookOpenText, ChevronRight } from 'lucide-react';
import { useUi } from '../../state/store';
import { fmtKm2 } from '../../lib/format';
import { useCaseStudy, yearSpan, type CaseStudyMeta } from './data';

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Featured card for a STATIC case study. It has no live-analysis status and needs no backend: everything it shows is
 * in the case study's own files. It is never part of the homepage "Detected change" totals (those count only the
 * backend's stored live results).
 */
export function CaseStudyCard({ meta, index, cell }: { meta: CaseStudyMeta; index: number; cell: string }) {
  const open = useUi((s) => s.openCaseStudy);
  const { data } = useCaseStudy(meta.id);
  const years = data ? yearSpan(data.study.years) : '';
  return (
    <motion.button
      initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + index * 0.07, duration: 0.5, ease: EASE }}
      onClick={() => open(meta.id)}
      data-testid="case-study-card" data-case-study={meta.id}
      className={`tt-card group relative flex flex-col overflow-hidden rounded-lg text-left ${cell}`}
      aria-label={`Open case study: ${meta.name}`}
    >
      <div className="relative h-[clamp(76px,10.5vh,124px)] overflow-hidden bg-[#0b0f12]">
        <img src={meta.thumbnail_url} alt="" loading="lazy"
          className="h-full w-full scale-105 object-cover transition duration-700 ease-out group-hover:scale-[1.12]" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/5 via-transparent to-[#0b0f12]" />
        <div className="absolute left-3 top-3 flex gap-1.5">
          <span className="tt-img-badge">{meta.country}</span>
          <span className="tt-img-badge">{meta.region}</span>
        </div>
      </div>
      <div className="flex flex-1 flex-col px-4 pb-3.5 pt-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[15px] font-semibold leading-snug tracking-[-0.005em] text-ink" title={meta.name}>{meta.name}</div>
            <div className="mt-0.5 truncate text-[12px] text-ink-3">{meta.subtitle}</div>
          </div>
          <ChevronRight size={18} className="mt-0.5 shrink-0 text-ink-3 transition group-hover:translate-x-1 group-hover:text-accent" />
        </div>
        <div className="mt-[clamp(8px,1.4vh,14px)] grid grid-cols-2 divide-x divide-line">
          <div className="min-w-0 pr-3">
            <div className="t-data truncate text-[14px] font-medium text-ink">{data ? `${fmtKm2(data.study.area_km2)} km²` : '—'}</div>
            <div className="text-[10.5px] text-ink-3">study area</div>
          </div>
          <div className="min-w-0 px-3">
            <div className="t-data truncate text-[14px] font-medium text-ink">{years || '—'}</div>
            <div className="text-[10.5px] text-ink-3">study years</div>
          </div>
        </div>
        {/* Precomputed results: a fixed label instead of a live-analysis status. */}
        <div className="mt-2.5 flex min-w-0 items-center gap-2 border-t border-line pt-2" data-testid="case-study-badge">
          <BookOpenText size={13} className="shrink-0 text-accent" />
          <span className="t-data min-w-0 text-[12.5px] font-medium leading-tight text-accent">Case study · Landsat{years ? ` ${years}` : ''}</span>
        </div>
      </div>
    </motion.button>
  );
}
