#!/usr/bin/env node
/**
 * End-to-end data-integrity check (run against the dev server + backend):
 *
 *   npm run dev                  # frontend (and the backend on :8000)
 *   npm run test:integrity       # uses the locally installed Microsoft Edge / Chrome
 *
 * Works in both backend states (detected from /api/health):
 *   A. Earth Engine unavailable — every analysis must be UNAVAILABLE with the reason,
 *      and the UI must show NO scientific results anywhere.
 *   B. Earth Engine configured — real analyses run. A result may be READY only if it
 *      independently passes every physical/validity rule re-checked here; any other
 *      outcome (UNAVAILABLE / INVALID_ANALYSIS / ERROR) must render with its reason and
 *      NO metrics. An invalid or insufficient real analysis is never accepted as a finding.
 * Then repeats the no-metrics checks with the backend unreachable (UI PREVIEW).
 */
import { chromium } from 'playwright-core';

const BASE = process.env.TT_URL ?? 'http://localhost:5173/';
const channel = process.env.TT_BROWSER ?? 'msedge';
const FEATURED = ['rondonia-frontier', 'hasdeo-arand', 'similipal', 'silent-valley'];
// Phrases that only appear alongside measured results.
const NON_READY = ['UNAVAILABLE', 'INVALID_ANALYSIS', 'ERROR'];
const ANALYSIS_TIMEOUT = 260000;
// Developer / infrastructure text that must never appear in the public UI.
const DEV_TEXT = /uvicorn|\.venv|EE_PROJECT|EE_SERVICE_ACCOUNT|GOOGLE_APPLICATION_CREDENTIALS|earthengine authenticate|localhost|127\.0\.0\.1|backend\/|\.env\b|service[- ]account|Traceback|python -m|Configure Live Data|app\.main|API key|credentials/i;
const METRIC_TEXT = /\b(ha lost|forest change\b|change events|Detected change \d|Forest cover 20\d\d|high \/ critical)\b|−\d[\d,]* ha/i;
const FORBIDDEN = /Demonstration data|demo mode|\bsimulated (events|statistics|change)\b/i;

