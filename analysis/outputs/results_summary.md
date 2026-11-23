# Results summary — Noida, Greater Noida and Ghaziabad (Delhi NCR)

Generated 2026-11-24 by the TerraTrace analysis pipeline v1.0.2 from `outputs/tables/*.csv` (years 2015, 2025). Every result is read from those tables; none is typed by hand. Contextual figures from other sources are cited.

## 1. Study setup

- **Study area:** Noida, Greater Noida and Ghaziabad (Delhi NCR) — FAO GAUL 2025 districts Gautam Buddha Nagar + Ghaziabad, 2,335 km² (the sum of the classified 30 m pixels).
- **Years and sensors:** 2015: Landsat 8; 2025: Landsat 8 + Landsat 9 — Landsat Collection 2 Level-2, Tier 1, 30 m.
- **Scenes used:** April–June 2015: 17, whole year 2015: 56; April–June 2025: 29, whole year 2025: 101.
- **Classes (4):** Built-up and bare land, Vegetation/Trees, Agriculture/Cropland, Water (Barren/Open land merged into Built-up in every year). Random Forest (Breiman, 2001), 200 trees; points (600 per class, 70/30 per class): 2015: 1680 training / 720 test; 2025: 1680 training / 720 test.
- **Reference labels (training and test):** 2015 map — GLC-FCS30D 2015 class, unchanged in every year 2013–2017, agreeing with Dynamic World 2016; 2025 map — GLC-FCS30D 2022 class, unchanged in every year 2020–2022, agreeing with ESA WorldCover 2021, agreeing with Dynamic World 2025.

**Scenes per calendar month and median acquisition date** (scenes that passed the 60 % scene cloud filter; clouds inside them are masked per pixel; neighbouring path/rows on one date count as separate scenes):

| Composite | Scenes per month | Total | Median acquisition date |
|---|---|---:|---|
| April–June 2015 | Apr 6 · May 6 · Jun 5 | 17 | 10 May 2015 |
| April–June 2025 | Apr 12 · May 11 · Jun 6 | 29 | 6 May 2025 |

## 2. Classification quality

- **2015:** overall agreement with reference labels **91.4%**, kappa **0.885** (720 held-out points). Most confused pairs: Vegetation/Trees ↔ Water: 20 of 720 test points (10 Vegetation/Trees → Water, 10 the other way); Vegetation/Trees ↔ Agriculture/Cropland: 15 of 720 test points (11 Vegetation/Trees → Agriculture/Cropland, 4 the other way).
- **2025:** overall agreement with reference labels **94.6%**, kappa **0.928** (720 held-out points). Most confused pairs: Vegetation/Trees ↔ Agriculture/Cropland: 11 of 720 test points (7 Vegetation/Trees → Agriculture/Cropland, 4 the other way); Vegetation/Trees ↔ Water: 10 of 720 test points (4 Vegetation/Trees → Water, 6 the other way).
- These figures measure agreement with labels derived from GLC-FCS30D (stable pixels, agreeing with an independent product), **not accuracy against ground truth**; see Limitations.

## 3. Land-cover change (core result)

| Class | 2015 km² | 2015 % | 2025 km² | 2025 % |
|---|---:|---:|---:|---:|
| Built-up and bare land | 616.3 | 26.4 | 669.3 | 28.7 |
| Vegetation/Trees | 139.3 | 6.0 | 166.8 | 7.1 |
| Agriculture/Cropland | 1,544.9 | 66.2 | 1,472.0 | 63.0 |
| Water | 34.8 | 1.5 | 27.3 | 1.2 |

**Change 2015 → 2025:**

