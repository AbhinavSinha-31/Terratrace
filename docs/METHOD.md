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
| Historical | 1984, 1990, 1995, 2000, 2005, 2010, 2015 | Landsat 5/7/8/9 Collection 2 Level-2 surface reflectance, multi-year median (e.g. 2005 = 2004–2006; 1984 = 1984–1985) | **None — imagery only** (see §1a) |
| Modern | 2016 → last complete year | Sentinel-2 SR Harmonized annual median + Dynamic World V1 `trees` probability | Dynamic World `trees` (per-pixel 75th percentile, `tt-ee-2.4`) ≥ 0.50 **and** leaf-on NDVI (per-pixel 90th percentile of clear observations, `tt-ee-2.1`) ≥ 0.60 |

* Dynamic World starts mid-2015; it is never back-filled into historical years.
* Sentinel-2 SR Harmonized is sparse before late 2018 outside Europe; such years are reported as
  unavailable, never substituted with another collection (e.g. top-of-atmosphere L1C).
* Forest figures, loss, gain and change events exist for the modern era only.

### 1a. Before 2016: imagery only (decided 2026-10-10)

The only forest measure available for 1984–2015 is Landsat greenness (NDVI ≥ 0.60), and it cannot tell
green crops, pasture or grassland from forest (§8). So for every area — featured sites included — the
Landsat years are shown as **imagery only**: their availability, observed coverage and spectral means are
reported, but **no** forest area, forest share, loss, gain, net change, long-term change period, loss rate,
historical summary or forest-mask tile. The rows carry `forest_withheld: true` with those fields `null`,
and every result and history response carries `historical_statement`, which says why. Forest-mask and
change tiles for years before 2016 are refused (404). This is applied where results leave the backend
(`science.withhold_proxy`), so results stored earlier never expose the proxy and nothing needs recomputing;
the Earth Engine pipeline still computes the proxy internally (it never reaches a response, never decides a
status). Better historical forest measures (options C and E in
[notes/landsat-proxy-options.md](notes/landsat-proxy-options.md)) may replace this once validated.

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

* Dynamic World is a **probability**, not a measured forest percentage. The upper-quartile `trees ≥ 0.50`
  rule depends on enough Dynamic World observations; in persistently cloudy regions Dynamic World may
  observe pixels only 0–3 times a year, and those years are then not analysable.
* The Landsat NDVI ≥ 0.60 proxy (no longer reported, §1a) also saturates in dense tropical vegetation and
  is sensitive to Landsat 7 SLC-off gaps and phenology.
* **The Landsat-era (1984–2015) forest proxy cannot tell green non-forest from forest.** NDVI ≥ 0.60 is a
  greenness test: irrigated crops, green pasture and grassland pass it (Nile delta cropland: 52–63 %
  "forest"). **Consequence: since 2026-10-10 no Landsat-era forest figure is shown anywhere (§1a).**
  Measured 2026-10-10 at the featured sites (proxy forest that independent data call non-forest; the closer
  in time, the more meaningful):

  | Site | Proxy 2000 vs Hansen 2000 (same year): canopy < 30 % | Proxy 2015 vs Dynamic World 2016: not trees | Proxy vs WorldCover 2021: not tree cover |
  |---|---|---|---|
  | Rondônia | 19.3 % | 26.6 % (grass 17.9, shrub 8.4) | 38.8–57.7 % (mostly real clearing since then) |
  | Hasdeo Arand | 50.8 % — Hansen under-counts this dry forest (22 % vs WorldCover 61 %) | 0.0 % | 0.1–3.3 % |
  | Similipal | 3.8 % | 0.0 % | 0.0–0.2 % |
  | Silent Valley | 14.0 % | 3.4 % (shrub 1.8, grass 0.9) | 2.1–5.0 % |

  So the problem is material at the pasture frontier (Rondônia: roughly a fifth to a quarter of the proxy's
  "forest" around 2000–2015 is likely pasture or regrowth), modest at Silent Valley (montane grassland) and
  negligible at Similipal. Hasdeo shows a different weakness — the proxy is unstable (2,930 ha "forest" in
  1990, 53,268 ha in 2000, 5,224 ha in 2010: missed forest, not crops). The interim rule that withheld the
  record only where there was little or no forest (`history_withheld`) was replaced by §1a (option F); the
  other options are kept in [notes/landsat-proxy-options.md](notes/landsat-proxy-options.md).
