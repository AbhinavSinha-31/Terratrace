import { useEffect, useMemo, useRef } from 'react';
import type { ChangeEvent, ChangeType, Severity, StudyArea } from '../../data/contracts';
import { useBasemaps, useCandidateAoi, useCurrentBundle, useImageryDecision, useReadyResults, useSelectedAoi, useStudyAreas } from '../../data/queries';
import { selectCandidate, useUi } from '../../state/store';
import { EXPLORE_REGIONS } from '../../lib/regions';
import { squareAround } from '../../lib/geo';
import { TerraMap, type GlobalHotspot } from './TerraMap';
import { AoiDrawer } from './AoiDrawer';
import { useMapRegistry } from './registry';

const NO_AREAS: StudyArea[] = [];
const NO_EVENTS: ChangeEvent[] = [];

interface Props {
  role: 'primary' | 'before';
  year: number;
  onReady(role: 'primary' | 'before', map: TerraMap | null): void;
  style?: React.CSSProperties;
}

/** One MapLibre instance bound to the UI store. Compare mode renders two. */
export function MapCanvas({ role, year, onReady, style }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const tm = useRef<TerraMap | null>(null);

  const areas = useStudyAreas().data?.items ?? NO_AREAS;
  const aoi = useSelectedAoi();
  const aoiId = useUi((s) => s.investigation.study?.id ?? null);
  const bundle = useCurrentBundle();
  const basemaps = useBasemaps().data ?? null;
  // A search/drawn selection is registered so its live imagery loads before any analysis (never analyses).
  const drawToolActive = useUi((s) => !!s.drawTool);
  const candidateAoi = useCandidateAoi();
  const imageryAoi = aoiId ? aoi : drawToolActive ? null : candidateAoi;
  // Real imagery for THIS map's year (compare mode's 'before' map asks for its own year).
  const yearImagery = useImageryDecision(imageryAoi?.id ?? null, year).data ?? null;
  const readyResults = useReadyResults();
  const imagery = useUi((s) => s.imagery);
  const layers = useUi((s) => s.layers);
  const sevFilter = useUi((s) => s.severityFilter);
  const typeFilter = useUi((s) => s.typeFilter);
  const selectedId = useUi((s) => s.selectedEventId);
  const hoveredId = useUi((s) => s.hoveredEventId);
  const hoveredAoiId = useUi((s) => s.hoveredAoiId);
  const selection = useUi(selectCandidate);
  const drawTool = useUi((s) => s.drawTool);
  const reducedMotion = useUi((s) => s.reducedMotion);
  const draft = useMapRegistry((s) => s.draft);

  // Analysis layers and events exist only for a READY live analysis.
  const catalog = bundle && bundle.id === aoiId ? bundle.layers : null;
  const events = bundle && bundle.id === aoiId ? bundle.events.features : NO_EVENTS;
  const severities = useMemo(() => (Object.keys(sevFilter) as Severity[]).filter((k) => sevFilter[k]), [sevFilter]);
  const types = useMemo(() => (Object.keys(typeFilter) as ChangeType[]).filter((k) => typeFilter[k]), [typeFilter]);
  // Detected change on the globe comes only from completed (READY) live analyses.
  const hotspots = useMemo<GlobalHotspot[]>(
    () => readyResults.flatMap((r) => (r.bundle?.events.features ?? []).map((f) => ({ lon: f.properties.centroid[0], lat: f.properties.centroid[1], area_ha: f.properties.area_ha, severity: f.properties.severity.class }))),
    [readyResults],
  );

  const state = {
    areas, regions: EXPLORE_REGIONS, aoi, catalog, basemaps, yearImagery, imageryAoi, events, hotspots, year, imagery, layers, severities, types,
    selectedId, hoveredId, hoveredAoiId,
    draft: drawTool ? draft : aoiId ? null : selection?.geometry ?? null,
    pin: drawTool || aoiId ? null : selection?.point ?? null,
    drawing: !!drawTool, spin: role === 'primary', reducedMotion,
  };
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const ui = useUi.getState;
    const reg = useMapRegistry.getState;
    const map = new TerraMap(el.current!, stateRef.current, {
      onEventClick: (id) => ui().selectEvent(id),
      onEventHover: (id) => ui().hoverEvent(id),
      onAoiClick: (id) => ui().openAnalysis(id),
      onAoiHover: (id) => ui().hoverAoi(id),
      onRegionClick: (r) => {
        ui().setPhase('explore');
        ui().requestCamera({ kind: 'bbox', bbox: r.bbox });
      },
      onMapClick: (p) => {
        const zoom = reg().view.zoom;
        if (zoom < 4) {
          ui().setPhase('explore');
          ui().requestCamera({ kind: 'point', point: p });
          return;
        }
        // Regional view: place an editable 10 km × 10 km selection at the clicked point.
        ui().setSelection({ geometry: squareAround(p, 10), source: 'click' });
      },
      onTileError: () => reg().set({ tileError: true }),
      onView: role === 'primary' ? (v) => reg().set({ view: v }) : undefined,
      onPointer: (p) => reg().set({ pointer: p }),
    });
    tm.current = map;
    onReady(role, map);
    if (role === 'primary') {
      const drawer = new AoiDrawer(
        map,
        (g) => reg().set({ draft: g }),
        (g) => {
          reg().set({ draft: null });
          ui().setDrawTool(null);
          if (g) ui().setSelection({ geometry: g, source: 'draw' });
        },
      );
      reg().set({ primary: map, drawer });
      // Dev-only hooks for the regression/e2e scripts (never shipped in production builds).
      if (import.meta.env.DEV) Object.assign(window as object, { __tt: map, __ttUi: useUi });
    } else if (import.meta.env.DEV) Object.assign(window as object, { __ttBefore: map });
    return () => {
      onReady(role, null);
      if (role === 'primary') reg().set({ primary: null, drawer: null });
      map.destroy();
      tm.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    tm.current?.update(stateRef.current);
  });

  // Start/stop the drawing interaction when the tool changes.
  useEffect(() => {
    if (role !== 'primary') return;
    const drawer = useMapRegistry.getState().drawer;
    if (!drawer) return;
    if (drawTool) {
      useUi.getState().setSelection(null);
      drawer.begin(drawTool);
    } else if (drawer.active) drawer.cancel(false);
  }, [drawTool, role]);

  useEffect(() => {
    if (!aoiId) tm.current?.resumeSpin();
  }, [aoiId]);

  // Inline positioning: MapLibre's own (unlayered) CSS sets position:relative on the container.
  return <div ref={el} style={{ position: 'absolute', inset: 0, ...style }} />;
}
