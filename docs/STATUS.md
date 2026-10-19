# AtlasMotion AI: build status

Status as of 2026-10-19. This covers phases A to F of the master prompt, plus the satellite (G) and 3D terrain (H) requests. "Verified" means the code was run in the development container and the result was checked, not just written.

## Phase summary

| Phase | Scope | State |
| --- | --- | --- |
| A | Monorepo, shared Zod contracts (storyboard v1, API DTOs, job state machine, formats), config, models | Done, verified by tests |
| B | Natural Earth data layer, gazetteer, planners (Claude + offline), coordinate resolution, repair loop | Done. The Claude planner is tested with an SDK double only (no API key available) |
| C | Video engine: frame renderer, camera timeline, captions, espeak-ng TTS, FFmpeg assembly, ffprobe validation | Done, verified with real MP4 output |
| D | REST API, auth, ownership, storage (local + S3), BullMQ queue, worker (cache, retry, cancel, recovery, cleanup) | Done, verified end to end. The S3 driver is untested |
| E | Web studio: landing, auth, dashboard, new project, storyboard editor with globe preview, render studio, export | Done, verified in headless Chromium |
| F | Tests, lint, builds, check-env, docker-compose, Dockerfile, README | Done. The Docker image was not built (registry rate limit) |
| G | Satellite base map: NASA Blue Marble base, detail tiles (Sentinel-2 cloudless 2016 by default, or a custom keyed provider), server tile proxy for the preview, Satellite/Map toggle | Done. The tile path is verified against a local fixture tile server only, because this container cannot reach any public tile host |
| H | 3D terrain view (default for new projects): MapLibre GL in headless Chromium with terrain, tilted and turning camera, sky; Copernicus Sentinel-2 region baker; 3D editor preview; Chromium fallback to the flat view | Done, verified with real MP4 output (software WebGL) |

## Commands that were run and passed

- `pnpm typecheck` passes across all 8 workspaces.
- `pnpm lint` reports 0 problems.
- `pnpm test:unit` passes 70 tests.
- `pnpm test:integration` passes 20 tests. It runs the API against a real MongoDB, with a labelled recording double in place of the queue.
- `pnpm test:e2e` passes 3 tests. It uses real MongoDB, Redis and BullMQ plus an in-process worker. The flow is: prompt, storyboard, edit, render both formats, download, then ffprobe and a full decode. A second run checks cancel mid-render followed by a retry that reuses finished scenes.
- `vite build` and the `tsup` bundles for the API and worker build. The bundled API was started and served the studio on a single origin, and that was checked in a browser.
- `pnpm check:env` passes all required checks.
- Browser flow in headless Chromium:
  1. Register.
  2. Create a project from a Hindi prompt.
  3. The offline plan runs.
  4. Add a claim. Render is disabled while the claim is unsupported.
  5. Mark the claim illustrative and save with Ctrl+S.
  6. Render at draft quality, 24 fps.
  7. Watch per-scene progress and logs.
  8. Two validated MP4s and SRTs appear for download.
  9. The dashboard thumbnail comes from the real renderer.

## Sample render

```
pnpm sample:render -- --prompt "नेपाल से भारत में बहने वाली कोसी, गंडक और करनाली नदियों को दिखाइए, जो आगे चलकर गंगा में मिलती हैं।" --lang hi --duration 60 --quality standard --fps 30 --publish
```

Both formats rendered and passed validation (ffprobe metadata plus a full decode):

| File | Video | Audio | Length | Size |
| --- | --- | --- | --- | --- |
| `sample-hi-9x16.mp4` | H.264, 1080×1920, 30 fps, 1800 frames | AAC | 60.0s | 12.4 MB |
| `sample-hi-16x9.mp4` | H.264, 1920×1080, 30 fps, 1800 frames | AAC | 60.0s | 13.2 MB |

The plan has 8 scenes: opening globe, Nepal, India, then the Koshi, Gandak, Karnali and Ganga river reveals, then a closing pull-out. Captions are burned in Devanagari and narration is espeak-ng Hindi. Frames were spot-checked visually. Each frame takes about 30 to 70 ms to draw at 1080p in the container.

The files are in `samples/` next to this repository in the shared folder. A locally published copy goes to `apps/web/public/samples`, which is gitignored.

## Satellite base map (phase G)

Requested on 2026-10-19: "My output expectation is Google Maps satellite view".

- **What was built.**
  - The renderer inverse-projects every pixel and samples satellite imagery, then draws borders, rivers and overlays on top. The vector look is still available per project.
  - The base layer is NASA Blue Marble at 4096×2048 (public domain). Detail tiles come from Sentinel-2 cloudless 2016 by EOX (CC BY 4.0, no key) or from any XYZ provider set through `SATELLITE_*` variables.
  - Tiles are fetched before a scene is drawn and cached on disk. The editor preview gets the same imagery through `/api/v1/geo/imagery/tiles`, so a provider key never reaches the browser.
