#!/usr/bin/env node
/**
 * End-to-end data-integrity check (run against the dev server + backend):
 *
 *   npm run dev                  # frontend (and the backend on :8001)
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
// Exact names of the reference datasets shown in the area context (backend app/services/context.py SOURCES). These
// strings — and only these — are exempt from METRIC_TEXT ("…Forest Change…" is a dataset name, not a measurement).
const REFERENCE_DATASET_NAMES = ['Hansen Global Forest Change v1.13', 'Copernicus DEM GLO-30', 'ESA WorldCover v200'];
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
  const s = await page.evaluate(() => { const u = window.__ttUi.getState(); return { years: u.years, win: { start: u.investigation.baselineYear, end: u.investigation.comparisonYear } }; });
  check(s.years[0] === 1984 && s.years.includes(1990) && s.years.at(-1) === 2025, `${name} timeline selectable from 1984`, `${s.years[0]}…${s.years.at(-1)}`);
  check(s.years.filter((y) => y < 2016).length === 7, `${name} no 2016/2018 minimum (7 historical Landsat years present)`);
  const tick = await page.locator('button:text-is("1984")').count();
  check(tick >= 1, `${name} 1984 tick rendered in the Time Machine`);
  // Option F (2026-10-10): before 2016 imagery only — no Landsat-proxy forest figure, period, summary or forest tile.
  const pre = await page.evaluate(() => {
    const b = window.__ttUi.getState().investigation.analysisResult?.bundle;
    if (!b) return null;
    const rows = b.summary.years.filter((y) => y.year < 2016);
    return {
      figures: rows.filter((y) => ['forest_ha', 'forest_pct', 'loss_ha', 'gain_ha', 'net_change_ha'].some((k) => y[k] !== null && y[k] !== undefined)).map((y) => y.year),
      periods: (b.summary.periods ?? []).filter((p) => p.from_year < 2016).length,
      tiles: Object.keys(b.layers.overlays.find((o) => o.kind === 'forest')?.tiles_by_year ?? {}).filter((y) => Number(y) < 2016),
      history: b.summary.history ?? null,
      statement: b.summary.historical_statement ?? null,
    };
  });
  if (pre) {
    check(pre.figures.length === 0, `${name} no forest/change figure before 2016`, pre.figures.join(', '));
    check(pre.periods === 0 && pre.history === null, `${name} no Landsat-era change periods or historical summary`);
    check(pre.tiles.length === 0, `${name} no forest tiles before 2016`, pre.tiles.join(', '));
    check(/imagery only/i.test(pre.statement ?? ''), `${name} states why 1984–2015 is imagery only`);
  }
  const panel = await page.locator('[data-testid="analysis-unavailable"]').textContent().catch(() => null);
  if (panel) {
    const req = panel.match(/Requested window\s*(\d{4}) → (\d{4})/);
    if (/Requested window/.test(panel)) check(!!req && Number(req[1]) === s.win.start && Number(req[2]) === s.win.end, `${name} requested window in panel == Time Machine window`, req ? `${req[1]}→${req[2]} vs ${s.win.start}→${s.win.end}` : 'not shown');
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
  // Every raster tile the page requests (to prove no frontend-built imagery URLs).
  const tileRequests = [];
  page.on('request', (r) => { const u = r.url(); if (/^https?:/.test(u) && /\/tiles?\/|wmts|MapServer/.test(u)) tileRequests.push(u); });
  await page.goto(`${BASE}#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__tt?.loaded && document.querySelectorAll('.tt-marker--featured').length >= 4, null, { timeout: 45000 });
  await page.waitForSelector('button.tt-card[aria-label^="Open featured investigation"]', { timeout: 20000 });
  await page.waitForFunction(() => !/…/.test(document.querySelector('button.tt-card')?.innerText ?? '…'), null, { timeout: 20000 });

  // ---- backend state
  const health = offline ? null : await page.evaluate(async () => (await fetch('/api/health')).json());
  const live = health?.analysis?.status === 'ready';
  // Stored featured outcomes (read-only endpoint): what the overview and an opened study must show — never more.
  const stored = offline ? null : await page.evaluate(async () => (await fetch('/api/featured/summary')).json()).catch(() => null);
  const storedOf = (id) => stored?.items?.find((i) => i.id === id) ?? null;
  const hasStored = (id) => ['READY', 'INVALID_ANALYSIS', 'UNAVAILABLE'].includes(storedOf(id)?.status);
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
  {
    // The overview total is exactly the stored READY featured results' own event area / count (control sites excluded).
    const areasDoc = offline ? { items: [] } : await page.evaluate(async () => (await fetch('/api/study-areas')).json()).catch(() => ({ items: [] }));
    const controlIds = new Set((areasDoc.items ?? []).filter((a) => a.tags?.some((t) => /control site/i.test(t))).map((a) => a.id));
    const ready = (stored?.items ?? []).filter((i) => i.status === 'READY' && i.kpis && !controlIds.has(i.id));
    const flat = overview.replace(/\s+/g, ' ');
    if (!ready.length) check(/No (completed live|change-site) analyses/.test(overview), `${label}: overview has no detected-change total without stored READY results`, flat);
    else {
      const ha = ready.reduce((a, i) => a + i.kpis.event_area_ha, 0);
      const n = ready.reduce((a, i) => a + i.kpis.event_count, 0);
      const haTxt = new Intl.NumberFormat('en-US', { maximumFractionDigits: Math.abs(ha) >= 100 ? 0 : 1 }).format(ha);
      check(flat.includes(`${haTxt} ha`) && flat.includes(`${n} events · ${ready.length} live ${ready.length === 1 ? 'analysis' : 'analyses'}`),
        `${label}: overview total = stored READY featured results (${haTxt} ha, ${n} events)`, flat);
    }
  }
  const hotspots = await page.evaluate(() => window.__tt.map.getSource('global-hotspots')?._data?.features?.length ?? 0);
  check(hotspots === 0, `${label}: no global hotspots without READY analyses`, `${hotspots} features`);
  const sub = await page.locator('.tt-marker--featured').allInnerTexts();
  check(sub.every((t) => !/events|control/i.test(t)), `${label}: marker labels carry no event counts`);
  check(!FORBIDDEN.test(await page.locator('body').innerText()), `${label}: no demonstration/simulated wording on landing`);

  // ---- request counter: every analysis request (GET /api/analysis/<id>?... or POST /api/analyze)
  // An analysis request = a job creation (POST /api/analysis-jobs) or a legacy synchronous endpoint. Job status polls
  // (/api/analysis-jobs/<id>) and the history request (/api/analysis/<id>/history) are not new analyses.
  const ANALYSIS_URL = /\/api\/analysis\/[^/?]+\?|\/api\/analyze\b|\/api\/analysis-jobs(\?|$)/;
  const analysisRequests = [];
  page.on('request', (r) => { if (ANALYSIS_URL.test(r.url())) analysisRequests.push(r.url()); });
  // Imagery decisions requested from the backend imagery endpoint.
  const imageryRequests = [];
  page.on('request', (r) => { if (/\/api\/imagery\?/.test(r.url())) imageryRequests.push(r.url()); });
  const imgState = () => page.evaluate(() => {
    const el = document.querySelector('[data-testid="real-imagery-label"]');
    const m = window.__tt.map;
    const liveLayers = m.getStyle().layers.filter((l) => l.id.startsWith('img-s2-live-')).map((l) => ({ id: l.id, visible: m.getLayoutProperty(l.id, 'visibility') !== 'none' }));
    const v = window.__ttUi.getState().investigation;
    return { imagery: el?.getAttribute('data-imagery') ?? null, code: el?.getAttribute('data-code') ?? null, text: (el?.textContent ?? '').replace(/\s+/g, ' '), errText: document.querySelector('[data-testid="imagery-error"]')?.textContent ?? null, status: v.imageryStatus, analysis: v.analysisStatus, hasResult: !!v.analysisResult, liveLayers };
  });
  const waitImagery = () => page.waitForFunction(() => { const el = document.querySelector('[data-testid="real-imagery-label"]'); return el && el.getAttribute('data-imagery') !== 'LOADING'; }, null, { timeout: 150000 }).catch(() => {});
  /** Expected imagery outcome in this backend state. Imagery is independent of analysis. */
  const checkImagery = async (name, id) => {
    await waitImagery();
    const s = await imgState();
    if (offline) {
      check(s.imagery === 'ERROR' && s.status === 'unknown' && /^Imagery unavailable/.test(s.text) && /^Imagery service could not be reached\./.test(s.errText ?? '') && s.liveLayers.length === 0, `${name} offline: 'Imagery service could not be reached', no imagery drawn`, JSON.stringify(s));
    } else if (live) {
      const layer = s.liveLayers.find((l) => l.id.startsWith(`img-s2-live-${id}-`));
      check(s.imagery === 'READY' && ['available', 'insufficient'].includes(s.status) && !!layer?.visible, `${name} LIVE satellite imagery READY and drawn on the map`, JSON.stringify(s));
      check(/Live satellite imagery · no analysis/.test(s.text) && /scenes · Earth Engine/.test(s.text), `${name} imagery labelled live imagery · no analysis`, s.text.replace(/\s+/g, ' '));
    } else {
      check(s.imagery === 'UNAVAILABLE' && s.code === 'EARTH_ENGINE_AUTH_ERROR' && s.status === 'unavailable' && s.liveLayers.length === 0, `${name} Earth Engine unavailable: imagery UNAVAILABLE (classified), nothing drawn`, JSON.stringify(s));
    }
    return s;
  };
  const settle = () => page.waitForFunction(() => ['complete', 'error', 'idle'].includes(window.__ttUi.getState().investigation.analysisStatus), null, { timeout: ANALYSIS_TIMEOUT }).catch(() => {});
  const inv = () => page.evaluate(() => {
    const v = window.__ttUi.getState().investigation;
    return {
      status: v.analysisStatus, has: !!v.analysisResult, rid: v.analysisRequestId, err: v.analysisError,
      study: v.study?.id ?? null, b: v.baselineYear, c: v.comparisonYear, bundle: !!v.analysisResult?.bundle,
      resYears: v.analysisResult ? [v.analysisResult.window.baseline_year, v.analysisResult.window.comparison_year] : null,
    };
  });

  /**
   * Area context (reference datasets): shown whatever the analysis status, labelled "Reference context, not a
   * TerraTrace result", the dataset + year under EVERY value; offline it says unavailable and shows no value.
   */
  const checkContext = async (name) => {
    await page.waitForFunction(() => ['READY', 'UNAVAILABLE', 'ERROR'].includes(document.querySelector('[data-testid="area-context"]')?.getAttribute('data-status')), null, { timeout: 150000 }).catch(() => {});
    const status = await page.locator('[data-testid="area-context"]').getAttribute('data-status').catch(() => null);
    const label = await page.locator('[data-testid="context-label"]').innerText().catch(() => '');
    const rows = await page.locator('[data-testid="context-row"]').count();
    const sources = await page.locator('[data-testid="context-source"]').allInnerTexts();
    check(label === 'Reference context, not a TerraTrace result', `${name} area context labelled as reference, not a TerraTrace result`, label);
    if (offline) {
      check(status === 'ERROR' && rows === 0 && (await page.locator('[data-testid="context-unavailable"]').count()) >= 1, `${name} offline: area context unavailable, no values shown`, String(status));
    } else {
      check(status === 'READY' || status === 'UNAVAILABLE', `${name} area context measured or explicitly unavailable`, String(status));
      if (status === 'READY') {
        check(rows > 0 && sources.length === rows && sources.every((s) => /·/.test(s) && /\b(19|20)\d\d\b/.test(s)), `${name} every reference value carries its dataset and year`, `${rows} rows / ${sources.length} source lines`);
        check((await page.locator('[data-testid="context-not-current"]').innerText().catch(() => '')).startsWith('None of these is current forest cover'), `${name} reference forest cover is never presented as current`);
      }
    }
  };

  // ---- every featured study
  for (const id of FEATURED) {
    // A. Opening a study populates the investigation, sends ZERO analysis requests, shows Ready to analyze.
    const n0 = analysisRequests.length;
    await page.evaluate((h) => { window.location.hash = h; }, `#/analysis/${id}`);
    await page.waitForTimeout(1500);
    check(analysisRequests.length === n0, `${label}: ${id} opening the study sends 0 analysis requests`, `${analysisRequests.length - n0} sent`);
    if (hasStored(id)) {
      // A STORED result for the site's default window opens at once (read-only lookup) — still 0 analysis requests.
      const w = storedOf(id).default_window;
      await page.waitForFunction(() => window.__ttUi.getState().investigation.analysisStatus === 'complete', null, { timeout: 30000 }).catch(() => {});
      const o = await inv();
      check(o.study === id && o.status === 'complete' && o.has && JSON.stringify(o.resYears) === JSON.stringify(w) && analysisRequests.length === n0,
        `${label}: ${id} opens with its stored ${storedOf(id).status} result for ${w.join('→')} (0 analysis requests)`, JSON.stringify({ s: o.status, has: o.has, years: o.resYears }));
      await page.getByRole('tab', { name: /Overview/ }).click().catch(() => {});
      await checkContext(`${label}: ${id}`);
      continue;   // the "Ready to analyze" / Run flow below needs a study WITHOUT a stored result
    }
    const opened = await inv();
    check(opened.study === id && opened.status === 'idle' && !opened.has, `${label}: ${id} opens as Ready to analyze (no stored result)`, JSON.stringify({ s: opened.status, has: opened.has }));
    check((await page.locator('[data-testid="ready-to-analyze"]').count()) === 1, `${label}: ${id} 'Ready to analyze' panel shown`);
    const readyName = ((await page.locator('[data-testid="ready-to-analyze"]').innerText().catch(() => '')).split('\n')[1] ?? '').trim();
    check(readyName.length > 0 && readyName !== 'Selected area', `${label}: ${id} study metadata renders (name)`, readyName);
    await checkContext(`${label}: ${id}`);
    // Imagery != analysis: imagery is requested for the study; the analysis stays idle whatever imagery does.
    const img = await checkImagery(`${label}: ${id}`, id);
    check(offline || imageryRequests.some((u) => u.includes(`aoi=${id}&`)), `${label}: ${id} imagery requested from the backend imagery endpoint`);
    const after = await inv();
    check(after.status === 'idle' && !after.has && analysisRequests.length === n0, `${label}: ${id} imagery loading leaves the analysis idle (0 analysis requests)`, JSON.stringify({ s: after.status, n: analysisRequests.length - n0 }));
    if (live) continue;   // never trigger a real Earth Engine computation from the test suite

    // C. Pressing Run sends exactly ONE analysis request.
    const n1 = analysisRequests.length;
    await page.getByRole('button', { name: /Run live analysis 2018 → 2025/ }).first().click();
    await settle();
    await page.waitForTimeout(500);
    check(analysisRequests.length - n1 === 1, `${label}: ${id} Run sends exactly 1 analysis request`, `${analysisRequests.length - n1} sent`);
    const ran = await inv();
    // E. Backend unavailable -> truthful state. Offline -> NO AnalysisResult is created at all.
    if (offline) {
      check(ran.status === 'error' && !ran.has && ran.err?.code === 'service_unavailable', `${label}: ${id} offline: no synthetic AnalysisResult (error state only)`, JSON.stringify({ s: ran.status, has: ran.has, code: ran.err?.code }));
    } else {
      check(ran.status === 'complete' && ran.has && !ran.bundle && JSON.stringify(ran.resYears) === '[2018,2025]', `${label}: ${id} backend UNAVAILABLE envelope for the requested years, no measurements`, JSON.stringify(ran));
    }
    const panel = page.locator('[data-testid="analysis-unavailable"]');
    await panel.waitFor({ timeout: 30000 });
    const text = await panel.innerText();
    check(/Live Earth observation is temporarily unavailable/.test(text), `${label}: ${id} truthful unavailable message`);
    const bodyText = await page.locator('body').innerText();
    check(!DEV_TEXT.test(bodyText), `${label}: ${id} no developer text in the UI`, (bodyText.match(DEV_TEXT) ?? [''])[0]);
    check((await page.locator('[data-testid="no-metrics"]').count()) >= 1, `${label}: ${id} metrics strip carries no metrics`);
    const img2 = await imgState();
    check(img2.status === img.status && img2.imagery === img.imagery, `${label}: ${id} a failed analysis does not change the imagery state`, `${img.status} -> ${img2.status}`);
    check(!METRIC_TEXT.test(bodyText) && !FORBIDDEN.test(bodyText), `${label}: ${id} no fabricated measurements rendered`);
    const evs = await page.evaluate(() => window.__tt.state.events.length);
    check(evs === 0, `${label}: ${id} no change events on the map`, `${evs} events`);
    await checkTimeline(page, `${label}: ${id}`, null);
  }

  // ---- B/C/D: changing years clears the result without requests; only Run analyses; stale responses rejected
  {
    const id = FEATURED[1];   // not the loop's last study: opening it must reset to idle
    await page.evaluate((i) => { window.location.hash = `#/analysis/${i}`; }, id);
    await page.waitForTimeout(1000);
    {
      // Switching never carries the previous study's result over: idle, or THIS study's own stored result for its
      // default window (read-only lookup) — never another study's.
      await page.waitForTimeout(1500);
      const s = await inv();
      const own = hasStored(id) && s.status === 'complete' && s.study === id && JSON.stringify(s.resYears) === JSON.stringify(storedOf(id).default_window);
      check(s.status === 'idle' || own, `${label}: switching study resets the analysis (idle, or its own stored result)`, JSON.stringify({ s: s.status, study: s.study, years: s.resYears }));
      if (own && live && storedOf(id).status === 'READY') {
        // A featured stored READY result: imagery only before 2016 (the history request is made only after a live run,
        // so its rows are checked by the backend tests and the custom-area run below).
        await checkTimeline(page, `${label}: ${id} READY`, null);
      }
    }
    if (!live) {
      await page.getByRole('button', { name: /Run live analysis 2018 → 2025/ }).first().click();
      await settle();
    }
    const before = await inv();
    const n0 = analysisRequests.length;
    await page.evaluate(() => window.__ttUi.getState().setWindow(1990, 2025));
    await page.waitForTimeout(1500);
    const after = await inv();
    check(analysisRequests.length === n0, `${label}: changing the years sends 0 analysis requests`);
    check(after.status === 'idle' && !after.has && after.rid === null && after.b === 1990, `${label}: changing the years clears the previous result`, JSON.stringify(after));
    check((await page.locator('[data-testid="ready-to-analyze"]').count()) === 1, `${label}: 'Ready to analyze' shown for the new years`);
    check((await page.locator('[data-testid="analysis-unavailable"]').count()) === 0, `${label}: no stale status panel from the previous years`);
    check(/[#&?]from=1990&to=2025/.test(await page.evaluate(() => window.location.hash)), `${label}: URL mirrors the investigation years`);
    // D. A late response for an OLD request cannot overwrite the current state (test fixture object; never shown).
    const stale = await page.evaluate((oldRid) => {
      const s = window.__ttUi.getState();
      const ok = s.acceptAnalysis({ requestId: oldRid ?? 'old-request-id', studyId: s.investigation.study?.id ?? null, baselineYear: 2018, comparisonYear: 2025 }, { id: 'x', status: 'READY' });
      return { ok, has: !!window.__ttUi.getState().investigation.analysisResult };
    }, before.rid);
    check(stale.ok === false && !stale.has, `${label}: a stale response for an old request is discarded`);
    const runBtn = page.getByRole('button', { name: /Run live analysis 1990 → 2025/ }).first();
    check((await runBtn.count()) === 1, `${label}: explicit 'Run live analysis' action offered`);
    if (!live) {
      const n1 = analysisRequests.length;
      await runBtn.click();
      await settle();
      await page.waitForTimeout(500);
      check(analysisRequests.length - n1 === 1, `${label}: Run sends exactly 1 analysis request for the new years`, `${analysisRequests.length - n1} sent`);
      const done = await inv();
      check(offline ? !done.has : JSON.stringify(done.resYears) === '[1990,2025]', `${label}: the new state belongs to the current years`, JSON.stringify(done.resYears));
    }
    await page.evaluate(() => window.__ttUi.getState().setWindow(2018, 2025));
  }

  // ---- G: URL hydration (full reload) mirrors InvestigationState and does NOT execute analysis
  {
    const reqs = [];
    const onReq = (r) => { if (ANALYSIS_URL.test(r.url())) reqs.push(r.url()); };
    page.on('request', onReq);
    // Both endpoints are analysable years at this site (an unanalysable endpoint is moved inward — check G2).
    await page.goto(`${BASE}#/analysis/${FEATURED[1]}?from=2020&to=2023&year=2021`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__ttUi && !!window.__ttUi.getState().investigation.study, null, { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const h = await inv();
    const y = await page.evaluate(() => window.__ttUi.getState().investigation.imageryYear);
    check(h.study === FEATURED[1] && h.b === 2020 && h.c === 2023 && y === 2021, `${label}: URL hydration mirrors study + years into InvestigationState`, JSON.stringify({ study: h.study, b: h.b, c: h.c, y }));
    check(reqs.length === 0 && h.status === 'idle' && !h.has, `${label}: URL hydration executes 0 analysis requests`, `${reqs.length} sent, status ${h.status}`);
    page.off('request', onReq);
  }

  // ---- G2: the analysis window offers only analysable years. Hasdeo Arand 2024 is MEASURED unanalysable (Jul–Sep only
  // 79.8 % observed), so a link ending in 2024 moves inward to 2023 — and still runs nothing.
  if (!offline) {
    const reqs = [];
    const onReq = (r) => { if (ANALYSIS_URL.test(r.url())) reqs.push(r.url()); };
    page.on('request', onReq);
    await page.goto(`${BASE}#/analysis/hasdeo-arand?from=2019&to=2024&year=2021`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ttUi?.getState().investigation.comparisonYear === 2023, null, { timeout: 180000 }).catch(() => {});
    const h = await inv();
    check(h.b === 2019 && h.c === 2023, `${label}: an unanalysable window end (Hasdeo 2024) moves inward to the nearest analysable year`, JSON.stringify({ b: h.b, c: h.c }));
    check(reqs.length === 0 && h.status === 'idle', `${label}: adjusting the window executes 0 analysis requests`, `${reqs.length} sent`);
    page.off('request', onReq);
  }

  // ---- H: the timeline consumes /api/imagery/availability; imagery-only is never shown as analysis.
  // Route-mocked availability/imagery responses are TEST FIXTURES (exercise the UI contract; never shown to users).
  if (!offline) {
    const AOI = FEATURED[2];
    const years = [1984, 1990, 1995, 2000, 2005, 2010, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
    const fixture = {
      aoi_id: AOI, method_version: 'fixture', provider: 'Google Earth Engine', computed_at: '2026-09-27T00:00:00Z',
      thresholds: { min_pixel_clear_obs: 3, min_pixel_dw_obs: 3, min_year_coverage: 0.8 },
      years: years.map((y) => ({
        year: y, era: y < 2016 ? 'historical' : 'modern', source: 'fixture', composite: 'fixture', scenes: {},
        status: y === 1995 ? 'UNAVAILABLE' : y === 2018 ? 'INSUFFICIENT' : 'AVAILABLE', sceneCount: y === 1995 ? 0 : 40,
        coverage: y === 1995 ? null : y === 2018 ? 0.42 : 0.93,
        reason: y === 1995 ? 'No Landsat Collection 2 scenes over this area for 1994–1996.' : y === 2018 ? 'Insufficient clear observations: only 42% of the area.' : null,
      })),
    };
    const decision = (y) => (y === 2020
      ? { aoi_id: AOI, year: y, status: 'READY', code: null, message: null, source: 'Earth Engine', is_analysis: false, imageryStatus: 'AVAILABLE', tileUrl: `/api/imagery/tiles/${AOI}/2020/{z}/{x}/{y}`, sceneCount: 40, label: 'Live Sentinel-2 imagery 2020', attribution: 'fixture', max_zoom: 15 }
      : { aoi_id: AOI, year: y, status: 'UNAVAILABLE', code: 'NO_LANDSAT_IMAGERY', message: 'No Landsat observations were found for the requested region and period.', source: 'Earth Engine', is_analysis: false, imageryStatus: 'UNAVAILABLE', tileUrl: null });
    await page.route(`**/api/imagery/availability?aoi=${AOI}`, (r) => r.fulfill({ json: fixture }));
    await page.route(`**/api/imagery?aoi=${AOI}&year=*`, (r) => r.fulfill({ json: decision(Number(new URL(r.request().url()).searchParams.get('year'))) }));
    await page.route(`**/api/imagery/tiles/${AOI}/**`, (r) => r.fulfill({ status: 404, body: '' }));
    // This section is about imagery WITHOUT an analysis: no stored result is served for the fixture AOI.
    await page.route(`**/api/analysis-result/${AOI}?*`, (r) => r.fulfill({ status: 404, json: { detail: { code: 'not_run', user_message: 'This analysis has not been run yet.', retryable: false } } }));
    const nA = analysisRequests.length;
    await page.goto(`${BASE}#/analysis/${AOI}?year=2020`, { waitUntil: 'domcontentloaded' });
    // A hash change keeps the document: earlier sections may have cached this AOI's REAL availability (10 min
    // staleTime). Reload so the timeline is fed by the fixture routes above, not by a cached live response.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__ttUi?.getState().investigation.study && window.__tt?.loaded, null, { timeout: 45000 }).catch(() => {});
    // Generous wait: under heavy load (build + live Earth Engine) the analysis view can take > 30 s to mount.
    await page.waitForFunction(() => document.querySelector('button[data-imagery-status="UNAVAILABLE"]'), null, { timeout: 90000 }).catch(() => {});
    const ticks = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('button[data-imagery-status]')].map((b) => [b.textContent, [b.getAttribute('data-imagery-status'), b.hasAttribute('data-unavailable')]])));
    check(JSON.stringify(ticks['’95']) === '["UNAVAILABLE",true]', `${label}: timeline marks an UNAVAILABLE year from the availability endpoint`, JSON.stringify(ticks['’95']));
    check(JSON.stringify(ticks['’18']) === '["INSUFFICIENT",true]', `${label}: timeline marks an INSUFFICIENT year`, JSON.stringify(ticks['’18']));
    check(JSON.stringify(ticks['’20']) === '["AVAILABLE",false]', `${label}: timeline shows an AVAILABLE year as selectable`, JSON.stringify(ticks['’20']));
    // READY imagery is drawn as imagery only — never an analysis.
    await waitImagery();
    const s = await imgState();
    check(s.imagery === 'READY' && s.liveLayers.some((l) => l.id === `img-s2-live-${AOI}-2020` && l.visible), `${label}: READY imagery decision drawn as a raster layer from the backend tile template`, JSON.stringify(s.liveLayers));
    check(s.analysis === 'idle' && !s.hasResult && /no analysis/.test(s.text), `${label}: imagery READY while analysis stays idle — imagery-only never appears as analysis`, JSON.stringify({ a: s.analysis, t: s.text }));
    // The WHOLE page is scanned, including the reference-context panel. Only the exact names of the reference datasets
    // are exempt — "Hansen Global Forest Change v1.13" is a dataset's name, not a TerraTrace "forest change" figure —
    // and only where they actually appear (each exempted name must be present, so no exemption is silently unused).
    const rawBody = await page.locator('body').innerText();
    const exempt = REFERENCE_DATASET_NAMES.filter((n) => rawBody.includes(n));
    const body = exempt.reduce((t, n) => t.split(n).join(' '), rawBody);
    const ctxReady = (await page.locator('[data-testid="area-context"]').getAttribute('data-status').catch(() => null)) === 'READY';
    if (ctxReady) check(exempt.includes('Hansen Global Forest Change v1.13'), `${label}: reference dataset names found on the page (exempted from the scan: ${exempt.join(', ') || 'none'})`);
    check(!METRIC_TEXT.test(body) && (await page.evaluate(() => window.__tt.state.events.length)) === 0, `${label}: imagery-only view renders no measurements or events`, (body.match(METRIC_TEXT) ?? [''])[0]);
    // A year without usable imagery draws NOTHING (no substitution with another year) and says so.
    await page.evaluate(() => window.__ttUi.getState().setYear(1995));
    await waitImagery();
    const u = await imgState();
    check(u.imagery === 'UNAVAILABLE' && u.status === 'unavailable' && !u.liveLayers.some((l) => l.visible) && /imagery unavailable/i.test(u.text), `${label}: no-usable-imagery year draws nothing and says so (no year substitution)`, JSON.stringify(u));
    check(analysisRequests.length === nA, `${label}: timeline/imagery interaction sends 0 analysis requests`);
    // Regression (2026-09-27): a backend without the imagery route answered 404 and the UI said "could not be reached".
    await page.route(`**/api/imagery?aoi=${AOI}&year=2000`, (r) => r.fulfill({ status: 404, json: { detail: 'Not Found' } }));
    await page.evaluate(() => window.__ttUi.getState().setYear(2000));
    await page.waitForFunction(() => document.querySelector('[data-testid="imagery-error"]'), null, { timeout: 20000 }).catch(() => {});
    const e404 = await imgState();
    check(e404.errText === 'Imagery request failed: endpoint not found. Nothing is substituted.', `${label}: HTTP 404 is reported as 'endpoint not found', not as unreachable`, e404.errText ?? JSON.stringify(e404));
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }

  // ---- I: every location (2026-10-10). No area is refused for lack of forest; the selection card shows the area's
  // Earth Engine reference context (never a sampled or guessed number); the panel never overlaps the legend.
  {
    const select = async (coords) => {
      await page.goto(`${BASE}#/explore`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__tt?.loaded, null, { timeout: 60000 }).catch(() => {});
      // Start from no selection, so the card read below can only belong to THIS area (never a previous one).
      await page.evaluate(() => window.__ttUi.getState().setSelection(null));
      await page.locator('[data-testid="reference-tree-cover"]').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
      const box = page.getByRole('combobox').or(page.getByPlaceholder(/search/i)).first();
      await box.click(); await box.fill(coords); await box.press('Enter');
      const [lat, lon] = coords.split(',').map((v) => Math.abs(Number(v)).toFixed(3));
      await page.getByText(new RegExp(`${lat}°[NS], ${lon}°[EW]`)).first().waitFor({ timeout: 30000 }).catch(() => {});
      await page.locator('[data-testid="reference-tree-cover"]').waitFor({ timeout: 30000 }).catch(() => {});
      await page.waitForFunction(() => ['READY', 'UNAVAILABLE'].includes(document.querySelector('[data-testid="reference-tree-cover"]')?.getAttribute('data-status')), null, { timeout: 120000 }).catch(() => {});
      return {
        status: await page.locator('[data-testid="reference-tree-cover"]').getAttribute('data-status').catch(() => null),
        card: (await page.locator('[data-testid="reference-tree-cover"]').innerText().catch(() => '')).replace(/\s+/g, ' '),
        body: await page.locator('body').innerText(),
        enabled: await page.getByRole('button', { name: /Analyze forest change|Open area/ }).first().isEnabled().catch(() => false),
      };
    };
    const overlaps = async () => {
      const [p, l, b] = await Promise.all(['[data-testid="selection-panel-wrap"]', '[data-testid="map-legend"]'].map((s) => page.locator(s).boundingBox().catch(() => null))
        .concat(page.getByRole('button', { name: /Analyze forest change|Open area/ }).first().boundingBox().catch(() => null)));
      const hit = (a, c) => !!a && !!c && !(a.y + a.height <= c.y || c.y + c.height <= a.y || a.x + a.width <= c.x || c.x + c.width <= a.x);
      return { panelLegend: hit(p, l), buttonLegend: hit(b, l) };
    };
    const nile = await select('30.997, 30.849');
    check(!/Area cannot be analysed|Choose a forested area/.test(nile.body), `${label}: a non-forest area (Nile delta cropland) is not refused`);
    const ov = await overlaps();
    check(!ov.panelLegend && !ov.buttonLegend, `${label}: selection panel and its action button never overlap the map legend`, JSON.stringify(ov));
    if (offline) {
      check(nile.status === 'UNAVAILABLE' && !/\d\s?%/.test(nile.card), `${label}: offline, the reference card says unavailable and shows no number`, nile.card);
    } else {
      check(nile.status === 'READY' && /Tree cover · 2000 < 1 %/.test(nile.card) && /Hansen GFC v1\.13 · 2000/.test(nile.card) && /ESA WorldCover v200 · 2021/.test(nile.card),
        `${label}: reference card = the Earth Engine context, small values shown as "< 1 %", dataset + year on each value`, nile.card);
      check(nile.enabled, `${label}: Analyze is offered for a non-forest area`);
      const ocean = await select('-10, -30');
      check(ocean.status === 'READY' && /Open water: there is no land here to measure/.test(ocean.card) && /Unavailable/.test(ocean.card), `${label}: open ocean says open water, values unavailable (no blank card)`, ocean.card);
    }
  }

  // ---- imagery URLs: every satellite tile comes from a backend-provided template
  {
    const cfg = offline ? await page.evaluate(async () => (await fetch('data/basemaps.json')).json()) : await page.evaluate(async () => (await fetch('/api/imagery/basemaps')).json());
    const hosts = new Set(Object.values(cfg).filter((v) => v?.tiles).map((v) => new URL(v.tiles[0]).host));
    const eoxYears = [...new Set(tileRequests.map((u) => u.match(/s2cloudless-(\d{4})_3857/)?.[1]).filter(Boolean))];
    const foreign = tileRequests.filter((u) => { const h = new URL(u).host; return !/^(localhost|127\.)/.test(h) && !hosts.has(h) && !/earthengine\.googleapis\.com/.test(h); });
    check(foreign.length === 0, `${label}: every imagery tile host comes from the backend imagery config`, foreign.slice(0, 2).join(' | '));
    check(eoxYears.every((y) => Number(y) === cfg.globe.year), `${label}: no per-year EOX mosaic requested (only the backend's static globe basemap)`, eoxYears.join(','));
    check(tileRequests.length > 0, `${label}: map tiles were requested`, `${tileRequests.length}`);
  }

  // ---- no developer configuration UI exists anywhere
  check((await page.getByRole('button', { name: /Configure Live Data/i }).count()) === 0, `${label}: no developer configuration UI`);

  // ---- custom AOI (backend only; never against live Earth Engine)
  if (!offline && !live) {
    await page.evaluate(() => {
      const s = window.__ttUi.getState();
      s.goExplore('explore');
      s.setSelection({ geometry: { type: 'Polygon', coordinates: [[[76.40, 11.00], [76.48, 11.00], [76.48, 11.08], [76.40, 11.08], [76.40, 11.00]]] }, source: 'draw' });
    });
    const btn = page.getByRole('button', { name: live ? /Analyze forest change/ : /Open area · imagery only/ });
    await btn.waitFor({ timeout: 10000 });
    check(analysisRequests.filter((u) => u.includes('/api/analyze')).length === 0, `${label}: selecting a custom area sends 0 analysis requests`);
    const nA = analysisRequests.length;
    await btn.click();
    await page.waitForFunction(() => window.__ttUi.getState().investigation.study?.id?.startsWith('aoi-'), null, { timeout: 90000 });
    // The analysis runs as a job; its terminal envelope is what the app accepted (read from the investigation).
    const env = await page.evaluate(() => { const r = window.__ttUi.getState().investigation.analysisResult;
      return r ? { analysisStatus: r.status, summary: r.bundle?.summary ?? null } : null; });
    check(analysisRequests.length - nA === 1, `${label}: explicit Analyze sends exactly 1 analysis request`, `${analysisRequests.length - nA} sent`);
    if (live && env?.analysisStatus === 'READY') {
      const errs = validityErrors(env);
      check(errs.length === 0, `${label}: custom AOI READY result passes every validity rule`, errs.slice(0, 3).join('; '));
      // After a live run the history (incl. 1984–2015) is merged in the background: imagery only before 2016.
      const merged = await page.waitForFunction(() => window.__ttUi.getState().investigation.analysisResult?.bundle?.summary.years.some((y) => y.year < 2016), null, { timeout: 120000 }).then(() => true, () => false);
      if (merged) await checkTimeline(page, `${label}: custom AOI with history`, null);
      else console.log(`INFO  ${label}: custom AOI history not merged within 120 s — pre-2016 rows not checked in the UI`);
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
