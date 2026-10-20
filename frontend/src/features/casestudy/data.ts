import { useQuery } from '@tanstack/react-query';

/**
 * Static case studies: precomputed results shipped as files in /public (written by analysis/export_case_study.py).
 * They never call the backend, so they work offline and never count towards the live "Detected change" totals.
 */
export interface CaseStudyMeta {
  id: string;
  /** Card title and the two image badges. */
  name: string;
  country: string;
  region: string;
  subtitle: string;
  /** Card image: the same true-colour source and zoom as the live featured cards (Sentinel-2 cloudless 2025 by EOX,
   *  one z10 tile over the urban core; credited in About). Not derived from the case study's own rasters. */
  thumbnail_url: string;
}

export const CASE_STUDIES: CaseStudyMeta[] = [
  { id: 'noida-ghaziabad', name: 'Noida–Ghaziabad (Delhi NCR)', country: 'India', region: 'Uttar Pradesh', subtitle: 'Urban growth & surface heat',
    thumbnail_url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/10/427/732.jpg' },
];

export const caseStudyMeta = (id: string) => CASE_STUDIES.find((c) => c.id === id) ?? null;
export const caseStudyAsset = (id: string, file: string) => `${import.meta.env.BASE_URL}case-studies/${id}/${file}`;

export interface ImageRef { file: string; width: number; height: number; bytes: number }
type Season = 'summer' | 'winter';

/** Mirrors analysis/export_case_study.py. Every number in it comes from the analysis tables. */
export interface CaseStudyDoc {
  id: string;
  generated_utc: string;
  pipeline_version: string;
  study: {
    name: string; short_name: string; districts: string[]; boundary_source: string; area_km2: number; area_km2_grid: number;
    years: number[]; sensors: Record<string, string>; scenes: { year: number; season: Season | 'annual'; scenes: number }[];
    classes: { code: number; name: string; color: string }[]; method_summary: string;
  };
  findings: string[];
  limitations: { title: string; text: string }[];
  flags: { level: 'WARNING' | 'CAUTION' | 'INFO'; topic: string; message: string }[];
  areas: { year: number; class_code: number; class: string; area_km2: number; percent: number }[];
  net_change: { from_year: number; to_year: number; class: string; class_code: number; from_km2: number; to_km2: number; delta_km2: number; delta_pp: number; delta_rel_pct: number | null }[];
  transitions: {
    from_year: number; to_year: number; total_changed_km2: number;
    top: { from: string; to: string; km2: number; share: number }[];
    into_built: { from: string; km2: number }[];
    cropland_to_built: { gross_km2: number; reverse_km2: number; net_km2: number };
  }[];
  population: { epoch: number; population: number; ghsl_built_km2: number; projection: boolean; builtup_km2_this_study: number | null }[];
  lst_summary: { year: number; season: Season; mean_land_c: number }[];
  lst_per_class: { year: number; season: Season; class: string; class_code: number; mean_c: number }[];
  uhi: { year: number; season: Season; method: string; primary: boolean; uhi_c: number; urban_mean_c: number; rural_mean_c: number; ring_outer_km: number | null; result: 'heat island' | 'cool island' | 'near zero' }[];
  conversion: { period: string; season: Season; group: string; area_km2: number; delta_lst_c: number; delta_z: number }[];
  correlations: { year: number; season: Season; index: 'NDVI' | 'NDBI'; r: number; p_thinned: number; n_pixels: number; n_thinned: number; thin_spacing_m: number }[];
  accuracy: { year: number; overall_agreement: number; kappa: number; n_test: number; label: string; most_confused: { a: string; b: string; n: number }[] }[];
  masking: { rule: string; impact: Record<string, number | string | boolean>[] };
  images: {
    lulc: Record<string, ImageRef>; lst_summer: Record<string, ImageRef>; lst_winter: Record<string, ImageRef>;
    change: Record<string, ImageRef>; uhi_zones: Record<string, ImageRef>; charts: Record<string, ImageRef>;
  };
  cross_checks: string[];
}

/** The case study's JSON — a static file, cached for the session; no backend involved. */
export function useCaseStudy(id: string | null) {
  return useQuery({
    queryKey: ['case-study', id],
    enabled: !!id,
    staleTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<CaseStudyDoc> => {
      const res = await fetch(caseStudyAsset(id as string, 'case-study.json'));
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error('The case study could not be loaded.');
      return (await res.json()) as CaseStudyDoc;
    },
  });
}

/** Mirrors analysis/render_tiles.py: static XYZ tiles rendered from the pipeline's 30 m rasters (no backend, no EE). */
export interface TilesManifest {
  id: string;
  generated_utc: string;
  tile_size: number;
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number];
  /** Relative to the case study folder, with a {layer} placeholder. */
  tiles: string;
  layers: ({ id: string; bytes: number } & (
    | { kind: 'lulc'; year: number }
    | { kind: 'change'; from_year: number; to_year: number }
    | { kind: 'lst'; season: Season; year: number }
  ))[];
  legends: {
    lulc: { code: number; name: string; color: string }[];
    change: { code: number; name: string; color: string }[];
    change_km2: Record<string, number[]>;
    lst: Record<Season, { vmin: number; vmax: number; stops: string[] }>;
  };
  files: number;
  bytes: number;
}

export function useCaseStudyTiles(id: string | null) {
  return useQuery({
    queryKey: ['case-study-tiles', id],
    enabled: !!id,
    staleTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<TilesManifest> => {
      const res = await fetch(caseStudyAsset(id as string, 'tiles.json'));
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error('The case study map could not be loaded.');
      return (await res.json()) as TilesManifest;
    },
  });
}

export const yearSpan =(years: number[]) => (years.length ? `${Math.min(...years)}–${Math.max(...years)}` : '');
