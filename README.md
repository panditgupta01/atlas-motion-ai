# AtlasMotion AI

Turn a natural-language prompt into an animated map documentary video. AtlasMotion plans a storyboard, lets you review and edit every scene, then renders real MP4 files in 9:16 (1080×1920) and 16:9 (1920×1080) with captions and narration.

```
prompt ─▶ planner (Claude or offline gazetteer) ─▶ storyboard (versioned schema, validated)
       ─▶ editor (scenes, overlays, claims, sources) ─▶ render queue (BullMQ)
       ─▶ worker: map frames (3D terrain in headless MapLibre, or flat satellite/vector with Skia + d3-geo; Natural Earth overlays) ─▶ FFmpeg ─▶ ffprobe validation ─▶ download
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
  - A MapLibre globe preview that uses the same camera timeline and imagery as the renderer. Tiles reach the browser through the API, so provider keys never leave the server.
  - Saves use optimistic concurrency. You can regenerate a single scene.
- **3D terrain flyovers (default).** See [3D terrain view](#3d-terrain-view) below.
  - Satellite imagery draped over real elevation, with a tilted camera that slowly turns, sky and atmosphere: the look of Google Earth Studio, built from sources whose licences allow video.
- **Satellite base map.** See [Satellite imagery](#satellite-imagery) below.
  - Frames show satellite imagery under the borders, rivers and overlays. Projects can switch between "3D", the flat satellite globe ("Satellite") and the vector map ("Map") in the editor.
  - The globe and wide shots use NASA Blue Marble, bundled and offline. Close-ups use detail tiles from a provider whose licence allows video, fetched by the server and cached on disk.
  - Every frame credits the imagery it actually drew.
- **Rendering.**
  - A background worker draws every frame, encodes per-scene H.264 clips, and caches them by content hash.
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

- 3D frames are slow on a CPU-only host: about 4.5 s per 960×540 frame in software WebGL (SwiftShader), so a 30-second draft takes about an hour. A GPU host, or the flat "Satellite" view, is much faster.
- Sharp 3D close-ups need prepared imagery for the area (only the Koshi basin in eastern Nepal is set up) or a reachable detail provider. Elsewhere the 3D view uses Blue Marble and looks soft below country scale.
- Without detail tiles (no network to the provider, or `SATELLITE_PROVIDER=none`), close-ups use NASA Blue Marble at about 10 km per pixel and look soft. The render log says when this happened, and such clips are not reused once tiles are reachable.
- Satellite frames take longer to draw than vector frames: about 0.1 s per 1080p frame from Blue Marble, and up to about 0.2 s per frame with detail tiles, on one core.
- No flood extents, river basins, population data or live data. No such dataset is bundled. River lines are Natural Earth centerlines.
- No ocean or sea names. "Bay of Bengal", for example, is not in the gazetteer and will not become a scene.
- Hindi map labels appear only where Natural Earth provides `name_hi`. Otherwise the English name is used. Hindi river names are matched through a small alias list (`packages/geo/src/gazetteer.ts`).
- The narration voice is espeak-ng: real and offline, but robotic. The TTS layer is a provider interface, so a cloud voice can be added. None is wired up because none was configured.
- The S3 storage driver is implemented but has not been tested against a real bucket.
- The Claude planner is covered by tests against an SDK test double only. It has not been run against the live API in this repository.
- The Docker image has not been built and verified. The registry rate-limited the build in the development environment. `docker-compose.yml` passes `docker compose config`.

## Satellite imagery

Renders and the editor preview draw satellite imagery under the map overlays.

| Layer | Used for | Source | Licence | Key |
| --- | --- | --- | --- | --- |
| Base | Globe, wide shots, and any area tiles cannot cover | NASA Blue Marble, 4096×2048, downloaded by `scripts/fetch-assets.sh` | Public domain | None |
| Detail (default) | Close-ups, tile zoom 5 to 13 | [Sentinel-2 cloudless 2016](https://s2maps.eu) by EOX IT Services GmbH | CC BY 4.0 | None |
| Detail (custom) | Close-ups, up to `SATELLITE_MAX_ZOOM` | Any XYZ tile service you have rights to use | Your provider's terms | Usually |

- **How tiles are fetched.** The renderer works out which tiles every frame of a scene needs, fetches them before drawing, and caches them under `storage/cache/tiles`. It never asks for tiles below zoom 5, because Blue Marble is just as sharp there.
- **When tiles cannot be fetched.** Each pixel falls back to the next coarser layer, down to Blue Marble. After 8 failures in a row the provider is skipped for 5 minutes, so a render never waits on thousands of timeouts.
- **Credits.** The credit line on each scene lists only the layers that scene drew, plus "Map data: Natural Earth".
- **Why the 2016 mosaic.** The EOX mosaics for 2018 and later are CC BY-NC-SA, which does not allow commercial use. Check the current terms at [s2maps.eu](https://s2maps.eu) before rendering at scale.
- **Why not Google Maps.** Google Maps Platform terms do not allow its satellite tiles to be cached or used outside a Google map, which rules out rendering them into video files.
- **A sharper keyed provider.** For close-ups sharper than about 10 m per pixel, set `SATELLITE_PROVIDER=custom` with an XYZ URL from a provider whose licence covers video, for example MapTiler, Mapbox or Esri. Confirm the video and attribution terms on your plan first. `{key}` in the URL is replaced with `SATELLITE_TILE_KEY` on the server only.
- **Network.** The worker and the API need outbound HTTPS to the tile host (`tiles.maps.eox.at` by default). `pnpm check:env` reports the provider in use and any configuration problems.

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
- About 42 MB of map data, fonts and base imagery, downloaded by a script.

## Setup

```bash
pnpm install
bash scripts/fetch-assets.sh          # Natural Earth + NASA Blue Marble (public domain), Noto Sans / Noto Sans Devanagari (OFL)
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

