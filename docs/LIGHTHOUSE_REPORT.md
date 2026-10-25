# Lighthouse, accessibility and mobile report

Measured 2026-10-25 on branch `production`, on this Windows laptop (other work running at the same time), against the
**production build** (`vite build` + `vite preview`) with a local backend whose stored results were copied from the
development cache, so no Earth Engine analysis ran. Lighthouse 13.5.0, Chrome headless; "mobile" = Lighthouse's
default emulation (Moto G Power, slow 4G, 4× CPU slowdown), "desktop" = `--preset=desktop`.

Single Lighthouse runs on this machine vary by ±5 performance points and up to 2× in Total Blocking Time; the
before/after comparison therefore uses the **median of 3 runs** of the same page on both builds.

## Scores after this phase

| Page | Performance | Accessibility | Best practices | SEO | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|---|
| Landing, mobile | 33 | 100 | 96 | 100 | 3.8 s | 6.1 s | 2,710 ms | 0.003 |
| Landing, desktop | 61 | 100 | 96 | 100 | 0.8 s | 1.6 s | 630 ms | 0.008 |
| Case study, mobile | 32 | 100 | 96 | 100 | 4.0 s | 6.0 s | 3,540 ms | 0 |
| Featured analysis (Hasdeo), mobile | 31 | 100 | 96 | 100 | 4.2 s | 7.3 s | 10,700 ms* | 0.006 |
| Featured analysis (Hasdeo), desktop | 58 | 100 | 96 | 100 | 0.8 s | 1.7 s | 1,200 ms | 0.051 |

\* single run; the same page measured 7,540 ms an hour earlier — the map's WebGL work under 4× CPU slowdown dominates.

## Before → after (landing page, median of 3 runs)

"Before" is commit `779fe28` (start of this phase), served the same way.

| | Performance | FCP | LCP | Speed Index | TBT | Time to Interactive | JS transferred |
|---|---|---|---|---|---|---|---|
| Mobile, before | 29 | 5.7 s | 7.1 s | 9.8 s | 2,853 ms | 11.5 s | 675 KiB |
| Mobile, after | **33** | **4.0 s** | **6.1 s** | **8.6 s** | **2,573 ms** | **10.2 s** | **462 KiB** |
| Desktop, before | 56 | 1.1 s | 1.7 s | 3.7 s | 721 ms | 2.8 s | 675 KiB |
| Desktop, after | **64** | **0.8 s** | **1.5 s** | **3.2 s** | **543 ms** | **2.5 s** | **462 KiB** |

First-load JavaScript: entry chunk 753 kB → 547 kB (230 → 171 kB gzip); MapLibre (1.05 MB) and ECharts (540 kB) are
no longer downloaded before the first paint.

## What was changed

| Finding | Where | Fix |
|---|---|---|
| Whole MapLibre + ECharts loaded before first paint | `App.tsx`, `vite.config.ts` | Map, analysis view, Ask page, case study and About are `React.lazy`; MapLibre no longer preloaded (Rollup's CommonJS helper had pulled the maplibre chunk into the entry) |
| ECharts evaluated with the analysis view | `components/charts/EChart.tsx` | Loaded by the first chart (`echartsSetup.ts`, dynamic import, still tree-shaken) |
| Idle prefetch of the analysis view raised desktop TBT 721 → 1,623 ms | `App.tsx` | Removed |
| Layout shift **1.18** on phones in the analysis view | `AnalysisView.tsx` (bottom sheet) | `initial={false}`: opens at its height instead of growing from its content height |
| Text contrast 4.35 : 1 (`ink-3`) and 2.39 : 1 (`ink-4`) | `index.css` | `ink-3` #6c7a84 → #808e98, `ink-4` #46525a → #76848e (≥ 4.5 : 1 on base, surface and raised panels) |
| Horizontal scrollers not reachable by keyboard | case-study tables, phone timeline and key figures | `tabIndex=0`, `role="region"`, label |
| `<ul>` containing a non-`<li>`; SVG `role="img"` without a name | `AreaContext.tsx` | `<li>` wrapper; `aria-label` with the peak value |
| `aria-label` on a plain `<div>` | `MetricsStrip.tsx` evidence bar | `role="img"` |
| Phone menu not announced as a dialog, no Escape | `Header.tsx` | `role="dialog"`, `aria-modal`, Escape closes, focus moves to "Close menu" |
| Sheet handle 48 × 6 px, drawer tab 16 × 56 px tap targets | `AnalysisView.tsx` | 48 × 24 px and 24 × 56 px |
| `robots.txt` answered with `index.html` | `public/robots.txt` | Added (`Allow: /`) |

## Mobile layout

Checked with Playwright at 360 × 740, 390 × 844 and 768 × 1024 (touch, DPR 2) on the landing page, the case study,
a featured analysis and the Ask page: **no horizontal page scroll on any of the 12 combinations** (every element
inside the viewport or inside its own scroller). Screenshots were reviewed for the landing page and the analysis view.

## Still open

| Finding | Why it is not fixed here |
|---|---|
| Mobile performance ~30: TBT 2.5–10 s | Dominated by MapLibre's WebGL globe/map start-up (≈14 s of scripting at 4× slowdown). Options: a static image instead of the globe on phones until the user interacts, or delaying map start until after first input. A design decision |
| Best practices 96: console errors | (a) The Hansen tree-cover overlay requests tiles that do not exist in Google's bucket at zoom 2 (404, e.g. `gfc_v1.4/tree_alpha/2/1/0.png`); (b) the analysis view probes for a stored result of the default window and the backend answers 404 when there is none (`/api/analysis-result/hasdeo-arand?baseline=2018&comparison=2025`). Both are expected answers; removing them needs a tile `bounds` decision and an API change (204 instead of 404) |
| axe `nested-interactive` on the timeline | The year labels are `<button tabIndex=-1>` inside the `role="slider"` track. Keyboard users use the slider (arrow keys); the labels are pointer shortcuts. Changing them breaks `frontend/scripts/check-data-integrity.mjs`, which selects `button[data-imagery-status]` |
| Timeline year labels 19 × 16 px | Same controls: the slider itself is the large target (WCAG 2.5.8 "equivalent" exception) |
| axe `label-content-name-mismatch` at 768 px (experimental rule) | Featured cards ("Open featured investigation: …"), region buttons and the logo have names that do not repeat all visible text. Lighthouse does not flag these; worth a pass when the cards are next redesigned |
