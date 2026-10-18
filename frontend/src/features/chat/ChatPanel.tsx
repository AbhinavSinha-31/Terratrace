import { useEffect, useRef, useState } from 'react';
import { BookOpen, Database, Loader2, Send, ShieldAlert, Sparkles } from 'lucide-react';
import { useHealth } from '../../data/queries';
import type { ChatCitation, ChatReply, ChatSegment, ChatStage } from '../../data/contracts';
import { useChat, type AreaContextRef, type ChatMessage } from '../../state/chat';

// A stable empty list: a new [] per render would make the store selector loop forever.
const NO_MESSAGES: ChatMessage[] = [];
const NOOP = () => {};

export const CHAT_NOTICE = "Don't enter personal information. AI explanations can be wrong; figures come from TerraTrace data with their dataset and year.";

/** Whether the server's AI chat can answer (health); null while unknown. */
export function useChatAvailability(): { ready: boolean | null; message: string | null } {
  const { data: h } = useHealth();
  if (!h) return { ready: null, message: null };
  if (!h.backend) return { ready: false, message: 'The AI chat needs the TerraTrace server, which is not reachable right now.' };
  const st = h.chat?.status;
  if (st === 'ready') return { ready: true, message: null };
  if (st === 'offline') return { ready: false, message: 'The AI chat is switched off on this server.' };
  return { ready: false, message: 'The AI chat is not available right now.' };
}

const KIND_LABEL: Record<ChatCitation['kind'], string> = {
  terratrace_result: 'TerraTrace result',
  reference_context: 'Reference context, not a TerraTrace result',
  method: 'TerraTrace method',
  dataset: 'Dataset documentation',
};

function Citation({ c }: { c: ChatCitation }) {
  const ref = c.kind === 'method' || c.kind === 'dataset';
  return (
    <li className="rounded-sm bg-white/[0.03] px-2.5 py-1.5 text-[11px] leading-snug shadow-[0_0_0_1px_rgba(255,255,255,0.08)]" data-testid="chat-citation" data-kind={c.kind}>
      <div className="flex items-center gap-1.5 text-ink-3">
        {ref ? <BookOpen size={11} /> : <Database size={11} />}
        <span className="t-label !text-[8.5px]">{KIND_LABEL[c.kind]}</span>
      </div>
      <div className="mt-0.5 text-ink-2">{c.label}{c.value ? <> · <b className="font-medium text-ink">{c.value}</b></> : null}</div>
      {(c.dataset || c.year) && <div className="text-ink-4">{[c.dataset, c.year].filter(Boolean).join(' · ')}</div>}
      {c.source && <div className="text-ink-4">Source: {c.source}</div>}
    </li>
  );
}

const STAGE_TEXT: Record<ChatStage, string> = {
  sending: 'Sending your question…',
  asking: 'Asking the AI model…',
  fallback: 'The main AI model is busy — trying the backup model…',
  checking: "Checking the answer against TerraTrace's data…",
};

