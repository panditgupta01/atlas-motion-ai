import { describe, expect, it } from "vitest";
import { buildCues, chunkText, escapeAss, narrationCacheKey, sceneCacheKey, stableStringify, toAss, toSrt } from "@atlas/video-engine";
import { sceneFixture } from "../helpers/fixtures";

describe("subtitles", () => {
  it("chunks text on word and sentence boundaries, including the Devanagari danda", () => {
    expect(chunkText("one two three four five", 9)).toEqual(["one two", "three", "four five"]);
    expect(chunkText("नेपाल सुंदर है। भारत बड़ा है।", 40)).toEqual(["नेपाल सुंदर है।", "भारत बड़ा है।"]);
  });

  it("times cues inside each scene's window, in order and without overlap", () => {
    const cues = buildCues(
      [
        { sceneStart: 0, sceneDuration: 5, text: "First scene narration that is long enough to split into parts." },
        { sceneStart: 5, sceneDuration: 4, text: "Second scene.", audioDuration: 1.5 },
      ],
      "9:16",
    );
    expect(cues.length).toBeGreaterThan(2);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end - 1e-9);
    const second = cues.filter((c) => c.start >= 5);
    expect(second.at(-1)!.end).toBeLessThanOrEqual(9);
  });

  it("writes valid SRT timestamps", () => {
    const srt = toSrt([{ start: 0, end: 1.5, text: "Hello" }, { start: 61.25, end: 63, text: "World" }]);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\nHello");
    expect(srt).toContain("2\n00:01:01,250 --> 00:01:03,000\nWorld");
  });

  it("escapes ASS override characters so captions cannot inject styling", () => {
    expect(escapeAss("{\\b1}bold")).not.toContain("{");
    const ass = toAss([{ start: 0, end: 1, text: "{\\pos(0,0)}x" }], "16:9", "standard", "en");
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).not.toContain("{\\pos");
  });
});

describe("cache keys", () => {
  const scene = sceneFixture();

  it("is stable regardless of object key order", () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(stableStringify({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it("changes when visual inputs change and ignores narration and review status", () => {
    const k = sceneCacheKey(scene, undefined, "9:16", "standard", 30);
    expect(sceneCacheKey({ ...scene }, undefined, "9:16", "standard", 30)).toBe(k);
    expect(sceneCacheKey({ ...scene, narration: "different words" }, undefined, "9:16", "standard", 30)).toBe(k);
    expect(sceneCacheKey({ ...scene, status: "approved" }, undefined, "9:16", "standard", 30)).toBe(k);
    expect(sceneCacheKey(scene, undefined, "16:9", "standard", 30)).not.toBe(k);
    expect(sceneCacheKey(scene, undefined, "9:16", "draft", 30)).not.toBe(k);
    expect(sceneCacheKey(scene, undefined, "9:16", "standard", 24)).not.toBe(k);
    expect(sceneCacheKey({ ...scene, camera: { ...scene.camera, zoomEnd: 5 } }, undefined, "9:16", "standard", 30)).not.toBe(k);
  });

  it("depends on the previous scene's location, which sets the camera start", () => {
    const prevA = sceneFixture({ location: { name: "A", latitude: 1, longitude: 1, source: "user" } });
    const prevB = sceneFixture({ location: { name: "B", latitude: 2, longitude: 2, source: "user" } });
    expect(sceneCacheKey(scene, prevA, "9:16", "standard", 30)).not.toBe(sceneCacheKey(scene, prevB, "9:16", "standard", 30));
  });

  it("keys narration on text, language, provider and voice", () => {
    const k = narrationCacheKey("hello", "en", "espeak", "en-us");
    expect(narrationCacheKey("hello", "hi", "espeak", "en-us")).not.toBe(k);
    expect(narrationCacheKey("hello", "en", "espeak", "en-us")).toBe(k);
  });
});
