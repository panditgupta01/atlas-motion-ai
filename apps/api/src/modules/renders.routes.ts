import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  assertTransition,
  createRenderSchema,
  isTerminal,
  parseStoryboard,
  retryRenderSchema,
  validateStoryboard,
  type RenderJobStatus,
} from "@atlas/shared";
import { MediaAsset, Project, RenderJob, toRenderJobDto, type MediaAssetDoc, type RenderJobDoc } from "@atlas/server-core";
import type { AppDeps } from "../deps.js";
import { AppError, parse } from "../errors.js";
import { currentUserId, ownedProject, ownedRender } from "./ownership.js";

async function renderDto(job: RenderJobDoc) {
  const outputs = job.outputs?.length ? await MediaAsset.find({ _id: { $in: job.outputs }, owner: job.owner }).lean<MediaAssetDoc[]>() : [];
  return toRenderJobDto(job, outputs);
}

export function renderRoutes(deps: AppDeps): { projectScoped: Router; renderScoped: Router } {
  const projectScoped = Router({ mergeParams: true });
  const renderScoped = Router();
  const renderLimiter = rateLimit({
    windowMs: 60_000,
    limit: deps.config.NODE_ENV === "test" ? 1000 : 5,
    keyGenerator: (req) => String(req.user?._id ?? req.ip),
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });

  projectScoped.post("/renders", renderLimiter, async (req, res) => {
    const body = parse(createRenderSchema, req.body);
    const owner = currentUserId(req);
    const project = await ownedProject(req);

    if (body.idempotencyKey) {
      const existing = await RenderJob.findOne({ owner, idempotencyKey: body.idempotencyKey }).lean<RenderJobDoc>();
      if (existing) return res.status(200).json({ render: await renderDto(existing) });
    }

    const parsed = parseStoryboard(project.storyboard);
    if (!parsed.success) throw new AppError(409, "no_storyboard", "Generate and review a storyboard before rendering.");
    if (body.storyboardVersion !== project.storyboardVersion) {
      throw new AppError(409, "version_conflict", "The storyboard changed after you reviewed it. Review the latest version, then render.", { currentVersion: project.storyboardVersion });
    }
    const validation = validateStoryboard(parsed.data);
    if (!validation.ok) {
      throw new AppError(422, "storyboard_invalid", "Fix the storyboard errors before rendering.", validation.errors);
    }
    const storyboard = parsed.data;
    const hasNarration = body.narration && storyboard.scenes.some((s) => s.narration.trim());
    if (hasNarration && !deps.tts.pick(storyboard.language)) {
      throw new AppError(422, "narration_unavailable", `No narration provider for ${storyboard.language === "hi" ? "Hindi" : "English"} is configured on this server. Turn narration off or configure a TTS provider.`);
    }
    const active = await RenderJob.exists({ project: project._id, status: { $in: ["queued", "rendering_scenes", "generating_audio", "assembling", "validating", "retrying"] } });
    if (active) throw new AppError(409, "render_in_progress", "A render for this project is already running. Cancel it or wait for it to finish.");
    await deps.usage.assertCanRender(owner);

    const scenes = body.formats.flatMap((format) =>
      storyboard.scenes.map((s) => ({ sceneId: s.id, format, status: "pending", framesDone: 0, framesTotal: Math.round(s.durationSeconds * body.fps), attempts: 0 })),
    );
    const audio = hasNarration ? storyboard.scenes.map((s) => ({ sceneId: s.id, status: s.narration.trim() ? "pending" : "skipped" })) : [];
    const totalUnits = scenes.reduce((n, s) => n + s.framesTotal, 0);

    let job;
    try {
      job = await RenderJob.create({
        project: project._id,
        owner,
        settings: { ...body, narration: hasNarration },
        storyboardVersion: project.storyboardVersion,
        storyboardSnapshot: storyboard,
        scenes,
        audio,
        progress: { completedUnits: 0, totalUnits },
        idempotencyKey: body.idempotencyKey,
        logs: [{ at: new Date(), level: "info", message: `Render requested for ${body.formats.join(" and ")} at ${body.fps} fps (${body.quality}).` }],
        warnings: validation.warnings.map((w) => w.message),
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000 && body.idempotencyKey) {
        const existing = await RenderJob.findOne({ owner, idempotencyKey: body.idempotencyKey }).lean<RenderJobDoc>();
        if (existing) return res.status(200).json({ render: await renderDto(existing) });
      }
      throw err;
    }

    try {
      await deps.queue.enqueueRender(String(job._id), 0);
    } catch (err) {
      req.log.error({ err }, "enqueue failed");
      job.status = "failed";
      job.stage = "Could not reach the render queue";
      job.set("error", { message: "The render queue (Redis) is unavailable. Try again once it is running.", kind: "recoverable" });
      job.finishedAt = new Date();
      await job.save();
      throw new AppError(503, "queue_unavailable", "The render queue is unavailable. Check that Redis and the worker are running.");
    }
    await Project.updateOne({ _id: project._id }, { $set: { status: "rendering", latestRenderId: job._id } });
    await deps.usage.record({ owner, kind: "render", project: project._id, renderSeconds: storyboard.durationSeconds * body.formats.length });
    res.status(202).json({ render: await renderDto(job.toObject()) });
  });

  projectScoped.get("/renders", async (req, res) => {
    const project = await ownedProject(req);
    const jobs = await RenderJob.find({ project: project._id, owner: currentUserId(req) }).select("-storyboardSnapshot").sort({ createdAt: -1 }).limit(50).lean<RenderJobDoc[]>();
    res.json({ items: await Promise.all(jobs.map(renderDto)) });
  });

  renderScoped.get("/:renderId", async (req, res) => {
    const job = await ownedRender(req);
    res.json({ render: await renderDto(job.toObject()) });
  });

  renderScoped.post("/:renderId/cancel", async (req, res) => {
    const job = await ownedRender(req);
    const status = job.status as RenderJobStatus;
    if (isTerminal(status)) throw new AppError(409, "invalid_state", `This render is already ${status}.`);
    if (status === "queued" || status === "retrying") {
      const removed = await deps.queue.removeQueued(String(job._id), job.attempts).catch(() => false);
      if (removed || status === "retrying") {
        // The worker never picked it up (or is between attempts): cancel directly.
        const updated = await RenderJob.findOneAndUpdate(
          { _id: job._id, status },
          { $set: { status: "cancelled", stage: "Cancelled", cancelRequested: true, finishedAt: new Date() }, $push: { logs: { at: new Date(), level: "info", message: "Cancelled before rendering started." } } },
          { returnDocument: "after" },
        ).lean<RenderJobDoc>();
        if (updated) {
          await Project.updateOne({ _id: job.project }, { $set: { status: "awaiting_review" } });
          return res.json({ render: await renderDto(updated) });
        }
      }
    }
    // Running: the worker checks this flag between frames and stops.
    const updated = await RenderJob.findOneAndUpdate(
      { _id: job._id },
      { $set: { cancelRequested: true }, $push: { logs: { at: new Date(), level: "info", message: "Cancellation requested." } } },
      { returnDocument: "after" },
    ).lean<RenderJobDoc>();
    res.status(202).json({ render: await renderDto(updated!) });
  });

  renderScoped.post("/:renderId/retry", async (req, res) => {
    parse(retryRenderSchema, req.body ?? {});
    const job = await ownedRender(req);
    assertTransition(job.status as RenderJobStatus, "queued");
    const active = await RenderJob.exists({ project: job.project, _id: { $ne: job._id }, status: { $in: ["queued", "rendering_scenes", "generating_audio", "assembling", "validating", "retrying"] } });
    if (active) throw new AppError(409, "render_in_progress", "Another render for this project is running.");
    const attempt = job.attempts + 1;
    // Completed scenes keep their clips; only failed/unfinished ones render again.
    for (const s of job.scenes) {
      if (s.status !== "done" && s.status !== "cached") {
        s.status = "pending";
        s.framesDone = 0;
        s.error = undefined;
      }
    }
    for (const a of job.audio) if (a.status === "failed" || a.status === "pending") { a.status = "pending"; a.error = undefined; }
    job.status = "queued";
    job.stage = "Waiting for a worker";
    job.cancelRequested = false;
    job.set("error", undefined);
    job.attempts = attempt;
    job.finishedAt = undefined;
    job.logs.push({ at: new Date(), level: "info", message: `Retry ${attempt} requested; completed scenes will be reused.` });
    await job.save();
    await deps.queue.enqueueRender(String(job._id), attempt);
    await Project.updateOne({ _id: job.project }, { $set: { status: "rendering", latestRenderId: job._id } });
    res.status(202).json({ render: await renderDto(job.toObject()) });
  });

  return { projectScoped, renderScoped };
}
