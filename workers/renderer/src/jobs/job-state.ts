import os from "node:os";
import { assertTransition, type AspectFormat, type RenderJobStatus } from "@atlas/shared";
import { RenderJob, type RenderJobDoc } from "@atlas/server-core";
import type { Types } from "mongoose";

const MAX_LOGS = 500;

/**
 * All writes to a render job's persisted state go through this class so the
 * lifecycle rules (allowed transitions, log retention, throttled progress)
 * are enforced in one place.
 */
export class JobState {
  private lastProgressWrite = 0;
  private pendingProgress: Promise<unknown> = Promise.resolve();

  constructor(
    readonly id: Types.ObjectId,
    public status: RenderJobStatus,
    readonly workerId: string,
  ) {}

  static async load(id: string, workerId: string): Promise<{ state: JobState; doc: RenderJobDoc } | null> {
    const doc = await RenderJob.findById(id).lean<RenderJobDoc>();
    if (!doc) return null;
    return { state: new JobState(doc._id, doc.status as RenderJobStatus, workerId), doc };
  }

  /** Move to a new status, enforcing the lifecycle. Same-status moves only update the stage. */
  async moveTo(to: RenderJobStatus, stage: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (to !== this.status) assertTransition(this.status, to);
    const res = await RenderJob.updateOne(
      { _id: this.id, status: this.status },
      {
        $set: { status: to, stage, ...extra },
        $push: { logs: { $each: [{ at: new Date(), level: "info", message: stage }], $slice: -MAX_LOGS } },
      },
    );
    if (res.matchedCount === 0) {
      const current = await RenderJob.findById(this.id).select("status").lean<{ status: RenderJobStatus }>();
      throw new Error(`Render job status changed underneath the worker (expected ${this.status}, found ${current?.status}).`);
    }
    this.status = to;
  }

  async log(level: "info" | "warn" | "error", message: string): Promise<void> {
    await RenderJob.updateOne({ _id: this.id }, { $push: { logs: { $each: [{ at: new Date(), level, message }], $slice: -MAX_LOGS } } });
  }

  async setStage(stage: string): Promise<void> {
    await RenderJob.updateOne({ _id: this.id }, { $set: { stage } });
  }

  async heartbeat(): Promise<void> {
    await RenderJob.updateOne({ _id: this.id }, { $set: { worker: { id: this.workerId, host: os.hostname(), pid: process.pid, heartbeatAt: new Date() } } });
  }

  async isCancelRequested(): Promise<boolean> {
    const doc = await RenderJob.findById(this.id).select("cancelRequested").lean<{ cancelRequested: boolean }>();
    return Boolean(doc?.cancelRequested);
  }

  async updateScene(sceneId: string, format: AspectFormat, fields: Record<string, unknown>, completedUnits?: number): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) set[`scenes.$[s].${k}`] = v;
    if (completedUnits !== undefined) set["progress.completedUnits"] = completedUnits;
    await RenderJob.updateOne({ _id: this.id }, { $set: set }, { arrayFilters: [{ "s.sceneId": sceneId, "s.format": format }] });
  }

  /** Frame progress, written at most every 750 ms. */
  sceneProgress(sceneId: string, format: AspectFormat, framesDone: number, completedUnits: number, force = false): void {
    const now = Date.now();
    if (!force && now - this.lastProgressWrite < 750) return;
    this.lastProgressWrite = now;
    this.pendingProgress = this.pendingProgress.then(() => this.updateScene(sceneId, format, { framesDone }, completedUnits)).catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.pendingProgress;
  }

  async updateAudio(sceneId: string, fields: Record<string, unknown>): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) set[`audio.$[a].${k}`] = v;
    await RenderJob.updateOne({ _id: this.id }, { $set: set }, { arrayFilters: [{ "a.sceneId": sceneId }] });
  }
}
