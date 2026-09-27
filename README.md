# TERRATRACE — Forest-Change Intelligence (Expo prototype)

Interactive prototype of TERRATRACE: select a study area, scrub through 2018–2025 annual
Sentinel-2 imagery, compare before/after, inspect detected forest-change events with
their NDVI / NBR / tree-probability evidence, and read an AI explanation grounded only in
the measured facts.

> **Data honesty.** Basemap imagery is **real** (EOX Sentinel-2 cloudless annual mosaics).
> Forest masks, change events and statistics are **illustrative**, produced by a
> deterministic simulation (`frontend/scripts/generate-demo-data.mjs`) in exactly the
> format the real pipeline will output. The UI labels this with a *DEMO DATA* badge.

## Quick start

```bash
cd frontend
npm install
npm run dev            # http://localhost:5173
```

The demo dataset is committed in `frontend/public/data`. To regenerate it (deterministic):
`npm run generate:demo`.

### Optional: AI explanations with Claude

Without the server the app uses the **offline grounded narrative** (template-based, so it
can only state supplied facts). To generate explanations with Claude:

```bash
cd server
python -m venv .venv
.venv\Scripts\activate                 # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # PowerShell; macOS/Linux: export ANTHROPIC_API_KEY=...
uvicorn app:app --port 8000
python -m pytest -q test_app.py         # offline tests: fact-check, health, error paths
```

The Vite dev server proxies `/api` to `:8000`. The key stays on the server. Every model
draft goes through a **numeric fact-check**: any number that does not appear in the event's
facts rejects the draft, and the UI falls back to the offline narrative with a notice.
Passing drafts are cached in `server/.cache/`, so clicking through the demo once before the
Expo makes later views instant and offline-safe.

### Expo mode (one command)

```bash
cd frontend && npm run build
cd ../server && uvicorn app:app --port 8000   # serves the app at http://localhost:8000
```

Imagery tiles need internet; if they fail, a toast appears and the analysis layers,
charts and events keep working.

## Demo script (≈3 minutes)

1. **Globe** → four monitored regions; point out the control site.
2. **Rondônia** → fishbone frontier; press **Play** on the timeline and watch events appear
   with pulsing rings, while forest area falls in the chart.
3. Click a polygon → **event panel**: area in ha/km², period, ΔNDVI, ΔNBR, Δtree probability,
   severity, and the evidence checklist behind the confidence score.
4. **Before / After** → a swipe comparison between the two composites that bracket the event.
5. **Similipal** → burn scars: NBR drops more than NDVI; the forest chart dips in 2021 and
   *recovers* (regrowth).
6. **Hasdeo Arand** → mine expansion; the 2025 imagery shows the open-cast pit.
7. **Silent Valley** → no events: evidence of a low false-alarm rate.
8. Open **Facts supplied to the model** to show the explanation uses nothing else.

Keyboard: `←/→` year · `Space` play · `C` compare · `Esc` close.
UI states for review: append `?simulate=error`, `?simulate=empty` or `?simulate=slow`.

## Prototype architecture

```
frontend/
  scripts/generate-demo-data.mjs   simulation → public/data (API-shaped JSON/GeoJSON/PNG)
  public/data/                      study-areas.json, aoi/<id>/{summary.json, events.geojson, layers.json, *.png}
  src/data/contracts.ts             ★ the data contract (schema 1.0)
  src/data/provider.ts              DataSource interface; VITE_DATA_SOURCE=demo|api
  src/data/staticProvider.ts        reads public/data (prototype)
  src/data/apiProvider.ts           reads /api/v1 (production backend, same shapes)
  src/explain/                      facts builder, offline narrative, LLM client with fallback
  src/features/map/TerraMap.ts      imperative MapLibre controller (globe, imagery cross-fade,
                                    overlays, events, hotspots, pulse animation)
  src/features/…                    timeline, dashboard, events, explanation, layers, shell
server/app.py                       POST /api/v1/explanations, GET /api/v1/health, serves dist/
```

### Data contract (what the real pipeline must produce)

| Endpoint (production)              | Prototype file                       | Type (`contracts.ts`) |
|------------------------------------|--------------------------------------|-----------------------|
| `GET /api/v1/study-areas`          | `data/study-areas.json`              | `StudyAreaIndex`      |
| `GET /api/v1/aois/{id}/summary`    | `data/aoi/{id}/summary.json`         | `AoiSummary`          |
| `GET /api/v1/aois/{id}/events`     | `data/aoi/{id}/events.geojson`       | `EventCollection`     |
| `GET /api/v1/aois/{id}/layers`     | `data/aoi/{id}/layers.json`          | `LayerCatalog`        |
| `POST /api/v1/explanations`        | `server/app.py`                      | `Explanation`         |

To plug in the real Earth Engine pipeline, either export files with these shapes into
`public/data`, or implement the endpoints and set `VITE_DATA_SOURCE=api`. Overlays support
per-year images (`source: "image"`) and XYZ tiles (`source: "raster-tiles"`, e.g. GEE map IDs
or TiTiler), so no frontend change is needed.

### Method shown in the UI (and in `summary.json → method`)

- Forest: Dynamic World tree probability ≥ 0.50 and NDVI ≥ 0.60 in a same-season composite.
- Change: `forest(t−1) ∧ [ΔNDVI ≤ −0.20 ∨ ΔNBR ≤ −0.25] ∧ Δtree-prob ≤ −0.30 ∧ ¬forest(t)`, MMU 2 ha.
- Severity: burns use USGS dNBR classes; clearings use a composite of NDVI decline, conversion share and patch size.
- Confidence: weighted evidence (NDVI, NBR, tree probability, persistence, clear observations, Hansen overlap).

## Credits & licences

- Sentinel-2 cloudless annual mosaics © EOX IT Services GmbH, s2maps.eu (CC BY-NC-SA 4.0;
  contains modified Copernicus Sentinel data). Non-commercial use only.
- High-resolution imagery and labels © Esri, Maxar, Earthstar Geographics.
- MapLibre GL JS, Apache ECharts, React, Tailwind CSS.
