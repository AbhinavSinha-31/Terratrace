import { ChevronsLeft, Flame, Layers, Map as MapIcon, Satellite, Scan, SquareDashed, TreePine, Type } from 'lucide-react';
import { useCurrentBundle } from '../../data/queries';
import { useUi } from '../../state/store';
import { useImageryLabel } from '../../data/imagerySync';
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
  const imageryLabel = useImageryLabel();

  return (
    <div>
      <div className="flex items-center justify-between px-1 pb-2">
        <div className="t-label flex items-center gap-2 text-ink"><Layers size={13} className="text-accent" /> Layers</div>
        {onCollapse && <IconButton label="Collapse layers" size="sm" onClick={onCollapse}><ChevronsLeft size={15} /></IconButton>}
      </div>
      <div className="space-y-0.5">
        <LayerToggle icon={<Satellite size={14} />} label="Satellite" hint={img ? `${img.label}${img.reference ? ' — stand-in reference, desaturated' : ''}` : `${imageryLabel.title} — ${imageryLabel.sub}`} on={layers.satellite} onChange={(v) => set('satellite', v)}>
          <Segmented label="Imagery source" value={imagery} onChange={setImagery} options={[{ value: 'sentinel', label: 'Annual composite' }, { value: 'hires', label: 'High-res (current)' }]} />
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
        <LayerToggle icon={<MapIcon size={14} />} label="Study boundary" hint="Analysed area and outside mask" on={layers.boundary} onChange={(v) => set('boundary', v)} />
        <LayerToggle icon={<Type size={14} />} label="Place labels" hint="Boundaries and place names (Esri)" on={layers.labels} onChange={(v) => set('labels', v)} />
      </div>

      <div className="mt-4 border-t border-line px-1 pt-4">
        <SectionLabel>Legend</SectionLabel>
        <div className="space-y-3.5">
          {!analysis && <div className="text-[11px] leading-relaxed text-ink-3">Forest, NDVI and change layers appear after a live analysis completes and passes validation. None are simulated.</div>}
          {layers.forest && forestLegend && <Gradient legend={forestLegend} />}
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
