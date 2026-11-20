import { describe, expect, it } from 'vitest';
import type { SystemHealth } from '../../data/contracts';
import { ago, badgeState, serviceRows, type CommunityCheck } from './serviceStatus';

const health = (over: Partial<SystemHealth> = {}): SystemHealth => ({
  backend: true, status: 'operational', version: '1', engine: 'x', dataMode: 'LIVE',
  analysis: { status: 'ready' }, explainer: { status: 'unconfigured' }, geocoder: { status: 'ready' },
  limits: { max_aoi_km2: 1, min_aoi_km2: 0 }, chat: { status: 'ready' }, ...over,
});
const offline = health({ backend: false, analysis: { status: 'offline' }, chat: undefined });
const community: CommunityCheck = { state: 'Online', tone: 'ok', checkedAt: 1 };

describe('badgeState', () => {
  it('is "waking" while the first check is pending, even before 3 s', () => {
    expect(badgeState(undefined, true, false)).toBe('waking');
    expect(badgeState(undefined, true, true)).toBe('waking');
  });
  it('is "online" only when the API answered and Earth Engine is ready', () => {
    expect(badgeState(health(), false, false)).toBe('online');
    expect(badgeState(health({ analysis: { status: 'error' } }), false, false)).toBe('offline');
    expect(badgeState(health({ analysis: { status: 'unconfigured' } }), false, false)).toBe('offline');
    expect(badgeState(offline, false, false)).toBe('offline');
  });
  it('turns "waking" when a later check runs longer than 3 s, and not before', () => {
    expect(badgeState(offline, true, false)).toBe('offline');
    expect(badgeState(offline, true, true)).toBe('waking');
    expect(badgeState(health(), true, false)).toBe('online');
    expect(badgeState(health(), true, true)).toBe('waking');
  });
});

describe('serviceRows', () => {
  it('lists the four services in order', () => {
    expect(serviceRows(health(), 5, community).map((r) => r.name)).toEqual(['Analysis API', 'Earth Engine', 'Ask TerraTrace chat', 'Community database']);
  });
  it('never reports a service behind an unreachable API as ready', () => {
    const rows = serviceRows(offline, 5, community);
    expect(rows[0]).toMatchObject({ state: 'Unreachable', tone: 'down' });
    expect(rows[1].tone).toBe('down');
    expect(rows[2].tone).toBe('down');
    expect(rows[3]).toMatchObject({ state: 'Online', tone: 'ok' });   // Supabase is checked on its own
  });
  it('shows "Checking…" before the first answer, with no timestamp', () => {
    const rows = serviceRows(undefined, null, { state: 'Checking…', tone: 'pending', checkedAt: null });
    expect(rows.every((r) => r.tone === 'pending' && r.checkedAt === null)).toBe(true);
  });
  it('maps chat states', () => {
    expect(serviceRows(health({ chat: { status: 'offline' } }), 5, community)[2].state).toBe('Switched off');
    expect(serviceRows(health({ chat: { status: 'error' } }), 5, community)[2].state).toBe('Unavailable');
    expect(serviceRows(health({ chat: null }), 5, community)[2].state).toBe('Unavailable');
  });
});

describe('ago', () => {
  it('formats the last check', () => {
    expect(ago(null, 0)).toBe('not checked yet');
    expect(ago(1000, 3000)).toBe('checked just now');
    expect(ago(0, 42000)).toBe('checked 42 s ago');
    expect(ago(0, 150000)).toBe('checked 2 min ago');
  });
});
