import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface Props {
  content: ReactNode;
  side?: Side;
  delay?: number;
  children: ReactElement<Record<string, unknown>>;
  disabled?: boolean;
}

/**
 * TerratraceTooltip — portal-rendered (never clipped by scroll containers),
 * opens on hover or keyboard focus after a short intent delay.
 */
export function Tooltip({ content, side = 'top', delay = 280, children, disabled }: Props) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number>(0);
  const ref = useRef<HTMLElement | null>(null);
  const id = useId();

  const show = useCallback(() => {
    if (disabled) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const gap = 8;
      const p =
        side === 'top' ? { x: r.left + r.width / 2, y: r.top - gap }
        : side === 'bottom' ? { x: r.left + r.width / 2, y: r.bottom + gap }
        : side === 'left' ? { x: r.left - gap, y: r.top + r.height / 2 }
        : { x: r.right + gap, y: r.top + r.height / 2 };
      setPos(p);
    }, delay);
  }, [delay, side, disabled]);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setPos(null);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const translate =
    side === 'top' ? 'translate(-50%, -100%)' : side === 'bottom' ? 'translate(-50%, 0)' : side === 'left' ? 'translate(-100%, -50%)' : 'translate(0, -50%)';

  const child = cloneElement(children, {
    ref: (el: HTMLElement | null) => { ref.current = el; },
    onPointerEnter: show,
    onPointerLeave: hide,
    onFocus: show,
    onBlur: hide,
    'aria-describedby': pos ? id : undefined,
  });

  return (
    <>
      {child}
      {createPortal(
        <AnimatePresence>
          {pos && (
            <motion.div
              id={id}
              role="tooltip"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="pointer-events-none fixed z-[100] max-w-[260px] rounded-sm bg-[#141b20] px-2.5 py-1.5 text-[11.5px] leading-snug text-ink-2 shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_12px_28px_-10px_rgba(0,0,0,0.9)]"
              style={{ left: pos.x, top: pos.y, transform: translate }}
            >
              {content}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
