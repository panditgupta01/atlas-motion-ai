import fs from "node:fs";
import path from "node:path";
import { getCountryByIso3, getRiverFeatures, checkGeoData } from "@atlas/geo";
import {
  FORMAT_LAYOUTS,
  QUALITY_SETTINGS,
  frameSizeFor,
  sceneSchema,
  type AspectFormat,
  type Quality,
  type Scene,
} from "@atlas/shared";
import { camera3dAt, cameraAt, scaleForZoom, visibleRadiusDegrees, type CameraState } from "./camera.js";
import { buildSceneEncodeArgs, CancelledError, spawnFrameEncoder } from "./ffmpeg.js";
import { MapFrameRenderer, type SceneImagery } from "./map-frame.js";
import { Globe3DSession, Globe3DUnavailableError } from "./globe3d.js";
import { loadImage } from "@napi-rs/canvas";
import { clipFeatures, getCountryFeature, loadDataset, loadSimplified, simplifyGeometry } from "@atlas/geo";
import { BASE_ATTRIBUTION, buildMosaic, imageryCacheTag, terrainConfigFromEnv, type TerrainConfig, describeImagery, imageryConfigFromEnv, loadBaseImagery, MOSAIC_MAX_PX, TileFetcher, tileZoomForScale, type ImageryConfig, type Mosaic } from "./imagery.js";
import type { Basemap, FrameSize } from "@atlas/shared";

export type { Basemap };

export interface RenderSceneInput {
  scene: Scene;
  /** Previous scene, used as the camera's starting point. */
  previous?: Scene;
  format: AspectFormat;
  quality: Quality;
  fps: number;
  /** Satellite imagery (default) or the flat vector look. */
  basemap?: Basemap;
  /** Absolute output path for the MP4 clip. */
  output: string;
  signal?: AbortSignal;
  onProgress?: (framesDone: number, framesTotal: number) => void;
}

export interface RenderSceneResult {
  output: string;
  frames: number;
  width: number;
  height: number;
  durationSeconds: number;
  renderer: string;
  elapsedMs: number;
  imagery: ImageryReport;
}

export interface ImageryReport {
  basemap: Basemap;
  /** Credit lines drawn on the frames. */
  attribution: string[];
  /** Detail tile zoom levels that were drawn. */
  detailZooms: number[];
  /** True when detail tiles were wanted but some or all could not be fetched, so coarser imagery was used. */
  degraded: boolean;
  note?: string;
}

export interface RendererCapabilities {
  id: string;
  label: string;
  /** True only for renderers that produce actual 3D terrain. */
  terrain3d: boolean;
  overlays: string[];
  cameraMoves: string[];
  maxFps: number;
  dataSources: string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface SceneRenderer {
  renderScene(input: RenderSceneInput): Promise<RenderSceneResult>;
  getCapabilities(): RendererCapabilities;
  validateInput(input: RenderSceneInput): Promise<ValidationResult>;
  /** Identifies the imagery source, for clip cache keys. */
  imageryTag?(): string;
}

/** Bump when frame output changes, so cached clips are re-rendered. */
export const MAP_RENDERER_VERSION = "map2d-4";

/** Vertical exaggeration of the 3D terrain; a little relief helps it read at documentary altitudes. */
export const TERRAIN_EXAGGERATION = 1.3;

/** Below this tile zoom the 4096 px base image is as sharp as tiles, so no tiles are fetched. */
const MIN_DETAIL_ZOOM = 5;

function cameraBBox(cam: CameraState, size: FrameSize): [number, number, number, number] | null {
  const r = visibleRadiusDegrees(scaleForZoom(cam.zoom, size), size) * 1.1;
  if (r >= 45) return null;
  const maxLat = Math.min(85, Math.abs(cam.latitude) + r);
  const lonHalf = Math.min(180, r / Math.cos((maxLat * Math.PI) / 180));
  return [cam.longitude - lonHalf, Math.max(-85, cam.latitude - r), cam.longitude + lonHalf, Math.min(85, cam.latitude + r)];
}

/**
 * 2D animated map renderer: draws every frame with Skia (via @napi-rs/canvas)
 * from Natural Earth vectors in an orthographic projection, and pipes raw
 * frames into FFmpeg. Deterministic: the same scene input yields the same frames.
 */
export class MapSceneRenderer implements SceneRenderer {
  readonly imageryConfig: ImageryConfig;
  readonly tiles: TileFetcher;

