import {
  MAX_SCENE_SECONDS,
  MIN_SCENE_SECONDS,
  STORYBOARD_SCHEMA_VERSION,
  type Claim,
  type GazetteerHit,
  type Overlay,
  type Scene,
  type SourceRef,
  type Storyboard,
} from "@atlas/shared";
import { NATURAL_EARTH_ATTRIBUTION, getCountryByIso3, searchGazetteer } from "@atlas/geo";
import type { DraftScene, DraftStoryboard, PlannerInput } from "./types.js";

export const NATURAL_EARTH_SOURCE: SourceRef = {
  id: "natural-earth",
  title: "Natural Earth 1:10m and 1:50m vector data (countries, rivers, lakes, populated places)",
  url: "https://www.naturalearthdata.com/",
  kind: "dataset",
  addedBy: "system",
  note: NATURAL_EARTH_ATTRIBUTION,
};

export function userSources(urls: string[]): SourceRef[] {
  return urls.map((url, i) => {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* schema already validated the URL */
    }
    return { id: `user-source-${i + 1}`, title: host, url, kind: "web" as const, addedBy: "user" as const };
  });
}

/** Approximate zoom level that fits a lon/lat bounding box. */
export function zoomForBBox(bbox: [number, number, number, number]): number {
  const span = Math.max(bbox[2] - bbox[0], (bbox[3] - bbox[1]) * 1.4, 0.05);
  return Math.min(10, Math.max(1, Math.log2(360 / span) - 0.6));
}

const KIND_ORDER: Record<DraftScene["placeKind"], GazetteerHit["kind"][]> = {
  country: ["country", "place", "lake", "river"],
  place: ["place", "country", "lake", "river"],
  river: ["river", "lake", "place"],
  lake: ["lake", "river", "place"],
  region: ["country", "place", "lake", "river"],
};

export function resolvePlace(name: string, kind: DraftScene["placeKind"] = "region"): GazetteerHit | undefined {
  const q = name.trim();
  if (!q) return undefined;
  for (const k of KIND_ORDER[kind]) {
    const exact = searchGazetteer(q, 5, [k]).find((h) => h.name.toLowerCase() === q.toLowerCase() || h.nameHi === q);
    if (exact) return exact;
  }
  // Fall back to the best alias/prefix match of the preferred kind only.
  return searchGazetteer(q, 1, [KIND_ORDER[kind][0]!])[0];
}

/**
 * Scale scene durations so they add up to the target, in 0.5 s steps, keeping
 * each scene within the allowed range.
 */
export function normalizeDurations(durations: number[], target: number): number[] {
  if (durations.length === 0) return [];
  const clamp = (d: number) => Math.min(MAX_SCENE_SECONDS, Math.max(MIN_SCENE_SECONDS, d));
  const safe = durations.map((d) => (Number.isFinite(d) && d > 0 ? d : target / durations.length));
  const sum = safe.reduce((a, b) => a + b, 0);
  const scaled = safe.map((d) => clamp(Math.round(((d / sum) * target) * 2) / 2));
  let diff = Math.round((target - scaled.reduce((a, b) => a + b, 0)) * 2) / 2;
  // Distribute the rounding remainder over scenes that still have room.
  for (let guard = 0; Math.abs(diff) >= 0.5 && guard < 1000; guard++) {
    const step = diff > 0 ? 0.5 : -0.5;
    const i = guard % scaled.length;
    const next = scaled[i]! + step;
    if (next >= MIN_SCENE_SECONDS && next <= MAX_SCENE_SECONDS) {
      scaled[i] = next;
      diff -= step;
    }
  }
  return scaled;
}

export interface ResolveContext {
  input: PlannerInput;
  sources: SourceRef[];
  notes: string[];
}

