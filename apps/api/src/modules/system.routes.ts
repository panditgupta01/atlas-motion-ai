import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { checkGeoData } from "@atlas/geo";
import { isDatabaseConnected } from "@atlas/server-core";
import type { HealthDto, ProviderStatusDto } from "@atlas/shared";
import { FFMPEG_BIN, fontsDir, MapSceneRenderer } from "@atlas/video-engine";
import type { AppDeps } from "../deps.js";
import { openApiDocument } from "../openapi.js";

let ffmpegCheck: { ok: boolean; detail?: string } | null = null;
function checkFfmpeg() {
  if (!ffmpegCheck) {
    const r = spawnSync(FFMPEG_BIN, ["-hide_banner", "-version"], { encoding: "utf8" });
    ffmpegCheck = r.status === 0 ? { ok: true, detail: r.stdout.split("\n")[0] } : { ok: false, detail: "ffmpeg not found on PATH" };
  }
  return ffmpegCheck;
}

export function systemRoutes(deps: AppDeps): Router {
  const r = Router();

  r.get("/health", async (_req, res) => {
    const geo = checkGeoData();
    const fonts = ["NotoSans.ttf", "NotoSansDevanagari.ttf"].every((f) => fs.existsSync(path.join(fontsDir(), f)));
    const [redis, storage] = await Promise.all([deps.queue.ping().catch(() => false), deps.storage.check()]);
    const dbOk = isDatabaseConnected();
    const checks: HealthDto["checks"] = {
      database: { ok: dbOk },
      queue: { ok: redis, detail: redis ? undefined : "Redis unreachable" },
      storage,
      ffmpeg: checkFfmpeg(),
      geoData: { ok: geo.ok, detail: geo.ok ? undefined : `missing: ${geo.missing.join(", ")}` },
      fonts: { ok: fonts, detail: fonts ? undefined : "run scripts/fetch-assets.sh" },
    };
    const ok = Object.values(checks).every((c) => c.ok);
    const body: HealthDto = { status: ok ? "ok" : "degraded", checks, version: "0.1.0" };
    res.status(dbOk ? 200 : 503).json(body);
  });

  /** Which providers are configured. Never returns secrets. */
  r.get("/providers", (_req, res) => {
    const defaultPlanner = deps.planners.defaultId();
    const items: ProviderStatusDto[] = [
      ...deps.planners.providers.map((p) => ({
        kind: "planner" as const,
        id: p.id,
        label: p.label,
        configured: p.isConfigured(),
        isDefault: p.id === defaultPlanner,
        notes: p.id === "anthropic" ? (p.isConfigured() ? `Model ${deps.config.ANTHROPIC_MODEL}.` : "Set ANTHROPIC_API_KEY to enable AI-written storyboards.") : "Places come from the Natural Earth gazetteer; narration is placeholder text you edit.",
      })),
      ...deps.tts.providers.map((p, i) => ({
        kind: "tts" as const,
        id: p.id,
        label: p.label,
        configured: p.isConfigured(),
        isDefault: i === 0,
        languages: p.languages,
        notes: p.isConfigured() ? "Synthetic voice generated on the worker." : "Install espeak-ng on the worker host.",
      })),
      { kind: "renderer", id: "map2d", label: new MapSceneRenderer().getCapabilities().label, configured: true, isDefault: true, notes: "2D animated maps. No 3D terrain renderer is implemented." },
      { kind: "ambience", id: "procedural", label: "Generated ambience bed (FFmpeg noise + drone)", configured: true, isDefault: true, notes: "No third-party music is bundled." },
      { kind: "storage", id: deps.storage.id, label: deps.storage.id === "s3" ? "S3-compatible object storage" : "Local filesystem (development)", configured: true, isDefault: true, notes: deps.storage.id === "local" ? "Not suitable for multi-host production." : "" },
    ];
    res.json({ items });
  });

  r.get("/docs/openapi.json", (_req, res) => res.json(openApiDocument));

  return r;
}
