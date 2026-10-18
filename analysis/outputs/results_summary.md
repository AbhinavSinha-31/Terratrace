# Results summary — Noida, Greater Noida and Ghaziabad (Delhi NCR)

Generated 2026-10-19 by the TerraTrace analysis pipeline v1.0.0 from `outputs/tables/*.csv` (years 2015, 2025). Every number is read from those tables; none is typed by hand.

## 1. Study setup

- **Study area:** Noida, Greater Noida and Ghaziabad (Delhi NCR) — FAO GAUL 2025 districts Gautambudhnagar + Ghaziabad, 2,330 km² (30 m grid: 2,335 km²).
- **Years and sensors:** 2015: Landsat 8; 2025: Landsat 8 + Landsat 9 — Landsat Collection 2 Level-2, Tier 1, 30 m.
- **Scenes used:** 2015: 17 April–June, 18 Nov–Feb, 56 whole-year; 2025: 29 April–June, 36 Nov–Feb, 101 whole-year.
- **Classes (4):** Built-up (incl. bare land), Vegetation/Trees, Agriculture/Cropland, Water (Barren/Open land merged into Built-up in every year). Random Forest, 200 trees; points (600 per class, 70/30 per class): 2015: 1680 training / 720 test; 2025: 1680 training / 720 test.

## 2. Classification quality

- **2015:** overall agreement with reference labels **91.4%**, kappa **0.885** (720 held-out points). Most confused pairs: Vegetation/Trees ↔ Water: 20 of 720 test points (10 Vegetation/Trees → Water, 10 the other way); Vegetation/Trees ↔ Agriculture/Cropland: 15 of 720 test points (11 Vegetation/Trees → Agriculture/Cropland, 4 the other way).
- **2025:** overall agreement with reference labels **94.6%**, kappa **0.928** (720 held-out points). Most confused pairs: Vegetation/Trees ↔ Agriculture/Cropland: 11 of 720 test points (7 Vegetation/Trees → Agriculture/Cropland, 4 the other way); Vegetation/Trees ↔ Water: 10 of 720 test points (4 Vegetation/Trees → Water, 6 the other way).
- These figures measure agreement with labels derived from GLC-FCS30D (stable pixels, agreeing with an independent product), **not accuracy against ground truth**; see §9.

## 3. Land-cover change (core result)

| Class | 2015 km² | 2015 % | 2025 km² | 2025 % |
|---|---:|---:|---:|---:|
| Built-up (incl. bare land) | 616.3 | 26.4 | 669.3 | 28.7 |
| Vegetation/Trees | 139.3 | 6.0 | 166.8 | 7.1 |
| Agriculture/Cropland | 1,544.9 | 66.2 | 1,472.0 | 63.0 |
| Water | 34.8 | 1.5 | 27.3 | 1.2 |

**Change 2015 → 2025:**

- Built-up (incl. bare land): +52.9 km² (+2.3 percentage points; +9 % relative)
- Vegetation/Trees: +27.5 km² (+1.2 percentage points; +20 % relative)
- Agriculture/Cropland: -72.9 km² (-3.1 percentage points; -5 % relative)
- Water: -7.6 km² (-0.3 percentage points; -22 % relative)
- Top 3 transitions (474.9 km² changed class in total): **154.8 km² of Agriculture/Cropland became Built-up (incl. bare land)** (33% of all change); **95.5 km² of Built-up (incl. bare land) became Agriculture/Cropland** (20% of all change); **75.9 km² of Agriculture/Cropland became Vegetation/Trees** (16% of all change).
- Land that became Built-up (incl. bare land): 185.8 km² in total — 154.8 km² from Agriculture/Cropland (83%), 21.7 km² from Vegetation/Trees (12%), 9.3 km² from Water (5%).
- Built-up (incl. bare land) that changed to another class: 132.8 km² (31.0 km² to Vegetation/Trees, 95.5 km² to Agriculture/Cropland, 6.3 km² to Water). Built-up rarely returns to cropland in reality; most of this is confusion between bare harvested fields (inside the merged Built-up class) and cropland, so the gross transitions overstate change; **use the net figures**.

## 4. Population

- 2015: 6.07 million residents (GHSL GHS-POP P2023A).
- 2025: 7.26 million residents (GHSL GHS-POP P2023A) — **GHSL model projection, not a census-based estimate**.
- 2015 → 2025: population +19.5 %; built-up area (this study) +8.6 %; GHSL built-up surface +18.2 %. Built-up land per resident: 102 m² → 92 m² (population grew faster than built-up area).
- Only two (later three) time points: this describes co-occurring growth, not a statistical relationship or cause.

