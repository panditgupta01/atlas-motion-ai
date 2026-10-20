#!/usr/bin/env bash
# Smoke test for the one-click Docker stack: signs up, plans a storyboard, renders a short 3D video
# through the running API and worker, and downloads it. Usage: scripts/smoke-docker.sh OUT.mp4 [BASE_URL]
set -euo pipefail
out="$1"
base="${2:-http://localhost:4000}/api/v1"
jar="$(mktemp)"
api() { curl -fsS -b "$jar" -c "$jar" -H "X-Atlas-Client: web" -H "Content-Type: application/json" "$@"; }

api -X POST "$base/auth/register" -d "{\"email\":\"smoke-$RANDOM$RANDOM@example.com\",\"password\":\"correct-horse-battery\"}" >/dev/null
project="$(api -X POST "$base/projects" -d '{"prompt":"Nepal and the Koshi river","options":{"durationSeconds":10,"language":"en"}}' | jq -r .project.id)"
version="$(api -X POST "$base/projects/$project/storyboard" -d '{"provider":"gazetteer"}' | jq -r 'if .validation.ok then .version else error("storyboard did not validate") end')"
render="$(api -X POST "$base/projects/$project/renders" -d "{\"formats\":[\"16:9\"],\"fps\":24,\"quality\":\"draft\",\"subtitles\":\"burned\",\"narration\":true,\"ambience\":true,\"storyboardVersion\":$version}" | jq -r .render.id)"
echo "Rendering $render"
for _ in $(seq 1 240); do
  r="$(api "$base/renders/$render")"
  status="$(jq -r .render.status <<<"$r")"
  case "$status" in
    completed) break ;;
    failed|cancelled) jq .render <<<"$r"; exit 1 ;;
  esac
  sleep 5
done
[ "$status" = completed ] || { echo "Render timed out ($status)"; exit 1; }
url="$(jq -r '.render.outputs[] | select(.kind=="video") | .downloadUrl' <<<"$r" | head -1)"
case "$url" in http*) ;; *) url="${base%/api/v1}$url" ;; esac
api -o "$out" "$url"
echo "Downloaded $(wc -c <"$out") bytes to $out"
