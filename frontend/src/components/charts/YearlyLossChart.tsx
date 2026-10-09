import { useMemo } from 'react';
import { SEVERITIES, type YearStat } from '../../data/contracts';
import { INK, SEVERITY_COLOR, SURFACE } from '../../lib/palette';
import { fmtHa, severityLabel } from '../../lib/format';
import { EChart, chartBase } from './EChart';

const HIST = '#6f8a96';

/**
 * Forest loss as an annual rate (ha / yr) per measured transition (2016 onward; 1984–2015 is imagery only).
 * Annual transitions are stacked by event severity (validated ordinal ramp); loss outside detected events is grey;
 * a transition spanning skipped (unanalysable) years is averaged per year.
 */
export function YearlyLossChart({ years, selectedYear, onSelectYear }: { years: YearStat[]; selectedYear: number; onSelectYear(y: number): void }) {
  // Only measured transitions (analysable year with an analysable predecessor of the same era).
  const rows = useMemo(() => years.filter((y): y is YearStat & { loss_ha: number } => y.passes_quality && y.previous_year !== null && y.loss_ha !== null), [years]);
  const option = useMemo(() => {
    const span = (r: YearStat) => r.year - (r.previous_year ?? r.year - 1);
    const annual = (r: YearStat) => r.era === 'modern' && span(r) === 1;
    const unattributed = rows.map((r) => {
      const sev = SEVERITIES.reduce((a, s) => a + r.loss_by_severity[s], 0);
      return annual(r) ? Math.max(0, r.loss_ha - sev) : r.loss_ha / span(r);
    });
    const top = new Map<number, string>();
    for (const r of rows) {
      const last = [...SEVERITIES].reverse().find((s) => r.loss_by_severity[s] > 0);
      top.set(r.year, last ?? 'hist');
    }
    return {
      ...chartBase,
      grid: { left: 8, right: 8, top: 30, bottom: 4, containLabel: true },
      legend: { top: 0, left: 0, itemWidth: 9, itemHeight: 9, itemGap: 10, icon: 'roundRect', textStyle: { color: INK.secondary, fontSize: 10.5 }, selectedMode: false },
      tooltip: {
        ...chartBase.tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(255,255,255,0.04)' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const r = rows[ps[0].dataIndex];
          const lines = [...SEVERITIES].reverse().filter((s) => r.loss_by_severity[s] > 0)
            .map((s) => `<div style="display:flex;gap:8px;justify-content:space-between"><span style="display:flex;align-items:center;gap:6px;color:${INK.secondary}"><i style="width:8px;height:8px;border-radius:2px;background:${SEVERITY_COLOR[s]};display:inline-block"></i>${severityLabel[s]}</span><span style="font-family:JetBrains Mono">${fmtHa(r.loss_by_severity[s])} ha</span></div>`).join('');
          return `<div style="font-weight:600;margin-bottom:4px">${r.previous_year} → ${r.year} <span style="color:${INK.muted};font-weight:400">· ${r.source === 'landsat' ? 'Landsat' : 'Sentinel-2'}${r.compared_ha !== null ? ` · over ${fmtHa(r.compared_ha)} ha observed in both` : ''}</span></div>${lines}` +
            `<div style="border-top:1px solid rgba(255,255,255,.1);margin-top:6px;padding-top:6px;display:flex;justify-content:space-between;gap:16px"><span>Total · ${r.event_count} events</span><b style="font-family:JetBrains Mono">${fmtHa(r.loss_ha)} ha</b></div>` +
            (span(r) > 1 ? `<div style="color:${INK.muted};margin-top:2px">${span(r)}-year interval · ${fmtHa(r.loss_ha / span(r))} ha/yr</div>` : '');
        },
      },
      xAxis: {
        type: 'category',
        data: rows.map((r) => String(r.year)),
        axisLine: chartBase.axisLine,
        axisTick: { show: false },
        axisLabel: {
          ...chartBase.axisLabel,
          interval: 0,
          formatter: (v: string) => (Number(v) === selectedYear ? `{sel|’${v.slice(2)}}` : `’${v.slice(2)}`),
          rich: { sel: { color: INK.primary, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5 } },
        },
      },
      yAxis: { type: 'value', name: 'ha / yr', nameTextStyle: { color: INK.muted, fontSize: 9.5, align: 'left' }, splitNumber: 3, axisLabel: { ...chartBase.axisLabel, formatter: (v: number) => (v >= 1000 ? `${v / 1000}k` : String(v)) }, splitLine: chartBase.splitLine },
      series: [
        {
          name: 'Outside detected events', type: 'bar', stack: 'loss', barWidth: '60%', color: HIST, itemStyle: { color: HIST },
          data: rows.map((r, i) => ({ value: unattributed[i], itemStyle: { color: HIST, opacity: r.year === selectedYear ? 1 : 0.6, borderColor: SURFACE, borderWidth: unattributed[i] > 0 ? 1 : 0, borderRadius: top.get(r.year) === 'hist' ? [3, 3, 0, 0] : 0 } })),
        },
        ...SEVERITIES.map((s) => ({
          name: severityLabel[s], type: 'bar', stack: 'loss', barWidth: '60%', color: SEVERITY_COLOR[s], itemStyle: { color: SEVERITY_COLOR[s] },
          data: rows.map((r) => ({
            value: r.loss_by_severity[s],
            itemStyle: { color: SEVERITY_COLOR[s], opacity: r.year === selectedYear ? 1 : 0.72, borderColor: SURFACE, borderWidth: r.loss_by_severity[s] > 0 ? 1 : 0, borderRadius: top.get(r.year) === s ? [3, 3, 0, 0] : 0 },
          })),
        })),
      ],
    };
  }, [rows, selectedYear]);

  return <EChart option={option} height={180} ariaLabel="Forest loss per year from 2016, stacked by event severity; loss outside detected events in grey" onClickData={(p) => onSelectYear(Number(p.name))} />;
}