## 3D terrain view

New projects use the 3D view. The worker runs MapLibre GL in headless Chromium and reads each frame back; labels, the title card, the legend and credits are then drawn on top exactly as in the flat views.

| Layer | Source | Licence |
| --- | --- | --- |
| Elevation | [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/) (Terrarium PNG; SRTM, GMTED2010, ETOPO1 and others), fetched by the server and cached | Free to use with attribution |
| Prepared imagery regions | Copernicus Sentinel-2 L2A true colour, built with `scripts/imagery/bake_sentinel2.py` from the AWS `sentinel-cogs` bucket | Free and open, commercial use allowed, credit "contains modified Copernicus Sentinel data" |
| Imagery elsewhere | The same base and detail layers as the flat satellite view | As above |

- **Camera.** Pitch rises from straight down at globe scale to about 65° at close range, and the heading drifts a few degrees (an orbit turns 50°). A scene can set `camera.pitch` and `camera.bearing` to override both.
- **Prepared regions.** `python3 scripts/imagery/bake_sentinel2.py --name koshi-sentinel2 --bbox 85.3 26.3 88.4 28.6 --max-zoom 12` picks the clearest post-monsoon scenes, mosaics them, fades the edge into the base imagery over 30 km and writes tiles to `assets/imagery/regions/` (not committed; about 150 MB for this box). Regions are used before any network provider, in the flat views too.
- **Without Chromium** the scene falls back to the flat satellite view and the render log says so. The Docker image installs Debian's `chromium` and sets `CHROMIUM_PATH`.
- **Why not Google's 3D tiles or Earth Studio.** Google's Photorealistic 3D Tiles allow only short promotional videos about your app and forbid caching; Google Earth Studio has no licence for commercial use of its imagery. Neither fits a product that exports videos.

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
| `SATELLITE_PROVIDER` | `eox-s2cloudless` (default, no key), `custom`, or `none` (Blue Marble only). See [Satellite imagery](#satellite-imagery). |
| `SATELLITE_TILE_URL`, `SATELLITE_TILE_KEY`, `SATELLITE_ATTRIBUTION`, `SATELLITE_MAX_ZOOM` | A custom XYZ provider. The key stays on the server. |
| `SATELLITE_REGIONS_DIR` | Folder of prepared imagery regions (default `assets/imagery/regions`, `none` to ignore). |
| `TERRAIN_TILE_URL`, `TERRAIN_ATTRIBUTION`, `TERRAIN_MAX_ZOOM` | Elevation tiles for the 3D view (Terrarium encoding). `none` draws it without relief. |
| `CHROMIUM_PATH` | Chromium for the 3D view. Defaults to Playwright's Chromium when installed. |
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

- GPU rendering for the 3D view, and more prepared imagery regions.
- Bundled thematic datasets with provenance: basins, flood extents, protected areas.
- Cloud TTS providers with natural voices. Per-scene audio preview in the editor.
- Ocean and sea features in the gazetteer. More Hindi aliases from a reviewed list.
- Drag-and-drop scene reordering and map-click coordinate picking in the editor.

## Licences and attribution

- Map data: [Natural Earth](https://www.naturalearthdata.com/) (public domain). Every frame carries "Map data: Natural Earth".
- Base imagery: NASA Blue Marble (public domain), taken from the [three-globe](https://www.npmjs.com/package/three-globe) npm package (MIT), pinned by checksum in `scripts/fetch-assets.sh`.
- Detail imagery: Sentinel-2 cloudless 2016 by EOX IT Services GmbH, containing modified Copernicus Sentinel data 2016 (CC BY 4.0), or your configured provider. Tiles are fetched at render time and are not bundled.
- Elevation: Terrain Tiles on AWS by Mapzen and contributors (SRTM, GMTED2010, ETOPO1 and others). Credited on every 3D frame.
- Prepared regions: contains modified Copernicus Sentinel data (years in each `region.json`). Credited on every frame that uses them.
- Fonts: Noto Sans and Noto Sans Devanagari (SIL Open Font License).
- No third-party music is bundled. The ambience bed is generated with FFmpeg.
