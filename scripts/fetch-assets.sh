#!/usr/bin/env bash
# Downloads the public-domain Natural Earth vector data and the OFL Noto fonts
# used by the renderer. Safe to re-run; existing files are kept.
set -euo pipefail
cd "$(dirname "$0")/.."
NE_REF="${NE_REF:-master}"
NE_BASE="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_REF}"
mkdir -p data/natural-earth assets/fonts
for f in ne_10m_admin_0_countries ne_50m_admin_0_countries ne_110m_admin_0_countries \
         ne_10m_rivers_lake_centerlines ne_50m_rivers_lake_centerlines ne_110m_rivers_lake_centerlines \
         ne_10m_lakes ne_50m_lakes ne_110m_lakes ne_10m_populated_places_simple; do
  if [ ! -s "data/natural-earth/$f.geojson" ]; then
    echo "Downloading $f"
    curl -fsSL -o "data/natural-earth/$f.geojson" "$NE_BASE/geojson/$f.geojson"
  fi
done
[ -s data/natural-earth/LICENSE.md ] || curl -fsSL -o data/natural-earth/LICENSE.md "$NE_BASE/LICENSE.md"
G="https://raw.githubusercontent.com/google/fonts/main/ofl"
[ -s assets/fonts/NotoSans.ttf ] || curl -fsSL -o assets/fonts/NotoSans.ttf "$G/notosans/NotoSans%5Bwdth,wght%5D.ttf"
[ -s assets/fonts/NotoSansDevanagari.ttf ] || curl -fsSL -o assets/fonts/NotoSansDevanagari.ttf "$G/notosansdevanagari/NotoSansDevanagari%5Bwdth,wght%5D.ttf"
[ -s assets/fonts/OFL.txt ] || curl -fsSL -o assets/fonts/OFL.txt "$G/notosans/OFL.txt"
echo "Assets ready."
