# TERRATRACE

**Explainable satellite intelligence for forest change, land cover and urban heat — anywhere on Earth.**

TERRATRACE turns public Earth-observation archives into transparent, reproducible measurements: forest loss and gain,
land use / land cover (LULC), land surface temperature (LST) and the surface urban heat island (UHI), and an estimate
of above-ground carbon. Every figure comes from a completed Google Earth Engine computation, carries its dataset, date
window and resolution, and passes explicit validity checks. **Nothing is simulated or filled in:** when a value cannot
be measured, TERRATRACE says why instead of showing a placeholder.

---

## Contents

[Features](#features) · [Architecture](#architecture) · [Methods](#methods) · [Data sources](#data-sources) ·
[Limitations](#limitations) · [Research in progress](#research-in-progress) · [Getting started](#getting-started) ·
[Tests](#tests) · [Deployment](#deployment) · [Roadmap](#roadmap) · [Credits](#credits--licences)

## Features

| Area | What you get |
|---|---|
| **Forest-change analysis** | Annual forest masks and validated loss/gain between a baseline and comparison year for any area ≤ 1,500 km² (Sentinel-2 + Dynamic World, 2016 →). Change events with severity, confidence and spectral evidence (NDVI, NBR, tree probability). Runs as a cancellable background job; stored results open instantly. |
| **Time Machine** | Real annual imagery from 1984 (Landsat) and 2017 (Sentinel-2) for the open area — imagery only before 2016, never a forest figure. |
| **Land, heat & carbon (quick scan)** | For any area and year: LULC in the study-design classes (Forest, Cropland, Built-up, Water, Barren, Grass/Shrub) with area and share; LST in °C with per-class means; surface UHI against all other land **and** against vegetated land; above-ground tree carbon (ESA CCI). Map layers with legends for each. |
| **Change between years** | Per-class area change and built-up expansion between two scanned years, LST and UHI change, and estimated carbon for every ESA CCI epoch (2007, 2010, 2015–2022) with its uncertainty range. |
| **Heatmaps** | NDVI-change (comparison − baseline) and LST heatmaps with legends; reference layers (terrain, Hansen tree cover). |
| **Featured investigations** | Rondônia (Brazil), Hasdeo Arand, Similipal and Silent Valley (India), plus an Indian-city case study — **Gurugram** urban expansion — and the static Noida–Ghaziabad LULC + UHI case study. |
| **Ask TerraTrace** | A Gemini-powered assistant (key on the server only) that explains *your* open analysis from its measured facts, cites them, and withholds any answer containing a number it was not given. Without an open scan it teaches remote-sensing concepts. |
| **Accounts & community** | Supabase sign-in (email + password, magic link, optional Google). Save scans to *My scans*; discuss analyses and reports in a Reddit-style community with tags, search, threaded comments and votes. Guests can read everything. |

## Architecture

```
 Browser (React 19 + Vite, MapLibre, ECharts)            Supabase (Auth + Postgres, Row Level Security)
   │  public anon key + the user's own JWT ───────────────▶  profiles · saved_scans · posts · comments · votes
   │
   │  /api/*  (no credentials in the browser)
   ▼
 FastAPI backend (one process, one worker)  ──────────────▶  Google Earth Engine (service account)
   · analysis jobs (polled), method-versioned result cache    Sentinel-2, Landsat C2, Dynamic World, ESA CCI, …
   · quick scans, carbon series, map-tile proxy + cache
   · rate limits, Supabase JWT verification (JWKS, ES256)
   · /api/ask → Gemini, answers checked against cited facts ─▶  Gemini API (server-side key)
```

- **Frontend** (`frontend/`): React + TypeScript, zustand state, TanStack Query; the URL mirrors the investigation
  (`#/analysis/<area>?from=&to=`), so links and reloads restore the same view.
- **Backend** (`backend/app/`): `api/routes.py` (HTTP API), `services/` (analysis orchestration, quick scan,
  `land_metrics.py`, `carbon_series.py`, chat), `providers/earth_engine/` (the Earth Engine pipeline), `auth.py`
  (token verification), `ratelimit.py`.
- **Database** (`supabase/migrations/`): schema and RLS policies, tested on an in-memory Postgres (`supabase/tests`).
- **Research pipeline** (`analysis/`): a standalone, reproducible LULC (Random Forest) + LST/UHI pipeline used for the
  Noida–Ghaziabad case study; the quick scan reuses its Landsat scene selection and masking code.

## Methods

The full forest method, thresholds and validity rules are in [docs/METHOD.md](docs/METHOD.md) (current version
`tt-ee-2.4`); the quick-scan method in [docs/QUICKSCAN_PLAN.md](docs/QUICKSCAN_PLAN.md).

### Spectral indices: NDVI and NBR

- **NDVI** = (NIR − Red) / (NIR + Red) — vegetation greenness (Sentinel-2 B8, B4).
- **NBR** = (NIR − SWIR2) / (NIR + SWIR2) — sensitive to burned and cleared surfaces (B8, B12).

### Forest and forest change (2016 →)

- **Forest mask.** A 30 m pixel is forest in a year when its Dynamic World *trees* probability (per-pixel 75th
  percentile of the year) is ≥ 0.50 **and** its leaf-on NDVI (per-pixel 90th percentile of clear Sentinel-2
  observations, Cloud Score+ `cs_cdf ≥ 0.60`) is ≥ 0.60. Pixels with fewer than 3 clear or 3 Dynamic World
  observations stay *unobserved*, never "non-forest".
- **Change.** A loss event requires forest → non-forest **and** ΔNDVI ≤ −0.20 or ΔNBR ≤ −0.25 **and** Δtrees ≤ −0.30,
  over patches ≥ 2 ha (minimum mapping unit), counted only on pixels observed in both years.
- **Validity.** Years with < 80 % observed coverage are not analysable; a window with fewer than two analysable years is
  UNAVAILABLE; an in-window transition that fails a physical check (e.g. implausible gain) makes the result
  INVALID_ANALYSIS. Figures are shown only for READY results.

### Land use / land cover (LULC)

Dynamic World V1 annual composite of the scan year: mean probability per class, top class wins; statistics at 30 m by
mode. The nine Dynamic World classes are grouped into the study-design classes **Forest** (trees), **Cropland**
(crops), **Built-up** (built), **Water**, **Barren** (bare), **Grass/Shrub** (grass + shrub and scrub), with flooded
vegetation and snow/ice listed separately. Pixels whose top probability is below 0.5 are reported as low confidence,
and agreement with ESA WorldCover 2021 is reported as a cross-check (agreement, not accuracy). Change between years is
the net change in mapped area per class between two independent annual classifications — not a pixel transition matrix.

### Land surface temperature and the urban heat island (LST / UHI)

- **LST.** Landsat 8/9 Collection 2 Level-2 surface temperature (`ST_B10`): scale factor 0.00341802, offset 149.0 K,
  converted to °C. Scenes are masked per pixel for cloud, cloud shadow, snow and saturation (`QA_PIXEL`, `QA_RADSAT`),
  surface-temperature uncertainty (`ST_QA` ≤ 5 K) and emissivity (`ST_EMIS` ≥ 0.90); the composite is the per-pixel
  median of a season's clear scenes, and at least 5 usable scenes are required. Landsat passes at about 10:30 local
  time, so these are daytime surface (not air) temperatures.
- **UHI intensity** = mean LST of built-up land − mean LST of a reference, area-weighted, water excluded:
  1. *against all other land* (stored with each scan), and
  2. *against vegetated land* (trees, crops, grass, shrub, flooded vegetation; bare ground excluded) — the rural
     reference used in the study design. Bare, dry farmland can be hotter than built-up land in a dry season (an
     "urban cool island"); showing both references makes that visible instead of hiding it.
  Built-up land must cover ≥ 5 % and ≥ 2 km² of the land (and the reference ≥ 2 km²) for a UHI figure.

### Carbon index (estimate)

Above-ground tree carbon = ESA CCI above-ground biomass (oven-dry woody biomass of living trees, 100 m) × **0.47**, the
IPCC (2006) default carbon fraction of dry wood, summed over the area, with a range from the per-pixel standard
deviation (widest case). It is computed for every CCI epoch; the change is measured between 2015 and 2022 (2007 and
2010 come from earlier radar inputs and are shown for context) and flagged when the two ranges overlap. CCI pixels
without a value (desert, dense built-up land) are counted as no tree biomass, not as missing data. It is labelled an **estimate** everywhere.
Roots, dead wood, litter and soil carbon are not included. An IPCC Tier 1 cross-check (LULC area × default carbon
density per class) needs the FAO Global Ecological Zone of each area; that layer is not yet available in Earth Engine
for this project, so Tier 1 is reported as *not computed* rather than approximated.

## Data sources

| Dataset | Use | Reference |
|---|---|---|
| Copernicus Sentinel-2 SR Harmonized (ESA) | imagery, NDVI/NBR, forest mask (2017 →) | Copernicus Sentinel data, processed in Google Earth Engine |
| Cloud Score+ S2 Harmonized | per-pixel cloud masking | Pasquarella, V. J., et al. (2023), *CVPR Workshops (EarthVision)* |
| Google Dynamic World V1 | tree probability, LULC | Brown, C. F., et al. (2022), *Scientific Data* 9, 251, doi:10.1038/s41597-022-01307-4 |
| USGS Landsat Collection 2 (Level-2 SR and ST) | historical imagery; LST (`ST_B10`) | U.S. Geological Survey, Landsat Collection 2 |
| ESA WorldCover v200 (2021) | LULC cross-check | Zanaga, D., et al. (2022), ESA WorldCover 10 m 2021 v200 |
| ESA CCI Above-Ground Biomass v6.0 | carbon estimate (2007, 2010, 2015–2022) | Santoro, M. & Cartus, O., ESA Biomass Climate Change Initiative |
| Hansen Global Forest Change v1.13 | reference layers only | Hansen, M. C., et al. (2013), *Science* 342, 850–853 |
| Copernicus DEM GLO-30 | terrain context (slope, hillshade) | © DLR / Airbus, Copernicus programme |
| IPCC 2006 Guidelines, Vol. 4 (AFOLU) | carbon fraction 0.47 | IPCC (2006), *Guidelines for National Greenhouse Gas Inventories* |

## Limitations

- **Agreement, not accuracy.** Quick-scan values come from global public products and are not validated against
  ground truth for each area; WorldCover agreement is a cross-check between two maps.
- **Deciduous forests.** Dynamic World's tree probability varies between years in strongly seasonal forest; some
  windows (e.g. Hasdeo Arand) fail the gain check and are reported INVALID_ANALYSIS with no figures.
- **Before 2016** only imagery is shown: the Landsat-era NDVI proxy cannot separate green crops from forest.
- **LST is a daytime surface temperature** from single-year composites; differences between years include weather.
  The UHI difference (built − reference within the same scenes) is less sensitive to it.
- **Carbon** is an estimate from a biomass map with its own uncertainty; ESA advises caution when reading small
  differences between epochs as change.
- **Area limit** of 1,500 km² per interactive analysis; the free Earth Engine tier can enter restricted mode, which makes
  requests slower (they are queued one at a time).
- **The assistant** can be wrong about general knowledge; only its cited TERRATRACE figures are checked.

## Research in progress

A manuscript describing the TERRATRACE method and its Indian case studies (LULC change, built-up expansion and the
surface urban heat island in Delhi NCR, and forest change in central and eastern India) is in preparation for a
peer-reviewed journal. **It has not been submitted.** Figures in the app and in `analysis/outputs/` are working
results and may change before publication; please contact the author before citing them.

## Getting started

Requirements: Python 3.14, Node.js 20.19+ or 22.12+, and a Google Cloud project registered for Earth Engine
(noncommercial use is free: <https://code.earthengine.google.com/register>).

```powershell
# one-time setup
cd backend;  python -m venv .venv; .venv\Scripts\python -m pip install -r requirements.txt; cd ..
cd frontend; npm install; cd ..
copy backend\.env.example backend\.env              # set EE_PROJECT; optional SUPABASE_URL, GEMINI_API_KEY
copy frontend\.env.example frontend\.env.local      # optional VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
earthengine authenticate                            # once, for local Earth Engine access

# run everything
.\run-dev.ps1        # backend http://127.0.0.1:8001 (new window, auto-reload) + frontend http://localhost:5173
```

- **Backend only:** `backend\run.ps1` (works from any folder; passes `--app-dir`, so `import app` always resolves —
  plain `uvicorn app.main:app` only works inside `backend/`). If PowerShell blocks scripts:
  `powershell -ExecutionPolicy Bypass -File backend\run.ps1`.
- **Frontend only:** `cd frontend; npm run dev` (proxies `/api` to `127.0.0.1:8001`; `TT_API_PROXY` overrides).
- `http://127.0.0.1:8001/api/health` reports Earth Engine (`ready` / `unconfigured`), the chat and the limits. Without
  credentials the backend still starts; analysis then shows as unavailable and nothing is substituted.
- Accounts and the community need a Supabase project with the migrations applied — see [DEPLOY.md](DEPLOY.md#3-supabase-migrations-and-redirect-urls).
  Without Supabase settings the app works and shows "Accounts are not available yet".

`backend/.env` and `frontend/.env.local` are git-ignored. Never commit them, a key file, or a Supabase service-role key.

## Tests

```powershell
cd backend;  .venv\Scripts\python -m pytest -q; cd ..        # offline: Earth Engine, Gemini and Supabase are faked
cd frontend; npm run typecheck; npm test; npm run build; cd .. # Vitest unit tests (jsdom)
cd supabase; npm install; npm test; cd ..                      # migrations + Row Level Security on in-memory Postgres
# end-to-end (a preview build with test Supabase settings; see each script's header):
cd frontend; npm run test:auth; npm run test:community; npm run test:integrity; cd ..
```

## Deployment

Frontend on **Vercel**, backend on **Railway** (one container from the repo-root `Dockerfile`, persistent volume),
accounts and community on **Supabase**. Exact environment variables per platform, redirect URLs and Google OAuth:
[DEPLOY.md](DEPLOY.md). Open items before going public: [docs/PRE_DEPLOYMENT.md](docs/PRE_DEPLOYMENT.md).

## Roadmap

**Later (not built yet):**

- **Custom-trained models** — a TERRATRACE land-cover / change classifier trained on the project's own labelled
  samples (the `analysis/` Random Forest is a first step), with per-class accuracy against independent validation.
- **Terrain datasets** in the analyses themselves (elevation, slope and aspect as covariates and stratification for
  LULC, LST and change), beyond today's terrain context layers.
- IPCC Tier 1 carbon cross-check once the FAO Global Ecological Zone layer is available in Earth Engine.
- Earlier baseline years (≈2000) for city case studies through the Landsat 5/7 research pipeline.

## Credits & licences

- Copernicus Sentinel-2 data (ESA); USGS Landsat Collection 2; Google Dynamic World V1; ESA WorldCover; ESA Climate
  Change Initiative Biomass; Hansen et al. Global Forest Change (CC BY 4.0); Copernicus DEM — all via Google Earth Engine.
- Globe basemap: Sentinel-2 cloudless 2025 © EOX IT Services GmbH, s2maps.eu (CC BY-NC-SA 4.0).
- High-resolution imagery and labels © Esri, Maxar, Earthstar Geographics.
- Built with React, MapLibre GL JS, Apache ECharts, Tailwind CSS, FastAPI, Supabase and the Gemini API.
