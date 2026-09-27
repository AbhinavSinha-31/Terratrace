/**
 * Time-machine constants: composite years and sensor eras.
 * Landsat is the historical backbone; Sentinel-2 and Dynamic World define the modern era.
 */
// Mirrors backend/app/services/science.py (HIST_YEARS, MODERN_FIRST_YEAR) — see docs/METHOD.md.
/** Historical Landsat era composites (multi-year medians). No Dynamic World. */
export const HIST_YEARS = [1984, 1990, 1995, 2000, 2005, 2010, 2015];
/** First modern (Sentinel-2 + Dynamic World) annual composite; availability is decided per AOI by the backend. */
export const MODERN_FIRST_YEAR = 2016;
export const MODERN_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
/** Every composite year the Time Machine can select — the global minimum is 1984. */
export const DEFAULT_YEARS = [...HIST_YEARS, ...MODERN_YEARS];
export const TIMELINE_START = 1984;
/** Axis end: the 2026 composite is shown as "in progress". */
export const TIMELINE_END = 2026;
export const PENDING_YEAR = 2026;
/** Default REQUESTED analysis window (a default, not a minimum — any window from 1984 can be requested). */
export const DEFAULT_ANALYSIS_WINDOW = { start: 2018, end: 2025 };
/** EOX Sentinel-2 cloudless mosaics exist only for these years (real imagery, never metrics). */
export const EOX_FIRST_YEAR = 2016;
export const hasEoxImagery = (year: number) => year >= EOX_FIRST_YEAR && year <= 2025;
export const eraOf = (year: number): 'historical' | 'modern' => (year < MODERN_FIRST_YEAR ? 'historical' : 'modern');

export interface SensorEra {
  key: 'L' | 'S' | 'D';
  name: string;
  short: string;
  from: number;
  to: number;
  note: string;
}

/** Operational coverage of each data source on the timeline. */
export const ERAS: SensorEra[] = [
  { key: 'L', name: 'Landsat', short: 'L', from: 1984, to: TIMELINE_END, note: 'Landsat 5 TM · 7 ETM+ · 8 OLI · 9 OLI-2 — 30 m, historical backbone' },
  { key: 'S', name: 'Sentinel-2', short: 'S', from: 2015.5, to: TIMELINE_END, note: 'Sentinel-2 MSI — 10 m, modern high-resolution observation' },
  { key: 'D', name: 'Dynamic World', short: 'D', from: 2015.5, to: TIMELINE_END, note: 'Dynamic World V1 — near-real-time land cover & tree probability' },
];

export function erasAt(year: number): string {
  return ERAS.filter((e) => year >= e.from).map((e) => e.short).join('+');
}

export function sourceLabel(year: number): { title: string; subtitle: string } {
  if (eraOf(year) === 'historical') return { title: 'LANDSAT', subtitle: 'Historical observation · 30 m' };
  return { title: 'SENTINEL-2', subtitle: 'Modern high-resolution observation · 10 m' };
}

/**
 * Piecewise-linear time axis (0..1): the Landsat decades are compressed into the
 * first 42 %, the annual Sentinel-2 era gets the rest — so every modern year is
 * legible while 1984 stays on the same axis. The scale break sits at 2015.
 */
const BREAK = 2015;
const BREAK_POS = 0.42;
export function axisPos(y: number): number {
  if (y <= BREAK) return ((y - TIMELINE_START) / (BREAK - TIMELINE_START)) * BREAK_POS;
  return BREAK_POS + ((y - BREAK) / (TIMELINE_END - BREAK)) * (1 - BREAK_POS);
}
export function axisYear(p: number): number {
  if (p <= BREAK_POS) return TIMELINE_START + (p / BREAK_POS) * (BREAK - TIMELINE_START);
  return BREAK + ((p - BREAK_POS) / (1 - BREAK_POS)) * (TIMELINE_END - BREAK);
}
