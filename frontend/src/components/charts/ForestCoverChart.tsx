import { useMemo } from 'react';
import type { YearStat } from '../../data/contracts';
import { FOREST, INK } from '../../lib/palette';
import { escapeHtml, fmtHa, fmtKm2 } from '../../lib/format';
import { EChart, chartBase } from './EChart';

/**
 * Forest area per composite (km²), modern era only (Dynamic World mask, 10 m). 1984–2015 is imagery only: the
 * Landsat greenness proxy cannot tell green crops from forest, so those years carry no forest figure.
 */
export function ForestCoverChart({ years: all, selectedYear, window, onSelectYear }: { years: YearStat[]; selectedYear: number; window: { start: number; end: number }; onSelectYear(y: number): void }) {
  const option = useMemo(() => {
    const years = all.filter((y) => y.era === 'modern');
    const cats = years.map((y) => String(y.year));
    // Only analysable years carry a value; others are gaps (null), never 0.
    const km2 = (y: YearStat) => (y.passes_quality && y.forest_ha !== null ? y.forest_ha / 100 : null);
    const s2 = years.map(km2);
    const shade = cats.length ? [String(Math.max(window.start, years[0].year)), String(Math.min(window.end, years[years.length - 1].year))] : null;
    return {
      ...chartBase,
      grid: { left: 8, right: 14, top: 14, bottom: 4, containLabel: true },
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
          name: 'Dynamic World · 10 m', type: 'line', data: s2, connectNulls: false, symbol: 'circle',
          markArea: shade ? { silent: true, itemStyle: { color: 'rgba(69,208,196,0.06)' }, data: [[{ xAxis: shade[0] }, { xAxis: shade[1] }]] } : undefined,
          symbolSize: (_: number, p: { dataIndex: number }) => (years[p.dataIndex].year === selectedYear ? 9 : 6),
          lineStyle: { width: 2, color: FOREST }, itemStyle: { color: FOREST, borderColor: '#0b1117', borderWidth: 2 },
          markLine: {
            silent: true, symbol: 'none',
            label: { show: false },
            data: selectedYear >= (years[0]?.year ?? Infinity) ? [{ xAxis: String(selectedYear), lineStyle: { color: 'rgba(69,208,196,0.7)', type: 'solid', width: 1 } }] : [],
          },
        },
      ],
    };
  }, [all, selectedYear, window.start, window.end]);

  return (
    <EChart option={option} height={170} ariaLabel="Forest area per analysable year from 2016 (Dynamic World forest mask); years before 2016 are imagery only" onClickData={(p) => onSelectYear(Number(p.name))} />
  );
}
