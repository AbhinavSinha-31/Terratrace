#!/usr/bin/env node
/**
 * Rendered-marker regression check (run against the dev server):
 *
 *   npm run dev            # in another terminal
 *   npm run test:markers   # uses the locally installed Microsoft Edge / Chrome
 *
 * For every featured investigation it flies the globe to the site and asserts the
 * marker reticle is drawn within TOLERANCE px of its [lon, lat] coordinate. This
 * catches CSS/positioning regressions (e.g. the Silent Valley stacking bug) that
 * data-level tests cannot see.
 */
import { chromium } from 'playwright-core';

const URL = process.env.TT_URL ?? 'http://localhost:5173/';
const TOLERANCE = 2;
const channel = process.env.TT_BROWSER ?? 'msedge';

const browser = await chromium.launch({ channel, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__tt?.loaded && document.querySelectorAll('.tt-marker--featured').length >= 4, null, { timeout: 45000 });

const results = await page.evaluate(async () => {
  const tm = window.__tt;
  tm.interacting = true; // stop idle drift
  const out = [];
  for (const [id, { marker }] of tm.markers) {
    if (id.startsWith('region-')) continue;
    const want = marker.getLngLat();
    tm.map.jumpTo({ center: want, zoom: 4, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    await new Promise((r) => setTimeout(r, 700));
    const ret = marker.getElement().querySelector('.tt-reticle').getBoundingClientRect();
    const box = tm.map.getContainer().getBoundingClientRect();
    const expected = tm.map.project(want);
    const dx = ret.left + ret.width / 2 - box.left - expected.x;
    const dy = ret.top + ret.height / 2 - box.top - expected.y;
    out.push({ id, lngLat: [want.lng, want.lat], error: Math.hypot(dx, dy) });
  }
  return out;
});
await browser.close();

let failed = 0;
for (const r of results) {
  const ok = r.error <= TOLERANCE;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(20)} [${r.lngLat.map((v) => v.toFixed(3)).join(', ')}]  error ${r.error.toFixed(1)} px`);
}
if (results.length < 4) { console.log('FAIL  expected 4 featured markers'); failed++; }
process.exit(failed ? 1 : 0);
