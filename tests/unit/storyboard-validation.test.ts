import { describe, expect, it } from "vitest";
import { durationToleranceSeconds, estimateNarrationSeconds, validateStoryboard } from "@atlas/shared";
import { sceneFixture, storyboardFixture } from "../helpers/fixtures";

const codes = (r: ReturnType<typeof validateStoryboard>) => ({ errors: r.errors.map((e) => e.code), warnings: r.warnings.map((w) => w.code) });

describe("validateStoryboard", () => {
  it("passes a consistent storyboard", () => {
    const r = validateStoryboard(storyboardFixture());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("flags total duration outside tolerance", () => {
    expect(durationToleranceSeconds(10)).toBe(1);
    expect(durationToleranceSeconds(60)).toBe(3);
    const r = validateStoryboard(storyboardFixture({ durationSeconds: 30 }));
    expect(codes(r).errors).toContain("duration_mismatch");
    // Within tolerance is fine.
    expect(validateStoryboard(storyboardFixture({ durationSeconds: 10.9 })).ok).toBe(true);
  });

  it("flags coordinates at 0,0 (null island)", () => {
    const sb = storyboardFixture({ scenes: [sceneFixture({ durationSeconds: 10, location: { name: "X", latitude: 0, longitude: 0, source: "user" } })] });
    const all = [...codes(validateStoryboard(sb)).errors, ...codes(validateStoryboard(sb)).warnings];
    expect(all.some((c) => c.includes("null_island"))).toBe(true);
  });

  it("blocks rendering on unsupported claims", () => {
    const sb = storyboardFixture();
    sb.scenes[0]!.claims = [{ text: "Nepal has 8 of the 10 highest peaks.", sourceRefIds: [], status: "unsupported" }];
    const r = validateStoryboard(sb);
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.sceneId === "scene-001")).toBeTruthy();
  });

  it("accepts illustrative claims and sourced claims with a known source", () => {
    const sb = storyboardFixture();
    sb.scenes[0]!.claims = [
      { text: "A journey begins.", sourceRefIds: [], status: "illustrative" },
      { text: "Nepal borders India.", sourceRefIds: ["natural-earth"], status: "sourced" },
    ];
    expect(validateStoryboard(sb).ok).toBe(true);
  });

  it("rejects a sourced claim that cites an unknown source", () => {
    const sb = storyboardFixture();
    sb.scenes[0]!.claims = [{ text: "Nepal borders India.", sourceRefIds: ["made-up"], status: "sourced" }];
    expect(validateStoryboard(sb).ok).toBe(false);
  });

  it("requires a route or river for follow_route scenes", () => {
    const sb = storyboardFixture();
    sb.scenes[1]!.camera.move = "follow_route";
    sb.scenes[1]!.overlays = [];
    const r = validateStoryboard(sb);
    expect([...r.errors, ...r.warnings].some((i) => i.sceneId === "scene-002")).toBe(true);
  });

  it("warns when narration is too long for the scene", () => {
    const sb = storyboardFixture();
    sb.scenes[0]!.narration = Array.from({ length: 40 }, () => "word").join(" ");
    expect(validateStoryboard(sb).warnings.some((w) => w.sceneId === "scene-001")).toBe(true);
  });

  it("flags duplicate scene ids", () => {
    const sb = storyboardFixture();
    sb.scenes[1]!.id = "scene-001";
    expect(validateStoryboard(sb).ok).toBe(false);
  });

  it("estimates narration length per language", () => {
    const text = Array.from({ length: 22 }, () => "शब्द").join(" ");
    expect(estimateNarrationSeconds(text, "hi")).toBeGreaterThan(estimateNarrationSeconds(text, "en"));
    expect(estimateNarrationSeconds("", "en")).toBe(0);
  });
});
