"""Sample Hansen et al. (2013) tree cover 2000 from the public GFC map tiles.

Tiles: storage.googleapis.com/earthenginepartners-hansen/tiles/gfc_v1.4/tree_alpha
Encoding: green pixels whose alpha channel is canopy cover (0–255 ≙ 0–100 %).
Used for the AOI preview (reference tree cover before analysis); never as an analysis result.
Licence: CC BY 4.0 — Hansen/UMD/Google/USGS/NASA.
"""

from __future__ import annotations

import io
import logging
import math

import httpx
from PIL import Image

from ...config import settings

log = logging.getLogger("terratrace.hansen")
URL = "https://storage.googleapis.com/earthenginepartners-hansen/tiles/gfc_v1.4/tree_alpha/{z}/{x}/{y}.png"
CACHE = settings.cache_dir / "hansen"
MAX_TILES = 16


def _tile(z: int, x: int, y: int, client: httpx.Client) -> Image.Image | None:
    path = CACHE / f"{z}_{x}_{y}.png"
    try:
        if path.exists():
            return Image.open(path).convert("RGBA")
        r = client.get(URL.format(z=z, x=x, y=y))
        if r.status_code == 404:  # ocean / no data
            return None
        r.raise_for_status()
        CACHE.mkdir(parents=True, exist_ok=True)
        path.write_bytes(r.content)
        return Image.open(io.BytesIO(r.content)).convert("RGBA")
    except (httpx.HTTPError, OSError) as e:
        raise ConnectionError(str(e)) from e


def _xy(lon: float, lat: float, z: int) -> tuple[float, float]:
    n = 2**z
    r = math.radians(lat)
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n


def tree_cover_grid(bbox: tuple[float, float, float, float], W: int, H: int) -> list[float] | None:
    """Tree-cover fraction (0–1) for a W×H grid over bbox, or None if tiles are unreachable."""
    w, s, e, n = bbox
    lat_c = (s + n) / 2
    target_m = (e - w) * 111320 * math.cos(math.radians(lat_c)) / W
    z = int(max(3, min(12, math.floor(math.log2(156543.03 * math.cos(math.radians(lat_c)) / max(target_m, 1))))))
    while z > 3:
        x0, y0 = _xy(w, n, z)
        x1, y1 = _xy(e, s, z)
        if (int(x1) - int(x0) + 1) * (int(y1) - int(y0) + 1) <= MAX_TILES:
            break
        z -= 1
    tiles: dict[tuple[int, int], Image.Image | None] = {}
    out: list[float] = []
    try:
        with httpx.Client(timeout=6.0, headers={"User-Agent": settings.user_agent}) as client:
            for j in range(H):
                lat = n - (j + 0.5) / H * (n - s)
                for i in range(W):
                    lon = w + (i + 0.5) / W * (e - w)
                    fx, fy = _xy(lon, lat, z)
                    key = (int(fx), int(fy))
                    if key not in tiles:
                        tiles[key] = _tile(z, key[0], key[1], client)
                    img = tiles[key]
                    if img is None:
                        out.append(0.0)
                        continue
                    px = img.getpixel((min(255, int((fx - key[0]) * 256)), min(255, int((fy - key[1]) * 256))))
                    out.append(px[3] / 255 if px[1] > 0 else 0.0)
    except ConnectionError as e:
        log.info("Hansen reference tiles unreachable: %s", e)
        return None
    return out


def tree_cover_fraction(bbox: tuple[float, float, float, float], inside) -> float | None:
    """Share of the AOI with ≥ 30 % canopy (Hansen forest definition) — quick 64×64 sample."""
    W = H = 64
    grid = tree_cover_grid(bbox, W, H)
    if grid is None:
        return None
    w, s, e, n = bbox
    tot = forest = 0
    for k, tc in enumerate(grid):
        lon = w + (k % W + 0.5) / W * (e - w)
        lat = n - (k // W + 0.5) / H * (n - s)
        if inside(lon, lat):
            tot += 1
            forest += tc >= 0.3
    return round(forest / tot * 100, 1) if tot else None
