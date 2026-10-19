import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  generateStoryboardSchema,
  parseStoryboard,
  regenerateSceneSchema,
  updateStoryboardSchema,
  validateStoryboard,
  type Storyboard,
  type StoryboardDto,
} from "@atlas/shared";
import { planStoryboard, regenerateScene, type PlannerInput } from "@atlas/storyboard";
import { stableStringify } from "@atlas/video-engine";
import type { HydratedDocument } from "mongoose";
import type { ProjectDoc } from "@atlas/server-core";
import type { AppDeps } from "../deps.js";
import { AppError, parse } from "../errors.js";
import { currentUserId, ownedProject } from "./ownership.js";

export function plannerInputFor(project: ProjectDoc): PlannerInput {
  const o = project.options;
  return {
    prompt: project.prompt,
    title: project.title,
    language: o.language as PlannerInput["language"],
    durationSeconds: o.durationSeconds,
    formats: o.formats as PlannerInput["formats"],
    style: o.style as PlannerInput["style"],
    narration: o.narration,
    sourceUrls: o.sourceUrls ?? [],
  };
}

function storyboardDto(project: HydratedDocument<ProjectDoc>): StoryboardDto {
  const parsed = parseStoryboard(project.storyboard);
  if (!parsed.success) throw new AppError(500, "corrupt_storyboard", "The saved storyboard no longer matches the schema.");
  return { projectId: String(project._id), version: project.storyboardVersion, storyboard: parsed.data, validation: validateStoryboard(parsed.data), updatedAt: project.updatedAt.toISOString() };
}

/**
 * Mark scenes whose content changed as edited and bump their revision, so the
 * render cache and the editor can tell which scenes differ from the plan.
 */
export function applySceneEdits(previous: Storyboard | null, next: Storyboard): Storyboard {
  const before = new Map((previous?.scenes ?? []).map((s) => [s.id, s]));
  return {
    ...next,
    scenes: next.scenes.map((s) => {
      const old = before.get(s.id);
      if (!old) return { ...s, status: "edited", revision: 0 };
      const strip = (x: typeof s) => stableStringify({ ...x, status: undefined, revision: undefined });
      if (strip(old) === strip(s)) return { ...s, revision: old.revision };
      return { ...s, status: s.status === "approved" ? "approved" : "edited", revision: old.revision + 1 };
    }),
  };
}

export function storyboardRoutes(deps: AppDeps): Router {
  const r = Router({ mergeParams: true });
  const planLimiter = rateLimit({
    windowMs: 60_000,
    limit: deps.config.NODE_ENV === "test" ? 1000 : 10,
    keyGenerator: (req) => String(req.user?._id ?? req.ip),
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });

  r.post("/storyboard", planLimiter, async (req, res) => {
    const body = parse(generateStoryboardSchema, req.body ?? {});
    const project = await ownedProject(req);
    const planner = deps.planners.get(body.provider);
    await deps.usage.assertCanPlan(currentUserId(req));
    const previousStatus = project.status;
    project.status = "planning";
    await project.save();
    try {
      const result = await planStoryboard(planner, plannerInputFor(project.toObject()));
      project.set("storyboard", result.storyboard);
      project.storyboardVersion += 1;
      project.status = "awaiting_review";
      await project.save();
      await deps.usage.record({ owner: currentUserId(req), kind: "plan", project: project._id, ...result.usage });
      await deps.queue.enqueueThumbnail(String(project._id), project.storyboardVersion).catch((err) => req.log.warn({ err }, "thumbnail enqueue failed"));
      res.status(201).json({ ...storyboardDto(project), usage: result.usage, attempts: result.attempts });
    } catch (err) {
      project.status = previousStatus === "planning" ? "draft" : previousStatus;
      await project.save();
      throw err;
    }
  });

  r.get("/storyboard", async (req, res) => {
    const project = await ownedProject(req);
    if (!project.storyboard) throw new AppError(404, "no_storyboard", "This project has no storyboard yet.");
    res.json(storyboardDto(project));
  });

  r.patch("/storyboard", async (req, res) => {
    const body = parse(updateStoryboardSchema, req.body);
    const project = await ownedProject(req);
    if (!project.storyboard) throw new AppError(404, "no_storyboard", "Generate a storyboard first.");
    if (body.baseVersion !== project.storyboardVersion) {
      throw new AppError(409, "version_conflict", "The storyboard changed since you loaded it. Reload to see the latest version.", { currentVersion: project.storyboardVersion });
    }
    const previous = parseStoryboard(project.storyboard);
    const next = applySceneEdits(previous.success ? previous.data : null, body.storyboard);
    if (next.durationSeconds > deps.config.MAX_PROJECT_SECONDS) throw new AppError(400, "duration_limit", `Videos can be at most ${deps.config.MAX_PROJECT_SECONDS} seconds.`);
    // Conditional update guards against two concurrent saves of the same version.
    const updated = await project.collection.findOneAndUpdate(
      { _id: project._id, storyboardVersion: body.baseVersion },
      { $set: { storyboard: next, status: "awaiting_review", updatedAt: new Date() }, $inc: { storyboardVersion: 1 } },
      { returnDocument: "after" },
    );
    if (!updated) throw new AppError(409, "version_conflict", "The storyboard changed since you loaded it. Reload to see the latest version.");
    const fresh = await ownedProject(req);
    await deps.queue.enqueueThumbnail(String(fresh._id), fresh.storyboardVersion).catch(() => undefined);
    res.json(storyboardDto(fresh));
  });

  r.post("/scenes/:sceneId/regenerate", planLimiter, async (req, res) => {
    const body = parse(regenerateSceneSchema, req.body);
    const project = await ownedProject(req);
    const current = parseStoryboard(project.storyboard);
    if (!current.success) throw new AppError(404, "no_storyboard", "Generate a storyboard first.");
    if (body.baseVersion !== project.storyboardVersion) throw new AppError(409, "version_conflict", "The storyboard changed since you loaded it.");
    const sceneId = String(req.params.sceneId);
    if (!current.data.scenes.some((s) => s.id === sceneId)) throw new AppError(404, "not_found", "Scene not found.");
    await deps.usage.assertCanPlan(currentUserId(req));
    const result = await regenerateScene(deps.planners.get(body.provider), plannerInputFor(project.toObject()), current.data, sceneId, body.instructions);
    const updated = await project.collection.findOneAndUpdate(
      { _id: project._id, storyboardVersion: body.baseVersion },
      { $set: { storyboard: result.storyboard, status: "awaiting_review", updatedAt: new Date() }, $inc: { storyboardVersion: 1 } },
      { returnDocument: "after" },
    );
    if (!updated) throw new AppError(409, "version_conflict", "The storyboard changed while the scene was regenerating. Reload and try again.");
    await deps.usage.record({ owner: currentUserId(req), kind: "regenerate_scene", project: project._id, ...result.usage });
    const fresh = await ownedProject(req);
    res.json({ ...storyboardDto(fresh), usage: result.usage });
  });

  return r;
}
