import { useMemo } from 'react';
import type { ChangeEventProps } from '../../data/contracts';
import { INK, SIGNAL } from '../../lib/palette';
import { fmtIndex } from '../../lib/format';
import { EChart, chartBase } from './EChart';

const SERIES = [
  { key: 'ndvi', name: 'NDVI', color: SIGNAL.ndvi },
  { key: 'nbr', name: 'NBR', color: SIGNAL.nbr },
  { key: 'tree_prob', name: 'Tree prob.', color: SIGNAL.tree_prob },
] as const;

/**
 * Per-event spectral trajectory. All three are unitless indices on one shared
 * axis (no dual axis). Legend + direct end labels; the change period is shaded.
 */
export function SignalChart({ event }: { event: ChangeEventProps }) {
  const option = useMemo(() => {
    const ts = event.timeseries;
    return {
      ...chartBase,
      grid: { left: 6, right: 62, top: 30, bottom: 4, containLabel: true },
      legend: { top: 0, left: 0, itemWidth: 14, itemHeight: 3, icon: 'rect', textStyle: { color: INK.secondary, fontSize: 11 }, selectedMode: false },
      tooltip: {
        ...chartBase.tooltip,
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,0.25)' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const p = ts[ps[0].dataIndex];
          return `<div style="font-weight:600;margin-bottom:4px">${p.year}</div>` +
            SERIES.map((s) => `<div style="display:flex;justify-content:space-between;gap:18px"><span style="display:flex;align-items:center;gap:6px;color:${INK.secondary}"><i style="width:10px;height:2px;background:${s.color};display:inline-block"></i>${s.name}</span><span style="font-family:JetBrains Mono">${fmtIndex(p[s.key])}</span></div>`).join('');
        },
      },
      xAxis: {
        type: 'category',
        data: ts.map((p) => String(p.year)),
        boundaryGap: false,
        axisLine: chartBase.axisLine,
        axisTick: { show: false },
        axisLabel: { ...chartBase.axisLabel, formatter: (v: string) => `’${v.slice(2)}` },
      },
      yAxis: {
        type: 'value',
        min: -0.3,
        max: 1,
        interval: 0.5,
        axisLabel: { ...chartBase.axisLabel, formatter: (v: number) => fmtIndex(v) },
        splitLine: chartBase.splitLine,
      },
      series: SERIES.map((s, i) => ({
        name: s.name,
        type: 'line',
        data: ts.map((p) => p[s.key]),
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: false,
        lineStyle: { width: 2, color: s.color },
        itemStyle: { color: s.color, borderColor: '#0b1117', borderWidth: 2 },
        endLabel: {
          show: true,
          formatter: () => s.name,
          color: INK.secondary,
          fontSize: 10.5,
          offset: [6, i === 0 ? -6 : i === 2 ? 6 : 0],
        },
        markArea:
          i === 0
            ? {
                silent: true,
                itemStyle: { color: 'rgba(212,69,47,0.12)', borderColor: 'rgba(255,107,82,0.35)', borderWidth: 1, borderType: 'dashed' },
                label: { show: true, position: 'insideTop', color: INK.secondary, fontSize: 10, formatter: 'change' },
                data: [[{ xAxis: String(event.year_from) }, { xAxis: String(event.year_to) }]],
              }
            : undefined,
      })),
    };
  }, [event]);

  return (
    <EChart
      option={option}
      height={180}
      ariaLabel={`NDVI, NBR and tree probability from ${event.timeseries[0].year} to ${event.timeseries[event.timeseries.length - 1].year}; change between ${event.year_from} and ${event.year_to}`}
    />
  );
}
