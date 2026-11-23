"""Static XYZ map tiles for the website's case-study map, rendered from the cached rasters only (no Earth Engine).

    .venv\\Scripts\\python render_tiles.py               # z8–z12
    .venv\\Scripts\\python render_tiles.py --max-zoom 11 # smaller output

Layers — the same classes, colours and LST colour ranges as the publication maps in outputs/maps (terratrace_analysis.maps):
  lulc_<year>            land use / land cover (class colours from config.toml)
  change_<a>_<b>         land-cover change categories (maps.CHANGE_CLASSES, maps.change_codes)
  lst_<season>_<year>    land surface temperature, inferno, one colour range per season shared by all years (maps.lst_range)

Web Mercator (EPSG:3857), 256 px PNG tiles. At z12 one tile pixel is ~34 m here, the 30 m data's own resolution, so no
deeper zoom is rendered (the map enlarges z12 tiles). Below z12 each tile pixel aggregates the 30 m pixels under it
(an 8 × 8 sample grid at most): the most frequent class for land cover and change, the mean for temperature. Tiles are
transparent outside the study area and where no valid temperature exists. Pixels are sampled from the UTM 43N grid by
nearest neighbour after reprojection (pyproj); no value is interpolated or invented.

Output: frontend/public/case-studies/<id>/tiles/<layer>/<z>/<x>/<y>.png, tiles.json (bounds, zooms, legends, sizes) and
boundary.geojson (the study-area outline used by the maps).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path

import numpy as np
from matplotlib import colormaps
from matplotlib import colors as mcolors
from PIL import Image
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parent))

from terratrace_analysis import config as config_mod  # noqa: E402
from terratrace_analysis.download import Grid  # noqa: E402
from terratrace_analysis.maps import CHANGE_CLASSES, change_codes, lst_range  # noqa: E402
from terratrace_analysis.stats import load_year  # noqa: E402

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "outputs" / "cache"
CASE_ID = "noida-ghaziabad"
DEST = ROOT.parent / "frontend" / "public" / "case-studies" / CASE_ID
TILE = 256
MIN_ZOOM = 8
NATIVE_ZOOM = 12             # ~34 m per tile pixel at 28.4°N: the 30 m grid's own resolution
MAX_SUPERSAMPLE = 8          # samples per tile-pixel side at low zooms
CLEAR = 255                  # palette index of transparent pixels
NOT_CLASSIFIED = "#ffffff"   # as in the publication maps
R = 6378137.0                # Web Mercator sphere radius


def hexrgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def tile_range(bounds: tuple[float, float, float, float], z: int) -> tuple[range, range]:
    """XYZ tile columns and rows covering a lon/lat bounding box at zoom z."""
    w, s, e, n = bounds
    k = 2 ** z

    def xy(lon: float, lat: float) -> tuple[float, float]:
        r = math.radians(lat)
        return (lon + 180) / 360 * k, (1 - math.asinh(math.tan(r)) / math.pi) / 2 * k
    x0, y0 = xy(w, n)
    x1, y1 = xy(e, s)
    return range(int(x0), int(x1) + 1), range(int(y0), int(y1) + 1)


class Sampler:
    """Maps each tile pixel to the 30 m UTM grid pixels under it (f × f samples per tile pixel)."""

    def __init__(self, grid: Grid, aoi: np.ndarray):
        self.grid, self.aoi = grid, aoi
        self.to_utm = Transformer.from_crs("EPSG:3857", grid.crs, always_xy=True)

    def index(self, z: int, x: int, y: int, f: int) -> tuple[np.ndarray, np.ndarray]:
        size = 2 * math.pi * R / 2 ** z
        minx, maxy = -math.pi * R + x * size, math.pi * R - y * size
        n = TILE * f
        step = size / n
        mx = minx + (np.arange(n) + 0.5) * step
        my = maxy - (np.arange(n) + 0.5) * step
        X, Y = np.meshgrid(mx, my)
        e, nn = self.to_utm.transform(X, Y)
        col = np.floor((e - self.grid.x0) / self.grid.scale).astype(np.int64)
        row = np.floor((self.grid.y0 - nn) / self.grid.scale).astype(np.int64)
        ok = (col >= 0) & (col < self.grid.width) & (row >= 0) & (row < self.grid.height)
        flat = np.where(ok, row * self.grid.width + np.clip(col, 0, self.grid.width - 1), 0)
        inside = ok & self.aoi.ravel()[flat]
        return flat, inside


def blocks(a: np.ndarray, f: int) -> np.ndarray:
    """(256·f, 256·f) → (256, 256, f·f): the samples under each tile pixel."""
    return a.reshape(TILE, f, TILE, f).swapaxes(1, 2).reshape(TILE, TILE, f * f)


def categorical(values: np.ndarray, flat: np.ndarray, inside: np.ndarray, f: int, n_codes: int) -> np.ndarray:
    """Most frequent code (0..n_codes) among the samples inside the study area; CLEAR where most samples are outside."""
    s = np.where(inside, values.ravel()[flat], CLEAR).astype(np.uint8)
    if f == 1:
        return s
    b = blocks(s, f)
    counts = np.stack([(b == k).sum(-1) for k in range(n_codes + 1)], -1)
    out = counts.argmax(-1).astype(np.uint8)
    out[blocks(inside, f).mean(-1) < 0.5] = CLEAR
    return out


def continuous(values: np.ndarray, flat: np.ndarray, inside: np.ndarray, f: int, vmin: float, vmax: float, levels: int) -> np.ndarray:
    """Mean of the valid samples, as a palette index 0..levels-1 over [vmin, vmax] (clipped, like the maps' colour bar)."""
    s = np.where(inside, values.ravel()[flat], np.nan)
    if f > 1:
        b = blocks(s, f)
        ok = np.isfinite(b)
        cnt = ok.sum(-1)
        mean = np.where(cnt > 0, np.where(ok, b, 0).sum(-1) / np.maximum(cnt, 1), np.nan)
        mean[blocks(inside, f).mean(-1) < 0.5] = np.nan
        s = mean
    t = np.clip((s - vmin) / (vmax - vmin), 0, 1)
    idx = np.where(np.isfinite(s), np.rint(t * (levels - 1)), CLEAR)
    return idx.astype(np.uint8)


def save_png(idx: np.ndarray, palette: list[tuple[int, int, int]], path: Path) -> int:
    im = Image.fromarray(idx, "P")
    flat = [c for rgb in palette for c in rgb]
    im.putpalette(flat + [0] * (768 - len(flat)))
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, optimize=True, transparency=CLEAR)
    return path.stat().st_size


