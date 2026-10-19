import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { checkGeoData } from "@atlas/geo";
import { MediaAsset, Project, createLogger } from "@atlas/server-core";
import { frameSizeFor, isTerminal, type RenderJobDto } from "@atlas/shared";
import { EspeakTtsProvider, MapSceneRenderer, registerFonts, validateVideoFile } from "@atlas/video-engine";
import { createBullQueuePort } from "../../apps/api/src/queue-adapter";
import { startWorker } from "../../workers/renderer/src/worker";
import { createTestEnv, mongoAvailable, REDIS_URL, signedInAgent, type Agent, type TestEnv } from "../helpers/app";

// A separate Redis database keeps these jobs away from any dev worker on the default queue.
const E2E_REDIS = `${REDIS_URL.replace(/\/\d+$/, "")}/7`;

async function redisAvailable() {
  const r = new Redis(E2E_REDIS, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1500 });
  try {
    await r.connect();
    await r.flushdb();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

const ready = (await mongoAvailable()) && (await redisAvailable()) && checkGeoData().ok;
if (!ready) console.warn("Skipping e2e: needs MongoDB, Redis and Natural Earth data (scripts/fetch-assets.sh).");
const espeak = new EspeakTtsProvider();

async function waitFor(a: Agent, renderId: string, until: (r: RenderJobDto) => boolean, timeoutMs = 240_000): Promise<RenderJobDto> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = (await a.get(`/api/v1/renders/${renderId}`)).body.render as RenderJobDto;
    if (until(r)) return r;
    if (Date.now() > end) throw new Error(`timed out; last status ${r.status} (${r.stage})`);
    await new Promise((res) => setTimeout(res, 500));
  }
}

describe.skipIf(!ready)("end to end: prompt → storyboard → edit → render → validated download", () => {
  let env: TestEnv;
  let worker: Worker;
  let queue: ReturnType<typeof createBullQueuePort>;
  let a: Agent;
  let projectId: string;
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-e2e-dl-"));

  beforeAll(async () => {
    registerFonts();
    env = await createTestEnv({ overrides: { REDIS_URL: E2E_REDIS, RENDER_MAX_ATTEMPTS: "1" } });
    queue = createBullQueuePort(env.config);
    env.deps.queue = queue;
    worker = startWorker({
      config: env.config,
      storage: env.deps.storage,
      tts: env.deps.tts,
      renderer: new MapSceneRenderer(),
      logger: createLogger("worker-test", "silent"),
      workerId: "e2e",
    });
    a = await signedInAgent(env.app);
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    await env?.close();
    fs.rmSync(downloads, { recursive: true, force: true });
  });

  it("renders both formats and the downloads pass validation", async () => {
    projectId = (await a.post("/api/v1/projects", { prompt: "Show Nepal and its neighbour India", options: { durationSeconds: 10, language: "en" } })).body.project.id;
    const planned = (await a.post(`/api/v1/projects/${projectId}/storyboard`, { provider: "gazetteer" })).body;
    expect(planned.validation.ok).toBe(true);

    // Edit: rewrite the first scene's narration, as a reviewer would.
    const sb = structuredClone(planned.storyboard);
    sb.scenes[0].narration = "Nepal sits between China and India.";
    sb.scenes[0].claims = [{ text: "Nepal sits between China and India.", sourceRefIds: ["natural-earth"], status: "sourced" }];
    const saved = await a.patch(`/api/v1/projects/${projectId}/storyboard`, { storyboard: sb, baseVersion: planned.version });
    expect(saved.status).toBe(200);

    const narration = espeak.isConfigured();
    const created = await a.post(`/api/v1/projects/${projectId}/renders`, {
      formats: ["9:16", "16:9"],
      fps: 24,
      quality: "draft",
      subtitles: "burned",
      narration,
      ambience: true,
      storyboardVersion: saved.body.version,
    });
    expect(created.status).toBe(202);
    const done = await waitFor(a, created.body.render.id, (r) => isTerminal(r.status));
    expect(done.error).toBeUndefined();
    expect(done.status).toBe("completed");
    expect(done.progress.fraction).toBe(1);
    expect(done.scenes.every((s) => s.status === "done" || s.status === "cached")).toBe(true);

    const videos = done.outputs.filter((o) => o.kind === "video");
    expect(videos.map((v) => v.format).sort()).toEqual(["16:9", "9:16"]);
    expect(done.outputs.filter((o) => o.kind === "subtitle")).toHaveLength(2);

    for (const v of videos) {
      const res = await a.get(v.downloadUrl).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("video/mp4");
      const file = path.join(downloads, `${v.format === "9:16" ? "v" : "h"}.mp4`);
      fs.writeFileSync(file, res.body as Buffer);
      const size = frameSizeFor(v.format!, "draft");
      const report = await validateVideoFile(file, { ...size, fps: 24, durationSeconds: 10, requireAudio: true });
      expect(report.issues).toEqual([]);
    }
  });

  it("produced a dashboard thumbnail from the real renderer", async () => {
    const end = Date.now() + 30_000;
    let thumb;
    while (!thumb && Date.now() < end) {
      const p = await Project.findById(projectId).lean();
      thumb = p?.thumbnailAssetId ? await MediaAsset.findById(p.thumbnailAssetId).lean() : null;
      if (!thumb) await new Promise((r) => setTimeout(r, 500));
    }
    expect(thumb?.mimeType).toBe("image/png");
  });

  it("cancels a running render, then a retry reuses finished scenes", async () => {
    const { version } = (await a.get(`/api/v1/projects/${projectId}/storyboard`)).body;
    const created = await a.post(`/api/v1/projects/${projectId}/renders`, { formats: ["16:9"], fps: 30, quality: "standard", subtitles: "none", narration: false, storyboardVersion: version });
    expect(created.status).toBe(202);
    const id = created.body.render.id;
    const running = await waitFor(a, id, (r) => r.scenes.some((s) => s.status === "done") || isTerminal(r.status), 120_000);
    expect(running.status).toBe("rendering_scenes");
    await a.post(`/api/v1/renders/${id}/cancel`).expect(202);
    const cancelled = await waitFor(a, id, (r) => isTerminal(r.status), 60_000);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.outputs).toHaveLength(0);
    const finishedBefore = cancelled.scenes.filter((s) => s.status === "done").map((s) => s.sceneId);
    expect(finishedBefore.length).toBeGreaterThan(0);

    await a.post(`/api/v1/renders/${id}/retry`).expect(202);
    const done = await waitFor(a, id, (r) => isTerminal(r.status));
    expect(done.status).toBe("completed");
    expect(done.attempts).toBe(1);
    expect(done.logs.some((l) => /reuse|cached|already rendered/i.test(l.message))).toBe(true);
  });
});
