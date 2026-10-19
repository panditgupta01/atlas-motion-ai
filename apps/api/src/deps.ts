import type { AppConfig, Logger, StorageDriver, UsageService } from "@atlas/server-core";
import type { PlannerRegistry } from "@atlas/storyboard";
import type { TtsRegistry } from "@atlas/video-engine";

/** Queue operations the API needs; BullMQ in production, a recorder in unit tests. */
export interface RenderQueuePort {
  enqueueRender(renderJobId: string, attempt: number): Promise<void>;
  enqueueThumbnail(projectId: string, storyboardVersion: number): Promise<void>;
  /** Remove a job that has not started yet. Returns true if it was removed. */
  removeQueued(renderJobId: string, attempt: number): Promise<boolean>;
  ping(): Promise<boolean>;
}

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  storage: StorageDriver;
  queue: RenderQueuePort;
  planners: PlannerRegistry;
  tts: TtsRegistry;
  usage: UsageService;
}
