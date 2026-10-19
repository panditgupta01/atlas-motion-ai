import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import mongoose from "mongoose";
import request from "supertest";
import { connectDatabase, createLogger, LocalStorage, loadConfig, UsageService, type AppConfig } from "@atlas/server-core";
import { PlannerRegistry } from "@atlas/storyboard";
import { EspeakTtsProvider, imageryConfigFromEnv, ImageryTileService, TtsRegistry } from "@atlas/video-engine";
import { createApp } from "../../apps/api/src/app";
import type { AppDeps, RenderQueuePort } from "../../apps/api/src/deps";

export const MONGO_BASE = process.env.TEST_MONGODB_URI ?? "mongodb://127.0.0.1:27017";
export const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379";

/** True when a MongoDB server is reachable; integration tests are skipped (and say so) otherwise. */
export async function mongoAvailable(): Promise<boolean> {
  try {
    const conn = await mongoose.createConnection(`${MONGO_BASE}/atlas_probe`, { serverSelectionTimeoutMS: 1500 }).asPromise();
    await conn.close();
    return true;
  } catch {
    return false;
  }
}

/** Records queue calls instead of talking to Redis. A test double, used where no worker should run. */
export class RecordingQueue implements RenderQueuePort {
  renders: { renderJobId: string; attempt: number }[] = [];
  thumbnails: { projectId: string; version: number }[] = [];
  removable = true;
  async enqueueRender(renderJobId: string, attempt: number) {
    this.renders.push({ renderJobId, attempt });
  }
  async enqueueThumbnail(projectId: string, version: number) {
    this.thumbnails.push({ projectId, version });
  }
  async removeQueued() {
    return this.removable;
  }
  async ping() {
    return true;
  }
}

export interface TestEnv {
  config: AppConfig;
  deps: AppDeps;
  app: ReturnType<typeof createApp>;
  dbName: string;
  tmp: string;
  close(): Promise<void>;
}

export async function createTestEnv(opts: { queue?: RenderQueuePort; overrides?: Record<string, string> } = {}): Promise<TestEnv> {
  const dbName = `atlas_test_${crypto.randomBytes(4).toString("hex")}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-it-"));
  const config = loadConfig(
    {
      NODE_ENV: "test",
      MONGODB_URI: `${MONGO_BASE}/${dbName}`,
      REDIS_URL,
      JWT_SECRET: crypto.randomBytes(32).toString("hex"),
      STORAGE_LOCAL_DIR: path.join(tmp, "storage"),
      WORK_DIR: path.join(tmp, "work"),
      LOG_LEVEL: "silent",
      PLANNER_DEFAULT: "gazetteer",
      ...opts.overrides,
    },
    { reload: true },
  );
  await connectDatabase(config.MONGODB_URI);
  const deps: AppDeps = {
    config,
    logger: createLogger("api-test", "silent"),
    storage: new LocalStorage(config.STORAGE_LOCAL_DIR),
    queue: opts.queue ?? new RecordingQueue(),
    planners: new PlannerRegistry({ defaultProvider: "gazetteer" }),
    tts: new TtsRegistry([new EspeakTtsProvider()]),
    imagery: new ImageryTileService({ ...imageryConfigFromEnv(), provider: "none" }),
    usage: new UsageService({ rendersPerDay: config.USAGE_RENDERS_PER_DAY, plansPerHour: config.USAGE_PLANS_PER_HOUR }),
  };
  const app = createApp(deps);
  return {
    config,
    deps,
    app,
    dbName,
    tmp,
    async close() {
      await mongoose.connection.dropDatabase().catch(() => undefined);
      await mongoose.disconnect();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** A signed-in supertest agent. Every request carries the CSRF header the web client sends. */
export async function signedInAgent(app: TestEnv["app"], email = `user-${crypto.randomBytes(4).toString("hex")}@example.com`) {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/auth/register").set("X-Atlas-Client", "web").send({ email, password: "correct-horse-battery" });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const wrap = {
    get: (url: string) => agent.get(url).set("X-Atlas-Client", "web"),
    post: (url: string, body?: object) => agent.post(url).set("X-Atlas-Client", "web").send(body ?? {}),
    patch: (url: string, body?: object) => agent.patch(url).set("X-Atlas-Client", "web").send(body ?? {}),
    delete: (url: string) => agent.delete(url).set("X-Atlas-Client", "web"),
    user: res.body.user as { id: string; email: string },
  };
  return wrap;
}

export type Agent = Awaited<ReturnType<typeof signedInAgent>>;
