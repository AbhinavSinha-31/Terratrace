# TERRATRACE scientific method — `tt-ee-2.4`

Every number TERRATRACE shows comes from a completed **Google Earth Engine** analysis that
passed the validity rules below. Nothing is simulated, estimated, interpolated or clamped.
Rules and thresholds live in [`backend/app/services/science.py`](../backend/app/services/science.py);
the Earth Engine implementation is [`backend/app/providers/earth_engine/provider.py`](../backend/app/providers/earth_engine/provider.py).
Changing any rule requires bumping `METHOD_VERSION`; cached results from another version are
never reused (they are deleted at startup and rejected on load).

## 1. Sensor eras

| Era | Years | Imagery | Forest definition |
|---|---|---|---|
| Historical | 1984, 1990, 1995, 2000, 2005, 2010, 2015 | Landsat 5/7/8/9 Collection 2 Level-2 surface reflectance, multi-year median (e.g. 2005 = 2004–2006; 1984 = 1984–1985) | NDVI ≥ 0.60 (30 m proxy) |
| Modern | 2016 → last complete year | Sentinel-2 SR Harmonized annual median + Dynamic World V1 `trees` probability | Dynamic World `trees` (per-pixel 75th percentile, `tt-ee-2.4`) ≥ 0.50 **and** leaf-on NDVI (per-pixel 90th percentile of clear observations, `tt-ee-2.1`) ≥ 0.60 |

* Dynamic World starts mid-2015; it is never back-filled into historical years.
* Sentinel-2 SR Harmonized is sparse before late 2018 outside Europe; such years are reported as
  unavailable, never substituted with another collection (e.g. top-of-atmosphere L1C).
* The two forest definitions are **not comparable**: loss/gain are only computed between years of
  the same era, and the historical summary is never subtracted from the modern one.

## 2. Cloud masking

* Sentinel-2: Cloud Score+ `cs_cdf ≥ 0.60`. Scenes without a Cloud Score+ match are excluded.
* Landsat: `QA_PIXEL` dilated-cloud, cloud and cloud-shadow bits.
* Dynamic World carries its own cloud handling (it is only produced for sufficiently clear scenes).

## 3. No-data handling

* An empty source collection is never composited (a composite of nothing has no bands). The year is
  reported in `unavailable_years` with the exact reason and scene counts.
* A pixel is **observed** in a year only with ≥ 3 clear observations (`MIN_PIXEL_CLEAR_OBS`) and, in the
  modern era, ≥ 3 Dynamic World observations (`MIN_PIXEL_DW_OBS`). Rationale: a median needs ≥ 3 values to
  reject a single missed cloud/shadow; a tree-probability statistic from 1–2 scenes is noise.
* The forest mask is **masked** (no-data) where a pixel is not observed. Unobserved is never treated as
  non-forest; reducers sum/average observed pixels only. The only `unmask(0)` in the pipeline is on
  observation **counts**, where 0 is a measured fact.
* Missing statistics are `null`, never 0. A 0 always means a measured zero.

## 4. Observation coverage

For every composite year: scene counts per source, median clear observations, median Dynamic World
observations, and **coverage** = observed area ÷ AOI area. Scene counts are *not* coverage: a year can
have 150 scenes and still leave most pixels without clear views.

A year is **analysable** only if coverage ≥ 80 % (`MIN_YEAR_COVERAGE`) — below that, AOI-level figures
would describe a fragment of the area. Non-analysable years carry no forest/loss/gain values; the UI
says *"Insufficient clear observations"*, never *"no change"*.

**Seasonal coverage (`tt-ee-2.2`, modern era).** The forest test uses *leaf-on* NDVI, an upper percentile
over the whole year, so a year must sample the whole phenological cycle. A modern year is analysable only
if, in **every calendar quarter**, ≥ 80 % of the AOI (the same `MIN_YEAR_COVERAGE`; no new constant) has at
least one clear Sentinel-2 observation. Reported per year as `seasonal_coverage_pct` (Jan–Mar … Oct–Dec).
A quarter without any scene is a measured zero (an empty collection is never composited; one fully masked
image keeps the band defined and contributes no observation).

