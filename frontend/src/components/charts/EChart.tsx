import { useEffect, useRef } from 'react';
import type { ECharts, EChartsCoreOption } from 'echarts/core';
import { INK } from '../../lib/palette';

type EChartsCore = typeof import('echarts/core');
let loading: Promise<EChartsCore> | null = null;

/** ECharts (~175 kB gzip) is fetched when the first chart mounts, never as part of a page's own chunk. */
function loadECharts(): Promise<EChartsCore> {
  return (loading ??= import('./echartsSetup').then((m) => m.echarts).catch((e) => { loading = null; throw e; }));
}

/** Shared axis/tooltip styling: recessive grid, muted axis ink, glass tooltip. */
export const chartBase = {
  animationDuration: 600,
  animationEasing: 'cubicOut',
  textStyle: { fontFamily: 'Inter Variable, system-ui, sans-serif', color: INK.secondary },
  aria: { enabled: true },
  tooltip: {
    backgroundColor: 'rgba(9,14,19,0.94)',
    borderColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    padding: [8, 11],
    textStyle: { color: INK.primary, fontSize: 12 },
    extraCssText: 'border-radius:10px;box-shadow:0 12px 30px -10px rgba(0,0,0,.8);backdrop-filter:blur(8px);',
  },
  axisLabel: { color: INK.muted, fontSize: 10.5, fontFamily: 'JetBrains Mono, monospace' },
  splitLine: { lineStyle: { color: INK.grid } },
  axisLine: { lineStyle: { color: INK.axis } },
} as const;

interface Props {
  option: EChartsCoreOption;
  height: number;
  onClickData?: (p: { name: string; dataIndex: number; seriesName?: string }) => void;
  ariaLabel: string;
}

export function EChart({ option, height, onClickData, ariaLabel }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const clickRef = useRef(onClickData);
  clickRef.current = onClickData;
  const optionRef = useRef(option);
  optionRef.current = option;

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    loadECharts().then((echarts) => {
      if (disposed || !el.current) return;
      cleanup = mount(echarts, el.current);
    }).catch(() => {});   // the chart's aria-label still describes it; the rest of the view is unaffected
    return () => { disposed = true; cleanup(); };
  }, []);

  function mount(echarts: EChartsCore, node: HTMLDivElement): () => void {
    const c = echarts.init(node, undefined, { renderer: 'canvas' });
    chart.current = c;
    c.setOption(optionRef.current, { notMerge: true });
    // Axis-level clicks: anywhere in a column selects it (hit target larger than the mark).
    c.getZr().on('click', (e) => {
      if (!clickRef.current) return;
      const pt = [e.offsetX, e.offsetY];
      if (!c.containPixel('grid', pt)) return;
      const [idx] = c.convertFromPixel({ seriesIndex: 0 }, pt) as number[];
      const opt = c.getOption() as { xAxis?: { data?: (string | number)[] }[] };
      const cats = opt.xAxis?.[0]?.data;
      if (cats && Number.isFinite(idx)) {
        const i = Math.max(0, Math.min(cats.length - 1, Math.round(idx)));
        clickRef.current({ name: String(cats[i]), dataIndex: i });
      }
    });
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(node);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={el} style={{ height }} role="img" aria-label={ariaLabel} className={onClickData ? 'cursor-pointer' : ''} />;
}
