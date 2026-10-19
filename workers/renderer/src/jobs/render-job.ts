import fs from "node:fs";
import path from "node:path";
import { UnrecoverableError, type Job } from "bullmq";
import {
  frameSizeFor,
  parseStoryboard,
  type AspectFormat,
  type RenderJobStatus,
  type RenderSettings,
  type Storyboard,
} from "@atlas/shared";
import {
  MediaAsset,
  Project,
  RenderJob,
  newObjectKey,
  type AppConfig,
  type Logger,
  type MediaAssetDoc,
  type RenderJobDoc,
  type StorageDriver,
} from "@atlas/server-core";
import {
  CancelledError,
  SceneInputError,
  TtsError,
  assembleVideo,
  narrationCacheKey,
  sceneCacheKey,
  validateVideoFile,
  type AudioSegment,
  type NarrationTiming,
  type SceneRenderer,
  type TtsRegistry,
} from "@atlas/video-engine";
import { NATURAL_EARTH_ATTRIBUTION } from "@atlas/geo";
import type { Types } from "mongoose";
import { JobState } from "./job-state.js";

export interface WorkerContext {
  config: AppConfig;
  storage: StorageDriver;
  tts: TtsRegistry;
  renderer: SceneRenderer;
  logger: Logger;
  workerId: string;
}

/** A failure that retrying cannot fix (bad input, missing provider, invalid output). */
export class PermanentRenderError extends Error {
  constructor(message: string, public readonly sceneId?: string) {
    super(message);
    this.name = "PermanentRenderError";
  }
}

const ACTIVE_RESUMABLE: RenderJobStatus[] = ["rendering_scenes", "generating_audio", "assembling", "validating"];
const CLIP_RETENTION_DAYS = 14;

async function storedAssetUsable(storage: StorageDriver, asset: MediaAssetDoc | null): Promise<boolean> {
  return Boolean(asset && (await storage.exists(asset.storageKey).catch(() => false)));
}

