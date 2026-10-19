# AtlasMotion AI: build status

Status as of 2026-10-19. This covers phases A to F of the master prompt. "Verified" means the code was run in the development container and the result was checked, not just written.

## Phase summary

| Phase | Scope | State |
| --- | --- | --- |
| A | Monorepo, shared Zod contracts (storyboard v1, API DTOs, job state machine, formats), config, models | Done, verified by tests |
| B | Natural Earth data layer, gazetteer, planners (Claude + offline), coordinate resolution, repair loop | Done. The Claude planner is tested with an SDK double only (no API key available) |
| C | Video engine: frame renderer, camera timeline, captions, espeak-ng TTS, FFmpeg assembly, ffprobe validation | Done, verified with real MP4 output |
| D | REST API, auth, ownership, storage (local + S3), BullMQ queue, worker (cache, retry, cancel, recovery, cleanup) | Done, verified end to end. The S3 driver is untested |
| E | Web studio: landing, auth, dashboard, new project, storyboard editor with globe preview, render studio, export | Done, verified in headless Chromium |
| F | Tests, lint, builds, check-env, docker-compose, Dockerfile, README | Done. The Docker image was not built (registry rate limit) |

## Commands that were run and passed

- `pnpm typecheck` passes across all 8 workspaces.
- `pnpm lint` reports 0 problems.
- `pnpm test:unit` passes 61 tests.
- `pnpm test:integration` passes 19 tests. It runs the API against a real MongoDB, with a labelled recording double in place of the queue.
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

## Bugs found and fixed during this phase

- **"Bay of Bengal" matched the wrong place.** It became a scene for the Philippine lake "Laguna de Bay", because Natural Earth gives that lake the English alias "Bay". Everyday-word aliases now only match when followed by "river" or "lake". A regression test covers this.
- **Hindi river names were not recognised.** Natural Earth has no `name_hi` for rivers. A small alias list now maps common Devanagari spellings to dataset names. Every alias was checked to exist in the dataset.
- **The MapLibre worker and map container broke in Vite builds.** Both were fixed.
- **Bundled builds could not find the data folder.** They resolved the repository root relative to source files. They now search upward for `pnpm-workspace.yaml`, and `ATLAS_ROOT` can override this.
- **Rate-limit key fallback was not IPv6-safe.** The express-rate-limit warning was fixed.

## External setup needed for production

These are not done, and none of them were purchased or configured:

- An `ANTHROPIC_API_KEY` to enable AI-written storyboards. Without one, the offline planner is used.
- An S3-compatible bucket plus credentials, when the API and worker run on different hosts.
- HTTPS hosting, a strong `JWT_SECRET`, and `COOKIE_SECURE=true`.
- Optionally, a natural-sounding TTS provider, implementing the `TtsProvider` interface.

## Known limitations

These are also in the README:

- The renderer is 2D only, with no 3D terrain.
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
