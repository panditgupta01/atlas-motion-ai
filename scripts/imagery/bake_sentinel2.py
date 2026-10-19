#!/usr/bin/env python3
"""
Build a prepared imagery region from Copernicus Sentinel-2 true-colour scenes.

Reads the clearest Sentinel-2 L2A scenes (TCI, 10 m) for a bounding box from the
public AWS Open Data bucket `sentinel-cogs`, mosaics them in Web Mercator,
feathers the region's edge so it blends into the global base imagery, and writes
XYZ tiles plus region.json into assets/imagery/regions/<name>/. The renderer and
the editor preview use those tiles before any network tile provider.

Licence: Copernicus Sentinel data is free and open, including commercial use,
with the credit "contains modified Copernicus Sentinel data <years>". The
region.json written here carries that credit; every frame that uses it shows it.

Requires Python 3.10+ with rasterio, numpy, pillow and mgrs:
    python3 -m pip install -r scripts/imagery/requirements.txt

Example (the Koshi basin in eastern Nepal, zoom 5 to 12):
    python3 scripts/imagery/bake_sentinel2.py --name koshi-sentinel2 \
        --bbox 85.3 26.3 88.4 28.6 --max-zoom 12

Scenes are picked from November and December (post-monsoon, clearest skies over
South Asia) by default; change --months for other regions.
"""
import argparse
import json
import math
import os
import re
import sys
import urllib.request

import mgrs
import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject

BUCKET = "https://sentinel-cogs.s3.us-west-2.amazonaws.com"
R = 6378137.0


def ls(prefix):
    xml = urllib.request.urlopen(f"{BUCKET}/?list-type=2&delimiter=/&prefix={prefix}", timeout=60).read().decode()
    return re.findall(r"<Prefix>([^<]+)</Prefix>", xml)[1:]


def grid_squares(bbox):
    m = mgrs.MGRS()
    w, s, e, n = bbox
    out = set()
    lat = s
    while lat <= n + 0.2:
        lon = w
        while lon <= e + 0.2:
            out.add(m.toMGRS(min(lat, n), min(lon, e), MGRSPrecision=0))
            lon += 0.25
        lat += 0.25
    return sorted(out)


def best_scenes(square, years, months, keep):
    zone, band, sq = square[:2], square[2], square[3:]
    found = []
    for y in years:
        for mo in months:
            for p in ls(f"sentinel-s2-l2a-cogs/{int(zone)}/{band}/{sq}/{y}/{mo}/"):
                sid = p.rstrip("/").split("/")[-1]
                try:
                    props = json.load(urllib.request.urlopen(f"{BUCKET}/{p}{sid}.json", timeout=60))["properties"]
                except Exception:
                    continue
                found.append(((props.get("eo:cloud_cover") or 100) + 0.5 * (props.get("s2:nodata_pixel_percentage") or 0), props.get("s2:nodata_pixel_percentage") or 0, p, y))
    found.sort()
    if not found:
        return []
    # A second scene only where the first one has empty corners (orbit edge).
    return found[:keep] if found[0][1] > 1 else found[:1]


