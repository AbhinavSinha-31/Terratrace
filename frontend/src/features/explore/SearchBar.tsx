import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Crosshair, Eraser, Hexagon, Loader2, MapPin, Search, SquareDashed, Trees, X, Radar } from 'lucide-react';
import { client } from '../../data/client';
import type { SearchResult } from '../../data/contracts';
import { useStudyAreas } from '../../data/queries';
import { selectCandidate, useUi } from '../../state/store';
import { useMapRegistry } from '../map/registry';
import { bboxAreaKm2, bboxPolygon, squareAround } from '../../lib/geo';
import { Tooltip } from '../../design';

const MAX_DIRECT_KM2 = 2500;

export function selectSearchResult(r: SearchResult) {
  const ui = useUi.getState();
  if (r.kind === 'featured' && r.study_area_id) return ui.openAnalysis(r.study_area_id, { name: r.name });
  ui.setPhase('explore');
  if (r.bbox) ui.requestCamera({ kind: 'bbox', bbox: r.bbox });
  else ui.requestCamera({ kind: 'point', point: r.center });
  // A region small enough is selected as-is; large regions get a 20 km sample square at their centre.
  const small = r.bbox && bboxAreaKm2(r.bbox) <= MAX_DIRECT_KM2 && r.kind !== 'coordinates';
  ui.setSelection({
    geometry: small ? bboxPolygon(r.bbox!) : squareAround(r.center, r.kind === 'coordinates' ? 10 : 20),
    source: 'search',
    name: small ? r.name : `${r.name} · sample area`,
  });
}

const KIND_ICON = { featured: Radar, forest: Trees, place: MapPin, coordinates: Crosshair };

/**
 * Parse user-typed coordinates. Humans write "lat, lon" (e.g. "11.1, 76.4" or
 * "11.1N 76.4E"); the result is returned in GeoJSON order [lon, lat].
 */
export function parseLatLon(q: string): [number, number] | null {
  const m = q.trim().match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?$/);
  if (!m) return null;
  let lat = Number(m[1]), lon = Number(m[3]);
  if (m[2]?.toUpperCase() === 'S') lat = -Math.abs(lat);
  if (m[4]?.toUpperCase() === 'W') lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

