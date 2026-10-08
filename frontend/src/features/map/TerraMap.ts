import maplibregl, {
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSource,
  type ImageSource,
  type Map as MlMap,
  type StyleSpecification,
} from 'maplibre-gl';
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';
import type { AoiGeometry, BaseLayer, Basemaps, ChangeEvent, ChangeType, ImageryDecision, LayerCatalog, Severity, StudyArea } from '../../data/contracts';
import type { ImageryMode, LayerToggles } from '../../state/store';
import type { ExploreRegion } from '../../lib/regions';
import { SEVERITY_COLOR, SEVERITY_LINE } from '../../lib/palette';
import { changeTypeLabel, escapeHtml, fmtHa, severityLabel } from '../../lib/format';
import { nightPolygons } from '../../lib/solar';
import { THROTTLED, eeTiles, registerEeTiles } from './eeTiles';

export interface GlobalHotspot {
  lon: number;
  lat: number;
  area_ha: number;
  severity: Severity;
}

/** Desired map state. TerraMap reconciles the MapLibre style against it. */
export interface MapState {
  areas: StudyArea[];
  regions: ExploreRegion[];
  aoi: StudyArea | null;
  catalog: LayerCatalog | null;
  /** Static base layers from the backend (URLs are never built here). */
  basemaps: Basemaps | null;
  /** Backend imagery decision for the open AOI + this map's year (real Earth Engine imagery; never analysis). */
  yearImagery: ImageryDecision | null;
  /** The area whose live imagery is drawn: the open study, or a registered search/drawn selection before any analysis. */
  imageryAoi: StudyArea | null;
  events: ChangeEvent[];
  hotspots: GlobalHotspot[];
  year: number;
  imagery: ImageryMode;
  layers: LayerToggles;
  severities: Severity[];
  types: ChangeType[];
  selectedId: string | null;
  hoveredId: string | null;
  hoveredAoiId: string | null;
  draft: AoiGeometry | null;
  /** Searched / located point [lon, lat] — a pin marker (never a result). */
  pin: [number, number] | null;
  drawing: boolean;
  spin: boolean;
  reducedMotion: boolean;
}

export interface TerraMapHandlers {
  onEventClick?(id: string): void;
  onEventHover?(id: string | null): void;
  onAoiClick?(id: string): void;
  onAoiHover?(id: string | null): void;
  onRegionClick?(r: ExploreRegion): void;
  onMapClick?(lngLat: [number, number]): void;
  onTileError?(): void;
  onView?(v: { lng: number; lat: number; zoom: number; bearing: number }): void;
  onPointer?(p: { lng: number; lat: number } | null): void;
}

export interface Padding { top: number; bottom: number; left: number; right: number }

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const NO_PAD = { top: 0, bottom: 0, left: 0, right: 0 };
const ACCENT = '#45d0c4';
const sevMatch = (colors: Record<Severity, string>): ExpressionSpecification => [
  'match', ['get', 'severity'],
  'low', colors.low, 'moderate', colors.moderate, 'high', colors.high, 'critical', colors.critical,
  '#9aa5ad',
];
// Marching-ants sequence for the draft AOI boundary.
const DASHES: number[][] = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];

