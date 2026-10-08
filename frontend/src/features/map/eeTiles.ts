/**
 * Earth Engine tile loading — graceful under Earth Engine's concurrency limit (HTTP 429 RESOURCE_EXHAUSTED,
 * which a project in Restricted Mode hits quickly). This never bypasses the quota; it only avoids
 * over-asking and fails individual tiles cleanly:
 *
 *   - at most MAX_IN_FLIGHT Earth Engine tile requests at once (the rest wait in a FIFO queue);
 *   - MapLibre's abort signal is honoured, so tiles the map no longer needs (pan / zoom / fly-to)
 *     leave the queue without ever being requested;
 *   - a 429 is retried ONCE after RETRY_DELAY_MS (+ jitter);
 *   - a tile throttled again is PARKED (still pending, still cancellable). Once no new 429 has been seen
 *     for RECOVERY_QUIET_MS, every parked tile is re-requested ONCE (through the same limiter). A 429 in
 *     that recovery pass fails that tile only — the layer and every other tile stay on the map.
 *     At most 3 requests per tile; nothing retries indefinitely;
 *   - the browser HTTP cache and MapLibre's tile cache are used as normal (no cache-busting).
 *
 * Used only for backend Earth Engine templates (/api/imagery/tiles/…, /api/tiles/…). MapLibre itself
 * has no tile retry, so this is the single retry mechanism.
 */
import maplibregl from 'maplibre-gl';
import { create } from 'zustand';
import { apiUrl } from '../../data/client';

const SCHEME = 'ttee';
// Measured 2026-09-27 (Restricted Mode, fresh 256 px tiles, ~4–5 s each): 8 tiles took 26.9 s at 2 in flight and
// 10.1 s at 3 with no 429; at 4, 3 of 8 were throttled. 3 is the fastest setting that stays under the limit.
const MAX_IN_FLIGHT = 3;
const RETRY_DELAY_MS = 1500;
const THROTTLE_NOTICE_MS = 6000;
const RECOVERY_QUIET_MS = 6000;

/** Error name of a tile still throttled after its recovery pass (lets the map tell it apart from a connection failure). */
export const THROTTLED = 'EeTileThrottled';

interface EeTileState {
  /** 429 responses that were retried or parked / tiles given up after the recovery pass (this session). */
  throttled: number;
  failedThrottled: number;
  /** True while a 429 happened within the last few seconds (drives the "throttled · retrying" notice). */
  throttling: boolean;
}
export const useEeTiles = create<EeTileState>(() => ({ throttled: 0, failedThrottled: 0, throttling: false }));

let inFlight = 0;
/** Analysis-overlay tiles (/api/tiles/…: forest masks, analysis composites) in flight. They are far slower for
 * Earth Engine than imagery tiles, so they may hold at most OVERLAY_MAX_IN_FLIGHT of the slots: real imagery
 * (/api/imagery/tiles/…) always keeps at least one slot and is served first. The total stays MAX_IN_FLIGHT. */
const OVERLAY_MAX_IN_FLIGHT = 2;
let overlayInFlight = 0;
const queue: Array<{ start(): void; signal: AbortSignal; overlay: boolean }> = [];
let noticeTimer: number | undefined;
/** Tiles throttled twice, waiting for the single recovery pass. */
const parked: Array<{ resume(): void; signal: AbortSignal }> = [];
let recoveryTimer: number | undefined;

const abortError = () => new DOMException('Tile request aborted', 'AbortError');
const devLog = (...a: unknown[]) => { if (import.meta.env.DEV) console.debug('[ee-tiles]', ...a); };

const canStart = (overlay: boolean) => inFlight < MAX_IN_FLIGHT && (!overlay || overlayInFlight < OVERLAY_MAX_IN_FLIGHT);

function acquire(signal: AbortSignal, overlay: boolean): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (canStart(overlay)) { inFlight++; if (overlay) overlayInFlight++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const entry = { signal, overlay, start: () => { signal.removeEventListener('abort', onAbort); inFlight++; if (overlay) overlayInFlight++; resolve(); } };
    const onAbort = () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    queue.push(entry);
  });
}

