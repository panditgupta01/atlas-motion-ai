import type { FrameSize } from "@atlas/shared";

export { camera3dAt, cameraAt, defaultPitch, easeInOut, lerpLongitude, toMapLibreZoom, type Camera3D, type CameraState } from "@atlas/shared";

/** Orthographic projection scale (pixels per radian) for a zoom level. */
export function scaleForZoom(zoom: number, size: FrameSize): number {
  const minSide = Math.min(size.width, size.height);
  return minSide * 0.45 * Math.pow(2, zoom);
}

/** Angular radius (degrees) of the visible area around the camera centre. */
export function visibleRadiusDegrees(scale: number, size: FrameSize): number {
  const halfDiag = Math.hypot(size.width, size.height) / 2;
  const r = halfDiag / scale;
  return r >= 1 ? 90 : (Math.asin(r) * 180) / Math.PI;
}
