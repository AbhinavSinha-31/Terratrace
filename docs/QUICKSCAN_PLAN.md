# Quick scan — land, heat and carbon for any area

Status: approved 2026-10-21, implemented on branch `quickscan` (from `case-study-noida`; never merged into `main` without review).

A light, on-request scan for any searched or drawn area, next to the forest-change analysis. It is not a replacement for
the research pipeline in `analysis/` (custom Random Forest, raster downloads, ~25 min of Earth Engine per run), which
stays the *Research case study* tier.

## Decisions (user, 2026-10-21)

1. **Land cover: Dynamic World** (`GOOGLE/DYNAMICWORLD/V1`). ESA WorldCover v200 (2021) is used only as a cross-check.
2. **Carbon: "above-ground tree biomass carbon (ESA CCI)"** from `ESA/CCI/Above_Ground_Biomass/V6_0`, designed so a
   broader carbon source (e.g. soil organic carbon) can be added later as another component.
3. **Tier 1 is named "Research case study"** (not "verified research": its accuracy is agreement with reference labels).
4. **The quick scan runs behind a "Run quick scan" button**; it is never started automatically.

## Tiers shown in the interface

| Tier | What | Example |
|---|---|---|
| Research case study | Custom classifier, validated pipeline, PDF report; accuracy reported as agreement with reference labels | Noida–Ghaziabad |
| Live analysis | TerraTrace forest-change method with its validity checks | the four featured forests, any area |
| Quick scan | Computed on request from public datasets; **not validated for this area** | any area, on request |

Quick-scan numbers never enter the homepage "Detected change" totals.

## What a quick scan computes

**Land surface temperature (LST).** Landsat 8/9 Collection 2 Level-2 thermal band, with exactly the research pipeline's
per-scene masking (QA_PIXEL cloud/shadow/snow, QA_RADSAT, `ST_QA` ≤ 5 K, `ST_EMIS` ≥ 0.90, scale factors) — imported from
`analysis/terratrace_analysis/landsat.py`, not copied. Per-pixel median of clear scenes for the scan year (all months by
default; a season can be chosen). Fewer than 5 usable scenes → UNAVAILABLE.

**Land cover.** Dynamic World annual composite for the scan year: mean probability per class, top class wins; 10 m
resampled to 30 m by mode for the statistics. Pixels whose top probability is below 0.5 are counted as *low confidence*.
Labelled "Land cover from Dynamic World (Google/WRI), {year}" — never "TerraTrace classification".
Cross-check: share of pixels where the Dynamic World class agrees with ESA WorldCover 2021 (mapped to the same groups).

**Mean LST per class** and a **simple surface UHI** = mean LST of built-up land − mean LST of other land (water excluded),
reported only when built-up land is ≥ 5 % of the land and ≥ 2 km² (and the rest also ≥ 2 km²). Labelled
"simple surface UHI (built − non-built)"; the core-vs-ring method stays in the research tier.

**Above-ground tree biomass carbon (ESA CCI).** `agb` (Mg/ha, oven-dry woody biomass of living trees) × 0.47 (IPCC
default carbon fraction) → t C/ha and total t C, for the latest CCI year (2022), with a range from `agb_sd`. Excludes
roots, dead wood, litter and soil. The result is a list of carbon *components*; soil carbon can be added later as a
second component without changing the others.

## How it runs

- **One grouped Earth Engine request per scan** returns class areas, LST per class, the UHI inputs, carbon sums,
  valid fractions, scene counts and the WorldCover agreement.
- **Cached** in `backend/.cache/quickscan/<aid>-<year>-<season>-<QUICKSCAN_VERSION>.json`. A failure is UNAVAILABLE with
  a public reason and is **not** cached. A method change bumps `QUICKSCAN_VERSION`.
- **Background job** after the user presses *Run quick scan*; one at a time on the analysis workers; its own rate limit.
  Same interactive area limit as the analysis (1,500 km²).
- **Restricted mode** (Earth Engine noncommercial quota exceeded): scans still run, one at a time and more slowly, with a
  longer request deadline and an explicit notice (changed 2026-10-22; see Implementation status).
