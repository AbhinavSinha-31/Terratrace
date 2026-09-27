import { create } from 'zustand';
import type { AoiGeometry } from '../../data/contracts';
import type { TerraMap } from './TerraMap';
import type { AoiDrawer } from './AoiDrawer';

/** Map instances + high-frequency telemetry (kept out of the main UI store). */
interface MapRegistry {
  primary: TerraMap | null;
  drawer: AoiDrawer | null;
  draft: AoiGeometry | null;
  pointer: { lng: number; lat: number } | null;
  view: { lng: number; lat: number; zoom: number; bearing: number };
  tileError: boolean;
  set(p: Partial<Omit<MapRegistry, 'set'>>): void;
}

export const useMapRegistry = create<MapRegistry>((set) => ({
  primary: null,
  drawer: null,
  draft: null,
  pointer: null,
  view: { lng: -30, lat: 4, zoom: 2.15, bearing: 0 },
  tileError: false,
  set: (p) => set(p),
}));
