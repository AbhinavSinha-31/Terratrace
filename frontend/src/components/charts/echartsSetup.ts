// The ECharts modules the charts use, registered once. Imported only dynamically (EChart.tsx), so ECharts stays out of
// every page chunk; named imports keep the bundle tree-shaken.
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, AriaComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, AriaComponent, CanvasRenderer]);

export { echarts };
