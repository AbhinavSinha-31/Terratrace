/**
 * Coordinate order in the frontend: every selection is GeoJSON [longitude, latitude], from the map click to the
 * request body. Regression (2026-10-09): an area reported at "-84.951°, 89.481°" was checked for a lat/lon swap — the
 * chain is consistent; this keeps it that way. Runs the real module (Node strips the TypeScript types):
 *
 *   npm run test:coordinates
 */
import assert from 'node:assert/strict';
import { fmtLatLon, geometryBbox, geometryCentroid, squareAround } from '../src/lib/geo.ts';

const results = [];
const check = (name, fn) => { try { fn(); results.push(`PASS  ${name}`); } catch (e) { results.push(`FAIL  ${name} — ${e.message}`); } };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

// A click at Hasdeo Arand (central India): MapLibre hands over [lng, lat] (TerraMap onMapClick).
const click = [82.79, 22.84];
const sq = squareAround(click, 10);

check('a 10 km click square is a closed GeoJSON ring in [lon, lat] order', () => {
  const ring = sq.coordinates[0];
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4]);
  for (const [lon, lat] of ring) assert.ok(lon > 82.7 && lon < 82.9 && lat > 22.7 && lat < 22.9, `${lon},${lat}`);
});
check('the square is centred on the click (centroid is [lon, lat])', () => {
  const [lon, lat] = geometryCentroid(sq);
  assert.ok(near(lon, 82.79) && near(lat, 22.84), `${lon},${lat}`);
});
check('bbox is [west, south, east, north]', () => {
  const [w, s, e, n] = geometryBbox(sq);
  assert.ok(w < 82.79 && 82.79 < e && s < 22.84 && 22.84 < n);
  assert.ok(near(n - s, 10 / 110.574, 1e-6), 'height is 10 km of latitude');
});
check('the label reads latitude first with hemispheres', () => {
  assert.equal(fmtLatLon(82.79, 22.84, 3), '22.840°N, 82.790°E');
  assert.equal(fmtLatLon(89.481, -84.951, 3), '84.951°S, 89.481°E');
});
check('a polar click stays a polar area (no swap): latitude −84.95 remains the latitude', () => {
  const [lon, lat] = geometryCentroid(squareAround([89.4806, -84.95055], 10));
  assert.ok(near(lon, 89.4806) && near(lat, -84.95055), `${lon},${lat}`);
});

console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
console.log('\nAll coordinate checks passed');
