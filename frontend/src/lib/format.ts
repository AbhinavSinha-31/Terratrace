import type { ChangeEvent, ChangeType, ConfidenceClass, LandCover, Severity } from '../data/contracts';

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export const fmtHa = (v: number) => (Math.abs(v) >= 100 ? nf0.format(v) : nf1.format(v));
export const fmtKm2 = (v: number) => (Math.abs(v) >= 100 ? nf0.format(v) : v.toFixed(2));
export const haToKm2 = (ha: number) => ha / 100;
export const fmtPct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;
export const fmtSignedPct = (pctValue: number, digits = 2) => `${pctValue > 0 ? '+' : ''}${pctValue.toFixed(digits)}%`;
export const fmtDelta = (v: number, digits = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
export const fmtIndex = (v: number) => (v < 0 ? `−${Math.abs(v).toFixed(2)}` : v.toFixed(2));
export const fmtCoord = (lon: number, lat: number) =>
  `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;

const LC: Record<LandCover, string> = {
  water: 'Water', trees: 'Trees', grass: 'Grass / pasture', flooded_vegetation: 'Flooded vegetation',
  crops: 'Cropland', shrub_and_scrub: 'Shrub & scrub', built: 'Built-up', bare: 'Bare ground', snow_and_ice: 'Snow & ice',
};
export const landCoverLabel = (lc: LandCover) => LC[lc] ?? lc;

// Short card labels for full biome names; the full name stays available as a tooltip.
const BIOME_SHORT: Record<string, string> = {
  'tropical moist broadleaf forest': 'Moist broadleaf',
  'tropical dry deciduous (sal) forest': 'Dry deciduous',
  'tropical moist deciduous forest': 'Moist deciduous',
  'tropical wet evergreen forest': 'Wet evergreen',
};
/** Unmapped biomes fall back to the text before any qualifier, without a leading "Tropical". */
export const shortBiome = (biome: string | null | undefined): string => {
  if (!biome) return '—';
  const known = BIOME_SHORT[biome.trim().toLowerCase()];
  if (known) return known;
  const base = biome.split(/[—–(]/)[0].replace(/\bforests?\b/i, '').replace(/^tropical\s+/i, '').trim();
  return base ? base[0].toUpperCase() + base.slice(1) : biome;
};

export const severityLabel: Record<Severity, string> = { low: 'Low', moderate: 'Moderate', high: 'High', critical: 'Critical' };
export const changeTypeLabel: Record<ChangeType, string> = {
  clearing: 'Forest clearing', fire: 'Burn scar', degradation: 'Degradation', unknown: 'Unclassified',
};

/** Display helper: count backend-classified events by evidence class (no scientific computation). */
export function evidenceDistribution(events: ChangeEvent[]): Record<ConfidenceClass, number> {
  const d = { high: 0, medium: 0, low: 0 };
  for (const e of events) d[e.properties.confidence.class]++;
  return d;
}
