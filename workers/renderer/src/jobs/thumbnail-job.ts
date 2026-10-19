import fs from "node:fs";
import path from "node:path";
import type { Job } from "bullmq";
import { FORMAT_LAYOUTS, parseStoryboard } from "@atlas/shared";
import { MediaAsset, Project, newObjectKey, type MediaAssetDoc, type ProjectDoc } from "@atlas/server-core";
import { MapFrameRenderer, cameraAt } from "@atlas/video-engine";
import type { WorkerContext } from "./render-job.js";

/** Render a still of the first scene from the real map renderer for the dashboard card. */
export async function processThumbnailJob(ctx: WorkerContext, job: Job<{ projectId: string; storyboardVersion: number }>) {
  const project = await Project.findById(job.data.projectId).lean<ProjectDoc>();
  if (!project || project.deletedAt || project.storyboardVersion !== job.data.storyboardVersion) return { skipped: "stale" };
  const parsed = parseStoryboard(project.storyboard);
  if (!parsed.success) return { skipped: "no storyboard" };
  const sb = parsed.data;
  const scene = sb.scenes.find((s) => s.overlays.some((o) => o.type === "highlight_country" || o.type === "river")) ?? sb.scenes[0]!;
  const index = sb.scenes.indexOf(scene);
  const layout = FORMAT_LAYOUTS["16:9"];
  const renderer = new MapFrameRenderer({ width: 640, height: 360 });
  const t = 0.85;
  const camera = cameraAt(scene, sb.scenes[index - 1], t, layout);
  renderer.beginScene([camera]);
  const canvas = renderer.render({ scene, camera, t, seconds: t * scene.durationSeconds, layout, fade: 1 });
  const file = path.join(ctx.config.WORK_DIR, "thumbs", `${project._id}-${job.data.storyboardVersion}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, canvas.toBuffer("image/png"));
  const key = newObjectKey({ userId: String(project.owner), projectId: String(project._id), folder: "thumbs", ext: "png" });
  const stored = await ctx.storage.putFile(key, file, "image/png");
  fs.rmSync(file, { force: true });
  const asset = await MediaAsset.create({ owner: project.owner, project: project._id, kind: "image", storageKey: key, mimeType: "image/png", sizeBytes: stored.sizeBytes, filename: "thumbnail.png", width: 640, height: 360, provider: "map2d" });
  const res = await Project.findOneAndUpdate({ _id: project._id, storyboardVersion: job.data.storyboardVersion }, { $set: { thumbnailAssetId: asset._id } }, { returnDocument: "before", timestamps: false }).lean<ProjectDoc>();
  // Remove the previous thumbnail.
  if (res?.thumbnailAssetId) {
    const old = await MediaAsset.findByIdAndDelete(res.thumbnailAssetId).lean<MediaAssetDoc>();
    if (old) await ctx.storage.delete(old.storageKey).catch(() => undefined);
  }
  return { assetId: String(asset._id) };
}