/** Turn one draft scene into a storyboard scene. Unresolvable names are dropped with a note. */
export function resolveDraftScene(draft: DraftScene, id: string, ctx: ResolveContext, revision = 0): Scene {
  const hit = resolvePlace(draft.placeName, draft.placeKind);
  const lang = ctx.input.language;
  let location: Scene["location"];
  if (hit) {
    location = { name: lang === "hi" && hit.nameHi ? hit.nameHi : hit.name, latitude: hit.latitude, longitude: hit.longitude, source: "gazetteer", gazetteerId: hit.id };
  } else if (
    typeof draft.fallbackLatitude === "number" &&
    typeof draft.fallbackLongitude === "number" &&
    Math.abs(draft.fallbackLatitude) <= 90 &&
    Math.abs(draft.fallbackLongitude) <= 180
  ) {
    location = { name: draft.placeName.slice(0, 120) || "Unnamed place", latitude: draft.fallbackLatitude, longitude: draft.fallbackLongitude, source: "planner" };
    ctx.notes.push(`"${draft.placeName}" is not in the gazetteer; its coordinates came from the planner and need checking.`);
  } else {
    // No reliable coordinates: centre on 0,0 so validation flags it instead of guessing.
    location = { name: draft.placeName.slice(0, 120) || "Unknown place", latitude: 0, longitude: 0, source: "planner" };
    ctx.notes.push(`Could not find coordinates for "${draft.placeName}". Set the location of scene "${draft.title}" by hand.`);
  }

  const overlays: Overlay[] = [];
  for (const iso3 of draft.highlightCountries) {
    const code = iso3.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(code) && getCountryByIso3(code)) overlays.push({ type: "highlight_country", iso3: code });
    else ctx.notes.push(`Unknown country code "${iso3}" was dropped.`);
  }
  for (const river of draft.rivers) {
    const r = resolvePlace(river, "river");
    if (r && r.kind === "river") overlays.push({ type: "river", datasetName: r.name, label: river.slice(0, 120), animate: true });
    else ctx.notes.push(`River "${river}" is not in the Natural Earth river dataset, so it is not drawn.`);
  }
  for (const label of draft.labels) {
    const p = resolvePlace(label.placeName);
    if (p && label.text.trim()) {
      const text = label.text.trim().slice(0, 120);
      // Cities get a marker pin; countries, lakes and rivers get a plain label.
      overlays.push(
        p.kind === "place"
          ? { type: "marker", label: text, latitude: p.latitude, longitude: p.longitude, pulse: true }
          : { type: "location_label", text, latitude: p.latitude, longitude: p.longitude },
      );
    } else if (label.text.trim()) {
      ctx.notes.push(`Label "${label.text}" was dropped: "${label.placeName}" could not be located.`);
    }
  }

  const claims: Claim[] = draft.claims.map((c) => {
    const src = c.sourceUrl ? ctx.sources.find((s) => s.url === c.sourceUrl) : undefined;
    if (c.sourceUrl && !src) ctx.notes.push(`A claim cited ${c.sourceUrl}, which the user did not supply; it is marked unsupported.`);
    return { text: c.text.slice(0, 500), sourceRefIds: src ? [src.id] : [], status: src ? "sourced" : "unsupported" };
  });

  const clampZoom = (z: number) => (Number.isFinite(z) ? Math.round(Math.min(12, Math.max(0, z)) * 100) / 100 : 3);
  return {
    id,
    title: draft.title.slice(0, 120),
    durationSeconds: draft.durationSeconds,
    location,
    camera: { move: draft.cameraMove, zoomStart: clampZoom(draft.zoomStart), zoomEnd: clampZoom(draft.zoomEnd), easing: "ease_in_out" },
    narration: ctx.input.narration ? draft.narration.slice(0, 1200) : "",
    overlays,
    claims,
    sourceRefs: [NATURAL_EARTH_SOURCE.id, ...new Set(claims.flatMap((c) => c.sourceRefIds))],
    status: "planned",
    revision,
  };
}

export function sceneId(index: number): string {
  return `scene-${String(index + 1).padStart(3, "0")}`;
}

export function draftToStoryboard(
  draft: DraftStoryboard,
  input: PlannerInput,
  planner: Storyboard["planner"],
): Storyboard {
  const sources = [NATURAL_EARTH_SOURCE, ...userSources(input.sourceUrls)];
  const notes = [...draft.notes.map((n) => n.slice(0, 500))];
  const ctx: ResolveContext = { input, sources, notes };
  const durations = normalizeDurations(
    draft.scenes.map((s) => s.durationSeconds),
    input.durationSeconds,
  );
  const scenes = draft.scenes.map((s, i) => resolveDraftScene({ ...s, durationSeconds: durations[i]! }, sceneId(i), ctx));
  return {
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    projectTitle: (input.title ?? draft.projectTitle).slice(0, 140) || "Untitled map story",
    language: input.language,
    durationSeconds: input.durationSeconds,
    formats: input.formats,
    style: input.style,
    basemap: "satellite",
    fps: 30,
    scenes,
    sources,
    planner: planner ? { ...planner, notes: [...planner.notes, ...notes].slice(0, 20) } : undefined,
  };
}