* An event polygon consists only of pixels that passed the change rule, so its converted share is 1 by
  construction (it is not an independent measurement).

## 9. Area context (reference datasets — not TerraTrace results)

Every area also shows terrain and forest cover from published reference datasets, whatever the state of its
TerraTrace analysis. They are labelled **"Reference context, not a TerraTrace result"**, every value carries its
dataset and year, and they never feed, adjust or replace a TerraTrace measurement. One Earth Engine request per area
([`services/context.py`](../backend/app/services/context.py)), cached per dataset version; a request that fails is
reported as unavailable (never estimated) and measured again later.

| Value | Dataset (Earth Engine ID) | Date | Notes |
|---|---|---|---|
| Elevation (min, 5–95 %, mean, max), mean slope, share steeper than 30° | Copernicus DEM GLO-30, 30 m (`COPERNICUS/DEM/GLO30_2024_1`) | Earth Engine catalogue: version 2024_1, dataset availability 2010-12-01 – 2020-11-13 | Digital Surface Model — "the surface of the Earth including buildings, infrastructure and vegetation" (catalogue), so over forest the elevation includes the canopy. (The radar acquisition years are not stated in the catalogue and are not shown.) The tiles are mosaicked with their own projection before computing slope. `COPERNICUS/DEM/GLO30` is deprecated in the catalogue in favour of this ID. |
| Tree cover, share of land | Hansen Global Forest Change v1.13 (`UMD/hansen/global_forest_change_2025_v1_13`) | **year-2000 baseline** | Canopy ≥ 30 % at 30 m; land = Hansen `datamask` 1. |
| Tree cover loss per year | Hansen GFC v1.13 | **each year 2001–2025** | Within the year-2000 tree cover. Stand-replacing canopy removal (incl. logging, fire, plantation harvest) — not necessarily deforestation; method updates make years not strictly comparable. A year with no loss pixel over the measured area is a measured 0. |
| Tree cover gain | Hansen GFC v1.13 | **2000–2012 only** | Not updated after 2012. |
| Tree cover class, share of land | ESA WorldCover v200, 10 m (`ESA/WorldCover/v200`) | **2021** | Class "Tree cover" (10); mangroves are a separate class; permanent water excluded from the land area. |

None of these is current forest cover, and no "remaining tree cover" is derived (baseline minus loss would ignore
regrowth). The definitions differ and are not comparable with each other or with TerraTrace's forest mask — e.g.
Hasdeo Arand (measured 2026-10-09): Hansen year-2000 tree cover 22.5 % of land, WorldCover 2021 tree cover 61.0 %,
TerraTrace's own 2019 forest mask ~57 %. Map layers (hillshade, slope, Hansen tree cover 2000, Hansen loss year) are
served by `/api/tiles/{aid}/context/{layer}/…` with the same validation, cache and Earth Engine concurrency cap as
the other tile routes.

