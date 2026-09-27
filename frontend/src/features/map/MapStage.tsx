import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Compass, Minus, Plus, RotateCcw, WifiOff, X } from 'lucide-react';
import { selectCandidate, useAnalysisWindow, useUi } from '../../state/store';
import { imageryErrorMessage } from '../../data/imagerySync';
import { useEeTiles } from './eeTiles';
import { useBasemaps, useCurrentAnalysis, useCurrentBundle, useImageryDecision, useSelectedAoi } from '../../data/queries';
import { CHROME, analysisPadding, landingInset, landingZoom, useBreakpoint } from '../../lib/useLayout';
import { fmtCoord } from '../../lib/format';
import { IconButton, Tooltip } from '../../design';
import { MapCanvas } from './MapCanvas';
import type { TerraMap } from './TerraMap';
import { useMapRegistry } from './registry';

/**
 * The map viewport. In compare mode a second map ("before") is stacked on top
 * and clipped to the left of a draggable divider; both cameras stay in sync.
 */
export function MapStage() {
  const [primary, setPrimary] = useState<TerraMap | null>(null);
  const [before, setBefore] = useState<TerraMap | null>(null);
  const [split, setSplit] = useState(50);
  const [dragging, setDragging] = useState(false);
  const stage = useRef<HTMLDivElement>(null);

  const year = useUi((s) => s.investigation.imageryYear);
  const win = useAnalysisWindow();
  const compare = useUi((s) => s.compare);
  const camera = useUi((s) => s.camera);
  const view = useUi((s) => s.view);
  const phase = useUi((s) => s.phase);
  const drawerOpen = useUi((s) => s.drawerOpen);
  const layersOpen = useUi((s) => s.layersOpen);
  const presentation = useUi((s) => s.presentation.active);
  const aoi = useSelectedAoi();
  const analysis = useCurrentBundle();
  const bp = useBreakpoint();

  const onReady = useCallback((role: 'primary' | 'before', m: TerraMap | null) => {
    (role === 'primary' ? setPrimary : setBefore)(m);
  }, []);

  const pad = () => analysisPadding(bp, { drawer: drawerOpen && !presentation, layers: layersOpen && bp === 'wide' && !presentation });

  // Camera requests from anywhere in the UI; each request (nonce) is served once.
  const served = useRef(0);
  useEffect(() => {
    if (!primary || !camera || served.current === camera.nonce) return;
    const s = useUi.getState();
    switch (camera.kind) {
      case 'home': primary.flyHome(landingInset(bp, s.phase), landingZoom(bp, s.phase)); break;
      case 'aoi': if (!aoi) return; primary.flyToAoi(aoi, pad()); break;
      case 'event': {
        const ev = analysis?.events.features.find((f) => f.id === camera.id);
        if (!ev) return;
        primary.flyToEvent(ev.properties.bbox, pad());
        break;
      }
      case 'bbox': if (camera.bbox) primary.fitBounds(camera.bbox, { top: 120, bottom: 160, left: 80, right: bp === 'mobile' ? 40 : 420 }, 12, 2200); break;
      case 'point': if (camera.point) primary.flyToPoint(camera.point, 5.2); break;
      case 'zoom-in': primary.zoomBy(1); break;
      case 'zoom-out': primary.zoomBy(-1); break;
      case 'north': primary.resetNorth(); break;
    }
    served.current = camera.nonce;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary, camera?.nonce, aoi?.id, analysis]);

  // Landing: keep the globe composed around the hero column / panels.
  useEffect(() => {
    if (!primary || aoi) return;
    const s = useUi.getState();
    if (selectCandidate(s) || s.drawTool) return;
    primary.flyHome(landingInset(bp, phase), landingZoom(bp, phase));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary, phase, bp]);

  // Keep both cameras locked together in compare mode.
  useEffect(() => {
    if (!primary || !before) return;
    let lock = false;
    const copy = (src: TerraMap, dst: TerraMap) => () => {
      if (lock) return;
      lock = true;
      dst.map.jumpTo({ center: src.map.getCenter(), zoom: src.map.getZoom(), bearing: src.map.getBearing(), pitch: src.map.getPitch(), padding: src.map.getPadding() });
      lock = false;
    };
    const a = copy(primary, before), b = copy(before, primary);
    a();
    primary.map.on('move', a);
    before.map.on('move', b);
    return () => { primary.map.off('move', a); before.map.off('move', b); };
  }, [primary, before]);

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || !stage.current) return;
    const r = stage.current.getBoundingClientRect();
    setSplit(Math.min(94, Math.max(6, ((e.clientX - r.left) / r.width) * 100)));
  };

  const showCompare = compare && !!aoi && view !== 'explore';

  return (
    <div ref={stage} className={`tt-space absolute inset-0 overflow-hidden ${dragging ? 'cursor-ew-resize select-none' : ''}`} onPointerMove={onPointerMove} onPointerUp={() => setDragging(false)} onPointerLeave={() => setDragging(false)}>
      <MapCanvas role="primary" year={year} onReady={onReady} />
      {!aoi && <OrbitOverlay />}

      {showCompare && (
        <>
          <MapCanvas role="before" year={win.start} onReady={onReady} style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} />
          <div className="pointer-events-none absolute inset-y-0 z-10" style={{ left: `${split}%` }}>
            <div className={`absolute inset-y-0 -left-px w-[2px] transition-colors ${dragging ? 'bg-accent' : 'bg-white/85'}`} style={{ boxShadow: dragging ? '0 0 16px rgba(69,208,196,.8)' : '0 0 10px rgba(0,0,0,.6)' }} />
            <button
              aria-label={`Compare slider — before ${win.start}, after ${year}. Use arrow keys to move.`}
              className={`tt-compare-handle pointer-events-auto absolute top-1/2 -left-[22px] grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full ${dragging ? 'is-dragging' : ''}`}
              onPointerDown={(e) => { setDragging(true); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); setSplit((s) => Math.max(6, s - 4)); }
                if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setSplit((s) => Math.min(94, s + 4)); }
              }}
            >
              <span className="flex gap-[3px]" aria-hidden>
                <i className="h-3.5 w-[2px] rounded-full bg-current" /><i className="h-3.5 w-[2px] rounded-full bg-current" /><i className="h-3.5 w-[2px] rounded-full bg-current" />
              </span>
            </button>
            <div className="absolute top-[88px] -translate-x-[calc(100%+10px)] whitespace-nowrap max-md:top-[76px]">
              <div className="tt-chip-label"><span className="text-ink-3">BEFORE</span> <span className="t-data text-ink">{win.start}</span></div>
            </div>
            <div className="absolute left-[10px] top-[88px] whitespace-nowrap max-md:top-[76px]">
              <div className="tt-chip-label"><span className="text-ink-3">AFTER</span> <span className="t-data text-accent">{year}</span></div>
            </div>
          </div>
        </>
      )}

      {aoi && view !== 'explore' && <ReferenceImageryNotice />}
      {aoi && view !== 'explore' && <AnalysisMapControls onFit={() => useUi.getState().requestCamera({ kind: 'aoi', id: aoi.id })} />}
      {aoi && view !== 'explore' && <MapHud />}
      <TileErrorToast />
    </div>
  );
}

