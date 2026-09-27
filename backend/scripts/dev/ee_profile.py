"""Earth Engine cost attribution for one AOI (developer tool; read-only, nothing cached).

    .venv/Scripts/python scripts/dev/ee_profile.py <aoi-id> [baseline comparison]

Part 1 runs the REAL instrumented pipeline once (provider.analyze → [EE TIMING] logs).
Part 2 evaluates each component in ISOLATION (one getInfo each) so cost can be attributed.
Earth Engine does not cache between requests, so every isolated request recomputes the
composites it depends on — the isolated timings therefore also show how much of each
pipeline request is composite recomputation. Same expressions/thresholds as the pipeline.
"""

from __future__ import annotations

import json
import logging
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.providers import registry  # noqa: E402
from app.providers.earth_engine import provider as P  # noqa: E402
from app.services import science as sc  # noqa: E402
from app.services.geometry import validate_aoi  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(message)s")
logging.getLogger("googleapiclient").setLevel(logging.WARNING)
out = logging.getLogger("profile")

aid = sys.argv[1]
b_req, c_req = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else sc.DEFAULT_EVENT_WINDOW
doc = registry.get(aid) or json.loads((Path(__file__).resolve().parents[2] / ".cache" / "aois" / f"{aid}.json").read_text(encoding="utf-8"))
aoi = validate_aoi(doc["geometry"], enforce_limits=False)
prov = P.provider
prov.initialize()
ee = P._ee()
print(f"AOI {aid}: {aoi.area_km2:.2f} km², window {b_req}→{c_req}\n")

# ------------------------------------------------------------------ part 1: real pipeline
print("== Part 1: real pipeline (one run) ==")
t = time.monotonic()
res = prov.analyze(aoi, aid, doc.get("name", aid), b_req, c_req)
print(f"pipeline total {time.monotonic() - t:.1f}s → {res['status']} {res.get('reasonCode') or ''}\n")

# ------------------------------------------------------------------ part 2: isolated components
print("== Part 2: isolated components (each = one Earth Engine request, recomputing its inputs) ==")
q = res["quality"]
avail = [y["year"] for y in q["years"] if y["scenes"] and all(v for v in y["scenes"].values())]
ok = [y["year"] for y in q["years"] if y["passes"]]
hist = [y for y in avail if sc.era_of(y) == "historical"]
modern = [y for y in avail if sc.era_of(y) == "modern"]
geom = ee.Geometry(aoi.geometry)
area = ee.Image.pixelArea().divide(1e4)
S = P.ANALYSIS_SCALE


def timed(name: str, obj) -> None:
    t0 = time.monotonic()
    try:
        obj.getInfo()
        print(f"[EE TIMING] operation={name} elapsed={time.monotonic() - t0:.2f}")
    except Exception as e:  # noqa: BLE001
        print(f"[EE TIMING] operation={name} elapsed={time.monotonic() - t0:.2f} FAILED {str(e)[:160]}")


def rr(img, reducer):
    return img.reduceRegion(reducer, geom, S, maxPixels=1e10, tileScale=4)


print(f"years with scenes: {avail}\nanalysable years:  {ok}\nanalysable window: {q['analyzable_window']}\n")
timed("scene_metadata", prov.source_sizes(geom, sc.HIST_YEARS + list(range(sc.MODERN_FIRST_YEAR, 2026))))
if hist:
    timed(f"landsat_composites ({len(hist)} medians)", rr(ee.Image.cat([prov._landsat(geom, y)[0].select("nir").rename(f"n{y}") for y in hist]), ee.Reducer.mean()))
if modern:
    s2 = []
    for y in modern:
        col = prov._s2_collection(geom, y).map(lambda i: i.updateMask(i.select("cs_cdf").gte(0.6)).select(["B8"], ["nir"]).divide(10000))
        s2.append(col.median().rename(f"n{y}"))
    timed(f"sentinel2_composites ({len(modern)} medians, Cloud Score+ masked)", rr(ee.Image.cat(s2), ee.Reducer.mean()))
    timed(f"dynamic_world ({len(modern)} annual means + obs counts)", rr(ee.Image.cat(
        [prov._dw_collection(geom, y).select("trees").mean().rename(f"t{y}") for y in modern]
        + [prov._dw_collection(geom, y).select("trees").count().rename(f"c{y}") for y in modern]), ee.Reducer.mean()))

