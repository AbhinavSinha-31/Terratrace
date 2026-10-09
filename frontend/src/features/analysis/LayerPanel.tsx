import { ChevronsLeft, Flame, Layers, Map as MapIcon, Mountain, Satellite, Scan, SquareDashed, TreePine, Type } from 'lucide-react';
import { useAreaContext, useCurrentBundle } from '../../data/queries';
import { useUi } from '../../state/store';
import { useImageryState } from '../../data/viewState';
import { SEVERITIES, type GradientLegend } from '../../data/contracts';
import { SEVERITY_COLOR, SEVERITY_LINE } from '../../lib/palette';
import { severityLabel } from '../../lib/format';
import { IconButton, LayerToggle, SectionLabel, Segmented } from '../../design';

function Gradient({ legend }: { legend: GradientLegend }) {
  const lo = legend.stops[0][0], hi = legend.stops[legend.stops.length - 1][0];
  const css = legend.stops.map(([v, c]) => `${c} ${hi === lo ? 0 : (((v - lo) / (hi - lo)) * 100).toFixed(1)}%`).join(', ');
  return (
    <div>
      <div className="mb-1 flex justify-between text-[10.5px] text-ink-2"><span>{legend.title}</span>{legend.note && <span className="text-ink-4">{legend.note}</span>}</div>
      <div className="h-1.5 rounded-full" style={{ background: `linear-gradient(90deg, ${css})` }} />
      <div className="t-data mt-1 flex justify-between text-[9.5px] text-ink-3"><span>{legend.min_label}</span><span>{legend.max_label}</span></div>
    </div>
  );
}

