import { parseStoryboard, validateStoryboard, type Storyboard, type StoryboardValidationResult } from "@atlas/shared";
import { draftToStoryboard, resolveDraftScene, NATURAL_EARTH_SOURCE, userSources } from "./resolve.js";
import { PlannerError, type PlannerInput, type PlannerProvider, type PlannerUsage } from "./types.js";

export interface PlanResult {
  storyboard: Storyboard;
  validation: StoryboardValidationResult;
  usage: PlannerUsage;
  attempts: number;
}

const MAX_ATTEMPTS = 3;

function mergeUsage(a: PlannerUsage | undefined, b: PlannerUsage): PlannerUsage {
  if (!a) return b;
  return {
    provider: b.provider,
    model: b.model ?? a.model,
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0) || undefined,
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0) || undefined,
    calls: a.calls + b.calls,
  };
}

/**
 * Generate a storyboard and validate it. Schema failures are fed back to the
 * provider for repair (up to MAX_ATTEMPTS). Semantic warnings and review-level
 * errors (e.g. unsupported claims) are returned for the human review step,
 * not retried, because only a person can resolve them.
 */
export async function planStoryboard(provider: PlannerProvider, input: PlannerInput): Promise<PlanResult> {
  if (!provider.isConfigured()) {
    throw new PlannerError(`Planner "${provider.label}" is not configured.`, "not_configured");
  }
  let feedback: string[] | undefined;
  let usage: PlannerUsage | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await provider.draftStoryboard(input, feedback);
    usage = mergeUsage(usage, res.usage);
    if (res.draft.scenes.length === 0) {
      feedback = ["The draft had no scenes."];
      continue;
    }
    const built = draftToStoryboard(res.draft, input, {
      provider: provider.id,
      model: res.model,
      generatedAt: new Date().toISOString(),
      deterministic: provider.deterministic,
      notes: [],
    });
    const parsed = parseStoryboard(built);
    if (parsed.success) {
      return { storyboard: parsed.data, validation: validateStoryboard(parsed.data), usage, attempts: attempt };
    }
    feedback = parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".")}: ${i.message}`);
  }
  throw new PlannerError(`The planner did not produce a valid storyboard after ${MAX_ATTEMPTS} attempts.`, "invalid_output", feedback);
}

export interface RegenerateResult {
  storyboard: Storyboard;
  validation: StoryboardValidationResult;
  usage: PlannerUsage;
}

/**
 * Replace one scene. Its id, position and duration are kept so the rest of the
 * storyboard (and cached renders of other scenes) stay valid. Sources the
 * scene referenced remain in the storyboard so provenance is not lost.
 */
export async function regenerateScene(
  provider: PlannerProvider,
  input: PlannerInput,
  storyboard: Storyboard,
  sceneId: string,
  instructions?: string,
): Promise<RegenerateResult> {
  const index = storyboard.scenes.findIndex((s) => s.id === sceneId);
  const scene = storyboard.scenes[index];
  if (!scene) throw new PlannerError(`Scene "${sceneId}" does not exist.`, "invalid_output");
  if (!provider.isConfigured()) throw new PlannerError(`Planner "${provider.label}" is not configured.`, "not_configured");

  let feedback: string[] | undefined;
  let usage: PlannerUsage | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await provider.draftScene(input, storyboard, scene, instructions, feedback);
    usage = mergeUsage(usage, res.usage);
    const sources = storyboard.sources.length ? storyboard.sources : [NATURAL_EARTH_SOURCE, ...userSources(input.sourceUrls)];
    const notes: string[] = [];
    const next = resolveDraftScene({ ...res.draft, durationSeconds: scene.durationSeconds }, scene.id, { input, sources, notes }, scene.revision + 1);
    const candidate: Storyboard = {
      ...storyboard,
      sources,
      scenes: storyboard.scenes.map((s, i) => (i === index ? next : s)),
      planner: storyboard.planner
        ? { ...storyboard.planner, notes: [...storyboard.planner.notes, ...notes.map((n) => `${scene.id}: ${n}`)].slice(-20) }
        : undefined,
    };
    const parsed = parseStoryboard(candidate);
    if (parsed.success) {
      return { storyboard: parsed.data, validation: validateStoryboard(parsed.data), usage };
    }
    feedback = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`);
  }
  throw new PlannerError(`Could not regenerate scene "${sceneId}" after ${MAX_ATTEMPTS} attempts.`, "invalid_output", feedback);
}
