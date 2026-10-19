import type { Scene, Storyboard } from "@atlas/shared";

/**
 * Hand-written storyboard fixture. Coordinates are the Natural Earth gazetteer
 * values for Nepal and India so geographic checks pass; it is test data, not planner output.
 */
export function sceneFixture(overrides: Partial<Scene> = {}): Scene {
  return {
    id: "scene-001",
    title: "Nepal",
    durationSeconds: 5,
    location: { name: "Nepal", latitude: 28.2979, longitude: 83.6399, source: "gazetteer", gazetteerId: "country:NPL" },
    camera: { move: "zoom_to", zoomStart: 1, zoomEnd: 4, easing: "ease_in_out" },
    narration: "Nepal lies between China and India.",
    overlays: [{ type: "highlight_country", iso3: "NPL", label: "Nepal" }],
    claims: [],
    sourceRefs: [],
    status: "planned",
    revision: 0,
    ...overrides,
  };
}

export function storyboardFixture(overrides: Partial<Storyboard> = {}): Storyboard {
  return {
    schemaVersion: 1,
    projectTitle: "Test map story",
    language: "en",
    durationSeconds: 10,
    formats: ["9:16", "16:9"],
    style: "documentary",
    fps: 30,
    scenes: [
      sceneFixture(),
      sceneFixture({
        id: "scene-002",
        title: "India",
        location: { name: "India", latitude: 22.9, longitude: 79.6, source: "gazetteer", gazetteerId: "country:IND" },
        camera: { move: "pan_to", zoomStart: 4, zoomEnd: 3.5, easing: "ease_in_out" },
        narration: "To the south lies India.",
        overlays: [{ type: "highlight_country", iso3: "IND" }],
      }),
    ],
    sources: [{ id: "natural-earth", title: "Natural Earth", url: "https://www.naturalearthdata.com/", kind: "dataset", addedBy: "system" }],
    ...overrides,
  };
}
