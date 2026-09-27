/**
 * Earth Engine tile loading — graceful under Earth Engine's concurrency limit (HTTP 429 RESOURCE_EXHAUSTED,
 * which a project in Restricted Mode hits quickly). This never bypasses the quota; it only avoids
 * over-asking and fails individual tiles cleanly:
 *
 *   - at most MAX_IN_FLIGHT Earth Engine tile requests at once (the rest wait in a FIFO queue);
 *   - MapLibre's abort signal is honoured, so tiles the map no longer needs (pan / zoom / fly-to)
 *     leave the queue without ever being requested;
 *   - a 429 is retried ONCE after RETRY_DELAY_MS (+ jitter); a second 429 fails that tile only —
 *     the layer and every other tile stay on the map;
 *   - the browser HTTP cache and MapLibre's tile cache are used as normal (no cache-busting).
 *
 * Used only for backend Earth Engine templates (/api/imagery/tiles/…, /api/tiles/…). MapLibre itself
 * has no tile retry, so this is the single retry mechanism.
 */
import maplibregl from 'maplibre-gl';
import { create } from 'zustand';

const SCHEME = 'ttee';
const MAX_IN_FLIGHT = 4;
const RETRY_DELAY_MS = 1500;
const THROTTLE_NOTICE_MS = 6000;

/** Error name of a tile that was throttled twice (lets the map tell it apart from a connection failure). */
export const THROTTLED = 'EeTileThrottled';

interface EeTileState {
  /** Tiles that received a 429 at least once / were given up after the one retry (this session). */
  throttled: number;
  failedThrottled: number;
  /** True while a 429 happened within the last few seconds (drives the "throttled · retrying" notice). */
  throttling: boolean;
}
export const useEeTiles = create<EeTileState>(() => ({ throttled: 0, failedThrottled: 0, throttling: false }));

let inFlight = 0;
const queue: Array<{ start(): void; signal: AbortSignal }> = [];
let noticeTimer: number | undefined;

const abortError = () => new DOMException('Tile request aborted', 'AbortError');
const devLog = (...a: unknown[]) => { if (import.meta.env.DEV) console.debug('[ee-tiles]', ...a); };

function acquire(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (inFlight < MAX_IN_FLIGHT) { inFlight++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const entry = { signal, start: () => { signal.removeEventListener('abort', onAbort); inFlight++; resolve(); } };
    const onAbort = () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    queue.push(entry);
  });
}

function release() {
  inFlight--;
  while (queue.length && inFlight < MAX_IN_FLIGHT) {
    const next = queue.shift()!;
    if (!next.signal.aborted) next.start();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { window.clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

function noteThrottle(final: boolean) {
  useEeTiles.setState((s) => ({ throttled: s.throttled + (final ? 0 : 1), failedThrottled: s.failedThrottled + (final ? 1 : 0), throttling: true }));
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => useEeTiles.setState({ throttling: false }), THROTTLE_NOTICE_MS);
}

async function fetchOnce(url: string, signal: AbortSignal): Promise<Response> {
  await acquire(signal);
  try {
    return await fetch(url, { signal });
  } finally {
    release();
  }
}

async function loadTile(params: { url: string }, ctrl: AbortController) {
  const url = params.url.slice(`${SCHEME}://`.length);
  const signal = ctrl.signal;
  let res = await fetchOnce(url, signal);
  if (res.status === 429) {
    noteThrottle(false);
    devLog('429 — retrying once', url);
    await sleep(RETRY_DELAY_MS + Math.random() * 1000, signal);
    res = await fetchOnce(url, signal);
    if (res.status === 429) {
      noteThrottle(true);
      devLog('429 again — tile skipped', url);
      const e = new Error('Earth Engine concurrency limit (429) — tile skipped');
      e.name = THROTTLED;
      throw e;
    }
  }
  if (!res.ok) throw new maplibregl.AJAXError(res.status, res.statusText, url, await res.blob());
  return { data: await res.arrayBuffer(), cacheControl: res.headers.get('cache-control'), expires: res.headers.get('expires') };
}

let registered = false;
/** Registers the loader once (idempotent). */
export function registerEeTiles() {
  if (registered) return;
  maplibregl.addProtocol(SCHEME, loadTile);
  registered = true;
}

/** Routes a backend Earth Engine tile template through the loader. Other templates are returned unchanged. */
export function eeTiles(template: string): string {
  return template.startsWith('/api/') ? `${SCHEME}://${template}` : template;
}
