import { useEffect, useState } from 'react';
import type { Padding } from '../features/map/TerraMap';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop' | 'wide';

function current(): Breakpoint {
  const w = window.innerWidth;
  if (w < 768) return 'mobile';
  if (w < 1024) return 'tablet';
  if (w < 1320) return 'desktop';
  return 'wide';
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(current);
  useEffect(() => {
    const on = () => setBp(current());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return bp;
}

/** Fixed chrome sizes (px) shared by the layout and the camera. */
export const CHROME = { header: 64, dock: 188, gutter: 12, drawer: { wide: 404, desktop: 372, tablet: 340 }, layers: 272 };

/** Camera padding so fitted features land in the visible gap between panels. */
export function analysisPadding(bp: Breakpoint, opts: { drawer: boolean; layers: boolean }): Padding {
  if (bp === 'mobile') return { top: 80, bottom: Math.round(window.innerHeight * 0.48), left: 24, right: 24 };
  const drawerW = bp === 'wide' ? CHROME.drawer.wide : bp === 'desktop' ? CHROME.drawer.desktop : CHROME.drawer.tablet;
  return {
    top: CHROME.header + 36,
    bottom: CHROME.dock + 48,
    left: opts.layers ? CHROME.layers + 48 : 48,
    right: opts.drawer ? drawerW + 48 : 64,
  };
}

/** Height of the landing featured row (matches the Landing column layout at common sizes). */
const featuredRowHeight = (h: number) => Math.round(Math.min(300, Math.max(220, h * 0.3)));

/**
 * Where the landing globe sits: centred between the hero column and the right-hand
 * panels, inside the region above the featured row.
 */
export function landingInset(bp: Breakpoint, phase: 'intro' | 'explore'): Partial<Padding> {
  const w = window.innerWidth, h = window.innerHeight;
  if (bp === 'mobile') return { top: 0, bottom: Math.round(h * 0.45) };
  if (phase === 'explore') return { top: CHROME.header, left: 0, right: 0, bottom: 0 };
  if (bp === 'tablet') return { top: CHROME.header, left: Math.round(w * 0.1), right: 0, bottom: featuredRowHeight(h) };
  const heroRight = Math.min(620, Math.round(w * 0.43));
  const panels = bp === 'wide' ? 292 + 24 : 24;
  return { top: CHROME.header, left: heroRight, right: panels, bottom: featuredRowHeight(h) };
}

/** Globe zoom so its radius fills the region above the featured row (slightly cropped at the top, like the reference). */
export function landingZoom(bp: Breakpoint, phase: 'intro' | 'explore'): number {
  const w = window.innerWidth, h = window.innerHeight;
  if (bp === 'mobile') return 1.3;
  if (phase === 'explore') return 2.2 + Math.log2(Math.max(0.75, Math.min(1.3, h / 900)));
  const inset = landingInset(bp, 'intro');
  const availH = h - (inset.top ?? 0) - (inset.bottom ?? 0);
  const availW = w - (inset.left ?? 0) - (inset.right ?? 0);
  const radius = Math.min(availH * 0.53, availW * 0.6);
  return Math.log2((radius * 2 * Math.PI) / 512);
}