*Why:* the Sentinel-2 SR archive has no July–September 2018 scenes over Hasdeo Arand or Silent Valley and
no usable January–March 2018 scenes over Rondônia (measured 2026-10-07). With only dry-season scenes,
deciduous forest fails the leaf-on test, so 2018 under-counted forest and 2018→2019 showed spurious
"gain" (Hasdeo: 7.0 % of the area). Every 2019–2025 year passes at all four featured sites. This rule does
not apply to imagery *display*, but imagery availability reports it per year as `analysable` (with the
reason), so the analysis-window selector offers only years an analysis can use.

**Upper-quartile tree probability (`tt-ee-2.4`, modern era).** A pixel's Dynamic World `trees` value for
the forest test is the per-pixel **75th percentile** of the year's observations (`FOREST_TREE_PERCENTILE`):
it is tree-covered only if at least a quarter of its observations say so. The NDVI half is unchanged
(leaf-on 90th percentile, `tt-ee-2.1`), as are both thresholds and the 5 %/yr gain-plausibility limit.

*Why.* The annual *mean* (`tt-ee-2.2` and earlier) sat near 0.50 for deciduous sal forest, because leaf-off
dry-season scenes pull it down, so pixels flipped with each year's mix of clear scenes (Hasdeo Arand
2019→2020: 8.2 %/yr "gain", then 6.0 % "loss"; forest share 45.7 → 53.3 → 47.7 %). Re-weighting the
seasons did not help (July–September has almost no Dynamic World scenes in any year). `tt-ee-2.3` used the
90th percentile, which fixed Hasdeo but **failed at Rondônia** (6.8 %/yr): on an evergreen pasture
frontier a few transient high-probability scenes flip pasture and regrowth. `tt-ee-2.3` results were never
published and are discarded. Every candidate was measured on Earth Engine at all four featured sites
(2026-10-09, analysable years 2019–2025; Similipal 2018–2025; consecutive analysable pairs). Maximum gross
forest gain per year:

| DW statistic | Hasdeo (deciduous) | Rondônia (frontier) | Similipal | Silent Valley | |
|---|---|---|---|---|---|
| annual mean (≤ 2.2) | **8.18 %** | 4.62 % | 3.87 % | 4.64 % | fails Hasdeo |
| 90th percentile (2.3) | 3.69 % | **6.82 %** | 0.52 % | 1.06 % | fails Rondônia |
| **75th percentile (2.4)** | 3.14 % | 3.82 % | 0.63 % | 2.35 % | stable at all four |
| median | **5.74 %** | 2.82 % | 2.50 % | **5.30 %** | fails two |
| highest quarterly mean | 3.49 % | **9.00 %** | 0.74 % | 1.84 % | fails Rondônia |

The 75th percentile was chosen from these candidates on Hasdeo and Rondônia and then checked on the other
two sites as hold-outs (Similipal and Silent Valley: maximum gain 0.63 % and 2.35 %). It is an empirical
choice on four sites, not a universal calibration; other ecosystems may still fail the plausibility rule,
and are then reported as INVALID_ANALYSIS, never adjusted. The annual-mean `trees` band is still used,
unchanged, as change *evidence* (Δ tree probability ≤ −0.30) and in event reports.

## 5. Statistics (what each number means)

| Field | Calculation |
|---|---|
| `forest_ha` | Σ pixel area of forest pixels among **observed** pixels (analysable years only) |
| `forest_pct` | `forest_ha` ÷ observed area × 100 — share of the **observed** area |
| `loss_ha` / `gain_ha` | Forest→non-forest / non-forest→forest pixel area between `previous_year` and the year, over pixels observed in **both** |
| `compared_ha` | Area observed in both years (where loss/gain were measured) |
| `previous_year` | The previous **analysable** year of the same era; a gap (e.g. 2015→2019) shows skipped years explicitly |
| `mean_ndvi`, `mean_nbr` | Mean over observed pixels; `null` if none |
| `kpis.net_change_ha` / `_pct` | Direct baseline→comparison comparison over pixels observed in both years (not a subtraction of areas with different coverage) |
| `kpis.total_loss_ha` / `total_gain_ha` | Sum of measured annual transitions inside the window |

