import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MessagesSquare, X } from 'lucide-react';
import { IconButton } from '../../design';
import { GENERAL, useChat } from '../../state/chat';
import { ChatPanel } from './ChatPanel';
import { GENERAL_STARTERS, GREETING } from './starters';


/** The "Ask me anything" page: a full page over the map (general questions; no area facts). */
export function AskPage() {
  const open = useChat((s) => s.askOpen);
  const close = useChat((s) => s.closeAsk);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
  return (
    <AnimatePresence>
      {open && (
        <motion.section key="ask" role="dialog" aria-modal="true" aria-labelledby="ask-title" data-testid="ask-page"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
          className="absolute inset-0 z-40 bg-base/95 px-4 pb-4 pt-20 backdrop-blur-sm sm:px-6">
          <div className="mx-auto flex h-full w-full max-w-[760px] flex-col">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-md bg-accent/12 text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.35)]"><MessagesSquare size={19} /></div>
                <div>
                  <h1 id="ask-title" className="t-h1">Ask me anything</h1>
                  <p className="text-[12.5px] text-ink-3">About forests, Earth observation and TerraTrace.</p>
                </div>
              </div>
              <IconButton label="Close" onClick={close}><X size={17} /></IconButton>
            </div>
            <div className="tt-panel min-h-0 flex-1 p-4 sm:p-5"><ChatPanel thread={GENERAL} starters={GENERAL_STARTERS} greeting={GREETING} autoFocus /></div>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
