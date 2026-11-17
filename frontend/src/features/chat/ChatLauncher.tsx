import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { MessageCircle, Send, X } from 'lucide-react';
import { GENERAL, useChat } from '../../state/chat';
import { GENERAL_STARTERS, GREETING } from './starters';
import { ChatNotice, useChatAvailability } from './ChatPanel';

/**
 * Front-page chat: an in-flow button in the "Featured investigations" header row (so it can never cover a card, at
 * any width) and a small pop-up with a greeting and starters, rendered over the page (portal) while it is open.
 * Sending opens the Ask page with the conversation carried over.
 */
export function ChatLauncher() {
  const open = useChat((s) => s.launcherOpen);
  const setOpen = useChat((s) => s.setLauncherOpen);
  const askOpen = useChat((s) => s.askOpen);
  if (askOpen) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(!open)} aria-label={open ? 'Close chat' : 'Ask TerraTrace'} aria-expanded={open}
        data-testid="chat-launcher"
        className="tt-press flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 text-[12px] font-medium text-[#03201d] shadow-[0_6px_18px_-6px_rgba(69,208,196,0.6)]">
        {open ? <X size={14} /> : <MessageCircle size={14} />}
        <span>Ask TerraTrace</span>
      </button>
      {createPortal(<ChatPopup />, document.body)}
    </>
  );
}

function ChatPopup() {
  const open = useChat((s) => s.launcherOpen);
  const setOpen = useChat((s) => s.setLauncherOpen);
  const send = useChat((s) => s.send);
  const openAsk = useChat((s) => s.openAsk);
  const { ready, message } = useChatAvailability();
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
  const start = (text: string) => {
    if (!text.trim() || ready === false) return;
    void send(GENERAL, text);   // the conversation carries over: the Ask page shows the same thread
    setDraft('');
    openAsk();
  };
  return (
    <AnimatePresence>
      {open && (
        <motion.div key="pop" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
          className="tt-panel fixed bottom-4 right-4 z-[60] w-[min(340px,calc(100vw-32px))] p-4" role="dialog" aria-label="Ask TerraTrace" data-testid="chat-popup">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[13px] leading-relaxed text-ink-2">{GREETING}</p>
            <button type="button" aria-label="Close chat" onClick={() => setOpen(false)} className="tt-press -mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-hover"><X size={15} /></button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {GENERAL_STARTERS.slice(0, 3).map((q) => (
              <button key={q} type="button" disabled={ready === false} onClick={() => start(q)} data-testid="chat-popup-starter"
                className="tt-press rounded-full bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-ink-2 shadow-[0_0_0_1px_rgba(255,255,255,0.1)] hover:bg-hover disabled:opacity-50">{q}</button>
            ))}
          </div>
          {ready === false && message && <p className="mt-2 text-[11.5px] text-warn">{message}</p>}
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); start(draft); }}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={1000} disabled={ready === false} aria-label="Your question"
              placeholder="Ask a question…" data-testid="chat-popup-input"
              className="h-9 min-w-0 flex-1 rounded-md bg-white/[0.04] px-3 text-[12.5px] text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.12)] outline-none placeholder:text-ink-4 disabled:opacity-50" />
            <button type="submit" aria-label="Send" disabled={ready === false || !draft.trim()} className="tt-press grid h-9 w-9 place-items-center rounded-md bg-accent text-[#03201d] disabled:opacity-40"><Send size={14} /></button>
          </form>
          <ChatNotice className="mt-2" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