## 5. Temperature / UHI

**Mean land surface temperature (land = all classes except Water):**

| | 2015 Apr–Jun | 2025 Apr–Jun | 2015 Nov–Feb | 2025 Nov–Feb |
|---|---:|---:|---:|---:|
| Study area (land) | 43.7 °C | 40.4 °C | 23.8 °C | 22.5 °C |
| Built-up (incl. bare land) | 43.1 °C | 40.7 °C | 24.8 °C | 23.2 °C |
| Vegetation/Trees | 40.7 °C | 38.9 °C | 23.6 °C | 22.6 °C |
| Agriculture/Cropland | 44.2 °C | 40.4 °C | 23.4 °C | 22.1 °C |
| Water | 39.8 °C | 37.0 °C | 22.9 °C | 21.3 °C |

Absolute LST differs between years partly because of that season's weather; compare classes within a year, or use the relative measures below across years.

**UHI intensity (urban − rural):**

| Year | Season | Urban core − rural ring (primary) | Built-up − non-built-up (secondary) | Result |
|---|---|---:|---:|---|
| 2015 | April–June (primary) | -0.55 °C (43.1 vs 43.6; ring to 2.2 km) | -0.80 °C | a surface urban **cool island** |
| 2025 | April–June (primary) | +0.50 °C (40.8 vs 40.3; ring to 2.2 km) | +0.50 °C | a surface urban **heat island** |
| 2015 | Nov–Feb (secondary) | +1.06 °C (25.0 vs 23.9; ring to 2.2 km) | +1.38 °C | a surface urban **heat island** |
| 2025 | Nov–Feb (secondary) | +1.09 °C (23.4 vs 22.3; ring to 2.2 km) | +1.05 °C | a surface urban **heat island** |

- **2015, April–June (primary): a surface urban **cool island** (urban cooler than its surroundings)** — urban core -0.55 °C relative to the rural ring.
- **2025, April–June (primary): a surface urban **heat island** (urban warmer)** — urban core +0.50 °C relative to the rural ring.
- 2015, November–February (secondary): a surface urban **heat island** (urban warmer) — +1.06 °C.
- 2025, November–February (secondary): a surface urban **heat island** (urban warmer) — +1.09 °C.

**Key test of the story — LST change of pixels that became Built-up vs pixels that kept their class:**

| Period | Season | Group | Area km² | Mean ΔLST (°C) | Mean Δ normalised LST (SD) |
|---|---|---|---:|---:|---:|
| 2015→2025 | summer | Vegetation/Trees → Built-up | 21.7 | -2.92 °C | +0.30 |
| 2015→2025 | summer | Agriculture/Cropland → Built-up | 154.8 | -3.71 °C | -0.01 |
| 2015→2025 | summer | Stable Built-up | 483.5 | -2.36 °C | +0.32 |
| 2015→2025 | summer | Stable Vegetation/Trees | 52.7 | -2.31 °C | -0.29 |
| 2015→2025 | summer | Stable Agriculture/Cropland | 1,309.3 | -3.77 °C | -0.11 |
| 2015→2025 | winter | Vegetation/Trees → Built-up | 21.7 | -2.11 °C | -0.28 |
| 2015→2025 | winter | Agriculture/Cropland → Built-up | 154.8 | -1.09 °C | +0.25 |
| 2015→2025 | winter | Stable Built-up | 483.5 | -1.47 °C | +0.01 |
| 2015→2025 | winter | Stable Vegetation/Trees | 52.7 | -1.34 °C | -0.11 |
| 2015→2025 | winter | Stable Agriculture/Cropland | 1,309.3 | -1.17 °C | +0.02 |

- 2015→2025, summer: agriculture/cropland that became built-up (154.8 km²) vs unchanged agriculture/cropland: difference +0.10 SD normalised, +0.06 °C raw (-3.71 °C vs -3.77 °C) — **slightly warmer than the unchanged class**.
- 2015→2025, summer: vegetation/trees that became built-up (21.7 km²) vs unchanged vegetation/trees: difference +0.59 SD normalised, -0.60 °C raw (-2.92 °C vs -2.31 °C) — **inconclusive: normalised and raw differences point in opposite directions**.
- 2015→2025, winter: agriculture/cropland that became built-up (154.8 km²) vs unchanged agriculture/cropland: difference +0.24 SD normalised, +0.09 °C raw (-1.09 °C vs -1.17 °C) — **warmer than the unchanged class**.
- 2015→2025, winter: vegetation/trees that became built-up (21.7 km²) vs unchanged vegetation/trees: difference -0.17 SD normalised, -0.77 °C raw (-2.11 °C vs -1.34 °C) — **slightly cooler than the unchanged class**.

