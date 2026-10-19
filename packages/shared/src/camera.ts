import type { FormatLayout } from "./formats.js";
import type { Scene } from "./storyboard.js";

/**
 * Camera timeline shared by the video renderer and the editor preview, so the
 * preview frames each scene the way the final video will.
 */

export interface CameraState {
  longitude: number;
  latitude: number;
  zoom: number;
  /** Roll in degrees (used by "orbit"). */
  roll: number;
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate longitude along the shorter way around the globe. */
export function lerpLongitude(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  let v = a + d * t;
  if (v > 180) v -= 360;
  if (v < -180) v += 360;
  return v;
}

/**
 * Camera at normalised time t ∈ [0,1] within a scene. Camera start points
 * default to the previous scene's location, so consecutive scenes connect.
 */
export function cameraAt(scene: Scene, previous: Scene | undefined, t: number, layout: FormatLayout): CameraState {
  const cam = scene.camera;
  const k = cam.easing === "linear" ? t : easeInOut(Math.min(1, Math.max(0, t)));
  const target = { longitude: scene.location.longitude, latitude: scene.location.latitude };
  const from = cam.from ?? (previous ? { longitude: previous.location.longitude, latitude: previous.location.latitude } : target);
  const zoomStart = cam.zoomStart + layout.zoomBias;
  const zoomEnd = cam.zoomEnd + layout.zoomBias;

  switch (cam.move) {
    case "static":
      return { ...target, zoom: zoomEnd, roll: 0 };
    case "zoom_to":
    case "zoom_out":
    case "pan_to":
    case "follow_route": {
      // The camera travels in the first 60% of the scene for zoom moves when coming from elsewhere,
      // so the end framing holds long enough to read labels.
      const travelK = cam.move === "pan_to" ? k : easeInOut(Math.min(1, t / 0.6));
      return {
        longitude: lerpLongitude(from.longitude, target.longitude, travelK),
        latitude: lerp(from.latitude, target.latitude, travelK),
        zoom: lerp(zoomStart, zoomEnd, k),
        roll: 0,
      };
    }
    case "orbit":
      return {
        longitude: lerpLongitude(target.longitude - 8 / Math.pow(2, Math.max(0, zoomStart - 1)), target.longitude, k),
        latitude: target.latitude,
        zoom: lerp(zoomStart, zoomEnd, k),
        roll: lerp(-4, 4, k),
      };
  }
}

