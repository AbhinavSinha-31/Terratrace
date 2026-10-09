# Landsat-era forest proxy: fix options (decision pending)

**Problem.** For 1984–2015 TerraTrace's "forest" is Landsat NDVI ≥ 0.60 — a greenness test. Irrigated crops,
green pasture and grassland pass it (Nile delta cropland: 52–63 % "forest"). Measured at the featured sites
(METHOD.md §8): Rondônia 19–27 % of proxy forest is likely pasture/regrowth, Silent Valley 3–14 %, Similipal
≤ 4 %; Hasdeo shows instability (missed forest) rather than crops. Interim measure in place: the 1984–2015 record
is withheld where the window has little or no forest. Nothing below is implemented.

| Option | What it does | Gains | Costs / risks |
|---|---|---|---|
| **A. Keep interim + per-area check** | Keep the proxy; add a contemporaneous check (proxy 2000 vs Hansen 2000, proxy 2015 vs Dynamic World 2016) and withhold or caution the historical record when they disagree beyond a threshold | Small change; uses data already in use; honest flagging | New threshold to choose; Hansen under-counts dry forest (Hasdeo would be flagged for Hansen's error, not the proxy's); doesn't fix the proxy |
| **B. Mask the proxy with Hansen** | Historical forest = NDVI ≥ 0.60 AND Hansen 2000 canopy ≥ 30 % (and, after 2000, not yet lost per Hansen) | Removes most crops/pasture at once | Loses real pre-2000 clearing (cleared pixels have low 2000 canopy); erases dry forest Hansen misses (Hasdeo's 22 % vs 61 %); ties history to one external product |
| **C. Better spectral rule** | Replace NDVI ≥ 0.60 with a multi-feature rule (e.g. SWIR/NBR plus intra-year NDVI amplitude: crops and pasture swing, evergreen forest is stable) | Stays a TerraTrace measurement; works everywhere | New thresholds need calibration and validation; deciduous forest also swings seasonally (confusion with crops); weeks of work |
| **D. Train on the modern era** | Train a classifier on Landsat pixels labelled by Dynamic World/WorldCover (2016–2021) and apply it to 1984–2015 | Learns crops vs forest from real labels | Largest effort; temporal transfer (sensors, climate) unproven; needs a validation set; Earth Engine quota cost |
| **E. Use a long land-cover product** | Use an existing multi-decade product (candidates to verify in the catalogue: MapBiomas for Brazil, ESA CCI Land Cover 1992–2020 at 300 m, GLAD land-cover change 2000–2020 at 30 m) | Peer-reviewed, validated | Coverage, resolution and years differ by product (CCI 300 m is coarse for 100 km² areas; MapBiomas Brazil-only); different forest definitions; years before each product's start remain uncovered |
| **F. Stop quantifying before 2016** | Show 1984–2015 Landsat **imagery** only; no historical forest figures or change periods | Simplest; nothing misleading can appear | Loses the quantitative Time Machine story (four decades of forest numbers) |

**Suggested path to discuss:** F (or A) now for the Expo — honest and cheap — and E or C as a later, validated
improvement. B is not recommended (systematically erases dry forest and pre-2000 clearing).