  readonly terrainConfig: TerrainConfig;

  constructor(options: { imagery?: ImageryConfig; terrain?: TerrainConfig } = {}) {
    this.imageryConfig = options.imagery ?? imageryConfigFromEnv();
    this.terrainConfig = options.terrain ?? terrainConfigFromEnv();
    this.tiles = new TileFetcher(this.imageryConfig);
  }

  imageryTag(): string {
    const regions = this.tiles.regions.regions.map((r) => `${r.name}@${r.maxZoom}`).join(",");
    return `${imageryCacheTag(this.imageryConfig)}|${regions}|${this.terrainConfig.tileUrl ?? "flat"}`;
  }

  getCapabilities(): RendererCapabilities {
    const imagery = describeImagery(this.imageryConfig);
    return {
      id: "map2d",
      label: "2D satellite map (orthographic globe, Natural Earth overlays)",
      terrain3d: true,
      overlays: ["title_card", "location_label", "marker", "highlight_country", "river", "route", "arrow", "legend"],
      cameraMoves: ["static", "zoom_to", "zoom_out", "pan_to", "orbit", "follow_route"],
      maxFps: 30,
      dataSources: ["Natural Earth 1:10m/1:50m (public domain)", "NASA Blue Marble (public domain)", ...(this.tiles.enabled ? [`${imagery.label} (${imagery.license})`] : [])],
    };
  }

