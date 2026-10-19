/**
 * Hand-maintained OpenAPI summary of the REST API. Request bodies are
 * validated by the Zod schemas in @atlas/shared (src/api.ts), which are the
 * source of truth for field-level rules.
 */
const op = (summary: string, extra: Record<string, unknown> = {}) => ({ summary, ...extra });
const auth = { security: [{ cookieAuth: [] }] };
const body = (schemaName: string) => ({ requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } } } });

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "AtlasMotion AI API",
    version: "1.0.0",
    description:
      "All state-changing requests require the header `X-Atlas-Client: web` (CSRF protection) and a session cookie from /auth/login. Errors use `{ error: { code, message, details, requestId } }`.",
  },
  servers: [{ url: "/api/v1" }],
  components: {
    securitySchemes: { cookieAuth: { type: "apiKey", in: "cookie", name: "atlas_session" } },
    schemas: {
      Register: { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 10 } } },
      CreateProject: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, title: { type: "string" }, options: { type: "object", description: "language, durationSeconds, formats, style, narration, subtitles, soundDesign, sourceUrls" } } },
      UpdateStoryboard: { type: "object", required: ["storyboard", "baseVersion"], properties: { storyboard: { type: "object", description: "Storyboard schema v1 (packages/shared/src/storyboard.ts)" }, baseVersion: { type: "integer" } } },
      RegenerateScene: { type: "object", required: ["baseVersion"], properties: { instructions: { type: "string" }, provider: { type: "string" }, baseVersion: { type: "integer" } } },
      CreateRender: { type: "object", required: ["formats", "storyboardVersion"], properties: { formats: { type: "array", items: { enum: ["9:16", "16:9"] } }, fps: { enum: [24, 25, 30] }, quality: { enum: ["draft", "standard", "high"] }, subtitles: { enum: ["burned", "sidecar", "none"] }, narration: { type: "boolean" }, ambience: { type: "boolean" }, storyboardVersion: { type: "integer" }, idempotencyKey: { type: "string" } } },
    },
  },
  paths: {
    "/health": { get: op("Service health: database, queue, storage, FFmpeg, map data, fonts") },
    "/providers": { get: op("Configured planner, TTS, renderer and storage providers (no secrets)") },
    "/auth/register": { post: op("Create an account and start a session", body("Register")) },
    "/auth/login": { post: op("Start a session", body("Register")) },
    "/auth/logout": { post: op("End the session") },
    "/auth/me": { get: op("Current user", auth) },
    "/projects": { get: op("List projects (page, pageSize, q, sort, order)", auth), post: op("Create a project", { ...auth, ...body("CreateProject") }) },
    "/projects/{projectId}": { get: op("Get a project", auth), patch: op("Update title, prompt or options", auth), delete: op("Delete a project (soft delete)", auth) },
    "/projects/{projectId}/storyboard": {
      post: op("Generate a storyboard with the default or chosen planner", auth),
      get: op("Get the storyboard with validation results", auth),
      patch: op("Save an edited storyboard (optimistic concurrency via baseVersion)", { ...auth, ...body("UpdateStoryboard") }),
    },
    "/projects/{projectId}/scenes/{sceneId}/regenerate": { post: op("Regenerate one scene", { ...auth, ...body("RegenerateScene") }) },
    "/projects/{projectId}/renders": { get: op("Render history", auth), post: op("Submit a render of a reviewed storyboard version", { ...auth, ...body("CreateRender") }) },
    "/projects/{projectId}/assets": { get: op("Validated output files and thumbnails", auth) },
    "/renders/{renderId}": { get: op("Render status, per-scene progress, logs and validated outputs", auth) },
    "/renders/{renderId}/cancel": { post: op("Cancel a queued or running render", auth) },
    "/renders/{renderId}/retry": { post: op("Retry a failed or cancelled render, reusing completed scenes", auth) },
    "/assets/{assetId}/download": { get: op("Download a file you own (?inline=1 to preview)", auth) },
    "/geo/search": { get: op("Search the Natural Earth gazetteer (q, kind, limit)") },
    "/geo/layers/{layer}": { get: op("GeoJSON layers for the map preview: countries, rivers, lakes") },
  },
};
