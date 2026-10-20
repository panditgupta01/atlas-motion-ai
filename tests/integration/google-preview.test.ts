import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, mongoAvailable, signedInAgent, type TestEnv } from "../helpers/app";

const hasMongo = await mongoAvailable();

// A made-up key: the test checks how the server hands it out, not Google itself.
const FAKE_KEY = "AIzaFakeKeyForTests_0123456789abcdef";

describe.skipIf(!hasMongo)("Google Maps preview configuration (real MongoDB)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({ overrides: { GOOGLE_MAPS_BROWSER_KEY: FAKE_KEY } });
  });
  afterAll(async () => env?.close());

  it("advertises the preview without the key, and gives the key only to signed-in users", async () => {
    const info = await request(env.app).get("/api/v1/geo/imagery");
    expect(info.body.googlePreview).toBe(true);
    expect(JSON.stringify(info.body)).not.toContain(FAKE_KEY);
    expect((await request(env.app).get("/api/v1/geo/google-maps")).status).toBe(401);
    const a = await signedInAgent(env.app);
    const res = await a.get("/api/v1/geo/google-maps");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ browserKey: FAKE_KEY, mapId: null });
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("allows Google's map hosts in the Content Security Policy only when the preview is on", async () => {
    const csp = (await request(env.app).get("/api/v1/health")).headers["content-security-policy"] ?? "";
    expect(csp).toContain("https://*.googleapis.com");
    expect(csp).toContain("https://*.gstatic.com");
  });
});
