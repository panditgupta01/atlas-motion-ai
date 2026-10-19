import { z } from "zod";
import type { AspectFormat } from "./storyboard.js";

export interface FrameSize {
  width: number;
  height: number;
}

export const OUTPUT_SIZES: Record<AspectFormat, FrameSize> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
};

export const QUALITY_PRESETS = ["draft", "standard", "high"] as const;
export const qualitySchema = z.enum(QUALITY_PRESETS);
export type Quality = z.infer<typeof qualitySchema>;

/**
 * Quality preset → encoder settings and render scale. `draft` renders at half
 * resolution so previews are quick; the file still has the exact output
 * aspect ratio.
 */
export const QUALITY_SETTINGS: Record<Quality, { crf: number; preset: string; scale: number }> = {
  draft: { crf: 28, preset: "veryfast", scale: 0.5 },
  standard: { crf: 21, preset: "medium", scale: 1 },
  high: { crf: 18, preset: "slow", scale: 1 },
};

export const FPS_OPTIONS = [24, 25, 30] as const;

/** Frame size for a format at a quality preset, rounded to even numbers for H.264. */
export function frameSizeFor(format: AspectFormat, quality: Quality): FrameSize {
  const base = OUTPUT_SIZES[format];
  const scale = QUALITY_SETTINGS[quality].scale;
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(base.width), height: even(base.height) };
}

export function aspectRatio(size: FrameSize): number {
  return size.width / size.height;
}

export function formatFromSize(size: FrameSize): AspectFormat | null {
  const r = aspectRatio(size);
  if (Math.abs(r - 9 / 16) < 0.01) return "9:16";
  if (Math.abs(r - 16 / 9) < 0.01) return "16:9";
  return null;
}

/**
 * Independent layout for each aspect ratio: where titles, captions and legends
 * go, and how much extra map context to show. Values are fractions of the frame.
 */
export interface FormatLayout {
  /** Safe area insets (platform UI overlays on Shorts cover the bottom and right). */
  safe: { top: number; right: number; bottom: number; left: number };
  titleY: number;
  captionY: number;
  captionMaxWidth: number;
  legendCorner: "top-left" | "bottom-left";
  /** Base text size as a fraction of the frame's shorter side. */
  textScale: number;
  /** Multiplier applied to camera zoom so the subject fits the narrower axis. */
  zoomBias: number;
}

export const FORMAT_LAYOUTS: Record<AspectFormat, FormatLayout> = {
  "9:16": {
    safe: { top: 0.08, right: 0.12, bottom: 0.2, left: 0.06 },
    titleY: 0.14,
    captionY: 0.74,
    captionMaxWidth: 0.82,
    legendCorner: "top-left",
    textScale: 0.05,
    zoomBias: -0.6,
  },
  "16:9": {
    safe: { top: 0.06, right: 0.05, bottom: 0.08, left: 0.05 },
    titleY: 0.12,
    captionY: 0.86,
    captionMaxWidth: 0.7,
    legendCorner: "bottom-left",
    textScale: 0.045,
    zoomBias: 0,
  },
};
