import mongoose, { Schema, type Model, type Types } from "mongoose";
import { PROJECT_STATUSES, RENDER_JOB_STATUSES, SCENE_RENDER_STATUSES } from "@atlas/shared";


// Explicit document interfaces: mongoose's schema type inference is too heavy for the TypeScript compiler here.
export interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectOptionsDoc {
  language: "hi" | "en";
  durationSeconds: number;
  formats: string[];
  style: string;
  narration: boolean;
  subtitles: boolean;
  soundDesign: boolean;
  sourceUrls: string[];
}

export interface ProjectDoc {
  _id: Types.ObjectId;
  owner: Types.ObjectId;
  title: string;
  prompt: string;
  options: ProjectOptionsDoc;
  status: string;
  storyboard: unknown;
  storyboardVersion: number;
  thumbnailAssetId?: Types.ObjectId | null;
  latestRenderId?: Types.ObjectId | null;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SceneStateDoc {
  sceneId: string;
  format: "9:16" | "16:9";
  status: string;
  framesDone: number;
  framesTotal: number;
  attempts: number;
  error?: string | null;
  cacheKey?: string | null;
  clipAssetId?: Types.ObjectId | null;
}

export interface AudioStateDoc {
  sceneId: string;
  status: string;
  cacheKey?: string | null;
  assetId?: Types.ObjectId | null;
  durationSeconds?: number | null;
  error?: string | null;
}

export interface RenderLogDoc {
  at: Date;
  level: string;
  message: string;
}

export interface RenderJobDoc {
  _id: Types.ObjectId;
  project: Types.ObjectId;
  owner: Types.ObjectId;
  type: "render";
  status: string;
  stage: string;
  settings: unknown;
  storyboardVersion: number;
  storyboardSnapshot: unknown;
  scenes: SceneStateDoc[];
  audio: AudioStateDoc[];
  progress: { completedUnits: number; totalUnits: number };
  attempts: number;
  cancelRequested: boolean;
  error?: { message?: string | null; kind?: string | null; sceneId?: string | null } | null;
  logs: RenderLogDoc[];
  outputs: Types.ObjectId[];
  warnings: string[];
  idempotencyKey?: string | null;
  worker?: { id?: string; host?: string; pid?: number; heartbeatAt?: Date } | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MediaAssetDoc {
  _id: Types.ObjectId;
  owner: Types.ObjectId;
  project?: Types.ObjectId | null;
  renderJob?: Types.ObjectId | null;
  kind: "video" | "audio" | "subtitle" | "image" | "scene_clip";
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  filename: string;
  format?: string | null;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  fps?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  provider?: string | null;
  license?: string | null;
  attribution?: string | null;
  cacheKey?: string | null;
  expiresAt?: Date | null;
  createdAt: Date;
}

export interface UsageEventDoc {
  _id: Types.ObjectId;
  owner: Types.ObjectId;
  kind: "plan" | "regenerate_scene" | "render";
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  calls?: number;
  renderSeconds?: number;
  project?: Types.ObjectId;
  createdAt: Date;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDoc = any;

// ---------- User ----------
const userSchema = new Schema<AnyDoc>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
  },
  { timestamps: true },
);
userSchema.index({ email: 1 }, { unique: true });

// ---------- Project ----------
const projectSchema = new Schema<AnyDoc>(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: 140 },
    prompt: { type: String, required: true, maxlength: 4000 },
    options: {
      language: { type: String, enum: ["hi", "en"], required: true },
      durationSeconds: { type: Number, required: true },
      formats: { type: [String], required: true },
      style: { type: String, required: true },
      narration: { type: Boolean, required: true },
      subtitles: { type: Boolean, required: true },
      soundDesign: { type: Boolean, required: true },
      sourceUrls: { type: [String], default: [] },
    },
    status: { type: String, enum: PROJECT_STATUSES, default: "draft" },
    /** Current storyboard (validated against the shared schema before every write). */
    storyboard: { type: Schema.Types.Mixed, default: null },
    storyboardVersion: { type: Number, default: 0 },
    thumbnailAssetId: { type: Schema.Types.ObjectId, ref: "MediaAsset" },
    latestRenderId: { type: Schema.Types.ObjectId, ref: "RenderJob" },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);
projectSchema.index({ owner: 1, deletedAt: 1, updatedAt: -1 });
projectSchema.index({ owner: 1, deletedAt: 1, createdAt: -1 });
projectSchema.index({ owner: 1, title: 1 });

