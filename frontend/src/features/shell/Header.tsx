import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, Bookmark, ChevronDown, RotateCcw, Info, LogIn, LogOut, Menu as MenuIcon, Search, Settings, UserRound, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useHealth } from '../../data/queries';
import { useUi, type View } from '../../state/store';
import { Avatar, IconButton, Popover, Switch, TerratraceLogo, TerratraceMark } from '../../design';
import type { SystemHealth } from '../../data/contracts';
import { ago, BADGE, useServiceStatus, type ServiceRow, type Tone } from './serviceStatus';
import { useBreakpoint } from '../../lib/useLayout';
import { useChat } from '../../state/chat';
import { openSignIn, signOut, useAuth } from '../../state/auth';
import { identity, useProfile } from '../account/profile';

type NavKey = 'explore' | 'analysis' | 'timemachine' | 'featured' | 'community' | 'ask' | 'about';
const NAV: { key: NavKey; label: string }[] = [
  { key: 'explore', label: 'Explore' },
  { key: 'analysis', label: 'Analysis' },
  { key: 'timemachine', label: 'Time Machine' },
  { key: 'featured', label: 'Featured' },
  { key: 'community', label: 'Community' },
  { key: 'ask', label: 'Ask TerraTrace' },
  { key: 'about', label: 'About' },
];

export function navigate(key: NavKey) {
  const ui = useUi.getState();
  if (key === 'ask') return useChat.getState().openAsk();
  useChat.getState().closeAsk();
  if (key !== 'community' && key !== 'about') ui.closePage();
  if (key === 'about') return ui.setAboutOpen(true);
  if (key === 'community') return ui.openPage({ kind: 'community' });
  if (key === 'featured') {
    ui.goExplore('intro');
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('tt:featured')), 50);
    return;
  }
  if (key === 'explore') return ui.goExplore(ui.phase);
  ui.setView(key as View);
}

const TONE_DOT: Record<Tone, string> = { ok: 'bg-live', pending: 'bg-warn', down: 'bg-ink-4', off: 'bg-ink-4' };

