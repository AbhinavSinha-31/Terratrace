import { useEffect } from 'react';
import { useUi, type InvestigationState, type OverlayPage, type View } from '../state/store';

/**
 * URL ⇄ UI state, so refreshes and shared links restore the same analysis.
 *
 *   #/                                   explore (intro)
 *   #/explore                            explore (map exploration)
 *   #/analysis/<aoiId>?from=2018&to=2025&year=2025
 *   #/timemachine/<aoiId>?from=1984&to=2025&year=1990
 *   #/case-study/<id>                    a static case study, full page over the overview
 *   #/profile                            the account page (sign in / your profile), full page over the overview
 *   #/scans                              My scans (signed-in users' saved analyses)
 *   #/community[?tag=x]                  community feed; #/community/new = new post; #/community/<postId> = a post
 *
 * `aoiId` is either a featured investigation id or a backend analysis id for a
 * custom AOI (the backend persists registered AOIs, so they survive a refresh).
 * Legacy `mode=` parameters are ignored and stripped — there is only one (LIVE) data path.
 */
export interface UrlState {
  view: View;
  phase: 'intro' | 'explore';
  aoiId: string | null;
  from?: number;
  to?: number;
  year?: number;
  caseStudy?: string | null;
  profile?: boolean;
  page?: OverlayPage | null;
}

const int = (v: string | null) => (v && /^\d{4}$/.test(v) ? Number(v) : undefined);

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return ''; // malformed escape (e.g. "%%%") — treat as an unknown segment, never throw
  }
};

const POST_ID = /^[0-9a-f-]{36}$/;

function parsePage(parts: string[], q: URLSearchParams): OverlayPage | null {
  if (parts[0] === 'scans') return { kind: 'scans' };
  if (parts[0] !== 'community') return null;
  if (parts[1] === 'new') return { kind: 'new-post' };
  if (parts[1] && POST_ID.test(parts[1])) return { kind: 'post', id: parts[1] };
  const tag = q.get('tag');
  return tag && /^[a-z0-9-]{1,32}$/.test(tag) ? { kind: 'community', tag } : { kind: 'community' };
}

export function pageHash(p: OverlayPage): string {
  if (p.kind === 'scans') return '#/scans';
  if (p.kind === 'new-post') return '#/community/new';
  if (p.kind === 'post') return `#/community/${p.id}`;
  return p.tag ? `#/community?tag=${encodeURIComponent(p.tag)}` : '#/community';
}

const samePage = (a: OverlayPage | null | undefined, b: OverlayPage | null | undefined) => (a ? pageHash(a) : '') === (b ? pageHash(b) : '');

/** Parse a location hash. Never throws: anything unrecognised falls back to Explore. */
export function parseHash(hash: string): UrlState {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(safeDecode);
  const q = new URLSearchParams(query);
  if (parts[0] === 'profile') return { view: 'explore', phase: 'intro', aoiId: null, profile: true };
  const page = parsePage(parts, q);
  if (page) return { view: 'explore', phase: 'intro', aoiId: null, page };
  if (parts[0] === 'case-study' && parts[1]) return { view: 'explore', phase: 'intro', aoiId: null, caseStudy: parts[1] };
  if ((parts[0] === 'analysis' || parts[0] === 'timemachine') && parts[1]) {
    return { view: parts[0], phase: 'explore', aoiId: parts[1], from: int(q.get('from')), to: int(q.get('to')), year: int(q.get('year')) };
  }
  if (parts[0] === 'analysis' || parts[0] === 'timemachine') return { view: parts[0], phase: 'intro', aoiId: null };
  return { view: 'explore', phase: parts[0] === 'explore' ? 'explore' : 'intro', aoiId: null };
}

/** The URL is a MIRROR of InvestigationState (study, baseline, comparison, imagery year) — never a source. */
export function toHash(s: { view: View; phase: 'intro' | 'explore'; investigation: InvestigationState; caseStudy?: string | null; profileOpen?: boolean; page?: OverlayPage | null }): string {
  if (s.profileOpen) return '#/profile';
  if (s.page) return pageHash(s.page);
  if (s.caseStudy) return `#/case-study/${encodeURIComponent(s.caseStudy)}`;
  const inv = s.investigation;
  if (s.view === 'explore' || !inv.study) {
    return s.view === 'explore' ? (s.phase === 'explore' ? '#/explore' : '#/') : `#/${s.view}`;
  }
  const q = new URLSearchParams({ from: String(inv.baselineYear), to: String(inv.comparisonYear), year: String(inv.imageryYear) });
  return `#/${s.view}/${encodeURIComponent(inv.study.id)}?${q}`;
}

/** Apply a URL to the state ONLY through store actions (the same paths the UI uses). */
function apply(u: UrlState) {
  const ui = useUi.getState();
  const studyId = ui.investigation.study?.id ?? null;
  if (u.aoiId) {
    const window = u.from !== undefined && u.to !== undefined && u.from < u.to ? { start: u.from, end: u.to } : undefined;
    if (u.aoiId !== studyId || u.view !== ui.view) ui.openAnalysis(u.aoiId, { view: u.view, window, imageryYear: u.year });
    else {
      if (window) ui.setWindow(window.start, window.end);
      if (u.year !== undefined) ui.setYear(u.year);
    }
  } else if (u.view === 'explore') {
    if (ui.view !== 'explore' || studyId) ui.goExplore(u.phase);
    else if (ui.phase !== u.phase) ui.setPhase(u.phase);
  } else {
    ui.setView(u.view);
  }
  const cs = u.caseStudy ?? null;
  if (ui.caseStudy !== cs) {
    if (cs) ui.openCaseStudy(cs);
    else ui.closeCaseStudy();
  }
  if (ui.profileOpen !== !!u.profile) {
    if (u.profile) ui.openProfile();
    else ui.closeProfile();
  }
  if (!samePage(ui.page, u.page)) {
    if (u.page) ui.openPage(u.page);
    else ui.closePage();
  }
}

/** Restore state from the URL on load, keep the URL in sync, and honour Back/Forward. */
export function useUrlSync() {
  useEffect(() => {
    try {
      apply(parseHash(window.location.hash));
    } catch (e) {
      console.warn('TERRATRACE: ignoring unreadable URL state', e);
      window.history.replaceState(null, '', `${window.location.pathname}#/`);
    }
    let last = window.location.hash;
    const unsub = useUi.subscribe((s, prev) => {
      const next = toHash(s);
      if (next === last || (next === '#/' && last === '')) return;
      // A new place (view / AOI / explore phase) is a history entry; scrubbing years is not.
      const navigation = s.view !== prev.view || s.investigation.study?.id !== prev.investigation.study?.id || s.phase !== prev.phase
        || s.caseStudy !== prev.caseStudy || s.profileOpen !== prev.profileOpen || !samePage(s.page, prev.page);
      const url = `${window.location.pathname}${window.location.search.replace(/[?&]mode=(live|demo)/, '')}${next}`;
      if (navigation) window.history.pushState(null, '', url);
      else window.history.replaceState(null, '', url);
      last = next;
    });
    const onPop = () => {
      last = window.location.hash;
      apply(parseHash(window.location.hash));
    };
    window.addEventListener('popstate', onPop);
    return () => {
      unsub();
      window.removeEventListener('popstate', onPop);
    };
  }, []);
}