def remove_tree(path: Path) -> None:
    """Delete every old tile file, then the folders that can be removed. On OneDrive a just-emptied folder can stay locked for
    a while; an empty folder left behind is harmless (no stale tile can survive, and git does not track folders)."""
    for f in path.rglob("*"):
        if f.is_file():
            f.unlink()
    for d in sorted((d for d in path.rglob("*") if d.is_dir()), key=lambda d: len(d.parts), reverse=True) + [path]:
        try:
            d.rmdir()
        except OSError:
            pass

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--max-zoom", type=int, default=12, choices=range(MIN_ZOOM, NATIVE_ZOOM + 1))
    a = ap.parse_args()
    cfg = config_mod.load()
    grid = Grid.load(CACHE / "grid.json")
    aoi = np.load(CACHE / "aoi_mask.npy").astype(bool)
    years = sorted(int(p.name) for p in CACHE.iterdir() if p.is_dir() and p.name.isdigit() and (p / "meta.json").exists())

    # Study-area outline (the same dissolved outline the maps draw), in lon/lat, and its bounding box.
    to_ll = Transformer.from_crs(grid.crs, "EPSG:4326", always_xy=True)
    coords = json.loads((CACHE / "aoi_outline_utm.json").read_text(encoding="utf-8"))
    polys = coords if isinstance(coords[0][0][0], list) else [coords]
    ll_polys = [[[[round(v, 6) for v in to_ll.transform(*p)] for p in ring] for ring in poly] for poly in polys]
    lons = [p[0] for poly in ll_polys for ring in poly for p in ring]
    lats = [p[1] for poly in ll_polys for ring in poly for p in ring]
    bounds = (min(lons), min(lats), max(lons), max(lats))

    lulc_pal = [hexrgb(NOT_CLASSIFIED)] + [hexrgb(c.color) for c in cfg.classes]
    change_pal = [hexrgb(NOT_CLASSIFIED)] + [hexrgb(c) for _, c in CHANGE_CLASSES]
    levels = 255
    lst_pal = [tuple(int(round(v * 255)) for v in rgba[:3]) for rgba in colormaps["inferno"](np.linspace(0, 1, levels))]
    ranges = {s: lst_range(CACHE, aoi, years, s) for s in ("summer", "winter")}

    layers: dict[str, dict] = {}
    data = {y: load_year(CACHE, y) for y in years}
    for y in years:
        layers[f"lulc_{y}"] = {"kind": "lulc", "year": y, "values": data[y]["lulc"]}
    for p, q in combinations(years, 2):
        layers[f"change_{p}_{q}"] = {"kind": "change", "from_year": p, "to_year": q, "values": change_codes(data[p]["lulc"], data[q]["lulc"])}
    for s in ("summer", "winter"):
        for y in years:
            layers[f"lst_{s}_{y}"] = {"kind": "lst", "season": s, "year": y, "values": data[y][f"lst_{s}"]}

    out = DEST / "tiles"
    if out.exists():
        remove_tree(out)
    sampler = Sampler(grid, aoi)
    sizes = {k: 0 for k in layers}
    files = 0
    for z in range(MIN_ZOOM, a.max_zoom + 1):
        f = min(2 ** (NATIVE_ZOOM - z), MAX_SUPERSAMPLE)   # samples per tile-pixel side: 1 at the native zoom
        xs, ys = tile_range(bounds, z)
        for x in xs:
            for y in ys:
                flat, inside = sampler.index(z, x, y, f)
                for name, L in layers.items():
                    if L["kind"] == "lulc":
                        idx, pal = categorical(L["values"], flat, inside, f, len(cfg.classes)), lulc_pal
                    elif L["kind"] == "change":
                        idx, pal = categorical(L["values"], flat, inside, f, len(CHANGE_CLASSES)), change_pal
                    else:
                        vmin, vmax = ranges[L["season"]]
                        idx, pal = continuous(L["values"], flat, inside, f, vmin, vmax, levels), lst_pal
                    sizes[name] += save_png(idx, pal, out / name / str(z) / str(x) / f"{y}.png")
                    files += 1
        print(f"z{z}: {len(xs) * len(ys)} tiles per layer (supersampling {f}×{f})")

    sq = cfg.scale ** 2 / 1e6
    change_km2 = {name: [float((L["values"][aoi] == i).sum() * sq) for i in range(1, len(CHANGE_CLASSES) + 1)]
                  for name, L in layers.items() if L["kind"] == "change"}
    stops = np.linspace(0, 1, 9)
    manifest = {
        "id": CASE_ID, "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "analysis/outputs/cache rasters (the pipeline's 30 m UTM 43N grid); rendered by analysis/render_tiles.py, no Earth Engine",
        "tile_size": TILE, "minzoom": MIN_ZOOM, "maxzoom": a.max_zoom, "bounds": [round(v, 6) for v in bounds],
        "tiles": "tiles/{layer}/{z}/{x}/{y}.png",
        "layers": [{"id": k, **{kk: vv for kk, vv in L.items() if kk != "values"}, "bytes": sizes[k]} for k, L in layers.items()],
        "legends": {
            "lulc": [{"code": 0, "name": "Not classified", "color": NOT_CLASSIFIED}] + [{"code": c.code, "name": c.name, "color": c.color} for c in cfg.classes],
            "change": [{"code": i, "name": n, "color": c} for i, (n, c) in enumerate(CHANGE_CLASSES, 1)],
            "change_km2": change_km2,
            "lst": {s: {"vmin": round(r[0], 2), "vmax": round(r[1], 2),
                        "stops": [mcolors.to_hex(colormaps["inferno"](v)) for v in stops]} for s, r in ranges.items()},
        },
        "files": files, "bytes": sum(sizes.values()),
    }
    (DEST / "tiles.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    (DEST / "boundary.geojson").write_text(json.dumps({
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {"name": cfg.study["short_name"]},
                      "geometry": {"type": "MultiPolygon", "coordinates": ll_polys}}]}, separators=(",", ":")), encoding="utf-8")
    print(f"{files} tiles, {manifest['bytes'] / 1e6:.2f} MB → {out.relative_to(ROOT.parent).as_posix()}")
    for k in layers:
        print(f"  {k}: {sizes[k] / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
