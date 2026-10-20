import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root: ATLAS_ROOT, else the nearest parent containing pnpm-workspace.yaml.
 * Works both from TypeScript sources and from bundled dist/ files.
 */
function findRepoRoot(from: string = here): string {
  if (process.env.ATLAS_ROOT) return path.resolve(process.env.ATLAS_ROOT);
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot();

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/atlasmotion"),
  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  SESSION_TTL_HOURS: z.coerce.number().min(1).max(24 * 30).default(72),
  COOKIE_SECURE: bool,
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  PUBLIC_WEB_URL: z.string().default("http://localhost:5173"),
  /** Optional: serve the built web app (apps/web/dist) from the API process on the same origin. */
  WEB_DIST_DIR: z.string().optional(),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default(path.join(REPO_ROOT, "storage")),
  WORK_DIR: z.string().default(path.join(REPO_ROOT, "storage", "tmp")),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  PLANNER_DEFAULT: z.enum(["auto", "anthropic", "gazetteer"]).default("auto"),
  TTS_DEFAULT: z.string().default("espeak-ng"),

  // Live Google Maps satellite preview in the editor only (Maps JavaScript API). A browser key is
  // visible to the browser by design: restrict it to your site's referrers and to the Maps JavaScript API.
  GOOGLE_MAPS_BROWSER_KEY: z.string().regex(/^[A-Za-z0-9_-]{20,80}$/, "must look like a Google API key").optional(),
  GOOGLE_MAPS_MAP_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),

  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  RENDER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  RENDER_JOB_TIMEOUT_MINUTES: z.coerce.number().min(1).max(240).default(60),
  MAX_PROJECT_SECONDS: z.coerce.number().int().min(10).max(180).default(180),
  USAGE_RENDERS_PER_DAY: z.coerce.number().int().min(0).default(20),
  USAGE_PLANS_PER_HOUR: z.coerce.number().int().min(0).default(30),
  TEMP_RETENTION_HOURS: z.coerce.number().min(1).default(24),
  STORAGE_QUOTA_MB_PER_USER: z.coerce.number().min(10).default(5000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type AppConfig = z.infer<typeof envSchema> & { corsOrigins: string[] };

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { reload?: boolean } = {}): AppConfig {
  if (cached && !opts.reload && env === process.env) return cached;
  if (env === process.env) dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const c = parsed.data;
  const issues: string[] = [];
  if (c.STORAGE_DRIVER === "s3") {
    for (const k of ["S3_BUCKET", "S3_REGION"] as const) if (!c[k]) issues.push(`${k} is required when STORAGE_DRIVER=s3`);
  }
  if (c.NODE_ENV === "production" && !c.COOKIE_SECURE) issues.push("COOKIE_SECURE must be true in production");
  if (c.NODE_ENV === "production" && /change-me|dev-only/i.test(c.JWT_SECRET)) issues.push("JWT_SECRET is still a placeholder");
  if (issues.length) throw new ConfigError(issues);
  const config = { ...c, corsOrigins: c.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) };
  if (env === process.env) cached = config;
  return config;
}
