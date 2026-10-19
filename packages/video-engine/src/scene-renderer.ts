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
import { cameraAt } from "./camera.js";
import { buildSceneEncodeArgs, CancelledError, spawnFrameEncoder } from "./ffmpeg.js";
import { MapFrameRenderer } from "./map-frame.js";

export interface RenderSceneInput {
  scene: Scene;
  /** Previous scene, used as the camera's starting point. */
  previous?: Scene;
  format: AspectFormat;
  quality: Quality;
  fps: number;
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
}

/** Bump when frame output changes, so cached clips are re-rendered. */
export const MAP_RENDERER_VERSION = "map2d-1";

/**
 * 2D animated map renderer: draws every frame with Skia (via @napi-rs/canvas)
 * from Natural Earth vectors in an orthographic projection, and pipes raw
 * frames into FFmpeg. Deterministic: the same scene input yields the same frames.
 */
export class MapSceneRenderer implements SceneRenderer {
  getCapabilities(): RendererCapabilities {
    return {
      id: "map2d",
      label: "2D vector map (Natural Earth, orthographic globe)",
      terrain3d: false,
      overlays: ["title_card", "location_label", "marker", "highlight_country", "river", "route", "arrow", "legend"],
      cameraMoves: ["static", "zoom_to", "zoom_out", "pan_to", "orbit", "follow_route"],
      maxFps: 30,
      dataSources: ["Natural Earth 1:10m/1:50m (public domain)"],
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
    try {
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
      await encoder.finish();
    } catch (err) {
      encoder.kill();
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    // Atomic publish: a clip at `output` is always complete.
    fs.renameSync(tmp, input.output);
    return { output: input.output, frames, width: size.width, height: size.height, durationSeconds: frames / input.fps, renderer: MAP_RENDERER_VERSION, elapsedMs: Date.now() - started };
  }
}

export class SceneInputError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Scene cannot be rendered: ${errors.join("; ")}`);
    this.name = "SceneInputError";
  }
}
