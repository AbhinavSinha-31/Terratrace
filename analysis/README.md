# LULC + urban heat island case study — method and how to run it

The research story this pipeline tests is: urban population growth → land-use / land-cover (LULC) change
(vegetation or cropland becoming built-up) → vegetation loss → rising land surface temperature (LST), i.e. a surface
urban heat island (UHI).

It **tests** the story; it does not assume it. Each link is measured separately, every suspicious number is
flagged in `outputs/results_summary.md`, and a result that goes against the story is reported as it is.

- Study area: Noida, Greater Noida and Ghaziabad. These are the FAO GAUL 2025 districts *Gautambudhnagar* and
  *Ghaziabad*, about 2,335 km².
- Study years: 2005, 2015 and 2025.
- All settings: [config.toml](config.toml).

## Run it

```powershell
cd analysis
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env        # EE_PROJECT=<Earth Engine Cloud project>; log in once with `earthengine authenticate`
.venv\Scripts\python -m pytest tests -q
.venv\Scripts\python run_pipeline.py --years 2015 2025
.venv\Scripts\python run_pipeline.py                  # all years
```

| Step | What it does | Where |
|---|---|---|
| `boundary` | Writes `boundaries/noida_ghaziabad.geojson` from GAUL 2025. It is skipped if the file exists; replace the file to change city. | Earth Engine |
| `grid` | Fixes one 30 m UTM 43N grid and rasterises the study area. | Earth Engine |
| `lst` | Re-downloads only the LST rasters of cached years, after a change to the LST masking. The LULC is kept. | Earth Engine |
| `ee` | For each year: composites, reference labels, sample, Random Forest, accuracy, then downloads the LULC, LST, NDVI and NDBI rasters. | Earth Engine (about 20 min per year) |
| `population` | GHSL population and built-up surface per epoch. | Earth Engine |
| `stats` | Areas, transitions, LST per class, UHI (both methods), correlations and conversion analysis, written to `outputs/tables/*.csv`. | local |
| `figures` | Maps and charts, written to `outputs/maps`, `outputs/charts`. | local |
| `validation` | Blind validation points, written to `outputs/validation`. | local, plus 1 small Earth Engine call |
| `report` | Sanity checks and `outputs/results_summary.md`. | local |

- **Caching:** Earth Engine results are cached in `outputs/cache/`. Re-running the local steps takes seconds; `--force` recomputes.
- **One request at a time:** Earth Engine requests run serially, because of the noncommercial quota.
- **Credentials:** they come only from the environment or `analysis/.env` (git-ignored), never from code. A service-account key file, if you use one, must live outside the repository (`EE_SERVICE_ACCOUNT_KEY`).

### Website case study (local, no Earth Engine)

```powershell
.venv\Scripts\python export_case_study.py   # case-study.json + web-sized figures, from outputs/tables and outputs/maps
.venv\Scripts\python render_tiles.py        # interactive-map tiles, from the cached rasters in outputs/cache
```

- **Output:** both write to `frontend/public/case-studies/noida-ghaziabad/`, which is served as static files; the website needs no backend for the case study.
- **Map tiles:** Web Mercator PNG tiles, z8–z12, for land cover per year, the change map and LST per season and year (about 12 MB, 938 files). z12 is about 34 m per pixel, the 30 m data's own resolution; the map enlarges z12 beyond that. Classes, colours and LST colour ranges are the publication maps' own (`terratrace_analysis.maps`). `--max-zoom 11` gives a smaller set.
- **Order:** run `run_pipeline.py --steps stats figures report` first if the tables changed; `export_case_study.py` refuses to run when `results_summary.md` is older than the tables.

## Method

### 1. Imagery

Landsat Collection 2 Level-2, Tier 1:

| Year | Sensor | Why |
|---|---|---|
| 2005 | Landsat 7 ETM+, 2004–2006 pooled | Landsat 5 has **no** Collection 2 scenes (Tier 1 or Tier 2) over this area in 2002–2007: its onboard recorder had failed and these acquisitions never reached the USGS archive. Landsat 7 has had stripe gaps since its scan-line corrector failed in May 2003 (SLC-off, about 22 % of each scene missing). Pooling three years and taking the per-pixel median fills most of them; the remaining gaps are reported. |
| 2015 | Landsat 8 OLI/TIRS | |
| 2025 | Landsat 8 + 9 OLI/TIRS | |

Processing of each scene:

