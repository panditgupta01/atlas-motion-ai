#!/usr/bin/env bash
# macOS: double-click in Finder to stop AtlasMotion AI.
cd "$(dirname "$0")" && ./stop.sh
echo; read -r -p "Press Return to close this window."
