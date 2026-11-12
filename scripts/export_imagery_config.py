"""Write the frontend's offline copy of the backend basemap config (frontend/public/data/basemaps.json).

The backend (app/services/imagery.py) is the single source of imagery URLs; this copy exists only so the
UI keeps a globe when the backend is unreachable. tests/test_imagery.py fails if the two drift.

    .venv/Scripts/python scripts/export_imagery_config.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.imagery import basemaps  # noqa: E402

out = Path(__file__).resolve().parents[2] / "frontend" / "public" / "data" / "basemaps.json"
out.write_text(json.dumps(basemaps(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print("wrote frontend/public/data/basemaps.json")