**Land cover and surface (context version 2).** The context also reports the **ESA WorldCover v200 (2021) land-cover
breakdown** — every class present (tree cover, shrubland, grassland, cropland, built-up, bare / sparse vegetation,
snow and ice, permanent water, herbaceous wetland, mangroves, moss and lichen) as hectares and share of the area
WorldCover maps (water included) — and the Hansen data mask as land / water / no data. From these measured values
only, an area is described as **open water** (no Copernicus land elevation and nothing in WorldCover's map — open ocean
is outside both), **mostly water** or **mostly snow and ice** (≥ half of the WorldCover-mapped area), or land. Hansen's
"no data" (e.g. ice sheets, open ocean) is reported as such, never as zero tree cover. Measured 2026-10-10:
Nile delta, Egypt (30.997° N, 30.849° E): cropland 86.9 %, built-up 10.6 %, tree cover 1.2 %, Hansen 2000 tree cover
< 1 %; open Atlantic (10° S, 30° W): no DEM, no WorldCover, Hansen no data, 0 Sentinel-2 scenes in 2024; Greenland
ice sheet (72° N, 40° W): 3,085–3,112 m, WorldCover snow and ice 100 %, Hansen no data.

## 10. Every location: no forest, little forest, no imagery

Since 2026-10-10 every area on Earth can be opened and analysed; nothing is refused for lack of forest.

* **Change only inside the forest mask.** A change event requires *forest in the baseline year* AND no forest in the
  comparison year AND the spectral and tree-probability tests (`change_mask`); yearly loss requires forest in the
  earlier year. A pixel that was crop, bare soil or water in the baseline can never be reported as change. Gross
  *gain* (non-forest → forest between consecutive years) is kept, stays out of change events and headline totals,
  and carries its own warning when the area has little forest (below).
* **No forest to monitor.** When TerraTrace's forest mask holds **< 2 ha** in the baseline year (one minimum mapping
  unit — the smallest area a change event can have), the analysis completes as READY with the measured forest area
  (possibly 0 ha), 0 events and the statement "There was little or no forest to monitor here". It is a measured
  result, not a failure, and nothing is added to fill the page.
* **Reliability cautions** — display only; they never change a status or a number, and each names the datasets and
  years it compares. The thresholds are **chosen heuristics**, not a standard definition:
  * **Little forest:** forest mask in the baseline year **< 10 % of the observed area or < 100 ha**. Reasoning: below
    roughly a tenth of the area, or a few dozen minimum mapping units, misclassified orchards, irrigated crops or
    wetlands can weigh as much as real forest, and gross gain in particular may reflect such misclassification — so the
    gain figure itself carries "May reflect crop or orchard misclassification, not new forest". (FAO's 10 % canopy
    figure informed the order of magnitude, but this is a pixel-share heuristic on TerraTrace's own mask, not the FAO
    forest definition.)
  * **Datasets disagree:** TerraTrace's forest share and ESA WorldCover v200's tree-cover share differ by **more than
    10 percentage points in the same year (2021**, or the nearest analysable year, which is named). Reasoning: at the
    four featured sites the same-year gap is 0.1–4.6 points (Rondônia 1.9, Hasdeo 4.6, Similipal 0.3, Silent Valley
    0.1), so 10 points flags a real disagreement without flagging areas that agree. Hansen 2000 is shown but is not a
    trigger: it is twenty years older and uses a canopy-density definition (e.g. Rondônia 73.3 % in 2000 vs 40.6 % in
    2021 is real forest loss, not disagreement).