- Built-up and bare land: +52.9 km² (+2.3 percentage points; +9 % relative)
- Vegetation/Trees: +27.5 km² (+1.2 percentage points; +20 % relative)
- Agriculture/Cropland: -72.9 km² (-3.1 percentage points; -5 % relative)
- Water: -7.6 km² (-0.3 percentage points; -22 % relative)
- Top 3 transitions (474.9 km² changed class in total): **154.8 km² of Agriculture/Cropland became Built-up and bare land** (33% of all change); **95.5 km² of Built-up and bare land became Agriculture/Cropland** (20% of all change); **75.9 km² of Agriculture/Cropland became Vegetation/Trees** (16% of all change).
- Gross flows per class (km² the same class in both years / lost to other classes / gained from them): Built-up and bare land 483.5 / 132.8 / 185.8; Vegetation/Trees 52.7 / 86.7 / 114.1; Agriculture/Cropland 1,309.8 / 235.1 / 162.3; Water 14.5 / 20.3 / 12.7.
- Land that became Built-up and bare land: 185.8 km² in total — 154.8 km² from Agriculture/Cropland (83%), 21.7 km² from Vegetation/Trees (12%), 9.3 km² from Water (5%).
- Built-up and bare land that changed to another class: 132.8 km² (31.0 km² to Vegetation/Trees, 95.5 km² to Agriculture/Cropland, 6.3 km² to Water). Built-up rarely returns to cropland in reality; most of this is confusion between bare harvested fields (inside the merged Built-up class) and cropland, so the gross transitions overstate change; **use the net figures**.

## 4. Population

- 2015: 6.07 million residents (GHSL GHS-POP P2023A).
- 2025: 7.26 million residents (GHSL GHS-POP P2023A) — **GHSL model projection, not a census-based estimate**.
- 2015 → 2025: population +19.5 %; built-up area (this study) +8.6 %; GHSL built-up surface +18.2 %. Built-up land per resident: 102 m² → 92 m² (population grew faster than built-up area).
- Only two (later three) time points: this describes co-occurring growth, not a statistical relationship or cause.

## 5. Quality control

- Seasonal ponds: a few pixels classified Water are ponds that are dry in April–June (e.g. 28.62°N 77.47°E; JRC Global Surface Water ≈ 1 month of water per year); for the April–June composite their class is wrong.

**Flags raised by checks.py:**

- **CAUTION** (accuracy): All accuracy figures are AGREEMENT WITH REFERENCE LABELS (held-out GLC-FCS30D stable pixels), not accuracy against ground truth; stable pixels are easier than changing ones, so the figures are optimistic. Independent validation points (outputs/validation) have not been interpreted yet.
- **CAUTION** (LULC change): 2015→2025: 154.8 km² of Agriculture/Cropland became Built-up and bare land, but 95.5 km² went the other way (62% of the forward flow). Built-up → cropland reversals at this scale are mostly class confusion, because bare harvested fields are counted in Built-up and bare land; use the NET conversion (59.4 km²) and net class changes, not the gross transition, as the headline.
- **CAUTION** (LULC change): 2015→2025: only 52.7 km² (38%) of the 139.3 km² mapped as Vegetation/Trees in 2015 is Vegetation/Trees again in 2025 (threshold 50%); 86.7 km² was lost to other classes and 114.1 km² gained from them. The net change (+27.5 km²) is a small difference between these large gross flows, which include class confusion, so it is uncertain.
- **CAUTION** (LULC change): 2015→2025: only 14.5 km² (42%) of the 34.8 km² mapped as Water in 2015 is Water again in 2025 (threshold 50%); 20.3 km² was lost to other classes and 12.7 km² gained from them. The net change (-7.6 km²) is a small difference between these large gross flows, which include class confusion, so it is uncertain.
- **INFO** (data): 2015: Landsat 8 OLI/TIRS.
- **INFO** (data): 2025: Landsat 8 + 9 OLI/TIRS.
- **INFO** (scenes): April–June 2015 vs April–June 2025: scene timing checked — the largest difference in a month's share of the scenes is 9 percentage points (Jun: 29% vs 21%), within the 15-point limit.
- **INFO** (population): GHSL epochs from 2025 are model projections, not census-based estimates.

**Cross-checks run before writing this file (all passed):**

