import { z } from "zod";

/**
 * Versioned storyboard contract shared by the planner, the API, the editor and
 * the renderer. Bump STORYBOARD_SCHEMA_VERSION on any breaking change and add a
 * migration in `migrateStoryboard`.
 */
export const STORYBOARD_SCHEMA_VERSION = 1 as const;

export const LANGUAGES = ["hi", "en"] as const;
export const languageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof languageSchema>;

export const ASPECT_FORMATS = ["9:16", "16:9"] as const;
export const aspectFormatSchema = z.enum(ASPECT_FORMATS);
export type AspectFormat = z.infer<typeof aspectFormatSchema>;

export const VISUAL_STYLES = ["documentary", "news", "educational", "minimal"] as const;
export const visualStyleSchema = z.enum(VISUAL_STYLES);
export type VisualStyle = z.infer<typeof visualStyleSchema>;

export const latitudeSchema = z.number().finite().min(-90).max(90);
export const longitudeSchema = z.number().finite().min(-180).max(180);
/** [longitude, latitude], GeoJSON order. */
export const lonLatSchema = z.tuple([longitudeSchema, latitudeSchema]);
export type LonLat = z.infer<typeof lonLatSchema>;

const shortText = z.string().trim().min(1).max(120);
const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "ids use lowercase letters, digits and hyphens");

export const sourceRefSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(300),
  url: z.url({ protocol: /^https?$/ }).optional(),
  kind: z.enum(["dataset", "web", "document", "user_note"]),
  /** Who supplied the reference: the user, the planner, or the built-in data layer. */
  addedBy: z.enum(["user", "planner", "system"]).default("user"),
  note: z.string().max(1000).optional(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

/**
 * A factual statement made in narration or on screen. Unsupported claims are
 * allowed in a draft but block rendering until a reviewer either attaches a
 * source or marks the claim illustrative / removes it.
 */
export const claimSchema = z.object({
  text: z.string().trim().min(1).max(500),
  sourceRefIds: z.array(idSchema).default([]),
  status: z.enum(["sourced", "unsupported", "illustrative"]),
});
export type Claim = z.infer<typeof claimSchema>;

export const locationSchema = z.object({
  name: shortText,
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  /** Where the coordinates came from (gazetteer id, user entry, planner). */
  source: z.enum(["gazetteer", "user", "planner"]).default("user"),
  gazetteerId: z.string().max(80).optional(),
});
export type SceneLocation = z.infer<typeof locationSchema>;

export const CAMERA_MOVES = ["static", "zoom_to", "zoom_out", "pan_to", "orbit", "follow_route"] as const;
export const cameraSchema = z.object({
  move: z.enum(CAMERA_MOVES),
  /**
   * Zoom uses a Web-Mercator-like scale: 0 = whole globe, ~4 = country,
   * ~7 = region, ~10 = city. Renderer converts to projection scale.
   */
  zoomStart: z.number().min(0).max(12),
  zoomEnd: z.number().min(0).max(12),
  /** Optional start point for pan_to / zoom_to; defaults to the previous scene's target. */
  from: z
    .object({ latitude: latitudeSchema, longitude: longitudeSchema })
    .optional(),
  easing: z.enum(["linear", "ease_in_out"]).default("ease_in_out"),
  /** 3D view only: camera tilt in degrees (0 = straight down). Defaults to a tilt chosen from the zoom. */
  pitch: z.number().min(0).max(75).optional(),
  /** 3D view only: compass heading in degrees the camera faces (0 = north). */
  bearing: z.number().min(-180).max(180).optional(),
});
export type Camera = z.infer<typeof cameraSchema>;

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const overlaySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("title_card"),
    text: z.string().trim().min(1).max(80),
    subtitle: z.string().trim().max(120).optional(),
  }),
  z.object({
    type: z.literal("location_label"),
    text: shortText,
    latitude: latitudeSchema,
    longitude: longitudeSchema,
  }),
  z.object({
    type: z.literal("marker"),
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    label: shortText.optional(),
    pulse: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("highlight_country"),
    /** ISO 3166-1 alpha-3 code as used by Natural Earth (ADM0_A3). */
    iso3: z.string().regex(/^[A-Z]{3}$/),
    label: shortText.optional(),
    color: colorSchema.optional(),
  }),
  z.object({
    type: z.literal("river"),
    /** Exact feature name in the river dataset (Natural Earth `name`). */
    datasetName: shortText,
    label: shortText.optional(),
    animate: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("route"),
    coordinates: z.array(lonLatSchema).min(2).max(500),
    label: shortText.optional(),
    animate: z.boolean().default(true),
    color: colorSchema.optional(),
  }),
  z.object({
    type: z.literal("arrow"),
    from: lonLatSchema,
    to: lonLatSchema,
    label: shortText.optional(),
  }),
  z.object({
    type: z.literal("legend"),
    items: z.array(z.object({ label: shortText, color: colorSchema })).min(1).max(6),
  }),
]);
export type Overlay = z.infer<typeof overlaySchema>;
export type OverlayType = Overlay["type"];

