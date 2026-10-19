import type { MediaAssetDto, ProjectDto, RenderJobDto, RenderSettings, UserDto } from "@atlas/shared";
import type { MediaAssetDoc, ProjectDoc, RenderJobDoc, UserDoc } from "./models.js";

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : undefined);

export function toUserDto(u: UserDoc): UserDto {
  return { id: String(u._id), email: u.email, role: u.role as UserDto["role"], createdAt: iso(u.createdAt)! };
}

export function toProjectDto(p: ProjectDoc): ProjectDto {
  return {
    id: String(p._id),
    title: p.title,
    prompt: p.prompt,
    options: p.options as ProjectDto["options"],
    status: p.status as ProjectDto["status"],
    storyboardVersion: p.storyboardVersion,
    hasStoryboard: Boolean(p.storyboard),
    thumbnailAssetId: p.thumbnailAssetId ? String(p.thumbnailAssetId) : undefined,
    latestRenderId: p.latestRenderId ? String(p.latestRenderId) : undefined,
    createdAt: iso(p.createdAt)!,
    updatedAt: iso(p.updatedAt)!,
  };
}

export function toAssetDto(a: MediaAssetDoc): MediaAssetDto {
  return {
    id: String(a._id),
    kind: a.kind as MediaAssetDto["kind"],
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    format: (a.format ?? undefined) as MediaAssetDto["format"],
    width: a.width ?? undefined,
    height: a.height ?? undefined,
    durationSeconds: a.durationSeconds ?? undefined,
    fps: a.fps ?? undefined,
    videoCodec: a.videoCodec ?? undefined,
    audioCodec: a.audioCodec ?? undefined,
    provider: a.provider ?? undefined,
    license: a.license ?? undefined,
    filename: a.filename,
    createdAt: iso(a.createdAt)!,
    // Relative URL: the API checks the session and ownership on every download.
    downloadUrl: `/api/v1/assets/${String(a._id)}/download`,
  };
}

export function toRenderJobDto(j: RenderJobDoc, outputs: MediaAssetDoc[]): RenderJobDto {
  const total = j.progress?.totalUnits ?? 0;
  const done = j.progress?.completedUnits ?? 0;
  return {
    id: String(j._id),
    projectId: String(j.project),
    status: j.status as RenderJobDto["status"],
    stage: j.stage,
    settings: j.settings as RenderSettings,
    storyboardVersion: j.storyboardVersion,
    scenes: (j.scenes ?? []).map((s) => ({
      sceneId: s.sceneId,
      format: s.format as "9:16" | "16:9",
      status: s.status as RenderJobDto["scenes"][number]["status"],
      framesDone: s.framesDone ?? 0,
      framesTotal: s.framesTotal ?? 0,
      attempts: s.attempts ?? 0,
      error: s.error ?? undefined,
      cacheKey: s.cacheKey ?? undefined,
    })),
    progress: { completedUnits: done, totalUnits: total, fraction: total > 0 ? Math.min(1, done / total) : 0 },
    attempts: j.attempts,
    cancelRequested: j.cancelRequested,
    error: j.error?.message ? { message: j.error.message, kind: j.error.kind ?? "unknown", sceneId: j.error.sceneId ?? undefined } : undefined,
    logs: (j.logs ?? []).slice(-200).map((l) => ({ at: iso(l.at as Date)!, level: (l.level ?? "info") as "info" | "warn" | "error", message: l.message ?? "" })),
    // Only outputs that passed validation are ever attached to a job.
    outputs: outputs.map(toAssetDto),
    warnings: j.warnings ?? [],
    createdAt: iso(j.createdAt)!,
    startedAt: iso(j.startedAt),
    finishedAt: iso(j.finishedAt),
  };
}
