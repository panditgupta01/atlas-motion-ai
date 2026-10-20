# Satellite imagery: Google products and licensing

Checked on 2026-10-20 against Google's own pages (listed at the end). This is an engineering reading of published terms, not legal advice and not a licence. No Google approval or agreement exists for this project.

## The question

AtlasMotion makes videos that users ask for, then download, publish and may monetise. The question for each imagery source is whether it may be drawn into those exported videos, separately from whether it may be shown live in the app.

## Google products, one at a time

| Product | Live preview in the app | Exported user videos | Why |
| --- | --- | --- | --- |
| A. Maps JavaScript API, satellite map type | **Permitted** with a Google Maps Platform key, Google's logo and attribution left visible | **Not permitted** | The Maps Platform terms forbid exporting, extracting or scraping Google Maps Content, caching it, and "creat[ing] content based on Google Maps Content". Recording the live map into an MP4 would do all three. |
| B1. Map Tiles API, 2D satellite tiles | Permitted inside your own map renderer, with attribution | **Not permitted** for this product | Video is allowed only as a *promotional video*: 30 s or less, about your own app's capabilities, marked "for promotional purposes only", not resold. Pre-fetching, storing and caching are forbidden, and so are "offline uses". User-requested documentaries meet none of those conditions. |
| B2. Map Tiles API, Photorealistic 3D Tiles | Permitted inside a 3D Tiles renderer (CesiumJS and others), with all tile attributions shown | **Not permitted** for this product | Same promotional-video rule and caching ban as B1. |
| C. Google Earth Studio | Not embeddable: "Google Earth may not be embedded online or in apps" | **Not permitted** as a product backend | "We currently do not offer a license to use Google Earth imagery for commercial applications." It is a manual, Chrome-only tool that needs an approved Google account, with no API. Google's geo guidelines do let a *person* use Earth Studio output in news, documentaries and educational videos (even monetised) with on-screen attribution. That is a human using the tool, not a service generating videos for its users. Promotional films, ads and commercials are excluded, and the guidelines apply the same commercial limits to Google Maps satellite view imagery. |

### What would need Google's authorisation

Drawing any Google imagery into exported user videos would need a written agreement with Google that covers it. The published terms do not cover it. Google's geo guidelines say: "If your use isn't allowed, we're not able to grant exceptions, so please don't submit a request." The realistic route is a direct commercial conversation with Google Maps Platform sales. This project has not started one, and nothing here should be read as approval.

## What the app does

- **Exported videos never use Google imagery.**
  - `SATELLITE_PROVIDER=google…` is refused, and so is a custom tile URL on a Google host (`google.*`, `googleapis.com`, `gstatic.com`, `ggpht.com`).
  - The reason appears in `pnpm check:env` and in the render log, and the render falls back to the open sources.
  - Code: `GOOGLE_EXPORT_BLOCKED` in `packages/video-engine/src/imagery.ts`.
- **The editor can show live Google Maps satellite imagery** (product A).
  - It is enabled with `GOOGLE_MAPS_BROWSER_KEY`, and the key is handed only to signed-in users (`GET /api/v1/geo/google-maps`).
  - The preview uses the same camera timeline as the video, and draws the scene's country highlights, rivers, routes, arrows and labels on the Google map with the Maps JavaScript API.
  - Google's logo and attribution are never covered: the app keeps a clear strip at the bottom.
  - Only one map is mounted at a time, because the terms forbid Google content "with or near a non-Google map".
  - A banner states that the preview is Google and the video is not, and names the sources the video uses.
- **Exported videos use separately licensed sources**, credited on every frame and listed in the render log:

  | Source | Licence |
  | --- | --- |
  | Copernicus Sentinel-2 L2A imagery (prepared regions) | Free and open, commercial use allowed with attribution |
  | NASA Blue Marble | Public domain |
  | Terrain Tiles on AWS (SRTM, GMTED2010, ETOPO1 and others) | Free to use with attribution |
  | Natural Earth | Public domain |
  | Optionally, a keyed provider whose plan covers video | Set by that provider |

## Provider-neutral architecture

| Concern | Where | Swapping it |
| --- | --- | --- |
| Geographic camera planning | `packages/shared/src/camera.ts` (`cameraAt`, `camera3dAt`), shared by the editor previews and the renderer | Independent of imagery |
| Imagery retrieval | `packages/video-engine/src/imagery.ts`: `TileFetcher` (regions first, then an XYZ provider), `ImageryTileService` (preview tile proxy) | Configure `SATELLITE_*`, or add a region with `scripts/imagery/bake_sentinel2.py` |
| Imagery rendering | `MapSceneRenderer` behind the `SceneRenderer` interface (`packages/video-engine/src/scene-renderer.ts`): 3D (`globe3d.ts`, MapLibre in headless Chromium), flat satellite and vector (`map-frame.ts`) | A new renderer implements `SceneRenderer`; the worker takes any implementation |
| Geographic overlays | `map-frame.ts` (`composite3d`, `drawOverlays`), from storyboard overlays | Shared by all render paths |
| Scene animation | `MapSceneRenderer.renderScene` drives frames from the camera timeline | |
| Audio and subtitles | `tts.ts` (provider registry), `subtitles.ts` | Add a `TtsProvider` |
| Final encoding | `ffmpeg.ts`, `compose.ts`, then ffprobe validation | |

The prompt planner, storyboard editor, job queue and video assembler do not depend on the imagery source.

## Acceptance tests, reported separately

1. **Satellite-map visualisation in the web app.**
   - The open-data 3D satellite preview with terrain was verified in headless Chromium. It showed the Koshi scene, the camera moving along the shared timeline, and the river and border overlays (`samples/acceptance/editor-3d-open-data.png`).
   - Google Maps preview: the integration loads Google's real Maps JavaScript API. With a placeholder key Google answered `InvalidKeyMapError`, which shows the request reached Google, and the page's CSP allowed it.
   - It has **not** been seen working with real Google imagery: that needs a real key, and this build container cannot reach Google's image hosts.
2. **Export of a downloadable video.**
   - Verified with the separately licensed sources, not Google.
   - `samples/3d/koshi-flyover-3d-hi-16x9.mp4` is 30 s at 960×540 and 24 fps with Hindi narration, and passed ffprobe and full-decode validation.
   - Google-backed export is blocked by licensing and is not implemented. It is not production-ready.

## Sources

- Map Tiles API policies: https://developers.google.com/maps/documentation/tile/policies
- Map Tiles API, 2D satellite: https://developers.google.com/maps/documentation/tile/satellite
- Photorealistic 3D Tiles: https://developers.google.com/maps/documentation/tile/3d-tiles-overview
- Google Earth Studio FAQ: https://www.google.com/earth/studio/faq/
- Google geo guidelines (permissions for Maps, Earth and Earth Studio content): https://about.google/brand-resource-center/products-and-services/geo-guidelines/
- Google Maps Platform restrictions as passed through to end users (no export or scraping, no caching, no content created from Google Maps Content, not with or near a non-Google map): https://cesium.com/legal/terms-for-google/
