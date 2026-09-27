/** Exploration regions shown on the globe (navigation only — not analysed until the user selects an area). */
export interface ExploreRegion {
  id: string;
  name: string;
  continent: string;
  center: [number, number];
  bbox: [number, number, number, number];
}

export const EXPLORE_REGIONS: ExploreRegion[] = [
  { id: 'amazon', name: 'Amazon Basin', continent: 'South America', center: [-62, -4], bbox: [-73.5, -15, -48, 2.5] },
  { id: 'congo', name: 'Congo Basin', continent: 'Africa', center: [22, 0], bbox: [12, -6, 30, 5] },
  { id: 'borneo', name: 'Borneo', continent: 'Southeast Asia', center: [114, 1], bbox: [108.5, -4.5, 119.5, 7.5] },
];