- **Scene filter:** scene `CLOUD_COVER` < 60 %.
- **Pixel mask:** pixels flagged in `QA_PIXEL` are masked: fill, dilated cloud, cirrus, cloud, cloud shadow and snow (bits 0–5). Pixels saturated in any band (`QA_RADSAT` ≠ 0) are also masked.
- **Scale factors:**
  - Reflectance ρ = DN × 0.0000275 − 0.2.
  - Temperature T = DN × 0.00341802 + 149.0 K, then °C = T − 273.15. The thermal band is `ST_B6` on Landsat 7 and `ST_B10` on Landsat 8/9.
- **Band names** are harmonised to blue, green, red, nir, swir1, swir2 and lst.
- **LST uncertainty mask (LST only):** a pixel's temperature is dropped from a scene when the USGS uncertainty band
  `ST_QA` exceeds 5 K (`config.toml → max_st_uncertainty_k`). This removes **emissivity artefacts**: places where the
  ASTER GED emissivity database that USGS uses is wrong. The cloud mask cannot see them. Found at 28.09°N 77.50°E
  (southern tip of the study area), on scene LC08_146040_20150503:

  | Pixels | Emissivity | `ST_QA` | Emissivity SD | ASTER GED band 14 | LST |
  |---|---|---|---|---|---|
  | Hot (n = 396) | 0.80 | 55.7 K | 0.83 | 0.70 | 58–63 °C |
  | Surroundings | 0.97 | 1.7 K | 0.01 | 0.97 | about 48 °C |

  In the temperature image they show up as sharp rectangles of 100–400 m (ASTER GED is a 100 m grid), with no
  matching feature in the true-colour image. Reflectance, and so the land-cover classification, is not affected.

Seasons (each date range includes its start date and excludes its end date):

- **April–June (pre-monsoon):** the primary LST result. Its spectral composite also feeds the classifier.
- **November–February** (Nov of the previous year to Feb of the study year): the secondary LST result.
- **Whole calendar year:** NDVI percentiles only.

The composite for each season is the per-pixel median of the clear observations.

The native thermal resolution is 60 m (ETM+) and 100 m (TIRS); USGS delivers both resampled to 30 m. Neighbouring
30 m LST pixels are therefore not independent.

### 2. LULC classification

- **Classes (4):** Built-up (incl. bare land), Vegetation/Trees, Agriculture/Cropland, Water. The planned fifth class,
  Barren/Open land, is **merged into Built-up in every year**:
  - **Too few labels.** The reference-label rule left only 86 Barren pixels in 2015 and 14 in 2025, giving at most
    26 and 4 test points. Accuracy figures from so few points mean nothing, and points from 27 and 8 tiny patches don't
    represent the class.
  - **No alternative works for every year.** A Dynamic World + WorldCover alternative gave enough pixels for 2025
    (3,231). It cannot exist for 2005, so it would break the identical-rule-for-every-year requirement.
  - **Closest class.** In the 12-feature space Barren is closest to Built-up: standardised distance 5.2 vs 5.7 to
    cropland in 2015, and 3.9 vs 4.7 in 2025. Neither ever turns green: whole-year 90th-percentile NDVI is 0.15–0.18
    for Barren, 0.34 for Built-up and 0.71 for cropland.
  - **How the merge is done:** at the label level, identically for all years. GLC-FCS30D codes 150/152/153/200–202,
    WorldCover 60 and Dynamic World 7 all map to Built-up.
  - **Consequence:** the Built-up class includes bare and cleared land, much of it construction sites on the urban
    fringe. Barren was 0.7 % of the five-class 2015 map.
- **Features** (12 in total):
  - April–June median reflectance in six bands.
  - April–June NDVI, NDBI and MNDWI.
  - The 10th, 50th and 90th percentile of NDVI over the whole year. April–June comes after the wheat harvest, when cropland looks like bare ground; whole-year NDVI shows the cropland's green seasons.

**Training labels — what to write in the methods.** Labels are pixels of the GLC-FCS30D global annual 30 m land-cover
product (Zhang et al., 2024, *Earth System Science Data*). Its fine classes are mapped onto the five classes
(`config.toml → [labels.glc_map]`). A pixel becomes a label only when both conditions hold:

- **Temporally stable:** it has the same class in every year from y−2 to y+2 (2020–2022 for 2025, because GLC-FCS30D ends in 2022).
- **Agreement:** it has the same class in each independent product available for that year:
  - 2025: ESA WorldCover 2021 and the Dynamic World 2025 annual mode.
  - 2015: Dynamic World 2016, because Dynamic World starts on 2015-12-07 here.
  - 2005: no independent product exists, so stability is the only filter.

Classification:

- **Sample:** a stratified random sample of up to 600 pixels per class is split 70/30 within each class (seeded); the exact points are saved in `outputs/cache/<year>/training_points.csv`.
- **Classifier:** `ee.Classifier.smileRandomForest` with 200 trees and seed 42.
- **Accuracy:** computed on the held-out 30 %.

**Accuracy wording.** These figures are **agreement with reference labels**, not accuracy against ground truth:

- **Same source:** training and test pixels come from the same reference product.
- **Easy pixels:** stable pixels are easier to classify than pixels that changed.
- **Not independent:** nearby sample points are not independent.

The figures are therefore optimistic. Independent validation is prepared (see §5) but not yet done.
Per-class figures are withheld for any class with fewer than 30 test points (`min_test_points_per_class`).

### 3. Change

- **Areas** are pixel counts × 900 m² on the common UTM grid.
- **Transition matrices** (km², from-class rows × to-class columns) are computed for every pair of years, over pixels classified in both.
- **Errors combine:** classification errors of the two maps add up in a change map.

### 4. LST and UHI

Measures computed for each year and season:

- **LST maps.**
- **Mean, SD and median LST per class.**
- **Pearson r with NDVI and NDBI:** computed over land pixels, with water excluded. The p-value is computed on a 300 m thinned grid, because neighbouring pixels are not independent.

UHI intensity is computed two ways, both for each year and season:

- **Method A — urban core vs rural ring.** This is the more standard surface-UHI definition (e.g. Peng et al., 2012; Chakraborty & Lee, 2019).
  - The **core** is the set of pixels whose built-up fraction within 500 m is ≥ 50 %, in patches of at least 1 km².
  - The **ring** is the nearest non-built-up, non-water land of *equal area*, inside the study area.
  - The ring stays inside the study area because East Delhi, directly west of Noida and Ghaziabad, is urban.
- **Method B — built-up minus non-built-up land** across the whole study area, with water excluded.

**Conversion analysis.** This is the direct test of "vegetation/cropland → built-up → warmer". It compares the change
in *normalised* LST, z = (LST − study-area mean) / SD per season and year, between two groups:

- pixels that became built-up;
- pixels that kept their class.

Because z is relative to each year's own study-area mean, a summer that was simply hotter overall does not count as warming.

**Expect a possible "cool island".** Landsat passes over at about 10:30 local time. In pre-monsoon India, the dry,
harvested fields around a city are often hotter than the city by day, a daytime *urban cool island* (Shastri et al.,
2017, *Scientific Reports*). A negative April–June UHI intensity is therefore plausible and is reported as it is.

**Seasonal ponds.** A few pixels classified as Water are seasonal ponds that are dry in April–June. Example:
28.62°N 77.47°E, where JRC Global Surface Water shows about 1 month of water per year and the summer MNDWI is −0.06.
Their summer LST of 55–58 °C is a real dry-ground temperature with normal uncertainty (1.9 K). The class is what is
wrong, not the temperature. Water is excluded from every LST land statistic, so they do not enter the UHI numbers.

### 5. Independent validation (to do before the final paper)

`outputs/validation/` holds, for each year, 50 random points per *mapped* class:

- `validation_points_<year>.kml`: a **blind** file of point IDs, with no map class shown.
- `validation_sheet.csv`: one row per point, to fill in.
- `validation_key.csv`: the map class of each point, kept separate.

To use them:

1. Open the KML in Google Earth Pro and set the historical-imagery slider to the point's year.
2. Record the class you see in `validation_sheet.csv`, without looking at the key.
3. Join the sheet to the key.
4. Compute area-weighted (stratified) accuracy and area estimates, following Olofsson et al. (2014), *Remote Sensing of Environment* 148: 42–57. Each stratum is weighted by its mapped area share.

### 6. Population

- **Source:** GHSL GHS-POP and GHS-BUILT-S, release P2023A, summed over the study area for each 5-year epoch.
- **2025 is a projection:** GHSL's 2025 epoch is a model projection, not a census-based estimate, and is marked as such everywhere.
- **Independent check:** GHS-BUILT-S gives an independent check on the built-up trend.