function baseStyle(): StyleSpecification {
  return {
    version: 8,
    projection: { type: 'globe' },
    sky: {
      'sky-color': '#040a12',
      'horizon-color': '#16566a',
      'fog-color': '#040a12',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.8,
      'fog-ground-blend': 0.9,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 4, 0.9, 7, 0],
    },
    sources: {
      night: { type: 'geojson', data: nightPolygons() },
      'global-hotspots': { type: 'geojson', data: EMPTY },
      'aoi-all': { type: 'geojson', data: EMPTY, promoteId: 'id' },
      'aoi-mask': { type: 'geojson', data: EMPTY },
      events: { type: 'geojson', data: EMPTY, promoteId: 'id' },
      'event-points': { type: 'geojson', data: EMPTY, promoteId: 'id' },
      draft: { type: 'geojson', data: EMPTY },
      'draft-vertices': { type: 'geojson', data: EMPTY },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#03060a', 'background-opacity': 0 } },
      // Base layers (backend-owned URLs) are inserted below these anchors once /api/imagery/basemaps arrives.
      { id: 'anchor-base', type: 'background', paint: { 'background-opacity': 0 } },
      { id: 'anchor-imagery', type: 'background', paint: { 'background-opacity': 0 } },
      { id: 'anchor-reference', type: 'background', paint: { 'background-opacity': 0 } },
      { id: 'night', type: 'fill', source: 'night', paint: { 'fill-color': '#01040a', 'fill-opacity': 0.2, 'fill-antialias': false } },
      { id: 'anchor-overlays', type: 'background', paint: { 'background-opacity': 0 } },
      // Dims everything OUTSIDE the study area — above the analysis overlays (forest tiles are square and spill past
      // the boundary; the live imagery is clipped to it), below change polygons, boundary and markers.
      { id: 'aoi-mask', type: 'fill', source: 'aoi-mask', paint: { 'fill-color': '#020406', 'fill-opacity': 0.78 } },
      { id: 'anchor-labels', type: 'background', paint: { 'background-opacity': 0 } },
      {
        id: 'global-hotspots-glow', type: 'circle', source: 'global-hotspots',
        paint: {
          // Glow wider than the marker reticle (11 px) so detected change stays visible around it.
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['interpolate', ['linear'], ['get', 'area_ha'], 0, 7, 1500, 16], 8, 30],
          'circle-color': sevMatch(SEVERITY_COLOR), 'circle-blur': 0.9, 'circle-opacity': 0.6,
        },
      },
      {
        id: 'global-hotspots', type: 'circle', source: 'global-hotspots',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 2.2, 8, 4.5], 'circle-color': sevMatch(SEVERITY_LINE), 'circle-opacity': 0.95, 'circle-stroke-width': 0.6, 'circle-stroke-color': 'rgba(0,0,0,0.5)' },
      },
      {
        id: 'hotspots', type: 'heatmap', source: 'event-points', maxzoom: 13,
        paint: {
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'area_ha'], 0, 0.15, 800, 1],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 0.7, 12, 1.5],
          // An overlay, not a replacement: kept small and translucent so the imagery stays readable underneath.
          'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 6, 8, 10, 24, 13, 64],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 11, 0.32, 13, 0],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.15, 'rgba(236,122,60,0.12)', 0.4, 'rgba(236,122,60,0.32)', 0.7, 'rgba(212,69,47,0.5)', 1, 'rgba(255,214,170,0.7)'],
        },
      },
      { id: 'events-fill', type: 'fill', source: 'events', paint: { 'fill-color': sevMatch(SEVERITY_COLOR), 'fill-opacity': 0.2, 'fill-opacity-transition': { duration: 250 } } },
      {
        id: 'events-line', type: 'line', source: 'events',
        paint: { 'line-color': sevMatch(SEVERITY_LINE), 'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.4, 1.2], 'line-opacity': 0.95 },
      },
      // Study boundary sits above the change polygons and below the event markers.
      {
        id: 'aoi-glow', type: 'line', source: 'aoi-all',
        paint: {
          'line-color': ACCENT, 'line-width': 10, 'line-blur': 8,
          'line-opacity': ['case', ['boolean', ['feature-state', 'active'], false], 0.3, ['boolean', ['feature-state', 'hover'], false], 0.4, 0],
          'line-opacity-transition': { duration: 300 },
        },
      },
      {
        id: 'aoi-outline', type: 'line', source: 'aoi-all',
        paint: {
          'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ffffff', ACCENT],
          'line-width': ['case', ['boolean', ['feature-state', 'active'], false], 1.4, ['boolean', ['feature-state', 'hover'], false], 1.6, 1],
          'line-opacity': ['case', ['boolean', ['feature-state', 'active'], false], 0.95, ['boolean', ['feature-state', 'hover'], false], 1, 0.55],
          'line-dasharray': [4, 3],
        },
      },
      { id: 'events-selected-halo', type: 'line', source: 'events', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.16, 'line-blur': 3 } },
      { id: 'events-selected', type: 'line', source: 'events', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2.5, 1.5] } },
      {
        id: 'events-pulse', type: 'circle', source: 'event-points',
        paint: { 'circle-radius': 6, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 1, 'circle-stroke-color': sevMatch(SEVERITY_LINE), 'circle-stroke-opacity': 0.55, 'circle-pitch-alignment': 'map' },
      },
      { id: 'draft-fill', type: 'fill', source: 'draft', paint: { 'fill-color': ACCENT, 'fill-opacity': 0.1 } },
      { id: 'draft-glow', type: 'line', source: 'draft', paint: { 'line-color': ACCENT, 'line-width': 8, 'line-blur': 6, 'line-opacity': 0.35 } },
      { id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': '#e9fffc', 'line-width': 1.8, 'line-dasharray': [0, 4, 3] } },
      {
        id: 'draft-vertices', type: 'circle', source: 'draft-vertices',
        paint: { 'circle-radius': ['case', ['==', ['get', 'role'], 'first'], 6, 4.5], 'circle-color': '#06080a', 'circle-stroke-color': ACCENT, 'circle-stroke-width': 2 },
      },
    ],
  };
}

/**
 * Imperative wrapper around a MapLibre map. All state changes go through
 * `update()`, which is idempotent and safe to call before the style loads.
 */
