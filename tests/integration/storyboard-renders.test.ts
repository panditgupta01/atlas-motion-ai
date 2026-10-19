import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RenderJob, MediaAsset } from "@atlas/server-core";
import { createTestEnv, mongoAvailable, RecordingQueue, signedInAgent, type Agent, type TestEnv } from "../helpers/app";

const hasMongo = await mongoAvailable();

describe.skipIf(!hasMongo)("storyboard and render API (real MongoDB, recording queue double)", () => {
  let env: TestEnv;
  const queue = new RecordingQueue();
  let a: Agent;
  let projectId: string;

  beforeAll(async () => {
    env = await createTestEnv({ queue });
    a = await signedInAgent(env.app);
    projectId = (await a.post("/api/v1/projects", { prompt: "Show how the Koshi river flows from Nepal into India", options: { durationSeconds: 20 } })).body.project.id;
  });
  afterAll(async () => env?.close());

  const storyboardUrl = () => `/api/v1/projects/${projectId}/storyboard`;

  it("plans a storyboard with the offline planner and queues a thumbnail", async () => {
    expect((await a.get(storyboardUrl())).status).toBe(404);
    const res = await a.post(storyboardUrl(), { provider: "gazetteer" });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(1);
    expect(res.body.storyboard.planner.deterministic).toBe(true);
    expect(res.body.validation.ok).toBe(true);
    expect(queue.thumbnails.at(-1)).toEqual({ projectId, version: 1 });
    expect((await a.get(`/api/v1/projects/${projectId}`)).body.project.status).toBe("awaiting_review");
  });

  it("rejects an unknown planner", async () => {
    expect((await a.post(storyboardUrl(), { provider: "nope" })).status).toBeGreaterThanOrEqual(400);
  });

  it("saves edits with optimistic concurrency and marks edited scenes", async () => {
    const current = (await a.get(storyboardUrl())).body;
    const sb = structuredClone(current.storyboard);
    sb.scenes[0].narration = "Edited narration.";
    const saved = await a.patch(storyboardUrl(), { storyboard: sb, baseVersion: current.version });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(current.version + 1);
    expect(saved.body.storyboard.scenes[0]).toMatchObject({ narration: "Edited narration.", status: "edited", revision: 1 });
    expect(saved.body.storyboard.scenes[1].revision).toBe(0);

    const stale = await a.patch(storyboardUrl(), { storyboard: sb, baseVersion: current.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
  });

  it("rejects malformed storyboards", async () => {
    const current = (await a.get(storyboardUrl())).body;
    const sb = structuredClone(current.storyboard);
    sb.scenes[0].location.latitude = 123;
    expect((await a.patch(storyboardUrl(), { storyboard: sb, baseVersion: current.version })).status).toBe(400);
  });

  it("regenerates one scene, keeping its id", async () => {
    const current = (await a.get(storyboardUrl())).body;
    const target = current.storyboard.scenes[1];
    const res = await a.post(`/api/v1/projects/${projectId}/scenes/${target.id}/regenerate`, { baseVersion: current.version, instructions: "shorter" });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(current.version + 1);
    const next = res.body.storyboard.scenes.find((s: { id: string }) => s.id === target.id);
    expect(next.revision).toBe(target.revision + 1);
    expect((await a.post(`/api/v1/projects/${projectId}/scenes/missing/regenerate`, { baseVersion: res.body.version })).status).toBe(404);
  });

  it("blocks renders when the storyboard has unsupported claims", async () => {
    const current = (await a.get(storyboardUrl())).body;
    const sb = structuredClone(current.storyboard);
    sb.scenes[0].claims = [{ text: "The Koshi floods every year.", sourceRefIds: [], status: "unsupported" }];
    const saved = (await a.patch(storyboardUrl(), { storyboard: sb, baseVersion: current.version })).body;
    const res = await a.post(`/api/v1/projects/${projectId}/renders`, { formats: ["9:16"], storyboardVersion: saved.version, narration: false });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("storyboard_invalid");
    // Resolve it as illustrative so later tests can render.
    sb.scenes[0].claims[0].status = "illustrative";
    await a.patch(storyboardUrl(), { storyboard: sb, baseVersion: saved.version }).expect(200);
  });

  it("refuses to render a storyboard version the user did not review", async () => {
    const current = (await a.get(storyboardUrl())).body;
    const res = await a.post(`/api/v1/projects/${projectId}/renders`, { formats: ["9:16"], storyboardVersion: current.version - 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("version_conflict");
  });

  it("creates a render once per idempotency key and refuses a second concurrent render", async () => {
    const { version } = (await a.get(storyboardUrl())).body;
    const body = { formats: ["9:16", "16:9"], fps: 24, quality: "draft", subtitles: "burned", narration: false, storyboardVersion: version, idempotencyKey: "key-12345678" };
    const first = await a.post(`/api/v1/projects/${projectId}/renders`, body);
    expect(first.status).toBe(202);
    expect(first.body.render.status).toBe("queued");
    expect(first.body.render.scenes.length).toBe(first.body.render.settings.formats.length * (await a.get(storyboardUrl())).body.storyboard.scenes.length);
    const again = await a.post(`/api/v1/projects/${projectId}/renders`, body);
    expect(again.status).toBe(200);
    expect(again.body.render.id).toBe(first.body.render.id);
    expect(queue.renders.filter((r) => r.renderJobId === first.body.render.id)).toHaveLength(1);
    const second = await a.post(`/api/v1/projects/${projectId}/renders`, { ...body, idempotencyKey: "key-87654321" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("render_in_progress");
  });

  it("cancels a queued render and retries it as a new attempt", async () => {
    const list = (await a.get(`/api/v1/projects/${projectId}/renders`)).body.items;
    const id = list[0].id;
    const cancelled = await a.post(`/api/v1/renders/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.render.status).toBe("cancelled");
    expect((await a.post(`/api/v1/renders/${id}/cancel`)).status).toBe(409);

    // Simulate one finished scene so retry must keep it.
    await RenderJob.updateOne({ _id: id }, { $set: { "scenes.0.status": "done", "scenes.0.framesDone": 10 } });
    const retried = await a.post(`/api/v1/renders/${id}/retry`);
    expect(retried.status).toBe(202);
    expect(retried.body.render.status).toBe("queued");
    expect(retried.body.render.attempts).toBe(1);
    expect(retried.body.render.scenes[0].status).toBe("done");
    expect(retried.body.render.scenes.slice(1).every((s: { status: string }) => s.status === "pending")).toBe(true);
    expect(queue.renders.at(-1)).toEqual({ renderJobId: id, attempt: 1 });
    // Completed renders cannot be retried.
    await RenderJob.updateOne({ _id: id }, { $set: { status: "completed" } });
    expect((await a.post(`/api/v1/renders/${id}/retry`)).status).toBe(409);
  });

  it("does not expose renders or assets to other users", async () => {
    const id = (await a.get(`/api/v1/projects/${projectId}/renders`)).body.items[0].id;
    const other = await signedInAgent(env.app);
    expect((await other.get(`/api/v1/renders/${id}`)).status).toBe(404);
    expect((await other.post(`/api/v1/renders/${id}/cancel`)).status).toBe(404);
    const asset = await MediaAsset.create({ owner: a.user.id, project: projectId, kind: "subtitle", storageKey: `users/${a.user.id}/projects/${projectId}/renders/abc.srt`, mimeType: "application/x-subrip", sizeBytes: 3, filename: "x.srt" });
    expect((await other.get(`/api/v1/assets/${asset._id}/download`)).status).toBe(404);
  });

  it("returns 404 rather than 500 for unknown ids", async () => {
    expect((await a.get("/api/v1/renders/507f1f77bcf86cd799439011")).status).toBe(404);
    expect((await a.get("/api/v1/assets/zzz/download")).status).toBe(404);
  });
});