let failed = 0;
const check = (ok, name, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** Independent re-check of a READY envelope (mirrors docs/METHOD.md; never trusts the backend's own verdict). */
function validityErrors(env) {
  const errs = [];
  const tol = 1.01;
  const aoiHa = env.aoi?.area_ha;
  const era = (y) => (y < 2016 ? 'historical' : 'modern');
  if (!env.summary || !env.events || !env.layers) errs.push('READY without summary/events/layers');
  if (env.quality?.issues?.length) errs.push(`READY despite ${env.quality.issues.length} validity issue(s)`);
  for (const y of env.summary?.years ?? []) {
    if (!y.passes_quality) {
      for (const k of ['forest_ha', 'forest_pct', 'loss_ha', 'gain_ha', 'net_change_ha']) if (y[k] !== null) errs.push(`${y.year}: ${k} reported for an insufficient year`);
      continue;
    }
    if (y.coverage_pct === null || y.coverage_pct < 80) errs.push(`${y.year}: passes with coverage ${y.coverage_pct}`);
    if (y.forest_pct !== null && (y.forest_pct < 0 || y.forest_pct > 100 * tol)) errs.push(`${y.year}: forest_pct ${y.forest_pct}`);
    for (const k of ['forest_ha', 'loss_ha', 'gain_ha']) if (y[k] !== null && (y[k] < 0 || y[k] > aoiHa * tol)) errs.push(`${y.year}: ${k} ${y[k]} outside 0..AOI`);
    if (y.loss_ha !== null && y.compared_ha !== null && y.loss_ha > y.compared_ha * tol) errs.push(`${y.year}: loss > compared area`);
    if (y.previous_year !== null && era(y.previous_year) !== era(y.year)) errs.push(`${y.year}: compared across eras (${y.previous_year})`);
    if (y.previous_year !== null && y.gain_ha !== null && y.compared_ha && y.gain_ha / y.compared_ha / (y.year - y.previous_year) > 0.05) errs.push(`${y.year}: unstable gain`);
  }
  const k = env.summary?.kpis;
  if (k && k.forest_baseline_ha !== null && k.total_loss_ha !== null && k.total_loss_ha > k.forest_baseline_ha + (k.total_gain_ha ?? 0) + aoiHa * 0.01) errs.push('cumulative loss > forest + gain');
  return errs;
}

/** Time Machine: selectable from 1984, no 2016/2018 floor, requested vs analysable window explicit and consistent. */
async function checkTimeline(page, name, env) {
  const s = await page.evaluate(() => { const u = window.__ttUi.getState(); return { years: u.years, win: u.window }; });
  check(s.years[0] === 1984 && s.years.includes(1990) && s.years.at(-1) === 2025, `${name} timeline selectable from 1984`, `${s.years[0]}…${s.years.at(-1)}`);
  check(s.years.filter((y) => y < 2016).length === 7, `${name} no 2016/2018 minimum (7 historical Landsat years present)`);
  const tick = await page.locator('button:text-is("1984")').count();
  check(tick >= 1, `${name} 1984 tick rendered in the Time Machine`);
  const panel = await page.locator('[data-testid="analysis-unavailable"]').textContent().catch(() => null);
  if (panel) {
    const req = panel.match(/Requested window\s*(\d{4}) → (\d{4})/);
    check(!!req && Number(req[1]) === s.win.start && Number(req[2]) === s.win.end, `${name} requested window in panel == Time Machine window`, req ? `${req[1]}→${req[2]} vs ${s.win.start}→${s.win.end}` : 'not shown');
    if (env?.quality) check(/Analysable window/.test(panel), `${name} analysable window explicitly labelled`);
  }
  if (env?.window) check(env.window.baseline_year === s.win.start && env.window.comparison_year === s.win.end, `${name} backend request == UI window`);
  if (env?.quality) {
    const unusable = env.quality.years.filter((y) => !y.passes).length;
    const struck = await page.locator('[data-unavailable="true"]').count();
    check(unusable === 0 || struck > 0, `${name} unavailable years marked on the timeline`, `${struck} marked / ${unusable} unusable`);
  }
}

const browser = await chromium.launch({ channel, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function run(label, { offline }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (offline) await ctx.route('**/api/**', (r) => r.abort('connectionrefused'));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__tt?.loaded && document.querySelectorAll('.tt-marker--featured').length >= 4, null, { timeout: 45000 });
  await page.waitForSelector('button.tt-card[aria-label^="Open featured investigation"]', { timeout: 20000 });
  await page.waitForFunction(() => !/…/.test(document.querySelector('button.tt-card')?.innerText ?? '…'), null, { timeout: 20000 });

  // ---- backend state
  const health = offline ? null : await page.evaluate(async () => (await fetch('/api/health')).json());
  const live = health?.analysis?.status === 'ready';
  console.log(`\n# ${label}: ${offline ? 'backend unreachable (UI preview)' : live ? 'Earth Engine configured — real analyses' : `Earth Engine ${health?.analysis?.status}`}`);

  // ---- landing
  const status = (await page.locator('[data-testid="data-status"]').innerText()).trim();
  check(live ? /live earth observation/i.test(status) : /live analysis unavailable/i.test(status), `${label}: header data status`, status.replace(/\s+/g, ' '));
  await page.locator('[data-testid="data-status"]').click();
  await page.waitForTimeout(300);
  const pop = await page.locator('body').innerText();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /System notices/ }).click().catch(() => {});
  await page.waitForTimeout(300);
  const notes = await page.locator('body').innerText();
  await page.keyboard.press('Escape');
  check(!DEV_TEXT.test(pop + notes), `${label}: status popover + notices contain no developer text`, ((pop + notes).match(DEV_TEXT) ?? [''])[0]);
  const cards = await page.locator('button.tt-card[aria-label^="Open featured investigation"]').allInnerTexts();
  check(cards.length === 4, `${label}: four featured investigations`);
  check(cards.every((c) => !METRIC_TEXT.test(c) && !/\bevents\b/.test(c)), `${label}: featured cards carry no metrics`);
  check(cards.every((c) => /km²/.test(c) && /live analysis/i.test(c)), `${label}: cards show AOI area + analysis status`);
  const overview = await page.locator('[data-testid="overview-detected-change"]').innerText();
  check(/No completed live analyses/.test(overview), `${label}: overview has no detected-change total`, overview.replace(/\s+/g, ' '));
  const hotspots = await page.evaluate(() => window.__tt.map.getSource('global-hotspots')?._data?.features?.length ?? 0);
  check(hotspots === 0, `${label}: no global hotspots without READY analyses`, `${hotspots} features`);
  const sub = await page.locator('.tt-marker--featured').allInnerTexts();
  check(sub.every((t) => !/events|control/i.test(t)), `${label}: marker labels carry no event counts`);
  check(!FORBIDDEN.test(await page.locator('body').innerText()), `${label}: no demonstration/simulated wording on landing`);

  // ---- every featured analysis
  for (const id of FEATURED) {
    const resp = offline ? null : page.waitForResponse((r) => r.url().includes(`/api/analysis/${id}`), { timeout: ANALYSIS_TIMEOUT }).catch(() => null);
    await page.evaluate((h) => { window.location.hash = h; }, `#/analysis/${id}`);
    const env = resp ? await (await resp)?.json().catch(() => null) : null;
    if (live) {
      if (!env) { check(false, `${label}: ${id} analysis response`, 'no response'); continue; }
      if (env.analysisStatus === 'READY') {
        const errs = validityErrors(env);
        check(errs.length === 0, `${label}: ${id} READY result passes every validity rule`, errs.slice(0, 3).join('; '));
        await page.locator('[role="tablist"]').first().waitFor({ timeout: 20000 }).catch(() => {});
        check((await page.locator('[data-testid="analysis-unavailable"]').count()) === 0, `${label}: ${id} READY renders measured results`);
        await checkTimeline(page, `${label}: ${id}`, env);
        continue;
      }
      check(NON_READY.includes(env.analysisStatus) && !!env.reason && !env.summary && !env.events, `${label}: ${id} non-READY (${env.analysisStatus}) carries a reason and no metrics`, env.reasonCode ?? '');
      if (env.analysisStatus === 'INVALID_ANALYSIS') check((env.quality?.issues?.length ?? 0) > 0, `${label}: ${id} INVALID_ANALYSIS lists the failed checks`);
    }
    const panel = page.locator('[data-testid="analysis-unavailable"]');
    await panel.waitFor({ timeout: 30000 });
    const text = await panel.innerText();
    const reasonOk = live ? !!env?.reason && text.includes(env.reason.slice(0, 40)) : /Live Earth observation is temporarily unavailable/.test(text);
    const bodyText = await page.locator('body').innerText();
    check(!DEV_TEXT.test(bodyText), `${label}: ${id} no developer text in the UI`, (bodyText.match(DEV_TEXT) ?? [''])[0]);
    check(reasonOk && /km²/.test(text), `${label}: ${id} shows ${env?.analysisStatus ?? 'UNAVAILABLE'} with reason + AOI area`);
    if (env?.analysisStatus === 'INVALID_ANALYSIS') check((await page.locator('[data-testid="validity-issues"]').count()) === 1, `${label}: ${id} failed checks are shown in the UI`);
    const strip = await page.locator('[data-testid="no-metrics"]').count();
    check(strip >= 1, `${label}: ${id} metrics strip carries no metrics`);
    const real = await page.locator('[data-testid="real-imagery-label"]').innerText().catch(() => '');
    check(/Real imagery · no analysis/i.test(real), `${label}: ${id} imagery labelled REAL IMAGERY · no analysis`);
    const body = await page.locator('body').innerText();
    check(!METRIC_TEXT.test(body) && !FORBIDDEN.test(body), `${label}: ${id} no metric text rendered`);
    const layers = await page.evaluate(() => ['tt-events', 'tt-events-fill', 'events-fill', 'change-fill'].filter((l) => window.__tt.map.getLayer(l)).length);
    const evs = await page.evaluate(() => window.__tt.state.events.length);
    check(evs === 0, `${label}: ${id} no change events on the map`, `${evs} events, ${layers} layers`);
    await checkTimeline(page, `${label}: ${id}`, env);
  }

  // ---- one canonical window: request 1984 → 2025 and verify it reaches the backend and every display
  if (!live) {
    const id = FEATURED[3];
    const resp = offline ? null : page.waitForResponse((r) => r.url().includes(`/api/analysis/${id}`) && r.url().includes('baseline=1984'), { timeout: 30000 }).catch(() => null);
    await page.evaluate((i) => { window.location.hash = `#/analysis/${i}`; window.__ttUi.getState().setWindow(1984, 2025); }, id);
    if (resp) check(!!(await resp), `${label}: selecting 1984 sends baseline=1984 to the backend`);
    await page.waitForFunction(() => /1984 → 2025/.test(document.querySelector('[data-testid="analysis-unavailable"]')?.textContent ?? ''), null, { timeout: 20000 })
      .then(() => check(true, `${label}: requested window 1984 → 2025 shown in the panel`), () => check(false, `${label}: requested window 1984 → 2025 shown in the panel`));
    check(/[#&?]from=1984&to=2025/.test(await page.evaluate(() => window.location.hash)), `${label}: requested window in the URL`);
    await page.evaluate(() => window.__ttUi.getState().setWindow(2018, 2025));
  }

  // ---- no developer configuration UI exists anywhere
  check((await page.getByRole('button', { name: /Configure Live Data/i }).count()) === 0, `${label}: no developer configuration UI`);

  // ---- exploring the timeline never starts an analysis; only an explicit request does
  {
    const id = FEATURED[3];
    await page.evaluate((i) => { window.location.hash = `#/analysis/${i}`; }, id);
    await page.waitForTimeout(1500);
    let sent = 0;
    const onReq = (r) => { if (r.url().includes('/api/analysis/') && r.url().includes('baseline=1990')) sent++; };
    page.on('request', onReq);
    await page.evaluate(() => window.__ttUi.getState().setPendingWindow(1990, 2025));
    await page.waitForTimeout(1500);
    check(sent === 0, `${label}: selecting 1990 → 2025 in the Time Machine sends no analysis request`);
    const run = page.getByRole('button', { name: /Run live analysis 1990 → 2025/ });
    check((await run.count()) === 1, `${label}: explicit 'Run live analysis' action offered`);
    if (!live && !offline) {
      await run.click();
      await page.waitForTimeout(2000);
      check(sent >= 1, `${label}: the analysis runs only after the explicit request`, `${sent} request(s)`);
    }
    page.off('request', onReq);
    await page.evaluate(() => window.__ttUi.getState().setWindow(2018, 2025));
  }

  // ---- custom AOI (backend only)
  if (!offline) {
    await page.evaluate(() => {
      const s = window.__ttUi.getState();
      s.goExplore('explore');
      s.setSelection({ geometry: { type: 'Polygon', coordinates: [[[76.40, 11.00], [76.48, 11.00], [76.48, 11.08], [76.40, 11.08], [76.40, 11.00]]] }, source: 'draw' });
    });
    const btn = page.getByRole('button', { name: live ? /Analyze forest change/ : /Open area · imagery only/ });
    await btn.waitFor({ timeout: 10000 });
    const resp = page.waitForResponse((r) => r.url().includes('/api/analyze'), { timeout: ANALYSIS_TIMEOUT }).catch(() => null);
    await btn.click();
    const env = await (await resp)?.json().catch(() => null);
    await page.waitForFunction(() => window.__ttUi.getState().aoiId?.startsWith('aoi-'), null, { timeout: 90000 });
    if (live && env?.analysisStatus === 'READY') {
      const errs = validityErrors(env);
      check(errs.length === 0, `${label}: custom AOI READY result passes every validity rule`, errs.slice(0, 3).join('; '));
    } else {
      const text = await page.locator('[data-testid="analysis-unavailable"]').innerText({ timeout: 30000 });
      const statusOk = live ? NON_READY.includes(env?.analysisStatus) && !env?.summary : /Live analysis unavailable/i.test(text);
      check(statusOk && /7\d\.\d+ km²/.test(text), `${label}: custom AOI → ${env?.analysisStatus ?? 'UNAVAILABLE'} with reason, geodesic area, no metrics`, (text.match(/[\d.]+ km²/) ?? [''])[0]);
      const body = await page.locator('body').innerText();
      check(!METRIC_TEXT.test(body), `${label}: custom AOI no metric text rendered`);
    }
    // AI refuses without a READY analysis.
    const ex = await page.evaluate(async () => (await fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ facts: { event_id: 'x' } }) })).json());
    check(ex.source === 'none' && /don't have a completed satellite analysis/.test(ex.text), `${label}: AI refuses non-READY facts`);
  }

  check(errors.length === 0, `${label}: no uncaught page errors`, errors.slice(0, 2).join(' | '));
  await ctx.close();
}

await run('backend', { offline: false });
await run('ui-preview', { offline: true });
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll integrity checks passed');
process.exit(failed ? 1 : 0);
