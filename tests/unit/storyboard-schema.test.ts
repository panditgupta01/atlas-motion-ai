import { describe, expect, it } from "vitest";
import { parseStoryboard, storyboardSchema, overlaySchema, STORYBOARD_SCHEMA_VERSION } from "@atlas/shared";
import { sceneFixture, storyboardFixture } from "../helpers/fixtures";

describe("storyboard schema", () => {
  it("accepts a valid storyboard and applies defaults", () => {
    const { sources: _s, ...rest } = storyboardFixture();
    const parsed = storyboardSchema.parse(rest);
    expect(parsed.schemaVersion).toBe(STORYBOARD_SCHEMA_VERSION);
    expect(parsed.sources).toEqual([]);
  });

  it("rejects out-of-range coordinates", () => {
    const sb = storyboardFixture({ scenes: [sceneFixture({ location: { name: "Nowhere", latitude: 95, longitude: 10, source: "user" } })] });
    const res = parseStoryboard(sb);
    expect(res.success).toBe(false);
    expect(res.error?.issues.some((i) => i.path.join(".") === "scenes.0.location.latitude")).toBe(true);
  });

  it("rejects scenes shorter than the minimum and longer than the maximum", () => {
    expect(parseStoryboard(storyboardFixture({ scenes: [sceneFixture({ durationSeconds: 1 })] })).success).toBe(false);
    expect(parseStoryboard(storyboardFixture({ scenes: [sceneFixture({ durationSeconds: 31 })] })).success).toBe(false);
  });

  it("rejects an unknown schema version", () => {
    expect(parseStoryboard({ ...storyboardFixture(), schemaVersion: 2 }).success).toBe(false);
  });

  it("validates overlays by type", () => {
    expect(overlaySchema.safeParse({ type: "highlight_country", iso3: "NPL" }).success).toBe(true);
    expect(overlaySchema.safeParse({ type: "highlight_country", iso3: "Nepal" }).success).toBe(false);
    expect(overlaySchema.safeParse({ type: "route", coordinates: [[0, 0]] }).success).toBe(false);
    expect(overlaySchema.safeParse({ type: "legend", items: [{ label: "x", color: "red" }] }).success).toBe(false);
    expect(overlaySchema.safeParse({ type: "fireworks" }).success).toBe(false);
  });

  it("only accepts http(s) source URLs", () => {
    const bad = storyboardFixture({ sources: [{ id: "x", title: "x", url: "javascript:alert(1)", kind: "web", addedBy: "user" }] });
    expect(parseStoryboard(bad).success).toBe(false);
  });

  it("rejects scene ids that are not slug-like", () => {
    expect(parseStoryboard(storyboardFixture({ scenes: [sceneFixture({ id: "Scene 1" })] })).success).toBe(false);
  });
});
