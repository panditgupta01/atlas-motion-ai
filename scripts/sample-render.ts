/**
 * Render a sample video directly through the engine (no API, database or
 * queue). Useful to verify FFmpeg, fonts, map data and TTS on a machine.
 *
 *   pnpm sample:render -- --prompt "Nepal and the Koshi river" --lang hi --duration 20 --quality draft
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { FORMAT_LAYOUTS, frameSizeFor, type AspectFormat, type Quality } from "@atlas/shared";
import { GazetteerPlanner, planStoryboard } from "@atlas/storyboard";
import {
  EspeakTtsProvider,
  MapSceneRenderer,
  assembleVideo,
  validateVideoFile,
  type AudioSegment,
  type NarrationTiming,
} from "@atlas/video-engine";

const { values } = parseArgs({
  options: {
    prompt: { type: "string", default: "A short map story about Nepal, the Koshi river and Kathmandu." },
    lang: { type: "string", default: "en" },
    duration: { type: "string", default: "20" },
    quality: { type: "string", default: "draft" },
    fps: { type: "string", default: "30" },
    out: { type: "string", default: "storage/samples" },
    formats: { type: "string", default: "9:16,16:9" },
  },
});

const language = values.lang === "hi" ? "hi" : "en";
const quality = values.quality as Quality;
const fps = Number(values.fps);
const formats = values.formats!.split(",") as AspectFormat[];
const outDir = path.resolve(values.out!);
const workDir = path.join(outDir, "work");
fs.mkdirSync(workDir, { recursive: true });

const plan = await planStoryboard(new GazetteerPlanner(), {
  prompt: values.prompt!,
  language,
  durationSeconds: Number(values.duration),
  formats,
  style: "documentary",
  narration: true,
  sourceUrls: [],
});
const sb = plan.storyboard;
console.log(`Planned ${sb.scenes.length} scenes (${sb.durationSeconds}s). Errors: ${plan.validation.errors.length}, warnings: ${plan.validation.warnings.length}`);
fs.writeFileSync(path.join(outDir, "storyboard.json"), JSON.stringify(sb, null, 2));

const tts = new EspeakTtsProvider();
const audio: AudioSegment[] = [];
const timings: NarrationTiming[] = [];
let start = 0;
for (const scene of sb.scenes) {
  let file: string | null = null;
  let audioDuration: number | undefined;
  if (scene.narration && tts.isConfigured()) {
    const r = await tts.synthesize({ text: scene.narration, language, output: path.join(workDir, `${scene.id}.wav`) });
    file = r.output;
    audioDuration = r.durationSeconds;
  }
  audio.push({ file, durationSeconds: scene.durationSeconds });
  timings.push({ sceneStart: start, sceneDuration: scene.durationSeconds, text: scene.narration, audioDuration });
  start += scene.durationSeconds;
}
if (!tts.isConfigured()) console.warn("espeak-ng not found: rendering without narration audio.");

const renderer = new MapSceneRenderer();
for (const format of formats) {
  const clips: string[] = [];
  for (const [i, scene] of sb.scenes.entries()) {
    const output = path.join(workDir, `${format.replace(":", "x")}-${scene.id}.mp4`);
    const t0 = Date.now();
    const r = await renderer.renderScene({ scene, previous: sb.scenes[i - 1], format, quality, fps, output });
    console.log(`  ${format} ${scene.id}: ${r.frames} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    clips.push(output);
  }
  const output = path.join(outDir, `sample-${language}-${format.replace(":", "x")}.mp4`);
  await assembleVideo({ format, quality, language, clips, audio, narrationTimings: timings, ambience: true, subtitles: "burned", title: sb.projectTitle, workDir, output });
  const size = frameSizeFor(format, quality);
  const report = await validateVideoFile(output, { ...size, fps, durationSeconds: sb.durationSeconds, requireAudio: tts.isConfigured() });
  console.log(`${format}: ${report.ok ? "VALID" : "INVALID"} ${output}`, report.issues, report.info?.video, report.info?.audio, `${report.info?.durationSeconds}s`);
  void FORMAT_LAYOUTS;
}
