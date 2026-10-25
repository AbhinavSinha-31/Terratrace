# TERRATRACE — Forest-Change Intelligence

Select a forest area, explore real satellite imagery from 1984 to today, and run a live
forest-change analysis on Google Earth Engine. Every measurement shown comes from a
completed, validated Earth Engine computation. TERRATRACE never shows simulated, estimated
or placeholder results: when something cannot be measured, the UI says so.

Imagery and analysis are independent:

| | What it is | Source |
|---|---|---|
| **Imagery** | Real satellite imagery for the open area and year (Sentinel-2 SR Harmonized — Earth Engine catalogue from 2017-03-28, a year is shown only where scenes exist — and Landsat Collection 2 before). Imagery only, never a result. | `GET /api/imagery` → Earth Engine |
| **Analysis** | Forest-cover and change measurements for a baseline → comparison window. Runs only when you press **Run**, as a background job with real stages and **Cancel**. | `POST /api/analysis-jobs`, poll `GET /api/analysis-jobs/{job_id}` → Earth Engine |

"Imagery READY, analysis unavailable" is a valid state.

## Requirements

- Python 3 (developed and tested with 3.14) and Node.js 20.19+ or 22.12+ (required by Vite 7)
- A Google Cloud project registered for Earth Engine (noncommercial use is free):
  <https://code.earthengine.google.com/register>

## Configure Earth Engine (backend only)

Credentials stay on the server. They never go into the frontend, the browser or Git.

```powershell
cd backend
copy .env.example .env        # then set EE_PROJECT=<your project id> in backend/.env
```

Then authenticate once, using **one** of these methods:

- **User credentials:** run `earthengine authenticate`.
- **Service account:** set `EE_SERVICE_ACCOUNT_KEY` in `backend/.env` to the path of a key
  file stored outside the repository.

`backend/.env` is git-ignored. Never commit it or any key file.

## Run

Backend (port **8001**):

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8001
```

Check it: <http://127.0.0.1:8001/api/health> should report `"analysis": {"status": "ready"}`
once Earth Engine is configured.

Frontend (port **5173**, proxies `/api` to `127.0.0.1:8001`; set `TT_API_PROXY` to use another backend URL):

```powershell
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

Run each server in its own terminal, from its own folder (`npm` only works inside `frontend/`).
If a port is already taken, an earlier server is probably still running: stop it with Ctrl+C in its
terminal, or find it with `Get-NetTCPConnection -LocalPort 8001 -State Listen`.

Single-port mode: run `npm run build` in `frontend/`. The backend then serves `frontend/dist`
at <http://127.0.0.1:8001>.

Without a reachable backend the UI still opens. Featured areas and search keep working,
but imagery and analysis show as unavailable, and nothing is substituted.

## Deploy

**Before going public, resolve every open item in [docs/PRE_DEPLOYMENT.md](docs/PRE_DEPLOYMENT.md).**

The frontend is a static build and runs on Vercel (`vercel.json` at the repo root builds `frontend/`
and publishes `frontend/dist`; `.vercelignore` keeps `backend/` and every secret out of the upload).

