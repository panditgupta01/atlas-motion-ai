import { describe, expect, it } from "vitest";
import {
  assertSafePath,
  buildAudioMixArgs,
  buildConcatArgs,
  buildFinalMuxArgs,
  buildSceneEncodeArgs,
  checkMediaInfo,
  concatListContent,
  escapeFilterPath,
  type MediaInfo,
} from "@atlas/video-engine";

const goodInfo: MediaInfo = {
  durationSeconds: 10,
  sizeBytes: 1000,
  formatName: "mov,mp4,m4a,3gp,3g2,mj2",
  video: { codec: "h264", width: 1080, height: 1920, fps: 30, pixFmt: "yuv420p" },
  audio: { codec: "aac", sampleRate: 48000, channels: 2 },
  subtitles: [],
};

describe("FFmpeg argument builders", () => {
  it("encodes raw RGBA frames to H.264 yuv420p at the requested size", () => {
    const args = buildSceneEncodeArgs({ size: { width: 1080, height: 1920 }, fps: 30, crf: 21, preset: "medium", output: "/tmp/work/scene-001.mp4" });
    expect(args).toEqual(expect.arrayContaining(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1080x1920", "-r", "30", "-c:v", "libx264"]));
    expect(args[args.indexOf("-pix_fmt", args.indexOf("libx264")) + 1]).toBe("yuv420p");
    expect(args.at(-1)).toBe("/tmp/work/scene-001.mp4");
  });

  it("refuses values outside the allowed set instead of passing them through", () => {
    const base = { size: { width: 1080, height: 1920 }, fps: 30, crf: 21, preset: "medium", output: "/tmp/a.mp4" };
    expect(() => buildSceneEncodeArgs({ ...base, preset: "medium -vf evil" })).toThrow();
    expect(() => buildSceneEncodeArgs({ ...base, crf: 99 })).toThrow();
    expect(() => buildSceneEncodeArgs({ ...base, fps: 29.97 })).toThrow();
    expect(() => buildSceneEncodeArgs({ ...base, output: "/tmp/a.mp4; rm -rf /" })).toThrow();
  });

  it("rejects unsafe media paths", () => {
    expect(assertSafePath("/srv/storage/u1/p1/out.mp4")).toBe("/srv/storage/u1/p1/out.mp4");
    for (const bad of ["../etc/passwd", "/tmp/a b.mp4", "/tmp/$(id).mp4", "/tmp/a'.mp4", "concat:/etc/passwd", "/tmp/a\nb.mp4"]) {
      expect(() => assertSafePath(bad)).toThrow();
    }
  });

  it("builds a stream-copy concat with a quoted list file", () => {
    expect(buildConcatArgs("/tmp/list.txt", "/tmp/out.mp4")).toEqual(expect.arrayContaining(["-f", "concat", "-safe", "0", "-c", "copy"]));
    expect(concatListContent(["/tmp/a.mp4", "/tmp/b.mp4"])).toBe("file '/tmp/a.mp4'\nfile '/tmp/b.mp4'\n");
  });

  it("burns subtitles through the subtitles filter or adds a soft mov_text track", () => {
    const burn = buildFinalMuxArgs({ video: "/tmp/v.mp4", audio: "/tmp/a.m4a", burnSubtitles: { assFile: "/tmp/s.ass", fontsDir: "/srv/fonts" }, crf: 21, preset: "medium", output: "/tmp/o.mp4" });
    expect(burn.join(" ")).toContain("subtitles=");
    expect(burn).toContain("libx264");
    const soft = buildFinalMuxArgs({ video: "/tmp/v.mp4", audio: null, softSubtitles: { srtFile: "/tmp/s.srt", language: "hin" }, crf: 21, preset: "medium", output: "/tmp/o.mp4" });
    expect(soft).toContain("mov_text");
    expect(soft.join(" ")).toContain("language=hin");
  });

  it("only puts allow-listed paths into filter graphs", () => {
    expect(escapeFilterPath("/srv/work/job-1/subs.ass")).toContain("/srv/work/job-1/subs.ass");
    expect(() => escapeFilterPath("/tmp/a:b.ass")).toThrow();
    expect(() => escapeFilterPath("/tmp/a,subtitles=/etc/passwd")).toThrow();
  });

  it("mixes narration segments with an optional ambience bed and loudness normalisation", () => {
    const args = buildAudioMixArgs({ segments: [{ file: "/tmp/n1.wav", durationSeconds: 5 }, { file: null, durationSeconds: 3 }], ambience: true, output: "/tmp/mix.m4a" });
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(graph).toContain("loudnorm");
    expect(args.at(-1)).toBe("/tmp/mix.m4a");
  });
});

describe("output validation", () => {
  const expectation = { width: 1080, height: 1920, fps: 30, durationSeconds: 10, requireAudio: true };

  it("accepts a matching file", () => {
    expect(checkMediaInfo(goodInfo, expectation)).toEqual([]);
  });

  it("reports wrong resolution, codec, frame rate, duration and missing audio", () => {
    const bad: MediaInfo = { ...goodInfo, durationSeconds: 7, audio: undefined, video: { codec: "hevc", width: 1920, height: 1080, fps: 25, pixFmt: "yuv444p" } };
    const issues = checkMediaInfo(bad, expectation).join(" ");
    for (const word of ["codec", "Resolution", "Frame rate", "Duration", "audio", "Pixel format"]) expect(issues).toContain(word);
  });

  it("requires a subtitle track when asked", () => {
    expect(checkMediaInfo(goodInfo, { ...expectation, requireSubtitleTrack: true })).toContain("No subtitle track.");
  });
});