## 6. Change detection (events)

Only between the first and last **analysable modern** years inside the requested window (reported as
`analyzable_window` next to `requested_window`), and only on pixels observed in both:
`forest(t−1) ∧ ¬forest(t) ∧ [ΔNDVI ≤ −0.20 ∨ ΔNBR ≤ −0.25] ∧ Δtree-probability ≤ −0.30`, minimum mapping
unit 2 ha. Persistence is checked only against an analysable following year. Severity and the evidence
score are unchanged (see `METHOD` in `science.py`).

## 7. Status and invalid-result conditions

| Status | Meaning |
|---|---|
| `READY` | Real imagery, sufficient observations, every statistic measured, every validity rule passed |
| `UNAVAILABLE` | Earth Engine not configured, no imagery, or fewer than two analysable modern years in the window |
| `INVALID_ANALYSIS` | The computation finished but failed a validity rule — results are withheld, not shown as findings |
| `ERROR` | Earth Engine failed or timed out |
| `PROCESSING` | An analysis job is running (real stages: VALIDATING → PREPARING_IMAGERY → MEASURING_OBSERVATION_COVERAGE → [MEASURING_FOREST_COVER] → DETECTING_CHANGE → VALIDATING_RESULT) |
| `NOT_RUN` | (`/api/analysis-status`) no analysis stored for this window and none running |

The UI labels these *Analysis ready*, *Live analysis unavailable*, *Scientific validation required*
(`INVALID_ANALYSIS`), *Analysis failed* (`ERROR`), *Processing* and *Not run*. A job's terminal state is
final: it never changes afterwards (e.g. a timed-out job never becomes READY). Its computation may still
finish and is then cached, so a retry returns it without recomputing.

`INVALID_ANALYSIS` when, for any analysable year or transition (tolerance 1 % for 30 m rasterisation along
the AOI boundary; values are **never clamped**):

* any area is negative;
* forest area exceeds the AOI, or `forest_pct` is outside 0–100 %;
* loss or gain exceeds the compared area (≤ AOI area);
* cumulative loss in the window exceeds initial forest plus measured gain;
* forest **gain** exceeds 5 % of the compared area per year (`MAX_ANNUAL_GAIN_FRACTION`). Tree canopy
  cannot establish over large areas within a year; such gain signals an unstable forest classification
  (cloud, phenology or sensor artefacts), which makes the same classifier's loss figures untrustworthy.
  The two halves of the forest mask are measured separately (% of the observed area with Dynamic World
  tree probability ≥ 0.50, and with leaf-on NDVI ≥ 0.60); the issue names the component that moved
  (`evidence.driver`, `evidence.component_change_pts`). Example: Hasdeo Arand 2019→2020 — tree probability
  +9.7 pts, leaf-on NDVI +2.3 pts, imagery complete: an instability of the Dynamic World classification, so
  the result stays withheld.

Observation quality (coverage table, reasons, failed checks) is returned for every status, because it
is measured metadata — not a forest or change measurement.

## 8. Known limitations

* Dynamic World is a **probability**, not a measured forest percentage. The leaf-on `trees ≥ 0.50`
  rule depends on enough Dynamic World observations; in persistently cloudy regions Dynamic World may
  observe pixels only 0–3 times a year, and those years are then not analysable.
* The Landsat NDVI ≥ 0.60 proxy saturates in dense tropical vegetation and is sensitive to Landsat 7
  SLC-off gaps and phenology; the gain-stability rule is what exposes this.
* An event polygon consists only of pixels that passed the change rule, so its converted share is 1 by
  construction (it is not an independent measurement).