/** Two restrained orbital rings with a slow satellite node, drawn around the landing globe. */
function OrbitOverlay() {
  const v = useMapRegistry((s) => s.view);
  const primary = useMapRegistry((s) => s.primary);
  const reduced = useUi((s) => s.reducedMotion);
  if (!primary || v.zoom > 3.3) return null;
  const c = primary.map.project(primary.map.getCenter());
  const r = (512 * 2 ** v.zoom) / (2 * Math.PI);
  const fade = Math.max(0, Math.min(1, (3.3 - v.zoom) / 0.8));
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden style={{ opacity: fade }}>
      <defs>
        <linearGradient id="orbit-g" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#45d0c4" stopOpacity="0" />
          <stop offset="0.5" stopColor="#45d0c4" stopOpacity="0.45" />
          <stop offset="1" stopColor="#45d0c4" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g transform={`translate(${c.x} ${c.y}) rotate(-18)`}>
        <ellipse rx={r * 1.32} ry={r * 0.36} fill="none" stroke="url(#orbit-g)" strokeWidth="1" />
        <ellipse rx={r * 1.18} ry={r * 0.62} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1" transform="rotate(38)" />
        {!reduced && (
          <circle r="2.6" fill="#e9fffc">
            <animateMotion dur="26s" repeatCount="indefinite" path={`M ${r * 1.32} 0 A ${r * 1.32} ${r * 0.36} 0 1 1 ${-r * 1.32} 0 A ${r * 1.32} ${r * 0.36} 0 1 1 ${r * 1.32} 0`} />
          </circle>
        )}
      </g>
    </svg>
  );
}

