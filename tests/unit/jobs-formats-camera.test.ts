import { describe, expect, it } from "vitest";
import {
  FORMAT_LAYOUTS,
  InvalidTransitionError,
  OUTPUT_SIZES,
  RENDER_JOB_STATUSES,
  assertTransition,
  aspectRatio,
  cameraAt,
  canTransition,
  formatFromSize,
  frameSizeFor,
  isTerminal,
  lerpLongitude,
} from "@atlas/shared";
import { sceneFixture } from "../helpers/fixtures";

describe("render job state machine", () => {
  it("allows the normal pipeline", () => {
    const path = ["queued", "rendering_scenes", "generating_audio", "assembling", "validating", "completed"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
  });

  it("allows cancel, failure and user retry", () => {
    expect(canTransition("rendering_scenes", "cancelled")).toBe(true);
    expect(canTransition("assembling", "failed")).toBe(true);
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("cancelled", "queued")).toBe(true);
    expect(canTransition("rendering_scenes", "retrying")).toBe(true);
  });

  it("rejects skipping stages or leaving completed", () => {
    expect(canTransition("queued", "completed")).toBe(false);
    expect(canTransition("completed", "queued")).toBe(false);
    expect(canTransition("rendering_scenes", "validating")).toBe(false);
    expect(() => assertTransition("completed", "rendering_scenes")).toThrow(InvalidTransitionError);
  });

  it("marks exactly completed, failed and cancelled as terminal", () => {
    expect(RENDER_JOB_STATUSES.filter(isTerminal).sort()).toEqual(["cancelled", "completed", "failed"]);
  });
});

describe("output formats", () => {
  it("uses 1080x1920 and 1920x1080 at standard quality", () => {
    expect(frameSizeFor("9:16", "standard")).toEqual({ width: 1080, height: 1920 });
    expect(frameSizeFor("16:9", "high")).toEqual({ width: 1920, height: 1080 });
  });

  it("keeps the aspect ratio and even dimensions at draft quality", () => {
    for (const f of ["9:16", "16:9"] as const) {
      const s = frameSizeFor(f, "draft");
      expect(s.width % 2).toBe(0);
      expect(s.height % 2).toBe(0);
      expect(aspectRatio(s)).toBeCloseTo(aspectRatio(OUTPUT_SIZES[f]), 2);
      expect(formatFromSize(s)).toBe(f);
    }
  });
});

describe("camera timeline", () => {
  it("starts at the previous scene and ends on the target", () => {
    const prev = sceneFixture({ location: { name: "A", latitude: 10, longitude: 10, source: "user" } });
    const scene = sceneFixture({ location: { name: "B", latitude: 20, longitude: 30, source: "user" }, camera: { move: "zoom_to", zoomStart: 1, zoomEnd: 5, easing: "ease_in_out" } });
    const layout = FORMAT_LAYOUTS["16:9"];
    const a = cameraAt(scene, prev, 0, layout);
    const b = cameraAt(scene, prev, 1, layout);
    expect([a.longitude, a.latitude, a.zoom]).toEqual([10, 10, 1]);
    expect([b.longitude, b.latitude, b.zoom]).toEqual([30, 20, 5]);
  });

  it("applies the vertical format zoom bias", () => {
    const scene = sceneFixture({ camera: { move: "static", zoomStart: 4, zoomEnd: 4, easing: "linear" } });
    expect(cameraAt(scene, undefined, 0.5, FORMAT_LAYOUTS["9:16"]).zoom).toBeCloseTo(4 + FORMAT_LAYOUTS["9:16"].zoomBias);
  });

  it("interpolates longitude across the antimeridian the short way", () => {
    expect(lerpLongitude(170, -170, 0.5)).toBeCloseTo(180, 5);
    expect(Math.abs(lerpLongitude(170, -170, 0.25))).toBeGreaterThan(170);
  });
});
