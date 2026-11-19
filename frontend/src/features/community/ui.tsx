import { useEffect, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, ArrowBigDown, ArrowBigUp, BadgeCheck, CheckCircle2, X } from 'lucide-react';
import { create } from 'zustand';
import { useQueryClient } from '@tanstack/react-query';
import { requireSignIn } from '../../state/auth';
import { Avatar, Skeleton, Tooltip, type AvatarSize } from '../../design';
import { castVote, devDetail, errorText, type VoteValue } from './api';

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
/** An error toast: the public sentence, plus the raw Supabase error in development builds. */
export const toastError = (e: unknown) => toast('error', [errorText(e), devDetail(e)].filter(Boolean).join(' — '));

/** Error body for a StateView: the public sentence and, in development builds only, the raw Supabase error. */
export function ErrorBody({ error }: { error: unknown }) {
  const detail = devDetail(error);
  return (
    <>
      {errorText(error)}
      {detail && <code className="mt-2 block break-words rounded-sm bg-white/[0.04] px-2 py-1.5 text-left text-[11px] text-warn" data-testid="dev-error-detail">dev: {detail}</code>}
    </>
  );
}

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
/** Up / down vote with an optimistic score (the database trigger keeps the real one) and a small pop on change.
 *  A vote of the current user lights the control in the accent colour. */
export function VoteControl({ kind, id, score, myVote, compact }: { kind: 'post' | 'comment'; id: string; score: number; myVote: VoteValue; compact?: boolean }) {
  const qc = useQueryClient();
  const [state, setState] = useState({ score, myVote });
  const [busy, setBusy] = useState(false);
  useEffect(() => setState({ score, myVote }), [score, myVote]);
  const cast = async (dir: 1 | -1) => {
    if (!requireSignIn('Sign in to vote. Reading works without an account.')) return;
    const value = (state.myVote === dir ? 0 : dir) as VoteValue;
    const before = state;
    setState({ score: state.score - state.myVote + value, myVote: value });   // optimistic
    setBusy(true);
    try {
      await castVote(kind, id, value, before.myVote);
      void qc.invalidateQueries({ queryKey: ['community'] });
    } catch (e) {
      setState(before);
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const voted = state.myVote !== 0;
  const btn = (dir: 1 | -1) => {
    const on = state.myVote === dir;
    const Icon = dir === 1 ? ArrowBigUp : ArrowBigDown;
    return (
      <motion.button type="button" disabled={busy} onClick={() => void cast(dir)} aria-pressed={on} aria-label={dir === 1 ? 'Upvote' : 'Downvote'}
        data-testid={dir === 1 ? 'upvote' : 'downvote'} whileTap={{ scale: 0.8 }}
        className={`grid place-items-center rounded-full transition-colors ${compact ? 'h-7 w-7' : 'h-8 w-8'} ${on ? (dir === 1 ? 'text-accent' : 'text-warn') : 'text-ink-3 hover:bg-white/[0.06] hover:text-ink'}`}>
        <motion.span key={on ? 'on' : 'off'} initial={on ? { scale: 0.6 } : false} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 520, damping: 18 }} className="grid">
          <Icon size={compact ? 16 : 18} fill={on ? 'currentColor' : 'none'} />
        </motion.span>
      </motion.button>
    );
  };
  return (
    <div data-testid={`vote-${kind}`} data-voted={state.myVote}
      className={`relative z-10 flex shrink-0 items-center self-start rounded-full transition-colors duration-200 ${compact ? 'flex-row gap-0.5 px-0.5' : 'flex-col py-0.5'} ${voted ? 'bg-accent/10 shadow-[0_0_0_1px_rgba(69,208,196,0.35)]' : 'bg-white/[0.025] shadow-[0_0_0_1px_rgba(255,255,255,0.06)]'}`}>
      {btn(1)}
      <span className="relative grid min-w-[2.2ch] place-items-center overflow-hidden" aria-label={`Score ${state.score}`} data-testid="score">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={state.score} initial={{ y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -8, opacity: 0 }} transition={{ duration: 0.18 }}
            className={`t-data text-[12.5px] font-semibold ${state.myVote === 1 ? 'text-accent' : state.myVote === -1 ? 'text-warn' : 'text-ink-2'}`}>
            {state.score}
          </motion.span>
        </AnimatePresence>
      </span>
      {btn(-1)}
    </div>
  );
}

