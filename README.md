# AtlasMotion AI

Turn a natural-language prompt into an animated map documentary video. AtlasMotion plans a storyboard, lets you review and edit every scene, then renders real MP4 files in 9:16 (1080×1920) and 16:9 (1920×1080) with captions and narration.

```
prompt ─▶ planner (Claude or offline gazetteer) ─▶ storyboard (versioned schema, validated)
       ─▶ editor (scenes, overlays, claims, sources) ─▶ render queue (BullMQ)
       ─▶ worker: map frames (Skia + d3-geo, Natural Earth) ─▶ FFmpeg ─▶ ffprobe validation ─▶ download
```

## What works today

- **Storyboard planning.**
  - The Claude planner (`@anthropic-ai/sdk`, structured outputs) writes scenes and narration. It needs `ANTHROPIC_API_KEY`.
  - Without a key, an offline planner builds scenes from places named in the prompt. Its narration is clearly labelled placeholder text.
  - Coordinates never come from the language model. Every place is resolved against the Natural Earth gazetteer. A place the gazetteer cannot resolve is marked "planner, unverified" and flagged for review.
- **Review before render.**
  - Each storyboard is validated against a versioned schema plus semantic checks: durations, coordinates, camera moves, narration length, and sources.
  - Factual claims are tracked per scene. An unsupported claim blocks rendering until you attach a source, mark it illustrative, or remove it.
- **Editor.**
  - Scene list with reorder, duplicate and delete. Undo and redo.
  - Gazetteer search for places, rivers and countries.
  - Overlays: title card, label, marker, country highlight, river, route, arrow and legend.
  - Claims, sources, and a live validation panel.
  - A MapLibre globe preview that uses the same camera timeline as the renderer.
  - Saves use optimistic concurrency. You can regenerate a single scene.
- **Rendering.**
  - A background worker draws every frame from vector data, encodes per-scene H.264 clips, and caches them by content hash.
  - It then adds narration (espeak-ng) and an optional generated ambience bed, normalises loudness, and burns in captions (libass) or writes an `.srt`.
  - Each output is validated with ffprobe plus a full decode. Only files that pass validation are listed as outputs.
- **Jobs.**
  - Stage tracking (queued → scenes → audio → assemble → validate → completed), per-scene progress, and logs.
  - Cancellation stops FFmpeg mid-scene. Retries reuse finished scenes. Automatic backoff for transient failures.
  - Orphaned jobs are recovered when the worker restarts.
- **Security.**
  - Email and password accounts (bcrypt), JWT in an httpOnly SameSite cookie, and a CSRF header check.
  - Per-user ownership checks: other users' objects return 404.
  - Rate limits and usage limits. Helmet headers and a CORS allowlist.
  - Allow-listed storage keys and FFmpeg paths. No user-supplied FFmpeg arguments.
  - Secrets come from the environment only.

## What it does not do (yet)

- No 3D terrain or satellite imagery. The renderer is 2D (orthographic globe and map). `getCapabilities().terrain3d` is `false`.
- No flood extents, river basins, population data or live data. No such dataset is bundled. River lines are Natural Earth centerlines.
- No ocean or sea names. "Bay of Bengal", for example, is not in the gazetteer and will not become a scene.
- Hindi map labels appear only where Natural Earth provides `name_hi`. Otherwise the English name is used. Hindi river names are matched through a small alias list (`packages/geo/src/gazetteer.ts`).
- The narration voice is espeak-ng: real and offline, but robotic. The TTS layer is a provider interface, so a cloud voice can be added. None is wired up because none was configured.
- The S3 storage driver is implemented but has not been tested against a real bucket.
- The Claude planner is covered by tests against an SDK test double only. It has not been run against the live API in this repository.
- The Docker image has not been built and verified. The registry rate-limited the build in the development environment. `docker-compose.yml` passes `docker compose config`.

## Repository layout

```
apps/api              Express 5 REST API (/api/v1), auth, OpenAPI at /api/v1/docs/openapi.json
apps/web              React 19 + Vite + Tailwind 4 studio (TanStack Query, Zustand, MapLibre)
workers/renderer      BullMQ worker: renders scenes, audio, assembly, validation, thumbnails, cleanup
packages/shared       Storyboard schema (Zod), validation, job state machine, formats, camera timeline, API DTOs
packages/geo          Natural Earth loading, simplification, clipping, gazetteer and text place matching
packages/storyboard   Planner providers (Claude, offline gazetteer), coordinate resolution, repair loop
packages/video-engine Frame renderer, FFmpeg command builders, subtitles, TTS, cache keys, assembly
packages/server-core  Config, Mongoose models, storage drivers (local, S3), queue, logging, usage limits
scripts               fetch-assets.sh, check-env.ts, sample-render.ts
tests                 unit / integration (real MongoDB) / e2e (MongoDB + Redis + real render)
```

## Requirements

- Node.js 20.11 or newer, and pnpm 10 (`corepack enable`).
- MongoDB 7 or newer, and Redis 6 or newer. `docker compose up -d mongo redis` starts both.
- FFmpeg and ffprobe with libx264 and libass. Debian and Ubuntu: `apt install ffmpeg`.
- espeak-ng for narration (optional): `apt install espeak-ng`. Without it, render with narration off.
- About 40 MB of map data and fonts, downloaded by a script.

## Setup

```bash
pnpm install
bash scripts/fetch-assets.sh          # Natural Earth (public domain) + Noto Sans / Noto Sans Devanagari (OFL)
cp .env.example .env                  # then set JWT_SECRET: openssl rand -hex 32
docker compose up -d mongo redis      # or point MONGODB_URI / REDIS_URL at your own
pnpm check:env                        # verifies config, MongoDB, Redis, FFmpeg, espeak-ng, data, fonts
```

