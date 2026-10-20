#!/usr/bin/env bash
# Stops AtlasMotion AI. Your projects, videos and prepared imagery are kept for the next start.
cd "$(dirname "$0")"
docker compose --profile app stop