- **Why not Google.** Google Maps Platform terms do not allow its tiles to be cached or used outside a Google map, so they cannot be rendered into video files.
- **What was verified here.**
  - Unit tests check that the inverse projection matches d3 within 1e-6°, including roll.
  - A local fixture tile server proves that detail tiles are drawn, credited and cached on disk, and that a failing provider falls back to Blue Marble and is reported.
  - An integration test checks that preview tiles need a session and that the imagery endpoint exposes no keys or upstream URLs.
  - The e2e render suite passes with satellite frames. The editor preview showed satellite tiles in headless Chromium.
  - A 60-second sample rendered in both formats with Blue Marble only.
- **Not verified.** Real EOX or keyed-provider tiles. This container's network policy rejects every public tile host (EOX, NASA GIBS, Esri), so close-ups in the sample are soft (about 10 km per pixel). Allowing `tiles.maps.eox.at` in the environment's network settings enables them with no code change.
- **Speed.** About 0.1 s per 1080p frame when only Blue Marble is drawn (it is computed at half resolution, since it is upscaled anyway), and about 0.17 s per frame at full resolution with detail tiles, on one core.

## Bugs found and fixed during this phase

- **"Bay of Bengal" matched the wrong place.** It became a scene for the Philippine lake "Laguna de Bay", because Natural Earth gives that lake the English alias "Bay". Everyday-word aliases now only match when followed by "river" or "lake". A regression test covers this.
- **Hindi river names were not recognised.** Natural Earth has no `name_hi` for rivers. A small alias list now maps common Devanagari spellings to dataset names. Every alias was checked to exist in the dataset.
- **The MapLibre worker and map container broke in Vite builds.** Both were fixed.
- **Bundled builds could not find the data folder.** They resolved the repository root relative to source files. They now search upward for `pnpm-workspace.yaml`, and `ATLAS_ROOT` can override this.
- **Rate-limit key fallback was not IPv6-safe.** The express-rate-limit warning was fixed.

## 3D terrain view (phase H)

Requested on 2026-10-19: "i mean in a goggle map studio", read as the Google Earth Studio look (photoreal 3D terrain with cinematic camera moves).

- Google's Photorealistic 3D Tiles allow only promotional videos of 30 s or less about the app, and forbid caching. Google Earth Studio offers no licence for commercial use of its imagery. So the 3D view is built from open sources: Copernicus Sentinel-2 imagery, Terrain Tiles on AWS elevation, NASA Blue Marble and Natural Earth.
- Verified: the unit tests for the 3D camera, regions and terrain switches, the 3D render e2e (Chromium, validated MP4, lit centre pixel), the Chromium-missing fallback, and the terrain route's sign-in check. The whole suite (102 tests), lint and typecheck pass.
- Sample: `pnpm sample:render -- --prompt "Nepal and the Koshi river" --lang hi --duration 30 --quality draft --fps 24 --formats 16:9` with `SATELLITE_PROVIDER=none` produced a 30 s, 960×540, 24 fps video with narration that passed validation (720 frames, about 30 minutes to render).
- Speed in this container: about 4.5 s per 960×540 frame (SwiftShader, 4 cores), with about 20 s of tile warm-up on the first frame of a session.

## External setup needed for production

These are not done, and none of them were purchased or configured:

- An `ANTHROPIC_API_KEY` to enable AI-written storyboards. Without one, the offline planner is used.
- An S3-compatible bucket plus credentials, when the API and worker run on different hosts.
- HTTPS hosting, a strong `JWT_SECRET`, and `COOKIE_SECURE=true`.
- Optionally, a natural-sounding TTS provider, implementing the `TtsProvider` interface.
- Chromium on the worker (the Docker image installs it). A GPU host makes 3D frames much faster.
- Prepared imagery regions for the areas you cover, built with `scripts/imagery/bake_sentinel2.py` (needs outbound HTTPS to `sentinel-cogs.s3.us-west-2.amazonaws.com`), and HTTPS to `elevation-tiles-prod.s3.amazonaws.com` for terrain.
- Outbound HTTPS from the worker and API to the satellite tile host (`tiles.maps.eox.at` by default), or a keyed provider in `SATELLITE_*` whose terms allow video.

## Known limitations

These are also in the README:

- 3D frames are slow without a GPU.
- Sharp 3D close-ups exist only where a prepared region exists (the Koshi basin today) or a detail provider is reachable.
- Without detail tiles, satellite close-ups use Blue Marble and look soft.
- There is no basin, flood-extent, ocean-name or live data.
- espeak-ng narration sounds robotic.
- Hindi labels appear only where Natural Earth has `name_hi`.
- The offline planner writes template narration, which is labelled as such in the editor.
- The S3 driver, the live Claude API path and the Docker image have not been run.

## Suggested next tasks

1. Run the Claude planner against the live API with a real key, and tune the prompt on 10 to 20 sample prompts.
2. Add a reviewed dataset for one thematic layer the user cares about, for example flood-prone districts of Bihar, with its provenance recorded.
3. Wire up a natural TTS provider and add per-scene audio preview.
4. Build and smoke-test the Docker image once the registry is reachable.
5. Run an S3 driver test against MinIO.