The backend does **not** fit serverless functions: analysis jobs run for minutes in background
threads and are polled from in-memory state, registered areas and results live in `backend/.cache`,
and rate limits are per process. Host it as **one** long-running process with a persistent disk.
Hosting options are compared in [docs/PRODUCTION_PLAN.md](docs/PRODUCTION_PLAN.md#backend-hosting--options).

The repository-root `Dockerfile` builds the backend image (it includes the two parts of `analysis/` the
quick scan imports):

```sh
docker build -t terratrace-backend .
docker run -p 8000:8000 -v terratrace-cache:/data --env-file backend/.env terratrace-backend
```

- **Start command** (the image's default): `uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1
  --proxy-headers --forwarded-allow-ips=${TT_FORWARDED_ALLOW_IPS:-*}`. `--proxy-headers` makes rate limits apply
  per real client instead of per proxy; `*` is safe only when the container is reachable solely through the
  platform's proxy.
- **Health checks:** `GET /api/health/live` (liveness: no Earth Engine call, 503 if the cache is not writable);
  `GET /api/health` reports Earth Engine, chat and limits and can take several seconds.
- **Storage:** mount the persistent volume at `TT_CACHE_DIR` (`/data` in the image). Tiles go to
  `TT_TILE_CACHE_DIR` (default `$TT_CACHE_DIR/tiles`, disposable). The image runs as a non-root user (uid 10001):
  if the platform mounts the volume owned by root, `/api/health/live` answers 503 — fix the volume's ownership
  (or the platform's run-as-uid setting) before going live.

On the host,
Earth Engine needs a service account (`EE_PROJECT` + `EE_SERVICE_ACCOUNT_KEY` = path to the key
file, uploaded as a secret file), since `earthengine authenticate` user credentials do not exist there.

| Where | Variable | Value |
| --- | --- | --- |
| Vercel | `VITE_API_BASE` | backend public URL ending in `/api` (public; baked into the bundle) |
| Backend | `TT_CORS_ORIGINS` | your Vercel production origin, e.g. `https://<project>.vercel.app` |
| Backend | `TT_CACHE_DIR`, `TT_TILE_CACHE_DIR` | persistent volume path (image default `/data`); optional separate tile path |
| Backend | `TT_FORWARDED_ALLOW_IPS` | proxy address trusted for `X-Forwarded-For` (default `*`) |
| Backend | `EE_PROJECT`, `EE_SERVICE_ACCOUNT_KEY` | Earth Engine (secret) |
| Backend | `ANTHROPIC_API_KEY` | optional AI briefings (secret) |
| Backend | `TT_CHAT_ENABLED`, `GEMINI_API_KEY`, `TT_LLM_MODEL`, `TT_LLM_TIER` | optional AI chat, off by default; the key is a secret. `TT_LLM_TIER` = `free` (default) or `paid` (key from a billed project) sets the notice shown with the chat. Read docs/PRE_DEPLOYMENT.md items 4–7 first |

## Method (tt-ee-2.1)

- **Data.** `COPERNICUS/S2_SR_HARMONIZED` masked with Cloud Score+ (`cs_cdf ≥ 0.60`, scenes without
  Cloud Score+ excluded) and `GOOGLE/DYNAMICWORLD/V1` (*trees* probability, 0–1). Each year is a
  calendar-year composite (1 Jan – 31 Dec). A year without scenes is reported unavailable, never
  composited.
- **Area limit.** Every area — featured or drawn — is checked against the 1,500 km² interactive
  limit before anything else. A larger area returns `analysis_too_large` with the selected and maximum
  area. No stored result is served and no Earth Engine work runs.
- **Window.** The live analysis measures every year of the requested window (default 2018 → 2025).
  Years before the window come from a separate history request. They are shown in the Time Machine
  and charts only, and never change the window's result.
- **Forest.** A pixel (statistics at 30 m) is forest in a year when its Dynamic World mean *trees* probability is
  ≥ 0.50 **and** its leaf-on Sentinel-2 NDVI is ≥ 0.60. Leaf-on NDVI is the per-pixel 90th
  percentile of the year's clear NDVI observations. Pixels with fewer than 3 clear
  Sentinel-2 or 3 Dynamic World observations stay **unobserved**, never "non-forest".
- **Change.** Loss or gain is the change in forest state between two consecutive analysable years,
  counted only over pixels observed in both years. Unobserved → forest is never gain, and
  unobserved → non-forest is never loss.
- **Status.**
  - A year with < 80 % observed coverage is not analysable. Transitions skip it explicitly.
  - Fewer than two analysable years in the window gives **UNAVAILABLE**.
  - An in-window transition that fails a physical check gives **INVALID_ANALYSIS**. One such check
    is gain ≤ 5 % of the compared area per year. The compared area is the set of pixels observed in
    both years. The failed check is shown with its measured value.
  - Otherwise the result is **READY**. Measurements are shown only for READY.

**Why leaf-on NDVI (change from tt-ee-2.0).** Version 2.0 applied the NDVI floor to the
annual-median NDVI. In deciduous forest that median mixes leaf-off dry-season scenes. Whether a
pixel passed then depended on each year's seasonal sampling, not on forest cover. The evidence,
comparing annual-median NDVI (old) with leaf-on NDVI (new), same thresholds:

| Site (2018–2025) | Old method | Leaf-on NDVI |
|---|---|---|
| Kanha core, protected sal forest (stable control) | 30.7 % gain in 2019→20; 27 % loss in 2018→19 | 5.4 %; 2.6 % |
| Jaú interior, Amazon evergreen (stable control) | < 1 % per year | < 1 % per year |
| Rondônia subset, clearing in patches ≥ 2 ha | 39 / 80 / 27 / 49 / 25 ha | 37 / 82 / 24 / 46 / 23 ha |

About 90 % of the old implausible gains came from pixels that were already Dynamic World trees
and only crossed the NDVI floor. Real clearing is still detected. The thresholds (trees ≥ 0.50,
NDVI ≥ 0.60, gain ≤ 5 %/yr, ≥ 3 observations, ≥ 80 % coverage) are unchanged, and results from
2.0 are never reused.

A two-year persistence rule was also tested and not adopted:

- It cannot confirm the latest year.
- It shifts the timing of change.
- It still failed Hasdeo 2019→2020 (9.8 %).

**Remaining limitation.** Dynamic World's *trees* probability itself varies between years in
deciduous forest. Hasdeo Arand (2018→19 7.0 %, 2019→20 8.2 %) and the Kanha control (2019→20
5.4 %) therefore still fail the 5 % check. They are reported as INVALID_ANALYSIS, and no
measurements are shown.

## Earth Engine quota (noncommercial / Restricted Mode)

A noncommercial project that exceeds its compute quota enters **Restricted Mode**. Earth
Engine then limits concurrency and answers some tile requests with `429 RESOURCE_EXHAUSTED`.
TERRATRACE handles this without bypassing the quota:

- At most 3 Earth Engine tile requests are in flight at once.
- Tiles outside the study area are never requested.
- Tiles the map no longer needs are cancelled.
- A throttled tile is retried once, then skipped. The rest of the layer stays on the map, with
  the notice *"Satellite imagery is temporarily throttled. Retrying…"*.
- Analyses larger than the interactive limit (`TT_INTERACTIVE_MAX_KM2`, default 1,500 km²)
  are refused before any computation.

## Tests

```powershell
# from the repository root
cd backend;  .venv\Scripts\python -m pytest -q; cd ..   # offline: Earth Engine is replaced by fakes
cd frontend; npm run typecheck; npm run build; cd ..
cd frontend; npm run test:integrity; cd ..              # end-to-end; needs the dev server + backend running
```

The integrity suite never starts a live Earth Engine analysis.

## LULC + urban heat island case study (`analysis/`)

A standalone, reproducible research pipeline. It is separate from the web app: it has its own virtual environment
and does not import backend code. It classifies land use / land cover (Random Forest in Earth Engine) and measures
Landsat land surface temperature and urban heat island intensity for a configurable city. The default city is
Noida + Greater Noida + Ghaziabad. Every choice of method is in [analysis/config.toml](analysis/config.toml), and the
method is described in [analysis/README.md](analysis/README.md).

```powershell
cd analysis
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env                      # set EE_PROJECT=<your Earth Engine project>; uses `earthengine authenticate`
.venv\Scripts\python -m pytest tests -q     # offline tests, no Earth Engine
.venv\Scripts\python run_pipeline.py        # everything, all years (Earth Engine steps take ~20 min per year)
.venv\Scripts\python run_pipeline.py --years 2015 2025              # selected years only
.venv\Scripts\python run_pipeline.py --steps stats figures report   # re-run the local steps only (seconds)
```

Results go to `analysis/outputs/`:

- `maps/`, `charts/`: PNG files at 300 dpi.
- `tables/`: CSV files.
- `validation/`: KML files for manual checking.
- `results_summary.md`: key numbers as sentences, with every flagged issue.

Earth Engine results are cached in `analysis/outputs/cache/` (git-ignored), so later runs skip them unless you pass `--force`.

## Layout

```
backend/app/api/routes.py                 HTTP API (/api/…)
backend/app/services/analysis.py          analysis orchestration, method-versioned result cache
backend/app/services/imagery.py           imagery decisions, availability, basemap config (all imagery URLs)
backend/app/services/science.py           scientific thresholds and validity rules (docs/METHOD.md)
backend/app/providers/earth_engine/       the Earth Engine pipeline
frontend/src/state/store.ts               canonical InvestigationState
frontend/src/data/                        API client, analysis runner, imagery sync
frontend/src/features/map/                MapLibre map; eeTiles.ts = bounded Earth Engine tile loader
```

The method, thresholds and validity rules are documented in [docs/METHOD.md](docs/METHOD.md).

## Credits & licences

- Copernicus Sentinel-2 data (via Google Earth Engine); USGS Landsat Collection 2;
  Google Dynamic World V1; Hansen et al. Global Forest Change (CC BY 4.0).
- Globe basemap: Sentinel-2 cloudless 2025 © EOX IT Services GmbH, s2maps.eu
  (CC BY-NC-SA 4.0; contains modified Copernicus Sentinel data). A static basemap,
  not live imagery.
- High-resolution imagery and labels © Esri, Maxar, Earthstar Geographics.
- MapLibre GL JS, Apache ECharts, React, Tailwind CSS.
