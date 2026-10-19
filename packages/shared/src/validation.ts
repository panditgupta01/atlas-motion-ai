import type { Language, Scene, Storyboard } from "./storyboard.js";

export type IssueSeverity = "error" | "warning";

export interface StoryboardIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  sceneId?: string;
  path?: string;
}

export interface StoryboardValidationResult {
  ok: boolean;
  /** Errors block rendering. Warnings are shown in the editor but do not block. */
  errors: StoryboardIssue[];
  warnings: StoryboardIssue[];
}

/**
 * Allowed difference between the sum of scene durations and the target duration:
 * the larger of 1 second or 5% of the target.
 */
export function durationToleranceSeconds(targetSeconds: number): number {
  return Math.max(1, targetSeconds * 0.05);
}

/**
 * Conservative speaking rates used to estimate narration length. These are
 * planning heuristics, not measurements; the real narration duration comes
 * from the generated audio file.
 */
const WORDS_PER_SECOND: Record<Language, number> = { en: 2.5, hi: 2.2 };

export function estimateNarrationSeconds(text: string, language: Language): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return Math.round((words / WORDS_PER_SECOND[language]) * 10) / 10;
}

function sceneFingerprint(scene: Scene): string {
  return JSON.stringify([
    scene.location.latitude.toFixed(3),
    scene.location.longitude.toFixed(3),
    scene.camera.move,
    scene.camera.zoomStart,
    scene.camera.zoomEnd,
    scene.narration.trim(),
    scene.overlays,
  ]);
}

export function validateStoryboard(sb: Storyboard): StoryboardValidationResult {
  const errors: StoryboardIssue[] = [];
  const warnings: StoryboardIssue[] = [];

  const total = sb.scenes.reduce((s, sc) => s + sc.durationSeconds, 0);
  const tolerance = durationToleranceSeconds(sb.durationSeconds);
  if (Math.abs(total - sb.durationSeconds) > tolerance) {
    errors.push({
      severity: "error",
      code: "duration_mismatch",
      message: `Scenes add up to ${total.toFixed(1)}s but the target is ${sb.durationSeconds}s (allowed difference ±${tolerance.toFixed(1)}s).`,
      path: "scenes",
    });
  }

  const ids = new Set<string>();
  const fingerprints = new Map<string, string>();
  const sourceIds = new Set(sb.sources.map((s) => s.id));
  const seenSourceIds = new Set<string>();
  for (const s of sb.sources) {
    if (seenSourceIds.has(s.id)) {
      errors.push({ severity: "error", code: "duplicate_source_id", message: `Source id "${s.id}" is used twice.`, path: "sources" });
    }
    seenSourceIds.add(s.id);
  }

  sb.scenes.forEach((scene, index) => {
    const where = { sceneId: scene.id };
    const label = `Scene ${index + 1}`;
    if (ids.has(scene.id)) {
      errors.push({ severity: "error", code: "duplicate_scene_id", message: `${label} reuses id "${scene.id}".`, ...where });
    }
    ids.add(scene.id);

    const fp = sceneFingerprint(scene);
    const dup = fingerprints.get(fp);
    if (dup) {
      warnings.push({ severity: "warning", code: "duplicate_scene", message: `${label} looks identical to scene "${dup}".`, ...where });
    } else {
      fingerprints.set(fp, scene.id);
    }

    if (scene.location.latitude === 0 && scene.location.longitude === 0) {
      warnings.push({
        severity: "warning",
        code: "null_island",
        message: `${label} is centred on 0°, 0° (Gulf of Guinea). This usually means coordinates are missing.`,
        ...where,
      });
    }
    if (Math.abs(scene.location.latitude) > 85) {
      warnings.push({ severity: "warning", code: "polar_location", message: `${label} is near a pole; framing may be distorted.`, ...where });
    }
    if (scene.location.source === "planner") {
      warnings.push({
        severity: "warning",
        code: "unverified_coordinates",
        message: `${label}: coordinates for "${scene.location.name}" came from the AI planner and were not matched in the gazetteer. Check them.`,
        ...where,
      });
    }

    if (scene.camera.move === "zoom_to" && scene.camera.zoomEnd <= scene.camera.zoomStart) {
      warnings.push({ severity: "warning", code: "camera_zoom_direction", message: `${label}: "zoom_to" should end closer than it starts.`, ...where });
    }
    if (scene.camera.move === "zoom_out" && scene.camera.zoomEnd >= scene.camera.zoomStart) {
      warnings.push({ severity: "warning", code: "camera_zoom_direction", message: `${label}: "zoom_out" should end further out than it starts.`, ...where });
    }
    if (scene.camera.move === "follow_route" && !scene.overlays.some((o) => o.type === "route" || o.type === "river")) {
      errors.push({ severity: "error", code: "route_missing", message: `${label}: "follow_route" needs a route or river overlay.`, ...where });
    }

    const narrationSeconds = estimateNarrationSeconds(scene.narration, sb.language);
    if (narrationSeconds > scene.durationSeconds + 0.5) {
      warnings.push({
        severity: "warning",
        code: "narration_too_long",
        message: `${label}: narration needs about ${narrationSeconds}s but the scene is ${scene.durationSeconds}s.`,
        ...where,
      });
    }

    for (const ref of scene.sourceRefs) {
      if (!sourceIds.has(ref)) {
        errors.push({ severity: "error", code: "unknown_source", message: `${label} references unknown source "${ref}".`, ...where });
      }
    }
    scene.claims.forEach((claim, ci) => {
      for (const ref of claim.sourceRefIds) {
        if (!sourceIds.has(ref)) {
          errors.push({ severity: "error", code: "unknown_source", message: `${label}, claim ${ci + 1} references unknown source "${ref}".`, ...where });
        }
      }
      if (claim.status === "sourced" && claim.sourceRefIds.length === 0) {
        errors.push({ severity: "error", code: "claim_without_source", message: `${label}, claim ${ci + 1} is marked sourced but has no source.`, ...where });
      }
      if (claim.status === "unsupported") {
        errors.push({
          severity: "error",
          code: "unsupported_claim",
          message: `${label}: "${claim.text.slice(0, 80)}" has no source. Add a source, mark it illustrative, or remove it before rendering.`,
          ...where,
        });
      }
    });

    const titleCards = scene.overlays.filter((o) => o.type === "title_card").length;
    if (titleCards > 1) {
      warnings.push({ severity: "warning", code: "multiple_title_cards", message: `${label} has ${titleCards} title cards; only the first is shown.`, ...where });
    }
    if (scene.overlays.length > 8) {
      warnings.push({ severity: "warning", code: "crowded_scene", message: `${label} has ${scene.overlays.length} overlays and may be hard to read on a phone.`, ...where });
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}
