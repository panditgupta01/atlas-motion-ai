import { describe, expect, it } from "vitest";
import { checkGeoData, findPlacesInText, getCountryByIso3, getRiverFeatures, searchGazetteer } from "@atlas/geo";
import { parseStoryboard, validateStoryboard } from "@atlas/shared";
import {
  AnthropicPlanner,
  GazetteerPlanner,
  PlannerError,
  normalizeDurations,
  planStoryboard,
  regenerateScene,
  type DraftStoryboard,
  type MessagesClient,
  type PlannerInput,
  type PlannerProvider,
} from "@atlas/storyboard";

const geoReady = checkGeoData().ok;
const input = (prompt: string, language: "en" | "hi" = "en"): PlannerInput => ({
  prompt,
  language,
  durationSeconds: 30,
  formats: ["9:16", "16:9"],
  style: "documentary",
  narration: true,
  sourceUrls: [],
});

describe.skipIf(!geoReady)("gazetteer (requires scripts/fetch-assets.sh data)", () => {
  it("finds countries and rivers in English, with common spellings", () => {
    const names = findPlacesInText("The Koshi, Gandaki and Karnali flow from Nepal into India and join the Ganga.").map((m) => m.hit.name);
    expect(names).toEqual(expect.arrayContaining(["Nepal", "India", "Sapt", "Gandak", "Ghäghara", "Ganges"]));
  });

  it("finds places written in Hindi", () => {
    const names = findPlacesInText("नेपाल से भारत में बहने वाली कोसी और गंडक नदियाँ गंगा में मिलती हैं।").map((m) => m.hit.name);
    expect(names).toEqual(expect.arrayContaining(["Nepal", "India", "Sapt", "Gandak", "Ganges"]));
  });

  it("does not match everyday words that happen to be alternate feature names", () => {
    // Regression: "Bay of Bengal" matched the Philippine lake "Laguna de Bay" via its English alias "Bay".
    const names = findPlacesInText("The river ends at the Bay of Bengal near a new red building.").map((m) => m.hit.name);
    expect(names).not.toContain("Laguna de Bay");
    expect(names).not.toContain("New");
    expect(names).not.toContain("Red");
    expect(findPlacesInText("The Red River floods").map((m) => m.hit.name)).toContain("Red");
  });

  it("searches by prefix and returns coordinates from the dataset", () => {
    const hit = searchGazetteer("kathmandu", 3)[0];
    expect(hit?.name).toBe("Kathmandu");
    expect(hit!.latitude).toBeCloseTo(27.7, 0);
    expect(hit!.longitude).toBeCloseTo(85.3, 0);
    expect(getCountryByIso3("NPL")?.name).toBe("Nepal");
    expect(getRiverFeatures("Ganges").length).toBeGreaterThan(0);
  });

  it("the offline planner builds a valid, renderable storyboard with gazetteer coordinates", async () => {
    const res = await planStoryboard(new GazetteerPlanner(), input("Show how the Koshi river flows from Nepal into India."));
    expect(parseStoryboard(res.storyboard).success).toBe(true);
    expect(res.storyboard.planner?.deterministic).toBe(true);
    expect(res.storyboard.scenes.every((s) => s.location.source === "gazetteer")).toBe(true);
    expect(validateStoryboard(res.storyboard).ok).toBe(true);
    const total = res.storyboard.scenes.reduce((n, s) => n + s.durationSeconds, 0);
    expect(Math.abs(total - 30)).toBeLessThanOrEqual(1);
  });

  it("the offline planner refuses prompts with no recognisable places", async () => {
    await expect(planStoryboard(new GazetteerPlanner(), input("Tell me a story about friendship and courage"))).rejects.toMatchObject({ code: "no_places" });
  });

  it("regenerating a scene keeps its id and duration and bumps the revision", async () => {
    const planner = new GazetteerPlanner();
    const { storyboard } = await planStoryboard(planner, input("Nepal and India"));
    const target = storyboard.scenes[1]!;
    const res = await regenerateScene(planner, input("Nepal and India"), storyboard, target.id);
    const next = res.storyboard.scenes.find((s) => s.id === target.id)!;
    expect(next.durationSeconds).toBe(target.durationSeconds);
    expect(next.revision).toBe(target.revision + 1);
    expect(res.storyboard.scenes.length).toBe(storyboard.scenes.length);
  });

  /** Test double for an LLM planner: first returns an invalid draft, then a valid one. */
  class ScriptedPlanner implements PlannerProvider {
    readonly id = "scripted-test-double";
    readonly label = "Scripted test double";
    readonly deterministic = false;
    feedbackSeen: (string[] | undefined)[] = [];
    constructor(private readonly drafts: DraftStoryboard[]) {}
    isConfigured() {
      return true;
    }
    async draftStoryboard(_input: PlannerInput, feedback?: string[]) {
      this.feedbackSeen.push(feedback);
      return { draft: this.drafts[Math.min(this.feedbackSeen.length - 1, this.drafts.length - 1)]!, usage: { provider: this.id, calls: 1 } };
    }
    async draftScene(): Promise<never> {
      throw new Error("not used");
    }
  }

  const goodScene = { title: "Nepal", durationSeconds: 30, placeName: "Nepal", placeKind: "country" as const, cameraMove: "zoom_to" as const, zoomStart: 1, zoomEnd: 4, narration: "Nepal.", labels: [], highlightCountries: ["NPL"], rivers: [], claims: [] };

  it("feeds problems back to the planner and retries", async () => {
    const planner = new ScriptedPlanner([{ projectTitle: "T", scenes: [], notes: [] }, { projectTitle: "T", scenes: [goodScene], notes: [] }]);
    const res = await planStoryboard(planner, input("Nepal"));
    expect(res.attempts).toBe(2);
    expect(planner.feedbackSeen[1]).toEqual(["The draft had no scenes."]);
  });

  it("gives up after three invalid drafts", async () => {
    const planner = new ScriptedPlanner([{ projectTitle: "T", scenes: [], notes: [] }]);
    await expect(planStoryboard(planner, input("Nepal"))).rejects.toMatchObject({ code: "invalid_output" });
    expect(planner.feedbackSeen.length).toBe(3);
  });

  it("drops country codes that are not in the dataset instead of guessing", async () => {
    const planner = new ScriptedPlanner([{ projectTitle: "T", scenes: [{ ...goodScene, highlightCountries: ["NPL", "XYZ", "Nepal"] }], notes: [] }]);
    const res = await planStoryboard(planner, input("Nepal"));
    expect(res.storyboard.scenes[0]!.overlays.filter((o) => o.type === "highlight_country")).toEqual([{ type: "highlight_country", iso3: "NPL" }]);
  });

  it("turns planner claims without a user-supplied source into unsupported claims", async () => {
    const planner = new ScriptedPlanner([{ projectTitle: "T", scenes: [{ ...goodScene, claims: [{ text: "Nepal has eight of the ten highest peaks." }] }], notes: [] }]);
    const res = await planStoryboard(planner, input("Nepal"));
    expect(res.storyboard.scenes[0]!.claims[0]!.status).toBe("unsupported");
    expect(res.validation.ok).toBe(false);
  });

  it("the Claude planner reports refusals and missing configuration (SDK test double)", async () => {
    expect(new AnthropicPlanner().isConfigured()).toBe(false);
    await expect(new AnthropicPlanner().draftStoryboard(input("Nepal"))).rejects.toBeInstanceOf(PlannerError);
    const refusing = { messages: { parse: async () => ({ stop_reason: "refusal", parsed_output: null, usage: { input_tokens: 1, output_tokens: 1 } }) } } as unknown as MessagesClient;
    await expect(new AnthropicPlanner({ client: refusing }).draftStoryboard(input("Nepal"))).rejects.toMatchObject({ code: "refused" });
  });

  it("the Claude planner output goes through trusted coordinate resolution (SDK test double)", async () => {
    let request: Record<string, unknown> | undefined;
    const client = {
      messages: {
        parse: async (req: Record<string, unknown>) => {
          request = req;
          // The double claims Nepal is at 0,0; trusted code must replace this with gazetteer coordinates.
          return { stop_reason: "end_turn", parsed_output: { projectTitle: "Nepal", scenes: [{ ...goodScene, fallbackLatitude: 0, fallbackLongitude: 0 }], notes: [] }, usage: { input_tokens: 10, output_tokens: 20 } };
        },
      },
    } as unknown as MessagesClient;
    const res = await planStoryboard(new AnthropicPlanner({ client, model: "claude-opus-5-5" }), input("Nepal"));
    expect(request?.model).toBe("claude-opus-5-5");
    const loc = res.storyboard.scenes[0]!.location;
    expect(loc.source).toBe("gazetteer");
    expect(loc.latitude).toBeCloseTo(28.3, 0);
    expect(res.usage.inputTokens).toBe(10);
  });
});

describe("duration normalisation", () => {
  it("scales scene durations to the target in half-second steps", () => {
    const out = normalizeDurations([3, 3, 4], 20);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(20, 5);
    expect(out.every((d) => Math.round(d * 2) === d * 2)).toBe(true);
  });
});
