import { Router } from "express";
import type { AppDeps } from "../deps.js";
import { AppError } from "../errors.js";
import { ownedAsset } from "./ownership.js";

function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 150) || "download";
}

export function assetRoutes(deps: AppDeps): Router {
  const r = Router();

  /**
   * Authorised download: requires a session and ownership. Local storage is
   * streamed (with range support for in-browser preview); S3 redirects to a
   * short-lived signed URL. Storage keys and paths are never exposed.
   */
  r.get("/:assetId/download", async (req, res) => {
    const asset = await ownedAsset(req);
    if (asset.kind === "scene_clip") throw new AppError(404, "not_found", "Asset not found.");
    const target = await deps.storage.download(asset.storageKey, asset.filename, asset.mimeType).catch(() => {
      throw new AppError(410, "asset_missing", "This file is no longer available in storage.");
    });
    const inline = req.query.inline === "1";
    if (target.redirectUrl) return res.redirect(302, target.redirectUrl);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type(asset.mimeType);
    if (inline) {
      res.setHeader("Content-Disposition", `inline; filename="${safeFilename(asset.filename)}"`);
      return res.sendFile(target.filePath!, { dotfiles: "deny" });
    }
    return res.download(target.filePath!, safeFilename(asset.filename), { dotfiles: "deny" });
  });

  return r;
}