function AnalysisMapControls({ onFit }: { onFit(): void }) {
  const req = useUi((s) => s.requestCamera);
  const drawerOpen = useUi((s) => s.drawerOpen);
  const presentation = useUi((s) => s.presentation.active);
  const bearing = useMapRegistry((s) => s.view.bearing);
  const bp = useBreakpoint();
  if (bp === 'mobile') return null;
  const right = drawerOpen && !presentation ? (bp === 'wide' ? 404 : bp === 'desktop' ? 372 : 340) + 24 : 24;
  return (
    <div className="tt-panel absolute z-20 flex flex-col p-1 transition-[right] duration-300" style={{ right, bottom: CHROME.dock + 24 }}>
      <Tooltip content="Zoom in" side="left"><IconButton label="Zoom in" size="sm" onClick={() => req({ kind: 'zoom-in' })}><Plus size={15} /></IconButton></Tooltip>
      <Tooltip content="Zoom out" side="left"><IconButton label="Zoom out" size="sm" onClick={() => req({ kind: 'zoom-out' })}><Minus size={15} /></IconButton></Tooltip>
      <div className="mx-1.5 my-1 h-px bg-line" />
      <Tooltip content="Reset north" side="left">
        <IconButton label="Reset north" size="sm" onClick={() => req({ kind: 'north' })}><Compass size={15} style={{ transform: `rotate(${-bearing}deg)` }} /></IconButton>
      </Tooltip>
      <Tooltip content="Fit study area" side="left"><IconButton label="Fit study area" size="sm" onClick={onFit}><RotateCcw size={14} /></IconButton></Tooltip>
    </div>
  );
}

/**
 * Imagery honesty label. Without a READY analysis the map shows REAL IMAGERY only
 * (Sentinel-2 cloudless mosaics) — never analysis results.
 */
