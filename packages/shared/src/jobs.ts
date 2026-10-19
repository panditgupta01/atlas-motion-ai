import { z } from "zod";

/**
 * Render job lifecycle. Planning and review happen on the project/storyboard,
 * so a render job starts at `queued` once a reviewed storyboard is submitted.
 */
export const RENDER_JOB_STATUSES = [
  "queued",
  "rendering_scenes",
  "generating_audio",
  "assembling",
  "validating",
  "completed",
  "retrying",
  "failed",
  "cancelled",
] as const;
export const renderJobStatusSchema = z.enum(RENDER_JOB_STATUSES);
export type RenderJobStatus = z.infer<typeof renderJobStatusSchema>;

export const TERMINAL_JOB_STATUSES: readonly RenderJobStatus[] = ["completed", "failed", "cancelled"];
export const ACTIVE_JOB_STATUSES: readonly RenderJobStatus[] = [
  "queued",
  "rendering_scenes",
  "generating_audio",
  "assembling",
  "validating",
  "retrying",
];

const TRANSITIONS: Record<RenderJobStatus, readonly RenderJobStatus[]> = {
  queued: ["rendering_scenes", "failed", "cancelled"],
  rendering_scenes: ["generating_audio", "assembling", "retrying", "failed", "cancelled"],
  generating_audio: ["assembling", "retrying", "failed", "cancelled"],
  assembling: ["validating", "retrying", "failed", "cancelled"],
  validating: ["completed", "retrying", "failed", "cancelled"],
  retrying: ["rendering_scenes", "failed", "cancelled"],
  // A user retry moves a failed or cancelled job back into the queue.
  failed: ["queued"],
  cancelled: ["queued"],
  completed: [],
};

export function canTransition(from: RenderJobStatus, to: RenderJobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: RenderJobStatus,
    public readonly to: RenderJobStatus,
  ) {
    super(`Render job cannot move from "${from}" to "${to}".`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: RenderJobStatus, to: RenderJobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: RenderJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/** Per-scene, per-format render status tracked inside a render job. */
export const SCENE_RENDER_STATUSES = ["pending", "rendering", "done", "cached", "failed", "skipped"] as const;
export type SceneRenderStatus = (typeof SCENE_RENDER_STATUSES)[number];

/** Project lifecycle as shown on the dashboard. */
export const PROJECT_STATUSES = [
  "draft",
  "planning",
  "awaiting_review",
  "rendering",
  "rendered",
  "render_failed",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Error classes the worker distinguishes for retry decisions. */
export type RenderErrorKind = "recoverable" | "permanent" | "cancelled";
