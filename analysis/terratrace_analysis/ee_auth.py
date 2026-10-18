"""Earth Engine login. Credentials never live in the code or the repository.

Reads, in this order:
  1. environment variables EE_PROJECT (required) and EE_SERVICE_ACCOUNT_KEY (optional path to a key file
     stored OUTSIDE the repository);
  2. analysis/.env (git-ignored) for any of those not already set.
Without a service-account key, the login saved by `earthengine authenticate` is used.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import ee

from .config import ROOT


def _load_dotenv(path: Path) -> None:
    """Minimal KEY=VALUE reader (no extra dependency). Existing environment variables win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def initialize() -> str:
    """Initialise Earth Engine and return the Cloud project id (never prints credentials)."""
    _load_dotenv(ROOT / ".env")
    project = os.environ.get("EE_PROJECT", "").strip()
    if not project:
        raise SystemExit("EE_PROJECT is not set. Put EE_PROJECT=<your Earth Engine Cloud project> in analysis/.env "
                         "(see .env.example) or in the environment.")
    key = os.environ.get("EE_SERVICE_ACCOUNT_KEY", "").strip()
    if key:
        info = json.loads(Path(key).expanduser().read_text(encoding="utf-8"))
        ee.Initialize(ee.ServiceAccountCredentials(info["client_email"], key_file=str(Path(key).expanduser())), project=project)
    else:
        ee.Initialize(project=project)
    return project
