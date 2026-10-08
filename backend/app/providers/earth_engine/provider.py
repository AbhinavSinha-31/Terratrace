"""LIVE provider: Google Earth Engine analysis (server-side only).

Pipeline (per AOI) — rules and thresholds live in services/science.py (method version there):
  0. Scene counts per composite; empty periods are reported unavailable, never composited.
  Modern era          COPERNICUS/S2_SR_HARMONIZED (Earth Engine catalogue: 2017-03-28 onward; a year is composited only
                       where scenes exist), Cloud Score+ masked (cs_cdf ≥ 0.6), calendar-year (1 Jan–31 Dec) composites
                       + GOOGLE/DYNAMICWORLD/V1 annual mean "trees" probability and modal label
                       forest = trees ≥ 0.50 AND leaf-on NDVI (per-pixel 90th percentile) ≥ 0.60
  Historical (1984–2015) Landsat Collection 2 Level-2 (L5/L7/L8/L9), QA_PIXEL cloud/shadow masked,
                       multi-year median composites; forest proxy = NDVI ≥ 0.60 at 30 m (no Dynamic World)
  1. Observation coverage: a pixel is observed only with enough clear (and Dynamic World) observations;
     forest is MASKED where unobserved. Years below the coverage threshold are not analysed.
  2. Statistics over observed pixels only; loss/gain only between analysable years of the same era,
     over pixels observed in both. `science.evaluate` decides READY / UNAVAILABLE / INVALID_ANALYSIS.
  Change (baseline→comparison, modern era, READY only)
                       forest(before) ∧ ¬forest(after) ∧ [ΔNDVI ≤ −0.20 ∨ ΔNBR ≤ −0.25] ∧ Δtrees ≤ −0.30
                       → minimum mapping unit (2 ha) → polygons → per-polygon statistics
  Reference            Hansen GFC v1.13 (UMD/hansen/global_forest_change_2025_v1_13) loss year
                       (independent cross-check, not ground truth)

Nothing here runs in the browser; the frontend only receives the TERRATRACE
contract (summary / events / layers) and tile URLs proxied by this backend.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path
from typing import Any

from ...config import settings
from ...lru import LRUDict
from ...services import science as sc
from ...services.geometry import Aoi

log = logging.getLogger("terratrace.ee")

S2 = "COPERNICUS/S2_SR_HARMONIZED"
# reduceRegion tile scale: splits the computation into smaller tiles (same pixels, same reducers) so a dense
# Sentinel-2 stack does not exceed Earth Engine's per-tile user memory limit (a 9 km² Silent Valley area failed
# with "User memory limit exceeded" at 4 and completes at 16).
TILE_SCALE = 16
# Change-event vectorisation / per-polygon statistics: 16 slowed a 400 km² analysis from ~50 s to 145 s, and the
# memory failure never occurred there, so it keeps the previous tile scale.
EVENT_TILE_SCALE = 4
CSPLUS = "GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED"
DW = "GOOGLE/DYNAMICWORLD/V1"
HANSEN = "UMD/hansen/global_forest_change_2025_v1_13"
HANSEN_LAST_YEAR = 2025  # GFC v1.13: annual loss year through 2025
LANDSAT = {
    "LANDSAT/LT05/C02/T1_L2": ["SR_B1", "SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B7"],
    "LANDSAT/LE07/C02/T1_L2": ["SR_B1", "SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B7"],
    "LANDSAT/LC08/C02/T1_L2": ["SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B6", "SR_B7"],
    "LANDSAT/LC09/C02/T1_L2": ["SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B6", "SR_B7"],
}
BANDS = ["blue", "green", "red", "nir", "swir1", "swir2"]
DW_LABELS = ["water", "trees", "grass", "flooded_vegetation", "crops", "shrub_and_scrub", "built", "bare", "snow_and_ice"]
ANALYSIS_SCALE = 30
EVENT_SCALE = 20
MAX_EVENTS = sc.MAX_EVENTS


class EarthEngineError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _ee():
    import ee  # imported lazily so the API starts even without earthengine-api configured

    return ee


def _safe(e: BaseException) -> str:
    """Exact failure reason for the UI, with anything token-like redacted."""
    msg = re.sub(r"(ya29\.|1//)[\w\-.]+", "[redacted]", f"{e}")
    return re.sub(r"\s+", " ", msg).strip()[:300]


def split_available(years: list[int], sizes: dict[str, dict[str, int]]) -> tuple[list[int], list[dict[str, Any]]]:
    """Partition composite years into those with input imagery and those without.

    A year is usable only if every source its composite needs has ≥ 1 scene
    (Landsat in the historical era; Sentinel-2 with Cloud Score+ AND Dynamic World in the modern era).
    Unusable years are returned with an explicit reason — they are never composited,
    interpolated or substituted with another dataset.
    """
    available, unavailable = [], []
    for y in years:
        counts = sizes.get(str(y), {})
        needed = ["landsat"] if sc.era_of(y) == "historical" else ["sentinel2", "dynamicWorld"]
        empty = [k for k in needed if not counts.get(k)]
        if not empty:
            available.append(y)
            continue
        if sc.era_of(y) == "historical":
            y0, y1 = sc.landsat_window(y)
            reason = f"No Landsat Collection 2 scenes over this area for {y0}–{y1 - 1}."
        else:
            names = {"sentinel2": "Sentinel-2 SR (with Cloud Score+)", "dynamicWorld": "Dynamic World"}
            reason = f"No {' or '.join(names[k] for k in empty)} scenes over this area in {y}."
        unavailable.append({"year": y, "sources": {k: counts.get(k) for k in needed}, "reason": reason})
    return available, unavailable


# ----------------------------------------------------------------------------- timing instrumentation
# ----------------------------------------------------------------------------- Earth Engine quota state
# Earth Engine signals "noncommercial compute quota exceeded — restricted mode" only as a Python
# UserWarning. Capture it so the condition is logged (and visible in developer diagnostics) instead of
# surfacing as an unexplained slow/hung analysis.
RESTRICTED_MODE = {"seen_at": None}
_orig_showwarning = warnings.showwarning


def _ee_warning_hook(message, category, filename, lineno, file=None, line=None):
    text = str(message)
    if "restricted mode" in text.lower():
        if RESTRICTED_MODE["seen_at"] is None:
            log.error("Earth Engine project is in RESTRICTED MODE (noncommercial compute quota exceeded). "
                      "Analyses will be throttled or time out until the quota resets.")
        RESTRICTED_MODE["seen_at"] = time.time()
        return
    _orig_showwarning(message, category, filename, lineno, file, line)


warnings.showwarning = _ee_warning_hook


class EETimer:
    """Structured timing: `[EE TIMING] operation=<name> elapsed=<s>`. Logs no credentials or data.

    Earth Engine is lazy: building images/reducers in Python is client-side and ~instant; all server
    computation happens inside the `[getInfo #n]` operations.
    """

    def __init__(self, analysis_id: str):
        self.aid, self.t0, self.ops = analysis_id, time.monotonic(), []

    def __call__(self, op: str):
        timer = self

        class _Ctx:
            def __enter__(self):
                log.info("[EE] START aoi=%s operation=%s", timer.aid, op.replace(" ", "_"))
                self.t = time.monotonic()

            def __exit__(self, *exc):
                timer.log(op, time.monotonic() - self.t, failed=exc[0] is not None)
                return False

        return _Ctx()

    def log(self, op: str, elapsed: float, failed: bool = False) -> None:
        self.ops.append((op, elapsed))
        log.info("[EE] END aoi=%s operation=%s elapsed=%.2fs%s", self.aid, op.replace(" ", "_"), elapsed, " FAILED" if failed else "")

    def total(self, status: str) -> None:
        log.info("[EE TIMING] aoi=%s operation=total elapsed=%.2f status=%s", self.aid, time.monotonic() - self.t0, status)


# ----------------------------------------------------------------------------- pure / expression helpers
def transition_bands(fa, fb, area, tag: str) -> list[Any]:
    """Loss / gain / compared-area / baseline-forest bands between two forest masks.

    `fa` and `fb` are masked where a pixel was not observed, so every band below is
    masked unless the pixel was observed in BOTH years; reducers then sum observed
    pixels only. An unobserved pixel is never treated as non-forest.
    """
    both = fa.gte(0).And(fb.gte(0))
    return [
        fa.And(fb.Not()).multiply(area).rename(f"loss_{tag}"),
        fa.Not().And(fb).multiply(area).rename(f"gain_{tag}"),
        both.multiply(area).rename(f"cmp_{tag}"),
        fa.updateMask(both).multiply(area).rename(f"fb_{tag}"),
    ]


def link_transitions(rows: list[dict[str, Any]]) -> list[int]:
    """Set previous_year to the previous ANALYSABLE year of the same era (skips are explicit).

    Years that fail quality get previous_year None and are never part of a transition.
    Returns the analysable years.
    """
    ok = [r["year"] for r in rows if r["passes_quality"]]
    for r in rows:
        r["previous_year"] = None
        if r["passes_quality"]:
            prev = [y for y in ok if y < r["year"] and sc.era_of(y) == r["era"]]
            r["previous_year"] = prev[-1] if prev else None
    return ok


def choose_windows(rows: list[dict[str, Any]], baseline_year: int, comparison_year: int) -> tuple[tuple[int, int] | None, tuple[int, int] | None]:
    """(event window, historical pair) from analysable years only.

    Event window: first and last analysable MODERN years inside the requested window
    (reported as `analyzable_window`; None if fewer than two). Historical pair: first and
    last analysable Landsat years.
    """
    ok = [r["year"] for r in rows if r["passes_quality"]]
    modern = [y for y in ok if sc.era_of(y) == "modern" and baseline_year <= y <= comparison_year]
    hist = [y for y in ok if sc.era_of(y) == "historical"]
    return ((modern[0], modern[-1]) if len(modern) >= 2 else None, (hist[0], hist[-1]) if len(hist) >= 2 else None)


def apply_statistics(rows: list[dict[str, Any]], sums: dict[str, Any], means: dict[str, Any]) -> None:
    """Fill measured statistics into analysable rows. Anything missing stays None — never 0."""
    def rnd(v: float | None, n: int = 1) -> float | None:
        return None if v is None else round(v, n)

    for r in rows:
        if not r["passes_quality"]:
            continue
        y = r["year"]
        f_ha = sc._num(sums.get(f"forest_{y}"))
        r["forest_ha"] = rnd(f_ha)
        r["forest_pct"] = None if f_ha is None or not r.get("valid_ha") else round(f_ha / r["valid_ha"] * 100, 2)
        tc, nc = sc._num(sums.get(f"ctree_{y}")), sc._num(sums.get(f"cndvi_{y}"))
        valid = r.get("valid_ha")
        r["forest_components"] = None if tc is None or nc is None or not valid else {
            "tree_prob": round(tc / valid * 100, 2), "leafon_ndvi": round(nc / valid * 100, 2)}   # % of the observed area
        r["mean_ndvi"] = rnd(sc._num(means.get(f"ndvi_{y}")), 3)
        r["mean_nbr"] = rnd(sc._num(means.get(f"nbr_{y}")), 3)
        if r["previous_year"] is not None:
            loss, gain, cmp_ = (sc._num(sums.get(f"{k}_{y}")) for k in ("loss", "gain", "cmp"))
            r["loss_ha"], r["gain_ha"], r["compared_ha"] = rnd(loss), rnd(gain), rnd(cmp_)
            r["net_change_ha"] = None if loss is None or gain is None else round(gain - loss, 1)
    by_year = {r["year"]: r for r in rows}
    for r in rows:   # measured change of each forest-mask component since the previous analysable year
        prev = by_year.get(r.get("previous_year")) if r.get("passes_quality") else None
        a, b = (prev or {}).get("forest_components"), r.get("forest_components")
        r["forest_components_change_pts"] = None if not a or not b else {k: round(b[k] - a[k], 2) for k in b}


# Map-layer styling (single source for the analysis and the post-restart tile rebuild).
IMAGERY_VIS_PARAMS = {"min": 0, "max": 0.3, "gamma": 1.2}
FOREST_PALETTE = ["16a36d"]
CHANGE_PALETTE = ["d4452f"]
LAYER_KINDS = ("imagery", "forest", "change")


def change_mask(b, a):
    """Change rule between two composites (baseline `b`, comparison `a`), with the minimum mapping unit applied.

    forest bands are masked where unobserved, so change exists only on pixels observed in both years.
    """
    d_ndvi = a.select("ndvi").subtract(b.select("ndvi"))
    d_nbr = a.select("nbr").subtract(b.select("nbr"))
    d_tree = a.select("trees").subtract(b.select("trees"))
    change = (
        b.select("forest").And(a.select("forest").Not())
        .And(d_ndvi.lte(sc.D_NDVI).Or(d_nbr.lte(sc.D_NBR)))
        .And(d_tree.lte(sc.D_TREE))
    ).selfMask()
    mmu_px = math.ceil(sc.MMU_HA * 1e4 / EVENT_SCALE**2)
    # Minimum mapping unit: keep patches of >= mmu_px connected pixels. connectedPixelCount(maxSize) counts only up
    # to maxSize, so maxSize = mmu_px gives exactly the same ">= mmu_px" test as any larger cap (a patch reaching
    # the MMU is counted as mmu_px either way) while exploring a far smaller neighbourhood. Identical mask; far less work.
    return change.updateMask(change.connectedPixelCount(mmu_px, True).gte(mmu_px))


def layer_key(analysis_id: str, kind: str, year: int, baseline: int | None = None) -> tuple[str, str, int]:
    """Cache key of a rendered layer. A change layer depends on BOTH years, so its key carries the baseline."""
    return (analysis_id, f"change:{baseline}" if kind == "change" else kind, year)


def evaluate_concurrently(groups: dict[str, Any], workers: int) -> dict[str, Any]:
    """Evaluate {name: ee.ComputedObject} as one Earth Engine request per entry, `workers` at a time.

    Earth Engine parallelises a single request across the tiles of its region; a small AOI is one or
    two tiles, so a combined request computes every yearly composite on the same worker(s) in sequence.
    Sending the same expressions as separate requests lets them run concurrently. Values are identical:
    each entry is exactly the reduction the combined request would have performed.
    """
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {k: pool.submit(v.getInfo) for k, v in groups.items()}
        return {k: f.result() for k, f in futures.items()}


class EarthEngineProvider:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._initialized = False
        self._error: str | None = None
        self._error_at = 0.0
        self._project: str | None = None
        self._auth: str | None = None
        # Bounded: rendered layers and analysed geometries are rebuilt from the registered AOI after eviction (tile_url),
        # and a map id is only a cached tile template (3 h TTL) that is regenerated on demand.
        n = settings.memory_cache_entries
        self._images: LRUDict = LRUDict(n * 4)       # (aoi, kind, year) -> styled ee.Image (client-side graph)
        self._mapids: LRUDict = LRUDict(n * 8)       # (aoi, kind, year) -> (tile URL template, created monotonic s)
        self._requests: LRUDict = LRUDict(n)         # aoi -> {"geometry": analysed geometry}
        # One map-ID build per layer at a time: concurrent tile requests for a cold layer wait for the first build
        # instead of each compositing and calling getMapId (a burst Restricted Mode answers with 429).
        self._mapid_locks: dict[tuple, threading.Lock] = {}
        self._mapid_locks_guard = threading.Lock()

    def mapid_lock(self, key: tuple) -> threading.Lock:
        with self._mapid_locks_guard:
            if len(self._mapid_locks) > 4096:   # bounded: drop locks nobody holds
                for k in [k for k, v in self._mapid_locks.items() if not v.locked()]:
                    self._mapid_locks.pop(k, None)
            return self._mapid_locks.setdefault(key, threading.Lock())

    def drop_mapid(self, key: tuple) -> None:
        """Forget a map ID Earth Engine no longer accepts (expired), so the next request rebuilds it."""
        self._mapids.pop(key, None)

    # ----------------------------------------------------------------- credentials
    @staticmethod
    def credentials_configured() -> bool:
        key = settings.ee_service_account_key
        if key and Path(key).expanduser().exists():
            return True
        user_creds = Path(os.environ.get("EARTHENGINE_CREDENTIALS", Path.home() / ".config" / "earthengine" / "credentials"))
        return user_creds.exists() and bool(settings.ee_project)

    def status(self) -> tuple[str, str | None]:
        """Readiness = Earth Engine actually initialised AND answered a real request.

        Blocking (first call ~1–3 s); callers run it off the event loop. A failure is
        re-attempted at most every RETRY_S seconds so health polling never hammers EE.
        """
        if not self.credentials_configured():
            return "unconfigured", "Earth Engine is not configured: set EE_PROJECT in backend/.env and run `earthengine authenticate` (or set EE_SERVICE_ACCOUNT_KEY)."
        if not self._initialized and not (self._error and time.monotonic() - self._error_at < self.RETRY_S):
            try:
                self.initialize()
            except EarthEngineError:
                pass
        if self._initialized:
            return "ready", f"Earth Engine initialised · project {self._project} · {self._auth}"
        return "error", self._error

    RETRY_S = 60.0

    def initialize(self) -> None:
        with self._lock:
            if self._initialized:
                return
            if not self.credentials_configured():
                raise EarthEngineError("ee_unconfigured", "Earth Engine credentials are not configured on the server.")
            ee = _ee()
            try:
                key = settings.ee_service_account_key
                if key and Path(key).expanduser().exists():
                    path = str(Path(key).expanduser())
                    info = json.loads(Path(path).read_text(encoding="utf-8"))
                    creds = ee.ServiceAccountCredentials(info["client_email"], key_file=path)
                    project = settings.ee_project or info.get("project_id")
                    ee.Initialize(creds, project=project)
                    auth = "service-account credentials"
                else:
                    project = settings.ee_project
                    ee.Initialize(project=project)
                    auth = "user credentials"
                # Bound every Earth Engine HTTP request: a hung request fails instead of blocking a worker forever.
                ee.data.setDeadline(int(settings.ee_request_deadline_s * 1000))
                # Initialize() alone does not prove access — make one real, trivial request.
                if ee.Number(1).add(1).getInfo() != 2:
                    raise RuntimeError("unexpected response to a test request")
                self._initialized, self._error, self._project, self._auth = True, None, project, auth
            except Exception as e:  # noqa: BLE001 — surface any auth/init failure to the UI
                self._error = f"Earth Engine initialisation failed: {_safe(e)}"
                self._error_at = time.monotonic()
                raise EarthEngineError("ee_init_failed", self._error) from e

    # ----------------------------------------------------------------- source collections
    # A composite of an EMPTY collection is an image with zero bands; any band math on it
    # fails ("No band named 'nir'. Available band names: []"). Collections are therefore
    # built separately so their sizes can be checked (see `source_sizes`) before any
    # composite is made, and empty periods are reported as unavailable — never filled in.

    def _s2_collection(self, geom, year: int):
        ee = _ee()
        start, end = ee.Date.fromYMD(year, 1, 1), ee.Date.fromYMD(year + 1, 1, 1)
        return (
            ee.ImageCollection(S2).filterBounds(geom).filterDate(start, end)
            .linkCollection(ee.ImageCollection(CSPLUS), ["cs_cdf"])
            # Scenes without a Cloud Score+ match cannot be cloud-masked by our rule: excluded, not substituted.
            .filter(ee.Filter.listContains("system:band_names", "cs_cdf"))
        )

    def _dw_collection(self, geom, year: int):
        ee = _ee()
        return ee.ImageCollection(DW).filterBounds(geom).filterDate(ee.Date.fromYMD(year, 1, 1), ee.Date.fromYMD(year + 1, 1, 1))

    def _landsat_collection(self, geom, year: int):
        ee = _ee()
        y0, y1 = sc.landsat_window(year)
        start, end = ee.Date.fromYMD(y0, 1, 1), ee.Date.fromYMD(y1, 1, 1)

        def prep(bands):
            def f(img):
                qa = img.select("QA_PIXEL")
                clear = qa.bitwiseAnd(1 << 1).eq(0).And(qa.bitwiseAnd(1 << 3).eq(0)).And(qa.bitwiseAnd(1 << 4).eq(0))
                return img.select(bands, BANDS).multiply(0.0000275).add(-0.2).updateMask(clear)
            return f

        merged = None
        for cid, bands in LANDSAT.items():
            c = ee.ImageCollection(cid).filterBounds(geom).filterDate(start, end).map(prep(bands))
            merged = c if merged is None else merged.merge(c)
        return merged

    def source_sizes(self, geom, years: list[int]):
        """Server-side dictionary {year: {source: scene count}} for every composite's inputs."""
        ee = _ee()
        out = {}
        for y in years:
            if sc.era_of(y) == "historical":
                out[str(y)] = {"landsat": self._landsat_collection(geom, y).size()}
            else:
                out[str(y)] = {"sentinel2": self._s2_collection(geom, y).size(), "dynamicWorld": self._dw_collection(geom, y).size()}
        return ee.Dictionary(out)

    # ----------------------------------------------------------------- composites (non-empty inputs only)
    def _s2(self, geom, year: int):
        col = self._s2_collection(geom, year).map(
            lambda img: img.updateMask(img.select("cs_cdf").gte(0.6)).select(["B2", "B3", "B4", "B8", "B11", "B12"], BANDS).divide(10000)
        )
        comp = col.median()
        ndvi = comp.normalizedDifference(["nir", "red"]).rename("ndvi")
        nbr = comp.normalizedDifference(["nir", "swir2"]).rename("nbr")
        # Forest-mask NDVI = leaf-on canopy greenness: the per-pixel upper percentile of the cloud-masked NDVI
        # observations (method tt-ee-2.1). The annual MEDIAN mixed leaf-off dry-season scenes into the forest test, so
        # deciduous forest crossed the NDVI floor depending on each year's seasonal sampling (a stable protected sal
        # forest "gained" 31 % in one year). The median NDVI band is kept for event detection and reported means.
        ndvi_leafon = col.map(lambda img: img.normalizedDifference(["nir", "red"]).rename("ndvi"))             .reduce(_ee().Reducer.percentile([sc.FOREST_NDVI_PERCENTILE])).rename("ndvi_leafon")
        dwc = self._dw_collection(geom, year)
        trees = dwc.select("trees").mean().rename("trees")
        label = dwc.select("label").mode().rename("label")
        # Observation counts are measured facts (0 = observed zero times), so unmask(0) is correct HERE only.
        clear = col.select("nir").count().unmask(0).rename("clear")
        dw_obs = dwc.select("trees").count().unmask(0).rename("dw_obs")
        valid = clear.gte(sc.MIN_PIXEL_CLEAR_OBS).And(dw_obs.gte(sc.MIN_PIXEL_DW_OBS)).rename("valid")
        # Forest only where observed; unobserved pixels stay MASKED (never "non-forest").
        forest = trees.gte(sc.FOREST_TREE_PROB).And(ndvi_leafon.gte(sc.FOREST_NDVI)).updateMask(valid).rename("forest")
        # The two halves of the forest mask, over observed pixels — measured separately so an unstable mask can be
        # attributed to the component that moved (never used to decide forest).
        tree_c = trees.gte(sc.FOREST_TREE_PROB).updateMask(valid).rename("forest_c_tree")
        ndvi_c = ndvi_leafon.gte(sc.FOREST_NDVI).updateMask(valid).rename("forest_c_ndvi")
        return comp.addBands([ndvi, nbr, ndvi_leafon, trees, label, clear, dw_obs, valid, forest, tree_c, ndvi_c]
                             + self._quarter_obs(geom, year)), col.size()

    def _quarter_obs(self, geom, year: int) -> list[Any]:
        """obs_q1..obs_q4: 1 where the pixel has >= 1 clear (Cloud Score+) Sentinel-2 observation in that calendar quarter,
        else 0 (a measured count of zero). A quarter WITHOUT scenes is a real case (e.g. 2018 July–September over parts of
        India): a count over an empty collection has no bands, so one fully MASKED image is merged in — it contributes
        no observation, it only keeps the band defined. Nothing is filled in."""
        ee = _ee()
        raw = self._s2_collection(geom, year)
        none = ee.ImageCollection([ee.Image.constant(1).toByte().rename("obs").updateMask(ee.Image.constant(0))])
        out = []
        for q in range(4):
            seen = raw.filter(ee.Filter.calendarRange(3 * q + 1, 3 * q + 3, "month")).map(
                lambda img: img.select("B8").updateMask(img.select("cs_cdf").gte(0.6)).multiply(0).add(1).toByte().rename("obs"))
            out.append(none.merge(seen).count().unmask(0).gte(1).rename(f"obs_q{q + 1}"))
        return out

    def _landsat(self, geom, year: int):
        merged = self._landsat_collection(geom, year)
        comp = merged.median()
        ndvi = comp.normalizedDifference(["nir", "red"]).rename("ndvi")
        nbr = comp.normalizedDifference(["nir", "swir2"]).rename("nbr")
        clear = merged.select("nir").count().unmask(0).rename("clear")   # measured observation count
        valid = clear.gte(sc.MIN_PIXEL_CLEAR_OBS).rename("valid")
        forest = ndvi.gte(sc.LANDSAT_FOREST_NDVI).updateMask(valid).rename("forest")   # unobserved stays masked
        return comp.addBands([ndvi, nbr, clear, valid, forest]), merged.size()

    def _composite(self, geom, year: int):
        return self._landsat(geom, year) if sc.era_of(year) == "historical" else self._s2(geom, year)

    # ----------------------------------------------------------------- imagery availability (no analysis)
    def measure_imagery(self, geometry: dict[str, Any], years: list[int], deadline: float | None = None) -> dict[str, Any]:
        """REAL per-year imagery measurements for an AOI: scene counts and observed-area coverage.

        Exactly the observation rules of the analysis (stage 0 + stage 1 coverage): scene counts per source,
        then the area whose composite pixel is `valid` (>= MIN_PIXEL_CLEAR_OBS clear observations, and
        >= MIN_PIXEL_DW_OBS Dynamic World observations in the modern era). Two getInfo requests; years
        without scenes are never composited. Returns raw measurements only — classification is done by
        services/imagery.py. No forest or change metric is computed here.
        """
        self.initialize()
        ee = _ee()
        geom = ee.Geometry(geometry)
        tm = EETimer("imagery-availability")
        with tm("imagery_scene_metadata [getInfo #1]"):
            counts = self.source_sizes(geom, years).getInfo()
        with_scenes, _ = split_available(years, counts)
        coverage: dict[str, Any] = {}
        if with_scenes:
            if deadline is not None and time.monotonic() > deadline:
                raise EarthEngineError("analysis_timeout", "deadline passed before imagery coverage")
            area = ee.Image.pixelArea().divide(1e4)
            img = ee.Image.cat([area.rename("aoi")] + [self._composite(geom, y)[0].select("valid").multiply(area).rename(f"valid_{y}") for y in with_scenes])
            with tm("imagery_coverage [getInfo #2]"):
                coverage = img.reduceRegion(ee.Reducer.sum(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE).getInfo()
        tm.total("measured")
        return {"counts": counts, "coverage": coverage}

    # True-colour visualisation of the project's own composites (surface reflectance, 0–0.3, gamma 1.2).
    IMAGERY_VIS = {"min": 0, "max": 0.3, "gamma": 1.2}

    def imagery_collection(self, geom, year: int):
        """(collection, dataset, date range, S2 band names) of the imagery for one composite year — the SAME
        collections as the analysis: Sentinel-2 SR Harmonized with Cloud Score+ (modern) or Landsat C2 L2 (historical)."""
        if sc.era_of(year) == "historical":
            y0, y1 = sc.landsat_window(year)
            return self._landsat_collection(geom, year), "Landsat Collection 2 Level-2 (LT05/LE07/LC08/LC09)", (f"{y0}-01-01", f"{y1}-01-01"), ["red", "green", "blue"]
        return self._s2_collection(geom, year), S2, (f"{year}-01-01", f"{year + 1}-01-01"), ["B4", "B3", "B2"]

    def imagery_layer(self, aoi_id: str, geometry: dict[str, Any], year: int) -> dict[str, Any]:
        """REAL imagery for one AOI and year, independent of any analysis.

        1 getInfo (scene count) + 1 getMapId. The composite is built ONLY after the scene count is known to be
        > 0; masks are preserved (no unmask) — unobserved pixels stay transparent, never filled.
        """
        self.initialize()
        ee = _ee()
        geom = ee.Geometry(geometry)
        col, dataset, (start, end), vis_bands = self.imagery_collection(geom, year)
        with EETimer(f"imagery-{aoi_id}-{year}")("imagery_scene_count [getInfo]"):
            scenes = int(col.size().getInfo())
        out = {"dataset": dataset, "dateRange": {"start": start, "end": end}, "sceneCount": scenes, "bands": vis_bands, "tileUrl": None}
        if scenes == 0:
            return out   # never composite an empty collection
        if sc.era_of(year) == "historical":
            rgb = col.select(["red", "green", "blue"]).median()
        else:
            # Project cloud rule: per-pixel Cloud Score+ cs_cdf >= 0.6 (the analysis' own mask); reflectance = DN / 10000.
            rgb = col.map(lambda img: img.updateMask(img.select("cs_cdf").gte(0.6)).select(["B4", "B3", "B2"], ["red", "green", "blue"]).divide(10000)).median()
        img = rgb.visualize(bands=["red", "green", "blue"], **self.IMAGERY_VIS).clip(geom)
        with EETimer(f"imagery-{aoi_id}-{year}")("imagery_map_id [getMapId]"):
            url = ee.data.getMapId({"image": img})["tile_fetcher"].url_format
        self.store_mapid((aoi_id, "aoi-imagery", year), url)
        out["tileUrl"] = url
        return out

    # Earth Engine map IDs expire; a cached tile template older than this is rebuilt from the same real inputs.
    MAPID_TTL_S = 3 * 3600

    def cached_mapid(self, key: tuple[str, str, int]) -> str | None:
        entry = self._mapids.get(key)
        if entry is None:
            return None
        url, created = entry
        if time.monotonic() - created >= self.MAPID_TTL_S:   # expired: never served again
            self._mapids.pop(key, None)
            return None
        return url

    def store_mapid(self, key: tuple[str, str, int], url: str) -> None:
        now = time.monotonic()
        for k, (_, created) in self._mapids.items():   # drop every expired template, not only the one requested
            if now - created >= self.MAPID_TTL_S:
                self._mapids.pop(k, None)
        self._mapids[key] = (url, now)

    def cached_imagery_url(self, aoi_id: str, year: int) -> str | None:
        return self.cached_mapid((aoi_id, "aoi-imagery", year))

    def imagery_tile_url(self, aoi_id: str, geometry: dict[str, Any], year: int) -> str | None:
        """The AOI imagery tile template: cached, else rebuilt ONCE however many tiles ask at the same time."""
        key = (aoi_id, "aoi-imagery", year)
        with self.mapid_lock(key):
            return self.cached_mapid(key) or self.imagery_layer(aoi_id, geometry, year)["tileUrl"]

    # ----------------------------------------------------------------- analysis
    def analyze(self, aoi: Aoi, analysis_id: str, name: str, baseline_year: int, comparison_year: int,
                diag: frozenset[str] = frozenset(), deadline: float | None = None, workers: int | None = None,
                on_stage: Any = None, scope: str = "window") -> dict[str, Any]:
        """Run the analysis and decide its scientific status.

        Returns {"status", "reasonCode", "reason", "quality"} plus summary/events/layers
        ONLY when status == READY. A finished computation is not enough for READY: every
        year must be observed well enough and every statistic must pass `science.evaluate`.

        diag is a DIAGNOSTIC-ONLY switch set (scripts/dev/ee_diagnose.py; never passed by the API):
        no_coverage, no_yearly_stats, no_change, no_vectorize, no_hansen, no_persistence. A diagnostic
        result is marked diagnostic and is never cached or served.
        """
        self.initialize()
        ee = _ee()
        workers = settings.ee_parallel_requests if workers is None else workers
        stage = on_stage or (lambda s: None)   # REAL stage reporting (which Earth Engine request is running)

        def check_deadline(stage: str) -> None:
            # Earth Engine requests cannot be cancelled once sent, so a timed-out analysis stops here,
            # before starting its next request (no orphaned work beyond the current stage).
            if deadline is not None and time.monotonic() > deadline:
                raise EarthEngineError("analysis_timeout", f"deadline passed before {stage}")

        geom = ee.Geometry(aoi.geometry)
        latest = min(date.today().year - 1, 2030)
        all_years = sc.HIST_YEARS + list(range(sc.MODERN_FIRST_YEAR, latest + 1))
        # scope "window" (live analysis): only the years the requested result is built from — the window itself plus
        #   the next modern year, which event persistence uses. Out-of-window years never change the window result.
        # scope "history" (Time Machine / charts): only the years OUTSIDE the window; no validation, no events.
        # scope "all": every composite year (diagnostics).
        if scope == "window":
            nxt = [y for y in all_years if y > comparison_year and sc.era_of(y) == "modern"][:1]
            candidate_years = [y for y in all_years if baseline_year <= y <= comparison_year] + nxt
        elif scope == "history":
            candidate_years = [y for y in all_years if not baseline_year <= y <= comparison_year]
        else:
            candidate_years = all_years
        self._requests[analysis_id] = {"geometry": aoi.geometry}

        # Stage 0 — metadata: input scenes per composite. Empty periods are never composited.
        tm = EETimer(analysis_id)
        stage("preparing_imagery")
        with tm("scene_metadata [getInfo #1]"):
            source_counts = self.source_sizes(geom, candidate_years).getInfo()
        years, unavailable_years = split_available(candidate_years, source_counts)
        with tm("composite_graph_build (lazy, client-side)"):
            comps = {y: self._composite(geom, y)[0] for y in years}
        area = ee.Image.pixelArea().divide(1e4)

        # Stage 1 — observation coverage (valid pixels = enough clear observations; NOT scene counts).
        def cov_bands(y: int) -> list[Any]:
            out = [comps[y].select("valid").multiply(area).rename(f"valid_{y}")]
            if sc.era_of(y) == "modern":   # seasonal coverage: observed area per calendar quarter
                out += [comps[y].select(f"obs_q{q}").multiply(area).rename(f"season{q}_{y}") for q in range(1, 5)]
            return out

        def component_bands(y: int) -> list[Any]:
            if sc.era_of(y) != "modern":
                return []
            return [comps[y].select("forest_c_tree").multiply(area).rename(f"ctree_{y}"),
                    comps[y].select("forest_c_ndvi").multiply(area).rename(f"cndvi_{y}")]

        cov_img = ee.Image.cat([area.rename("aoi")] + [b for y in years for b in cov_bands(y)])
        med_bands = [comps[y].select("clear").rename(f"clear_{y}") for y in years]
        med_bands += [comps[y].select("dw_obs").rename(f"dw_{y}") for y in years if sc.era_of(y) == "modern"]
        check_deadline("coverage")
        stage("measuring_coverage")

        def pair_bands(a: int, b: int, tag: str) -> list[Any]:
            return transition_bands(comps[a].select("forest"), comps[b].select("forest"), area, tag)

        # Default path: coverage, observation medians AND the forest statistics in ONE Earth Engine request, so the
        # annual composites are computed once instead of twice (they used to be rebuilt by a separate request #3).
        # The statistics bands are exactly those request #3 would use; they are computed for every year with scenes
        # and keyed by BOTH years of each transition. A year's statistics do not depend on the AOI-level quality
        # decision (unobserved pixels are masked per pixel), so results for years that fail it are simply unused.
        # Transitions that only exist when a year fails (e.g. 2019→2021) are computed by a small follow-up request.
        merged = workers <= 1 and not diag
        spec: dict[str, Any] = {}
        if merged:
            spec_rows = [{"year": y, "era": sc.era_of(y), "passes_quality": True} for y in years]
            link_transitions(spec_rows)
            spec_bands = []
            for r in spec_rows:
                spec_bands.append(comps[r["year"]].select("forest").multiply(area).rename(f"forest_{r['year']}"))
                spec_bands += component_bands(r["year"])
                if r["previous_year"] is not None:
                    spec_bands += pair_bands(r["previous_year"], r["year"], f"{r['previous_year']}_{r['year']}")
            spec_pairs = {(r["previous_year"], r["year"]) for r in spec_rows if r["previous_year"] is not None}
            for pr in choose_windows(spec_rows, baseline_year, comparison_year):
                if pr and pr not in spec_pairs:
                    spec_bands += pair_bands(pr[0], pr[1], f"{pr[0]}_{pr[1]}")
                    spec_pairs.add(pr)
            spec_means = [comps[y].select(["ndvi", "nbr"], [f"ndvi_{y}", f"nbr_{y}"]).updateMask(comps[y].select("valid")) for y in years]
            with tm("coverage+observation_medians+forest_stats+transitions+means [getInfo #2, 1 request]"):
                spec = ee.Dictionary({
                    "sums": ee.Image.cat([cov_img] + spec_bands).reduceRegion(ee.Reducer.sum(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE),
                    "med": ee.Image.cat(med_bands).reduceRegion(ee.Reducer.median(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE),
                    "means": ee.Image.cat(spec_means).reduceRegion(ee.Reducer.mean(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE),
                }).getInfo()
            stage1 = {"cov": spec["sums"], "med": spec["med"]}
        elif "no_coverage" in diag:   # DIAGNOSTIC: skip request #2; every year with scenes is treated as analysable
            stage1 = {"cov": {}, "med": {}}
        else:
         with tm(f"coverage+observation_medians [getInfo #2, {'1 request' if workers <= 1 else f'{len(years) + 1} concurrent requests'}]"):
          if workers <= 1:
            stage1 = ee.Dictionary({
                "cov": cov_img.reduceRegion(ee.Reducer.sum(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE),
                "med": ee.Image.cat(med_bands).reduceRegion(ee.Reducer.median(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE),
            }).getInfo()
          else:
            # Same bands, reducers, scale and geometry as the combined request — split per year so Earth
            # Engine computes the yearly composites concurrently (a small AOI is only one or two tiles).
            groups = {"aoi": area.rename("aoi").reduceRegion(ee.Reducer.sum(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE)}
            for y in years:
                med_y = [comps[y].select("clear").rename(f"clear_{y}")] + ([comps[y].select("dw_obs").rename(f"dw_{y}")] if sc.era_of(y) == "modern" else [])
                groups[str(y)] = ee.Dictionary({
                    "cov": ee.Image.cat(cov_bands(y)).reduceRegion(ee.Reducer.sum(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE),
                    "med": ee.Image.cat(med_y).reduceRegion(ee.Reducer.median(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE),
                })
            out = evaluate_concurrently(groups, workers)
            stage1 = {"cov": {**out.pop("aoi")}, "med": {}}
            for g in out.values():
                stage1["cov"].update(g["cov"])
                stage1["med"].update(g["med"])
        aoi_px_ha = sc._num(stage1["cov"].get("aoi"))

        rows: list[dict[str, Any]] = []
        for y in years:
            valid_ha = sc._num(stage1["cov"].get(f"valid_{y}"))
            coverage = valid_ha / aoi_px_ha if valid_ha is not None and aoi_px_ha else None
            clear_med = sc._num(stage1["med"].get(f"clear_{y}"))
            dw_med = sc._num(stage1["med"].get(f"dw_{y}")) if sc.era_of(y) == "modern" else None
            seasonal = None
            if sc.era_of(y) == "modern":
                q_ha = [sc._num(stage1["cov"].get(f"season{q}_{y}")) for q in range(1, 5)]
                seasonal = [None if v is None or not aoi_px_ha else v / aoi_px_ha for v in q_ha]
            passes, reason = (True, None) if "no_coverage" in diag else sc.assess_year(y, clear_med, dw_med, coverage, seasonal, forest_analysis=True)
            s = sc.sensor_for(y)
            rows.append({
                "year": y, "era": sc.era_of(y), "previous_year": None,
                "passes_quality": passes, "quality_reason": reason,
                "scenes": source_counts.get(str(y), {}),
                "clear_obs_median": None if clear_med is None else int(round(clear_med)),
                "dw_obs_median": None if dw_med is None else int(round(dw_med)),
                "valid_ha": None if valid_ha is None else round(valid_ha, 1),
                "coverage_pct": None if coverage is None else round(coverage * 100, 1),
                "seasonal_coverage_pct": None if seasonal is None else [None if v is None else round(v * 100, 1) for v in seasonal],
                "forest_ha": None, "forest_pct": None, "loss_ha": None, "gain_ha": None, "compared_ha": None, "net_change_ha": None,
                "mean_ndvi": None, "mean_nbr": None,
                "sensor": s["label"], "source": s["source"], "resolution_m": s["resolution_m"], "forest_method": s["forest_method"],
                "dw_available": s["dw_available"], "composite_window": s["composite"] or f"{y} annual composite",
                "imagery_status": sc.imagery_status(None if clear_med is None else int(round(clear_med)), passes),
                "event_count": 0, "loss_by_severity": {"low": 0, "moderate": 0, "high": 0, "critical": 0}, "loss_by_type": {},
            })
        ok = link_transitions(rows)
        window, hist_pair = choose_windows(rows, baseline_year, comparison_year)

        def quality(status: str, issues: list[dict[str, Any]]) -> dict[str, Any]:
            by_year = {r["year"]: r for r in rows}
            q_years = []
            for y in candidate_years:
                r = by_year.get(y)
                u = next((u for u in unavailable_years if u["year"] == y), None)
                q_years.append({
                    "year": y, "era": sc.era_of(y), "sensor": sc.sensor_for(y)["label"], "scenes": source_counts.get(str(y), {}),
                    "clear_obs_median": r["clear_obs_median"] if r else None, "dw_obs_median": r["dw_obs_median"] if r else None,
                    "coverage_pct": r["coverage_pct"] if r else None,
                    "seasonal_coverage_pct": r["seasonal_coverage_pct"] if r else None,
                    "passes": bool(r and r["passes_quality"]),
                    "reason": (r["quality_reason"] if r else u["reason"] if u else None),
                })
            return {
                "method_version": sc.METHOD_VERSION, "status": status,
                "requested_window": [baseline_year, comparison_year],
                "analyzable_window": list(window) if window else None,
                "years": q_years, "issues": issues, "thresholds": sc.METHOD["thresholds"],
                # Same checks outside the analysed window (history only) — informational, never decide the status.
                "context_issues": sc.context_issues(rows, aoi.area_ha, window),
            }

        # Stage 2 — statistics over OBSERVED pixels only (forest bands are masked where unobserved).
        bands = []
        for r in rows:
            if not r["passes_quality"]:
                continue
            y = r["year"]
            bands.append(comps[y].select("forest").multiply(area).rename(f"forest_{y}"))
            bands += component_bands(y)
            if r["previous_year"] is not None:
                bands += pair_bands(r["previous_year"], y, str(y))
        if window:
            bands += pair_bands(window[0], window[1], "win")
        if hist_pair:
            bands += pair_bands(hist_pair[0], hist_pair[1], "hist")
        means = [comps[y].select(["ndvi", "nbr"], [f"ndvi_{y}", f"nbr_{y}"]).updateMask(comps[y].select("valid")) for y in ok]
        check_deadline("statistics")
        if not merged:   # merged path: forest cover was measured in the same request as coverage (no separate stage)
            stage("measuring_forest")
        if merged:
            # Map the merged results onto the names used below; request only transitions not yet computed.
            got, S0 = spec["sums"], {}
            missing = []
            def take(a: int, b: int, tag: str) -> None:
                if f"loss_{a}_{b}" in got:
                    for k in ("loss", "gain", "cmp", "fb"):
                        S0[f"{k}_{tag}"] = got.get(f"{k}_{a}_{b}")
                else:
                    missing.append((a, b, tag))
            for r in rows:
                if r["passes_quality"]:
                    for k in ("forest", "ctree", "cndvi"):
                        S0[f"{k}_{r['year']}"] = got.get(f"{k}_{r['year']}")
                    if r["previous_year"] is not None:
                        take(r["previous_year"], r["year"], str(r["year"]))
            for tag, pr in (("win", window), ("hist", hist_pair)):
                if pr:
                    take(pr[0], pr[1], tag)
            if missing:
                stage("measuring_forest")   # a real extra request: transitions that skip an unusable year
                with tm(f"transitions skipping an unusable year [getInfo #3, {len(missing)} pair(s)]"):
                    S0.update(ee.Image.cat([bd for a, b, tag in missing for bd in pair_bands(a, b, tag)])
                              .reduceRegion(ee.Reducer.sum(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE).getInfo())
            stage2 = {"sums": S0, "means": {k: v for k, v in spec["means"].items() if int(k.split("_")[1]) in ok}}
        elif "no_yearly_stats" in diag:   # DIAGNOSTIC: skip request #3 (all statistics stay None)
            stage2 = {"sums": {}, "means": {}}
        else:
         with tm(f"forest_stats+transitions+means [getInfo #3, {'1 request' if workers <= 1 else 'concurrent per-year requests'}]"):
          if workers <= 1:
            stage2 = ee.Dictionary({
                "sums": ee.Image.cat(bands).reduceRegion(ee.Reducer.sum(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE) if bands else {},
                "means": ee.Image.cat(means).reduceRegion(ee.Reducer.mean(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE) if means else {},
            }).getInfo()
          else:
            # Identical band expressions/reducers/scale; one request per analysable year (+ window / history pairs).
            groups = {}
            for r in rows:
                if not r["passes_quality"]:
                    continue
                y = r["year"]
                sb = [comps[y].select("forest").multiply(area).rename(f"forest_{y}")] + component_bands(y)
                if r["previous_year"] is not None:
                    sb += pair_bands(r["previous_year"], y, str(y))
                groups[str(y)] = ee.Dictionary({
                    "sums": ee.Image.cat(sb).reduceRegion(ee.Reducer.sum(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE),
                    "means": comps[y].select(["ndvi", "nbr"], [f"ndvi_{y}", f"nbr_{y}"]).updateMask(comps[y].select("valid"))
                             .reduceRegion(ee.Reducer.mean(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE),
                })
            for tag, pr in (("win", window), ("hist", hist_pair)):
                if pr:
                    groups[tag] = ee.Dictionary({"sums": ee.Image.cat(pair_bands(pr[0], pr[1], tag)).reduceRegion(ee.Reducer.sum(), geom, ANALYSIS_SCALE, maxPixels=1e10, tileScale=TILE_SCALE),
                                                 "means": ee.Dictionary({})})
            out = evaluate_concurrently(groups, workers)
            stage2 = {"sums": {}, "means": {}}
            for g in out.values():
                stage2["sums"].update(g["sums"])
                stage2["means"].update(g["means"])
        S, M = stage2["sums"], stage2["means"]

        def pair(tag: str) -> dict[str, float | None]:
            return {"loss": sc._num(S.get(f"loss_{tag}")), "gain": sc._num(S.get(f"gain_{tag}")),
                    "compared": sc._num(S.get(f"cmp_{tag}")), "forest_b": sc._num(S.get(f"fb_{tag}"))}

        apply_statistics(rows, S, M)
        if scope == "history":
            tm.total("HISTORY")
            return {"status": "HISTORY", "years": rows, "periods": sc.classify_periods(rows, latest),
                    "history": sc.history_for(rows, pair("hist") if hist_pair else None), "quality_years": quality("HISTORY", [])["years"]}

        with tm("validation (pre-events)"):   # instant (Python); the reported stage is the final validation
            kpis = sc.kpis_for(rows, [], window[0], window[1], pair("win")) if window else None
            status, code, reason, issues = sc.evaluate(rows, aoi.area_ha, window, kpis)
        for i in issues:
            log.warning("EE %s: validity issue %s %s", analysis_id, i["rule"], i["message"])
        if status != "READY":
            tm.total(status)
            return {"status": status, "reasonCode": code, "reason": reason, "quality": quality(status, issues)}

        # READY so far → detect events between the analysable baseline and comparison composites.
        b_year, c_year = window
        if "no_change" in diag:
            tm.total("DIAGNOSTIC(no_change)")
            return {"status": "DIAGNOSTIC", "diagnostic": sorted(diag), "reasonCode": None, "reason": None, "quality": quality(status, issues)}
        for y in years:
            self._images[layer_key(analysis_id, "imagery", y)] = self._render("imagery", comps[y])
        for y in ok:
            self._images[layer_key(analysis_id, "forest", y)] = self._render("forest", comps[y])
        next_ok = next((y for y in ok if y > c_year and sc.era_of(y) == "modern"), None)
        check_deadline("events")
        stage("detecting_change")
        features, candidates = self._events(geom, comps, b_year, c_year, next_ok, analysis_id, tm, diag)
        ev_meta = sc.events_meta(len(features), candidates)
        c_row = next(r for r in rows if r["year"] == c_year)
        for f in features:
            c_row["event_count"] += 1
            c_row["loss_by_severity"][f["properties"]["severity"]["class"]] += f["properties"]["area_ha"]
        stage("validating_result")
        with tm("validation (final)"):
            kpis = sc.kpis_for(rows, features, b_year, c_year, pair("win"))
            status, code, reason, issues = sc.evaluate(rows, aoi.area_ha, window, kpis)
        if status != "READY":
            tm.total(status)
            return {"status": status, "reasonCode": code, "reason": reason, "quality": quality(status, issues)}

        t_ser = time.monotonic()
        adjusted = (b_year, c_year) != (baseline_year, comparison_year)
        summary = {
            "schema_version": "2.0",
            "aoi": {
                "id": analysis_id, "name": name, "short_name": name[:28],
                "region": f"{abs(aoi.centroid[1]):.3f}°{'N' if aoi.centroid[1] >= 0 else 'S'}, {abs(aoi.centroid[0]):.3f}°{'E' if aoi.centroid[0] >= 0 else 'W'}",
                "country": None, "biome": None, "description": "Area analysed live with Google Earth Engine.",
                "tags": [], "bbox": list(aoi.bbox), "center": list(aoi.centroid), "geometry": aoi.geometry,
                "area_ha": round(aoi.area_ha, 1), "area_km2": round(aoi.area_km2, 2), "thumbnail_url": "",
            },
            "kpis": kpis, "events_meta": ev_meta, "history": sc.history_for(rows, pair("hist") if hist_pair else None), "years": rows,
            "periods": sc.classify_periods(rows, latest), "method": sc.METHOD,
            "analysis_window": {"baseline_year": b_year, "comparison_year": c_year, "event_window": [b_year, c_year],
                                "requested": [baseline_year, comparison_year]},
            "unavailable_years": unavailable_years,
            "source_counts": source_counts,
            "quality": quality("READY", issues),
            "provenance": {
                "dataMode": "LIVE", "pipeline_version": sc.METHOD_VERSION, "generated_at": date.today().isoformat(),
                "sources": [
                    {"name": "Copernicus Sentinel-2 SR Harmonized + Cloud Score+", "role": "Modern composites (catalogue from 2017-03-28; years without scenes are unavailable)", "real": True},
                    {"name": "Google Dynamic World V1", "role": "Tree probability / land cover (modern era)", "real": True},
                    {"name": "USGS Landsat Collection 2 Level-2 (L5/L7/L8/L9)", "role": "Historical composites (1984–2015)", "real": True},
                    {"name": "Hansen GFC v1.13 (2025)", "role": "Independent reference (cross-check)", "real": True},
                ],
                "note": (
                    f"Live Earth Engine analysis (method {sc.METHOD_VERSION}). Change events are detected between {b_year} and {c_year}"
                    + (f" — the requested window {baseline_year}–{comparison_year} was narrowed to the years with sufficient clear observations" if adjusted else "")
                    + ". Statistics are computed over observed pixels only; historical (Landsat proxy) and modern (Dynamic World) forest are never compared."
                    + (f" Years without usable imagery: {', '.join(str(q['year']) for q in quality('READY', [])['years'] if not q['passes'])}." if any(not r['passes_quality'] for r in rows) or unavailable_years else "")
                ),
            },
        }
        layers = {
            "aoi_id": analysis_id, "years": years,
            "imagery": [{
                "year": y, "label": f"{sc.sensor_for(y)['label']} composite {y}", "tiles": [f"/api/tiles/{analysis_id}/imagery/{y}/{{z}}/{{x}}/{{y}}"],
                "tile_size": 256, "max_zoom": 15, "real": True, "reference": False, "sensor": sc.sensor_for(y)["label"],
                "attribution": "Contains modified Copernicus Sentinel data / USGS Landsat · processed in Google Earth Engine",
            } for y in years],
            "overlays": [{
                "kind": "forest", "label": "Forest cover", "source": "raster-tiles", "by_year": {},
                "tiles_by_year": {str(y): [f"/api/tiles/{analysis_id}/forest/{y}/{{z}}/{{x}}/{{y}}"] for y in ok},
                "legend": {"type": "gradient", "title": "Forest mask (observed pixels)", "stops": [[0, "#16a36d"], [1, "#16a36d"]], "min_label": "Forest", "max_label": "",
                           "note": "DW ≥ 0.5 ∧ leaf-on NDVI (p90) ≥ 0.6 (modern); Landsat NDVI proxy (historical)"},
            }],
            "severity_colors": {"low": "#f5a25a", "moderate": "#ec7a3c", "high": "#d4452f", "critical": "#a3281f"},
            # Raster of the change mask between the window's composites (API consumers; the UI draws the event
            # polygons). The baseline is part of the URL: a change layer depends on both years.
            "change": {
                "baseline_year": b_year, "comparison_year": c_year,
                "tiles": [f"/api/tiles/{analysis_id}/change/{c_year}/{{z}}/{{x}}/{{y}}?baseline={b_year}"],
                "palette": CHANGE_PALETTE,
            },
        }
        events = {"type": "FeatureCollection", "schema_version": "2.0", "aoi_id": analysis_id, "features": features, "meta": ev_meta}
        tm.log("result_serialization (python)", time.monotonic() - t_ser)
        tm.total("READY")
        return {"status": "READY", "reasonCode": None, "reason": None, "quality": summary["quality"],
                "summary": summary, "events": events, "layers": layers}

    def _events(self, geom, comps, b_year: int, c_year: int, next_year: int | None, analysis_id: str, tm: "EETimer | None" = None,
                diag: frozenset[str] = frozenset()) -> tuple[list[dict[str, Any]], int | None]:
        """(features, candidate polygon count before the MAX_EVENTS cut)."""
        ee = _ee()
        tm = tm or EETimer(analysis_id)
        b, a = comps[b_year], comps[c_year]
        change = change_mask(b, a)
        self._images[layer_key(analysis_id, "change", c_year, b_year)] = self._render("change", change)
        if "no_vectorize" in diag:   # DIAGNOSTIC: evaluate the change raster only (candidate area), no polygons
            with tm("change_raster_only (reduceRegion sum, 20 m) [diagnostic getInfo]"):
                change.multiply(ee.Image.pixelArea()).reduceRegion(ee.Reducer.sum(), geom, EVENT_SCALE, maxPixels=1e10, tileScale=EVENT_TILE_SCALE).getInfo()
            return [], None
        vectors = change.reduceToVectors(geometry=geom, scale=EVENT_SCALE, geometryType="polygon", eightConnected=True, maxPixels=1e10, tileScale=EVENT_TILE_SCALE)
        stack = [
            b.select(["ndvi", "nbr", "trees"], ["ndvi_b", "nbr_b", "tree_b"]),
            a.select(["ndvi", "nbr", "trees", "label", "clear"], ["ndvi_a", "nbr_a", "tree_a", "label_a", "clear_a"]),
        ]
        if next_year is not None and "no_persistence" not in diag:   # persistence only against an analysable following year
            stack.append(comps[next_year].select("forest").Not().rename("persist"))
        loss = ee.Image(HANSEN).select("lossyear")
        if "no_hansen" not in diag:
          stack.append(loss.gt(b_year - 2000).And(loss.lte(min(c_year, HANSEN_LAST_YEAR) - 2000)).rename("ref"))
        reducer = ee.Reducer.mean().combine(ee.Reducer.mode(), sharedInputs=True).combine(ee.Reducer.min(), sharedInputs=True)
        # Rank the change polygons by area and keep the MAX_EVENTS largest FIRST, then measure only those.
        # Per-polygon statistics are independent of the other polygons, so this is identical to measuring every
        # polygon and then keeping the largest — without computing statistics for polygons that are discarded.
        ranked = vectors.map(lambda f: f.set("area_ha", f.geometry().area(10).divide(1e4))).sort("area_ha", False).limit(MAX_EVENTS)
        fc = ee.Image.cat(stack).reduceRegions(collection=ranked, reducer=reducer, scale=EVENT_SCALE, tileScale=EVENT_TILE_SCALE).sort("area_ha", False)
        # ONE request evaluates: change mask → reduceToVectors → per-polygon reduceRegions (indices, DW label,
        # clear obs, persistence, Hansen overlap). Their costs cannot be separated inside a single request.
        # The candidate count rides in the same request (the polygons are computed for the ranking anyway), so the
        # result can state whether the MAX_EVENTS cut removed anything — never a guess. It is a collection property:
        # a FeatureCollection nested in an ee.Dictionary serialises WITHOUT its features (columns only).
        with tm("change_detection+vectorize+event_stats+persistence+hansen [getInfo #4]"):
            data = fc.set("tt_candidates", vectors.size()).getInfo()
        candidates = int(data["properties"]["tt_candidates"])
        t_ser = time.monotonic()

        features = []
        for n, f in enumerate(data.get("features", []), start=1):
            p = f["properties"]
            area = sc._num(p.get("area_ha"))
            if area is None or area < sc.MMU_HA:
                continue
            nb, na = p.get("ndvi_b_mean"), p.get("ndvi_a_mean")
            bb, ba = p.get("nbr_b_mean"), p.get("nbr_a_mean")
            tb, ta = p.get("tree_b_mean"), p.get("tree_a_mean")
            mode = p.get("label_a_mode")
            if None in (nb, na, bb, ba, tb, ta, mode):
                log.info("EE %s: skipping a change polygon without complete measurements", analysis_id)
                continue
            dn, db, dt = na - nb, ba - bb, ta - tb
            label = DW_LABELS[int(mode) % len(DW_LABELS)]
            fire = -db > 0.27 and -db > -dn * 1.3 and label not in ("crops", "built", "bare")
            persistence = round(float(p["persist_mean"]), 2) if p.get("persist_mean") is not None else None
            clear = None if p.get("clear_a_min") is None else int(p["clear_a_min"])
            reference = round(float(p["ref_mean"]), 2) if c_year <= HANSEN_LAST_YEAR and p.get("ref_mean") is not None else None
            sev = sc.severity_of("fire" if fire else "clearing", dn, db, 1.0, area)
            ev = sc.evidence_of(dn, db, dt, persistence, clear, reference)
            geom_json = f["geometry"]
            ring = geom_json["coordinates"][0] if geom_json["type"] == "Polygon" else geom_json["coordinates"][0][0]
            lons, lats = [q[0] for q in ring], [q[1] for q in ring]
            eid = f"TT-{analysis_id[-4:].upper()}-{c_year}-{n:02d}"
            features.append({
                "type": "Feature", "id": eid, "geometry": geom_json,
                "properties": {
                    "id": eid, "aoi_id": analysis_id,
                    "title": f"{'Burn scar' if fire else 'Forest-cover change'} #{n}",
                    "sector": f"{n:02d}", "change_type": "fire" if fire else "clearing",
                    "change_label": "Burn scar (spectral heuristic)" if fire else "Forest-cover change",
                    "year_from": b_year, "year_to": c_year, "composite_window": "Annual composites",
                    # Polygons consist only of pixels that passed the change rule, so the converted share is 1 by construction.
                    "area_ha": round(area, 1), "area_km2": round(area / 100, 3), "conversion_fraction": 1.0,
                    "centroid": [round(sum(lons) / len(lons), 5), round(sum(lats) / len(lats), 5)],
                    "bbox": [min(lons), min(lats), max(lons), max(lats)],
                    "indices": {
                        "ndvi": {"before": round(nb, 3), "after": round(na, 3), "change": round(dn, 3)},
                        "nbr": {"before": round(bb, 3), "after": round(ba, 3), "change": round(db, 3)},
                        "tree_prob": {"before": round(tb, 3), "after": round(ta, 3), "change": round(dt, 3)},
                    },
                    "land_cover": {"before": "trees", "after": label},
                    "severity": sev, "confidence": ev, "persistence": persistence,
                    "clear_obs_min": clear, "reference_overlap": reference,
                    "timeseries": [
                        {"year": b_year, "ndvi": round(nb, 3), "nbr": round(bb, 3), "tree_prob": round(tb, 3)},
                        {"year": c_year, "ndvi": round(na, 3), "nbr": round(ba, 3), "tree_prob": round(ta, 3)},
                    ],
                },
            })
        tm.log("event_serialization (python)", time.monotonic() - t_ser)
        return features, candidates

    # ----------------------------------------------------------------- tiles
    @staticmethod
    def _render(kind: str, img):
        """Styled image of one layer kind (`img` = a composite, or the change mask for kind 'change')."""
        if kind == "imagery":
            return img.select(["red", "green", "blue"]).visualize(**IMAGERY_VIS_PARAMS)
        if kind == "forest":
            return img.select("forest").selfMask().visualize(palette=FOREST_PALETTE, opacity=0.85)
        if kind == "change":
            return img.visualize(palette=CHANGE_PALETTE)
        raise EarthEngineError("unknown_layer", f"Unknown layer kind {kind!r}.")

    def tile_url(self, analysis_id: str, kind: str, year: int, geometry: dict[str, Any] | None = None,
                 baseline: int | None = None) -> str:
        """EE tile URL template for a rendered layer (map IDs are cached per layer and refreshed when old).

        `geometry` (the analysed AOI) lets layers be rebuilt after a backend restart, when nothing is in memory. The
        rebuild uses the SAME builders as the analysis (`_render`, `change_mask`), so a change layer is rebuilt as the
        change mask between `baseline` and `year` — never as another layer.
        """
        if kind not in LAYER_KINDS:
            raise EarthEngineError("unknown_layer", f"Unknown layer kind {kind!r}.")
        if kind == "change" and (baseline is None or not baseline < year):
            raise EarthEngineError("unknown_layer", "A change layer needs a baseline year before its comparison year.")
        key = layer_key(analysis_id, kind, year, baseline)
        cached = self.cached_mapid(key)
        if cached:
            return cached
        with self.mapid_lock(key):
            cached = self.cached_mapid(key)   # built by the request we waited for
            return cached or self._build_tile_url(key, analysis_id, kind, year, geometry, baseline)

    def _build_tile_url(self, key: tuple, analysis_id: str, kind: str, year: int, geometry: dict[str, Any] | None,
                        baseline: int | None) -> str:
        self.initialize()
        img = self._images.get(key)
        if img is None:
            req = self._requests.get(analysis_id) or ({"geometry": geometry} if geometry else None)
            if not req:
                raise EarthEngineError("unknown_layer", "This live analysis is no longer in memory; run the analysis again.")
            g = _ee().Geometry(req["geometry"])
            if kind == "change":
                img = self._render("change", change_mask(self._composite(g, baseline)[0], self._composite(g, year)[0]))
            else:
                img = self._render(kind, self._composite(g, year)[0])
            self._images[key] = img
        mapid = _ee().data.getMapId({"image": img})
        url = mapid["tile_fetcher"].url_format
        self.store_mapid(key, url)
        return url


provider = EarthEngineProvider()
