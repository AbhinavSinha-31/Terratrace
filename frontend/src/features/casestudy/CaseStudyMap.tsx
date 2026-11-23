import { useEffect, useRef, useState } from 'react';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import { ArrowRightLeft, Layers, RotateCcw } from 'lucide-react';
import { LayerToggle, Segmented, Skeleton, StateView, Switch } from '../../design';
import { useBasemaps } from '../../data/queries';
import type { BaseLayer } from '../../data/contracts';
import { caseStudyAsset, useCaseStudyTiles, type CaseStudyDoc, type TilesManifest } from './data';

// Land surface temperature was withdrawn in pipeline 1.0.2 (pending a weather-normalised method): no temperature layer.
type Kind = 'lulc' | 'change';
const OVERLAY = 'TerraTrace LULC pipeline · Landsat Collection 2 (USGS), 30 m';

/** Absolute tile URL with its {z}/{x}/{y} placeholders intact (URL() would percent-encode the braces). */
const absolute = (path: string) => new URL(path, window.location.href).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
const km2 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function style(id: string, t: TilesManifest): StyleSpecification {
  const sources: StyleSpecification['sources'] = {
    boundary: { type: 'geojson', data: absolute(caseStudyAsset(id, 'boundary.geojson')) },
  };
  for (const l of t.layers) {
    sources[l.id] = {
      type: 'raster', tiles: [absolute(caseStudyAsset(id, t.tiles.replace('{layer}', l.id)))], tileSize: t.tile_size,
      minzoom: t.minzoom, maxzoom: t.maxzoom, bounds: t.bounds, attribution: OVERLAY,
    };
  }
  return {
    version: 8,
    sources,
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#03060a' } },
      // The basemap (backend-owned URLs, same layer and paint as the main map) is inserted below this anchor.
      { id: 'anchor-base', type: 'background', paint: { 'background-opacity': 0 } },
      // Nearest-neighbour resampling: beyond z12 the 30 m pixels are enlarged, never smoothed into new values.
      ...t.layers.map((l) => ({
        id: l.id, type: 'raster' as const, source: l.id, layout: { visibility: 'none' as const },
        paint: { 'raster-opacity': 0.85, 'raster-resampling': 'nearest' as const, 'raster-fade-duration': 150 },
      })),
      { id: 'anchor-labels', type: 'background', paint: { 'background-opacity': 0 } },
      { id: 'boundary-casing', type: 'line', source: 'boundary', paint: { 'line-color': 'rgba(0,0,0,0.55)', 'line-width': 3.2 } },
      { id: 'boundary', type: 'line', source: 'boundary', paint: { 'line-color': '#f3f5f7', 'line-width': 1.2 } },
    ],
  };
}

function Swatch({ color }: { color: string }) {
  return <span className="mt-[3px] h-2.5 w-2.5 shrink-0 rounded-[2px] shadow-[0_0_0_1px_rgba(255,255,255,0.15)]" style={{ background: color }} />;
}

function Legend({ d, t, kind, year }: { d: CaseStudyDoc; t: TilesManifest; kind: Kind | null; year: number }) {
  if (!kind) return <p className="text-[11.5px] text-ink-3">No analysis layer shown — basemap only.</p>;
  if (kind === 'lulc') {
    const area = (code: number) => d.areas.find((a) => a.year === year && a.class_code === code);
    return (
      <ul className="space-y-1 text-[12px]" data-testid="case-map-legend">
        {t.legends.lulc.filter((c) => c.code > 0).map((c) => (
          <li key={c.code} className="flex gap-2"><Swatch color={c.color} />
            <span className="min-w-0 flex-1 text-ink-2">{c.name}</span>
            <span className="t-data shrink-0 text-ink">{area(c.code) ? `${area(c.code)!.percent.toFixed(1)} %` : '—'}</span>
          </li>
        ))}
        <li className="pt-1 text-[11px] text-ink-3">Share of classified area, {year}</li>
      </ul>
    );
  }
  const ch = t.layers.find((l) => l.kind === 'change');
  const values = ch ? t.legends.change_km2[ch.id] ?? [] : [];
  return (
    <ul className="space-y-1 text-[12px]" data-testid="case-map-legend">
      {t.legends.change.map((c, i) => (
        <li key={c.code} className="flex gap-2"><Swatch color={c.color} />
          <span className="min-w-0 flex-1 text-ink-2">{c.name}</span>
          <span className="t-data shrink-0 text-ink">{values[i] !== undefined ? `${km2(values[i])} km²` : '—'}</span>
        </li>
      ))}
      <li className="pt-1 text-[11px] leading-snug text-ink-3">Gross pixel changes; errors of both maps add up here — use the net figures below.</li>
    </ul>
  );
}

