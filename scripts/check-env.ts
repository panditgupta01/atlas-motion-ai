/**
 * Check that this machine can run AtlasMotion: configuration, MongoDB, Redis,
 * FFmpeg (with libx264 and libass), espeak-ng, map data and fonts.
 *
 *   pnpm check:env
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import mongoose from "mongoose";
import { Redis } from "ioredis";
import { ConfigError, loadConfig } from "@atlas/server-core";
import { checkGeoData } from "@atlas/geo";
import { EspeakTtsProvider, fontsDir } from "@atlas/video-engine";

type Result = { name: string; ok: boolean; detail: string; required: boolean };
const results: Result[] = [];
const add = (name: string, ok: boolean, detail: string, required = true) => results.push({ name, ok, detail, required });

let config;
try {
  config = loadConfig();
  add("Configuration (.env)", true, `NODE_ENV=${config.NODE_ENV}, storage=${config.STORAGE_DRIVER}`);
} catch (err) {
  add("Configuration (.env)", false, err instanceof ConfigError ? err.issues.join("; ") : String(err));
}

const ffmpeg = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-buildconf"], { encoding: "utf8" });
if (ffmpeg.status !== 0) add("FFmpeg", false, "ffmpeg not found on PATH (set FFMPEG_PATH)");
else {
  const conf = ffmpeg.stdout + ffmpeg.stderr;
  const missing = ["libx264", "libass"].filter((lib) => !conf.includes(`--enable-${lib}`));
  add("FFmpeg", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : "libx264 and libass available");
}
const ffprobe = spawnSync(process.env.FFPROBE_PATH || "ffprobe", ["-version"], { encoding: "utf8" });
add("ffprobe", ffprobe.status === 0, ffprobe.status === 0 ? "found" : "not found (set FFPROBE_PATH)");

const espeak = new EspeakTtsProvider();
add("espeak-ng (narration)", espeak.isConfigured(), espeak.isConfigured() ? "found; Hindi and English voices" : "not found: renders work, but narration must be off", false);

const geo = checkGeoData();
add("Natural Earth data", geo.ok, geo.ok ? "all datasets present" : `missing ${geo.missing.join(", ")}; run scripts/fetch-assets.sh`);
const fonts = ["NotoSans.ttf", "NotoSansDevanagari.ttf"].filter((f) => !fs.existsSync(path.join(fontsDir(), f)));
add("Fonts", fonts.length === 0, fonts.length ? `missing ${fonts.join(", ")}; run scripts/fetch-assets.sh` : "Noto Sans + Devanagari present");

if (config) {
  try {
    const conn = await mongoose.createConnection(config.MONGODB_URI, { serverSelectionTimeoutMS: 2000 }).asPromise();
    await conn.close();
    add("MongoDB", true, "reachable");
  } catch (err) {
    add("MongoDB", false, `cannot connect: ${(err as Error).message}`);
  }
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 2000 });
  try {
    await redis.connect();
    await redis.ping();
    add("Redis", true, "reachable");
  } catch (err) {
    add("Redis", false, `cannot connect: ${(err as Error).message}`);
  } finally {
    redis.disconnect();
  }
  add("Claude planner", Boolean(config.ANTHROPIC_API_KEY), config.ANTHROPIC_API_KEY ? `ANTHROPIC_API_KEY set (model ${config.ANTHROPIC_MODEL})` : "not configured; the offline gazetteer planner will be used", false);
}

for (const r of results) console.log(`${r.ok ? "✓" : r.required ? "✗" : "!"} ${r.name.padEnd(24)} ${r.detail}`);
const failed = results.filter((r) => !r.ok && r.required);
console.log(failed.length ? `\n${failed.length} required check(s) failed.` : "\nAll required checks passed.");
process.exit(failed.length ? 1 : 0);
