import type { Feature, FeatureCollection, Polygon } from 'geojson';

const rad = Math.PI / 180;

/** Sub-solar point (declination, longitude) for a UTC date — NOAA-style approximation (±0.5°). */
export function subsolar(date = new Date()): { lat: number; lon: number } {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  let lon = (ra / rad - gmst * 15) % 360;
  if (lon < -180) lon += 360;
  if (lon > 180) lon -= 360;
  return { lat: dec / rad, lon };
}

/**
 * Night-side polygons for solar elevations 0°, −6°, −12° (civil/nautical twilight),
 * stacked at low opacity to draw a soft terminator on the globe.
 */
export function nightPolygons(date = new Date()): FeatureCollection<Polygon> {
  const { lat: decDeg, lon: sLon } = subsolar(date);
  const dec = decDeg * rad;
  const features: Feature<Polygon>[] = [0, -6, -12].map((h) => {
    const sinH = Math.sin(h * rad);
    const ring: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 2) {
      const H = (lon - sLon) * rad;
      const A = Math.sin(dec), B = Math.cos(dec) * Math.cos(H);
      const R = Math.hypot(A, B) || 1e-9;
      const psi = Math.atan2(B, A);
      // sin h = R·sin(φ + ψ)  →  φ = asin(sin h / R) − ψ  or  π − asin(sin h / R) − ψ; keep the one in [−90°, 90°].
      const s = Math.asin(Math.max(-1, Math.min(1, sinH / R)));
      const wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
      const c1 = wrap(s - psi), c2 = wrap(Math.PI - s - psi);
      const phi = Math.abs(c1) <= Math.PI / 2 ? c1 : c2;
      ring.push([lon, Math.max(-84.9, Math.min(84.9, phi / rad))]);
    }
    const pole = decDeg >= 0 ? -84.9 : 84.9; // the dark pole
    const coords: [number, number][] = [...ring, [180, pole], [-180, pole], ring[0]];
    return { type: 'Feature', properties: { elevation: h }, geometry: { type: 'Polygon', coordinates: [coords] } };
  });
  return { type: 'FeatureCollection', features };
}
