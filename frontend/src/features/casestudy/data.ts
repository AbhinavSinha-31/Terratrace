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
}

export const CASE_STUDIES: CaseStudyMeta[] = [
  { id: 'noida-ghaziabad', name: 'Noida–Ghaziabad (Delhi NCR)', country: 'India', region: 'Uttar Pradesh', subtitle: 'Urban growth & land-cover change' },
];

export const caseStudyMeta = (id: string) => CASE_STUDIES.find((c) => c.id === id) ?? null;
export const caseStudyAsset = (id: string, file: string) => `${import.meta.env.BASE_URL}case-studies/${id}/${file}`;

export interface ImageRef { file: string; width: number; height: number; bytes: number }
type Season = 'summer' | 'winter';

/** Mirrors analysis/export_case_study.py. Every number in it comes from the analysis tables.
 *  Land surface temperature / UHI was withdrawn in pipeline 1.0.2 (config.toml [lst] enabled = false), so the file carries no
 *  temperature field and the page shows none. */
export interface CaseStudyDoc {
  id: string;
  generated_utc: string;
  pipeline_version: string;
  /** Card image URL, from the case study's data (config.toml [website]), like the live cards' backend metadata —
   *  imagery URLs are never built in frontend source. */
  thumbnail_url: string;
  earth_engine_downloaded_utc: string;
  /** false since 1.0.2: no land surface temperature / UHI content in this file. */
  lst_enabled: boolean;
  study: {
    name: string; short_name: string; districts: string[]; boundary_source: string;
    /** The sum of the classified 30 m pixels (class_areas.csv) — the study area as reported everywhere. */
    area_km2: number; area_km2_definition: string; area_km2_boundary_polygon: number;
    years: number[]; sensors: Record<string, string>;
    scenes: { year: number; season: Season | 'annual'; scenes: number; composite: string; median_date: string }[];
    /** Composite names from the pipeline config: 'April–June 2015' / 'Apr–Jun 2015' (and 'winter 2014–15' while LST is on). */
    composites: Partial<Record<Season, Record<string, { label: string; short: string }>>>;
    /** Scenes per calendar month and median acquisition date of each seasonal composite. */
    scene_timing: { composite: string; year: number; season: Season; months: string; per_month: { month: string; label: string; scenes: number }[]; total: number; median: string }[];
    /** Exactly which reference products and years made each map's training and test labels. */
    reference_labels: { year: number; text: string }[];
    reference_label_mismatches: string[];
    classes: { code: number; name: string; color: string }[]; method_summary: string;
  };
  changelog: { version: string; text: string }[];
  /** Plain-language headline cards (one number, one sentence), generated from the tables by export_case_study.py. */
  headlines: { id: string; value: string; period: string; title: string; text: string }[];
  /** How to read the results: the technical caveats, stated plainly. */
  caveats: { title: string; text: string }[];
  /** The full technical findings, verbatim from results_summary.md. */
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
  accuracy: { year: number; overall_agreement: number; kappa: number; n_test: number; label: string; most_confused: { a: string; b: string; n: number }[] }[];
  images: { lulc: Record<string, ImageRef>; change: Record<string, ImageRef>; charts: Record<string, ImageRef> };
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
  ))[];
  legends: {
    lulc: { code: number; name: string; color: string }[];
    change: { code: number; name: string; color: string }[];
    change_km2: Record<string, number[]>;
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

/** Mirrors analysis/export_report.py: the shareable files (PDF report, data ZIP) and their real sizes. */
export interface CaseStudyDownloads {
  generated_utc: string;
  pdf: { file: string; bytes: number; pages: number; title: string };
  data: { file: string; bytes: number; files: number };
}

export function useCaseStudyDownloads(id: string | null) {
  return useQuery({
    queryKey: ['case-study-downloads', id],
    enabled: !!id,
    staleTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<CaseStudyDownloads> => {
      const res = await fetch(caseStudyAsset(id as string, 'downloads.json'));
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error('The downloads could not be loaded.');
      return (await res.json()) as CaseStudyDownloads;
    },
  });
}

/** A composite's name, sentence-initial capital: 'April–June 2015', 'Winter 2014–15' (short: 'Apr–Jun 2015'). */
export const compositeLabel = (d: CaseStudyDoc, season: Season, year: number, short = false) => {
  const c = d.study.composites[season]?.[String(year)];
  const t = c ? (short ? c.short : c.label) : `${year}`;
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export const yearSpan =(years: number[]) => (years.length ? `${Math.min(...years)}–${Math.max(...years)}` : '');