## 6. Correlations

| Year | Season | LST vs NDVI r | LST vs NDBI r | p (300 m thinned grid) | n pixels (thinned) |
|---|---|---:|---:|---|---:|
| 2015 | April–June | -0.507 | +0.555 | NDVI p < 0.001; NDBI p < 0.001 | 2,555,572 (25,587) |
| 2025 | April–June | -0.481 | +0.441 | NDVI p < 0.001; NDBI p < 0.001 | 2,564,011 (25,660) |
| 2015 | Nov–Feb | -0.604 | +0.627 | NDVI p < 0.001; NDBI p < 0.001 | 2,555,615 (25,587) |
| 2025 | Nov–Feb | -0.567 | +0.577 | NDVI p < 0.001; NDBI p < 0.001 | 2,563,992 (25,660) |

- r uses every land pixel (water excluded). The p-value uses every 10th row and column (300 m apart) because neighbouring 30 m pixels are not independent (thermal bands are 100 m natively); even so, p-values from tens of thousands of pixels are always tiny — the size of r is what matters.

## 7. Quality control

- **LST masking rule:** in every scene, a pixel's LST is dropped when the USGS surface-temperature uncertainty (`ST_QA`) exceeds 5 K **or** its emissivity (`ST_EMIS`) is below 0.90 (real surfaces here: ~0.92–0.99), in addition to the QA_PIXEL cloud/shadow/snow mask. It targets ASTER GED emissivity artefacts that the cloud mask cannot see: blocky 100 m rectangles at the southern tip (28.09°N 77.48–77.51°E) with emissivity 0.74–0.80, LST up to 69 °C in single scenes, and either ST_QA ≈ 55 K or no uncertainty value at all (ST_QA = 0 — so the uncertainty test alone missed most of them; found by checking the hottest pixel after a first run). Reflectance and the LULC maps are unaffected.
- 2015 summer: 568 pixels lost their LST entirely (0.022% of 2,594,842); 47,297 more changed by > 1 °C; pixels > 55 °C 129 → 15; max land LST 67.8 → 55.5 °C. UHI before → after: core vs ring -0.51 °C → -0.55 °C; built-up vs non-built-up -0.80 °C → -0.80 °C.
- 2015 winter: 525 pixels lost their LST entirely (0.020% of 2,594,842); 180,565 more changed by > 1 °C; pixels > 55 °C 0 → 0; max land LST 45.0 → 34.1 °C. UHI before → after: core vs ring +1.02 °C → +1.06 °C; built-up vs non-built-up +1.33 °C → +1.38 °C.
- 2025 summer: 528 pixels lost their LST entirely (0.020% of 2,594,842); 106,077 more changed by > 1 °C; pixels > 55 °C 32 → 0; max land LST 58.6 → 51.2 °C. UHI before → after: core vs ring +0.59 °C → +0.50 °C; built-up vs non-built-up +0.57 °C → +0.50 °C.
- 2025 winter: 547 pixels lost their LST entirely (0.021% of 2,594,842); 131,899 more changed by > 1 °C; pixels > 55 °C 0 → 0; max land LST 44.1 → 35.3 °C. UHI before → after: core vs ring +1.04 °C → +1.09 °C; built-up vs non-built-up +1.03 °C → +1.05 °C.
- Seasonal ponds: a few pixels classified Water are ponds that are dry in April–June (e.g. 28.62°N 77.47°E; JRC Global Surface Water ≈ 1 month of water per year). Their LST is real; the class is wrong. Water is excluded from all land-LST statistics, so they do not affect the UHI numbers.

**Flags raised by checks.py:**

- **CAUTION** (accuracy): All accuracy figures are AGREEMENT WITH REFERENCE LABELS (held-out GLC-FCS30D stable pixels), not accuracy against ground truth; stable pixels are easier than changing ones, so the figures are optimistic. Independent validation points (outputs/validation) have not been interpreted yet.
- **CAUTION** (LULC change): 2015→2025: 154.8 km² of Agriculture/Cropland became Built-up (incl. bare land), but 95.5 km² went the other way (62% of the forward flow). Built-up → cropland reversals at this scale are mostly class confusion (bare harvested fields are now inside Built-up (incl. bare land)); use the NET conversion (59.4 km²) and net class changes, not the gross transition, as the headline.
- **CAUTION** (story): 2015→2025: Vegetation/Trees area INCREASED (139.3 → 166.8 km², +27.5 km²). This contradicts the expected 'vegetation loss' step; built-up growth here came mainly from cropland, not vegetation.
- **CAUTION** (UHI): summer: the core-vs-ring UHI changes sign between years (2015: -0.55 °C, 2025: +0.50 °C). Both values are small (< 1 °C); one composite per year cannot separate a trend from weather.
- **INFO** (data): 2015: Landsat 8 OLI/TIRS.
- **INFO** (data): 2025: Landsat 8 + 9 OLI/TIRS.
- **INFO** (UHI): 2015 summer (built-up vs non-built-up land): UHI intensity is negative (-0.80 °C) — the urban area is cooler than its surroundings at the ~10:30 overpass (a known daytime 'urban cool island' over dry, bare farmland in pre-monsoon India; Shastri et al., 2017).
- **INFO** (UHI): 2015 summer (urban core vs rural ring): UHI intensity is negative (-0.55 °C) — the urban area is cooler than its surroundings at the ~10:30 overpass (a known daytime 'urban cool island' over dry, bare farmland in pre-monsoon India; Shastri et al., 2017).
- **INFO** (population): GHSL epochs from 2025 are model projections, not census-based estimates.