/** The case study's interactive map: static tiles from the pipeline's own rasters over the main map's basemap. */
export function CaseStudyMap({ d }: { d: CaseStudyDoc }) {
  const { data: t, isError, refetch } = useCaseStudyTiles(d.id);
  const { data: basemaps } = useBasemaps();
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const years = d.study.years;
  const [kind, setKind] = useState<Kind | null>('lulc');
  const [year, setYear] = useState(years[years.length - 1]);
  const [opacity, setOpacity] = useState(0.85);
  const [labels, setLabels] = useState(true);
  const [outline, setOutline] = useState(true);
  const change = t?.layers.find((l) => l.kind === 'change');
  const active = kind === 'lulc' ? `lulc_${year}` : kind === 'change' ? change?.id : undefined;

  useEffect(() => {
    if (!t || !el.current) return;
    const [w, s, e, n] = t.bounds;
    const m = new maplibregl.Map({
      container: el.current, style: style(d.id, t), bounds: t.bounds, fitBoundsOptions: { padding: 20 },
      minZoom: t.minzoom, maxZoom: 14, maxBounds: [w - 0.6, s - 0.4, e + 0.6, n + 0.4], renderWorldCopies: false,
      dragRotate: false, pitchWithRotate: false, cooperativeGestures: true, attributionControl: { compact: true },
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.once('load', () => setReady(true));
    map.current = m;
    return () => { m.remove(); map.current = null; setReady(false); };
  }, [d.id, t]);

  // Basemap and place labels: the main map's layers, paint and attribution.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !basemaps || m.getSource('img-base')) return;
    const src = (l: BaseLayer) => ({ type: 'raster' as const, tiles: l.tiles, tileSize: l.tile_size, maxzoom: l.max_zoom, attribution: l.attribution });
    m.addSource('img-base', src(basemaps.globe));
    m.addSource('labels', src(basemaps.labels));
    m.addLayer({ id: 'img-base', type: 'raster', source: 'img-base', paint: { 'raster-fade-duration': 300, 'raster-saturation': -0.05, 'raster-contrast': 0.05 } }, 'anchor-base');
    m.addLayer({ id: 'labels', type: 'raster', source: 'labels', layout: { visibility: labels ? 'visible' : 'none' }, paint: { 'raster-opacity': 0.85 } }, 'anchor-labels');
  }, [ready, basemaps, labels]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !t) return;
    for (const l of t.layers) {
      m.setLayoutProperty(l.id, 'visibility', l.id === active ? 'visible' : 'none');
      m.setPaintProperty(l.id, 'raster-opacity', opacity);
    }
    if (m.getLayer('labels')) m.setLayoutProperty('labels', 'visibility', labels ? 'visible' : 'none');
    for (const id of ['boundary', 'boundary-casing']) m.setLayoutProperty(id, 'visibility', outline ? 'visible' : 'none');
  }, [ready, t, active, opacity, labels, outline]);

  if (isError) {
    return <div className="tt-panel"><StateView kind="service-unavailable" title="Map unavailable" onRetry={() => refetch()}>The map tiles could not be loaded. The figures below are unaffected.</StateView></div>;
  }
  const toggle = (k: Kind) => (on: boolean) => setKind(on ? k : null);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_288px]" data-testid="case-study-map">
      <div className="relative h-[clamp(340px,64vh,560px)] overflow-hidden rounded-md bg-[#03060a] shadow-[0_0_0_1px_rgba(255,255,255,0.1)]">
        {/* Sized by width/height, not inset: maplibre-gl.css makes the map container position: relative. */}
        <div ref={el} className="h-full w-full" />
        {!ready && <Skeleton className="absolute inset-0 rounded-md" />}
        <button onClick={() => t && map.current?.fitBounds(t.bounds, { padding: 20 })} title="Show the whole study area"
          className="tt-press absolute left-2.5 top-2.5 flex h-8 items-center gap-1.5 rounded-md bg-[#07090c]/85 px-2.5 text-[11.5px] text-ink-2 shadow-[0_0_0_1px_rgba(255,255,255,0.1)] hover:text-ink">
          <RotateCcw size={13} /> Whole area
        </button>
      </div>
      <div className="tt-panel space-y-3 p-3">
        <div>
          <div className="t-label mb-1 px-2 text-ink-3">Layers</div>
          <LayerToggle icon={<Layers size={14} />} label="Land cover" hint="Random Forest classes, 30 m" on={kind === 'lulc'} onChange={toggle('lulc')} />
          {change?.kind === 'change' && (
            <LayerToggle icon={<ArrowRightLeft size={14} />} label={`Change ${change.from_year} → ${change.to_year}`} hint="Pixel-by-pixel comparison of the two land-cover maps"
              on={kind === 'change'} onChange={toggle('change')} />
          )}
        </div>
        <div className="space-y-1.5 px-2">
          <div className="t-label text-ink-3">Year</div>
          {kind === 'change' && change?.kind === 'change'
            ? <p className="text-[11.5px] text-ink-3">The change layer compares {change.from_year} and {change.to_year}.</p>
            : <Segmented<string> label="Year" size="md" value={String(year)} onChange={(v) => setYear(Number(v))} options={years.map((y) => ({ value: String(y), label: String(y) }))} />}
        </div>
        <label className="block space-y-1 px-2">
          <span className="flex justify-between"><span className="t-label text-ink-3">Opacity</span><span className="t-data text-[11px] text-ink-2">{Math.round(opacity * 100)} %</span></span>
          <input className="tt-range" type="range" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Analysis layer opacity" />
        </label>
        <div className="space-y-2 px-2 text-[12px] text-ink-2">
          <div className="flex items-center justify-between gap-3"><span>Place labels</span><Switch on={labels} onChange={setLabels} label="Place labels" /></div>
          <div className="flex items-center justify-between gap-3"><span>Study-area outline</span><Switch on={outline} onChange={setOutline} label="Study-area outline" /></div>
        </div>
        <div className="border-t border-line px-2 pt-3">
          {t ? <Legend d={d} t={t} kind={kind} year={year} /> : <Skeleton className="h-20 rounded-md" />}
        </div>
      </div>
    </div>
  );
}