/** TERRATRACE layer control with dynamic legend. */
export function LayerPanel({ onCollapse }: { onCollapse?: () => void }) {
  // Analysis layers exist only for a READY live analysis; otherwise only real imagery is offered.
  const analysis = useCurrentBundle();
  const layers = useUi((s) => s.layers);
  const set = useUi((s) => s.setLayer);
  const imagery = useUi((s) => s.imagery);
  const setImagery = useUi((s) => s.setImagery);
  const setOpacity = useUi((s) => s.setForestOpacity);
  const year = useUi((s) => s.investigation.imageryYear);
  const forestLegend = analysis?.layers.overlays.find((o) => o.kind === 'forest')?.legend;
  const ndviLegend = analysis?.layers.overlays.find((o) => o.kind === 'ndvi')?.legend;
  const hasNdvi = !!ndviLegend;
  const img = analysis?.layers.imagery.find((i) => i.year === year);
  const imageryState = useImageryState();
  // Reference context layers (never TerraTrace results): available whatever the analysis status.
  const studyId = useUi((s) => s.investigation.study?.id ?? null);
  const ctxLayers = useAreaContext(studyId).data?.layers ?? [];
  const ctxOn = useUi((s) => s.contextLayers);
  const setCtx = useUi((s) => s.setContextLayer);

  return (
    <div>
      <div className="flex items-center justify-between px-1 pb-2">
        <div className="t-label flex items-center gap-2 text-ink"><Layers size={13} className="text-accent" /> Layers</div>
        {onCollapse && <IconButton label="Collapse layers" size="sm" onClick={onCollapse}><ChevronsLeft size={15} /></IconButton>}
      </div>
      <div className="space-y-0.5">
        <LayerToggle icon={<Satellite size={14} />} label="Satellite imagery" hint={imageryState.label} on={layers.satellite} onChange={(v) => set('satellite', v)}>
          {/* The selected segment is the source actually rendered; a year appears only in the line below, and only
              when the displayed imagery represents that year. */}
          <Segmented label="Imagery source" value={imagery} onChange={setImagery} options={[{ value: 'sentinel', label: 'Annual composite' }, { value: 'hires', label: 'Current' }]} />
          <div className="mt-1.5 text-[10.5px] leading-snug text-ink-3" data-testid="current-imagery" data-source={imageryState.source ?? ''}>
            Viewing: <span className="text-ink-2">{imageryState.label}</span>
            {imageryState.state === 'AVAILABLE' ? ' · imagery only' : imageryState.message ? ` — ${imageryState.message}` : ''}
          </div>
        </LayerToggle>
        {analysis && <>
        <LayerToggle icon={<TreePine size={14} />} label="Forest cover" hint={`Operational forest mask for ${year}`} on={layers.forest} onChange={(v) => set('forest', v)}>
          <div className="flex items-center gap-3">
            <input className="tt-range" type="range" min={0.1} max={0.75} step={0.05} value={layers.forestOpacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Forest layer opacity" />
            <span className="t-data w-8 text-right text-[10px] text-ink-3">{Math.round(layers.forestOpacity * 100)}%</span>
          </div>
        </LayerToggle>
        {hasNdvi && <LayerToggle icon={<Scan size={14} />} label="NDVI" hint="Vegetation greenness index for the selected year" on={layers.ndvi} onChange={(v) => set('ndvi', v)} />}
        <LayerToggle icon={<SquareDashed size={14} />} label="Detected change" hint="Change polygons that passed the detection rule" on={layers.change} onChange={(v) => set('change', v)} />
        <LayerToggle icon={<Flame size={14} />} label="Change intensity" hint="Density of detected change, weighted by area" on={layers.intensity} onChange={(v) => set('intensity', v)} />
        </>}
        {ctxLayers.length > 0 && (
          <div className="pt-2" data-testid="context-layers">
            <div className="t-label px-1 pb-1 pt-1 !text-[9px] text-ink-4">Reference context · not TerraTrace results</div>
            {ctxLayers.map((l) => (
              <LayerToggle key={l.id} icon={l.id === 'hillshade' || l.id === 'slope' ? <Mountain size={14} /> : <TreePine size={14} />}
                label={l.label} hint={`${l.dataset} · ${l.year_label}`} on={!!ctxOn[l.id]} onChange={(v) => setCtx(l.id, v)} />
            ))}
          </div>
        )}
        <LayerToggle icon={<MapIcon size={14} />} label="Study boundary" hint="Analysed area and outside mask" on={layers.boundary} onChange={(v) => set('boundary', v)} />
        <LayerToggle icon={<Type size={14} />} label="Place labels" hint="Boundaries and place names (Esri)" on={layers.labels} onChange={(v) => set('labels', v)} />
      </div>

      <div className="mt-4 border-t border-line px-1 pt-4">
        <SectionLabel>Legend</SectionLabel>
        <div className="space-y-3.5">
          {!analysis && <div className="text-[11px] leading-relaxed text-ink-3">Forest, NDVI and change layers appear after a live analysis completes and passes validation. None are simulated.</div>}
          {layers.forest && forestLegend && <Gradient legend={forestLegend} />}
          {ctxOn.slope && <Gradient legend={{ type: 'gradient', title: 'Slope · Copernicus DEM GLO-30', note: 'reference', stops: [[0, '#1a9850'], [15, '#fee08b'], [30, '#f46d43'], [45, '#a50026']], min_label: '0°', max_label: '45°+' }} />}
          {ctxOn.treecover2000 && <Gradient legend={{ type: 'gradient', title: 'Tree canopy · Hansen v1.13 · year 2000', note: 'reference', stops: [[30, '#c7e9c0'], [65, '#41ab5d'], [100, '#00441b']], min_label: '30 %', max_label: '100 %' }} />}
          {ctxOn.lossyear && <Gradient legend={{ type: 'gradient', title: 'Tree cover loss year · Hansen v1.13', note: 'reference', stops: [[2001, '#ffffb2'], [2013, '#fd8d3c'], [2025, '#bd0026']], min_label: '2001', max_label: '2025' }} />}
          {layers.ndvi && ndviLegend && <Gradient legend={ndviLegend} />}
          {analysis && layers.change && (
            <div>
              <div className="mb-1.5 text-[10.5px] text-ink-2">Detected change · severity</div>
              <div className="grid grid-cols-2 gap-1.5">
                {SEVERITIES.map((s) => (
                  <div key={s} className="flex items-center gap-2 text-[11px] text-ink-2">
                    <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: SEVERITY_COLOR[s], boxShadow: `0 0 0 1px ${SEVERITY_LINE[s]}` }} />{severityLabel[s]}
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[10.5px] text-ink-3">Pulsing ring = detected in {year}</div>
            </div>
          )}
          {analysis && layers.intensity && <div className="flex items-center gap-2 text-[10.5px] text-ink-2"><span className="h-2.5 w-10 rounded-full" style={{ background: 'linear-gradient(90deg, rgba(236,122,60,.2), #d4452f, #ffd6aa)' }} />Change intensity</div>}
          {layers.boundary && <div className="flex items-center gap-2 text-[10.5px] text-ink-2"><span className="h-0 w-6 border-t border-dashed border-accent" />Study boundary</div>}
          {analysis && !layers.forest && !layers.ndvi && !layers.change && !layers.intensity && !layers.boundary && <div className="text-[11px] text-ink-3">No analysis layers visible.</div>}
        </div>
      </div>
      {img && (
        <p className="mt-4 px-1 text-[10px] leading-relaxed text-ink-4">{img.reference ? img.note : img.attribution}</p>
      )}
    </div>
  );
}
