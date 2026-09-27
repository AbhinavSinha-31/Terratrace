import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';

interface Props {
  trigger(props: { ref: (el: HTMLElement | null) => void; onClick(): void; 'aria-expanded': boolean; 'aria-haspopup': 'dialog' }): ReactElement;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'left' | 'right';
  width?: number;
  label: string;
}

/** TerratracePopover — anchored panel (portal), closes on outside click / Esc. */
export function Popover({ trigger, children, align = 'right', width = 300, label }: Props) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !panel.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); anchor.current?.focus(); } };
    document.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true); };
  }, [open]);

  return (
    <>
      {trigger({
        ref: (el) => { anchor.current = el; },
        onClick: () => { setRect(anchor.current?.getBoundingClientRect() ?? null); setOpen((o) => !o); },
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
      })}
      {createPortal(
        <AnimatePresence>
          {open && rect && (
            <motion.div
              ref={panel}
              role="dialog"
              aria-label={label}
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              className="tt-panel fixed z-[96] max-w-[calc(100vw-24px)]"
              style={{ top: rect.bottom + 10, width, ...(align === 'right' ? { right: Math.max(12, window.innerWidth - rect.right) } : { left: Math.max(12, rect.left) }) }}
            >
              {typeof children === 'function' ? children(close) : children}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