- 2015: class areas re-counted from the raster, sum to the study area (2,335.4 km²), percentages sum to 100; overall agreement = trace / total of the confusion matrix; scene counts, scenes per month and median dates re-counted from the saved scene lists
- 2025: class areas re-counted from the raster, sum to the study area (2,335.4 km²), percentages sum to 100; overall agreement = trace / total of the confusion matrix; scene counts, scenes per month and median dates re-counted from the saved scene lists
- 2015→2025: transition-matrix row sums = 2015 class areas and column sums = 2025 class areas (re-counted); per class, stable + lost = first-year area and gained − lost = net change
- population table identical to the Earth Engine sums

## 6. Key findings

1. Built-up and bare land in Noida–Ghaziabad grew from 616 km² (26.4 %) in 2015 to 669 km² (28.7 %) in 2025, a net +53 km² (+9 %), while GHSL population rose +20 % (6.07 → 7.26 million; the 2025 figure is a GHSL projection).
2. Cropland was the main source of new built-up land: 155 km² changed from cropland to built-up, but 95 km² was mapped the other way (mostly class confusion), leaving a net conversion of 59 km² and a net cropland change of -73 km².
3. Vegetation/Trees changed by a net +27 km² (139 → 167 km²), but the gross flows are much larger: only 52.7 km² (38% of the 2015 area) was Vegetation/Trees in both years, 86.7 km² was lost to other classes and 114.1 km² gained from them; the net +27 km² is a small difference between these flows, which include class confusion, so it is uncertain.

## 7. Limitations

- **Accuracy is agreement with reference labels, not true accuracy.** Training and test points come from the same GLC-FCS30D-derived labels, restricted to temporally stable pixels (easier than changing ones) and spatially clustered; the figures are optimistic. Independent, stratified validation points (outputs/validation, 50 per class per year) still have to be interpreted on high-resolution imagery. Areas are pixel counts of the maps; error-adjusted area estimates with confidence intervals, the recommended practice (Olofsson et al., 2014), have not yet been made, because they need those validation points.
- **Built-up and bare land are one class.** Barren/Open land could not be trained (86 and 14 label pixels), so in every year it was merged with built-up land into one class, Built-up and bare land; construction sites and cleared plots therefore count as built-up.
- **Few labels for Vegetation/Trees and Water** (2015: 1,652 and 1,434 label pixels; 2025: 1,625 and 2,786 label pixels), from a limited number of patches; their mapped areas are the least certain.
- **Change maps add the errors of two maps**; small transitions (a few km²) are within classification noise, and a class whose gross gains and losses are large next to its net change has an uncertain net change (Vegetation/Trees: 52.7 km² stable, 86.7 lost, 114.1 gained, net +27.5 km²; Water: 14.5 km² stable, 20.3 lost, 12.7 gained, net -7.6 km²).
- **The April–June composites differ between years.** The 2015 land-cover map is built from Landsat 8 only (17 scenes that passed the cloud filter), the 2025 map from Landsat 8 + Landsat 9 (29 scenes), so the 2025 composite draws on more clear observations per pixel; the classification was not adjusted for this.
- **Reference-label years differ from the map years.** The labels used to train and test each map are not all from the map's own year: the 2015 map used Dynamic World 2016 (1 year after the map year); the 2025 map used GLC-FCS30D 2022 (3 years before the map year); the 2025 map used ESA WorldCover 2021 (4 years before the map year). GLC-FCS30D ends in 2022, so the 2025 map was trained and tested only on pixels whose class was stable in 2020–2022; land that changed after that can carry an out-of-date label, which also makes that map's agreement figure less meaningful.
- **GHSL 2025 is a projection**, and GHSL population is itself modelled from census and built-up data (not a count).
- **2005 (once added): Landsat 7 SLC-off** — about 22 % of each scene is missing in stripes; three pooled years fill most gaps, the remainder is reported. No independent label product exists for 2005 (stability filter only), and the sensor differs from 2015/2025 (ETM+ vs OLI).