/** Re-renders every `ms` while mounted (the popover body mounts only while open). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(t); }, [ms]);
  return now;
}

function ServiceList({ rows, checking }: { rows: ServiceRow[]; checking: boolean }) {
  const now = useNow(5000);
  return (
    <>
      <ul className="mt-3 space-y-2.5" data-testid="service-status-list">
        {rows.map((r) => (
          <li key={r.key} className="flex items-start gap-2.5" data-testid={`service-${r.key}`} data-tone={r.tone}>
            <span className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${TONE_DOT[r.tone]}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[12.5px] font-medium text-ink">{r.name}</span>
                <span className="shrink-0 text-[12px] text-ink-2">{r.state}</span>
              </div>
              <div className="text-[11px] text-ink-4" title={r.checkedAt ? new Date(r.checkedAt).toLocaleString() : undefined}>{ago(r.checkedAt, now)}</div>
            </div>
          </li>
        ))}
      </ul>
      {checking && <p className="mt-3 text-[11px] text-ink-3">Checking now… a sleeping server can take about a minute to wake.</p>}
    </>
  );
}

function StatusPill() {
  const queryClient = useQueryClient();
  const { badge, rows, checking } = useServiceStatus();
  const b = BADGE[badge];
  return (
    <Popover
      label="Service status"
      width={330}
      trigger={(p) => (
        <button
          {...p}
          data-testid="data-status"
          data-state={badge}
          aria-label={`Service status: ${b.label}`}
          className="tt-press flex h-9 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md bg-white/[0.03] px-3 text-[11px] font-medium uppercase tracking-[0.12em] text-ink shadow-[0_0_0_1px_rgba(255,255,255,0.1)] hover:bg-hover"
        >
          <span className="relative flex h-2 w-2">
            {badge !== 'offline' && <span className={`absolute inset-0 rounded-full ${b.dot} ${badge === 'online' ? 'animate-blink' : 'animate-pulse'}`} />}
            <span className={`relative h-2 w-2 rounded-full ${b.dot}`} />
          </span>
          <span className="hidden min-[1440px]:inline">{b.label}</span>
          <span className="hidden min-[1024px]:inline min-[1440px]:hidden">{b.short}</span>
          <ChevronDown size={13} className="text-ink-3" />
        </button>
      )}
    >
      {() => (
        <div className="p-4">
          <div className="t-label text-ink-3">Service status</div>
          <ServiceList rows={rows} checking={checking} />
          <p className="mt-3 text-[11px] leading-relaxed text-ink-4">TERRATRACE never shows simulated results: measurements appear only for completed, validated (published) analyses.</p>
          <button className="tt-press mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-md bg-accent/12 text-[12.5px] font-medium text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.4)] hover:bg-accent/20 disabled:opacity-50"
            disabled={checking}
            onClick={() => { for (const k of ['health', 'service-status', 'imagery', 'imagery-availability', 'basemaps']) void queryClient.invalidateQueries({ queryKey: [k] }); }}>
            <RotateCcw size={14} /> Check now
          </button>
        </div>
      )}
    </Popover>
  );
}
function notices(h?: SystemHealth): { tone: 'warn' | 'info'; title: string; body: string }[] {
  if (!h) return [];
  const out: { tone: 'warn' | 'info'; title: string; body: string }[] = [];
  if (!h.backend || h.analysis.status !== 'ready') {
    out.push({ tone: 'warn', title: 'Analysis unavailable', body: 'Earth Engine analysis is temporarily unavailable. Real imagery remains explorable; no measurements are shown.' });
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
      {() => (
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
        </div>
      )}
    </Popover>
  );
}


function openProfile() {
  useChat.getState().closeAsk();
  useUi.getState().openProfile();
}

const menuItem = 'tt-press flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink';

function AccountMenu() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.session?.user ?? null);
  const { data: profile } = useProfile();
  const who = user ? identity(user, profile) : null;
  return (
    <Popover
      label="Account"
      width={260}
      trigger={(p) => (
        <button {...p} aria-label={who ? `Account menu — ${who.name}` : 'Account menu'} data-testid="account-button" className="tt-press grid h-9 w-9 place-items-center rounded-full bg-accent/12 text-accent shadow-[0_0_0_1px_rgba(69,208,196,0.4)] hover:bg-accent/20">
          {who && user ? <Avatar name={who.name} src={who.avatar} userId={user.id} size="md" /> : <UserRound size={16} />}
        </button>
      )}
    >
      {(close) => (
        <div className="p-2">
          {who ? (
            <div className="flex items-center gap-2.5 px-2.5 py-2">
              <Avatar name={who.name} src={who.avatar} userId={user?.id} size="md" />
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-medium text-ink">{who.name}</div>
                {who.email && <div className="truncate text-[11px] text-ink-3">{who.email}</div>}
              </div>
            </div>
          ) : (
            <div className="px-2.5 py-2">
              <div className="text-[12.5px] font-medium text-ink">{status === 'unconfigured' ? 'Local session' : 'Not signed in'}</div>
              <div className="text-[11px] text-ink-3">{status === 'unconfigured' ? 'Accounts are not available yet' : status === 'loading' ? 'Checking your session…' : 'Sign in to keep a profile'}</div>
            </div>
          )}
          <div className="my-1 h-px bg-line" />
          {who ? (
            <>
              <button className={menuItem} onClick={() => { close(); openProfile(); }} data-testid="menu-profile"><UserRound size={15} /> Profile</button>
              <button className={menuItem} onClick={() => { close(); useChat.getState().closeAsk(); useUi.getState().openPage({ kind: 'scans' }); }} data-testid="menu-scans"><Bookmark size={15} /> My scans</button>
              <button className={menuItem} onClick={() => { close(); void signOut().catch(() => openProfile()); }} data-testid="menu-sign-out"><LogOut size={15} /> Sign out</button>
            </>
          ) : status === 'signed-out' && (
            <button className={menuItem} onClick={() => { close(); openSignIn(); }} data-testid="menu-sign-in"><LogIn size={15} /> Sign in</button>
          )}
          <button className={menuItem} onClick={() => { close(); useUi.getState().setAboutOpen(true); }}>
            <Info size={15} /> About TERRATRACE
          </button>
        </div>
      )}
    </Popover>
  );
}

/** The phone/tablet menu has no avatar: the account page is reached from here. */
function AccountMenuEntry({ onPick }: { onPick(): void }) {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.session?.user ?? null);
  const { data: profile } = useProfile();
  if (status === 'unconfigured' || status === 'loading') return null;
  const who = user ? identity(user, profile) : null;
  return (
    <button onClick={() => { onPick(); openProfile(); }} data-testid="menu-account" className="tt-press mt-auto flex h-14 w-full items-center gap-3 rounded-md border-t border-line px-3 text-[14px] text-ink-2">
      {who ? <><Avatar name={who.name} src={who.avatar} userId={user?.id} size="md" /><span className="min-w-0 truncate">{who.name}</span></> : <><LogIn size={17} /> Sign in</>}
    </button>
  );
}

/** Less-used links: inside "More" between 900 and 1279 px (all links show from 1280 px; below 900 px, the menu). */
const COLLAPSED: NavKey[] = ['featured', 'about'];

