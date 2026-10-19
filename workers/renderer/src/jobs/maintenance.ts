import fs from "node:fs";
import path from "node:path";
import { ACTIVE_JOB_STATUSES } from "@atlas/shared";
import { MediaAsset, RenderJob, renderQueueJobId, type MediaAssetDoc, type RenderJobDoc } from "@atlas/server-core";
import type { Queue } from "bullmq";
import type { WorkerContext } from "./render-job.js";

/**
 * Re-enqueue render jobs that the database says are active but that have no
 * live queue entry and no recent heartbeat (e.g. Redis was flushed or the
 * worker died before BullMQ could mark the job stalled).
 */
export async function reconcileOrphanedJobs(ctx: WorkerContext, queue: Queue): Promise<number> {
  const staleBefore = new Date(Date.now() - 2 * 60_000);
  const candidates = await RenderJob.find({
    status: { $in: ACTIVE_JOB_STATUSES },
    $or: [{ "worker.heartbeatAt": { $lt: staleBefore } }, { "worker.heartbeatAt": { $exists: false }, createdAt: { $lt: staleBefore } }],
  })
    .select("_id attempts status")
    .lean<RenderJobDoc[]>();
  let requeued = 0;
  for (const job of candidates) {
    const id = renderQueueJobId(String(job._id), job.attempts);
    const existing = await queue.getJob(id);
    const state = existing ? await existing.getState() : "missing";
    if (state === "missing" || state === "completed" || state === "failed" || state === "unknown") {
      if (existing) await existing.remove().catch(() => undefined);
      await queue.add("render", { renderJobId: String(job._id) }, { jobId: id, attempts: ctx.config.RENDER_MAX_ATTEMPTS, backoff: { type: "exponential", delay: 15_000 } });
      requeued++;
      ctx.logger.warn({ renderJobId: String(job._id), status: job.status }, "re-enqueued orphaned render job");
    }
  }
  return requeued;
}

/**
 * Delete expired intermediate assets (scene clips) that no active render
 * needs, and scratch directories older than the retention window.
 */
export async function cleanupExpired(ctx: WorkerContext): Promise<{ assets: number; dirs: number }> {
  const now = new Date();
  const expired = await MediaAsset.find({ kind: "scene_clip", expiresAt: { $lt: now } }).limit(500).lean<MediaAssetDoc[]>();
  let assets = 0;
  for (const a of expired) {
    const inUse = await RenderJob.exists({ status: { $in: ACTIVE_JOB_STATUSES }, "scenes.clipAssetId": a._id });
    if (inUse) continue;
    await ctx.storage.delete(a.storageKey).catch(() => undefined);
    await MediaAsset.deleteOne({ _id: a._id });
    assets++;
  }
  let dirs = 0;
  const jobsDir = path.join(ctx.config.WORK_DIR, "jobs");
  if (fs.existsSync(jobsDir)) {
    const cutoff = Date.now() - ctx.config.TEMP_RETENTION_HOURS * 3600_000;
    for (const name of fs.readdirSync(jobsDir)) {
      const p = path.join(jobsDir, name);
      const active = /^[a-f0-9]{24}$/.test(name) && (await RenderJob.exists({ _id: name, status: { $in: ACTIVE_JOB_STATUSES } }));
      if (!active && fs.statSync(p).mtimeMs < cutoff) {
        fs.rmSync(p, { recursive: true, force: true });
        dirs++;
      }
    }
  }
  return { assets, dirs };
}
