import { describe, expect, it, vi } from 'vitest';
import type { AnalysisEnvelope } from './contracts';
import { ApiError, PUBLIC, apiUrl, client, fromEnvelope } from './client';

// Synthetic envelopes: shapes only, never shown in the app.
const base = {
  analysis_id: 'a1', dataMode: 'LIVE', reason: null, reasonCode: null,
  aoi: { id: 'aoi-1' }, window: { baseline_year: 2018, comparison_year: 2025 }, source: {},
} as unknown as AnalysisEnvelope;
const readyParts = {
  summary: { forest_loss_ha: 1 }, events: { type: 'FeatureCollection', features: [] },
  layers: { overlays: [{ id: 'forest', by_year: { 2020: 'tiles/forest-2020.png' } }] },
} as unknown as Pick<AnalysisEnvelope, 'summary' | 'events' | 'layers'>;

describe('fromEnvelope: measurements only from a READY envelope', () => {
  it('keeps the bundle of a complete READY envelope', () => {
    const r = fromEnvelope({ ...base, analysisStatus: 'READY', ...readyParts, cautions: [] });
    expect(r.status).toBe('READY');
    expect(r.bundle?.summary).toEqual(readyParts.summary);
    expect(r.error).toBeNull();
  });

  it('drops measurements from a non-READY envelope even if the server sent some', () => {
    const r = fromEnvelope({ ...base, analysisStatus: 'INVALID_ANALYSIS', ...readyParts, error: { code: 'invalid_analysis', user_message: 'Failed a physical check.', retryable: false } } as AnalysisEnvelope);
    expect(r.status).toBe('INVALID_ANALYSIS');
    expect(r.bundle).toBeNull();
    expect(r.cautions).toEqual([]);
    expect(r.reason).toBe('Failed a physical check.');
  });

  it('treats a READY envelope without its summary as an error, not as a result', () => {
    const r = fromEnvelope({ ...base, analysisStatus: 'READY', events: readyParts.events, layers: readyParts.layers });
    expect(r.status).toBe('ERROR');
    expect(r.bundle).toBeNull();
    expect(r.reason).toBe(PUBLIC.failed);
  });

  it('resolves relative layer paths against the app base', () => {
    const r = fromEnvelope({ ...base, analysisStatus: 'READY', ...readyParts });
    expect(r.bundle?.layers.overlays[0].by_year['2020']).toBe('/tiles/forest-2020.png');
  });
});

describe('apiUrl', () => {
  it('maps backend paths onto the API base and leaves others alone', () => {
    expect(apiUrl('/api/tiles/x/forest/2020/{z}/{x}/{y}')).toBe('/api/tiles/x/forest/2020/{z}/{x}/{y}');
    expect(apiUrl('https://tiles.example/a.png')).toBe('https://tiles.example/a.png');
  });

  it('uses VITE_API_BASE when the frontend is hosted apart from the backend', async () => {
    vi.stubEnv('VITE_API_BASE', 'https://api.example.org/api/');
    vi.resetModules();
    const m = await import('./client');
    expect(m.apiUrl('/api/health')).toBe('https://api.example.org/api/health');
  });
});

describe('request errors: only the backend public message is ever shown', () => {
  const respond = (body: BodyInit | null, init: ResponseInit) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, init)));

  it('surfaces the public user_message, code and retryable flag', async () => {
    respond(JSON.stringify({ detail: { code: 'rate_limited', user_message: 'Too many requests in a short time.', retryable: true } }),
      { status: 429, headers: { 'content-type': 'application/json' } });
    const e = await client.chat({ messages: [{ role: 'user', text: 'hi' }] }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 429, code: 'rate_limited', retryable: true, message: 'Too many requests in a short time.' });
  });

  it('never shows raw server text', async () => {
    respond('Traceback (most recent call last): KeyError secret_path', { status: 500, headers: { 'content-type': 'text/plain' } });
    const e = await client.chat({ messages: [{ role: 'user', text: 'hi' }] }).catch((x) => x);
    expect(e.message).toBe(PUBLIC.failed);
    expect(e.message).not.toMatch(/Traceback|secret/);
  });

  it('reports an HTML answer (no backend behind the dev server) as unavailable', async () => {
    respond('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const e = await client.chat({ messages: [{ role: 'user', text: 'hi' }] }).catch((x) => x);
    expect(e).toMatchObject({ code: 'service_unavailable', message: PUBLIC.unavailable });
    expect(e.offline).toBe(true);
  });

  it('reports a network failure as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const e = await client.chat({ messages: [{ role: 'user', text: 'hi' }] }).catch((x) => x);
    expect(e).toMatchObject({ code: 'service_unavailable', status: undefined });
  });
});
