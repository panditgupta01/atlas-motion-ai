#!/bin/sh
# Builds the sharp Sentinel-2 regions the renderer uses for Nepal, skipping any that already exist.
# A region counts as done once its region.json is written (bake_sentinel2.py writes it last).
set -e
out="${1:-assets/imagery/regions}"
here="$(dirname "$0")"
bake() {
  name="$1"; shift
  if [ -f "$out/$name/region.json" ]; then
    echo "Imagery region $name is ready."
    return
  fi
  echo "Preparing imagery region $name. This downloads Copernicus Sentinel-2 data and runs only once."
  python3 "$here/bake_sentinel2.py" --name "$name" --out "$out" "$@"
}
bake nepal-sentinel2 --bbox 80.0 26.3 88.4 30.5 --max-zoom 11
bake koshi-sentinel2 --bbox 85.3 26.3 88.4 28.6 --max-zoom 12
echo "All imagery regions are ready."
