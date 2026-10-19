import { z } from "zod";
import { aspectFormatSchema, languageSchema, storyboardSchema, visualStyleSchema, MAX_PROJECT_SECONDS } from "./storyboard.js";
import { qualitySchema, type Quality } from "./formats.js";
import type { ProjectStatus, RenderJobStatus, SceneRenderStatus } from "./jobs.js";
import type { StoryboardValidationResult } from "./validation.js";
import type { AspectFormat, Language, Storyboard, VisualStyle } from "./storyboard.js";

// ---------- Auth ----------
export const registerSchema = z.object({
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  password: z.string().min(10, "Use at least 10 characters").max(200),
});
export const loginSchema = z.object({
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(200),
});

// ---------- Projects ----------
export const projectOptionsSchema = z.object({
  language: languageSchema.default("en"),
  durationSeconds: z.number().int().min(10).max(MAX_PROJECT_SECONDS).default(60),
  formats: z.array(aspectFormatSchema).min(1).max(2).default(["9:16", "16:9"]),
  style: visualStyleSchema.default("documentary"),
  narration: z.boolean().default(true),
  subtitles: z.boolean().default(true),
  soundDesign: z.boolean().default(false),
  sourceUrls: z.array(z.url({ protocol: /^https?$/ }).max(2000)).max(20).default([]),
});
export type ProjectOptions = z.infer<typeof projectOptionsSchema>;

export const createProjectSchema = z.object({
  prompt: z.string().trim().min(10, "Describe the video in at least 10 characters").max(4000),
  title: z.string().trim().min(1).max(140).optional(),
  options: projectOptionsSchema.default(projectOptionsSchema.parse({})),
});
export type CreateProjectRequest = z.input<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    title: z.string().trim().min(1).max(140).optional(),
    prompt: z.string().trim().min(10).max(4000).optional(),
    options: projectOptionsSchema.partial().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const listProjectsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["updatedAt", "createdAt", "title"]).default("updatedAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

// ---------- Storyboard ----------
export const generateStoryboardSchema = z.object({
  /** Planner provider id; omitted = server default. */
  provider: z.string().max(40).optional(),
});

export const updateStoryboardSchema = z.object({
  storyboard: storyboardSchema,
  /** Optimistic concurrency: the version the client edited. */
  baseVersion: z.number().int().min(1),
});

export const regenerateSceneSchema = z.object({
  instructions: z.string().trim().max(1000).optional(),
  provider: z.string().max(40).optional(),
  baseVersion: z.number().int().min(1),
});

// ---------- Renders ----------
export const subtitleModeSchema = z.enum(["burned", "sidecar", "none"]);
export const createRenderSchema = z.object({
  formats: z.array(aspectFormatSchema).min(1).max(2),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30)]).default(30),
  quality: qualitySchema.default("standard"),
  subtitles: subtitleModeSchema.default("burned"),
  narration: z.boolean().default(true),
  ambience: z.boolean().default(false),
  /** The storyboard version the user reviewed; the render uses exactly this snapshot. */
  storyboardVersion: z.number().int().min(1),
  /** Client-generated key so double-clicks do not enqueue duplicate renders. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
});
export type CreateRenderRequest = z.input<typeof createRenderSchema>;
export type RenderSettings = z.infer<typeof createRenderSchema>;

export const retryRenderSchema = z.object({
  /** Only failed scenes are re-rendered; completed scenes are reused from cache. */
  mode: z.enum(["failed_only"]).default("failed_only"),
});

// ---------- DTOs ----------
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface UserDto {
  id: string;
  email: string;
  role: "user" | "admin";
  createdAt: string;
}

export interface ProjectDto {
  id: string;
  title: string;
  prompt: string;
  options: ProjectOptions;
  status: ProjectStatus;
  storyboardVersion: number;
  hasStoryboard: boolean;
  thumbnailAssetId?: string;
  latestRenderId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardDto {
  projectId: string;
  version: number;
  storyboard: Storyboard;
  validation: StoryboardValidationResult;
  updatedAt: string;
}

export interface SceneRenderStateDto {
  sceneId: string;
  format: AspectFormat;
  status: SceneRenderStatus;
  framesDone: number;
  framesTotal: number;
  attempts: number;
  error?: string;
  cacheKey?: string;
}

export interface RenderLogEntry {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface MediaAssetDto {
  id: string;
  kind: "video" | "audio" | "subtitle" | "image" | "scene_clip";
  mimeType: string;
  sizeBytes: number;
  format?: AspectFormat;
  width?: number;
  height?: number;
  durationSeconds?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  provider?: string;
  license?: string;
  filename: string;
  createdAt: string;
  downloadUrl: string;
}

export interface RenderJobDto {
  id: string;
  projectId: string;
  status: RenderJobStatus;
  stage: string;
  settings: RenderSettings;
  storyboardVersion: number;
  scenes: SceneRenderStateDto[];
  progress: { completedUnits: number; totalUnits: number; fraction: number };
  attempts: number;
  cancelRequested: boolean;
  error?: { message: string; kind: string; sceneId?: string };
  logs: RenderLogEntry[];
  outputs: MediaAssetDto[];
  warnings: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ProviderStatusDto {
  kind: "planner" | "tts" | "renderer" | "storage" | "ambience";
  id: string;
  label: string;
  configured: boolean;
  isDefault: boolean;
  languages?: Language[];
  notes: string;
}

export interface HealthDto {
  status: "ok" | "degraded";
  checks: Record<string, { ok: boolean; detail?: string }>;
  version: string;
}

export interface GazetteerHit {
  id: string;
  kind: "country" | "place" | "river" | "lake";
  name: string;
  nameHi?: string;
  latitude: number;
  longitude: number;
  iso3?: string;
  country?: string;
  bbox?: [number, number, number, number];
}

export type { Quality, Language, VisualStyle };
