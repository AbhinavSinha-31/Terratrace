import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, ChevronDown, RotateCcw, Info, Menu as MenuIcon, MonitorPlay, Search, Settings, UserRound, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useHealth } from '../../data/queries';
import { useUi, type View } from '../../state/store';
import { IconButton, Popover, Switch, TerratraceLogo, TerratraceMark } from '../../design';
import type { SystemHealth } from '../../data/contracts';
import { useBreakpoint } from '../../lib/useLayout';

type NavKey = 'explore' | 'analysis' | 'timemachine' | 'featured' | 'about';
const NAV: { key: NavKey; label: string }[] = [
  { key: 'explore', label: 'Explore' },
  { key: 'analysis', label: 'Analysis' },
  { key: 'timemachine', label: 'Time Machine' },
  { key: 'featured', label: 'Featured' },
  { key: 'about', label: 'About' },
];

export function navigate(key: NavKey) {
  const ui = useUi.getState();
  if (key === 'about') return ui.setAboutOpen(true);
  if (key === 'featured') {
    ui.goExplore('intro');
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('tt:featured')), 50);
    return;
  }
  if (key === 'explore') return ui.goExplore(ui.phase);
  ui.setView(key as View);
}

/** Public data status (product language only — no infrastructure or setup details). */
export function dataStatus(h?: SystemHealth): { short: string; long: string; detail: string; ready: boolean } {
  if (!h) return { short: 'Live', long: 'Live Earth Observation', detail: 'Checking availability…', ready: false };
  if (h.backend && h.analysis.status === 'ready') {
    return { short: 'Live', long: 'Live Earth Observation', detail: 'Live analysis is available. Results are measured from Landsat, Sentinel-2 and Dynamic World imagery.', ready: true };
  }
  return {
    short: 'Unavailable', long: 'Live analysis unavailable', ready: false,
    detail: 'Live Earth observation is temporarily unavailable. You can keep exploring real imagery; TERRATRACE does not display estimated, simulated, or placeholder measurements.',
  };
}
function StatusPill({ health }: { health?: SystemHealth }) {
  const queryClient = useQueryClient();
  const s = dataStatus(health);
  const dot = s.ready ? 'bg-live' : 'bg-warn';
  return (
    <Popover
      label="Data status"
      width={330}
      trigger={(p) => (
        <button
          {...p}
          data-testid="data-status"
          className="tt-press flex h-9 items-center gap-2.5 rounded-md bg-white/[0.03] px-3 text-[11px] font-medium uppercase tracking-[0.12em] text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.1)] hover:bg-hover"
        >
          <span className="relative flex h-2 w-2">
            <span className={`absolute inset-0 rounded-full ${dot} ${s.ready ? 'animate-blink' : ''}`} />
            <span className={`relative h-2 w-2 rounded-full ${dot}`} />
          </span>
          <span className="hidden lg:inline">{s.long}</span>
          <span className="lg:hidden">{s.short}</span>
          <ChevronDown size={13} className="text-ink-3" />
        </button>
      )}
    >
      {(close) => (
        <div className="p-4">
          <div className="t-label text-ink-3">Data status</div>
          <div className="mt-2 flex items-center gap-2 text-[13px] font-medium text-ink"><span className={`h-2 w-2 rounded-full ${dot}`} />{s.long}</div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">{s.detail}</p>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-4">TERRATRACE never shows simulated results: measurements appear only for completed, validated live analyses.</p>
          {!s.ready && (
            <button className="tt-press mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-md bg-accent/12 text-[12.5px] font-medium text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.4)] hover:bg-accent/20"
              onClick={() => { close(); void queryClient.invalidateQueries({ queryKey: ['health'] }); }}>
              <RotateCcw size={14} /> Retry
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}
function notices(h?: SystemHealth): { tone: 'warn' | 'info'; title: string; body: string }[] {
  if (!h) return [];
  const out: { tone: 'warn' | 'info'; title: string; body: string }[] = [];
  if (!h.backend || h.analysis.status !== 'ready') {
    out.push({ tone: 'warn', title: 'Live analysis unavailable', body: 'Live Earth observation is temporarily unavailable. Real imagery remains explorable; no measurements are shown.' });
  }
  if (h.backend && h.explainer.status !== 'ready') out.push({ tone: 'info', title: 'Deterministic briefings', body: 'Completed analyses are explained by the deterministic TERRATRACE briefing, generated only from measured facts.' });
  if (h.geocoder.status !== 'ready') out.push({ tone: 'info', title: 'Place search limited', body: 'Featured investigations and coordinates remain searchable.' });
  return out;
}
function Notifications({ health }: { health?: SystemHealth }) {
  const list = notices(health);
  return (
    <Popover
      label="System notices"
      width={340}
      trigger={(p) => (
        <span className="relative">
          <IconButton {...p} label={`System notices (${list.length})`}><Bell size={17} /></IconButton>
          {list.some((n) => n.tone === 'warn') && <span className="pointer-events-none absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-warn" />}
        </span>
      )}
    >
      <div className="p-4">
        <div className="t-label text-ink-3">System notices</div>
        {list.length === 0 ? (
          <p className="mt-3 text-[12px] text-ink-2">All services operational.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {list.map((n) => (
              <li key={n.title} className="flex gap-3">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${n.tone === 'warn' ? 'bg-warn' : 'bg-accent'}`} />
                <div>
                  <div className="text-[12.5px] font-medium text-ink">{n.title}</div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">{n.body}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Popover>
  );
}

function SettingsMenu() {
  const layers = useUi((s) => s.layers);
  const setLayer = useUi((s) => s.setLayer);
  const reduced = useUi((s) => s.reducedMotion);
  return (
    <Popover
      label="Settings"
      width={300}
      trigger={(p) => <IconButton {...p} label="Settings"><Settings size={17} /></IconButton>}
    >
      {(close) => (
        <div className="p-4">
          <div className="t-label text-ink-3">Display</div>
          <div className="mt-3 space-y-3">
            {([
              ['Global forest reference', 'Hansen tree cover 2000 on the globe', layers.globalForest, (v: boolean) => setLayer('globalForest', v)],
              ['Place labels', 'Boundaries and place names', layers.labels, (v: boolean) => setLayer('labels', v)],
              ['Reduce motion', 'Disable globe drift and animations', reduced, (v: boolean) => useUi.setState({ reducedMotion: v })],
            ] as const).map(([t, d, on, fn]) => (
              <div key={t} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] text-ink">{t}</div>
                  <div className="text-[11px] text-ink-3">{d}</div>
                </div>
                <Switch on={on} onChange={fn} label={t} />
              </div>
            ))}
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <button className="tt-press flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink" onClick={() => { close(); startPresentation(); }}>
              <MonitorPlay size={15} /> Start presentation mode
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

export function startPresentation() {
  useUi.getState().setPresentation({ active: true, step: 0 });
}

function Avatar() {
  return (
    <Popover
      label="Session"
      width={260}
      trigger={(p) => (
        <button {...p} aria-label="Session menu" className="tt-press grid h-9 w-9 place-items-center rounded-full bg-accent/12 text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.4)] hover:bg-accent/20">
          <UserRound size={16} />
        </button>
      )}
    >
      {(close) => (
        <div className="p-2">
          <div className="px-2.5 py-2">
            <div className="text-[12.5px] font-medium text-ink">Local session</div>
            <div className="text-[11px] text-ink-3">Not signed in · prototype build</div>
          </div>
          <div className="my-1 h-px bg-line" />
          <button className="tt-press flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink" onClick={() => { close(); startPresentation(); }}>
            <MonitorPlay size={15} /> Presentation mode
          </button>
          <button className="tt-press flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink" onClick={() => { close(); useUi.getState().setAboutOpen(true); }}>
            <Info size={15} /> About TERRATRACE
          </button>
        </div>
      )}
    </Popover>
  );
}

export function Header() {
  const view = useUi((s) => s.view);
  const aboutOpen = useUi((s) => s.aboutOpen);
  const { data: health } = useHealth();
  const bp = useBreakpoint();
  const [menu, setMenu] = useState(false);
  const active: NavKey = aboutOpen ? 'about' : view;

  return (
    <header className="tt-header relative z-50 flex h-16 items-center gap-6 px-4 sm:px-6">
      <button onClick={() => useUi.getState().goExplore('intro')} aria-label="TERRATRACE — home" className="tt-press shrink-0 rounded-md">
        {bp === 'mobile' ? <TerratraceMark size={28} /> : <TerratraceLogo size="md" />}
      </button>

      {bp !== 'mobile' && (
        <nav aria-label="Primary" className="ml-4 hidden h-full items-stretch gap-1 md:flex">
          {NAV.map((n) => (
            <button
              key={n.key}
              onClick={() => navigate(n.key)}
              aria-current={active === n.key ? 'page' : undefined}
              className={`tt-press relative px-3.5 text-[13px] font-medium transition-colors ${active === n.key ? 'text-ink' : 'text-ink-3 hover:text-ink'}`}
            >
              {n.label}
              {active === n.key && <motion.span layoutId="nav-ind" className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-accent shadow-[0_0_10px_rgba(69,208,196,0.8)]" />}
            </button>
          ))}
        </nav>
      )}

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <StatusPill health={health} />
        <IconButton label="Search Earth" onClick={() => { if (useUi.getState().view !== 'explore') useUi.getState().goExplore('explore'); window.setTimeout(() => window.dispatchEvent(new CustomEvent('tt:focus-search')), 80); }}>
          <Search size={17} />
        </IconButton>
        {bp !== 'mobile' && <Notifications health={health} />}
        {bp !== 'mobile' && <SettingsMenu />}
        {bp === 'mobile' || bp === 'tablet' ? (
          <IconButton label="Menu" onClick={() => setMenu(true)}><MenuIcon size={18} /></IconButton>
        ) : (
          <Avatar />
        )}
      </div>

      <AnimatePresence>
        {menu && (
          <motion.div className="fixed inset-0 z-[80] bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMenu(false)}>
            <motion.nav
              aria-label="Primary"
              initial={{ x: 40 }} animate={{ x: 0 }} exit={{ x: 40 }}
              onClick={(e) => e.stopPropagation()}
              className="tt-panel absolute bottom-3 right-3 top-3 flex w-[min(300px,calc(100vw-24px))] flex-col p-3"
            >
              <div className="flex items-center justify-between px-2 py-1">
                <TerratraceLogo size="sm" />
                <IconButton label="Close menu" size="sm" onClick={() => setMenu(false)}><X size={15} /></IconButton>
              </div>
              <div className="mt-4 space-y-1">
                {NAV.map((n) => (
                  <button key={n.key} onClick={() => { setMenu(false); navigate(n.key); }} className={`tt-press flex h-12 w-full items-center rounded-md px-3 text-[14px] ${active === n.key ? 'bg-hover text-ink' : 'text-ink-2'}`}>
                    {n.label}
                  </button>
                ))}
                <button onClick={() => { setMenu(false); startPresentation(); }} className="tt-press flex h-12 w-full items-center gap-2.5 rounded-md px-3 text-[14px] text-ink-2">
                  <MonitorPlay size={16} /> Presentation mode
                </button>
              </div>
            </motion.nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