comps = {y: prov._composite(geom, y)[0] for y in avail}
timed(f"forest_mask ({len(avail)} years, full composites)", rr(ee.Image.cat([comps[y].select("forest").multiply(area).rename(f"f{y}") for y in avail]), ee.Reducer.sum()))
timed(f"coverage ({len(avail)} valid masks)", rr(ee.Image.cat([comps[y].select("valid").multiply(area).rename(f"v{y}") for y in avail]), ee.Reducer.sum()))
if ok:
    timed(f"yearly_stats ({len(ok)} forest sums + NDVI/NBR means)", ee.Dictionary({
        "f": rr(ee.Image.cat([comps[y].select("forest").multiply(area).rename(f"f{y}") for y in ok]), ee.Reducer.sum()),
        "m": rr(ee.Image.cat([comps[y].select(["ndvi", "nbr"], [f"n{y}", f"b{y}"]).updateMask(comps[y].select("valid")) for y in ok]), ee.Reducer.mean()),
    }))
    pairs = [(a, b) for a, b in zip(ok, ok[1:]) if sc.era_of(a) == sc.era_of(b)]
    if pairs:
        bands = [bb for a, b in pairs for bb in P.transition_bands(comps[a].select("forest"), comps[b].select("forest"), area, str(b))]
        timed(f"loss_gain_transitions ({len(pairs)} pairs)", rr(ee.Image.cat(bands), ee.Reducer.sum()))

win = q["analyzable_window"]
if not win:
    print("\nchange detection / events: NOT REACHED — no analysable window (the pipeline stops before events).")
else:
    b, a = comps[win[0]], comps[win[1]]
    d_ndvi = a.select("ndvi").subtract(b.select("ndvi"))
    d_nbr = a.select("nbr").subtract(b.select("nbr"))
    d_tree = a.select("trees").subtract(b.select("trees"))
    change = b.select("forest").And(a.select("forest").Not()).And(d_ndvi.lte(sc.D_NDVI).Or(d_nbr.lte(sc.D_NBR))).And(d_tree.lte(sc.D_TREE)).selfMask()
    mmu = math.ceil(sc.MMU_HA * 1e4 / P.EVENT_SCALE**2)
    change = change.updateMask(change.connectedPixelCount(256, True).gte(mmu))
    timed("change_detection_raster (candidate area, 20 m)", change.multiply(area).reduceRegion(ee.Reducer.sum(), geom, P.EVENT_SCALE, maxPixels=1e10, tileScale=4))
    vectors = change.reduceToVectors(geometry=geom, scale=P.EVENT_SCALE, geometryType="polygon", eightConnected=True, maxPixels=1e10, tileScale=4)
    timed("polygonization (reduceToVectors → count)", vectors.size())
    red = ee.Reducer.mean().combine(ee.Reducer.mode(), sharedInputs=True).combine(ee.Reducer.min(), sharedInputs=True)
    stack = ee.Image.cat([b.select(["ndvi", "nbr", "trees"], ["ndvi_b", "nbr_b", "tree_b"]),
                          a.select(["ndvi", "nbr", "trees", "label", "clear"], ["ndvi_a", "nbr_a", "tree_a", "label_a", "clear_a"])])
    timed("event_stats (reduceRegions, indices/label/obs)", stack.reduceRegions(collection=vectors, reducer=red, scale=P.EVENT_SCALE, tileScale=4).limit(P.MAX_EVENTS))
    loss = ee.Image(P.HANSEN).select("lossyear")
    ref = loss.gt(win[0] - 2000).And(loss.lte(min(win[1], P.HANSEN_LAST_YEAR) - 2000)).rename("ref")
    timed("hansen_overlap (reduceRegions on polygons)", ref.reduceRegions(collection=vectors, reducer=ee.Reducer.mean(), scale=P.EVENT_SCALE, tileScale=4).limit(P.MAX_EVENTS))
    nxt = next((y for y in ok if y > win[1] and sc.era_of(y) == "modern"), None)
    if nxt:
        timed("persistence (reduceRegions on polygons)", comps[nxt].select("forest").Not().rename("persist").reduceRegions(collection=vectors, reducer=ee.Reducer.mean(), scale=P.EVENT_SCALE, tileScale=4).limit(P.MAX_EVENTS))
    else:
        print("persistence: no analysable following year — not computed by the pipeline either")
