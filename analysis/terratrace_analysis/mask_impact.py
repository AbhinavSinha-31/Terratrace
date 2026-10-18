"""What did the LST uncertainty mask (ST_QA ≤ max_st_uncertainty_k) change?  One-off audit, written to
outputs/tables/lst_mask_impact.csv. Compares the LST composites downloaded before the mask
(cache/<year>/lst_<season>_before_stqa_mask.npy) with the current ones, using the SAME LULC map for both,
so any difference in the UHI numbers comes from the mask alone.

    .venv\\Scripts\\python -m terratrace_analysis.mask_impact
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from . import config
from .stats import WATER, uhi, urban_core

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    cfg = config.load()
    cache = ROOT / "outputs" / "cache"
    aoi = np.load(cache / "aoi_mask.npy").astype(bool)
    rows = []
    for y in (2005, 2015, 2025):
        d = cache / str(y)
        if not (d / "lst_summer_before_stqa_mask.npy").exists():
            continue
        lulc = np.load(d / "lulc.npy")
        core = urban_core(cfg, lulc, aoi)
        for s in ("summer", "winter"):
            before = np.load(d / f"lst_{s}_before_stqa_mask.npy")
            after = np.load(d / f"lst_{s}.npy")
            vb, va = aoi & np.isfinite(before), aoi & np.isfinite(after)
            both = vb & va
            diff = np.abs(after - before)
            ub = {r["method"]: r["uhi_intensity_c"] for r in uhi(cfg, lulc, before, aoi, core)}
            ua = {r["method"]: r["uhi_intensity_c"] for r in uhi(cfg, lulc, after, aoi, core)}
            land = aoi & (lulc > 0) & (lulc != WATER)
            rows.append({
                "year": y, "season": s,
                "pixels_with_lst_before": int(vb.sum()), "pixels_with_lst_after": int(va.sum()),
                "pixels_removed_entirely": int((vb & ~va).sum()),
                "pixels_changed_over_1c": int((both & (diff > 1)).sum()),
                "pixels_over_55c_before": int((vb & (before > 55)).sum()), "pixels_over_55c_after": int((va & (after > 55)).sum()),
                "max_land_lst_before_c": float(np.nanmax(np.where(land, before, np.nan))),
                "max_land_lst_after_c": float(np.nanmax(np.where(land, after, np.nan))),
                "p99_before_c": float(np.nanpercentile(before[vb], 99)), "p99_after_c": float(np.nanpercentile(after[va], 99)),
                "uhi_core_ring_before_c": ub["urban core vs rural ring"], "uhi_core_ring_after_c": ua["urban core vs rural ring"],
                "uhi_builtup_before_c": ub["built-up vs non-built-up land"], "uhi_builtup_after_c": ua["built-up vs non-built-up land"],
            })
    out = pd.DataFrame(rows)
    out.to_csv(ROOT / "outputs" / "tables" / "lst_mask_impact.csv", index=False)
    with pd.option_context("display.width", 250, "display.max_columns", 30):
        print(out.T)


if __name__ == "__main__":
    main()
