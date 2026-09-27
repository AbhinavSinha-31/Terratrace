"""Controlled Earth Engine diagnostic runs for one AOI (developer tool; results never cached/served).

    .venv/Scripts/python scripts/ee_diagnose.py <aoi-id> <baseline> <comparison> <config> [<config> ...]

config: full | no_coverage | no_yearly_stats | no_change | no_vectorize | no_hansen | no_persistence
(combine with '+', e.g. no_hansen+no_persistence). Runs are strictly sequential; each prints
[EE] START / END lines per synchronous Earth Engine evaluation and a per-run total.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.providers.earth_engine import provider as P  # noqa: E402
from app.services.geometry import validate_aoi  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
logging.getLogger("googleapiclient").setLevel(logging.WARNING)

aid, b, c, configs = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4:]
doc = json.loads((Path(__file__).resolve().parents[1] / ".cache" / "aois" / f"{aid}.json").read_text(encoding="utf-8"))
aoi = validate_aoi(doc["geometry"], enforce_limits=False)
P.provider.initialize()
print(f"AOI {aid} {aoi.area_km2:.2f} km2, window {b}->{c}")
summary = []
for cfg in configs:
    diag = frozenset() if cfg == "full" else frozenset(cfg.split("+"))
    print(f"\n===== RUN config={cfg} =====", flush=True)
    t = time.monotonic()
    try:
        res = P.provider.analyze(aoi, f"{aid}#{cfg}", doc.get("name", aid), b, c, diag=diag)
        outcome = f"{res['status']} {res.get('reasonCode') or ''} events={len((res.get('events') or {}).get('features', []))}"
    except Exception as e:  # noqa: BLE001
        outcome = f"EXCEPTION {type(e).__name__}: {str(e)[:160]}"
    summary.append((cfg, time.monotonic() - t, outcome))
    print(f"===== END config={cfg} total={time.monotonic() - t:.1f}s → {outcome}", flush=True)
print("\nSUMMARY")
for cfg, s, o in summary:
    print(f"  {cfg:32s} {s:6.1f}s  {o}")