export const SCENE_STATUSES = ["planned", "edited", "approved"] as const;

/** satellite3d: tilted 3D terrain with satellite imagery; satellite: flat orthographic globe; vector: flat drawn map. */
export const BASEMAPS = ["satellite3d", "satellite", "vector"] as const;
export type Basemap = (typeof BASEMAPS)[number];

export const MIN_SCENE_SECONDS = 2;
export const MAX_SCENE_SECONDS = 30;
export const MAX_PROJECT_SECONDS = 180;
export const MAX_SCENES = 40;

export const sceneSchema = z.object({
  id: idSchema,
  title: z.string().trim().max(120).optional(),
  durationSeconds: z.number().min(MIN_SCENE_SECONDS).max(MAX_SCENE_SECONDS),
  location: locationSchema,
  camera: cameraSchema,
  narration: z.string().max(1200).default(""),
  overlays: z.array(overlaySchema).max(20).default([]),
  claims: z.array(claimSchema).max(20).default([]),
  sourceRefs: z.array(idSchema).max(20).default([]),
  status: z.enum(SCENE_STATUSES).default("planned"),
  /** Monotonic counter bumped on every edit/regeneration of this scene. */
  revision: z.number().int().min(0).default(0),
});
export type Scene = z.infer<typeof sceneSchema>;

export const storyboardSchema = z.object({
  schemaVersion: z.literal(STORYBOARD_SCHEMA_VERSION),
  projectTitle: z.string().trim().min(1).max(140),
  language: languageSchema,
  durationSeconds: z.number().min(MIN_SCENE_SECONDS).max(MAX_PROJECT_SECONDS),
  formats: z.array(aspectFormatSchema).min(1).max(2),
  style: visualStyleSchema.default("documentary"),
  /** Satellite imagery under the overlays, or the flat vector map. */
  basemap: z.enum(BASEMAPS).default("satellite"),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30)]).default(30),
  scenes: z.array(sceneSchema).min(1).max(MAX_SCENES),
  sources: z.array(sourceRefSchema).max(100).default([]),
  planner: z
    .object({
      provider: z.string().max(60),
      model: z.string().max(80).optional(),
      generatedAt: z.string().max(40),
      /** True for the offline gazetteer planner: narration is template text, not AI-written. */
      deterministic: z.boolean().default(false),
      notes: z.array(z.string().max(500)).max(20).default([]),
    })
    .optional(),
});
export type Storyboard = z.infer<typeof storyboardSchema>;
export type StoryboardInput = z.input<typeof storyboardSchema>;

/** Parse unknown data into a storyboard, applying migrations for older versions. */
export function migrateStoryboard(data: unknown): unknown {
  // Only version 1 exists. Future versions add `if (version === n) data = upgrade(data)` steps here.
  return data;
}

export function parseStoryboard(data: unknown) {
  return storyboardSchema.safeParse(migrateStoryboard(data));
}
