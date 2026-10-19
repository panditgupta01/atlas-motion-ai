import { FORMAT_LAYOUTS, frameSizeFor, type AspectFormat, type Quality } from "@atlas/shared";

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface NarrationTiming {
  sceneStart: number;
  sceneDuration: number;
  text: string;
  /** Measured narration audio length; falls back to the scene length. */
  audioDuration?: number;
}

/** Split narration into caption-sized chunks on word boundaries. */
export function chunkText(text: string, maxChars: number): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?।])\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    let line = "";
    for (const word of sentence.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > maxChars && line) {
        chunks.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) chunks.push(line);
  }
  return chunks;
}

/** Caption cues timed proportionally to text length across each scene's narration. */
export function buildCues(timings: NarrationTiming[], format: AspectFormat): Cue[] {
  const maxChars = format === "9:16" ? 30 : 48;
  const cues: Cue[] = [];
  for (const t of timings) {
    const chunks = chunkText(t.text, maxChars);
    if (chunks.length === 0) continue;
    const speak = Math.min(t.sceneDuration - 0.1, Math.max(0.8, t.audioDuration ?? t.sceneDuration));
    const totalChars = chunks.reduce((s, c) => s + c.length, 0);
    let cursor = t.sceneStart + 0.05;
    for (const c of chunks) {
      const d = (c.length / totalChars) * speak;
      cues.push({ start: cursor, end: Math.min(t.sceneStart + t.sceneDuration - 0.05, cursor + d), text: c });
      cursor += d;
    }
  }
  return cues;
}

function srtTime(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(sec)},${p(rest, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text.replace(/\r?\n/g, " ")}\n`).join("\n");
}

function assTime(s: number): string {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  const rest = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(rest).padStart(2, "0")}`;
}

/** Neutralise ASS override syntax in user text. */
export function escapeAss(text: string): string {
  return text.replace(/\\/g, "⧵").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, " ");
}

/**
 * ASS subtitle file with a layout specific to the aspect ratio: on 9:16 the
 * captions sit above the area covered by Shorts UI; on 16:9 near the bottom.
 */
export function toAss(cues: Cue[], format: AspectFormat, quality: Quality, language: "hi" | "en"): string {
  const size = frameSizeFor(format, quality);
  const layout = FORMAT_LAYOUTS[format];
  const unit = Math.min(size.width, size.height);
  const fontSize = Math.round(unit * (format === "9:16" ? 0.066 : 0.056));
  const marginV = Math.round(size.height * (format === "9:16" ? layout.safe.bottom + 0.02 : layout.safe.bottom));
  const marginLR = Math.round((size.width * (1 - layout.captionMaxWidth)) / 2);
  const font = language === "hi" ? "Noto Sans Devanagari" : "Noto Sans";
  const outline = Math.max(1, Math.round(fontSize * 0.12));
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${size.width}`,
    `PlayResY: ${size.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${font},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H90000000,0,0,0,0,100,100,0,0,1,${outline},0,2,${marginLR},${marginLR},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${escapeAss(c.text)}`),
    "",
  ].join("\n");
}
