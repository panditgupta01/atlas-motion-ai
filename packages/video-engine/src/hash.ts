import crypto from "node:crypto";
import type { AspectFormat, Quality, Scene } from "@atlas/shared";
import { MAP_RENDERER_VERSION } from "./scene-renderer.js";

/** JSON.stringify with sorted object keys, so equal data always hashes equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/**
 * Cache key for a rendered scene clip. Includes everything that changes the
 * pixels: the scene's visual fields, the previous scene's location (camera
 * start point), format, quality, fps and renderer version. Narration text and
 * claims are excluded because captions are added at assembly time.
 */
export function sceneCacheKey(scene: Scene, previous: Scene | undefined, format: AspectFormat, quality: Quality, fps: number): string {
  return sha256(
    stableStringify({
      v: MAP_RENDERER_VERSION,
      format,
      quality,
      fps,
      duration: scene.durationSeconds,
      location: { lat: scene.location.latitude, lon: scene.location.longitude },
      camera: scene.camera,
      overlays: scene.overlays,
      prev: previous ? { lat: previous.location.latitude, lon: previous.location.longitude } : null,
    }),
  ).slice(0, 32);
}

export function narrationCacheKey(text: string, language: string, provider: string, voice: string): string {
  return sha256(stableStringify({ text: text.trim(), language, provider, voice })).slice(0, 32);
}
