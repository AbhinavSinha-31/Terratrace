# TERRATRACE scientific method — `tt-ee-2.0`

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
| Modern | 2016 → last complete year | Sentinel-2 SR Harmonized annual median + Dynamic World V1 annual mean | Dynamic World mean `trees` ≥ 0.50 **and** NDVI ≥ 0.60 |

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
  reject a single missed cloud/shadow; an annual mean tree probability from 1–2 scenes is noise.
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
| `PROCESSING` | Reserved for asynchronous runs |

`INVALID_ANALYSIS` when, for any analysable year or transition (tolerance 1 % for 30 m rasterisation along
the AOI boundary; values are **never clamped**):

* any area is negative;
* forest area exceeds the AOI, or `forest_pct` is outside 0–100 %;
* loss or gain exceeds the compared area (≤ AOI area);
* cumulative loss in the window exceeds initial forest plus measured gain;
* forest **gain** exceeds 5 % of the compared area per year (`MAX_ANNUAL_GAIN_FRACTION`). Tree canopy
  cannot establish over large areas within a year; such gain signals an unstable forest classification
  (cloud, phenology or sensor artefacts), which makes the same classifier's loss figures untrustworthy.

Observation quality (coverage table, reasons, failed checks) is returned for every status, because it
is measured metadata — not a forest or change measurement.

## 8. Known limitations

* Dynamic World is a **probability**, not a measured forest percentage. The annual mean `trees ≥ 0.50`
  rule depends on enough Dynamic World observations; in persistently cloudy regions Dynamic World may
  observe pixels only 0–3 times a year, and those years are then not analysable.
* The Landsat NDVI ≥ 0.60 proxy saturates in dense tropical vegetation and is sensitive to Landsat 7
  SLC-off gaps and phenology; the gain-stability rule is what exposes this.
* An event polygon consists only of pixels that passed the change rule, so its converted share is 1 by
  construction (it is not an independent measurement).
