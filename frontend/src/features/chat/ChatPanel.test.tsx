import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { SystemHealth } from '../../data/contracts';

const health = vi.hoisted(() => ({ data: undefined as Partial<SystemHealth> | undefined }));
vi.mock('../../data/queries', () => ({ useHealth: () => ({ data: health.data }) }));

const { useChatAvailability } = await import('./ChatPanel');
const { ASK_PLACEHOLDER, GENERAL_STARTERS, GREETING } = await import('./starters');

afterEach(() => { cleanup(); health.data = undefined; });

describe('Ask TerraTrace texts', () => {
  it('starter chips cover forests and cities, and never claim "only imagery before 2016"', () => {
    expect(GENERAL_STARTERS).toEqual(expect.arrayContaining([
      'How do satellites see forests?', 'What is NDVI?', 'How does TerraTrace detect urban expansion?', 'What is an urban heat island?',
    ]));
    expect(GENERAL_STARTERS.join(' ')).not.toMatch(/only imagery before 2016/i);
    expect(GREETING).toMatch(/forests/);
    expect(GREETING).toMatch(/cities/);
    expect(ASK_PLACEHOLDER).toBe('Ask about forests, cities, satellites or TerraTrace…');
  });
});

describe('useChatAvailability', () => {
  const state = (h: Partial<SystemHealth> | undefined) => {
    health.data = h;
    return renderHook(() => useChatAvailability()).result.current;
  };

  it('is unknown while health is loading', () => expect(state(undefined)).toEqual({ ready: null, message: null }));
  it('is ready only when the server says so', () => expect(state({ backend: true, chat: { status: 'ready' } }).ready).toBe(true));
  it('explains a switched-off chat', () => expect(state({ backend: true, chat: { status: 'offline' } }).message).toMatch(/switched off/));
  it('explains an unreachable server', () => expect(state({ backend: false }).message).toMatch(/not reachable/));
  it('never claims readiness for an unconfigured chat', () => expect(state({ backend: true, chat: { status: 'unconfigured' } }).ready).toBe(false));
});
