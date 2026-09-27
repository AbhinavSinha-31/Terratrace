import type { ReactNode } from 'react';
import type { ConfidenceClass, Severity } from '../data/contracts';
import { SEVERITY_COLOR, SEVERITY_LINE } from '../lib/palette';
import { severityLabel } from '../lib/format';

type Tone = 'neutral' | 'accent' | 'forest' | 'warn' | 'bad';

const TONE: Record<Tone, string> = {
  neutral: 'text-ink-2 shadow-[0_0_0_1px_rgba(255,255,255,0.12)]',
  accent: 'text-accent bg-accent/8 shadow-[0_0_0_1px_rgba(69,208,196,0.35)]',
  forest: 'text-forest bg-forest/8 shadow-[0_0_0_1px_rgba(76,183,130,0.35)]',
  warn: 'text-warn bg-warn/8 shadow-[0_0_0_1px_rgba(227,164,63,0.38)]',
  bad: 'text-[#ff8a80] bg-bad/8 shadow-[0_0_0_1px_rgba(229,88,79,0.4)]',
};

/** TerratraceBadge — mono, uppercase, compact status label. */
export function Badge({ tone = 'neutral', icon, children, className = '' }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-xs px-2 font-mono text-[10px] font-medium uppercase tracking-[0.1em] ${TONE[tone]} ${className}`}>
      {icon}
      {children}
    </span>
  );
}

export function StatusDot({ tone = 'live', pulse }: { tone?: 'live' | 'warn' | 'off' | 'accent'; pulse?: boolean }) {
  const color = { live: 'bg-live', warn: 'bg-warn', off: 'bg-ink-4', accent: 'bg-accent' }[tone];
  return (
    <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
      {pulse && <span className={`absolute inset-0 rounded-full ${color} animate-blink`} />}
      <span className={`relative h-1.5 w-1.5 rounded-full ${color}`} />
    </span>
  );
}

export function SeverityBadge({ severity, showScore }: { severity: Severity; showScore?: number }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-xs px-2 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.12)]">
      <span className="h-2 w-2 rounded-[2px]" style={{ background: SEVERITY_COLOR[severity], boxShadow: `0 0 0 1px ${SEVERITY_LINE[severity]}` }} />
      {severityLabel[severity]} severity
      {showScore !== undefined && <span className="text-ink-3">{showScore.toFixed(2)}</span>}
    </span>
  );
}

const EVIDENCE_TONE: Record<ConfidenceClass, Tone> = { high: 'forest', medium: 'warn', low: 'bad' };

export function EvidenceBadge({ level, score }: { level: ConfidenceClass; score?: number }) {
  return (
    <Badge tone={EVIDENCE_TONE[level]}>
      <span className="flex gap-[2px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className={`h-2 w-[3px] rounded-[1px] ${i < (level === 'high' ? 3 : level === 'medium' ? 2 : 1) ? 'bg-current' : 'bg-current opacity-25'}`} />
        ))}
      </span>
      {level} evidence
      {score !== undefined && <span className="opacity-70">{Math.round(score * 100)}%</span>}
    </Badge>
  );
}
