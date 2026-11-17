import { useEffect, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, ArrowBigDown, ArrowBigUp, CheckCircle2, X } from 'lucide-react';
import { create } from 'zustand';
import { useQueryClient } from '@tanstack/react-query';
import { requireSignIn } from '../../state/auth';
import { UserAvatar } from '../account/UserAvatar';
import { castVote, errorText, type VoteValue } from './api';

export const FIELD = 'w-full rounded-md bg-white/[0.04] px-3 py-2 text-[13px] text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.12)] outline-none placeholder:text-ink-4 focus:shadow-[0_0_0_1px_rgba(69,208,196,0.6)] disabled:opacity-50';

export function Labeled({ label, hint, count, max, id, children }: { label: string; hint?: ReactNode; count?: number; max?: number; id: string; children: ReactNode }) {
  const over = count !== undefined && max !== undefined && count > max;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[12px] font-medium text-ink-2">{label}</label>
        {count !== undefined && max !== undefined && <span className={`t-data text-[10.5px] ${over ? 'text-bad' : 'text-ink-4'}`}>{count.toLocaleString()} / {max.toLocaleString()}</span>}
      </div>
      {children}
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-ink-4">{hint}</p>}
    </div>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`${FIELD} h-10 ${p.className ?? ''}`} />;
export const TextArea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`${FIELD} resize-y leading-relaxed ${p.className ?? ''}`} />;

export function FormError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p role="alert" className="flex items-start gap-2 rounded-md bg-bad/8 px-3 py-2 text-[12px] leading-relaxed text-[#ff8a80] shadow-[0_0_0_1px_rgba(229,88,79,0.35)]"><AlertTriangle size={14} className="mt-px shrink-0" />{children}</p>;
}

// ---------------------------------------------------------------- toasts
interface Toast { id: number; tone: 'ok' | 'error'; text: string }
let toastId = 0;
const useToasts = create<{ items: Toast[]; push(tone: Toast['tone'], text: string): void; drop(id: number): void }>((set) => ({
  items: [],
  push: (tone, text) => {
    const id = ++toastId;
    set((s) => ({ items: [...s.items.slice(-2), { id, tone, text }] }));
    window.setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), 6000);
  },
  drop: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));
export const toast = (tone: Toast['tone'], text: string) => useToasts.getState().push(tone, text);

export function CommunityToasts() {
  const items = useToasts((s) => s.items);
  const drop = useToasts((s) => s.drop);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[120] flex flex-col items-center gap-2 px-4">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div key={t.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} data-testid="community-toast"
            className="tt-panel pointer-events-auto flex w-full max-w-[440px] items-start gap-2.5 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink">
            {t.tone === 'ok' ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-forest" /> : <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />}
            <span className="min-w-0 flex-1">{t.text}</span>
            <button aria-label="Dismiss" onClick={() => drop(t.id)} className="tt-press -mr-1 rounded-sm p-0.5 text-ink-3 hover:text-ink"><X size={14} /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------- votes
export function VoteControl({ kind, id, score, myVote, compact }: { kind: 'post' | 'comment'; id: string; score: number; myVote: VoteValue; compact?: boolean }) {
  const qc = useQueryClient();
  const [state, setState] = useState({ score, myVote });
  const [busy, setBusy] = useState(false);
  useEffect(() => setState({ score, myVote }), [score, myVote]);
  const cast = async (dir: 1 | -1) => {
    if (!requireSignIn('Sign in to vote. Reading works without an account.')) return;
    const value = (state.myVote === dir ? 0 : dir) as VoteValue;
    const before = state;
    setState({ score: state.score - state.myVote + value, myVote: value });   // optimistic; the trigger keeps the real score
    setBusy(true);
    try {
      await castVote(kind, id, value, before.myVote);
      void qc.invalidateQueries({ queryKey: ['community'] });
    } catch (e) {
      setState(before);
      toast('error', errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const btn = (dir: 1 | -1) => {
    const on = state.myVote === dir;
    const Icon = dir === 1 ? ArrowBigUp : ArrowBigDown;
    return (
      <button type="button" disabled={busy} onClick={() => void cast(dir)} aria-pressed={on} aria-label={dir === 1 ? 'Upvote' : 'Downvote'} data-testid={dir === 1 ? 'upvote' : 'downvote'}
        className={`tt-press grid place-items-center rounded-sm ${compact ? 'h-7 w-7' : 'h-8 w-8'} ${on ? (dir === 1 ? 'bg-accent/15 text-accent' : 'bg-warn/15 text-warn') : 'text-ink-3 hover:bg-hover hover:text-ink'}`}>
        <Icon size={compact ? 16 : 18} fill={on ? 'currentColor' : 'none'} />
      </button>
    );
  };
  return (
    <div className={`flex shrink-0 items-center self-start ${compact ? 'flex-row gap-0.5' : 'flex-col'}`} data-testid={`vote-${kind}`}>
      {btn(1)}
      <span className={`t-data min-w-[2ch] text-center text-[12.5px] font-medium ${state.myVote === 1 ? 'text-accent' : state.myVote === -1 ? 'text-warn' : 'text-ink-2'}`} aria-label={`Score ${state.score}`} data-testid="score">{state.score}</span>
      {btn(-1)}
    </div>
  );
}

// ---------------------------------------------------------------- tags, authors, time
export function TagChip({ label, active, onClick }: { label: string; active?: boolean; onClick?: () => void }) {
  const cls = `inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-[11.5px] font-medium ${active ? 'bg-accent/15 text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.45)]' : 'bg-white/[0.03] text-ink-2 shadow-[0_0_0_1px_rgba(255,255,255,0.1)]'}`;
  if (!onClick) return <span className={cls}>#{label}</span>;
  return <button type="button" onClick={onClick} aria-pressed={active} className={`tt-press ${cls} hover:text-ink`}>#{label}</button>;
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return iso.slice(0, 10);
}

export function Author({ name, avatar, official, when, size = 22 }: { name: string | null; avatar: string | null; official?: boolean; when: string; size?: number }) {
  const shown = official ? 'TERRATRACE' : name || 'Member';
  return (
    <span className="flex min-w-0 items-center gap-2 text-[11.5px] text-ink-3">
      <UserAvatar name={shown} src={official ? null : avatar} size={size} />
      <span className={`truncate ${official ? 'font-semibold text-accent' : 'text-ink-2'}`}>{shown}</span>
      <span aria-hidden>·</span>
      <time dateTime={when} title={new Date(when).toLocaleString()}>{timeAgo(when)}</time>
    </span>
  );
}
