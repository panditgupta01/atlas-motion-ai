import fs from "node:fs";
import path from "node:path";
import { QUALITY_SETTINGS, type AspectFormat, type Language, type Quality } from "@atlas/shared";
import {
  buildAudioMixArgs,
  buildConcatArgs,
  buildFinalMuxArgs,
  concatListContent,
  runFfmpeg,
  type AudioSegment,
} from "./ffmpeg.js";
import { fontsDir } from "./map-frame.js";
import { buildCues, toAss, toSrt, type NarrationTiming } from "./subtitles.js";

export interface AssembleInput {
  format: AspectFormat;
  quality: Quality;
  language: Language;
  /** Scene clips in order, all with identical encoding parameters. */
  clips: string[];
  /** Per-scene audio (narration file or silence) with the scene durations. */
  audio: AudioSegment[];
  narrationTimings: NarrationTiming[];
  ambience: boolean;
  subtitles: "burned" | "sidecar" | "none";
  title?: string;
  workDir: string;
  output: string;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
}

export interface AssembleResult {
  output: string;
  srtFile?: string;
  hasAudio: boolean;
  hasSubtitleTrack: boolean;
  burnedSubtitles: boolean;
  cueCount: number;
}

export async function assembleVideo(input: AssembleInput): Promise<AssembleResult> {
  fs.mkdirSync(input.workDir, { recursive: true });
  const q = QUALITY_SETTINGS[input.quality];

  input.onStage?.("joining scenes");
  const listFile = path.join(input.workDir, `concat-${input.format.replace(":", "x")}.txt`);
  fs.writeFileSync(listFile, concatListContent(input.clips));
  const joined = path.join(input.workDir, `joined-${input.format.replace(":", "x")}.mp4`);
  await runFfmpeg(buildConcatArgs(listFile, joined), { signal: input.signal });

  const hasNarration = input.audio.some((a) => a.file);
  let audioFile: string | null = null;
  if (hasNarration || input.ambience) {
    input.onStage?.("mixing audio");
    audioFile = path.join(input.workDir, `mix-${input.format.replace(":", "x")}.wav`);
    await runFfmpeg(buildAudioMixArgs({ segments: input.audio, ambience: input.ambience, output: audioFile }), { signal: input.signal });
  }

  const cues = input.subtitles === "none" ? [] : buildCues(input.narrationTimings, input.format);
  let srtFile: string | undefined;
  let assFile: string | undefined;
  if (cues.length > 0) {
    srtFile = path.join(input.workDir, `captions-${input.format.replace(":", "x")}.srt`);
    fs.writeFileSync(srtFile, toSrt(cues), "utf8");
    if (input.subtitles === "burned") {
      assFile = path.join(input.workDir, `captions-${input.format.replace(":", "x")}.ass`);
      fs.writeFileSync(assFile, toAss(cues, input.format, input.quality, input.language), "utf8");
    }
  }

  input.onStage?.(assFile ? "burning subtitles and encoding" : "muxing");
  const tmp = `${input.output}.partial.mp4`;
  await runFfmpeg(
    buildFinalMuxArgs({
      video: joined,
      audio: audioFile,
      burnSubtitles: assFile ? { assFile, fontsDir: fontsDir() } : undefined,
      softSubtitles: input.subtitles === "sidecar" && srtFile ? { srtFile, language: input.language === "hi" ? "hin" : "eng" } : undefined,
      crf: q.crf,
      preset: q.preset,
      output: tmp,
      title: input.title,
    }),
    { signal: input.signal },
  );
  fs.renameSync(tmp, input.output);
  return {
    output: input.output,
    srtFile,
    hasAudio: Boolean(audioFile),
    hasSubtitleTrack: input.subtitles === "sidecar" && Boolean(srtFile),
    burnedSubtitles: Boolean(assFile),
    cueCount: cues.length,
  };
}
