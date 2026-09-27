# TERRATRACE — Forest-Change Intelligence

Select a forest area, explore real satellite imagery from 1984 to today, and run a live
forest-change analysis on Google Earth Engine. Every measurement shown comes from a
completed, validated Earth Engine computation. TERRATRACE never shows simulated, estimated
or placeholder results: when something cannot be measured, the UI says so.

Imagery and analysis are independent:

| | What it is | Source |
|---|---|---|
| **Imagery** | Real satellite imagery for the open area and year (Sentinel-2 SR Harmonized from 2016, Landsat Collection 2 before). Imagery only, never a result. | `GET /api/imagery` → Earth Engine |
| **Analysis** | Forest-cover and change measurements for a baseline → comparison window. Runs only when you press **Run**. | `GET /api/analysis/{id}` → Earth Engine |

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

Backend (port **8000**):

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

Check it: <http://127.0.0.1:8000/api/health> should report `"analysis": {"status": "ready"}`
once Earth Engine is configured.

Frontend (port **5173**, proxies `/api` to `127.0.0.1:8000`):

```powershell
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

Single-port mode: run `npm run build` in `frontend/`. The backend then serves `frontend/dist`
at <http://127.0.0.1:8000>.

Without a reachable backend the UI still opens. Featured areas and search keep working,
but imagery and analysis show as unavailable, and nothing is substituted.

## Earth Engine quota (noncommercial / Restricted Mode)

A noncommercial project that exceeds its compute quota enters **Restricted Mode**. Earth
Engine then limits concurrency and answers some tile requests with `429 RESOURCE_EXHAUSTED`.
TERRATRACE handles this without bypassing the quota:

- At most 4 Earth Engine tile requests are in flight at once.
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
