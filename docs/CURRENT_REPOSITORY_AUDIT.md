# TERRATRACE — current repository audit

Audited 2026-09-27 (Phase 1 of the clean reimplementation). **Nothing has been deleted or changed by this audit.**

## 0. Checkpoint

- **Git is not installed** on this machine and the folder is not a Git repository, so the requested
  checkpoint commit `terratrace-before-clean-reimplementation` could not be created.
- Instead, a full checkpoint archive of the working tree was created **outside** the repository:
  `C:\Users\HP\OneDrive\Documents\TERRATRACE-checkpoints\terratrace-before-clean-reimplementation-20260927-141209.zip`
  (185 entries). Excluded: regenerable `node_modules/`, `.venv/`, `dist/`, `__pycache__/`, `.pytest_cache/`,
  and `backend/.env` (local configuration). Included: all source, docs, tests, and `backend/.cache/`
  (registered AOIs and method-versioned analysis results).
- Recommendation: install Git and `git init` before Phase 3, so each cleanup step is a reviewable commit.

## 1. Directory tree (relevant files; generated folders summarised)

```
.gitignore                     README.md (stale — see §9)
docs/
  METHOD.md                    scientific method tt-ee-2.0
  CURRENT_REPOSITORY_AUDIT.md  this file
backend/
  .env (git-ignored, EE_PROJECT only)   .env.example   requirements.txt
  app/
    __init__.py  config.py  errors.py  main.py  schemas.py  ee_check.py
    api/routes.py
    data/featured_investigations.json         4 study AOIs (geometry only)
    providers/registry.py                      reads the study JSON
    providers/earth_engine/provider.py         689 lines — ALL Earth Engine work
    providers/reference/hansen.py              Hansen tile sampling for AOI preview
    providers/ai/claude.py                     LLM client (explanations)
    services/analysis.py                       orchestration, envelopes, cache, progress
    services/science.py                        thresholds, eras, validity rules, KPIs
    services/geometry.py                       AOI validation + geodesic area
    services/search.py                         Nominatim + gazetteer
    services/explanation/service.py            fact-grounded briefing (LLM or deterministic)
  scripts/ ee_profile.py  ee_diagnose.py  ee_ab_parallel.py   (developer diagnostics)
  tests/   7 files, 82 tests (+2 opt-in live EE tests)
  .cache/  aois/ (8)  results/ (12)  hansen/ (50 tiles)       (git-ignored, generated)
frontend/
  index.html  package.json  package-lock.json  tsconfig.json  vite.config.ts
  public/ favicon.svg  data/featured.json (copy of the study JSON for offline UI)
  scripts/ check-data-integrity.mjs  check-map-markers.mjs     (Playwright e2e)
  src/
    main.tsx  index.css  vite-env.d.ts
    app/        App.tsx  ErrorBoundary.tsx
    data/       client.ts  contracts.ts  queries.ts
    state/      store.ts
    lib/        format geo palette regions solar time urlState useLayout windowStats
    design/     Badge Button Controls Logo Metric Modal Popover States Surface Tooltip index
    components/charts/  EChart ForestCoverChart SignalChart YearlyLossChart
    explain/    facts.ts  narrative.ts
    features/analysis/  AnalysisView AnalyzingOverlay Briefing EventInspector EventList
                        LayerPanel MetricsStrip Overview ReportModal TimeMachine Unavailable
    features/explore/   Landing SearchBar SelectionPanel
    features/map/       TerraMap AoiDrawer MapCanvas MapStage registry
    features/presentation/Presenter.tsx
    features/shell/     Header AboutModal BootSplash
  dist/ (build output, git-ignored)   node_modules/
ml/  .venv only (Kaggle CLI; no data, no code)
```

## 2. Architecture as it exists today

### Frontend
React 19 + TypeScript + Vite + Tailwind v4; MapLibre GL (globe) via an imperative `TerraMap` class;
ECharts; TanStack Query; zustand. One app shell (`App.tsx`) switches views `explore | analysis | timemachine`.