export async function processRenderJob(ctx: WorkerContext, bullJob: Job<{ renderJobId: string }>): Promise<{ outputs: string[] } | { cancelled: true } | { skipped: string }> {
  const { renderJobId } = bullJob.data;
  const loaded = await JobState.load(renderJobId, ctx.workerId);
  if (!loaded) return { skipped: "render job no longer exists" };
  const { state } = loaded;
  let doc = loaded.doc;
  const log = ctx.logger.child({ renderJobId });

  if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
    return { skipped: `render job already ${state.status}` };
  }
  if (doc.cancelRequested) {
    await markCancelled(state, doc);
    return { cancelled: true };
  }

  const abort = new AbortController();
  const heartbeat = setInterval(() => {
    state.heartbeat().catch(() => undefined);
    state
      .isCancelRequested()
      .then((c) => c && abort.abort())
      .catch(() => undefined);
  }, 1000);
  const workDir = path.join(ctx.config.WORK_DIR, "jobs", renderJobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // A job found mid-flight was interrupted (worker crash or restart): resume through "retrying".
    if (ACTIVE_RESUMABLE.includes(state.status)) {
      await state.moveTo("retrying", "Resuming after an interrupted attempt");
    }
    await state.moveTo("rendering_scenes", "Rendering map scenes", {
      startedAt: doc.startedAt ?? new Date(),
      attempts: Math.max(doc.attempts, 0),
      error: null,
    });
    await state.heartbeat();

    const parsed = parseStoryboard(doc.storyboardSnapshot);
    if (!parsed.success) throw new PermanentRenderError("The saved storyboard snapshot is invalid and cannot be rendered.");
    const storyboard = parsed.data;
    const settings = doc.settings as RenderSettings;
    const owner = doc.owner as Types.ObjectId;
    const projectId = doc.project as Types.ObjectId;

    // ---------- Scenes ----------
    const clipKeys = await renderScenes(ctx, state, doc, storyboard, settings, owner, projectId, workDir, abort.signal);

    // ---------- Narration ----------
    doc = (await RenderJob.findById(renderJobId).lean<RenderJobDoc>())!;
    const narration = settings.narration ? await generateNarration(ctx, state, doc, storyboard, owner, projectId, workDir, abort.signal) : new Map<string, { file: string; duration: number }>();

    // ---------- Assembly + validation, per format ----------
    await state.moveTo("assembling", "Assembling final videos");
    const assembled: { format: AspectFormat; file: string; srt?: string }[] = [];
    let start = 0;
    const timings: NarrationTiming[] = storyboard.scenes.map((s) => {
      const t = { sceneStart: start, sceneDuration: s.durationSeconds, text: settings.subtitles === "none" ? "" : s.narration, audioDuration: narration.get(s.id)?.duration };
      start += s.durationSeconds;
      return t;
    });
    const audio: AudioSegment[] = storyboard.scenes.map((s) => ({ file: narration.get(s.id)?.file ?? null, durationSeconds: s.durationSeconds }));
    for (const format of settings.formats) {
      const clips: string[] = [];
      for (const scene of storyboard.scenes) {
        const key = clipKeys.get(`${format}|${scene.id}`);
        if (!key) throw new Error(`Missing clip for ${scene.id} (${format}).`);
        clips.push(await ctx.storage.materialize(key, workDir));
      }
      const out = path.join(workDir, `final-${format.replace(":", "x")}.mp4`);
      const res = await assembleVideo({
        format,
        quality: settings.quality,
        language: storyboard.language,
        clips,
        audio,
        narrationTimings: timings,
        ambience: settings.ambience,
        subtitles: settings.subtitles,
        title: storyboard.projectTitle,
        workDir,
        output: out,
        signal: abort.signal,
        onStage: (stage) => void state.setStage(`Assembling ${format}: ${stage}`),
      });
      assembled.push({ format, file: res.output, srt: res.srtFile });
      await state.log("info", `Assembled ${format} (${res.cueCount} caption cues${res.hasAudio ? ", with audio" : ", no audio"}).`);
    }

    await state.moveTo("validating", "Validating output files");
    const outputIds: Types.ObjectId[] = [];
    for (const a of assembled) {
      const size = frameSizeFor(a.format, settings.quality);
      const report = await validateVideoFile(
        a.file,
        {
          ...size,
          fps: settings.fps,
          durationSeconds: storyboard.durationSeconds,
          requireAudio: narration.size > 0 || settings.ambience,
          requireSubtitleTrack: settings.subtitles === "sidecar" && Boolean(a.srt),
        },
        abort.signal,
      );
      if (!report.ok || !report.info) {
        throw new PermanentRenderError(`The ${a.format} video failed validation: ${report.issues.join(" ")}`);
      }
      const slug = storyboard.projectTitle.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "atlasmotion";
      const videoKey = newObjectKey({ userId: String(owner), projectId: String(projectId), folder: "outputs", ext: "mp4" });
      const stored = await ctx.storage.putFile(videoKey, a.file, "video/mp4");
      const attribution = [NATURAL_EARTH_ATTRIBUTION, narration.size > 0 ? "Narration: synthetic voice generated with eSpeak NG." : null, settings.ambience ? "Ambience: generated procedurally with FFmpeg." : null]
        .filter(Boolean)
        .join(" ");
      const video = await MediaAsset.create({
        owner,
        project: projectId,
        renderJob: state.id,
        kind: "video",
        storageKey: videoKey,
        mimeType: "video/mp4",
        sizeBytes: stored.sizeBytes,
        filename: `${slug}-${a.format.replace(":", "x")}.mp4`,
        format: a.format,
        width: report.info.video?.width,
        height: report.info.video?.height,
        durationSeconds: report.info.durationSeconds,
        fps: report.info.video?.fps,
        videoCodec: report.info.video?.codec,
        audioCodec: report.info.audio?.codec,
        provider: "map2d",
        license: "Your render. Map data public domain (Natural Earth).",
        attribution,
      });
      outputIds.push(video._id);
      if (a.srt) {
        const srtKey = newObjectKey({ userId: String(owner), projectId: String(projectId), folder: "outputs", ext: "srt" });
        const s = await ctx.storage.putFile(srtKey, a.srt, "application/x-subrip");
        const sub = await MediaAsset.create({ owner, project: projectId, renderJob: state.id, kind: "subtitle", storageKey: srtKey, mimeType: "application/x-subrip", sizeBytes: s.sizeBytes, filename: `${slug}-${a.format.replace(":", "x")}.srt`, format: a.format, provider: "atlasmotion" });
        outputIds.push(sub._id);
      }
      await state.log("info", `${a.format}: ${report.info.video?.width}x${report.info.video?.height}, ${report.info.durationSeconds.toFixed(2)}s, ${(stored.sizeBytes / 1e6).toFixed(1)} MB. Validation passed.`);
    }

    const total = (await RenderJob.findById(renderJobId).select("progress").lean<RenderJobDoc>())?.progress.totalUnits ?? 0;
    await state.moveTo("completed", "Completed", { outputs: outputIds, finishedAt: new Date(), "progress.completedUnits": total });
    await Project.updateOne({ _id: projectId }, { $set: { status: "rendered" } });
    // Success: scratch files are no longer needed (clips stay in storage for reuse).
    fs.rmSync(workDir, { recursive: true, force: true });
    log.info({ outputs: outputIds.length }, "render completed");
    return { outputs: outputIds.map(String) };
  } catch (err) {
    await state.flush();
    if (err instanceof CancelledError || abort.signal.aborted) {
      await markCancelled(state, doc);
      return { cancelled: true };
    }
    const permanent = err instanceof PermanentRenderError || err instanceof SceneInputError || (err instanceof TtsError && !err.recoverable);
    const maxAttempts = bullJob.opts.attempts ?? 1;
    const willRetry = !permanent && bullJob.attemptsMade + 1 < maxAttempts;
    const message = (err as Error).message;
    const sceneId = err instanceof PermanentRenderError ? err.sceneId : (err as { sceneId?: string }).sceneId;
    log.error({ err, willRetry }, "render attempt failed");
    try {
      if (willRetry) {
        await state.moveTo("retrying", `Attempt ${bullJob.attemptsMade + 1} of ${maxAttempts} failed; retrying automatically`, {
          error: { message, kind: "recoverable", sceneId },
        });
        await state.log("error", message);
      } else {
        if ((state.status as RenderJobStatus) !== "failed") {
          await state.moveTo("failed", "Failed", { error: { message, kind: permanent ? "permanent" : "recoverable", sceneId }, finishedAt: new Date() });
        }
        await state.log("error", message);
        await Project.updateOne({ _id: doc.project }, { $set: { status: "render_failed" } });
      }
    } catch (stateErr) {
      log.error({ err: stateErr }, "could not record failure");
    }
    if (permanent) throw new UnrecoverableError(message);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

async function markCancelled(state: JobState, doc: RenderJobDoc): Promise<void> {
  if (state.status !== "cancelled") {
    await state.moveTo("cancelled", "Cancelled", { finishedAt: new Date() }).catch(async () => {
      await RenderJob.updateOne({ _id: state.id }, { $set: { status: "cancelled", stage: "Cancelled", finishedAt: new Date() } });
    });
  }
  // Scenes that were mid-render go back to pending so a retry renders them.
  await RenderJob.updateOne({ _id: state.id }, { $set: { "scenes.$[s].status": "pending", "scenes.$[s].framesDone": 0 } }, { arrayFilters: [{ "s.status": "rendering" }] });
  await Project.updateOne({ _id: doc.project }, { $set: { status: "awaiting_review" } });
}

async function renderScenes(
  ctx: WorkerContext,
  state: JobState,
  doc: RenderJobDoc,
  storyboard: Storyboard,
  settings: RenderSettings,
  owner: Types.ObjectId,
  projectId: Types.ObjectId,
  workDir: string,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const clipKeys = new Map<string, string>();
  const look = { basemap: storyboard.basemap, imagery: storyboard.basemap !== "vector" ? ctx.renderer.imageryTag?.() : undefined };
  const imageryNotes = new Set<string>();
  const failures: { sceneId: string; format: AspectFormat; message: string; permanent: boolean }[] = [];
  const frameTotal = doc.scenes.reduce((n, s) => n + s.framesTotal, 0);
  let completedFrames = 0;

  for (const format of settings.formats) {
    for (const [index, scene] of storyboard.scenes.entries()) {
      if (signal.aborted) throw new CancelledError();
      const previous = storyboard.scenes[index - 1];
      const entry = doc.scenes.find((s) => s.sceneId === scene.id && s.format === format);
      const framesTotal = Math.round(scene.durationSeconds * settings.fps);
      const cacheKey = sceneCacheKey(scene, previous, format, settings.quality, settings.fps, look);

      // 1. Already finished in an earlier attempt of this job.
      if (entry && (entry.status === "done" || entry.status === "cached") && entry.clipAssetId && entry.cacheKey === cacheKey) {
        const asset = await MediaAsset.findById(entry.clipAssetId).lean<MediaAssetDoc>();
        if (await storedAssetUsable(ctx.storage, asset)) {
          clipKeys.set(`${format}|${scene.id}`, asset!.storageKey);
          completedFrames += framesTotal;
          continue;
        }
      }
      // 2. Identical scene rendered before (any project of this user).
      const cached = await MediaAsset.findOne({ owner, kind: "scene_clip", cacheKey }).sort({ createdAt: -1 }).lean<MediaAssetDoc>();
      if (await storedAssetUsable(ctx.storage, cached)) {
        clipKeys.set(`${format}|${scene.id}`, cached!.storageKey);
        completedFrames += framesTotal;
        await MediaAsset.updateOne({ _id: cached!._id }, { $set: { expiresAt: new Date(Date.now() + CLIP_RETENTION_DAYS * 86400_000) } });
        await state.updateScene(scene.id, format, { status: "cached", framesDone: framesTotal, framesTotal, cacheKey, clipAssetId: cached!._id, error: null }, completedFrames);
        await state.log("info", `${scene.id} (${format}): reused an identical earlier render.`);
        continue;
      }
      // 3. Render.
      await state.updateScene(scene.id, format, { status: "rendering", framesDone: 0, framesTotal, cacheKey, attempts: (entry?.attempts ?? 0) + 1, error: null });
      await state.setStage(`Rendering ${scene.title ?? scene.id} (${format})`);
      const out = path.join(workDir, "clips", `${format.replace(":", "x")}-${scene.id}-${cacheKey.slice(0, 12)}.mp4`);
      const base = completedFrames;
      try {
        const result = await ctx.renderer.renderScene({
          scene,
          previous,
          format,
          quality: settings.quality,
          fps: settings.fps,
          basemap: storyboard.basemap,
          output: out,
          signal,
          onProgress: (done) => state.sceneProgress(scene.id, format, done, base + done),
        });
        const key = newObjectKey({ userId: String(owner), projectId: String(projectId), folder: "clips", ext: "mp4" });
        const stored = await ctx.storage.putFile(key, out, "video/mp4");
        const asset = await MediaAsset.create({
          owner,
          project: projectId,
          renderJob: state.id,
          kind: "scene_clip",
          storageKey: key,
          mimeType: "video/mp4",
          sizeBytes: stored.sizeBytes,
          filename: path.basename(out),
          format,
          width: result.width,
          height: result.height,
          durationSeconds: result.durationSeconds,
          fps: settings.fps,
          videoCodec: "h264",
          provider: result.renderer,
          // A clip drawn without some of its detail tiles is not reused by later renders,
          // so it is redrawn once the tile provider is reachable again.
          cacheKey: result.imagery?.degraded ? `${cacheKey}-degraded` : cacheKey,
          expiresAt: new Date(Date.now() + CLIP_RETENTION_DAYS * 86400_000),
        });
        fs.rmSync(out, { force: true });
        completedFrames += framesTotal;
        await state.flush();
        await state.updateScene(scene.id, format, { status: "done", framesDone: framesTotal, clipAssetId: asset._id, error: null }, completedFrames);
        clipKeys.set(`${format}|${scene.id}`, key);
        await state.log("info", `${scene.id} (${format}): rendered ${result.frames} frames in ${(result.elapsedMs / 1000).toFixed(1)}s.`);
        if (result.imagery?.note && !imageryNotes.has(result.imagery.note)) {
          imageryNotes.add(result.imagery.note);
          await state.log("warn", `Imagery: ${result.imagery.note}`);
        }
      } catch (err) {
        if (err instanceof CancelledError || signal.aborted) throw new CancelledError();
        const message = (err as Error).message;
        await state.flush();
        await state.updateScene(scene.id, format, { status: "failed", error: message.slice(0, 500) });
        await state.log("error", `${scene.id} (${format}) failed: ${message}`);
        failures.push({ sceneId: scene.id, format, message, permanent: err instanceof SceneInputError });
        // Keep going: other scenes still render, so a retry only redoes the failed ones.
      }
    }
  }
  void frameTotal;
  if (failures.length > 0) {
    const first = failures[0]!;
    const msg = `${failures.length} scene render(s) failed. First: ${first.sceneId} (${first.format}): ${first.message}`;
    if (failures.every((f) => f.permanent)) throw new PermanentRenderError(msg, first.sceneId);
    const e = new Error(msg) as Error & { sceneId?: string };
    e.sceneId = first.sceneId;
    throw e;
  }
  return clipKeys;
}

async function generateNarration(
  ctx: WorkerContext,
  state: JobState,
  doc: RenderJobDoc,
  storyboard: Storyboard,
  owner: Types.ObjectId,
  projectId: Types.ObjectId,
  workDir: string,
  signal: AbortSignal,
): Promise<Map<string, { file: string; duration: number }>> {
  const out = new Map<string, { file: string; duration: number }>();
  const provider = ctx.tts.pick(storyboard.language, ctx.config.TTS_DEFAULT);
  if (!provider) throw new PermanentRenderError(`No narration provider supports ${storyboard.language}. Render without narration or configure a TTS provider.`);
  await state.moveTo("generating_audio", `Generating narration with ${provider.label}`);
  for (const scene of storyboard.scenes) {
    if (signal.aborted) throw new CancelledError();
    if (!scene.narration.trim()) continue;
    const cacheKey = narrationCacheKey(scene.narration, storyboard.language, provider.id, provider.voiceFor(storyboard.language));
    const existing = await MediaAsset.findOne({ owner, kind: "audio", cacheKey }).sort({ createdAt: -1 }).lean<MediaAssetDoc>();
    if (existing && (await storedAssetUsable(ctx.storage, existing))) {
      out.set(scene.id, { file: await ctx.storage.materialize(existing.storageKey, workDir), duration: existing.durationSeconds ?? scene.durationSeconds });
      await state.updateAudio(scene.id, { status: "cached", cacheKey, assetId: existing._id, durationSeconds: existing.durationSeconds });
      continue;
    }
    const file = path.join(workDir, "audio", `${scene.id}-${cacheKey.slice(0, 12)}.wav`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const r = await provider.synthesize({ text: scene.narration, language: storyboard.language, output: file, signal });
      const key = newObjectKey({ userId: String(owner), projectId: String(projectId), folder: "audio", ext: "wav" });
      const stored = await ctx.storage.putFile(key, file, "audio/wav");
      const asset = await MediaAsset.create({ owner, project: projectId, renderJob: state.id, kind: "audio", storageKey: key, mimeType: "audio/wav", sizeBytes: stored.sizeBytes, filename: path.basename(file), durationSeconds: r.durationSeconds, provider: r.provider, license: r.license, cacheKey });
      out.set(scene.id, { file, duration: r.durationSeconds });
      await state.updateAudio(scene.id, { status: "done", cacheKey, assetId: asset._id, durationSeconds: r.durationSeconds, error: null });
      if (r.durationSeconds > scene.durationSeconds) {
        await state.log("warn", `${scene.id}: narration is ${r.durationSeconds.toFixed(1)}s but the scene is ${scene.durationSeconds}s; the end will be cut. Shorten the text or lengthen the scene.`);
        await RenderJob.updateOne({ _id: state.id }, { $addToSet: { warnings: `Narration for ${scene.id} is longer than the scene and is cut at the scene end.` } });
      }
    } catch (err) {
      if (err instanceof CancelledError || signal.aborted) throw new CancelledError();
      await state.updateAudio(scene.id, { status: "failed", error: (err as Error).message.slice(0, 500) });
      // Never substitute other audio for failed narration: the attempt fails.
      throw err;
    }
  }
  void doc;
  return out;
}