def tile_of(lon, lat, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return int(x), int(y)


def feather_ramp(bbox, transform, width, height, feather_km):
    """Alpha 0..255 that rises smoothly from the bounding box's edge to full over feather_km inward."""
    w, s, e, n = bbox
    to_y = lambda lat: R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    x0, x1, y0, y1 = R * math.radians(w), R * math.radians(e), to_y(s), to_y(n)
    # Web Mercator metres are stretched by 1/cos(latitude) relative to the ground.
    f = feather_km * 1000 / math.cos(math.radians((s + n) / 2))
    xs = transform.c + (np.arange(width) + 0.5) * transform.a
    ys = transform.f + (np.arange(height) + 0.5) * transform.e
    dx = np.clip(np.minimum(xs - x0, x1 - xs) / f, 0, 1)
    dy = np.clip(np.minimum(ys - y0, y1 - ys) / f, 0, 1)
    smooth = lambda t: t * t * (3 - 2 * t)
    return np.outer(smooth(dy), smooth(dx)) * 255


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="region folder name, e.g. koshi-sentinel2")
    ap.add_argument("--bbox", nargs=4, type=float, required=True, metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    ap.add_argument("--max-zoom", type=int, default=12, help="12 is about 35 m per pixel; 13 doubles detail and quadruples size")
    ap.add_argument("--min-zoom", type=int, default=5)
    ap.add_argument("--feather-km", type=float, default=30, help="width of the fade into the global base imagery at the region's edge")
    ap.add_argument("--years", default="2023,2024")
    ap.add_argument("--months", default="11,12")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "..", "assets", "imagery", "regions"))
    args = ap.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,60}", args.name):
        sys.exit("--name must be lowercase letters, digits and dashes")
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    os.environ.setdefault("GDAL_HTTP_TIMEOUT", "60")

    years = args.years.split(",")
    months = [f"{int(m):02d}" for m in args.months.split(",")]
    scenes = []
    for sq in grid_squares(args.bbox):
        picked = best_scenes(sq, years, months, keep=2)
        print(f"{sq}: {', '.join(p[2].rstrip('/').split('/')[-1] for p in picked) or 'no scene'}", flush=True)
        scenes += picked
    if not scenes:
        sys.exit("No Sentinel-2 scenes found for this box and season.")

    z = args.max_zoom
    w, s, e, n = args.bbox
    tx0, ty0 = tile_of(w, n, z)
    tx1, ty1 = tile_of(e, s, z)
    cols, rows = tx1 - tx0 + 1, ty1 - ty0 + 1
    W, H = cols * 256, rows * 256
    world = 2 * math.pi * R
    ts = world / 2 ** z
    left, top = -world / 2 + tx0 * ts, world / 2 - ty0 * ts
    transform = from_bounds(left, top - rows * ts, left + cols * ts, top, W, H)
    mosaic = np.zeros((3, H, W), np.uint8)
    filled = np.zeros((H, W), bool)
    # Read at about 20 m, which is still finer than zoom 12 (about 35 m per pixel at 27° N).
    factor = 2 if z <= 12 else 1
    for _, _, prefix, _ in scenes:
        with rasterio.open(f"/vsicurl/{BUCKET}/{prefix}TCI.tif") as src:
            data = src.read(out_shape=(3, src.height // factor, src.width // factor), resampling=Resampling.average)
            st = src.transform * src.transform.scale(src.width / data.shape[2], src.height / data.shape[1])
            dst = np.zeros((3, H, W), np.uint8)
            for b in range(3):
                reproject(data[b], dst[b], src_transform=st, src_crs=src.crs, src_nodata=0, dst_transform=transform, dst_crs="EPSG:3857", dst_nodata=0, resampling=Resampling.bilinear)
            valid = (dst.max(axis=0) > 0) & ~filled
            mosaic[:, valid] = dst[:, valid]
            filled |= valid
        print(f"  {prefix.rstrip('/').split('/')[-1]}: {filled.mean() * 100:.1f}% filled", flush=True)

    alpha = (feather_ramp(args.bbox, transform, W, H, args.feather_km) * filled).astype(np.uint8)
    out = os.path.abspath(os.path.join(args.out, args.name))
    os.makedirs(out, exist_ok=True)
    img = Image.fromarray(np.dstack([mosaic[0], mosaic[1], mosaic[2], alpha]), "RGBA")
    del mosaic, filled
    count = 0
    while z >= args.min_zoom:
        Wz, Hz = img.size
        for r in range(Hz // 256):
            for c in range(Wz // 256):
                t = img.crop((c * 256, r * 256, c * 256 + 256, r * 256 + 256))
                a = np.asarray(t)[:, :, 3]
                if a.max() == 0:
                    continue
                p = os.path.join(out, str(z), str(tx0 + c), str(ty0 + r))
                os.makedirs(os.path.dirname(p), exist_ok=True)
                if a.min() == 255:
                    t.convert("RGB").save(p + ".jpg", quality=88)
                else:
                    t.save(p + ".png", optimize=True)
                count += 1
        # Next zoom out: pad so tile indices stay aligned, then halve.
        px, py = tx0 % 2, ty0 % 2
        c2, r2 = Wz // 256 + px, Hz // 256 + py
        c2 += c2 % 2
        r2 += r2 % 2
        canvas = Image.new("RGBA", (c2 * 256, r2 * 256))
        canvas.paste(img, (px * 256, py * 256))
        img = canvas.resize((c2 * 128, r2 * 128), Image.LANCZOS)
        tx0 //= 2
        ty0 //= 2
        z -= 1

    used_years = sorted({sc[3] for sc in scenes})
    yrs = used_years[0] if len(used_years) == 1 else f"{used_years[0]}-{used_years[-1]}"
    meta = {
        "name": args.name,
        "attribution": f"Imagery: contains modified Copernicus Sentinel data {yrs}",
        "license": "Copernicus Sentinel data terms (free and open, commercial use allowed with attribution)",
        "bbox": args.bbox,
        "minZoom": args.min_zoom,
        "maxZoom": args.max_zoom,
        "source": "Sentinel-2 L2A true-colour (TCI) scenes from the AWS Open Data sentinel-cogs bucket",
        "scenes": [sc[2].rstrip("/").split("/")[-1] for sc in scenes],
    }
    with open(os.path.join(out, "region.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"Wrote {count} tiles to {out}")


if __name__ == "__main__":
    main()
