import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

/** TerratracePanel — floating surface over the map. */
export const Panel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Panel({ className = '', ...rest }, ref) {
  return <div ref={ref} className={`tt-panel ${className}`} {...rest} />;
});

interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'button' | 'li';
  selected?: boolean;
  interactive?: boolean;
}

/** TerratraceCard — quiet container; interactive cards lift on hover and show a selected edge. */
export function Card({ as = 'div', selected, interactive, className = '', ...rest }: CardProps) {
  const Tag = as as 'div';
  const inter = interactive
    ? 'tt-press cursor-pointer hover:bg-hover hover:shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_10px_24px_-14px_rgba(0,0,0,0.9)] hover:-translate-y-px'
    : '';
  const sel = selected ? 'bg-hover shadow-[0_0_0_1px_rgba(69,208,196,0.55)]' : 'shadow-[0_0_0_1px_rgba(255,255,255,0.065)]';
  return <Tag className={`relative rounded-md bg-white/[0.02] text-left ${sel} ${inter} ${className}`} {...(rest as HTMLAttributes<HTMLDivElement>)} />;
}

/** Section heading in the mono label style, with optional trailing content. */
export function SectionLabel({ children, aside, className = '' }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={`mb-2.5 flex items-center justify-between gap-3 ${className}`}>
      <h3 className="t-label text-ink-3">{children}</h3>
      {aside && <div className="t-caption text-ink-3">{aside}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-[4px] px-1 font-mono text-[10px] text-ink-2 shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_1px_0_rgba(255,255,255,0.14)]">
      {children}
    </kbd>
  );
}

export function Divider({ vertical, className = '' }: { vertical?: boolean; className?: string }) {
  return <div aria-hidden className={`${vertical ? 'w-px self-stretch' : 'h-px w-full'} bg-line ${className}`} />;
}
