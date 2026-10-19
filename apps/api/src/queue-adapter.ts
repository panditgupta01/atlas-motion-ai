import { createRenderQueue, renderQueueJobId, type AppConfig } from "@atlas/server-core";
import type { RenderQueuePort } from "./deps.js";

export function createBullQueuePort(config: AppConfig): RenderQueuePort & { close(): Promise<void> } {
  const queue = createRenderQueue(config.REDIS_URL);
  return {
    async enqueueRender(renderJobId, attempt) {
      await queue.add(
        "render",
        { renderJobId },
        {
          jobId: renderQueueJobId(renderJobId, attempt),
          attempts: config.RENDER_MAX_ATTEMPTS,
          backoff: { type: "exponential", delay: 15_000 },
        },
      );
    },
    async enqueueThumbnail(projectId, storyboardVersion) {
      await queue.add("thumbnail", { projectId, storyboardVersion }, { jobId: `thumb-${projectId}-${storyboardVersion}`, attempts: 2, priority: 1 });
    },
    async removeQueued(renderJobId, attempt) {
      const job = await queue.getJob(renderQueueJobId(renderJobId, attempt));
      if (!job) return false;
      const state = await job.getState();
      if (state === "waiting" || state === "delayed" || state === "prioritized") {
        await job.remove();
        return true;
      }
      return false;
    },
    async ping() {
      // Any round trip to Redis proves the queue is reachable.
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000));
      await Promise.race([queue.getJobCounts("waiting"), timeout]);
      return true;
    },
    close: () => queue.close(),
  };
}
