"""Bring Earth Engine results to local arrays on one fixed 30 m UTM grid, so all statistics are computed locally,
reproducibly, without further Earth Engine quota.

Every raster of every year is fetched on the SAME grid (same origin, pixel size and dimensions), so pixel (r, c)
is the same 30 m square on the ground in all of them — required for transition matrices and change analysis.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import ee
import numpy as np

log = logging.getLogger("analysis.download")

NODATA_FLOAT = -9999.0
TILE = 512   # pixels per side of one computePixels request (keeps each request small and fast)


@dataclass(frozen=True)
class Grid:
    crs: str
    scale: float
    x0: float        # left edge (m)
    y0: float        # top edge (m)
    width: int
    height: int

    def extent(self) -> tuple[float, float, float, float]:
        """(left, right, bottom, top) in metres — for matplotlib imshow."""
        return self.x0, self.x0 + self.width * self.scale, self.y0 - self.height * self.scale, self.y0

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")

    @staticmethod
    def load(path: Path) -> "Grid":
        return Grid(**json.loads(path.read_text(encoding="utf-8")))


def make_grid(geom, crs: str, scale: float) -> Grid:
    """Smallest grid aligned to multiples of `scale` that covers the study area."""
    ring = geom.transform(crs, 1).bounds(1, crs).coordinates().get(0).getInfo()
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    x0 = np.floor(min(xs) / scale) * scale
    y0 = np.ceil(max(ys) / scale) * scale
    x1 = np.ceil(max(xs) / scale) * scale
    y1 = np.floor(min(ys) / scale) * scale
    return Grid(crs, float(scale), float(x0), float(y0), int(round((x1 - x0) / scale)), int(round((y0 - y1) / scale)))


def _request(image, grid: Grid, col: int, row: int, w: int, h: int):
    return ee.data.computePixels({
        "expression": image,
        "fileFormat": "NUMPY_NDARRAY",
        "grid": {
            "dimensions": {"width": w, "height": h},
            "affineTransform": {"scaleX": grid.scale, "shearX": 0, "translateX": grid.x0 + col * grid.scale,
                                "shearY": 0, "scaleY": -grid.scale, "translateY": grid.y0 - row * grid.scale},
            "crsCode": grid.crs,
        },
    })


def fetch(image, grid: Grid, bands: list[str], nodata: float = NODATA_FLOAT, retries: int = 4) -> dict[str, np.ndarray]:
    """Download `bands` of `image` over the whole grid, tile by tile (serially — Earth Engine quota).

    Masked pixels arrive as `nodata`; float bands are returned with NaN there, integer bands keep 0.
    """
    img = image.select(bands).unmask(nodata)
    out: dict[str, np.ndarray] = {}
    tiles = [(c, r) for r in range(0, grid.height, TILE) for c in range(0, grid.width, TILE)]
    for i, (c, r) in enumerate(tiles, 1):
        w, h = min(TILE, grid.width - c), min(TILE, grid.height - r)
        for attempt in range(retries):
            try:
                arr = _request(img, grid, c, r, w, h)
                break
            except ee.EEException as e:
                if attempt == retries - 1:
                    raise
                wait = 15 * (attempt + 1)
                log.warning("tile %d/%d failed (%s); retrying in %ds", i, len(tiles), str(e)[:120], wait)
                time.sleep(wait)
        for b in bands:
            if b not in out:
                out[b] = np.zeros((grid.height, grid.width), dtype=arr[b].dtype)
            out[b][r:r + h, c:c + w] = arr[b]
        log.info("  tile %d/%d", i, len(tiles))
    for b, a in out.items():
        if np.issubdtype(a.dtype, np.floating):
            a = a.astype(np.float32)
            a[a <= nodata + 1] = np.nan
            out[b] = a
    return out
