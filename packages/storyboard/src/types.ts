import { z } from "zod";
import type { AspectFormat, Language, Scene, Storyboard, VisualStyle } from "@atlas/shared";

export interface PlannerInput {
  prompt: string;
  title?: string;
  language: Language;
  durationSeconds: number;
  formats: AspectFormat[];
  style: VisualStyle;
  narration: boolean;
  sourceUrls: string[];
}

export interface PlannerUsage {
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  calls: number;
}

/**
 * The planner's draft: what an LLM (or the offline planner) is allowed to
 * decide. It names places; trusted code resolves names to coordinates through
 * the gazetteer and builds the validated storyboard. The model never produces
 * commands or code, only this data.
 */
export const draftSceneSchema = z.object({
  title: z.string().describe("Short scene title, a few words"),
  durationSeconds: z.number().describe("Scene length in seconds, between 2 and 30"),
  placeName: z.string().describe("The main place this scene shows: a country, city, river or lake name in English"),
  placeKind: z.enum(["country", "place", "river", "lake", "region"]),
  fallbackLatitude: z.number().optional().describe("Only if the place is not a well-known country/city/river/lake"),
  fallbackLongitude: z.number().optional(),
  cameraMove: z.enum(["static", "zoom_to", "zoom_out", "pan_to", "orbit", "follow_route"]),
  zoomStart: z.number().describe("0 = whole globe, 4 = country, 7 = region, 10 = city"),
  zoomEnd: z.number(),
  narration: z.string().describe("Narration in the project language. Empty string if narration is disabled."),
  labels: z
    .array(z.object({ text: z.string(), placeName: z.string() }))
    .describe("On-screen labels in the project language, each pinned to a named place"),
  highlightCountries: z.array(z.string()).describe("ISO 3166-1 alpha-3 codes of countries to highlight"),
  rivers: z.array(z.string()).describe("River names (English) to draw and animate"),
  claims: z
    .array(
      z.object({
        text: z.string().describe("A factual statement made in this scene"),
        sourceUrl: z.string().optional().describe("Only a URL the user supplied; never invent URLs"),
      }),
    )
    .describe("Every factual claim in the narration, so a reviewer can check it"),
});
export type DraftScene = z.infer<typeof draftSceneSchema>;

export const draftStoryboardSchema = z.object({
  projectTitle: z.string(),
  scenes: z.array(draftSceneSchema),
  notes: z.array(z.string()).describe("Caveats for the human reviewer, e.g. data you could not place"),
});
export type DraftStoryboard = z.infer<typeof draftStoryboardSchema>;

export interface PlannerProvider {
  readonly id: string;
  readonly label: string;
  /** False when required configuration (API key) is missing. */
  isConfigured(): boolean;
  /** True when narration is written from templates rather than by a language model. */
  readonly deterministic: boolean;
  draftStoryboard(input: PlannerInput, feedback?: string[]): Promise<{ draft: DraftStoryboard; usage: PlannerUsage; model?: string }>;
  draftScene(
    input: PlannerInput,
    storyboard: Storyboard,
    scene: Scene,
    instructions: string | undefined,
    feedback?: string[],
  ): Promise<{ draft: DraftScene; usage: PlannerUsage; model?: string }>;
}

export class PlannerError extends Error {
  constructor(
    message: string,
    public readonly code: "not_configured" | "no_places" | "invalid_output" | "provider_error" | "refused",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PlannerError";
  }
}
