"""A/B: single combined request vs concurrent per-year requests (developer tool; nothing cached).

    .venv/Scripts/python scripts/dev/ee_ab_parallel.py <aoi-id> <dlon>

Builds two COLD AOIs (the given AOI shifted ±dlon, same shape/size, never analysed), runs
A = workers=1 (current single request) and B = workers=8 (concurrent), then re-runs A's AOI with
workers=8 and checks that every statistic is identical to the single-request result.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.providers.earth_engine import provider as P  # noqa: E402
from app.services.geometry import validate_aoi  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
logging.getLogger("googleapiclient").setLevel(logging.WARNING)

aid, dlon = sys.argv[1], float(sys.argv[2])
doc = json.loads((Path(__file__).resolve().parents[2] / ".cache" / "aois" / f"{aid}.json").read_text(encoding="utf-8"))


def shifted(d: float):
    g = json.loads(json.dumps(doc["geometry"]))
    g["coordinates"] = [[[x + d, y] for x, y in ring] for ring in g["coordinates"]]
    return validate_aoi(g, enforce_limits=False)


P.provider.initialize()
KEYS = ("forest_ha", "forest_pct", "loss_ha", "gain_ha", "compared_ha", "mean_ndvi", "mean_nbr", "coverage_pct", "clear_obs_median", "dw_obs_median", "passes_quality", "previous_year")


def run(label: str, aoi, workers: int):
    print(f"\n===== {label}: {aoi.area_km2:.2f} km² centroid {aoi.centroid} workers={workers} =====", flush=True)
    t = time.monotonic()
    res = P.provider.analyze(aoi, f"ab-{label}", label, 2018, 2025, workers=workers)
    el = time.monotonic() - t
    print(f"===== {label}: {el:.1f}s → {res['status']} {res.get('reasonCode') or ''}", flush=True)
    rows = {r["year"]: r for r in (res.get("summary") or {}).get("years", [])}
    return el, res, rows


a_aoi, b_aoi = shifted(+dlon), shifted(-dlon)
ta, ra, rows_a = run("A_single_request_cold", a_aoi, 1)
tb, rb, rows_b = run("B_concurrent_cold", b_aoi, 8)
tc, rc, rows_c = run("A_again_concurrent_warm", a_aoi, 8)

print("\n===== EQUIVALENCE (A single request vs A concurrent) =====")
qa = {y["year"]: y for y in ra["quality"]["years"]}
qc = {y["year"]: y for y in rc["quality"]["years"]}
diffs = [(y, k, qa[y][k], qc[y][k]) for y in qa for k in ("coverage_pct", "clear_obs_median", "dw_obs_median", "passes") if qa[y][k] != qc[y][k]]
diffs += [(y, k, rows_a[y].get(k), rows_c.get(y, {}).get(k)) for y in rows_a for k in KEYS if rows_a[y].get(k) != rows_c.get(y, {}).get(k)]
same_status = (ra["status"], ra.get("reasonCode")) == (rc["status"], rc.get("reasonCode"))
same_kpis = (ra.get("summary") or {}).get("kpis") == (rc.get("summary") or {}).get("kpis")
print(f"status identical: {same_status}  kpis identical: {same_kpis}  differing values: {len(diffs)}")
for d in diffs[:20]:
    print("  DIFF", d)
print(f"\nSUMMARY  cold single-request {ta:.1f}s  |  cold concurrent {tb:.1f}s  |  warm concurrent {tc:.1f}s")
