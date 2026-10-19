import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const RENDER_QUEUE = "atlas-render";

export interface RenderQueueData {
  renderJobId: string;
}

export interface ThumbnailQueueData {
  projectId: string;
  storyboardVersion: number;
}

export type QueueJobName = "render" | "thumbnail";

/**
 * A new Redis client for BullMQ. Each Queue/Worker gets its own connection
 * (workers use blocking commands). `maxRetriesPerRequest: null` is required by BullMQ.
 */
export function redisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createRenderQueue(redisUrl: string): Queue<RenderQueueData | ThumbnailQueueData, unknown, QueueJobName> {
  return new Queue(RENDER_QUEUE, {
    connection: redisConnection(redisUrl),
    defaultJobOptions: {
      removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
      removeOnFail: { age: 14 * 24 * 3600 },
    },
  });
}

/**
 * BullMQ job id for a render attempt. The same render job + attempt always
 * maps to the same id, so a double submit cannot enqueue it twice.
 */
export function renderQueueJobId(renderJobId: string, attempt: number): string {
  return `render-${renderJobId}-${attempt}`;
}
