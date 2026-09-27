import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Check, CheckCircle2, CloudOff, CloudSun, FilterX, Plug, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from './Button';
import { TerratraceMark } from './Logo';

export function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden />;
}

export type StateKind =
  | 'no-change'
  | 'filtered'
  | 'insufficient-imagery'
  | 'cloud-limited'
  | 'service-unavailable'
  | 'ai-unavailable'
  | 'error'
  | 'empty';

const KIND: Record<StateKind, { icon: ReactNode; tone: string; title: string }> = {
  'no-change': { icon: <CheckCircle2 size={18} />, tone: 'text-forest bg-forest/10 shadow-[0_0_0_1px_rgba(76,183,130,0.35)]', title: 'No significant forest change detected' },
  filtered: { icon: <FilterX size={18} />, tone: 'text-ink-2 bg-white/[0.04] shadow-[0_0_0_1px_rgba(255,255,255,0.12)]', title: 'No events match these filters' },
  'insufficient-imagery': { icon: <CloudOff size={18} />, tone: 'text-warn bg-warn/10 shadow-[0_0_0_1px_rgba(227,164,63,0.35)]', title: 'Insufficient clear imagery' },
  'cloud-limited': { icon: <CloudSun size={18} />, tone: 'text-warn bg-warn/10 shadow-[0_0_0_1px_rgba(227,164,63,0.35)]', title: 'Cloud-limited composite' },
  'service-unavailable': { icon: <Plug size={18} />, tone: 'text-[#ff8a80] bg-bad/10 shadow-[0_0_0_1px_rgba(229,88,79,0.4)]', title: 'Earth-observation service unavailable' },
  'ai-unavailable': { icon: <Plug size={18} />, tone: 'text-ink-2 bg-white/[0.04] shadow-[0_0_0_1px_rgba(255,255,255,0.12)]', title: 'Analysis model unavailable' },
  error: { icon: <TriangleAlert size={18} />, tone: 'text-[#ff8a80] bg-bad/10 shadow-[0_0_0_1px_rgba(229,88,79,0.4)]', title: 'Something went wrong' },
  empty: { icon: <TerratraceMark size={18} accent={false} />, tone: 'text-ink-3 bg-white/[0.04] shadow-[0_0_0_1px_rgba(255,255,255,0.12)]', title: 'Nothing to show yet' },
};

interface StateProps {
  kind: StateKind;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  onRetry?(): void;
  compact?: boolean;
}

/** One component for every data state, so success, caution and failure read consistently. */
export function StateView({ kind, title, children, action, onRetry, compact }: StateProps) {
  const k = KIND[kind];
  const role = kind === 'error' || kind === 'service-unavailable' ? 'alert' : 'status';
  if (compact) {
    return (
      <div role={role} className="flex items-start gap-3 rounded-md bg-white/[0.02] px-3 py-2.5 shadow-[0_0_0_1px_rgba(255,255,255,0.065)]">
        <span className={`mt-px grid h-7 w-7 shrink-0 place-items-center rounded-sm ${k.tone}`}>{k.icon}</span>
        <div className="min-w-0">
          <div className="t-label text-ink">{title ?? k.title}</div>
          {children && <div className="mt-1 text-[11.5px] leading-relaxed text-ink-2">{children}</div>}
        </div>
      </div>
    );
  }
  return (
    <motion.div role={role} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center px-6 py-9 text-center">
      <span className={`grid h-11 w-11 place-items-center rounded-md ${k.tone}`}>{k.icon}</span>
      <div className="t-label mt-4 text-ink">{title ?? k.title}</div>
      {children && <p className="mt-2 max-w-[34ch] text-[12.5px] leading-relaxed text-ink-2">{children}</p>}
      {(action || onRetry) && (
        <div className="mt-5 flex gap-2">
          {onRetry && <Button size="sm" icon={<RefreshCw size={13} />} onClick={onRetry}>Retry</Button>}
          {action}
        </div>
      )}
    </motion.div>
  );
}

/**
 * Reveals stage completion one step at a time (min `stepMs` each), so the
 * pipeline stages are legible even when data arrives instantly.
 */
export function useStagedProgress(ready: boolean[], stepMs = 420, key?: unknown): number {
  const [done, setDone] = useState(0);
  useEffect(() => setDone(0), [key]);
  useEffect(() => {
    if (done >= ready.length || !ready[done]) return;
    const t = window.setTimeout(() => setDone((d) => d + 1), stepMs);
    return () => window.clearTimeout(t);
  }, [done, ready, stepMs]);
  return done;
}

interface PipelineProps {
  title: string;
  subtitle?: ReactNode;
  steps: string[];
  done: number;
}

/** TERRATRACE pipeline loader — ✓ done · ● active · ○ pending, with progress sweep. */
export function PipelineLoader({ title, subtitle, steps, done }: PipelineProps) {
  const pct = Math.round((done / steps.length) * 100);
  return (
    <div role="status" aria-live="polite" aria-label={`${title}: ${pct}%`}>
      <div className="flex items-center gap-2.5">
        <TerratraceMark size={18} />
        <div className="t-label text-ink">{title}</div>
        <div className="t-data ml-auto text-[11px] text-ink-3">{pct}%</div>
      </div>
      {subtitle && <div className="mt-1.5 pl-[30px] text-[11.5px] text-ink-3">{subtitle}</div>}
      <ol className="mt-4 space-y-2.5">
        {steps.map((s, i) => {
          const state = i < done ? 'done' : i === done ? 'active' : 'pending';
          return (
            <li key={s} className="flex items-center gap-3 text-[12.5px]">
              <span className="grid h-4 w-4 shrink-0 place-items-center">
                {state === 'done' ? (
                  <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="grid h-4 w-4 place-items-center rounded-full bg-accent/15 text-accent">
                    <Check size={10} strokeWidth={3} />
                  </motion.span>
                ) : state === 'active' ? (
                  <span className="relative h-2 w-2">
                    <span className="absolute inset-0 animate-ping rounded-full bg-accent/50" />
                    <span className="absolute inset-0 rounded-full bg-accent" />
                  </span>
                ) : (
                  <span className="h-2 w-2 rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.25)]" />
                )}
              </span>
              <span className={state === 'pending' ? 'text-ink-4' : state === 'active' ? 'text-ink' : 'text-ink-2'}>{s}</span>
            </li>
          );
        })}
      </ol>
      <div className="relative mt-5 h-[2px] overflow-hidden rounded-full bg-white/[0.06]">
        <motion.div className="absolute inset-y-0 left-0 bg-accent" animate={{ width: `${pct}%` }} transition={{ duration: 0.35 }} />
        <div className="absolute inset-y-0 w-1/4 animate-sweep bg-gradient-to-r from-transparent via-white/25 to-transparent" />
      </div>
    </div>
  );
}
