import { describe, expect, it } from 'vitest';
import type { InvestigationState } from '../state/store';
import { parseHash, toHash } from './urlState';

const inv = (id: string | null) => ({
  study: id ? { id } : null, baselineYear: 2018, comparisonYear: 2025, imageryYear: 2024,
}) as unknown as InvestigationState;

describe('parseHash', () => {
  it('reads an analysis link with its window and year', () => {
    expect(parseHash('#/analysis/hasdeo-arand?from=2019&to=2025&year=2024'))
      .toEqual({ view: 'analysis', phase: 'explore', aoiId: 'hasdeo-arand', from: 2019, to: 2025, year: 2024 });
  });

  it('reads a case study link', () => {
    expect(parseHash('#/case-study/noida-ghaziabad')).toMatchObject({ view: 'explore', caseStudy: 'noida-ghaziabad', aoiId: null });
  });

  it('ignores years that are not four digits', () => {
    const u = parseHash('#/timemachine/x?from=19&to=abcd&year=20255');
    expect(u).toMatchObject({ view: 'timemachine', aoiId: 'x', from: undefined, to: undefined, year: undefined });
  });

  it('never throws on malformed input and falls back to Explore', () => {
    expect(() => parseHash('#/%%%/??')).not.toThrow();
    expect(parseHash('#/nonsense')).toEqual({ view: 'explore', phase: 'intro', aoiId: null });
    expect(parseHash('')).toEqual({ view: 'explore', phase: 'intro', aoiId: null });
    expect(parseHash('#/explore')).toEqual({ view: 'explore', phase: 'explore', aoiId: null });
  });
});

describe('toHash', () => {
  it('round-trips an open analysis', () => {
    const h = toHash({ view: 'analysis', phase: 'explore', investigation: inv('aoi-3f2a') });
    expect(h).toBe('#/analysis/aoi-3f2a?from=2018&to=2025&year=2024');
    expect(parseHash(h)).toMatchObject({ view: 'analysis', aoiId: 'aoi-3f2a', from: 2018, to: 2025, year: 2024 });
  });

  it('encodes ids so a hash cannot be broken by them', () => {
    expect(toHash({ view: 'analysis', phase: 'explore', investigation: inv('a/b?c') })).toContain('a%2Fb%3Fc');
  });

  it('a case study wins over everything else', () => {
    expect(toHash({ view: 'analysis', phase: 'explore', investigation: inv('x'), caseStudy: 'noida-ghaziabad' })).toBe('#/case-study/noida-ghaziabad');
  });
});