export class TerraMap {
  readonly map: MlMap;
  private state: MapState;
  private applied: Record<string, unknown> = {};
  private loaded = false;
  private markers = new Map<string, { marker: maplibregl.Marker; label: HTMLElement; priority: number }>();
  private popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'tt-popup', offset: 14, maxWidth: '240px' });
  private imageryLayer: string | null = null;
  private raf = 0;
  private interacting = false;
  private tileErrors = 0;
  private hoverId: string | null = null;
  private resizeObs: ResizeObserver;
  private nightTimer = 0;
  private minZoomTarget = 1;
  private destroyed = false;
  private dashStep = 0;
  private lastDash = 0;
  private collisionQueued = false;

  constructor(container: HTMLElement, initial: MapState, private handlers: TerraMapHandlers = {}) {
    registerEeTiles();   // bounded Earth Engine tile loader (idempotent)
    this.state = initial;
    this.map = new maplibregl.Map({
      container,
      style: baseStyle(),
      center: [-30, 4],
      zoom: 2.15,
      minZoom: 1,
      maxZoom: 17,
      attributionControl: { compact: true },
      fadeDuration: 200,
      renderWorldCopies: false,
      canvasContextAttributes: { antialias: true },
    });
    // Reconcile as soon as the style is usable. Do NOT wait for 'load': it needs a fully
    // loaded first frame, which global tile sources (e.g. missing ocean tiles) can delay
    // indefinitely — leaving markers and data layers unapplied.
    const ready = () => {
      if (this.loaded || this.destroyed) return;
      this.loaded = true;
      this.apply();
      this.queueCollision();
    };
    if (this.map.isStyleLoaded()) queueMicrotask(ready);
    this.map.once('style.load', ready);
    this.map.once('styledata', () => this.map.isStyleLoaded() && ready());
    this.map.once('load', ready);
    this.bindInteractions();
    this.resizeObs = new ResizeObserver(() => this.map.resize());
    this.resizeObs.observe(container);
    this.raf = requestAnimationFrame(this.tick);
    this.nightTimer = window.setInterval(() => this.loaded && (this.map.getSource('night') as GeoJSONSource | undefined)?.setData(nightPolygons()), 60000);
  }

  update(patch: Partial<MapState>) {
    this.state = { ...this.state, ...patch };
    if (this.loaded) this.apply();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.clearInterval(this.nightTimer);
    this.resizeObs.disconnect();
    this.markers.forEach((m) => m.marker.remove());
    this.popup.remove();
    this.map.remove();
  }

  // ------------------------------------------------------------ camera
  private dur(ms: number) {
    return this.state.reducedMotion ? 0 : ms;
  }

  fitBounds(b: [number, number, number, number], padding: Padding, maxZoom = 11.6, duration = 2600) {
    this.map.setPadding(NO_PAD);
    this.map.fitBounds(b, { padding, duration: this.dur(duration), maxZoom, essential: true, curve: 1.5 });
  }

  flyToAoi(aoi: StudyArea, padding: Padding) {
    this.fitBounds(aoi.bbox, padding, 11.6, 3000);
  }

  flyToEvent(bbox: [number, number, number, number], padding: Padding) {
    const [w, s, e, n] = bbox;
    const mx = Math.max((e - w) * 0.9, 0.01), my = Math.max((n - s) * 0.9, 0.01);
    this.fitBounds([w - mx, s - my, e + mx, n + my], padding, 14.5, 1400);
  }

  flyToPoint(p: [number, number], zoom = 9) {
    this.map.flyTo({ center: p, zoom, duration: this.dur(2200), essential: true });
  }

  /** Globe overview; the inset keeps the globe clear of the hero column / panels. */
  flyHome(inset: Partial<Padding> = {}, zoom = 2.15) {
    this.map.flyTo({ center: [-30, 4], zoom, bearing: 0, pitch: 0, duration: this.dur(2400), essential: true, padding: { ...NO_PAD, ...inset } });
  }

  /**
   * Lowest zoom the camera may reach. Lowering applies at once. Raising it while the camera is still below the new
   * floor would snap the view, so the floor is raised only once the camera has moved above it (e.g. after the
   * fly-out of the landing globe). A later call always replaces a pending one.
   */
  setMinZoom(z: number) {
    this.minZoomTarget = z;
    const apply = () => {
      if (this.destroyed || this.minZoomTarget !== z) return;
      if (this.map.getZoom() >= z) this.map.setMinZoom(z);
      else this.map.once('moveend', apply);
    };
    if (this.map.getZoom() >= z || z <= this.map.getMinZoom()) this.map.setMinZoom(z);
    else this.map.once('moveend', apply);
  }

  setInset(inset: Partial<Padding>) {
    this.map.easeTo({ padding: { ...NO_PAD, ...inset }, duration: this.dur(700) });
  }

  zoomBy(delta: number) {
    this.map.easeTo({ zoom: this.map.getZoom() + delta, duration: this.dur(300) });
  }

  resetNorth() {
    this.map.easeTo({ bearing: 0, pitch: 0, duration: this.dur(400) });
  }

  setDraggable(on: boolean) {
    if (on) { this.map.dragPan.enable(); this.map.doubleClickZoom.enable(); }
    else { this.map.dragPan.disable(); this.map.doubleClickZoom.disable(); }
  }

  // ------------------------------------------------------------ reconcile
  private changed(key: string, value: unknown) {
    if (this.applied[key] === value) return false;
    this.applied[key] = value;
    return true;
  }

  private apply() {
    if (this.destroyed) return;
    const s = this.state;
    const m = this.map;
    const areas = s.aoi && !s.areas.some((a) => a.id === s.aoi!.id) ? [...s.areas, s.aoi] : s.areas;

    if (this.changed('areas', areas.map((a) => a.id).join())) {
      (m.getSource('aoi-all') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: areas.map((a) => ({ type: 'Feature', id: a.id, geometry: a.geometry, properties: { id: a.id } })),
      });
      this.applied.aoi = undefined;
      this.applied.aoiHover = undefined;
    }
    if (this.changed('markerSet', `${s.areas.map((a) => a.id).join()}|${s.regions.map((r) => r.id).join()}`)) this.buildMarkers();

    if (this.changed('aoi', s.aoi?.id ?? null)) {
      for (const a of areas) m.setFeatureState({ source: 'aoi-all', id: a.id }, { active: a.id === s.aoi?.id });
      (m.getSource('aoi-mask') as GeoJSONSource).setData(s.aoi ? maskFor(s.aoi.geometry) : EMPTY);
      this.markers.forEach((mk) => mk.marker.getElement().classList.toggle('is-hidden', !!s.aoi));
      this.popup.remove();
      const globe = s.aoi ? 'none' : 'visible';
      for (const id of ['night', 'global-hotspots', 'global-hotspots-glow']) m.setLayoutProperty(id, 'visibility', globe);
      this.applied.globalForest = undefined;
    }

    if (this.changed('basemaps', s.basemaps)) this.addBasemaps();

    if (this.changed('globalForest', `${s.layers.globalForest}|${!!s.aoi}|${this.basemapsAdded}`) && m.getLayer('global-forest')) {
      m.setLayoutProperty('global-forest', 'visibility', s.layers.globalForest && !s.aoi ? 'visible' : 'none');
    }
    if (this.changed('hotspotsData', s.hotspots)) {
      (m.getSource('global-hotspots') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: s.hotspots.map((h): Feature<Point> => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [h.lon, h.lat] }, properties: { area_ha: h.area_ha, severity: h.severity } })),
      });
    }

    if (this.changed('aoiHover', s.hoveredAoiId)) {
      for (const a of areas) m.setFeatureState({ source: 'aoi-all', id: a.id }, { hover: a.id === s.hoveredAoiId });
      this.markers.forEach((mk, id) => mk.marker.getElement().classList.toggle('is-hover', id === s.hoveredAoiId));
    }

    if (this.changed('pin', s.pin ? s.pin.join(',') : null)) this.updatePin();

    if (this.changed('boundary', s.layers.boundary)) {
      const v = s.layers.boundary ? 'visible' : 'none';
      for (const id of ['aoi-outline', 'aoi-glow', 'aoi-mask']) m.setLayoutProperty(id, 'visibility', v);
    }

    if (this.changed('catalog', s.catalog)) this.rebuildOverlays();

    const live = this.liveImagery();
    const imageryKey = `${s.layers.satellite}:${s.imagery}:${s.year}:${s.catalog?.aoi_id ?? ''}:${s.aoi?.id ?? ''}:${s.imageryAoi?.id ?? ''}:${live?.tileUrl ?? ''}:${this.basemapsAdded}`;
    if (this.changed('imagery', imageryKey)) this.showImagery();

    const ovKey = `${s.year}|${s.layers.forest}|${s.layers.ndvi}|${s.layers.forestOpacity}|${s.catalog?.aoi_id}`;
    if (this.changed('overlays', ovKey)) this.updateOverlays();

    if (this.changed('labels', `${s.layers.labels}|${this.basemapsAdded}`) && m.getLayer('labels')) m.setLayoutProperty('labels', 'visibility', s.layers.labels ? 'visible' : 'none');

    if (this.changed('events', s.events)) {
      (m.getSource('events') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: s.events.map((f): Feature => ({ type: 'Feature', id: f.id, geometry: f.geometry, properties: flatProps(f) })),
      });
      (m.getSource('event-points') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: s.events.map((f): Feature<Point> => ({ type: 'Feature', id: f.id, geometry: { type: 'Point', coordinates: f.properties.centroid }, properties: flatProps(f) })),
      });
      this.applied.selected = undefined;
    }

    const filterKey = `${s.year}|${s.severities.join()}|${s.types.join()}|${s.layers.change}|${s.layers.intensity}`;
    if (this.changed('filter', filterKey)) this.updateEventFilters();

    if (this.changed('selected', s.selectedId)) {
      const f: FilterSpecification = ['==', ['get', 'id'], s.selectedId ?? ''];
      m.setFilter('events-selected', f);
      m.setFilter('events-selected-halo', f);
    }
    if (this.changed('hovered', s.hoveredId)) this.setHover(s.hoveredId, false);

    if (this.changed('draft', s.draft)) {
      (m.getSource('draft') as GeoJSONSource).setData(s.draft ? { type: 'Feature', properties: {}, geometry: s.draft } : EMPTY);
      if (!s.drawing) (m.getSource('draft-vertices') as GeoJSONSource).setData(EMPTY);
    }
  }

  /** Vertex handles shown while drawing (set by the AOI drawer). */
  setDraftVertices(points: [number, number][], closedHint: boolean) {
    (this.map.getSource('draft-vertices') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: points.map((p, i): Feature<Point> => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { role: i === 0 && closedHint ? 'first' : 'vertex' } })),
    });
  }

  /** TerratraceMapMarker: featured investigations (reticle) + exploration regions (pin). */
  /** One pin at the searched / located point (created on demand, removed when the selection goes). */
  private pinMarker: maplibregl.Marker | null = null;
  private updatePin() {
    const p = this.state.pin;
    if (!p) { this.pinMarker?.remove(); this.pinMarker = null; return; }
    if (!this.pinMarker) {
      const el = document.createElement('div');
      el.className = 'tt-search-pin';
      el.dataset.testid = 'search-pin';
      el.setAttribute('aria-label', 'Searched location');
      el.innerHTML = '<svg width="26" height="34" viewBox="0 0 26 34" aria-hidden="true"><path d="M13 1C6.4 1 1 6.3 1 12.9 1 22 13 33 13 33s12-11 12-20.1C25 6.3 19.6 1 13 1z" fill="#45d0c4" stroke="#03201d" stroke-width="1.5"/><circle cx="13" cy="13" r="4.5" fill="#03201d"/></svg>';
      this.pinMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' });
    }
    this.pinMarker.setLngLat(p).addTo(this.map);
  }

  private buildMarkers() {
    this.markers.forEach((mk) => mk.marker.remove());
    this.markers.clear();
    const make = (id: string, center: [number, number], title: string, sub: string, kind: 'featured' | 'region', priority: number, onClick: () => void) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `tt-marker tt-marker--${kind}`;
      el.setAttribute('aria-label', kind === 'featured' ? `Open featured investigation ${title}` : `Explore ${title}`);
      const ret = document.createElement('span');
      ret.className = 'tt-reticle';
      for (let i = 0; i < 4; i++) ret.appendChild(document.createElement('i'));
      if (kind === 'featured') {
        const pulse = document.createElement('span');
        pulse.className = 'tt-reticle-pulse';
        ret.appendChild(pulse);
      }
      const label = document.createElement('span');
      label.className = 'tt-marker-label';
      const t = document.createElement('strong');
      t.textContent = title;
      const small = document.createElement('small');
      small.textContent = sub;
      label.append(t, small);
      el.append(ret, label);
      el.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
      if (kind === 'featured') {
        el.addEventListener('pointerenter', () => this.handlers.onAoiHover?.(id));
        el.addEventListener('pointerleave', () => this.handlers.onAoiHover?.(null));
        el.addEventListener('focus', () => this.handlers.onAoiHover?.(id));
        el.addEventListener('blur', () => this.handlers.onAoiHover?.(null));
      }
      if (this.state.aoi) el.classList.add('is-hidden');
      const marker = new maplibregl.Marker({ element: el, anchor: 'left', offset: [-11, 0] }).setLngLat(center).addTo(this.map);
      this.markers.set(id, { marker, label, priority });
    };
    this.state.areas.forEach((a, i) => make(a.id, a.center, a.short_name, `${a.region.split(',').pop()?.trim() ?? a.country ?? ''} · ${Math.round(a.area_km2).toLocaleString('en-US')} km²`, 'featured', 10 - i, () => this.handlers.onAoiClick?.(a.id)));
    this.state.regions.forEach((r) => make(`region-${r.id}`, r.center, r.name, r.continent, 'region', 0, () => this.handlers.onRegionClick?.(r)));
    this.queueCollision();
  }

  /**
   * Marker declutter: hide a whole marker that sits under a floating UI panel
   * (elements marked `data-map-occluder`), and hide labels that would overlap a
   * higher-priority label (the dot stays).
   */
  private queueCollision() {
    if (this.collisionQueued) return;
    this.collisionQueued = true;
    requestAnimationFrame(() => {
      this.collisionQueued = false;
      const hit = (r: DOMRect, p: DOMRect, pad = 4) => r.left < p.right + pad && r.right > p.left - pad && r.top < p.bottom + pad && r.bottom > p.top - pad;
      const occluders = [...document.querySelectorAll('[data-map-occluder]')].map((n) => n.getBoundingClientRect()).filter((r) => r.width && r.height);
      const placed: DOMRect[] = [];
      const entries = [...this.markers.values()].sort((a, b) => b.priority - a.priority);
      for (const e of entries) {
        const el = e.marker.getElement();
        e.label.classList.remove('is-collided');
        const dot = el.querySelector('.tt-reticle')?.getBoundingClientRect();
        el.classList.toggle('is-occluded', !!dot && occluders.some((o) => hit(dot, o, 2)));
        if (el.classList.contains('maplibregl-marker-covered') || el.classList.contains('is-hidden') || el.classList.contains('is-occluded')) continue;
        const labelRect = e.label.getBoundingClientRect();
        if (occluders.some((o) => hit(labelRect, o, 2))) { e.label.classList.add('is-collided'); placed.push(dot!); continue; }
        if (placed.some((p) => hit(labelRect, p))) e.label.classList.add('is-collided');
        else placed.push(labelRect);
      }
    });
  }

  /** Adds the backend's static base layers (globe mosaic, hi-res, reference forest, labels) once. */
  private basemapsAdded = false;
  private addBasemaps() {
    const b = this.state.basemaps;
    if (!b || this.basemapsAdded) return;
    const m = this.map;
    const src = (l: BaseLayer) => ({ type: 'raster' as const, tiles: l.tiles, tileSize: l.tile_size, maxzoom: l.max_zoom, attribution: l.attribution });
    m.addSource('img-base', src(b.globe));
    m.addSource('hires', src(b.hires));
    m.addSource('global-forest', src(b.reference_forest));
    m.addSource('labels', src(b.labels));
    m.addLayer({ id: 'img-base', type: 'raster', source: 'img-base', paint: { 'raster-fade-duration': 300, 'raster-saturation': -0.05, 'raster-contrast': 0.05 } }, 'anchor-base');
    m.addLayer({ id: 'img-hires', type: 'raster', source: 'hires', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 250 } }, 'anchor-base');
    m.addLayer({
      id: 'global-forest', type: 'raster', source: 'global-forest', maxzoom: 12, layout: { visibility: 'none' },
      paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 0.35, 10, 0.2], 'raster-saturation': -0.25, 'raster-hue-rotate': 12, 'raster-opacity-transition': { duration: 500 } },
    }, 'anchor-reference');
    m.addLayer({ id: 'labels', type: 'raster', source: 'labels', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85 } }, 'anchor-labels');
    this.basemapsAdded = true;
  }

  /** The backend imagery decision, only if it is READY for exactly the open AOI and this map's year. */
  private liveImagery(): ImageryDecision | null {
    const { yearImagery: d, imageryAoi: aoi, year } = this.state;
    return d && d.status === 'READY' && d.tileUrl && aoi && d.aoi_id === aoi.id && d.year === year ? d : null;
  }

  /**
   * Raster layer for this year: the live imagery decision if it is READY for this AOI + year, else the READY
   * analysis' own composite. Both are the same Earth Engine composite (same collection, cloud mask, median and
   * visualisation; the live one is clipped to the AOI), so reusing the already-loaded live layer avoids fetching
   * every tile a second time — which Earth Engine's Restricted-Mode concurrency limit makes slow.
   */
  private ensureImagery(year: number): string | null {
    const live = this.liveImagery();
    const spec = live ? undefined : this.state.catalog?.imagery.find((i) => i.year === year);
    if (!spec && !live) return null;
    const layerId = spec ? `img-s2-${year}${spec.reference ? '-ref' : ''}` : `img-s2-live-${live!.aoi_id}-${year}`;
    if (!this.map.getSource(layerId)) {
      // Earth Engine tiles go through the bounded loader (eeTiles.ts); `bounds` = the AOI, so MapLibre never
      // requests tiles outside the study area (the live composite is clipped to it).
      const bounds = this.state.imageryAoi?.bbox ?? this.state.aoi?.bbox;
      this.map.addSource(layerId, spec
        ? { type: 'raster', tiles: spec.tiles.map(eeTiles), tileSize: spec.tile_size, maxzoom: spec.max_zoom, attribution: spec.attribution, ...(bounds ? { bounds } : {}) }
        : { type: 'raster', tiles: [eeTiles(live!.tileUrl!)], tileSize: 256, maxzoom: live!.max_zoom ?? 15, attribution: live!.attribution ?? '', ...(bounds ? { bounds } : {}) });
      this.map.addLayer({
        id: layerId, type: 'raster', source: layerId, layout: { visibility: 'none' },
        // Stand-in reference imagery is visibly desaturated so it never reads as the composite of that year.
        paint: { 'raster-fade-duration': 350, ...(spec?.reference ? { 'raster-saturation': -0.85, 'raster-brightness-max': 0.7 } : {}) },
      }, 'anchor-imagery');
    }
    return layerId;
  }

  private hideImagery(prev: string | null) {
    if (prev && this.map.getLayer(prev)) this.map.setLayoutProperty(prev, 'visibility', 'none');
    this.imageryLayer = null;
  }

  /** Cross-fade: the new layer goes on top and fades its tiles in; the old one is hidden afterwards. */
  private showImagery() {
    const s = this.state;
    const m = this.map;
    const prev = this.imageryLayer;
    if (m.getLayer('img-base')) m.setLayoutProperty('img-base', 'visibility', s.aoi ? 'none' : 'visible');
    if (m.getLayer('img-hires')) m.setLayoutProperty('img-hires', 'visibility', s.imagery === 'hires' && s.layers.satellite ? 'visible' : 'none');
    // Live-imagery layers of other areas are removed (each is clipped to its own AOI).
    for (const l of m.getStyle().layers) {
      if (l.id.startsWith('img-s2-live-') && !l.id.startsWith(`img-s2-live-${s.imageryAoi?.id ?? '-'}-`)) { m.removeLayer(l.id); m.removeSource(l.id); if (prev === l.id) this.imageryLayer = null; }
    }
    // No study open: only a registered selection's READY live imagery is drawn (over the globe basemap).
    if (!s.layers.satellite || (!s.aoi && !this.liveImagery())) return this.hideImagery(this.imageryLayer);
    // No READY imagery for this exact year: draw NOTHING rather than another year's imagery — the map notice explains why.
    const next = s.imagery === 'hires' ? (m.getLayer('img-hires') ? 'img-hires' : null) : this.ensureImagery(s.year);
    if (!next) return this.hideImagery(this.imageryLayer);
    if (this.imageryLayer === next) return;
    const before = this.imageryLayer;
    m.setLayoutProperty(next, 'visibility', 'visible');
    if (next !== 'img-hires') m.moveLayer(next, 'anchor-imagery');
    this.imageryLayer = next;
    if (before && before !== 'img-hires') {
      window.setTimeout(() => {
        if (!this.destroyed && this.imageryLayer !== before && m.getLayer(before)) m.setLayoutProperty(before, 'visibility', 'none');
      }, 900);
    }
  }

  private rebuildOverlays() {
    const m = this.map;
    for (const kind of ['forest', 'ndvi']) {
      const id = `ov-${kind}`;
      if (m.getLayer(id)) m.removeLayer(id);
      if (m.getSource(id)) m.removeSource(id);
    }
    // Imagery sources are catalogue-specific (reference vs. real composites).
    for (const l of m.getStyle().layers) if (l.id.startsWith('img-s2-') && !l.id.startsWith('img-s2-live-')) { m.removeLayer(l.id); m.removeSource(l.id); }
    // Live-imagery layers are kept (re-usable) but hidden: showImagery() re-shows exactly one layer. A visible
    // live layer under the analysis composite would load every Earth Engine tile twice.
    for (const l of m.getStyle().layers) if (l.id.startsWith('img-s2-live-')) m.setLayoutProperty(l.id, 'visibility', 'none');
    this.imageryLayer = null;
    this.applied.imagery = undefined;
    const cat = this.state.catalog;
    if (!cat) return;
    for (const ov of cat.overlays) {
      const id = `ov-${ov.kind}`;
      const url = ov.by_year[String(this.state.year)];
      if (ov.source === 'image' && ov.coordinates && url) m.addSource(id, { type: 'image', url, coordinates: ov.coordinates });
      else if (ov.source === 'raster-tiles' && ov.tiles_by_year?.[String(this.state.year)]) m.addSource(id, { type: 'raster', tiles: ov.tiles_by_year[String(this.state.year)].map(eeTiles), tileSize: 256, ...(this.state.aoi ? { bounds: this.state.aoi.bbox } : {}) });
      else continue;
      m.addLayer({ id, type: 'raster', source: id, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 350 }, 'raster-fade-duration': 0 } }, 'anchor-overlays');
      this.applied[`ovyear-${id}`] = `${id}:${this.state.year}`;
      Object.values(ov.by_year).forEach((u) => { const img = new Image(); img.src = u; });
    }
    this.applied.overlays = undefined;
  }

  private updateOverlays() {
    const { catalog, year, layers } = this.state;
    if (!catalog) return;
    for (const ov of catalog.overlays) {
      const id = `ov-${ov.kind}`;
      if (!this.map.getLayer(id)) continue;
      const on = ov.kind === 'forest' ? layers.forest : layers.ndvi;
      this.map.setLayoutProperty(id, 'visibility', 'visible');
      this.map.setPaintProperty(id, 'raster-opacity', on ? (ov.kind === 'forest' ? layers.forestOpacity : 0.72) : 0);
      const key = `${id}:${year}`;
      if (this.applied[`ovyear-${id}`] !== key) {
        this.applied[`ovyear-${id}`] = key;
        const src = this.map.getSource(id);
        if (ov.source === 'image' && src && 'updateImage' in src && ov.by_year[String(year)]) {
          (src as ImageSource).updateImage({ url: ov.by_year[String(year)], coordinates: ov.coordinates });
        } else if (ov.source === 'raster-tiles' && ov.tiles_by_year?.[String(year)] && src && 'setTiles' in src) {
          (src as maplibregl.RasterTileSource).setTiles(ov.tiles_by_year[String(year)].map(eeTiles));
        }
      }
    }
  }

  private updateEventFilters() {
    const { year, severities, types, layers } = this.state;
    const base: FilterSpecification = ['all', ['<=', ['get', 'year_to'], year], ['in', ['get', 'severity'], ['literal', severities]], ['in', ['get', 'change_type'], ['literal', types]]];
    const fresh = [...(base as unknown[]), ['==', ['get', 'year_to'], year]] as FilterSpecification;
    const m = this.map;
    for (const id of ['events-fill', 'events-line']) m.setFilter(id, base);
    m.setFilter('events-pulse', fresh);
    m.setFilter('hotspots', base);
    m.setPaintProperty('events-fill', 'fill-opacity', ['case', ['boolean', ['feature-state', 'hover'], false], 0.55, ['==', ['get', 'year_to'], year], 0.34, 0.16]);
    const vis = (on: boolean) => (on ? 'visible' : 'none');
    for (const id of ['events-fill', 'events-line', 'events-selected', 'events-selected-halo', 'events-pulse']) m.setLayoutProperty(id, 'visibility', vis(layers.change));
    m.setLayoutProperty('hotspots', 'visibility', vis(layers.intensity));
  }

  private setHover(id: string | null, fromMap: boolean) {
    if (this.hoverId === id) return;
    if (this.hoverId) this.map.setFeatureState({ source: 'events', id: this.hoverId }, { hover: false });
    this.hoverId = id;
    if (id) this.map.setFeatureState({ source: 'events', id }, { hover: true });
    if (fromMap) this.handlers.onEventHover?.(id);
    if (!id) this.popup.remove();
  }

  // ------------------------------------------------------------ interactions
  private bindInteractions() {
    const m = this.map;
    m.on('mousemove', 'events-fill', (e) => {
      if (this.state.drawing) return;
      const f = e.features?.[0];
      if (!f) return;
      m.getCanvas().style.cursor = 'pointer';
      this.setHover(String(f.properties.id), true);
      const p = f.properties as Record<string, string | number>;
      this.popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div class="tt-pop-type">${escapeHtml(changeTypeLabel[p.change_type as ChangeType] ?? '')} · ${escapeHtml(String(p.year_from))}–${escapeHtml(String(p.year_to))}</div>` +
            `<div class="tt-pop-area">${escapeHtml(fmtHa(Number(p.area_ha)))} ha</div>` +
            `<div class="tt-pop-sev sev-${escapeHtml(String(p.severity))}">${escapeHtml(severityLabel[p.severity as Severity] ?? '')} severity · ${Math.round(Number(p.confidence) * 100)}% evidence</div>` +
            `<div class="tt-pop-hint">Click to investigate</div>`,
        )
        .addTo(m);
    });
    m.on('mouseleave', 'events-fill', () => {
      m.getCanvas().style.cursor = this.state.drawing ? 'crosshair' : '';
      this.setHover(null, true);
    });
    m.on('click', (e) => {
      if (this.state.drawing) return;
      if (this.state.aoi) {
        if (!this.state.layers.change) return;
        const hit = m.queryRenderedFeatures(e.point, { layers: ['events-fill'] })[0];
        if (hit) this.handlers.onEventClick?.(String(hit.properties.id));
        return;
      }
      this.handlers.onMapClick?.([e.lngLat.lng, e.lngLat.lat]);
    });
    const stopSpin = () => { this.interacting = true; };
    m.on('mousedown', stopSpin);
    m.on('touchstart', stopSpin);
    m.on('wheel', stopSpin);
    const report = () => {
      const c = m.getCenter();
      this.handlers.onView?.({ lng: c.lng, lat: c.lat, zoom: m.getZoom(), bearing: m.getBearing() });
    };
    m.on('move', report);
    m.on('move', () => this.queueCollision());
    const compact = () => m.getContainer().classList.toggle('tt-markers-compact', m.getZoom() < 1.6);
    m.on('zoom', compact);
    compact();
    m.on('mousemove', (e) => this.handlers.onPointer?.({ lng: e.lngLat.lng, lat: e.lngLat.lat }));
    m.on('mouseout', () => this.handlers.onPointer?.(null));
    m.on('error', (e) => {
      const src = (e as unknown as { sourceId?: string }).sourceId ?? '';
      // A tile Earth Engine throttled (429, after its one retry) is not a connection failure; eeTiles reports it.
      if ((e as unknown as { error?: Error }).error?.name === THROTTLED) return;
      if (/^(img-|hires|labels)/.test(src)) {
        this.tileErrors++;
        if (this.tileErrors === 8) this.handlers.onTileError?.();
      }
    });
  }

  /** Animation loop: pulsing rings, marching-ants AOI boundary, idle globe drift. */
  private tick = (now: number) => {
    if (this.destroyed) return;
    const s = this.state;
    if (this.loaded && !s.reducedMotion) {
      if (s.aoi && s.layers.change) {
        const t = (now % 2200) / 2200;
        this.map.setPaintProperty('events-pulse', 'circle-radius', 5 + 14 * t);
        this.map.setPaintProperty('events-pulse', 'circle-stroke-opacity', 0.55 * (1 - t) ** 1.5);
      }
      if (s.draft && now - this.lastDash > 70) {
        this.lastDash = now;
        this.dashStep = (this.dashStep + 1) % DASHES.length;
        this.map.setPaintProperty('draft-line', 'line-dasharray', DASHES[this.dashStep]);
      }
      if (s.spin && !s.aoi && !s.draft && !s.drawing && !this.interacting && !s.hoveredAoiId && !this.map.isMoving() && this.map.getZoom() < 3.5) {
        const c = this.map.getCenter();
        this.map.jumpTo({ center: [c.lng + 0.025, c.lat] });
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  resumeSpin() {
    this.interacting = false;
  }
}

function flatProps(f: ChangeEvent) {
  const p = f.properties;
  return { id: p.id, severity: p.severity.class, change_type: p.change_type, year_from: p.year_from, year_to: p.year_to, area_ha: p.area_ha, confidence: p.confidence.score };
}

/** World polygon with the AOI punched out — dims everything outside the study area. */
function maskFor(geometry: AoiGeometry): FeatureCollection {
  const holes = geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.coordinates.map((p) => p[0]);
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const rings = [world, ...holes.map((h) => (signedArea(h) > 0 ? [...h].reverse() : h))];
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } as Polygon }] };
}

function signedArea(ring: number[][]) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}
