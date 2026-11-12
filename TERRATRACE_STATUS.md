# TERRATRACE — Operational Status

**As of:** 2026-10-01 · method `tt-ee-2.1` · git HEAD `2d049a4` + 42 uncommitted files
Full evidence: `TERRATRACE_PROJECT_AUDIT.md` · Architecture: `TERRATRACE_ARCHITECTURE.md`

## Startup

Two terminals, each in its own folder:

```powershell
# Terminal 1 — backend (FastAPI + Earth Engine)
cd "C:\Users\HP\OneDrive\Documents\TERRATRACE 🌍\backend"
.venv\Scripts\python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8001

# Terminal 2 — frontend (Vite)
cd "C:\Users\HP\OneDrive\Documents\TERRATRACE 🌍\frontend"
npm run dev
```

| Service | URL |
|---|---|
| App | http://localhost:5173 (also http://127.0.0.1:5173) |
| Backend health | http://127.0.0.1:8001/api/health |
| API docs | http://127.0.0.1:8001/docs |

The frontend reaches the backend through the Vite proxy (`/api` → `http://127.0.0.1:8001`; override with `TT_API_PROXY`).
Stop servers with Ctrl+C. A busy port means an old server is still running: `Get-NetTCPConnection -LocalPort 8001 -State Listen`.

## What works (verified 2026-10-01)

- Backend health: Earth Engine **ready** (project `terratrace-509821`, user credentials).
- Fresh live analysis end to end: 31 km² Amazon area → **READY in 66.6 s** with real stages.
- Validity gating: unstable results → **INVALID_ANALYSIS** with the measured value; oversized areas → **UNAVAILABLE** (`analysis_too_large`).
- Job create / poll / cancel / cache reuse.
- Real imagery per year + Earth Engine tiles; per-year imagery availability timeline; history endpoint.
- Search (gazetteer + OpenStreetMap), AOI preview (Hansen 2000 reference).
- Deterministic event briefing (template).
- Tests: backend **166 passed, 2 skipped**; live EE tests **2 passed**; frontend typecheck, production build, `test:markers` (4/4), `test:integrity` (all passed).
- No simulated, demo or placeholder data on any active path.

## What does not work

- 🔴 `/api/tiles/{aoi}/change/{year}` after a backend restart returns the **forest** layer instead of the change layer. Not used by the UI (change is drawn as polygons).

## Partially working

- 🟠 **Featured investigations:** only **Silent Valley** is READY. Rondônia (1,773 km²) and Similipal (1,823 km²) exceed the 1,500 km² limit; Hasdeo Arand is INVALID (unstable forest mask).
- 🟠 **Deforestation frontiers:** often rejected by the 5 %/yr gain-stability rule (fresh Rondônia 31 km² test → INVALID).
- 🟠 **"Total loss" KPI** sums year-to-year transitions, so classification flicker counts as loss (Silent Valley: 4,530 ha "loss", net **+1,053 ha**).
- 🟠 **Historical 1984–2015:** 7 Landsat snapshots with an NDVI-only proxy; unstable; period "level" ignores gain.
- 🟠 **AI summary:** template only — no `ANTHROPIC_API_KEY`, Claude path inactive.

## Unverified

- Claude briefing; service-account auth; live job timeout and 429 throttling paths; `EE_PARALLEL_REQUESTS > 1`; READY-result UI rendering (no automated assertion); printable event brief; single-port mode.

## Facts to state correctly

- **Models:** no model was trained by the team. Pretrained: Google **Dynamic World V1** and **Cloud Score+** (outputs read from Earth Engine). Everything else is rule-based or statistical.
- **Time range:** change detection uses annual composites **2016/2017 onward** (default 2018–2025). 1984–2015 = seven Landsat snapshots for context.
- **Database:** none — JSON file cache in `backend/.cache/`.

## Critical blockers

1. 42 uncommitted files, including `backend/tests/test_jobs.py` (38 tests) and `conftest.py`.
2. 3 of 4 featured investigations cannot show results.
3. Headline loss figures are hard to defend without explanation (gross flicker).

## Next actions

| Priority | Action |
|---|---|
| P0 | Commit the working tree |
| P0 | Shrink Rondônia/Similipal below 1,500 km² or present them as imagery-only |
| P0 | Present net change / event area as the headline, or label total loss as gross transitions |
| P1 | Flag the 60-event cap; fix or remove the `change` tile rebuild |
| P1 | Update `docs/METHOD.md` (still says tt-ee-2.0) and `.env.example` |
| P1 | Basic accuracy comparison against Hansen over several areas |
| P2 | Authentication + rate limiting before any deployment; CI; lint |