// ---------- RenderJob ----------
const sceneStateSchema = new Schema<AnyDoc>(
  {
    sceneId: { type: String, required: true },
    format: { type: String, enum: ["9:16", "16:9"], required: true },
    status: { type: String, enum: SCENE_RENDER_STATUSES, default: "pending" },
    framesDone: { type: Number, default: 0 },
    framesTotal: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    error: { type: String },
    cacheKey: { type: String },
    clipAssetId: { type: Schema.Types.ObjectId, ref: "MediaAsset" },
  },
  { _id: false },
);
const audioStateSchema = new Schema<AnyDoc>(
  {
    sceneId: { type: String, required: true },
    status: { type: String, enum: ["pending", "done", "cached", "failed", "skipped"], default: "pending" },
    cacheKey: { type: String },
    assetId: { type: Schema.Types.ObjectId, ref: "MediaAsset" },
    durationSeconds: { type: Number },
    error: { type: String },
  },
  { _id: false },
);
const renderJobSchema = new Schema<AnyDoc>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["render"], default: "render" },
    status: { type: String, enum: RENDER_JOB_STATUSES, default: "queued" },
    stage: { type: String, default: "Waiting for a worker" },
    settings: { type: Schema.Types.Mixed, required: true },
    storyboardVersion: { type: Number, required: true },
    /** Exact storyboard the user approved; renders never read the live, editable copy. */
    storyboardSnapshot: { type: Schema.Types.Mixed, required: true },
    scenes: { type: [sceneStateSchema], default: [] },
    audio: { type: [audioStateSchema], default: [] },
    progress: {
      completedUnits: { type: Number, default: 0 },
      totalUnits: { type: Number, default: 0 },
    },
    attempts: { type: Number, default: 0 },
    cancelRequested: { type: Boolean, default: false },
    error: { message: String, kind: String, sceneId: String },
    logs: { type: [{ at: Date, level: String, message: String, _id: false }], default: [] },
    outputs: { type: [{ type: Schema.Types.ObjectId, ref: "MediaAsset" }], default: [] },
    warnings: { type: [String], default: [] },
    idempotencyKey: { type: String },
    worker: { id: String, host: String, pid: Number, heartbeatAt: Date },
    startedAt: Date,
    finishedAt: Date,
  },
  { timestamps: true, minimize: false },
);
renderJobSchema.index({ project: 1, createdAt: -1 });
renderJobSchema.index({ owner: 1, createdAt: -1 });
renderJobSchema.index({ status: 1, "worker.heartbeatAt": 1 });
renderJobSchema.index({ owner: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });

// ---------- MediaAsset ----------
const mediaAssetSchema = new Schema<AnyDoc>(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    project: { type: Schema.Types.ObjectId, ref: "Project" },
    renderJob: { type: Schema.Types.ObjectId, ref: "RenderJob" },
    kind: { type: String, enum: ["video", "audio", "subtitle", "image", "scene_clip"], required: true },
    storageKey: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    filename: { type: String, required: true, maxlength: 200 },
    format: { type: String, enum: ["9:16", "16:9"] },
    width: Number,
    height: Number,
    durationSeconds: Number,
    fps: Number,
    videoCodec: String,
    audioCodec: String,
    provider: String,
    license: String,
    attribution: String,
    /** Stable input hash for reusable intermediate assets (scene clips, narration). */
    cacheKey: String,
    /** Intermediate assets may be garbage-collected after this date. */
    expiresAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
mediaAssetSchema.index({ owner: 1, project: 1, createdAt: -1 });
mediaAssetSchema.index({ owner: 1, kind: 1, cacheKey: 1 });
mediaAssetSchema.index({ storageKey: 1 }, { unique: true });
mediaAssetSchema.index({ expiresAt: 1 });

// ---------- UsageEvent ----------
const usageEventSchema = new Schema<AnyDoc>(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: ["plan", "regenerate_scene", "render"], required: true },
    provider: String,
    model: String,
    inputTokens: Number,
    outputTokens: Number,
    calls: Number,
    renderSeconds: Number,
    project: { type: Schema.Types.ObjectId, ref: "Project" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
usageEventSchema.index({ owner: 1, kind: 1, createdAt: -1 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function model<T>(name: string, schema: Schema<any>): Model<T> {
  // Cast through unknown: comparing mongoose Model generics structurally is extremely slow for the compiler.
  return (mongoose.models[name] ?? mongoose.model(name, schema)) as unknown as Model<T>;
}

export const User = model<UserDoc>("User", userSchema);
export const Project = model<ProjectDoc>("Project", projectSchema);
export const RenderJob = model<RenderJobDoc>("RenderJob", renderJobSchema);
export const MediaAsset = model<MediaAssetDoc>("MediaAsset", mediaAssetSchema);
export const UsageEvent = model<UsageEventDoc>("UsageEvent", usageEventSchema);

export async function connectDatabase(uri: string): Promise<typeof mongoose> {
  mongoose.set("strictQuery", true);
  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User.syncIndexes(), Project.syncIndexes(), RenderJob.syncIndexes(), MediaAsset.syncIndexes(), UsageEvent.syncIndexes()]);
  return conn;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
