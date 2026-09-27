import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion } from 'framer-motion';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

/** Tween a number towards `value` (ease-out), respecting reduced motion. */
export function useAnimatedNumber(value: number, duration = 650): number {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reduce || !Number.isFinite(value)) { setShown(value); from.current = value; return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const e = 1 - (1 - k) ** 4;
      const v = a + (value - a) * e;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value, duration, reduce]);
  return shown;
}

export function AnimatedNumber({ value, format }: { value: number; format(v: number): string }) {
  const v = useAnimatedNumber(value);
  return <>{format(v)}</>;
}

interface MetricProps {
  label: string;
  value: number | null;
  format(v: number): string;
  unit?: string;
  /** Rendered verbatim instead of an animated number (e.g. "HIGH"). */
  text?: ReactNode;
  delta?: { value: string; direction: 'up' | 'down' | 'flat'; tone: 'bad' | 'good' | 'neutral' };
  caption?: ReactNode;
  size?: 'md' | 'lg';
  accent?: ReactNode;
}

/** TerratraceMetric — label, animated tabular value, unit, delta and caption. */
export function Metric({ label, value, format, unit, text, delta, caption, size = 'md', accent }: MetricProps) {
  const tone = delta?.tone === 'bad' ? 'text-[#ff8a80]' : delta?.tone === 'good' ? 'text-forest' : 'text-ink-2';
  return (
    <div className="min-w-0">
      <div className="t-label flex items-center gap-1.5 text-ink-3">{accent}{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1.5 whitespace-nowrap">
        <span className={`t-data font-medium text-ink ${size === 'lg' ? 'text-[26px] leading-none' : 'text-[20px] leading-none'}`}>
          {text ?? (value === null ? '—' : <AnimatedNumber value={value} format={format} />)}
        </span>
        {unit && value !== null && <span className="text-[11px] text-ink-3">{unit}</span>}
        {delta && (
          <span className={`t-data ml-1 inline-flex items-center gap-0.5 text-[11px] ${tone}`}>
            {delta.direction === 'down' ? <ArrowDownRight size={12} /> : delta.direction === 'up' ? <ArrowUpRight size={12} /> : null}
            {delta.value}
          </span>
        )}
      </div>
      {caption && <div className="mt-1 truncate text-[11px] text-ink-3">{caption}</div>}
    </div>
  );
}