// ---------------------------------------------------------------- tags, authors, time
const PILL = 'inline-flex h-7 shrink-0 items-center gap-0.5 rounded-full px-3 text-[11.5px] font-medium leading-none transition-colors';
const PILL_IDLE = 'bg-white/[0.04] text-ink-2 shadow-[0_0_0_1px_rgba(255,255,255,0.1)]';
const PILL_ACTIVE = 'bg-accent text-[#03201d] shadow-[0_0_0_1px_rgba(69,208,196,0.9),0_6px_16px_-8px_rgba(69,208,196,0.8)]';

/** A tag pill. `active` = the current feed filter (solid accent). Without onClick it is a static label. */
export function TagChip({ label, active, onClick }: { label: string; active?: boolean; onClick?: () => void }) {
  const body = <><span className={active ? 'opacity-70' : 'text-ink-4'}>#</span>{label}</>;
  if (!onClick) return <span className={`${PILL} ${PILL_IDLE}`}>{body}</span>;
  return (
    <button type="button" onClick={onClick} aria-pressed={!!active} data-active={active ? 'true' : undefined}
      className={`tt-press relative z-10 ${PILL} ${active ? PILL_ACTIVE : `${PILL_IDLE} hover:bg-white/[0.08] hover:text-ink`}`}>
      {body}
    </button>
  );
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))} mo ago`;
  return `${Math.floor(s / (86400 * 365))} y ago`;
}

const fullDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });

/** Relative time; the full date and time in a tooltip (and in the title for screen readers / touch). */
export function TimeAgo({ when }: { when: string }) {
  return (
    <Tooltip content={fullDate(when)}>
      <time dateTime={when} title={fullDate(when)} tabIndex={0} className="relative z-10 cursor-default whitespace-nowrap outline-none hover:text-ink-2 focus-visible:text-ink-2">{timeAgo(when)}</time>
    </Tooltip>
  );
}

export function OfficialBadge() {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-full bg-accent/12 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.35)]" data-testid="official-badge">
      <BadgeCheck size={11} /> Official
    </span>
  );
}

/** Avatar · name (· Official) · relative time. `official` = a post published by TERRATRACE itself (no author). */
export function Author({ userId, name, avatar, official, when, size = 'sm', strong }: {
  userId?: string | null; name: string | null; avatar: string | null; official?: boolean; when: string; size?: AvatarSize; strong?: boolean;
}) {
  const shown = official ? 'TERRATRACE' : name || 'Member';
  return (
    <span className={`flex min-w-0 items-center gap-2 text-ink-3 ${size === 'sm' ? 'text-[11.5px]' : 'text-[12.5px]'}`}>
      <Avatar name={shown} src={official ? null : avatar} userId={userId} official={official} size={size} />
      <span className={`truncate ${strong || official ? 'font-semibold text-ink' : 'font-medium text-ink-2'}`} data-testid="author-name">{shown}</span>
      {official && <OfficialBadge />}
      <span aria-hidden className="text-ink-4">·</span>
      <TimeAgo when={when} />
    </span>
  );
}

// ---------------------------------------------------------------- thumbnails
/** Sentinel-2 cloudless (EOX) tile at zoom 10 around a bbox centre — the same imagery as the featured cards. */
export function tileThumb(bbox: [number, number, number, number]): string {
  const lon = (bbox[0] + bbox[2]) / 2, lat = (bbox[1] + bbox[3]) / 2, n = 2 ** 10;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/10/${y}/${x}.jpg`;
}

// ---------------------------------------------------------------- loading
export function PostCardSkeleton() {
  return (
    <li className="tt-panel flex gap-4 p-4" aria-hidden data-testid="post-skeleton">
      <Skeleton className="h-[86px] w-9 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="flex items-center gap-2"><Skeleton className="h-6 w-6 rounded-full" /><Skeleton className="h-3 w-32 rounded" /></div>
        <Skeleton className="h-4 w-4/5 rounded" />
        <Skeleton className="h-3 w-full rounded" />
        <div className="flex gap-1.5 pt-1"><Skeleton className="h-6 w-16 rounded-full" /><Skeleton className="h-6 w-20 rounded-full" /></div>
      </div>
      <Skeleton className="hidden h-[86px] w-[124px] rounded-md sm:block" />
    </li>
  );
}

export function CommentSkeleton() {
  return (
    <div className="flex gap-2.5" aria-hidden>
      <Skeleton className="h-6 w-6 rounded-full" />
      <div className="flex-1 space-y-2"><Skeleton className="h-3 w-28 rounded" /><Skeleton className="h-3 w-3/4 rounded" /></div>
    </div>
  );
}