- **Map layers** (LST, Dynamic World land cover, biomass carbon) are served through the existing `/api/tiles` proxy and
  disk cache; tiles are created lazily on first view. No credentials reach the browser.

## Deployment

The backend imports the research pipeline's Landsat code from `analysis/` (next to `backend/` in the repository, or
`TT_ANALYSIS_DIR`). It needs only `earthengine-api` and the standard library — no numpy, pandas or matplotlib. Without
`analysis/` the quick scan reports itself unavailable; it is never re-implemented in the backend.

## Implementation status

- **Phase A (done):** `backend/app/providers/earth_engine/quickscan.py` (one request), `backend/app/services/quickscan.py`
  (interpretation, cache, jobs, refusals), `GET`/`POST /api/quickscan/{aid}?year=&season=`, rate group `quickscan`
  (`TT_RATE_QUICKSCAN_PER_MIN`, default 6), offline tests `backend/tests/test_quickscan.py`. The pipeline's
  `landsat.collection` was split into `scenes` (date ranges) so both use one scene filter and one `prepare` mask.
  Implementation details: low confidence is the share of 10 m pixels below 0.5; LST per class is area-weighted;
  the carbon range sums the per-pixel standard deviations as if fully correlated (the widest range).

- **Phase B (done):** map layers `GET /api/tiles/{aid}/quickscan/{lst|landcover|carbon}/{year}/{season}/{z}/{x}/{y}`,
  served only for a STORED scan whose section is READY (a tile request never starts a scan), through the shared tile
  cache (key includes the quick-scan method version) and map-ID cache (one build per layer). Tiles are built by the same
  functions as the measurement. Legends: temperature = inferno over the area's own 2nd–98th percentile (not comparable
  between areas, said in the legend); land cover = Dynamic World's class colours at 10 m; carbon = one fixed range,
  0–150 t C/ha, for every area. A READY scan lists its `layers` (tile template, legend, source); not stored on disk.

- **Phase C (done):** "Land, heat & carbon" tab in the analysis drawer (also shown below the status panel when an
  area has no READY forest analysis): year and season pickers, the "Run quick scan" button (the only way a scan
  starts), PROCESSING polling, and per-section values or reasons — land cover with class areas, low-confidence share
  and the WorldCover cross-check; surface temperature with per-class means and the simple UHI; carbon density, total
  and range. Every value shows dataset · year · resolution. One quick-scan map layer at a time (switch in each section
  and in the layer panel), with the backend's legend. Tier badges: "Research case study" (Noida page and card),
  "Live analysis" (forest Overview), "Quick scan · public datasets, not validated for this area" (the tab).

- **Phase D (done):** stored quick scans (latest 3 per area) are offered to the chat as place facts of a third kind,
  "Quick scan from public datasets — not validated for this area, not a TerraTrace classification", each with dataset
  and year. The validator understands °C, t C/ha and t/kt/Mt C, requires a heat-island figure to be stated as warmer
  (positive) or cooler (negative), and withholds a segment when a number supported only by quick-scan facts is
  presented as a TerraTrace classification (`quick_scan_as_terratrace`), a number supported only by Dynamic World
  "Trees" sits in a sentence that calls it forest (`trees_as_forest`), or biomass carbon is called total, ecosystem or
  soil carbon (`carbon_overclaim`; "not including soil carbon" is fine). Prompt `chat-4` states the same rules.
- **Earth Engine quota (2026-10-22):** project terratrace-509821 is in restricted mode — per Google, requests still
  run with reduced concurrency and workers; quotas reset on the 1st of each month at 00:00 Pacific Time.
- **Restricted mode changed (user, 2026-10-22):** quick scans now RUN in restricted mode instead of being refused — one
  at a time on their own single worker (a second request waits, shown as queued), with the Earth Engine request
  deadline raised to `TT_QUICKSCAN_RESTRICTED_DEADLINE_S` (default 900 s) for that one request and restored after (never
  shortened). Restricted mode counts as active for the rest of the quota month once seen (it cannot reset earlier). The
  tab shows "Earth Engine is in its slower restricted mode this month. A quick scan still works but may take several
  minutes. Full speed returns on {1st of next month}." and a restricted-mode estimate (measured restricted scans, else
  5–6× the normal median, else "several minutes"). Rate limit, area limit, caching and no auto-start unchanged.

