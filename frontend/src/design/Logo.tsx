import { motion, useReducedMotion } from 'framer-motion';

/**
 * TERRATRACE brand mark — one vector source for every use.
 *
 *   Earth ring with an orbital gap   → the planet under observation
 *   Satellite node in the gap        → the observing sensor
 *   Fault-shifted trace              → the land surface, displaced where change is detected
 *   Baseline band                    → the reference period it is compared against
 *
 * Monochrome by default (currentColor); `accent` tints only the satellite node.
 */
export const MARK_PATHS = {
  ring: 'M27.28 11.9A12 12 0 1 1 20.1 4.72',
  trace: 'M4.1 14H12.2L15.2 17.6H27.8',
  base: 'M7.6 22H24.4',
  node: 'M24.5 4.9L27.1 7.5L24.5 10.1L21.9 7.5Z',
} as const;

interface MarkProps {
  size?: number;
  accent?: string | false;
  animated?: boolean;
  className?: string;
  title?: string;
}

export function TerratraceMark({ size = 28, accent = '#45d0c4', animated = false, className, title }: MarkProps) {
  const reduce = useReducedMotion();
  const draw = animated && !reduce;
  const nodeColor = accent === false ? 'currentColor' : accent;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <motion.path
        d={MARK_PATHS.ring}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="butt"
        initial={draw ? { pathLength: 0 } : false}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      />
      <motion.path
        d={MARK_PATHS.trace}
        stroke="currentColor"
        strokeWidth={1.9}
        strokeLinejoin="miter"
        strokeLinecap="butt"
        initial={draw ? { pathLength: 0, opacity: 0 } : false}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.7, delay: draw ? 0.45 : 0, ease: [0.22, 1, 0.36, 1] }}
      />
      <motion.path
        d={MARK_PATHS.base}
        stroke="currentColor"
        strokeWidth={1.9}
        initial={draw ? { pathLength: 0, opacity: 0 } : false}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.5, delay: draw ? 0.7 : 0, ease: [0.22, 1, 0.36, 1] }}
      />
      <motion.path
        d={MARK_PATHS.node}
        fill={nodeColor}
        initial={draw ? { scale: 0, opacity: 0 } : false}
        animate={{ scale: 1, opacity: 1 }}
        style={{ transformOrigin: '24.5px 7.5px' }}
        transition={{ duration: 0.35, delay: draw ? 1.0 : 0, ease: [0.22, 1, 0.36, 1] }}
      />
    </svg>
  );
}

interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  descriptor?: boolean;
  animated?: boolean;
  className?: string;
}

const SIZES = {
  sm: { mark: 22, word: 'text-[12.5px]', gap: 'gap-2' },
  md: { mark: 26, word: 'text-[14px]', gap: 'gap-2.5' },
  lg: { mark: 44, word: 'text-[24px]', gap: 'gap-4' },
};

/** Full lockup: mark + wordmark (+ optional descriptor line). */
export function TerratraceLogo({ size = 'md', descriptor = true, animated = false, className = '' }: LogoProps) {
  const s = SIZES[size];
  return (
    <span className={`inline-flex items-center ${s.gap} text-ink ${className}`}>
      <TerratraceMark size={s.mark} animated={animated} />
      <span className="flex flex-col leading-none">
        <span className={`font-display font-semibold tracking-[0.24em] ${s.word}`} style={{ marginRight: '-0.24em' }}>
          TERRATRACE
        </span>
        {descriptor && (
          <span className={`mt-[5px] font-mono uppercase text-ink-3 ${size === 'lg' ? 'text-[10.5px] tracking-[0.3em]' : 'text-[8.5px] tracking-[0.22em]'}`}>
            Earth Observation Intelligence
          </span>
        )}
      </span>
    </span>
  );
}
