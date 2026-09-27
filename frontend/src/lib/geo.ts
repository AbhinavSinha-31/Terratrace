import type { AoiGeometry } from '../data/contracts';

const R = 6378137;
const rad = (d: number) => (d * Math.PI) / 180;

/** Spherical ring area in m² (turf.js ringArea formulation; matches the backend). */
function ringArea(ring: number[][]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i], p2 = ring[(i + 1) % n], p3 = ring[(i + 2) % n];
    total += (rad(p3[0]) - rad(p1[0])) * Math.sin(rad(p2[1]));
  }
  return Math.abs((total * R * R) / 2);
}

export function geometryAreaKm2(g: AoiGeometry): number {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let a = 0;
  for (const poly of polys) {
    poly.forEach((ring, i) => {
      const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
      a += (i === 0 ? 1 : -1) * ringArea(open);
    });
  }
  return a / 1e6;
}

export function geometryBbox(g: AoiGeometry): [number, number, number, number] {
  const pts = (g.type === 'Polygon' ? g.coordinates : g.coordinates.flat()).flat();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function geometryCentroid(g: AoiGeometry): [number, number] {
  const ring = (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0]).slice(0, -1);
  return [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];
}

export function bboxPolygon([w, s, e, n]: [number, number, number, number]): AoiGeometry {
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

/** Square AOI of `sideKm` centred on a point. */
export function squareAround([lon, lat]: [number, number], sideKm: number): AoiGeometry {
  const dLat = sideKm / 2 / 110.574;
  const dLon = sideKm / 2 / (111.32 * Math.cos(rad(lat)));
  return bboxPolygon([lon - dLon, lat - dLat, lon + dLon, lat + dLat]);
}

export function bboxAreaKm2(b: [number, number, number, number]): number {
  return geometryAreaKm2(bboxPolygon(b));
}

export const fmtLatLon = (lon: number, lat: number, d = 4) =>
  `${Math.abs(lat).toFixed(d)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(d)}°${lon >= 0 ? 'E' : 'W'}`;
