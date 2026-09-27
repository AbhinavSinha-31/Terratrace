"""Earth Engine verification utility — read-only, no analysis, no downloads.

    python -m app.ee_check [--project ID]

1. Initialises Earth Engine with the existing credentials (user credentials from
   `earthengine authenticate`, or a service-account key if EE_SERVICE_ACCOUNT_KEY is set).
2. Makes one trivial real request to prove the connection works.
3. For every dataset referenced by providers/earth_engine/provider.py, reads the
   catalog metadata and the band names of one image (metadata only — no pixels).
4. If the Hansen ID is invalid, lists the UMD/hansen catalog folder and reports the
   valid Global Forest Change IDs found there (never guessed).

Prints a PASS/FAIL report and exits 0 only if everything passes. Never prints
tokens or key contents.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .providers.earth_engine import provider as p

HANSEN_FOLDER = "projects/earthengine-public/assets/UMD/hansen"


@dataclass(frozen=True)
class DatasetSpec:
    key: str
    label: str
    asset_id: str
    kind: str  # "ImageCollection" | "Image"
    bands: tuple[str, ...]


@dataclass
class Result:
    name: str
    ok: bool
    detail: str = ""
    extra: list[str] = field(default_factory=list)


def dataset_specs() -> list[DatasetSpec]:
    """Every dataset the provider references, with the bands it reads — taken from provider.py itself."""
    specs = [
        DatasetSpec("s2", "Sentinel-2 SR Harmonized", p.S2, "ImageCollection", ("B2", "B3", "B4", "B8", "B11", "B12")),
        DatasetSpec("csplus", "Cloud Score+ (S2 Harmonized)", p.CSPLUS, "ImageCollection", ("cs_cdf",)),
        DatasetSpec("dw", "Dynamic World V1", p.DW, "ImageCollection", ("trees", "label")),
    ]
    for cid, bands in p.LANDSAT.items():
        sensor = cid.split("/")[1]
        specs.append(DatasetSpec(f"landsat-{sensor.lower()}", f"Landsat C2 L2 SR ({sensor})", cid, "ImageCollection", (*bands, "QA_PIXEL")))
    specs.append(DatasetSpec("hansen", "Hansen Global Forest Change", p.HANSEN, "Image", ("lossyear", "treecover2000")))
    return specs


def resolve_project(cli_project: str | None) -> tuple[str | None, str]:
    """Project ID and where it came from: --project > EE_PROJECT > earthengine CLI config. No built-in default."""
    if cli_project:
        return cli_project, "--project"
    if os.environ.get("EE_PROJECT"):
        return os.environ["EE_PROJECT"], "EE_PROJECT"
    creds = Path(os.environ.get("EARTHENGINE_CREDENTIALS", Path.home() / ".config" / "earthengine" / "credentials"))
    try:
        project = json.loads(creds.read_text(encoding="utf-8")).get("project")
        if project:
            return project, "earthengine set_project"
    except (OSError, ValueError):
        pass
    return None, "not set"


def _reason(e: BaseException) -> str:
    """Exact failure reason, with anything token-like redacted."""
    msg = f"{type(e).__name__}: {e}".strip()
    msg = re.sub(r"(ya29\.|1//)[\w\-.]+", "[redacted]", msg)
    return re.sub(r"\s+", " ", msg)[:400]


def initialize(ee: Any, project: str) -> Result:
    try:
        key = os.environ.get("EE_SERVICE_ACCOUNT_KEY")
        if key and Path(key).expanduser().exists():
            email = json.loads(Path(key).expanduser().read_text(encoding="utf-8"))["client_email"]
            ee.Initialize(ee.ServiceAccountCredentials(email, key_file=str(Path(key).expanduser())), project=project)
            how = "service-account key"
        else:
            ee.Initialize(project=project)
            how = "user credentials"
        return Result("Earth Engine initialisation", True, f"{how}, project {project}")
    except Exception as e:  # noqa: BLE001
        return Result("Earth Engine initialisation", False, _reason(e))


def live_request(ee: Any) -> Result:
    try:
        v = ee.Number(20).add(22).getInfo()
        ok = v == 42
        return Result("Real server request", ok, "ee.Number(20).add(22) → 42" if ok else f"unexpected response {v!r}")
    except Exception as e:  # noqa: BLE001
        return Result("Real server request", False, _reason(e))


def check_dataset(ee: Any, spec: DatasetSpec) -> Result:
    name = f"{spec.label} · {spec.asset_id}"
    try:
        meta = ee.data.getAsset(spec.asset_id)
    except Exception as e:  # noqa: BLE001
        return Result(name, False, f"catalog lookup failed — {_reason(e)}")
    kind = str(meta.get("type", "")).upper().replace("_", "")
    if kind != spec.kind.upper():
        return Result(name, False, f"expected {spec.kind}, catalog says {meta.get('type')}")
    try:
        img = ee.ImageCollection(spec.asset_id).first() if spec.kind == "ImageCollection" else ee.Image(spec.asset_id)
        bands = img.bandNames().getInfo() or []
    except Exception as e:  # noqa: BLE001
        return Result(name, False, f"band metadata request failed — {_reason(e)}")
    missing = [b for b in spec.bands if b not in bands]
    if missing:
        return Result(name, False, f"accessible, but bands used by the pipeline are missing: {', '.join(missing)}")
    return Result(name, True, f"{spec.kind}; bands used present ({', '.join(spec.bands)})")


def hansen_catalog(ee: Any) -> list[str]:
    """Valid Global Forest Change image IDs listed in the public UMD/hansen folder (newest first)."""
    out: list[str] = []
    token = None
    while True:
        params: dict[str, Any] = {"parent": HANSEN_FOLDER}
        if token:
            params["pageToken"] = token
        page = ee.data.listAssets(params)
        for a in page.get("assets", []):
            aid = a.get("id") or a.get("name", "").replace("projects/earthengine-public/assets/", "")
            if "global_forest_change" in aid and str(a.get("type", "")).upper() == "IMAGE":
                out.append(aid)
        token = page.get("nextPageToken")
        if not token:
            break
    return sorted(out, reverse=True)


def run(ee: Any, project: str) -> list[Result]:
    results = [initialize(ee, project)]
    if not results[0].ok:
        return results
    results.append(live_request(ee))
    if not results[-1].ok:
        return results
    for spec in dataset_specs():
        r = check_dataset(ee, spec)
        if spec.key == "hansen" and not r.ok:
            try:
                valid = hansen_catalog(ee)
                r.extra.append("valid IDs in the Earth Engine catalog: " + (", ".join(valid) if valid else "none found"))
            except Exception as e:  # noqa: BLE001
                r.extra.append(f"could not list {HANSEN_FOLDER}: {_reason(e)}")
        results.append(r)
    return results


def report(results: list[Result], project: str, source: str) -> str:
    lines = ["TERRATRACE · Earth Engine verification", f"Project ID: {project}  (from {source})", ""]
    for r in results:
        lines.append(f"{'PASS' if r.ok else 'FAIL'}  {r.name}")
        if r.detail:
            lines.append(f"      {r.detail}")
        lines.extend(f"      {x}" for x in r.extra)
    failed = sum(not r.ok for r in results)
    lines += ["", f"{len(results) - failed}/{len(results)} checks passed" + ("" if failed else " — Earth Engine is ready for TERRATRACE.")]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Verify Earth Engine access and every dataset TERRATRACE uses (read-only).")
    ap.add_argument("--project", help="Google Cloud project ID (else EE_PROJECT, then the earthengine CLI project)")
    args = ap.parse_args(argv)
    project, source = resolve_project(args.project)
    if not project:
        print("FAIL  No Earth Engine project: pass --project, set EE_PROJECT, or run `earthengine set_project`.")
        return 1
    try:
        import ee
    except ImportError as e:
        print(report([Result("Earth Engine initialisation", False, f"earthengine-api not installed — {e}")], project, source))
        return 1
    results = run(ee, project)
    print(report(results, project, source))
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
