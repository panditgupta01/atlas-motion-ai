import os from "node:os";
import { Worker, type Job } from "bullmq";
import {
  ConfigError,
  RENDER_QUEUE,
  connectDatabase,
  createLogger,
  createRenderQueue,
  createStorage,
  disconnectDatabase,
  loadConfig,
  redisConnection,
  type RenderQueueData,
  type ThumbnailQueueData,
} from "@atlas/server-core";
import { checkGeoData } from "@atlas/geo";
import { EspeakTtsProvider, MapSceneRenderer, TtsRegistry, registerFonts } from "@atlas/video-engine";
import { cleanupExpired, reconcileOrphanedJobs } from "./jobs/maintenance.js";
import { processRenderJob, type WorkerContext } from "./jobs/render-job.js";
import { processThumbnailJob } from "./jobs/thumbnail-job.js";

/** Build the job processor; exported so tests can run the worker in-process. */
export function createProcessor(ctx: WorkerContext) {
  return async (job: Job) => {
    if (job.name === "render") return processRenderJob(ctx, job as Job<RenderQueueData>);
    if (job.name === "thumbnail") return processThumbnailJob(ctx, job as Job<ThumbnailQueueData>);
    throw new Error(`Unknown job type ${job.name}`);
  };
}

export function startWorker(ctx: WorkerContext): Worker {
  const worker = new Worker(RENDER_QUEUE, createProcessor(ctx), {
    connection: redisConnection(ctx.config.REDIS_URL),
    concurrency: ctx.config.RENDER_CONCURRENCY,
    // Long renders hold the lock; BullMQ renews it automatically while the process is alive.
    lockDuration: 60_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  });
  worker.on("failed", (job, err) => ctx.logger.warn({ jobId: job?.id, err: err.message }, "queue job failed"));
  worker.on("error", (err) => ctx.logger.error({ err }, "worker error"));
  return worker;
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger("renderer", config.LOG_LEVEL);
  const geo = checkGeoData();
  if (!geo.ok) {
    logger.fatal({ missing: geo.missing }, "map data missing; run scripts/fetch-assets.sh");
    process.exit(1);
  }
  registerFonts();
  await connectDatabase(config.MONGODB_URI);
  const tts = new TtsRegistry([new EspeakTtsProvider()]);
  const renderer = new MapSceneRenderer();
  const ctx: WorkerContext = {
    config,
    storage: createStorage(config),
    tts,
    renderer,
    logger,
    workerId: `${os.hostname()}:${process.pid}`,
  };
  const worker = startWorker(ctx);
  const queue = createRenderQueue(config.REDIS_URL);
  logger.info({ concurrency: config.RENDER_CONCURRENCY, tts: tts.providers.map((p) => `${p.id}:${p.isConfigured()}`) }, "render worker started");

  const requeued = await reconcileOrphanedJobs(ctx, queue).catch((err) => (logger.error({ err }, "reconcile failed"), 0));
  if (requeued) logger.warn({ requeued }, "recovered orphaned render jobs");
  const maintenance = setInterval(() => {
    cleanupExpired(ctx)
      .then((r) => (r.assets || r.dirs) && logger.info(r, "cleanup"))
      .catch((err) => logger.error({ err }, "cleanup failed"));
    reconcileOrphanedJobs(ctx, queue).catch(() => undefined);
  }, 10 * 60_000);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutting down; active jobs will resume on the next start");
    clearInterval(maintenance);
    await worker.close();
    await renderer.close();
    await queue.close();
    await disconnectDatabase();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("worker.ts") || process.argv[1]?.endsWith("worker.js")) {
  main().catch((err) => {
    console.error("Worker failed to start:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
