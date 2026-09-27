import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown } from 'lucide-react';
import { Tooltip } from './Tooltip';

/** Switch — animated thumb, role="switch". */
export function Switch({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`tt-press relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-white/12'}`}
    >
      <motion.span
        className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.5)]"
        animate={{ left: on ? 14 : 2 }}
        transition={{ type: 'spring', stiffness: 700, damping: 36 }}
      />
    </button>
  );
}

interface LayerToggleProps {
  icon: ReactNode;
  label: string;
  hint: string;
  on: boolean;
  onChange(v: boolean): void;
  children?: ReactNode;
  disabled?: boolean;
}

/** TerratraceLayerToggle — icon, label, switch, tooltip, and an expanding settings slot when active. */
export function LayerToggle({ icon, label, hint, on, onChange, children, disabled }: LayerToggleProps) {
  return (
    <div className={`rounded-md transition-colors ${on ? 'bg-white/[0.03]' : ''} ${disabled ? 'opacity-40' : ''}`}>
      <div className="flex items-center gap-2.5 px-2 py-[7px]">
        <Tooltip content={hint} side="right">
          <span
            tabIndex={0}
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-sm transition-colors ${on ? 'bg-accent/12 text-accent' : 'bg-white/[0.04] text-ink-3'}`}
          >
            {icon}
          </span>
        </Tooltip>
        <button className="min-w-0 flex-1 text-left" onClick={() => !disabled && onChange(!on)} disabled={disabled}>
          <span className={`block truncate text-[12.5px] font-medium transition-colors ${on ? 'text-ink' : 'text-ink-2'}`}>{label}</span>
        </button>
        <Switch on={on} onChange={(v) => !disabled && onChange(v)} label={`${label} layer`} />
      </div>
      <AnimatePresence initial={false}>
        {on && children && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="px-2 pb-2.5 pl-[46px]">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: ReactNode; hint?: string }[];
  onChange(v: T): void;
  label: string;
  size?: 'sm' | 'md';
}

/** Segmented control with a sliding active indicator. */
export function Segmented<T extends string>({ value, options, onChange, label, size = 'sm' }: SegmentedProps<T>) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} className="relative flex rounded-sm bg-white/[0.03] p-[3px] shadow-[0_0_0_1px_rgba(255,255,255,0.07)]">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          title={o.hint}
          className={`tt-press relative flex-1 whitespace-nowrap rounded-[4px] px-2.5 ${size === 'sm' ? 'h-6 text-[11px]' : 'h-8 text-[12px]'} font-medium ${value === o.value ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
        >
          {value === o.value && (
            <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-[4px] bg-hover shadow-[0_0_0_1px_rgba(255,255,255,0.12)]" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

interface MenuProps<T extends string | number> {
  value: T;
  options: { value: T; label: ReactNode; meta?: ReactNode }[];
  onChange(v: T): void;
  label: string;
  renderValue?(v: T): ReactNode;
  className?: string;
  align?: 'left' | 'right';
}

/** Menu (custom select) — keyboard navigable listbox rendered in a portal. */
export function Menu<T extends string | number>({ value, options, onChange, label, renderValue, className = '', align = 'left' }: MenuProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const openMenu = () => {
    setRect(btn.current!.getBoundingClientRect());
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setOpen(false);
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', onScroll);
    setTimeout(() => list.current?.focus(), 0);
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('resize', onScroll); };
  }, [open]);

  const pick = (i: number) => { onChange(options[i].value); setOpen(false); btn.current?.focus(); };
  const current = options.find((o) => o.value === value);

  return (
    <>
      <button
        ref={btn}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(); } }}
        className={`tt-press inline-flex h-7 items-center gap-1.5 rounded-sm bg-white/[0.03] px-2 text-[11.5px] text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.1)] hover:bg-hover ${className}`}
      >
        <span className="truncate">{renderValue ? renderValue(value) : current?.label}</span>
        <ChevronDown size={13} className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && rect && (
            <motion.ul
              ref={list}
              role="listbox"
              tabIndex={-1}
              aria-label={label}
              aria-activedescendant={`opt-${active}`}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14 }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
                else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active); }
                else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus(); }
              }}
              className="tt-panel fixed z-[95] min-w-[140px] p-1 outline-none"
              style={{ top: rect.bottom + 6, ...(align === 'left' ? { left: rect.left } : { right: window.innerWidth - rect.right }), minWidth: rect.width }}
            >
              {options.map((o, i) => (
                <li
                  key={String(o.value)}
                  id={`opt-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(i)}
                  className={`flex cursor-pointer items-center gap-3 rounded-sm px-2.5 py-1.5 text-[12px] ${i === active ? 'bg-hover text-ink' : 'text-ink-2'}`}
                >
                  <span className="flex-1 whitespace-nowrap">{o.label}</span>
                  {o.meta && <span className="t-data text-[10.5px] text-ink-3">{o.meta}</span>}
                  <Check size={13} className={o.value === value ? 'text-accent' : 'opacity-0'} />
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
