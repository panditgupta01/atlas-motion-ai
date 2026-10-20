import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, mongoAvailable, signedInAgent, type TestEnv } from "../helpers/app";

const hasMongo = await mongoAvailable();
if (!hasMongo) console.warn("Skipping integration tests: no MongoDB at TEST_MONGODB_URI / 127.0.0.1:27017");

describe.skipIf(!hasMongo)("auth and projects API (real MongoDB)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => env?.close());

  it("registers, reads the session, logs out", async () => {
    const agent = request.agent(env.app);
    const reg = await agent.post("/api/v1/auth/register").set("X-Atlas-Client", "web").send({ email: "Alice@Example.com", password: "correct-horse-battery" });
    expect(reg.status).toBe(201);
    expect(reg.body.user.email).toBe("alice@example.com");
    expect(reg.body.user.passwordHash).toBeUndefined();
    const cookie = reg.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await agent.get("/api/v1/auth/me")).body.user.email).toBe("alice@example.com");
    expect((await agent.post("/api/v1/auth/logout").set("X-Atlas-Client", "web")).status).toBe(204);
    expect((await agent.get("/api/v1/auth/me")).status).toBe(401);
  });

  it("rejects duplicate emails, short passwords and wrong passwords without revealing which", async () => {
    await request(env.app).post("/api/v1/auth/register").set("X-Atlas-Client", "web").send({ email: "bob@example.com", password: "correct-horse-battery" }).expect(201);
    expect((await request(env.app).post("/api/v1/auth/register").set("X-Atlas-Client", "web").send({ email: "bob@example.com", password: "correct-horse-battery" })).status).toBe(409);
    expect((await request(env.app).post("/api/v1/auth/register").set("X-Atlas-Client", "web").send({ email: "c@example.com", password: "short" })).status).toBe(400);
    const wrong = await request(env.app).post("/api/v1/auth/login").set("X-Atlas-Client", "web").send({ email: "bob@example.com", password: "nope-nope-nope" });
    const unknown = await request(env.app).post("/api/v1/auth/login").set("X-Atlas-Client", "web").send({ email: "nobody@example.com", password: "nope-nope-nope" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it("rejects state-changing requests without the client header (CSRF defence)", async () => {
    const res = await request(env.app).post("/api/v1/auth/register").send({ email: "d@example.com", password: "correct-horse-battery" });
    expect(res.status).toBe(403);
  });

  it("describes the satellite imagery and serves preview tiles only to signed-in users", async () => {
    const info = await request(env.app).get("/api/v1/geo/imagery");
    expect(info.status).toBe(200);
    expect(info.body.attribution).toContain("NASA Blue Marble");
    expect(JSON.stringify(info.body)).not.toMatch(/key|https?:\/\//i);
    expect((await request(env.app).get("/api/v1/geo/imagery/tiles/2/2/1")).status).toBe(401);
    const a = await signedInAgent(env.app);
    const tile = await a.get("/api/v1/geo/imagery/tiles/2/2/1.jpg");
    expect(tile.status).toBe(200);
    expect(tile.headers["content-type"]).toBe("image/jpeg");
    expect(tile.headers["x-imagery-source"]).toBe("base");
    expect((await a.get("/api/v1/geo/imagery/tiles/2/7/1")).status).toBe(404);
    expect((await a.get("/api/v1/geo/imagery/tiles/x/1/1")).status).toBe(404);
  });

  it("offers no Google Maps preview and keeps Google hosts out of the CSP without a key", async () => {
    expect((await request(env.app).get("/api/v1/geo/imagery")).body.googlePreview).toBe(false);
    const a = await signedInAgent(env.app);
    expect((await a.get("/api/v1/geo/google-maps")).status).toBe(404);
    expect((await request(env.app).get("/api/v1/health")).headers["content-security-policy"] ?? "").not.toContain("google");
  });

  it("serves 3D terrain tiles only to signed-in users, and says when terrain is off", async () => {
    expect((await request(env.app).get("/api/v1/geo/imagery")).body.terrain).toBeNull();
    expect((await request(env.app).get("/api/v1/geo/terrain/3/1/1")).status).toBe(401);
    const a = await signedInAgent(env.app);
    expect((await a.get("/api/v1/geo/terrain/3/1/1.png")).status).toBe(404);
  });

  it("requires a session for project routes", async () => {
    expect((await request(env.app).get("/api/v1/projects")).status).toBe(401);
  });

  it("creates, lists, searches, updates and soft-deletes projects", async () => {
    const a = await signedInAgent(env.app);
    const created = await a.post("/api/v1/projects", { prompt: "Rivers of Nepal flowing into India", options: { language: "hi", durationSeconds: 45 } });
    expect(created.status).toBe(201);
    const p = created.body.project;
    expect(p.title).toBe("Rivers of Nepal flowing into India");
    expect(p.options).toMatchObject({ language: "hi", durationSeconds: 45, formats: ["9:16", "16:9"] });
    expect(p.status).toBe("draft");

    await a.post("/api/v1/projects", { prompt: "Capitals of the Mediterranean sea", title: "Med capitals" });
    const list = await a.get("/api/v1/projects?sort=title&order=asc");
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((x: { title: string }) => x.title)).toEqual(["Med capitals", "Rivers of Nepal flowing into India"]);
    expect((await a.get("/api/v1/projects?q=nepal")).body.total).toBe(1);
    expect((await a.get("/api/v1/projects?q=(.*")).status).toBe(200); // regex input is escaped

    const upd = await a.patch(`/api/v1/projects/${p.id}`, { title: "Renamed" });
    expect(upd.body.project.title).toBe("Renamed");
    expect((await a.delete(`/api/v1/projects/${p.id}`)).status).toBe(204);
    expect((await a.get(`/api/v1/projects/${p.id}`)).status).toBe(404);
    expect((await a.get("/api/v1/projects")).body.total).toBe(1);
  });

  it("validates project input", async () => {
    const a = await signedInAgent(env.app);
    expect((await a.post("/api/v1/projects", { prompt: "short" })).status).toBe(400);
    expect((await a.post("/api/v1/projects", { prompt: "A long enough prompt", options: { durationSeconds: 999 } })).status).toBe(400);
    expect((await a.post("/api/v1/projects", { prompt: "A long enough prompt", options: { sourceUrls: ["file:///etc/passwd"] } })).status).toBe(400);
    expect((await a.get("/api/v1/projects/not-an-id")).status).toBe(404);
  });

  it("hides other users' projects behind 404", async () => {
    const owner = await signedInAgent(env.app);
    const other = await signedInAgent(env.app);
    const { project } = (await owner.post("/api/v1/projects", { prompt: "Show Nepal and India on a map" })).body;
    expect((await other.get(`/api/v1/projects/${project.id}`)).status).toBe(404);
    expect((await other.patch(`/api/v1/projects/${project.id}`, { title: "mine" })).status).toBe(404);
    expect((await other.delete(`/api/v1/projects/${project.id}`)).status).toBe(404);
    expect((await other.post(`/api/v1/projects/${project.id}/storyboard`)).status).toBe(404);
    expect((await other.get(`/api/v1/projects/${project.id}/renders`)).status).toBe(404);
    expect((await other.get("/api/v1/projects")).body.total).toBe(0);
  });

  it("reports health and providers without secrets", async () => {
    const health = await request(env.app).get("/api/v1/health");
    expect(health.body.checks.database.ok).toBe(true);
    const providers = await request(env.app).get("/api/v1/providers");
    expect(JSON.stringify(providers.body)).not.toMatch(/sk-ant|JWT_SECRET/);
    expect(providers.body.items.find((p: { id: string }) => p.id === "gazetteer").configured).toBe(true);
  });
});