### Backend
FastAPI (`main.py`, `api/routes.py`) → `services/analysis.py` (orchestration) → `providers/earth_engine/provider.py`
(all Earth Engine) with rules in `services/science.py`. Public error contract in `errors.py`.

### Earth Engine pipeline (tt-ee-2.0)
One `provider.analyze()` call per (AOI, baseline, comparison), **always computing all 17 composite years**
(1984…2015 Landsat epochs + 2016…2025 Sentinel-2/Dynamic World) regardless of the requested window, in
4 synchronous requests: scene counts → coverage → statistics → change events. No `getInfo` inside loops.

### API endpoints and consumers

| Endpoint | Frontend consumer | Status |
|---|---|---|
| GET /api/health | Header, SelectionPanel, About | used |
| GET /api/study-areas | Landing, SearchBar, map markers | used |
| GET /api/analysis/{id} | useAnalysis (queries.ts) | used |
| GET /api/analysis/{id}/events · /stats · /layers | **none** (tests only) | dead in product |
| GET /api/progress/{rid} | AnalyzingOverlay | used |
| POST /api/analyze | CustomAnalysisRunner | used |
| POST /api/aoi/preview | SelectionPanel (Hansen reference %, area) | used |
| POST /api/explain | Briefing | used |
| GET /api/search | SearchBar | used |
| GET /api/tiles/{id}/{kind}/{year}/… | TerraMap (URLs come from READY layer catalog) | used |

### State management — **5 kinds of state sources today**
1. zustand `state/store.ts` (view, aoiId, window, pendingWindow, year, layers, selection, activeRid …)
2. zustand `features/map/registry.ts` (map instances, drawer, view, pointer — map plumbing, not investigation)
3. URL hash `lib/urlState.ts` (view, aoiId, from/to, year) — synchronised with (1)
4. TanStack Query caches: `['analysis', id, start, end]`, `['progress', rid]`, `['preview', geometry]`,
   `['explanation', eventId]`, `['health']`, `['study-areas']`
5. Component-local state that holds investigation data: **SelectionPanel's own baseline/comparison years**
   (not the store window), TimeMachine drag preview, SearchBar query.
No localStorage/sessionStorage/IndexedDB is used.

### Imagery providers — **7 imagery paths today**
| Path | Where | Notes |
|---|---|---|
| EOX Sentinel-2 cloudless per year (2016–2025) | TerraMap (frontend-built URL) | real imagery, not AOI-validated |
| EOX 2025 base layer | TerraMap | globe basemap |
| EOX thumbnails | Landing cards (frontend-built URL) | |
| EOX before/after tiles | ReportModal (frontend-built URL) | |
| Esri World Imagery (hi-res, undated) | TerraMap | |
| Hansen tree-cover tiles | TerraMap (globe layer) + backend `hansen.py` (preview %) | reference |
| Earth Engine composites via /api/tiles | backend provider, READY results only | the only AOI-validated imagery |

**The frontend constructs imagery URLs itself in three places** (violates Phase 8).
There is **no imagery-availability service**: per-year availability is only known *after* a full analysis
(from `quality.years`), so the Time Machine cannot show availability before an analysis exists.

### Analysis providers
- ONE Earth Engine analysis path (`provider.analyze`), plus a **diagnostic switch set** (`diag=`) and a
  **parallel-request path** (`workers>1`, unverified, default off) inside the same function.