## Phase 3 (user request, 2026-10-25)

Decisions (user, 2026-10-25): there is no separate PLAN.md, so this request is the spec. The quick scan IS the
"any area" generalisation of the Noida–Ghaziabad work (the custom-RF pipeline stays CLI-only, see urban-live). Carbon
shows **both** ESA CCI (measured, trees) and an **IPCC Tier 1 estimate** (default factors per land-cover class), each
with its own label and source. Accounts, saving and community publishing are **deferred** until after 2026-10-30.

- **Step 1 (done):** every served quick-scan result carries its date window (`source.period`: Dynamic World = the scan
  year; Landsat = the season window, plus the first and last scene used; ESA CCI and WorldCover = their map year) and the
  disclaimer "Agreement, not accuracy: …" (`disclaimer`), shown under every READY section. Both are derived from the
  scan's year and season when served (`services/quickscan.present`), so stored scans show them without a re-run.
  New scans also record the first and last Dynamic World image dates. No number changed, so no method-version bump.
- **Step 2 (proposed, waiting for approval):** IPCC Tier 1 carbon component — see below.

## Backlog (not part of the quick-scan phases; do later)

1. **Integrity script end to end.** `frontend/scripts/check-data-integrity.mjs` stops at the Hasdeo step that waits for a
   "Run live analysis 2018 → 2025" button (Hasdeo opens with its stored 2019→2025 result, so the button never appears —
   pre-existing, reproduced on 50ec485). Make it run to the end, and make it NEVER click a live-analysis button (it
   currently clicks "Run live analysis 1990 → 2025", which starts a real Earth Engine analysis when Earth Engine is
   configured).
2. **Chatbot withheld a numeric answer.** On merged main (2026-10-21) "How much forest change did TerraTrace detect in this
   area?" on Hasdeo Arand was withheld as `unsupported_number`, although the stored READY result has the figures.
   Investigate which number failed validation (model rounding/units vs the facts offered) and propose a fix that keeps
   the guarantee that no unverified number is ever shown.

## Earth Engine use during development

Offline, mocked tests only. When the code is complete, ask the user before any live probe; then run **one** small area
(~50 km²) first and time it.

## Chatbot

May quote, as cited facts with dataset and year: Dynamic World class areas, mean LST (with year, season, scene count),
the simple UHI (with its method name), biomass carbon (as a range, "ESA CCI {year} × 0.47"). May not: call any of these a
TerraTrace classification, state trends between years without two stored scans, make causal claims, or present biomass
carbon as total ecosystem carbon. Dynamic World "trees" must never pass the validator as forest cover.

## Phases

- **A** — backend provider + service, offline tests with mocked Earth Engine.
- **B** — tile kinds for LST, Dynamic World and biomass carbon via `/api/tiles`.
- **C** — frontend "Land, heat & carbon" tab, layers, legends, labels, tier badges, phone layout.
- **D** — chatbot facts and validator tests (°C, km², t C/ha; DW trees ≠ forest cover).

After each phase: typecheck, build and the full backend suite green; commit.

## Risks

Quota (every scan adds EE use); three different tree numbers on one screen (Dynamic World, Hansen, the forest
analysis) — each labelled with its dataset; carbon year (2022) differs from the scan year; CCI biomass is
forest-oriented (urban/cropland values uncertain); cloudy regions may not reach 5 scenes; LST colours use each area's
own range (legend shows the values).

## Sources

- Dynamic World V1 — https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1
- ESA WorldCover v200 — https://developers.google.com/earth-engine/datasets/catalog/ESA_WorldCover_v200
- ESA CCI Above-Ground Biomass v6.0 — https://developers.google.com/earth-engine/datasets/catalog/ESA_CCI_Above_Ground_Biomass_V6_0
- Landsat Collection 2 Level-2 — https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LC08_C02_T1_L2