**Cross-checks run before writing this file (all passed):**

- 2015: class areas re-counted from the raster, sum to the study area, percentages sum to 100; overall agreement = trace / total of the confusion matrix; UHI = urban − rural (4 cases)
- 2025: class areas re-counted from the raster, sum to the study area, percentages sum to 100; overall agreement = trace / total of the confusion matrix; UHI = urban − rural (4 cases)
- 2015→2025: transition-matrix row sums = 2015 class areas and column sums = 2025 class areas (re-counted)
- population table identical to the Earth Engine sums

## 8. Five key findings

1. Built-up land (including bare land) in Noida–Ghaziabad grew from 616 km² (26.4 %) in 2015 to 669 km² (28.7 %) in 2025, a net +53 km² (+9 %), while GHSL population rose +20 % (6.07 → 7.26 million; the 2025 figure is a GHSL projection).
2. Cropland was the main source of new built-up land: 155 km² changed from cropland to built-up, but 95 km² was mapped the other way (mostly class confusion), leaving a net conversion of 59 km² and a net cropland change of -73 km².
3. Vegetation/tree cover did not decline: it changed by +27 km² (139 → 167 km²), so urban growth in this period replaced cropland rather than vegetation and the expected vegetation-loss step is not supported.
4. In the pre-monsoon season (April–June, ~10:30 overpass) the urban core was -0.55 °C relative to its rural ring in 2015 (cool island) and +0.50 °C in 2025 (heat island), small values whose change of sign cannot be separated from weather with one composite per year, whereas November–February showed a consistent heat island (+1.06 °C and +1.09 °C).
5. Cropland that became built-up between 2015 and 2025 changed by -0.01 SD in normalised April–June LST, against -0.11 SD for cropland that stayed cropland, a difference of +0.10 SD (+0.06 °C raw), i.e. slightly warmer than the unchanged class; conversion to built-up did not produce a clear summer temperature change.

## 9. Limitations

- **Accuracy is agreement with reference labels, not true accuracy.** Training and test points come from the same GLC-FCS30D-derived labels, restricted to temporally stable pixels (easier than changing ones) and spatially clustered; the figures are optimistic. Independent, stratified validation points (outputs/validation, 50 per class per year) still have to be interpreted on high-resolution imagery.
- **Built-up includes bare land.** Barren/Open land could not be trained (86 and 14 label pixels) and was merged into Built-up in every year; construction sites and cleared plots therefore count as built-up.
- **Few labels for Vegetation/Trees and Water** (2015: 1,652 and 1,434 label pixels; 2025: 1,625 and 2,786 label pixels), from a limited number of patches; their mapped areas are the least certain.
- **Change maps add the errors of two maps**; small transitions (a few km²) are within classification noise.
- **One overpass time.** Landsat sees ~10:30 local time only; night-time UHI (usually the strongest) is not measured.
- **One composite per season per year.** Year-to-year weather differences affect absolute LST; UHI intensity and normalised LST reduce but do not remove this.
- **Thermal resolution.** LST is 100 m (Landsat 8/9) or 60 m (Landsat 7) resampled to 30 m; small features are smoothed.
- **Rural ring inside the study area.** East Delhi (urban) borders the study area to the west, so the ring is restricted to the districts; its location differs between years with the urban core.
- **GHSL 2025 is a projection**, and GHSL population is itself modelled from census and built-up data (not a count).
- **2005 (once added): Landsat 7 SLC-off** — about 22 % of each scene is missing in stripes; three pooled years fill most gaps, the remainder is reported. No independent label product exists for 2005 (stability filter only), and the sensor differs from 2015/2025 (ETM+ vs OLI).