- **Scientific calculations also exist in the frontend**: `lib/windowStats.ts` (window KPIs) and
  `explain/narrative.ts` (a second deterministic briefing generator, duplicating the backend's).

### Demo / mock / simulation paths (Phase 3 search)
- **Production simulation code: none.** (The old demo provider, generator and simulated data were removed earlier;
  `test_no_simulation_code_or_data_in_repository` guards this.)
- `?simulate=error|slow` failure injection remains in `data/client.ts` (production code; produces no data,
  but is a test hook in shipped code) → REFACTOR (dev-only) or DELETE.
- `Math.random` only in `newRid()` request-id fallback (not scientific) → KEEP.
- "fake"/"Fake" only in backend tests (fake `ee` modules) → KEEP (test fixtures).
- Public UI copy uses the word "simulated" in policy statements ("does not display … simulated …") →
  REFACTOR wording so a Phase 37 text scan stays clean.
- **README.md still documents the deleted demo generator**, `server/`, `VITE_DATA_SOURCE=demo|api`,
  `?simulate=empty` → REWRITE.

### Tests
backend: `test_api`, `test_coordinates`, `test_ee_check`, `test_ee_empty_collections`, `test_ee_readiness`,
`test_public_errors`, `test_scientific_validity` (82 pass; 2 live-EE tests opt-in).
frontend: no unit-test runner; Playwright e2e `check-data-integrity.mjs` (126/119 checks in live/unconfigured),
`check-map-markers.mjs`.

### Configuration
`backend/config.py` (env: EE_PROJECT, EE_SERVICE_ACCOUNT_KEY, EE_TIMEOUT_S, TT_INTERACTIVE_MAX_KM2,
EE_PARALLEL_REQUESTS, DEV_DIAGNOSTICS, ANTHROPIC_*, TT_GEOCODER …), `.env.example`, `vite.config.ts` (dev proxy),
`vite-env.d.ts` (VITE_API_BASE only).

### Generated / build files (never hand-edited)
`frontend/dist/`, `backend/.cache/`, `__pycache__/`, `.pytest_cache/`, `node_modules/`, `.venv/` — all git-ignored.

## 3. Per-file classification

KEEP = correct, stays · REFACTOR = stays but must change for the canonical architecture ·
MERGE = fold into another file · ARCHIVE = move out of the product path · DELETE = remove (after dependency proof).

### Backend
| File | Class | Reason |
|---|---|---|
| app/config.py | REFACTOR | drop `ee_parallel_requests` if the parallel path is not adopted; add pipeline/dataset config hash |
| app/errors.py | KEEP | canonical public error contract (extend to the Phase 27 status set) |
| app/main.py | KEEP | |
| app/schemas.py | REFACTOR | rebuild as the canonical AnalysisRequest / AnalysisResult / Imagery contracts |
| app/ee_check.py | KEEP | read-only credential/dataset verifier |
| app/api/routes.py | REFACTOR | reduce to the Phase 26 endpoint set; drop dead subset routes |
| app/data/featured_investigations.json | KEEP | canonical study definitions (add `country`/`bounds` already present) |
| app/providers/registry.py | KEEP | |
| app/providers/earth_engine/provider.py | REFACTOR | split into imagery service + analysis service; remove `diag` switches; 2-period vertical slice |
| app/providers/reference/hansen.py | REFACTOR | becomes the Hansen *reference* service (isolated) |
| app/providers/ai/claude.py | KEEP | |
| app/services/analysis.py | REFACTOR | requestId-based lifecycle (POST → GET by requestId), cache key incl. config hash |
| app/services/science.py | REFACTOR | keep rules; change rule needs your decision (see §6) |
| app/services/geometry.py | KEEP | canonical area/AOI validation |
| app/services/search.py | KEEP | |
| app/services/explanation/service.py | KEEP | only explainer (gate on COMPLETE+VALID) |
| scripts/ee_profile.py, ee_diagnose.py, ee_ab_parallel.py | ARCHIVE | developer diagnostics → `backend/scripts/dev/` (depend on `diag`/`workers`) |
| tests/* | KEEP / REFACTOR | keep; update with the new contracts |
| .env.example, requirements.txt | KEEP | |

### Frontend
| File | Class | Reason |
|---|---|---|
| index.html, vite.config.ts, tsconfig.json, package*.json, public/favicon.svg | KEEP | |
| public/data/featured.json | MERGE | duplicate of the backend study JSON (offline UI); decide: keep synced copy or drop offline mode |
| src/main.tsx, index.css, vite-env.d.ts | KEEP | visual identity lives in index.css |
| app/App.tsx | REFACTOR | mount the canonical investigation flow |
| app/ErrorBoundary.tsx | KEEP | |
| data/client.ts | REFACTOR | single API client; remove `?simulate=`, offline preview fallback decisions |
| data/contracts.ts | REFACTOR | rebuild to the new API contract |
| data/queries.ts | REFACTOR | requestId-bound analysis state; drop `useReadyResults` cache scan |
| state/store.ts | REFACTOR | becomes the ONE InvestigationState |
| design/* (11 files) | KEEP | design system |
| components/charts/* | KEEP (REFACTOR inputs) | render backend values only |
| explain/facts.ts | KEEP | builds facts for the backend explainer |
| explain/narrative.ts | DELETE (after refactor) | duplicate deterministic briefing; ReportModal should use the backend explanation |
| lib/windowStats.ts | DELETE (after refactor) | scientific KPIs computed in the frontend; backend must return them |
| lib/time.ts | REFACTOR | year availability must come from the backend imagery-availability endpoint |
| lib/urlState.ts | REFACTOR | synchronise with InvestigationState only |
| lib/geo.ts | REFACTOR | client-side area is display-only pre-validation; authoritative area from backend |
| lib/format, palette, regions, solar, useLayout | KEEP | |
| features/analysis/AnalysisView.tsx | REFACTOR | study/year selectors + states per Phase 28 |
| features/analysis/AnalyzingOverlay.tsx | KEEP (REFACTOR stages) | real-stage progress already; align stage names to Phase 23 |
| features/analysis/Briefing.tsx, EventInspector.tsx, EventList.tsx | KEEP (REFACTOR contract) | |
| features/analysis/LayerPanel.tsx, MetricsStrip.tsx, Overview.tsx | REFACTOR | consume backend metrics only |
| features/analysis/ReportModal.tsx | REFACTOR | builds EOX URLs itself; uses frontend narrative |
| features/analysis/TimeMachine.tsx | REFACTOR | per-year availability from backend; disabled unavailable years |
| features/analysis/Unavailable.tsx | KEEP (REFACTOR states) | maps to the Phase 19/27 statuses |
| features/explore/Landing.tsx | REFACTOR | study selection; EOX thumbnails built in frontend |
| features/explore/SearchBar.tsx | KEEP | |
| features/explore/SelectionPanel.tsx | REFACTOR | holds its own baseline/comparison state |
| features/map/TerraMap.ts | REFACTOR | imagery layers from the backend imagery contract only |
| features/map/MapCanvas.tsx, MapStage.tsx | REFACTOR | |
| features/map/AoiDrawer.ts, registry.ts | KEEP | map plumbing |
| features/presentation/Presenter.tsx | ARCHIVE | guided tour; not part of the canonical flow |
| features/shell/Header.tsx, AboutModal.tsx, BootSplash.tsx | KEEP | |
| scripts/check-data-integrity.mjs, check-map-markers.mjs | KEEP (REFACTOR) | e2e tests |

### Repository / docs
| File | Class | Reason |
|---|---|---|
| README.md | REFACTOR (rewrite) | describes deleted demo architecture |
| docs/METHOD.md | MERGE → docs/METHODOLOGY.md | |
| ml/ (.venv only) | DELETE | Kaggle environment, no code or data; not part of TERRATRACE |

## 4. Duplicate implementations (Phase 2 summary)

| Concern | Current implementations | Recommendation |
|---|---|---|
| Study AOIs | backend `featured_investigations.json` + frontend `public/data/featured.json` | one source (backend); frontend copy only if offline mode is kept |
| AOI area | backend `geometry.py` + frontend `lib/geo.ts` | backend authoritative |
| Year lists / eras | backend `science.py` + frontend `lib/time.ts` | backend availability endpoint |
| Imagery | 7 paths (§2) | one backend imagery service; frontend consumes URLs |
| Hansen | frontend globe tiles + backend preview sampling | one reference service, clearly labelled |
| Window KPIs / statistics | backend `kpis_for` + frontend `windowStats.ts` | backend only |
| Deterministic briefing | backend `offline_briefing` + frontend `narrative.ts` | backend only |
| Analysis execution | `provider.analyze` + `diag` switches + parallel path inside it | one path; diagnostics outside product code |
| Baseline/comparison state | store `window` + `pendingWindow` + SelectionPanel local state + URL | one InvestigationState |

## 5. Root causes of the reported symptoms (evidence from this session)

1. **"33 %" hang / timeouts** — the Earth Engine project is in **noncommercial restricted mode (compute quota
   exceeded)**; under throttling the 4 requests took 5 + 15 + 41 + 72 s. Aggravated by the pipeline computing
   all 17 years for every request and (before today's fixes) by duplicate/orphaned runs.
2. **Validation messages about 1990→1995, 2019→2020, 2021→2022 while 2018→2025 is selected** — these belong to the
   *current* request, but the pipeline validates all 17 composite years (historical + modern transitions)
   regardless of the requested window, and the UI shows every issue. Root cause: analysis scope ≠ requested window.
3. **Dark map** — for years before 2016 there is no EOX mosaic and no READY analysis layer, so the map shows no
   imagery by design (labelled); Earth Engine composite tiles are transparent where pixels are masked. The
   "white" case has not been reproduced yet — to be traced in Phase 9, not guessed.
4. **Stale / competing state** — baseline/comparison live in several places (§2, state sources).

## 6. Decisions needed from you before Phase 4+

1. **Change rule.** Current (tt-ee-2.0): `forest(t0) ∧ ¬forest(t1) ∧ [ΔNDVI ≤ −0.20 ∨ ΔNBR ≤ −0.25] ∧ Δtrees ≤ −0.30`.
   Your Phase 16 rule: `forestBefore ∧ ¬forestAfter ∧ NDVI decrease ∧ NBR decrease` (AND, no tree-probability term).
   These are different scientific definitions — which one, and with which thresholds?
2. **Scope of an analysis.** Proposed: an analysis computes **only the baseline and comparison periods**
   (2 composites instead of 17) — this is the main performance fix and removes out-of-window validation messages.
   The long 1984→present history becomes a separate, availability-first imagery feature.
3. **Offline UI mode.** Keep a no-backend UI (requires the duplicated study JSON) or require the backend?
4. **Earth Engine quota.** End-to-end tests (Phases 12, 32, 39) need real computation; the project is in
   restricted mode. Wait for the quota reset, or request a higher noncommercial tier.
5. **Git.** Install Git so the cleanup can proceed as reviewable commits.

## 7. Proposed cleanup list (nothing deleted yet)

DELETE (after the canonical replacement exists and a dependency check proves no consumers):
- `frontend/src/lib/windowStats.ts`, `frontend/src/explain/narrative.ts`
- `GET /api/analysis/{id}/events`, `/stats`, `/layers` routes (no product consumers)
- `?simulate=` injection in `data/client.ts`
- `ml/` (Kaggle `.venv` only)
- `provider.analyze` `diag=` switches and (unless adopted after an A/B under normal quota) the `workers` parallel path

ARCHIVE:
- `backend/scripts/ee_profile.py`, `ee_diagnose.py`, `ee_ab_parallel.py` → `backend/scripts/dev/`
- `frontend/src/features/presentation/Presenter.tsx`

REWRITE / MERGE:
- `README.md` (rewrite), `docs/METHOD.md` → `docs/METHODOLOGY.md`, add `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`
