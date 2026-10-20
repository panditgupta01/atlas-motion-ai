#!/usr/bin/env bash
# Starts AtlasMotion AI with Docker and opens it in the browser. Needs only Docker.
# Usage: ./start.sh [--no-browser]
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and run this again."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start Docker Desktop, wait until it says it is running, then run this again."
  exit 1
fi

# First run: create .env from the example with a fresh random session secret.
if [ ! -f .env ]; then
  secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed "s/^JWT_SECRET=.*/JWT_SECRET=${secret}/" .env.example > .env
  echo "Created .env with a new random JWT_SECRET."
fi

url="http://localhost:4000"
if [ -n "${CODESPACE_NAME:-}" ]; then
  export PUBLIC_URL="https://${CODESPACE_NAME}-4000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  url="$PUBLIC_URL"
fi

echo "Building and starting AtlasMotion AI. The first run downloads and builds everything, which takes a while."
docker compose --profile app up -d --build

echo "Waiting for the app to answer..."
for _ in $(seq 1 240); do
  if curl -fsS http://localhost:4000/api/v1/health >/dev/null 2>&1; then
    echo
    echo "AtlasMotion AI is running at $url"
    echo "Sharp Sentinel-2 imagery for Nepal is prepared in the background on the first run."
    echo "Videos made before it finishes use coarser imagery. Progress: docker compose logs -f imagery"
    echo "To stop the app, run ./stop.sh (or double-click stop.command / stop.bat)."
    if [ "${1:-}" != "--no-browser" ] && [ -z "${CODESPACE_NAME:-}" ]; then
      if command -v open >/dev/null 2>&1; then open "$url"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || true; fi
    fi
    exit 0
  fi
  sleep 5
done
echo "The app did not start. Showing its last log lines:"
docker compose --profile app logs --tail 40 api worker
exit 1
