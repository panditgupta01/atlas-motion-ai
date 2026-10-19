import { Router } from "express";
import { createProjectSchema, listProjectsQuerySchema, updateProjectSchema, type Paginated, type ProjectDto } from "@atlas/shared";
import { MediaAsset, Project, RenderJob, toAssetDto, toProjectDto, type MediaAssetDoc, type ProjectDoc } from "@atlas/server-core";
import type { AppDeps } from "../deps.js";
import { AppError, parse } from "../errors.js";
import { currentUserId, ownedProject } from "./ownership.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function projectRoutes(deps: AppDeps): Router {
  const r = Router();

  r.post("/", async (req, res) => {
    const body = parse(createProjectSchema, req.body);
    if (body.options.durationSeconds > deps.config.MAX_PROJECT_SECONDS) {
      throw new AppError(400, "duration_limit", `Videos can be at most ${deps.config.MAX_PROJECT_SECONDS} seconds on this server.`);
    }
    const title = body.title ?? body.prompt.split(/[.\n।]/)[0]!.slice(0, 80).trim();
    const project = await Project.create({ owner: currentUserId(req), title: title || "Untitled map story", prompt: body.prompt, options: body.options, status: "draft" });
    res.status(201).json({ project: toProjectDto(project.toObject() as ProjectDoc) });
  });

  r.get("/", async (req, res) => {
    const q = parse(listProjectsQuerySchema, req.query);
    const filter: Record<string, unknown> = { owner: currentUserId(req), deletedAt: null };
    if (q.q) filter.$or = [{ title: { $regex: escapeRegex(q.q), $options: "i" } }, { prompt: { $regex: escapeRegex(q.q), $options: "i" } }];
    const [items, total] = await Promise.all([
      Project.find(filter)
        .select("-storyboard")
        .sort({ [q.sort]: q.order === "asc" ? 1 : -1, _id: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean<ProjectDoc[]>(),
      Project.countDocuments(filter),
    ]);
    const body: Paginated<ProjectDto> = { items: items.map((p) => toProjectDto({ ...p, storyboard: p.storyboardVersion > 0 ? {} : null })), page: q.page, pageSize: q.pageSize, total };
    res.json(body);
  });

  r.get("/:projectId", async (req, res) => {
    const project = await ownedProject(req);
    res.json({ project: toProjectDto(project.toObject()) });
  });

  r.patch("/:projectId", async (req, res) => {
    const body = parse(updateProjectSchema, req.body);
    const project = await ownedProject(req);
    if (body.title) project.title = body.title;
    if (body.prompt) project.prompt = body.prompt;
    if (body.options) {
      const merged = { ...(project.toObject().options as object), ...body.options } as ProjectDoc["options"];
      if (merged.durationSeconds > deps.config.MAX_PROJECT_SECONDS) throw new AppError(400, "duration_limit", `Videos can be at most ${deps.config.MAX_PROJECT_SECONDS} seconds.`);
      project.set("options", merged);
    }
    await project.save();
    res.json({ project: toProjectDto(project.toObject()) });
  });

  /** Soft delete; renders in progress are cancelled. Stored files are removed by the cleanup job. */
  r.delete("/:projectId", async (req, res) => {
    const project = await ownedProject(req);
    project.deletedAt = new Date();
    await project.save();
    await RenderJob.updateMany({ project: project._id, status: { $in: ["queued", "rendering_scenes", "generating_audio", "assembling", "validating", "retrying"] } }, { $set: { cancelRequested: true } });
    res.status(204).end();
  });

  r.get("/:projectId/assets", async (req, res) => {
    const project = await ownedProject(req);
    const allowed: MediaAssetDoc["kind"][] = ["video", "subtitle", "image", "audio"];
    const kinds = typeof req.query.kind === "string" ? allowed.filter((k) => k === req.query.kind) : allowed;
    const assets = await MediaAsset.find({ owner: currentUserId(req), project: project._id, kind: { $in: kinds } })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean<MediaAssetDoc[]>();
    res.json({ items: assets.map(toAssetDto) });
  });

  return r;
}
