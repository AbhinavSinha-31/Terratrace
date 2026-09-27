import type { MapEventType, MapMouseEvent, MapTouchEvent } from 'maplibre-gl';
import type { AoiGeometry } from '../../data/contracts';
import type { TerraMap } from './TerraMap';

type Tool = 'rect' | 'polygon';

/**
 * TerratraceAOITool — rectangle (press-drag-release) and polygon (click
 * vertices; click the first vertex, double-click or press Enter to close;
 * Backspace removes the last vertex; Esc cancels).
 */
export class AoiDrawer {
  private tool: Tool | null = null;
  private start: [number, number] | null = null;
  private pts: [number, number][] = [];
  private hover: [number, number] | null = null;
  private off: (() => void)[] = [];

  constructor(
    private tm: TerraMap,
    private onDraft: (g: AoiGeometry | null) => void,
    private onDone: (g: AoiGeometry | null) => void,
  ) {}

  begin(tool: Tool) {
    this.cancel(false);
    this.tool = tool;
    const m = this.tm.map;
    m.getCanvas().style.cursor = 'crosshair';
    this.tm.setDraggable(tool === 'polygon');
    const on = <T extends keyof MapEventType>(type: T, fn: (e: MapEventType[T]) => void) => {
      m.on(type, fn);
      this.off.push(() => m.off(type, fn));
    };
    if (tool === 'rect') {
      const down = (e: MapMouseEvent | MapTouchEvent) => { e.preventDefault(); this.start = [e.lngLat.lng, e.lngLat.lat]; };
      const move = (e: MapMouseEvent | MapTouchEvent) => { if (this.start) this.onDraft(rect(this.start, [e.lngLat.lng, e.lngLat.lat])); };
      const up = (e: MapMouseEvent | MapTouchEvent) => {
        if (!this.start) return;
        const g = rect(this.start, [e.lngLat.lng, e.lngLat.lat]);
        const tiny = Math.abs(this.start[0] - e.lngLat.lng) < 1e-5 || Math.abs(this.start[1] - e.lngLat.lat) < 1e-5;
        this.start = null;
        this.finish(tiny ? null : g);
      };
      on('mousedown', down); on('mousemove', move); on('mouseup', up);
      on('touchstart', down); on('touchmove', move); on('touchend', up);
    } else {
      const click = (e: MapMouseEvent) => {
        const p: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        if (this.pts.length >= 3 && this.nearFirst(e.point.x, e.point.y)) return this.closePolygon();
        this.pts.push(p);
        this.render();
      };
      const move = (e: MapMouseEvent) => { this.hover = [e.lngLat.lng, e.lngLat.lat]; this.render(); };
      const dbl = (e: MapMouseEvent) => { e.preventDefault(); this.closePolygon(); };
      on('click', click); on('mousemove', move); on('dblclick', dbl);
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.cancel(true); }
      else if (e.key === 'Enter' && this.tool === 'polygon') this.closePolygon();
      else if (e.key === 'Backspace' && this.tool === 'polygon' && this.pts.length) { this.pts.pop(); this.render(); }
    };
    window.addEventListener('keydown', key, true);
    this.off.push(() => window.removeEventListener('keydown', key, true));
  }

  get active() {
    return this.tool;
  }

  get vertexCount() {
    return this.pts.length;
  }

  private nearFirst(x: number, y: number) {
    const f = this.tm.map.project(this.pts[0]);
    return Math.hypot(f.x - x, f.y - y) < 12;
  }

  private render() {
    const ring = this.hover ? [...this.pts, this.hover] : this.pts;
    this.tm.setDraftVertices(this.pts, this.pts.length >= 3);
    if (ring.length >= 3) this.onDraft({ type: 'Polygon', coordinates: [[...ring, ring[0]]] });
    else if (ring.length === 2) this.onDraft({ type: 'Polygon', coordinates: [[ring[0], ring[1], ring[1], ring[0]]] });
  }

  closePolygon() {
    // A double-click also fires two clicks: drop near-duplicate vertices first.
    const pts = this.pts.filter((p, i) => i === 0 || Math.hypot(p[0] - this.pts[i - 1][0], p[1] - this.pts[i - 1][1]) > 1e-6);
    if (this.tool !== 'polygon' || pts.length < 3) return;
    const g: AoiGeometry = { type: 'Polygon', coordinates: [[...pts, pts[0]]] };
    this.finish(g);
  }

  private finish(g: AoiGeometry | null) {
    this.teardown();
    this.onDone(g);
  }

  cancel(notify: boolean) {
    const wasActive = this.tool !== null;
    this.teardown();
    if (notify && wasActive) this.onDone(null);
  }

  private teardown() {
    this.off.forEach((f) => f());
    this.off = [];
    this.tool = null;
    this.start = null;
    this.pts = [];
    this.hover = null;
    this.tm.setDraftVertices([], false);
    this.tm.setDraggable(true);
    this.tm.map.getCanvas().style.cursor = '';
  }
}

function rect(a: [number, number], b: [number, number]): AoiGeometry {
  const [w, e] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [s, n] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}