## Running

Run each in its own terminal, or use `pnpm dev` to run all three:

```bash
pnpm dev:api       # http://localhost:4000  (API)
pnpm dev:worker    # render worker
pnpm dev:web       # http://localhost:5173  (studio; proxies /api to the API)
```

Production build:

```bash
pnpm build                            # typechecks and builds web, bundles api and worker with tsup
WEB_DIST_DIR=apps/web/dist pnpm start:api   # API also serves the studio on the same origin
pnpm start:worker
```

## Environment variables

All variables are listed with placeholders in [`.env.example`](.env.example). The important ones:

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | Session signing key, at least 32 characters. Required. |
| `MONGODB_URI`, `REDIS_URL` | Database and queue. |
| `COOKIE_SECURE` | Must be `true` in production (HTTPS). |
| `CORS_ORIGINS` | Comma-separated allowed origins for the studio. |
| `STORAGE_DRIVER` | `local` (single host) or `s3` with `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT` and credentials. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional Claude planner. Default model `claude-opus-5-5`. |
| `PLANNER_DEFAULT` | `auto` (Claude if configured, else offline), `anthropic` or `gazetteer`. |
| `RENDER_CONCURRENCY`, `RENDER_MAX_ATTEMPTS` | Worker parallelism and automatic retries. |
| `USAGE_RENDERS_PER_DAY`, `USAGE_PLANS_PER_HOUR` | Per-user limits. |
| `WEB_DIST_DIR` | Serve the built studio from the API. |
| `FFMPEG_PATH`, `FFPROBE_PATH`, `ESPEAK_PATH`, `ATLAS_GEO_DATA_DIR`, `ATLAS_FONTS_DIR`, `ATLAS_ROOT` | Optional path overrides. |

## Sample video

```bash
pnpm sample:render -- --prompt "नेपाल से भारत में बहने वाली कोसी, गंडक और करनाली नदियों को दिखाइए" --lang hi --duration 60 --quality standard --publish
```

This renders through the engine alone, with no API or database. It validates each file, and with `--publish` it copies only the files that passed validation to `apps/web/public/samples`, where the landing page shows them.

## Tests

```bash
pnpm test:unit          # schema, validation, state machine, formats, camera, FFmpeg args, subtitles, cache keys, gazetteer, planners, storage
pnpm test:integration   # REST API against a real MongoDB (auth, ownership, projects, storyboard, renders); queue is a labelled recording double
pnpm test:e2e           # prompt → storyboard → edit → real render via BullMQ + in-process worker → download → ffprobe validation; cancel + retry
pnpm test               # all of the above
pnpm typecheck && pnpm lint
```

- The integration and e2e suites skip themselves, with a message, when MongoDB, Redis or the map data are missing.
- They use throwaway databases and Redis DB 7.
- To use other servers, set `TEST_MONGODB_URI` and `TEST_REDIS_URL`.
- Test doubles are named as such in the code. The Claude SDK client double returns scripted responses and never calls the network.

## API

The REST API lives under `/api/v1`, and an OpenAPI summary is served at `/api/v1/docs/openapi.json`.

- **Auth:** `POST /auth/register`, `/auth/login`, `/auth/logout`; `GET /auth/me`.
- **Projects:**
  - `GET /projects` (search, sort, page), `POST /projects`.
  - `GET|PATCH|DELETE /projects/:id`.
  - `GET /projects/:id/assets`.
- **Storyboard:**
  - `POST /projects/:id/storyboard` (plan), `GET` (read), `PATCH` (save with `baseVersion`).
  - `POST /projects/:id/scenes/:sceneId/regenerate`.
- **Renders:**
  - `POST /projects/:id/renders` (with `storyboardVersion` and an optional `idempotencyKey`), `GET /projects/:id/renders`.
  - `GET /renders/:id`, `POST /renders/:id/cancel`, `POST /renders/:id/retry`.
- **Assets:** `GET /assets/:id/download` (`?inline=1` streams with range support).
- **Geo:** `GET /geo/search`, `/geo/countries/:iso3`, `/geo/layers/:layer`, `/geo/overlay-features`.
- **System:** `GET /health`, `/providers`.

Every non-GET request must send `X-Atlas-Client: web`.

## Deployment notes

- Run the API and the worker as separate processes. Scale workers horizontally; each one renders `RENDER_CONCURRENCY` jobs.
- With more than one host, use `STORAGE_DRIVER=s3`, since the local driver needs a shared filesystem. Downloads then redirect to short-lived presigned URLs.
- Put the API behind HTTPS. Set `NODE_ENV=production`, `COOKIE_SECURE=true` and a strong `JWT_SECRET`, and limit `CORS_ORIGINS`.
- Redis must not evict keys (`maxmemory-policy noeviction`), as BullMQ requires.
- `docker compose --profile app up --build` runs MongoDB, Redis, the API (serving the studio) and one worker. The image has not been verified, as noted in the limitations above.

## Future work

- A 3D terrain renderer behind the existing `SceneRenderer` interface, for example CesiumJS or Blender in a headless worker.
- Bundled thematic datasets with provenance: basins, flood extents, protected areas.
- Cloud TTS providers with natural voices. Per-scene audio preview in the editor.
- Ocean and sea features in the gazetteer. More Hindi aliases from a reviewed list.
- Drag-and-drop scene reordering and map-click coordinate picking in the editor.

## Licences and attribution

- Map data: [Natural Earth](https://www.naturalearthdata.com/) (public domain). Every frame carries "Map data: Natural Earth".
- Fonts: Noto Sans and Noto Sans Devanagari (SIL Open Font License).
- No third-party music or imagery is bundled. The ambience bed is generated with FFmpeg.
