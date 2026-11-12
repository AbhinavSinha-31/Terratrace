"""Pre-compute the featured investigations' default-window results (one at a time) and exit.

    .venv/Scripts/python scripts/precompute_featured.py

The backend also does this in the background after startup (TT_PRECOMPUTE_FEATURED, default on). Stored results of
the current method version are skipped, so re-running costs nothing. Earth Engine noncommercial quota: never run
several analyses at once.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import featured  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S")
logging.getLogger("httpx").setLevel(logging.WARNING)

if __name__ == "__main__":
    for aid, outcome in featured.precompute():
        print(f"{aid:22s} {outcome}")
