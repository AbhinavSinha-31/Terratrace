import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { TerratraceMark } from '../../design';
import { useStudyAreas } from '../../data/queries';

/** Brand loading screen on first load (mark draws itself, min 1.1 s). */
export function BootSplash() {
  const { isLoading } = useStudyAreas();
  const [minElapsed, setMinElapsed] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setMinElapsed(true), 1100); return () => window.clearTimeout(t); }, []);
  const show = isLoading || !minElapsed;
  return (
    <AnimatePresence>
      {show && (
        <motion.div className="tt-space fixed inset-0 z-[200] grid place-items-center" exit={{ opacity: 0 }} transition={{ duration: 0.5 }} role="status" aria-label="Loading TERRATRACE">
          <div className="flex flex-col items-center">
            <TerratraceMark size={72} animated className="text-ink" />
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 }} className="mt-6 text-center">
              <div className="font-display text-[22px] font-semibold tracking-[0.3em] text-ink" style={{ marginRight: '-0.3em' }}>TERRATRACE</div>
              <div className="t-label mt-2 text-ink-3">Earth observation intelligence</div>
            </motion.div>
            <div className="relative mt-8 h-px w-40 overflow-hidden bg-white/10">
              <div className="absolute inset-y-0 w-1/3 animate-sweep bg-gradient-to-r from-transparent via-accent to-transparent" />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