function MoreMenu({ active }: { active: NavKey }) {
  const items = NAV.filter((n) => COLLAPSED.includes(n.key));
  const on = items.some((n) => n.key === active);
  return (
    <div className="flex h-full items-stretch min-[1280px]:hidden">
      <Popover
        label="More"
        width={200}
        trigger={(p) => (
          <button {...p} data-testid="nav-more"
            className={`tt-press relative flex h-16 items-center gap-1 whitespace-nowrap px-3.5 text-[13px] font-medium transition-colors ${on ? 'text-ink' : 'text-ink-3 hover:text-ink'}`}>
            More <ChevronDown size={13} />
            {on && <motion.span layoutId="nav-ind" className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-accent shadow-[0_0_10px_rgba(69,208,196,0.8)]" />}
          </button>
        )}
      >
        {(close) => (
          <div className="p-2">
            {items.map((n) => <button key={n.key} className={menuItem} onClick={() => { close(); navigate(n.key); }}>{n.label}</button>)}
          </div>
        )}
      </Popover>
    </div>
  );
}

export function Header() {
  const view = useUi((s) => s.view);
  const aboutOpen = useUi((s) => s.aboutOpen);
  const { data: health } = useHealth();
  const bp = useBreakpoint();
  const [menu, setMenu] = useState(false);
  const askOpen = useChat((s) => s.askOpen);
  const inCommunity = useUi((s) => s.page?.kind === 'community' || s.page?.kind === 'post' || s.page?.kind === 'new-post');
  const active: NavKey = aboutOpen ? 'about' : askOpen ? 'ask' : inCommunity ? 'community' : view;

  return (
    <header className="tt-header relative z-50 flex h-16 items-center gap-6 px-4 sm:px-6">
      <button onClick={() => useUi.getState().goExplore('intro')} aria-label="TERRATRACE — home" className="tt-press shrink-0 rounded-md">
        <span className="min-[1600px]:hidden"><TerratraceMark size={28} /></span>
        <span className="hidden min-[1600px]:inline"><TerratraceLogo size="md" /></span>
      </button>

      {/* ≥ 1280 px: every link. 900–1279 px: Featured and About go into "More". < 900 px: the menu button. */}
      <nav aria-label="Primary" className="hidden h-full items-stretch gap-0.5 min-[900px]:flex min-[1280px]:ml-4 min-[1280px]:gap-1">
        {NAV.map((n) => (
          <button
            key={n.key}
            onClick={() => navigate(n.key)}
            aria-current={active === n.key ? 'page' : undefined}
            className={`tt-press relative whitespace-nowrap px-3 text-[13px] font-medium transition-colors min-[1280px]:px-3.5 ${COLLAPSED.includes(n.key) ? 'hidden min-[1280px]:block' : ''} ${active === n.key ? 'text-ink' : 'text-ink-3 hover:text-ink'}`}
          >
            {n.label}
            {active === n.key && <motion.span layoutId="nav-ind" className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-accent shadow-[0_0_10px_rgba(69,208,196,0.8)]" />}
          </button>
        ))}
        <MoreMenu active={active} />
      </nav>

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <StatusPill />
        <IconButton label="Search Earth" onClick={() => { if (useUi.getState().view !== 'explore') useUi.getState().goExplore('explore'); window.setTimeout(() => window.dispatchEvent(new CustomEvent('tt:focus-search')), 80); }}>
          <Search size={17} />
        </IconButton>
        {bp !== 'mobile' && <Notifications health={health} />}
        {bp !== 'mobile' && <SettingsMenu />}
        <span className="min-[900px]:hidden"><IconButton label="Menu" onClick={() => setMenu(true)}><MenuIcon size={18} /></IconButton></span>
        <span className="hidden min-[900px]:block"><AccountMenu /></span>
      </div>

      <AnimatePresence>
        {menu && (
          <motion.div className="fixed inset-0 z-[80] bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMenu(false)}
            role="dialog" aria-modal="true" aria-label="Menu" onKeyDown={(e) => { if (e.key === 'Escape') setMenu(false); }}>
            <motion.nav
              aria-label="Primary"
              initial={{ x: 40 }} animate={{ x: 0 }} exit={{ x: 40 }}
              onClick={(e) => e.stopPropagation()}
              className="tt-panel absolute bottom-3 right-3 top-3 flex w-[min(300px,calc(100vw-24px))] flex-col p-3"
            >
              <div className="flex items-center justify-between px-2 py-1">
                <TerratraceLogo size="sm" />
                <IconButton label="Close menu" size="sm" autoFocus onClick={() => setMenu(false)}><X size={15} /></IconButton>
              </div>
              <div className="mt-4 space-y-1">
                {NAV.map((n) => (
                  <button key={n.key} onClick={() => { setMenu(false); navigate(n.key); }} className={`tt-press flex h-12 w-full items-center rounded-md px-3 text-[14px] ${active === n.key ? 'bg-hover text-ink' : 'text-ink-2'}`}>
                    {n.label}
                  </button>
                ))}
              </div>
              <AccountMenuEntry onPick={() => setMenu(false)} />
            </motion.nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
