import { describe, expect, it } from 'vitest';
import { devDetail, errorText } from './api';

// The Supabase / PostgREST error seen on 2026-11-18 when the Data API could not see the community tables.
const PGRST205 = { code: 'PGRST205', details: null, hint: null, message: "Could not find the table 'public.post_feed' in the schema cache" };

describe('community errors', () => {
  it('says the community is not set up when PostgREST cannot see a table', () => {
    expect(errorText(PGRST205)).toBe('The community is not set up on this server yet.');
    expect(errorText({ code: 'PGRST202', message: 'no function' })).toBe('The community is not set up on this server yet.');
  });
  it('shows the raw Supabase error in development builds', () => {
    expect(import.meta.env.DEV).toBe(true);
    expect(devDetail(PGRST205)).toBe("PGRST205 · Could not find the table 'public.post_feed' in the schema cache");
    expect(devDetail({ code: '42501', message: 'permission denied', details: 'x', hint: 'y' })).toBe('42501 · permission denied · x · y');
    expect(devDetail(null)).toBeNull();
  });
  it('keeps the other public sentences', () => {
    expect(errorText({ code: '23505' })).toBe('You have already done that.');
    expect(errorText({ status: 401 })).toMatch(/signed in/);
  });
});
