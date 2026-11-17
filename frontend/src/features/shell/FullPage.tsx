import { useEffect, useRef, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';

/** A full page over the map (My scans, community): Back button, Esc to close, scrolls to top when `pageKey` changes. */
export function FullPage({ pageKey, titleId, testId, onBack, backLabel = 'Back', width = 880, children }: {
  pageKey: string; titleId: string; testId: string; onBack(): void; backLabel?: string; width?: number; children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [pageKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement).closest('input, textarea, [role="dialog"] [role="dialog"]')) return;
      onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);
  return (
    <motion.div ref={scroller} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
      className="absolute inset-0 z-40 overflow-y-auto bg-base">
      <div className="mx-auto w-full px-4 pb-16 pt-20 sm:px-6" style={{ maxWidth: width }}>
        <button onClick={onBack} className="tt-press mb-6 flex items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink"><ArrowLeft size={15} /> {backLabel}</button>
        {children}
      </div>
    </motion.div>
  );
}
