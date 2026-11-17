# Hardcoded numbers — featured investigations and case study

Checked 2026-10-25 on branch `production`. Scope: every number a visitor sees on the landing page's featured
investigations and overview panel, and on the Noida–Ghaziabad case study page. **Nothing was removed**; items without
a traceable source are listed at the end for a decision.

## Numbers with a verified source

| Number(s) | Where | Source | How it was checked |
|---|---|---|---|
| Area of each featured site (Rondônia 1,772.6 km², Hasdeo Arand 1,215.1, Similipal 1,822.5, Silent Valley 394.0) and its hectares | `backend/app/data/featured_investigations.json` (+ identical copy `frontend/public/data/featured.json`) | Geodesic area of the site's own polygon | Recomputed with `services/geometry.validate_aoi`: all within 0.03 km². New test `test_stated_areas_are_computed_from_the_geometry` pins it |
| Analysis subset areas (Rondônia 999.1 km², Similipal 997.7 km²) | same files, `analysis_area` | Geodesic area of the subset polygon | Recomputed: within 0.01 km²; covered by the same test |
| "Detected change · TERRATRACE" hectares, event count, number of live analyses, control-site detections | Landing overview panel, featured cards | Stored READY Earth Engine results, served by `GET /api/featured/summary` at runtime | Not in source code; computed from results on every load |
| "04 live · 1 case study" | Landing overview panel | Length of the featured list and of `CASE_STUDIES` | Derived |
| Every number on the case study page (class areas, net change, transitions, population, LST, UHI, conversions, correlations, agreement, masking, headline cards) | `frontend/public/case-studies/noida-ghaziabad/case-study.json` | `analysis/outputs/tables/*.csv` and `results_summary.md`, exported by `analysis/export_case_study.py` | Exporter re-run in an isolated copy (with the git-ignored Earth Engine cache): **0 differences** from the committed JSON apart from `generated_utc`; its own cross-checks: 4 passed |
| World forest area "40.6 M km² · 31 % of land area" | `frontend/src/features/explore/Landing.tsx:92-95`, labelled "Reference · FAO FRA 2020" | FAO, *Global Forest Resources Assessment 2020 – Key findings* (4.06 billion ha, 31 % of land), doi:10.4060/ca8753en | Matches the publication; typed into JSX (see item 3 below) |
| Data sources "Landsat 1984 – present" | `frontend/src/lib/time.ts` `ERAS` | Landsat 5 TM operations from 1984; the app's own historical years start at 1984 (`HIST_YEARS`) | Consistent with the method |

## Numbers without a traceable source in the repository (not removed)

| # | Number | Where | What is missing |
|---|---|---|---|
| 1 | "~10:30 overpass" (local time of the Landsat images) | `frontend/src/features/casestudy/CaseStudyPage.tsx:280` (Surface heat kicker); also the pipeline's own text in `analysis/outputs/results_summary.md` (lines 119, 120, 136, 145) and `analysis/README.md:176` | A fixed phrase, not measured. `analysis/outputs/tables/scenes.csv` stores scene counts and dates, not acquisition times. Could be confirmed from the scenes' `SCENE_CENTER_TIME` (one Earth Engine request) or cited to USGS |
| 2 | "about 1,000 km²" and "1,500 km² interactive analysis limit" | `analysis_area.basis` text in both featured JSON files | 1,000 matches the computed subsets; 1,500 is the *default* of `TT_INTERACTIVE_MAX_KM2` typed as text — it goes stale if the setting changes |
| 3 | "40.6 M km² · 31 %" | `Landing.tsx` | Source cited and correct, but the figure lives in JSX with no link or reference file (PLAN.md draft item H6 proposes a cited reference-data file) |
| 4 | "Sentinel-2 2015 – present", "Dynamic World 2015 – present" | Landing "Data sources" panel (`ERAS.from = 2015.5`) | True for the missions, but not what the app uses: Sentinel-2 imagery is shown from the SR Harmonized catalogue (2017-03-28, README) and forest analysis starts in 2016 (`MODERN_FIRST_YEAR`). Typed, not derived from the method |

Not in scope and not numbers shown to visitors: map styling constants, chart ranges, timeouts and limits in
`backend/app/config.py` (documented settings), and the quick-scan dataset years (`CCI_YEAR`, `WORLDCOVER_YEAR`, in
`docs/QUICKSCAN_PLAN.md`).