/** TerratraceSearch + TerratraceAOITool entry point (search · locate · draw). */
export function SearchBar({ compact = false }: { compact?: boolean }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [drawMenu, setDrawMenu] = useState(false);
  const [locating, setLocating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const drawBtn = useRef<HTMLDivElement>(null);
  const featured = useStudyAreas().data;
  const drawTool = useUi((s) => s.drawTool);
  const selection = useUi(selectCandidate);
  const setDrawTool = useUi((s) => s.setDrawTool);
  const setSelection = useUi((s) => s.setSelection);

  useEffect(() => {
    const focus = () => input.current?.focus();
    window.addEventListener('tt:focus-search', focus);
    return () => window.removeEventListener('tt:focus-search', focus);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); setNotice(null); return; }
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await client.search(q, featured);
        setResults(r.results);
        setNotice(r.notice ?? null);
        setActive(0);
      } catch {
        setResults([]);
        setNotice('Search failed — try coordinates such as 21.8, 86.3');
      } finally {
        setLoading(false);
      }
    }, 320);
    return () => window.clearTimeout(t);
  }, [q, featured]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
      if (!drawBtn.current?.contains(e.target as Node)) setDrawMenu(false);
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, []);

  const pick = (r: SearchResult) => {
    setOpen(false);
    setQ(r.name);
    selectSearchResult(r);
    input.current?.blur();
  };

  /** Enter: use the highlighted result, or resolve the query now (coordinates locally, else search). */
  const submit = async () => {
    if (results[active]) return pick(results[active]);
    const coords = parseLatLon(q);
    if (coords) return pick({ name: `${coords[1]}, ${coords[0]}`, detail: 'Coordinates', kind: 'coordinates', center: coords, bbox: null, source: 'input' });
    if (q.trim().length < 2) return;
    setLoading(true);
    try {
      const r = await client.search(q, featured);
      setResults(r.results);
      setNotice(r.notice ?? null);
      if (r.results[0]) pick(r.results[0]);
      else setOpen(true);
    } finally {
      setLoading(false);
    }
  };

  const locate = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const p: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        const ui = useUi.getState();
        ui.setPhase('explore');
        ui.requestCamera({ kind: 'point', point: p });
        ui.setSelection({ geometry: squareAround(p, 10), source: 'search', name: 'Your location · 10 km area' });
      },
      () => setLocating(false),
      { timeout: 8000 },
    );
  };

  const rect = box.current?.getBoundingClientRect();
  const showList = open && q.trim().length >= 2;

  return (
    <div className={`tt-search @container relative flex w-full items-center gap-1 rounded-lg p-1.5 ${compact ? 'h-12' : 'h-[58px]'}`} ref={box}>
      <Search size={18} className="ml-3 shrink-0 text-ink-3" />
      <input
        ref={input}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          else if (e.key === 'Escape') { setOpen(false); input.current?.blur(); }
        }}
        placeholder="Search a place, forest or coordinates"
        aria-label="Search Earth"
        role="combobox"
        aria-expanded={showList}
        aria-controls="tt-search-list"
        aria-autocomplete="list"
        className="h-full min-w-0 flex-1 bg-transparent px-2 text-[13.5px] text-ink placeholder:text-ink-3 focus:outline-none"
      />
      {loading && <Loader2 size={15} className="mr-1 animate-spin text-ink-3" />}
      {q && !loading && (
        <button aria-label="Clear search" onClick={() => { setQ(''); setResults([]); input.current?.focus(); }} className="tt-press grid h-8 w-8 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink">
          <X size={14} />
        </button>
      )}
      <Tooltip content="Use my location">
        <button aria-label="Use my location" onClick={locate} className="tt-press grid h-10 w-10 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-hover hover:text-ink">
          {locating ? <Loader2 size={16} className="animate-spin" /> : <Crosshair size={17} />}
        </button>
      </Tooltip>
      <div className="mx-1 h-6 w-px bg-line-2" />
      <div ref={drawBtn} className="relative flex shrink-0">
        <button
          onClick={() => setDrawTool(drawTool ? null : 'rect')}
          aria-pressed={!!drawTool}
          aria-label={drawTool ? 'Cancel drawing' : 'Draw area'}
          className={`tt-press flex h-10 items-center gap-2 rounded-l-md px-3.5 text-[12.5px] font-medium shadow-[0_0_0_1px_rgba(69,208,196,0.5)] ${drawTool ? 'bg-accent text-[#03201d]' : 'text-accent hover:bg-accent/10'}`}
        >
          <SquareDashed size={16} />
          <span className="hidden @[520px]:inline">{drawTool ? 'Drawing…' : 'Draw Area'}</span>
        </button>
        <button
          aria-label="Drawing options"
          aria-haspopup="menu"
          aria-expanded={drawMenu}
          onClick={() => setDrawMenu((o) => !o)}
          className="tt-press grid h-10 w-9 place-items-center rounded-r-md text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.5)] hover:bg-accent/10"
        >
          <ChevronDown size={15} className={`transition-transform ${drawMenu ? 'rotate-180' : ''}`} />
        </button>
        <AnimatePresence>
          {drawMenu && (
            <motion.div role="menu" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.14 }}
              className="tt-panel absolute bottom-full right-0 z-50 mb-2 w-52 p-1.5">
              {([
                ['Rectangle', 'Press and drag', SquareDashed, () => setDrawTool('rect')],
                ['Polygon', 'Click vertices, close to finish', Hexagon, () => setDrawTool('polygon')],
                ['Clear selection', selection ? 'Remove the current area' : 'Nothing selected', Eraser, () => { setDrawTool(null); setSelection(null); }],
              ] as const).map(([t, d, Icon, fn]) => (
                <button key={t} role="menuitem" onClick={() => { fn(); setDrawMenu(false); }} className="tt-press flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-hover">
                  <Icon size={16} className="text-accent" />
                  <span>
                    <span className="block text-[12.5px] text-ink">{t}</span>
                    <span className="block text-[10.5px] text-ink-3">{d}</span>
                  </span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {createPortal(
        <AnimatePresence>
          {showList && rect && (
            <motion.ul
              id="tt-search-list"
              role="listbox"
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}
              className="tt-panel fixed z-[97] max-h-[360px] overflow-y-auto p-1.5 scroll-thin"
              style={{ left: rect.left, width: rect.width, ...(rect.top > window.innerHeight / 2 ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }) }}
            >
              {results.length === 0 && !loading && <li className="px-3 py-3 text-[12px] text-ink-3">No matches. Try a place name or coordinates like “22.8, 82.8”.</li>}
              {results.map((r, i) => {
                const Icon = KIND_ICON[r.kind];
                return (
                  <li key={`${r.name}-${i}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(r); }}
                    className={`flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 ${i === active ? 'bg-hover' : ''}`}>
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-sm ${r.kind === 'featured' ? 'bg-accent/12 text-accent' : 'bg-white/[0.04] text-ink-2'}`}><Icon size={15} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-ink">{r.name}</span>
                      <span className="block truncate text-[11px] text-ink-3">{r.detail}</span>
                    </span>
                    <span className="t-label shrink-0 text-ink-4">{r.kind === 'featured' ? 'Investigation' : r.kind}</span>
                  </li>
                );
              })}
              {notice && <li className="px-3 pb-1 pt-2 text-[10.5px] text-ink-3">{notice}</li>}
            </motion.ul>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

/** Instruction chip shown while a drawing tool is active. */
export function DrawHint() {
  const tool = useUi((s) => s.drawTool);
  const setTool = useUi((s) => s.setDrawTool);
  const draft = useMapRegistry((s) => s.draft);
  return (
    <AnimatePresence>
      {tool && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} role="status"
          className="tt-panel pointer-events-auto flex items-center gap-3 px-3.5 py-2.5">
          <span className="relative flex h-2 w-2"><span className="absolute inset-0 animate-ping rounded-full bg-accent/60" /><span className="relative h-2 w-2 rounded-full bg-accent" /></span>
          <span className="t-label text-ink">Select area to analyze</span>
          <span className="text-[12px] text-ink-2">
            {tool === 'rect' ? 'Press and drag on the map' : draft ? 'Click to add points · click the first point or double-click to finish · Backspace undoes' : 'Click on the map to place the first point'}
          </span>
          <button className="tt-press ml-1 rounded-sm px-2 py-1 text-[11.5px] text-ink-3 hover:bg-hover hover:text-ink" onClick={() => setTool(null)}>Cancel · Esc</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
