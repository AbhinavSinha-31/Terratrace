import type { Severity } from '../data/contracts';

/**
 * Chart & map colors. Validated with the dataviz palette checker against the
 * dark chart surface (#0b1117):
 *  - signals: categorical, all-pairs CVD ΔE ≥ 9.4, normal-vision ΔE ≥ 20.9
 *  - severity: ordinal single-hue ramp, monotone lightness, ΔL ≥ 0.06
 * Severity is always shown with a text label, never color alone.
 */
export const SURFACE = '#0b1117';

export const SIGNAL = {
  ndvi: '#199e70',
  nbr: '#d95926',
  tree_prob: '#3987e5',
} as const;

export const SEVERITY_COLOR: Record<Severity, string> = {
  low: '#f5a25a',
  moderate: '#ec7a3c',
  high: '#d4452f',
  critical: '#a3281f',
};

/** Brighter outlines so dark severity fills stay visible over imagery. */
export const SEVERITY_LINE: Record<Severity, string> = {
  low: '#ffc98f',
  moderate: '#ffa26b',
  high: '#ff6b52',
  critical: '#ff4d6d',
};

export const FOREST = '#199e70';

export const INK = {
  primary: '#e8eef2',
  secondary: '#9fb0bc',
  muted: '#6b7c88',
  grid: 'rgba(255,255,255,0.06)',
  axis: 'rgba(255,255,255,0.14)',
};