function Segment({ s, lang }: { s: ChatSegment; lang?: ChatReply['language'] }) {
  const local = s.text_local ?? null;
  return (
    <div data-testid="chat-segment" data-kind={s.kind}>
      {s.kind === 'general' && (
        <div className="t-label mb-1 flex items-center gap-1 !text-[8.5px] text-accent"><Sparkles size={10} />AI explanation · general knowledge, not TerraTrace data</div>
      )}
      {s.kind === 'place' && <div className="t-label mb-1 !text-[8.5px] text-forest">From TerraTrace's data for this area</div>}
      {s.kind === 'reference' && <div className="t-label mb-1 !text-[8.5px] text-ink-3">Method / dataset reference</div>}
      {local ? (
        <>
          <p className="whitespace-pre-line text-[13px] leading-relaxed text-ink" lang={lang === 'hi' ? 'hi' : 'hi-Latn'} data-testid="chat-segment-local">{local}</p>
          <details className="mt-1 text-[11px] text-ink-3" data-testid="chat-segment-english">
            <summary className="cursor-pointer select-none">English (checked) · AI translation above; its numbers match the checked English</summary>
            <p className="mt-1 whitespace-pre-line leading-relaxed text-ink-2" lang="en">{s.text}</p>
          </details>
        </>
      ) : (
        <p className="whitespace-pre-line text-[13px] leading-relaxed text-ink">{s.text}</p>
      )}
      {s.citations.length > 0 && <ul className="mt-1.5 space-y-1">{s.citations.map((c) => <Citation key={c.id} c={c} />)}</ul>}
    </div>
  );
}

/** Reveals an answer's checked segments one after another (all of them already passed every check). */
function useReveal(total: number, animate: boolean, onDone: () => void): number {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [shown, setShown] = useState(animate && !reduced ? 1 : total);
  useEffect(() => {
    if (shown >= total) { if (animate) onDone(); return; }
    const t = window.setTimeout(() => setShown((n) => n + 1), 450);
    return () => window.clearTimeout(t);
  }, [shown, total, animate, onDone]);
  return shown;
}

function Reply({ r, animate = false, onRevealed }: { r: ChatReply; animate?: boolean; onRevealed?: () => void }) {
  const done = onRevealed ?? NOOP;
  const shown = useReveal(r.status === 'answered' ? r.segments.length : 0, animate, done);
  if (r.status === 'answered') {
    return (
      <div className="space-y-3">
        {r.message && <p className="text-[12px] leading-relaxed text-ink-3" data-testid="chat-translation-note">{r.message}</p>}
        {r.segments.slice(0, shown).map((s, i) => <Segment key={i} s={s} lang={r.language} />)}
      </div>
    );
  }
  const tone = r.status === 'withheld' ? 'text-warn' : 'text-ink-2';
  return (
    <div className={`flex gap-2 text-[12.5px] leading-relaxed ${tone}`} data-testid={`chat-${r.status}`}>
      {r.status === 'withheld' && <ShieldAlert size={15} className="mt-0.5 shrink-0" />}
      <span>{r.message}</span>
    </div>
  );
}

export function ChatPanel({ thread, area, starters, greeting, compact = false, autoFocus = false }: {
  thread: string; area?: AreaContextRef; starters: string[]; greeting: string; compact?: boolean; autoFocus?: boolean;
}) {
  const messages = useChat((s) => s.threads[thread] ?? NO_MESSAGES);
  const pending = useChat((s) => !!s.pending[thread]);
  const stage = useChat((s) => s.stage[thread]);
  const fresh = useChat((s) => s.fresh);
  const markRevealed = useChat((s) => s.markRevealed);
  const send = useChat((s) => s.send);
  const { ready, message } = useChatAvailability();
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages.length, pending]);
  const submit = (text: string) => {
    if (!text.trim() || ready === false) return;
    void send(thread, text, area);
    setDraft('');
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-panel" data-thread={thread}>
      <div className={`scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto ${compact ? 'pb-3' : 'pb-4'}`} aria-live="polite">
        <p className="text-[13px] leading-relaxed text-ink-2">{greeting}</p>
        {messages.length === 0 && (
          <div className="flex flex-wrap gap-2" data-testid="chat-starters">
            {starters.map((q) => (
              <button key={q} type="button" disabled={ready === false} onClick={() => submit(q)}
                className="tt-press rounded-full bg-white/[0.04] px-3 py-1.5 text-left text-[12px] text-ink-2 shadow-[0_0_0_1px_rgba(255,255,255,0.1)] hover:bg-hover hover:text-ink disabled:opacity-50">
                {q}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => m.role === 'user'
          ? <div key={m.id} className="ml-auto max-w-[85%] rounded-md bg-accent/12 px-3 py-2 text-[13px] text-ink shadow-[0_0_0_1px_rgba(69,208,196,0.25)]" data-testid="chat-user">{m.text}</div>
          : <div key={m.id} className="max-w-[95%]" data-testid="chat-reply"><Reply r={m.reply} animate={m.id === fresh} onRevealed={markRevealed} /></div>)}
        {pending && <div className="flex items-center gap-2 text-[12px] text-ink-3" data-testid="chat-stage" data-stage={stage ?? 'sending'}><Loader2 size={14} className="animate-spin" />{STAGE_TEXT[stage ?? 'sending']}</div>}
        <div ref={end} />
      </div>
      <div className="shrink-0 border-t border-line pt-3">
        {ready === false && message && <p className="mb-2 text-[12px] text-warn" data-testid="chat-unavailable-state">{message}</p>}
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); submit(draft); }}>
          <label className="sr-only" htmlFor={`chat-input-${thread}`}>Your question</label>
          <textarea id={`chat-input-${thread}`} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={1000} rows={compact ? 1 : 2}
            autoFocus={autoFocus} disabled={ready === false}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(draft); } }}
            placeholder={ready === false ? 'Chat unavailable' : 'Ask about forests, satellites or TerraTrace…'}
            className="min-h-[38px] flex-1 resize-none rounded-md bg-white/[0.04] px-3 py-2 text-[13px] text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.12)] outline-none placeholder:text-ink-4 focus:shadow-[0_0_0_1px_rgba(69,208,196,0.6)] disabled:opacity-50"
            data-testid="chat-input" />
          <button type="submit" aria-label="Send" disabled={ready === false || pending || !draft.trim()}
            className="tt-press grid h-[38px] w-[38px] shrink-0 place-items-center rounded-md bg-accent text-[#03201d] disabled:opacity-40">
            <Send size={15} />
          </button>
        </form>
        <p className="mt-2 text-[10.5px] leading-snug text-ink-4" data-testid="chat-notice">{CHAT_NOTICE}</p>
      </div>
    </div>
  );
}