function release(overlay: boolean) {
  inFlight--;
  if (overlay) overlayInFlight--;
  // Imagery first (FIFO within each kind); an overlay starts only while under its own cap.
  // (Aborted entries remove themselves from the queue — see acquire().)
  for (;;) {
    let i = canStart(false) ? queue.findIndex((e) => !e.overlay) : -1;
    if (i < 0 && canStart(true)) i = queue.findIndex((e) => e.overlay);
    if (i < 0) return;
    queue.splice(i, 1)[0].start();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { window.clearTimeout(t); reject(abortError()); };
    const t = window.setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** (Re)starts the quiet window; when it ends without a new 429, parked tiles are re-requested once. */
function scheduleRecovery() {
  window.clearTimeout(recoveryTimer);
  recoveryTimer = window.setTimeout(() => {
    const batch = parked.splice(0);
    devLog(`recovery pass: re-requesting ${batch.length} parked tile(s)`);
    for (const p of batch) if (!p.signal.aborted) p.resume();
  }, RECOVERY_QUIET_MS);
}

function park(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const entry = { signal, resume: () => { signal.removeEventListener('abort', onAbort); resolve(); } };
    const onAbort = () => { const i = parked.indexOf(entry); if (i >= 0) parked.splice(i, 1); reject(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    parked.push(entry);
    scheduleRecovery();
  });
}

function noteThrottle(final: boolean) {
  useEeTiles.setState((s) => ({ throttled: s.throttled + (final ? 0 : 1), failedThrottled: s.failedThrottled + (final ? 1 : 0), throttling: true }));
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => useEeTiles.setState({ throttling: false }), THROTTLE_NOTICE_MS);
  if (parked.length) scheduleRecovery();   // any new 429 extends the quiet window
}

const active = new Map<number, { url: string; t: number }>();
let activeId = 0;

async function fetchOnce(url: string, signal: AbortSignal): Promise<Response> {
  const overlay = !url.startsWith('/api/imagery/');
  await acquire(signal, overlay);
  const id = ++activeId;
  active.set(id, { url, t: performance.now() });
  try {
    return await fetch(apiUrl(url), { signal });
  } finally {
    active.delete(id);
    release(overlay);
  }
}

/** A throttled or transient failure: 429, a gateway/unavailable 5xx, or a network error (fetch rejected).
 *  All are retried the same bounded way; anything else (404 = no imagery, 4xx) fails immediately. */
const TRANSIENT = new Set([429, 502, 503, 504]);
async function fetchTransient(url: string, signal: AbortSignal): Promise<Response> {
  try {
    return await fetchOnce(url, signal);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    devLog('network error', (e as Error).message, url);
    return new Response(null, { status: 503, statusText: 'network error' });
  }
}

async function loadTile(params: { url: string }, ctrl: AbortController) {
  const url = params.url.slice(`${SCHEME}://`.length);
  const signal = ctrl.signal;
  let res = await fetchTransient(url, signal);
  if (TRANSIENT.has(res.status)) {
    noteThrottle(false);
    devLog('429 — retrying once', url);
    await sleep(RETRY_DELAY_MS + Math.random() * 1000, signal);
    res = await fetchTransient(url, signal);
    if (TRANSIENT.has(res.status)) {
      noteThrottle(false);
      devLog('429 again — tile parked for the recovery pass', url);
      await park(signal);
      res = await fetchTransient(url, signal);
      if (!TRANSIENT.has(res.status)) devLog('recovered in the recovery pass', url);
    }
    if (TRANSIENT.has(res.status)) {
      noteThrottle(true);
      devLog('429 in the recovery pass — tile skipped', url);
      const e = new Error('Earth Engine concurrency limit (429) — tile skipped');
      e.name = THROTTLED;
      throw e;
    }
  }
  if (!res.ok) throw new maplibregl.AJAXError(res.status, res.statusText, url, await res.blob());
  return { data: await res.arrayBuffer(), cacheControl: res.headers.get('cache-control'), expires: res.headers.get('expires') };
}

// Dev-only introspection for the e2e/debug scripts (never shipped in production builds).
if (import.meta.env.DEV) Object.assign(window as object, { __eeTiles: () => ({ inFlight, overlayInFlight, queued: queue.length, queuedOverlay: queue.filter((q) => q.overlay).length, queuedAborted: queue.filter((q) => q.signal.aborted).length, parked: parked.length, active: [...active.values()].map((a) => `${Math.round((performance.now() - a.t) / 1000)}s ${a.url.replace(/^.*\/tiles\//, '')}`) }) });

let registered = false;
/** Registers the loader once (idempotent). */
export function registerEeTiles() {
  if (registered) return;
  // MapLibre caps image requests GLOBALLY (all maps on the page, default 16). Our loader keeps its queued tiles
  // "in flight" from MapLibre's point of view, so 15 slow forest tiles could block every other map's imagery —
  // e.g. the Before/After 'before' map never requested a single tile. Let MapLibre hand every request to this
  // loader, which alone bounds Earth Engine concurrency (MAX_IN_FLIGHT, imagery first).
  maplibregl.setMaxParallelImageRequests(64);
  maplibregl.addProtocol(SCHEME, loadTile);
  registered = true;
}

/** Routes a backend Earth Engine tile template through the loader. Other templates are returned unchanged. */
export function eeTiles(template: string): string {
  return template.startsWith('/api/') ? `${SCHEME}://${template}` : template;
}
