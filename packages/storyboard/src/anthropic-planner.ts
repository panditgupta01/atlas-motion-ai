import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { findPlacesInText } from "@atlas/geo";
import type { Scene, Storyboard } from "@atlas/shared";
import { z } from "zod";
import {
  PlannerError,
  draftSceneSchema,
  draftStoryboardSchema,
  type DraftScene,
  type DraftStoryboard,
  type PlannerInput,
  type PlannerProvider,
  type PlannerUsage,
} from "./types.js";

const SYSTEM_PROMPT = `You plan short geographic explainer videos made of animated map scenes.
You only output storyboard data; trusted application code renders it.

Rules:
- Name places in English (countries, cities, rivers, lakes) so they can be matched to the Natural Earth gazetteer. Give fallback coordinates only for places that are not well-known countries, cities, rivers or lakes.
- Never invent statistics, dates, casualty figures, event locations or sources. If a fact needs a number you are not certain of, leave the number out.
- List every factual statement made in a scene's narration in that scene's "claims". Attach a sourceUrl only when it is one of the URLs the user supplied; otherwise leave it empty so a human reviewer can check the claim.
- Narration and on-screen labels are written in the requested language. Keep labels to a few words.
- Scene durations should add up to the requested total duration. Keep each scene between 3 and 12 seconds. Narration must be speakable within its scene (about 2.5 words per second in English, 2.2 in Hindi).
- Camera zoom: 0 = whole globe, 4 = a country, 7 = a region, 10 = a city.
- Only use cameraMove "follow_route" when the scene draws a river.
- Put caveats for the human reviewer in "notes", for example data the map cannot show (basins, terrain, flood extents).`;

/** Minimal surface of the SDK client the planner uses, so tests can pass a double. */
export interface MessagesClient {
  messages: {
    parse: Anthropic["messages"]["parse"];
  };
}

export interface AnthropicPlannerOptions {
  apiKey?: string;
  model?: string;
  client?: MessagesClient;
  maxTokens?: number;
}

export class AnthropicPlanner implements PlannerProvider {
  readonly id = "anthropic";
  readonly label = "Claude (Anthropic API)";
  readonly deterministic = false;
  private readonly model: string;
  private readonly apiKey?: string;
  private client?: MessagesClient;
  private readonly maxTokens: number;

  constructor(opts: AnthropicPlannerOptions = {}) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "claude-opus-5-5";
    this.client = opts.client;
    this.maxTokens = opts.maxTokens ?? 16000;
  }

  isConfigured(): boolean {
    return Boolean(this.client ?? this.apiKey);
  }

  private getClient(): MessagesClient {
    if (this.client) return this.client;
    if (!this.apiKey) throw new PlannerError("The Claude planner needs ANTHROPIC_API_KEY on the server.", "not_configured");
    this.client = new Anthropic({ apiKey: this.apiKey, maxRetries: 2, timeout: 180_000 });
    return this.client;
  }

  private describeInput(input: PlannerInput): string {
    const found = findPlacesInText(input.prompt)
      .slice(0, 12)
      .map((m) => `${m.hit.kind}: ${m.hit.name}${m.hit.iso3 ? ` (${m.hit.iso3})` : ""}`);
    return [
      `Request: ${input.prompt}`,
      `Language: ${input.language === "hi" ? "Hindi" : "English"}`,
      `Total duration: ${input.durationSeconds} seconds`,
      `Formats: ${input.formats.join(", ")}`,
      `Style: ${input.style}`,
      `Narration: ${input.narration ? "yes" : "no (leave narration empty)"}`,
      `User-supplied source URLs: ${input.sourceUrls.length ? input.sourceUrls.join(", ") : "none"}`,
      `Places already recognised in the request: ${found.length ? found.join("; ") : "none"}`,
    ].join("\n");
  }

  private async call<T extends z.ZodType>(schema: T, user: string): Promise<{ output: z.infer<T>; usage: PlannerUsage }> {
    const client = this.getClient();
    let response;
    try {
      response = await client.messages.parse({
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: user }],
        output_config: { format: zodOutputFormat(schema), effort: "medium" },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new PlannerError("The Anthropic API rejected the API key. Check ANTHROPIC_API_KEY.", "not_configured");
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new PlannerError("The Anthropic API is rate limiting requests. Try again shortly.", "provider_error");
      }
      if (err instanceof Anthropic.APIError) {
        throw new PlannerError(`Anthropic API error ${err.status ?? ""}: ${err.message}`, "provider_error");
      }
      throw new PlannerError(`Could not reach the Anthropic API: ${(err as Error).message}`, "provider_error");
    }
    const usage: PlannerUsage = {
      provider: this.id,
      model: this.model,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      calls: 1,
    };
    if (response.stop_reason === "refusal") {
      throw new PlannerError("The model declined to plan this request.", "refused", response.stop_details ?? undefined);
    }
    if (response.stop_reason === "max_tokens") {
      throw new PlannerError("The planner's output was cut off before it finished.", "invalid_output");
    }
    if (!response.parsed_output) {
      throw new PlannerError("The planner returned output that does not match the storyboard draft schema.", "invalid_output");
    }
    return { output: response.parsed_output as z.infer<T>, usage };
  }

  async draftStoryboard(input: PlannerInput, feedback?: string[]): Promise<{ draft: DraftStoryboard; usage: PlannerUsage; model: string }> {
    const extra = feedback?.length ? `\n\nYour previous draft had these problems; fix them:\n- ${feedback.join("\n- ")}` : "";
    const { output, usage } = await this.call(draftStoryboardSchema, this.describeInput(input) + extra);
    return { draft: output, usage, model: this.model };
  }

  async draftScene(
    input: PlannerInput,
    storyboard: Storyboard,
    scene: Scene,
    instructions?: string,
    feedback?: string[],
  ): Promise<{ draft: DraftScene; usage: PlannerUsage; model: string }> {
    const index = storyboard.scenes.findIndex((s) => s.id === scene.id);
    const neighbours = storyboard.scenes
      .map((s, i) => `${i + 1}. ${s.title ?? s.location.name} (${s.durationSeconds}s): ${s.narration.slice(0, 200)}`)
      .join("\n");
    const prompt = [
      this.describeInput(input),
      `\nStoryboard so far:\n${neighbours}`,
      `\nRewrite scene ${index + 1} only. Keep it ${scene.durationSeconds} seconds long.`,
      instructions ? `Reviewer instructions: ${instructions}` : "Improve it while keeping the same subject.",
      feedback?.length ? `Problems with your previous attempt:\n- ${feedback.join("\n- ")}` : "",
    ].join("\n");
    const { output, usage } = await this.call(draftSceneSchema, prompt);
    return { draft: output, usage, model: this.model };
  }
}
