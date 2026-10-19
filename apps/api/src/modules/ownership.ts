import mongoose from "mongoose";
import type { Request } from "express";
import { MediaAsset, Project, RenderJob, type MediaAssetDoc, type ProjectDoc, type RenderJobDoc } from "@atlas/server-core";
import { AppError, notFound } from "../errors.js";

export function objectId(id: string | undefined, what: string): mongoose.Types.ObjectId {
  if (!id || !mongoose.isValidObjectId(id)) throw notFound(what);
  return new mongoose.Types.ObjectId(id);
}

export function currentUserId(req: Request): mongoose.Types.ObjectId {
  if (!req.user) throw new AppError(401, "unauthenticated", "Please sign in.");
  return req.user._id;
}

/** Load a project owned by the current user. Other users' projects look like 404s, not 403s, to avoid leaking ids. */
export async function ownedProject(req: Request, id = req.params.projectId as string | undefined) {
  const project = await Project.findOne({ _id: objectId(id, "Project"), owner: currentUserId(req), deletedAt: null });
  if (!project) throw notFound("Project");
  return project as mongoose.HydratedDocument<ProjectDoc>;
}

export async function ownedRender(req: Request, id = req.params.renderId as string | undefined) {
  const job = await RenderJob.findOne({ _id: objectId(id, "Render"), owner: currentUserId(req) });
  if (!job) throw notFound("Render");
  return job as mongoose.HydratedDocument<RenderJobDoc>;
}

export async function ownedAsset(req: Request, id = req.params.assetId as string | undefined) {
  const asset = await MediaAsset.findOne({ _id: objectId(id, "Asset"), owner: currentUserId(req) }).lean<MediaAssetDoc>();
  if (!asset) throw notFound("Asset");
  return asset;
}