  async validateInput(input: RenderSceneInput): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const parsed = sceneSchema.safeParse(input.scene);
    if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    if (![24, 25, 30].includes(input.fps)) errors.push(`Unsupported frame rate ${input.fps}.`);
    if (!path.isAbsolute(input.output)) errors.push("Output path must be absolute.");
    const geo = checkGeoData();
    if (!geo.ok) errors.push(`Missing map data files: ${geo.missing.join(", ")}`);
    for (const o of input.scene.overlays) {
      if (o.type === "highlight_country" && !getCountryByIso3(o.iso3)) errors.push(`Country ${o.iso3} is not in the dataset.`);
      if (o.type === "river" && getRiverFeatures(o.datasetName).length === 0) errors.push(`River "${o.datasetName}" is not in the dataset.`);
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  async renderScene(input: RenderSceneInput): Promise<RenderSceneResult> {
    const started = Date.now();
    const check = await this.validateInput(input);
    if (!check.ok) throw new SceneInputError(check.errors);

    const size = frameSizeFor(input.format, input.quality);
    const layout = FORMAT_LAYOUTS[input.format];
    const q = QUALITY_SETTINGS[input.quality];
    const frames = Math.round(input.scene.durationSeconds * input.fps);
    const tmp = `${input.output}.partial.mp4`;
    fs.mkdirSync(path.dirname(input.output), { recursive: true });

    const renderer = new MapFrameRenderer(size);
    const encoder = spawnFrameEncoder(buildSceneEncodeArgs({ size, fps: input.fps, crf: q.crf, preset: q.preset, output: tmp }), input.signal);
    const edge = Math.min(0.3, input.scene.durationSeconds / 6);
    const cameras = Array.from({ length: frames }, (_, i) => cameraAt(input.scene, input.previous, frames > 1 ? i / (frames - 1) : 1, layout));
    renderer.beginScene(cameras);
    let basemap = input.basemap ?? "satellite";
    let fallback3d: string | null = null;
    if (basemap === "satellite3d") {
      // Without a usable Chromium the 3D view falls back to the flat satellite globe, and says so.
      try {
        await this.session3d(size);
      } catch (err) {
        if (!(err instanceof Globe3DUnavailableError)) throw err;
        basemap = "satellite";
        fallback3d = `${err.message} The flat satellite view was used instead.`;
      }
    }
    let report3d: ImageryReport | null = null;
    const prepared = basemap === "satellite" ? await this.prepareImagery(cameras, size, input.signal) : null;
    renderer.setImagery(prepared?.imagery ?? null);
    try {
      if (basemap === "satellite3d") {
        report3d = await this.renderFrames3d(input, size, layout, frames, edge, cameras, renderer, encoder);
      } else {
        for (let i = 0; i < frames; i++) {
          if (input.signal?.aborted) throw new CancelledError();
          const seconds = i / input.fps;
          const t = frames > 1 ? i / (frames - 1) : 1;
          const fromEnd = input.scene.durationSeconds - seconds;
          const fade = Math.min(1, 0.35 + 0.65 * Math.min(seconds / edge, fromEnd / edge, 1));
          const canvas = renderer.render({
            scene: input.scene,
            camera: cameras[i]!,
            t,
            seconds,
            layout,
            fade,
          });
          await encoder.write(canvas.data());
          if (i % 10 === 0 || i === frames - 1) input.onProgress?.(i + 1, frames);
        }
      }
      await encoder.finish();
    } catch (err) {
      encoder.kill();
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    // Atomic publish: a clip at `output` is always complete.
    fs.renameSync(tmp, input.output);
    return { output: input.output, frames, width: size.width, height: size.height, durationSeconds: frames / input.fps, renderer: MAP_RENDERER_VERSION, elapsedMs: Date.now() - started, imagery: withFallbackNote(report3d ?? prepared?.report ?? { basemap, attribution: [], detailZooms: [], degraded: false }, fallback3d) };
  }

  private sessions3d = new Map<string, { session: Promise<Globe3DSession>; timer: NodeJS.Timeout | null }>();

  /** A browser session for this frame size, kept open between scenes and closed after a minute idle. */
  private async session3d(size: FrameSize): Promise<Globe3DSession> {
    const key = `${size.width}x${size.height}`;
    let entry = this.sessions3d.get(key);
    if (!entry) {
      const s = new Globe3DSession(size, this.imageryConfig, this.terrainConfig);
      entry = { session: s.open().then(() => s), timer: null };
      this.sessions3d.set(key, entry);
      entry.session.catch(() => this.sessions3d.delete(key));
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    return entry.session;
  }

  private releaseSession3d(size: FrameSize): void {
    const key = `${size.width}x${size.height}`;
    const entry = this.sessions3d.get(key);
    if (!entry) return;
    entry.timer = setTimeout(() => {
      this.sessions3d.delete(key);
      void entry.session.then((s) => s.close());
    }, 60_000);
    entry.timer.unref();
  }

  /** Close any open 3D browser sessions (call before the process exits). */
  async close(): Promise<void> {
    const all = [...this.sessions3d.values()];
    this.sessions3d.clear();
    for (const e of all) {
      if (e.timer) clearTimeout(e.timer);
      await e.session.then((s) => s.close()).catch(() => undefined);
    }
  }

  private async renderFrames3d(
    input: RenderSceneInput,
    size: FrameSize,
    layout: (typeof FORMAT_LAYOUTS)[AspectFormat],
    frames: number,
    edge: number,
    cameras: CameraState[],
    renderer: MapFrameRenderer,
    encoder: ReturnType<typeof spawnFrameEncoder>,
  ): Promise<ImageryReport> {
    const session = await this.session3d(size);
    try {
      const minSide = Math.min(size.width, size.height);
      // Area the scene can show, for clipping borders and rivers; null when a frame shows the whole globe.
      let window: [number, number, number, number] | null = [Infinity, Infinity, -Infinity, -Infinity];
      for (const cam of cameras) {
        const b = cameraBBox({ ...cam, zoom: Math.max(0, cam.zoom - 1.2) }, size);
        if (!b) {
          window = null;
          break;
        }
        window = [Math.min(window[0], b[0]), Math.min(window[1], b[1]), Math.max(window[2], b[2]), Math.max(window[3], b[3])];
      }
      const pick = (id: "countries" | "rivers") => {
        const list = window ? clipFeatures(loadSimplified(`${id}10m`, 0.003), window) : loadDataset(`${id}50m`);
        return { type: "FeatureCollection" as const, features: list.map((f) => f.feature) };
      };
      const highlights = input.scene.overlays.flatMap((o) => {
        if (o.type !== "highlight_country") return [];
        const f = getCountryFeature(o.iso3);
        return f ? [{ type: "Feature" as const, properties: { color: o.color ?? "#e0b04c" }, geometry: simplifyGeometry(f.feature.geometry, 0.005) }] : [];
      });
      session.imageryFetcher.usedSources.clear();
      const terrain = session.terrainAvailable;
      await session.setScene({
        borders: pick("countries"),
        rivers: pick("rivers"),
        highlights: { type: "FeatureCollection", features: highlights },
        detailMaxZoom: this.imageryConfig.maxZoom,
        terrain,
        exaggeration: TERRAIN_EXAGGERATION,
      });
      const regions = session.imageryFetcher.regions.regions.filter((r) => !window || (r.bbox[0] <= window[2] && r.bbox[2] >= window[0] && r.bbox[1] <= window[3] && r.bbox[3] >= window[1]));
      const detailCredits = [...regions.map((r) => r.attribution), ...(session.imageryFetcher.providerEnabled ? [describeImagery(this.imageryConfig).attribution] : [])];
      const credits = [...new Set([...detailCredits, BASE_ATTRIBUTION, ...(terrain ? [this.terrainConfig.attribution] : []), "Map data: Natural Earth"])];
      let incomplete = 0;
      for (let i = 0; i < frames; i++) {
        if (input.signal?.aborted) throw new CancelledError();
        const seconds = i / input.fps;
        const t = frames > 1 ? i / (frames - 1) : 1;
        const fromEnd = input.scene.durationSeconds - seconds;
        const fade = Math.min(1, 0.35 + 0.65 * Math.min(seconds / edge, fromEnd / edge, 1));
        const anchors = renderer.overlayAnchors3d(input.scene, t);
        const frame = await session.frame({
          camera: camera3dAt(input.scene, input.previous, t, layout, minSide),
          lines: renderer.overlayLines3d(input.scene, t),
          anchors: anchors.map((a) => a.lonLat),
        });
        if (!frame.complete) incomplete++;
        const image = await loadImage(frame.jpeg);
        const positions = new Map(anchors.map((a, k) => [a.key, frame.anchors[k] ?? null]));
        const canvas = renderer.composite3d({ scene: input.scene, camera: cameras[i]!, t, seconds, layout, fade }, image, positions, credits);
        await encoder.write(canvas.data());
        if (i % 5 === 0 || i === frames - 1) input.onProgress?.(i + 1, frames);
      }
      const providerFailing = session.imageryFetcher.providerEnabled && !!session.imageryFetcher.lastError;
      const notes = [
        incomplete > 0 ? `${incomplete} frames were drawn before all tiles arrived.` : "",
        providerFailing ? `Some detail tiles could not be fetched (${session.imageryFetcher.lastError}); NASA Blue Marble was used there.` : "",
        terrain && session.terrainLastError ? `Some terrain tiles could not be fetched (${session.terrainLastError}); those areas are flat.` : "",
        !terrain ? "Terrain is off (TERRAIN_TILE_URL=none); the 3D view is flat." : "",
        !session.imageryFetcher.enabled ? "No detail imagery is configured; close-ups use NASA Blue Marble (about 10 km per pixel)." : "",
      ].filter(Boolean);
      return { basemap: "satellite3d", attribution: credits, detailZooms: [], degraded: incomplete > 0 || providerFailing || (terrain && !!session.terrainLastError), note: notes.join(" ") || undefined };
    } finally {
      this.releaseSession3d(size);
    }
  }

  /**
   * Load the base image and fetch the detail tiles every frame of the scene
   * needs, grouped by tile zoom, before any frame is drawn.
   */
  async prepareImagery(cameras: CameraState[], size: FrameSize, signal?: AbortSignal): Promise<{ imagery: SceneImagery; report: ImageryReport }> {
    const cfg = this.imageryConfig;
    const base = await loadBaseImagery(cfg);
    const boxes = new Map<number, [number, number, number, number]>();
    for (const cam of cameras) {
      const z = tileZoomForScale(scaleForZoom(cam.zoom, size), cam.latitude, cfg.maxZoom);
      if (z < MIN_DETAIL_ZOOM && base) continue;
      const b = cameraBBox(cam, size);
      if (!b) continue;
      const cur = boxes.get(z);
      boxes.set(z, cur ? [Math.min(cur[0], b[0]), Math.min(cur[1], b[1]), Math.max(cur[2], b[2]), Math.max(cur[3], b[3])] : b);
    }
    const mosaics = new Map<number, Mosaic>();
    this.tiles.usedSources.clear();
    let wanted = 0;
    let partial = false;
    if (this.tiles.enabled) {
      for (const [z, box] of [...boxes.entries()].sort((a, b) => a[0] - b[0])) {
        if (signal?.aborted) throw new CancelledError();
        // Very wide boxes (long pans) are dropped to a coarser zoom that fits one mosaic.
        let zz = z;
        let m: Mosaic | null = null;
        while (zz >= 0 && !mosaics.has(zz)) {
          const span = ((box[2] - box[0]) / 360) * 256 * 2 ** zz;
          if (span <= MOSAIC_MAX_PX - 512) {
            wanted++;
            m = await buildMosaic(this.tiles, zz, box);
            break;
          }
          zz--;
        }
        if (m) {
          mosaics.set(m.z, m);
          if (m.coverage < 1) partial = true;
        } else if (zz >= 0 && !mosaics.has(zz)) partial = true;
      }
    }
    const attribution: string[] = [];
    if (mosaics.size > 0) attribution.push(...[...this.tiles.usedSources].filter(Boolean));
    if (base) attribution.push(BASE_ATTRIBUTION);
    const wantedDetail = this.tiles.enabled && boxes.size > 0;
    const degraded = wantedDetail && this.tiles.providerEnabled && (mosaics.size < wanted || partial);
    const report: ImageryReport = {
      basemap: "satellite",
      attribution,
      detailZooms: [...mosaics.keys()].sort((a, b) => a - b),
      degraded,
      note: !base
        ? "Base imagery file is missing; areas without tiles are drawn as plain ocean."
        : degraded
          ? `Detail tiles could not all be fetched${this.tiles.lastError ? ` (${this.tiles.lastError})` : ""}; NASA Blue Marble was used where they were missing.`
          : !this.tiles.providerEnabled && boxes.size > 0 && (mosaics.size < wanted || partial || !this.tiles.enabled)
            ? "No detail tile provider is configured; close-ups outside prepared imagery regions use NASA Blue Marble (about 10 km per pixel)."
            : undefined,
    };
    return { imagery: { base, mosaics, maxZoom: cfg.maxZoom, attribution }, report };
  }
}

export class SceneInputError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Scene cannot be rendered: ${errors.join("; ")}`);
    this.name = "SceneInputError";
  }
}

function withFallbackNote(report: ImageryReport, note: string | null): ImageryReport {
  if (!note) return report;
  return { ...report, degraded: true, note: report.note ? `${note} ${report.note}` : note };
}