function ReferenceImageryNotice() {
  const year = useUi((s) => s.investigation.imageryYear);
  const studyId = useUi((s) => s.investigation.study?.id ?? null);
  const satellite = useUi((s) => s.layers.satellite);
  const hires = useUi((s) => s.imagery === 'hires');
  const q = useCurrentAnalysis();
  const bundle = q.data?.bundle ?? null;
  const img = bundle?.layers.imagery.find((i) => i.year === year);
  const live = useImageryDecision(studyId, year);
  const hiresLabel = useBasemaps().data?.hires.label ?? 'Esri World Imagery (current, undated)';
  const d = live.data;
  const throttling = useEeTiles((s) => s.throttling);
  // Imagery is independent of analysis: shown whenever no READY analysis layer covers this year.
  const show = satellite && !!studyId && !img;
  const box = 'pointer-events-none absolute left-1/2 top-[76px] z-20 -translate-x-1/2 rounded-md bg-[#0c1116]/92 px-3 py-1.5 text-center shadow-[0_0_0_1px_rgba(255,255,255,0.12)]';
  return (
    <AnimatePresence>
      {show && (
        <motion.div key="real-imagery"
          initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
          className={box} role="status" data-testid="real-imagery-label"
          data-imagery={hires ? 'basemap' : d?.status ?? (live.isError ? 'ERROR' : 'LOADING')} data-code={d?.code ?? ''}
        >
          {hires ? (
            <>
              <div className="t-label text-ink">Real imagery · no analysis</div>
              <div className="mt-0.5 text-[11px] text-ink-2">{hiresLabel} — not a TERRATRACE result</div>
            </>
          ) : d?.status === 'READY' ? (
            <>
              <div className="t-label text-ink">Live satellite imagery · no analysis</div>
              <div className="mt-0.5 text-[11px] text-ink-2">{d.label} · {d.sceneCount} scenes · Earth Engine — not a TERRATRACE result</div>
              {throttling && <div className="mt-1 text-[11px] text-warn" data-testid="imagery-throttled">Satellite imagery is temporarily throttled. Retrying…</div>}
            </>
          ) : d ? (
            <div data-testid="no-usable-imagery">
              <div className="t-label text-warn">{year} · imagery unavailable</div>
              <div className="mt-0.5 max-w-[360px] text-[11px] text-ink-2">{d.message} Nothing is substituted.</div>
            </div>
          ) : live.isError ? (
            <div data-testid="no-usable-imagery">
              <div className="t-label text-warn">Imagery unavailable</div>
              <div className="mt-0.5 text-[11px] text-ink-2" data-testid="imagery-error">{imageryErrorMessage(live.error)} Nothing is substituted.</div>
            </div>
          ) : (
            <div className="t-label text-ink-2" data-testid="imagery-loading">Loading satellite imagery · {year}</div>
          )}
        </motion.div>
      )}
      {satellite && img?.reference && (
        <motion.div key="reference"
          initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
          className="pointer-events-none absolute left-1/2 top-[76px] z-20 -translate-x-1/2 rounded-md bg-[#0c1116]/92 px-3 py-2 text-center shadow-[0_0_0_1px_rgba(227,164,63,0.35)]"
          role="status"
        >
          <div className="t-label text-warn">Reference imagery · desaturated</div>
          <div className="mt-0.5 text-[11px] text-ink-2">No {img.sensor} tiles are served for {year}. Forest layer and statistics show the {year} composite.</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function scaleBar(lat: number, zoom: number) {
  const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  const target = mPerPx * 90;
  const pow = 10 ** Math.floor(Math.log10(target));
  const nice = [1, 2, 5, 10].map((k) => k * pow).filter((v) => v <= target).pop() ?? pow;
  return { px: nice / mPerPx, label: nice >= 1000 ? `${nice / 1000} km` : `${nice} m` };
}

function MapHud() {
  const pointer = useMapRegistry((s) => s.pointer);
  const view = useMapRegistry((s) => s.view);
  const layersOpen = useUi((s) => s.layersOpen);
  const presentation = useUi((s) => s.presentation.active);
  const bp = useBreakpoint();
  if (bp === 'mobile') return null;
  const sb = scaleBar(view.lat, view.zoom);
  const p = pointer ?? view;
  const left = layersOpen && bp === 'wide' && !presentation ? 272 + 24 : 16;
  return (
    <div className="t-data pointer-events-none absolute z-10 flex items-center gap-3 rounded-sm bg-[#06080a]/70 px-2.5 py-1 text-[10.5px] text-ink-2 transition-[left] duration-300" style={{ left, bottom: CHROME.dock + 24 }}>
      <span>{fmtCoord(p.lng, p.lat)}</span>
      <span className="text-ink-4">z{view.zoom.toFixed(1)}</span>
      <span className="flex items-center gap-1.5"><span className="h-1.5 border-x border-b border-ink-3" style={{ width: sb.px }} />{sb.label}</span>
    </div>
  );
}

function TileErrorToast() {
  const tileError = useMapRegistry((s) => s.tileError);
  const set = useMapRegistry((s) => s.set);
  return (
    <AnimatePresence>
      {tileError && (
        <motion.div role="alert" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
          className="tt-panel absolute bottom-[210px] left-1/2 z-40 flex w-[min(420px,calc(100vw-32px))] -translate-x-1/2 items-start gap-3 p-3.5">
          <WifiOff size={17} className="mt-0.5 shrink-0 text-warn" />
          <div className="text-[12px] leading-relaxed text-ink-2">
            <div className="t-label text-ink">Imagery tiles unavailable</div>
            Some imagery could not be loaded. Check your connection; the analysis itself is unaffected.
          </div>
          <IconButton label="Dismiss" size="sm" className="-m-1 shrink-0" onClick={() => set({ tileError: false })}><X size={14} /></IconButton>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