* **No imagery.** Open ocean (Sentinel-2 does not image it) and areas outside Sentinel-2's systematic band (56° S –
  82.8° N) complete at once as UNAVAILABLE with that reason — no Earth Engine analysis work — and the reference context
  is still shown. Areas with too few clear observations are reported as before (insufficient usable imagery).
  **Northern limit 82.8° N** (checked 2026-10-10). ESA's own documents disagree, so the most conservative current
  statement is used: ESA SentiWiki, *S2 Mission* (https://sentiwiki.copernicus.eu/web/s2-mission): "all continental
  land surfaces (including inland waters) between latitudes 56° South and 82.8° North". Other ESA documents give
  84° N (Sentinel-2 User Handbook, ESA Standard Document, Issue 1 Rev 2, 24/07/2015, p. 8; Sentinel Online success
  story "Sentinel-2 images the globe every 5 days", 09/03/2018; ESA *Facts and figures*, which says "between 84°N and
  84°S", contradicting the 56° S limit) or 83° N (the same User Handbook, p. 18). Until 2026-10-10 TerraTrace used
  84° N.
* **One rounding rule for shares** (`services/units.py` / `lib/format.ts`): not measured "—"; a measured 0 "0 %";
  more than 0 but less than 1 "< 1 %"; otherwise one decimal (e.g. "22.5 %"). Shares are stored with four decimals and
  rounded once, at display.

## 11. AI chat — what it may say, and how that is checked

The chat (`POST /api/chat`; "Ask me anything" page, front-page pop-up, Ask tab in the analysis view) is **off by
default** (`TT_CHAT_ENABLED=false`): Gemini API users must be 18+, and the free tier may not serve EEA / UK / Swiss
users (`docs/PRE_DEPLOYMENT.md`). Model `gemini-3.8-flash` (`TT_LLM_MODEL`), Google Gen AI SDK `google-genai==2.29.0`,
one stateless `generate_content` call per question (the Interactions API, which stores conversations by default, is
not used). The key lives only in `backend/.env` (`GEMINI_API_KEY`). Tone: a teacher, plain language for non-experts,
deeper when asked. Scope (prompt `chat-2`, 2026-10-19): forests and forest cover change, Earth observation, land use /
land cover (LULC), NDVI, NDBI and other indices, land surface temperature (LST), urban heat islands (UHI) and TerraTrace;
scope is judged by topic, never by the question's language. Anything else gets a fixed polite decline, in English,
Hindi or Hinglish to match the user (the model's own text is never shown for an out-of-scope request).

**No second model call: every answer is checked deterministically** ([`services/chat/validator.py`](../backend/app/services/chat/validator.py)).
The model must answer in segments, and **one failing segment withholds the whole answer**; the user sees
"Answer withheld: …" with the reason, never the withheld text.

| Segment | May contain | Checked |
|---|---|---|
| `general` — labelled "AI explanation · general knowledge, not TerraTrace data" | Teaching true anywhere; numbers about sensors and indices (10 m pixels, 5-day revisit, NDVI −1…1, launch years) | **No forest-cover or forest-change figure about any place**, and no claim that forest changed in a named place, a possessed place ("my village") or the selected area (rules 1–3) |
| `place` — "From TerraTrace's data for this area" | Only the selected area, only from its facts (TerraTrace result, its cautions, or reference context — each labelled, with dataset and year) | Must cite this area's facts; every number must equal a cited value; no other place (rules 4–6) |
| `reference` — "Method / dataset reference" | A fact from the curated library (`app/data/reference_facts.json`) | Must cite it; numbers must equal its values; no place at all (rule 7) |

1. **Forest figure in a general segment** (`forest_figure_in_general`). Places are **never looked up in a list**: a
   general segment that contains a forest term (forest, deforestation, trees, canopy, woodland, mangrove, logging,
   plantation, vegetation, green cover, biomass, woody, carbon stock, …) **and anywhere in the same segment** a
   quantity is withheld. Quantities: a number (digits or words, "thirty-five") with an area or share unit (%, percent,
   ha, hectares, km², acres, square miles, football fields); "N … of forest" with any unit word ("40 bigha of
   forest"); a count of trees; proportion words (half, halved, a third, a quarter, doubled, tripled, twice, N-fold,
   N times); "most / nearly all / much of" together with a change word; or any other bare number together with a
   change word (except years, values ≤ 1, and numbers followed by a non-area unit: m, km, days, years, °, bands,
   scenes, observations, pixels, percentile).
   **One narrow exemption (2026-10-19)**, because light physics was being withheld as a forest figure (2 of 6 live
   NDVI answers, e.g. "Healthy vegetation absorbs about 90% of red light"): a **percentage, "twice" or "N times"** is
   allowed only if (a) its sentence is about light, sensors or an index (light, red, near-infrared, reflect, absorb,
   wavelength, band, NDVI, NDBI, …), (b) that sentence has no extent word (cover, area, land, share, world, country,
   "of forest"), no change or comparison word (lost, increased, less, more, fewer, …) and no time word (after, before,
   since, now, …), and (c) the **whole segment** names no place (no name, "my village", "this area", "nearby forests")
   and no year. Area units (ha, km², acres), tree counts, "N … of forest" and quantified change are never exempt. The
   prompt also asks for reflectance to be described qualitatively. Adversarial tests:
   `backend/tests/test_chat_validator.py::test_figures_dressed_up_as_physics_stay_withheld`.
2. **Place claim in a general segment** (`place_change_claim_in_general`): within a sentence and the one before it,
   a forest term together with (a) a reference to the selected area ("this area", "the selected site", "your area"),
   or (b) a change word and a possessed place ("my village", "our town") or a capitalised name. A capitalised word
   counts as a possible name unless it is a dataset / sensor / organisation word (Sentinel, Landsat, Hansen, ESA,
   NASA, Earth, …) or, **at the start of a sentence only**, an ordinary English word: a short curated list, or the
   vetted vocabulary `app/data/english_vocabulary.txt` — 37,367 words derived from SCOWL 2020.12.07 (the word lists
   behind GNU Aspell/Hunspell; licence in `app/data/SCOWL_COPYRIGHT.txt`): the common-word lists up to size 35, minus
   every word SCOWL also lists capitalised, so homographs of names ("China", "Turkey", "Reading") stay possible names.
   A possessive ("Delhi's") or a following capitalised word ("Western Ghats") is always a possible name. This is not a
   list of places: a word that is not known to be ordinary is treated as a possible name. "That area" refers to the
   selected area unless the same sentence first introduces an indefinite area it points back to ("how much forest a
   specific area has lost … select that area on the map"); "this area", "the selected area" and "your area" always do.
   (Both refinements, 2026-10-10, fix false positives seen in real Gemini answers; regression tests use those answers
   verbatim.)
3. **A figure in text with no English word** (`non_english`), e.g. "Bosque perdido: 40 %".
4. **Citations** (`uncited_place_claim`): a place segment must cite at least one fact of **this** area. Fact ids are
   rebuilt from the selected area's stored data for every request; another area's facts are never in the list.
5. **Numbers** (`unsupported_number`): every number must equal a cited value after correct rounding (half-up) to the
   decimals written — 22.4525 % may be "22.45 %", "22.5 %" or "22 %", never "23 %". No conversions, sums or
   estimates beyond the km² equivalent provided for each area figure. The unit must match (a "%" is never a hectare
   figure). Years must be a cited fact's years. **Direction:** a loss, gain or signed figure must be stated with its
   direction — a loss / gain word in its own clause, or its sign — so a loss cannot be passed off as a forest area or
   as a gain, and a segment may not say forest increased while citing a negative net change. Unverifiable words
   ("half", "most of", "doubled") are withheld in place segments, and in reference segments unless the cited entry
   itself uses them.
6. **Another place** (`other_place_in_place_segment`): any capitalised name that is not the area's own name, region
   or country (or an allowed dataset word), any possessed place, or "neighbouring / nearby / other districts, areas,
   forests …". **A figure from this area can therefore never be attached to another place, and a figure about
   another place can never be attached to this area's facts.**
7. **Reference segments** (`uncited_reference`, `place_in_reference`): cite library entries only, contain no place,
   and state only those entries' numbers.
8. `malformed` (not the required JSON, too long, unknown kinds) and `prompt_leak` (a random per-process marker or the
   instruction headers appear in the answer) are withheld too.

**Reference library** (15 entries, re-checked one by one 2026-10-10): TerraTrace's own rules from this document (§1,
§1a, §3, §4, §6, §7, §9, §10), dataset facts from each dataset's Earth Engine catalogue page (Hansen GFC v1.13, ESA
WorldCover v200, Dynamic World V1, Sentinel-2 SR Harmonized, Landsat 8 C2 L2, Copernicus DEM GLO-30 2024_1), and
Sentinel-2's coverage band from ESA SentiWiki (56° S – 82.8° N, §10). Left out because they could not be verified: the
DEM's radar acquisition years and WorldCover's tree-cover percentage definition (neither is on its catalogue page). **No global forest statistics.** An entry that
could not be verified is left out — e.g. ESA WorldCover's tree-cover percentage definition is not stated on its
catalogue page.

**Checked in English; shown in Hindi or Hinglish too (decided 2026-10-19).** The patterns are English, so every
segment's `text` is still written and checked in English exactly as before (an English text in another script or
dominated by non-English words is still withheld, `non_english`). When the user's own message is Hindi (Devanagari) or
Hinglish (Hindi in Latin letters) — detected deterministically from their words, not by the model — the model also
returns each segment in that language (`text_local`). `services/chat/translation.py` shows the translations only if
EVERY segment's translation has exactly the same numbers as its checked English segment (Devanagari digits normalised),
adds no capitalised Latin-script word (an added "Delhi"), is in the right script, is not much longer, and carries no
internal marker; otherwise all translations are dropped and the checked English answer is shown with a note. The
English stays one click away under each translated segment. **Accepted limit:** a place name or a quantity written as
a *word* in Devanagari ("दिल्ली", "आधा") cannot be detected in a translation; the English segment it must mirror has
been checked.

**Streaming (progress, not text).** `POST /api/chat/stream` returns the same answer as `POST /api/chat` as
Server-Sent Events: stage events while the model works ("asking", "fallback", "checking"), then one event with the
checked reply. Stage events carry no model text, so nothing unchecked is ever shown; the frontend then reveals the
checked segments one after another. Same request shape, limits and counters as `/api/chat`, which is unchanged.

**Counters and logs.** Outcomes are counted by **code only** (`answered`, `declined`, `withheld` by reason,
`unavailable` by code, e.g. `chat_quota_429`, `chat_cooldown`, `chat_timeout`, `chat_truncated`) in
`cache_dir/chat_counters.json` on the server. `GET /api/chat/stats` serves the same counts but is **off (404) unless
`TT_CHAT_STATS_ENABLED=true`** — there is no admin authentication, so it is for a local machine only. No question,
answer or model text is ever logged, counted or put in an error message; provider errors are reduced to a code, and
only the finish reason and token counts of an answer are logged.

**Provider behaviour.** One request per question: the SDK is set to a single attempt, so a 429 (quota) or a timeout
is never retried. After a 429, no request is sent to Gemini for `TT_CHAT_COOLDOWN_S` (60 s): questions get "busy, try
again shortly" at once. The one exception is a 503 ("this model is experiencing high demand", seen for every full Flash
model on 2026-10-15): the question is sent once more to `TT_LLM_FALLBACK_MODEL` (default `gemini-3.5-flash-lite`;
empty = none), and its answer goes through exactly the same checks. If the fallback is also overloaded the user sees
"busy, try again shortly", not "not available". An answer cut off by the output limit (`finish_reason` MAX_TOKENS) is a provider failure ("not available right
now"), not a withheld answer. Thinking level `low` (`TT_LLM_THINKING`; "minimal" is rejected by gemini-3.8-flash),
output budget 8,192 tokens, timeout 60 s (`TT_CHAT_TIMEOUT_S`).

**Limits** (conservative defaults until the project's real Gemini limits are read from AI Studio): 6 questions per
minute and 60 per day per client; 8 per minute and 200 per UTC day for the whole backend (Google's day ends at midnight
Pacific — `docs/PRE_DEPLOYMENT.md` item 7); at most 8 messages of 1,000 characters, 4,000 in all. The counters are in-process (`docs/PRE_DEPLOYMENT.md` item 3: behind a proxy they
count per proxy, not per user).

**Live validation status (2026-10-10, gemini-3.8-flash, free tier).** 20 real requests: 5 answers reached the
validator (2 answered, 3 withheld: two false positives — since fixed, above — and one answer cut off by the output
limit, now treated as a provider failure); 8 timed out; 2 got 429 (quota); 5 were refused during the cool-down. **Not
yet validated live: questions about a selected featured area (place segments) and reference questions (reference
segments)** — every attempt timed out or hit the quota. The live test (`backend/tests_live/`, opt-in only) must be
re-run before the chat is enabled for anyone.

**Known ways something could still get through** (pinned by `test_known_gaps_still_pass_as_documented`):

* **General teaching is labelled, not fact-checked.** "Sentinel-2 has 20 m resolution" (wrong) passes as an AI
  explanation.
* **Figures about a place that are not about forest** pass in general segments ("Delhi has 10 million people").
* **Claims without a figure** about a place written in lower case ("the amazon rainforest is shrinking"), or about
  "Earth", pass: name detection relies on capitals, and "Earth" is allowed for global teaching.
* **Wording outside the patterns:** a forest figure that uses no listed forest term (e.g. "green belt", "orchards"),
  a quantity form not covered (Roman numerals, digits split by letters, an unlisted unit word without "of forest" and
  without a change word), a figure in a short non-English phrase that still contains an English function word, or a
  sentence-initial place name that SCOWL does not list capitalised (a small place whose name is an ordinary English
  word) in a claim without a figure.
* **Meaning inside a place segment is checked only for value, unit, year and direction.** A correct cited number can
  still be described loosely (gross loss transitions called "deforestation"), and qualitative statements ("the forest
  is healthy") must cite a fact but are not verified against it.
* **Reference segments** may paraphrase a cited entry inaccurately if they state no number.

## 12. Land cover, urban expansion, heat and carbon (quick scans) — and year limits

These are TerraTrace measurements from public datasets (see docs/QUICKSCAN_PLAN.md for the full rules); they are
labelled "agreement, not accuracy" and are never mixed with the forest figures above.

| Measurement | Dataset | First year | Rule |
|---|---|---|---|
| Satellite imagery | Landsat Collection 2 | 1984 | imagery only |
| Satellite imagery | Sentinel-2 SR Harmonized | 2017 | imagery only |
| Forest and forest change | Sentinel-2 + Dynamic World | 2016 | sections 1–7 |
| Land cover (LULC) | Dynamic World V1 | 2016 (first full year) | annual mean probability, top class, 30 m mode |
| Land surface temperature | Landsat 8 (from 2013) and 9 (from late 2021), C2 L2 `ST_B10` | 2013 | median of ≥ 5 clear scenes per season |
| Above-ground biomass carbon (estimate) | ESA CCI Biomass v6.0 × 0.47 | 2007, 2010, 2015–2022 | change measured 2015 → 2022 |

- **Study-design classes.** Forest (trees), Cropland (crops), Built-up (built), Water, Barren (bare), Grass/Shrub
  (grass + shrub and scrub); flooded vegetation and snow/ice are listed separately.
- **Urban expansion** = the change in Dynamic World *built* area between two annual scans of the same area and season:
  a net change in mapped area per class, not a pixel-by-pixel transition map.
- **Surface urban heat island** = mean daytime LST of built-up land − mean LST of a reference, area-weighted, water
  excluded: (a) all other land; (b) vegetated land only (trees, crops, grass, shrub, flooded vegetation; bare ground
  excluded). Reported only when built-up land is ≥ 5 % of the land and ≥ 2 km² (and the reference ≥ 2 km²). Landsat
  passes at about 10:30 local time: a surface, not an air, temperature.
