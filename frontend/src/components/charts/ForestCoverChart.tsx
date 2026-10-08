import { useMemo } from 'react';
import type { YearStat } from '../../data/contracts';
import { FOREST, INK } from '../../lib/palette';
import { escapeHtml, fmtHa, fmtKm2 } from '../../lib/format';
import { EChart, chartBase } from './EChart';

/**
 * Forest area per composite (km²). Two series — Landsat proxy (30 m, dashed) and
 * Dynamic World mask (10 m, solid) — are deliberately not joined: the sensors
 * are not directly comparable. Legend + dash style carry identity (not colour alone).
 */
export function ForestCoverChart({ years, selectedYear, window, onSelectYear }: { years: YearStat[]; selectedYear: number; window: { start: number; end: number }; onSelectYear(y: number): void }) {
  const option = useMemo(() => {
    const cats = years.map((y) => String(y.year));
    // Only analysable years carry a value; others are gaps (null), never 0.
    const km2 = (y: YearStat) => (y.passes_quality && y.forest_ha !== null ? y.forest_ha / 100 : null);
    const land = years.map((y) => (y.era === 'historical' ? km2(y) : null));
    const s2 = years.map((y) => (y.era === 'modern' ? km2(y) : null));
    const hasLand = land.some((v) => v !== null);
    const transition = years.find((y) => y.era === 'modern')?.year;
    return {
      ...chartBase,
      grid: { left: 8, right: 14, top: hasLand ? 30 : 14, bottom: 4, containLabel: true },
      legend: hasLand ? { top: 0, left: 0, itemWidth: 16, itemHeight: 2, textStyle: { color: INK.secondary, fontSize: 10.5 }, selectedMode: false, data: ['Landsat proxy · 30 m', 'Dynamic World · 10 m'] } : undefined,
      tooltip: {
        ...chartBase.tooltip,
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,0.25)' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const y = years[ps[0].dataIndex];
          const head = `<div style="font-weight:600;margin-bottom:4px">${y.year} <span style="color:${INK.muted};font-weight:400">· ${escapeHtml(y.sensor)}</span></div>`;
          const line = (k: string, v: string) => `<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:${INK.secondary}">${k}</span><span style="font-family:JetBrains Mono">${v}</span></div>`;
          if (!y.passes_quality || y.forest_ha === null) return head + `<div style="color:${INK.muted};max-width:240px;white-space:normal">${escapeHtml(y.quality_reason ?? 'Not analysable')}</div>`;
          return head + line('Forest', `${fmtKm2(y.forest_ha / 100)} km²`) +
            (y.forest_pct !== null ? line('Share of observed area', `${y.forest_pct.toFixed(1)}%`) : '') +
            (y.coverage_pct !== null ? line('Observed', `${y.coverage_pct.toFixed(0)}% of area`) : '') +
            (y.net_change_ha !== null ? line(`Net vs ${y.previous_year}`, `${y.net_change_ha > 0 ? '+' : ''}${fmtHa(y.net_change_ha)} ha`) : '');
        },
      },
      xAxis: {
        type: 'category', data: cats, boundaryGap: false,
        axisLine: chartBase.axisLine, axisTick: { show: false },
        axisLabel: { ...chartBase.axisLabel, interval: (i: number) => years[i].year % 5 === 0 || years[i].year === years[0].year || years[i].year === years[years.length - 1].year, formatter: (v: string) => `’${v.slice(2)}` },
      },
      yAxis: { type: 'value', scale: true, splitNumber: 3, axisLabel: { ...chartBase.axisLabel, formatter: (v: number) => fmtKm2(v) }, splitLine: chartBase.splitLine },
      series: [
        {
          name: 'Landsat proxy · 30 m', type: 'line', data: land, connectNulls: false, symbol: 'circle', symbolSize: 5,
          lineStyle: { width: 2, color: FOREST, type: 'dashed' }, itemStyle: { color: FOREST, borderColor: '#0b1117', borderWidth: 1.5 },
          markArea: { silent: true, itemStyle: { color: 'rgba(69,208,196,0.06)' }, data: [[{ xAxis: String(window.start) }, { xAxis: String(window.end) }]] },
        },
        {
          name: 'Dynamic World · 10 m', type: 'line', data: s2, connectNulls: false, symbol: 'circle',
          symbolSize: (_: number, p: { dataIndex: number }) => (years[p.dataIndex].year === selectedYear ? 9 : 6),
          lineStyle: { width: 2, color: FOREST }, itemStyle: { color: FOREST, borderColor: '#0b1117', borderWidth: 2 },
          markLine: {
            silent: true, symbol: 'none',
            label: { show: false },
            data: [
              { xAxis: String(selectedYear), lineStyle: { color: 'rgba(69,208,196,0.7)', type: 'solid', width: 1 } },
              ...(hasLand && transition ? [{ xAxis: String(transition), lineStyle: { color: 'rgba(255,255,255,0.18)', type: 'dotted', width: 1 } }] : []),
            ],
          },
        },
      ],
    };
  }, [years, selectedYear, window.start, window.end]);

  return (
    <EChart option={option} height={170} ariaLabel="Forest area per analysable composite year; Landsat proxy (historical) and Dynamic World mask (modern) are not directly comparable" onClickData={(p) => onSelectYear(Number(p.name))} />
  );
}
