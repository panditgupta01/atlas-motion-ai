import { findPlacesInText, type TextMatch } from "@atlas/geo";
import type { Scene, Storyboard } from "@atlas/shared";
import { zoomForBBox } from "./resolve.js";
import { PlannerError, type DraftScene, type DraftStoryboard, type PlannerInput, type PlannerProvider } from "./types.js";

/**
 * Offline planner that needs no API key. It finds places named in the prompt
 * (English or Hindi) in the Natural Earth gazetteer and lays out a camera
 * sequence around them. It does not write documentary narration: narration is
 * neutral template text that names each place, for the user to replace.
 * It is deterministic, so it is also the planner used by automated tests.
 */
export class GazetteerPlanner implements PlannerProvider {
  readonly id = "gazetteer";
  readonly label = "Offline gazetteer planner (no AI; template narration)";
  readonly deterministic = true;

  isConfigured(): boolean {
    return true;
  }

  private displayName(m: TextMatch, input: PlannerInput): string {
    if (input.language === "hi" && m.hit.nameHi) return m.hit.nameHi;
    // Keep the user's own spelling (e.g. "Koshi" for the dataset's "Sapt").
    const own = input.prompt.slice(m.index, m.index + m.matched.length);
    return own.trim() ? own : m.hit.name;
  }

  private narrationFor(kind: "intro" | "country" | "river" | "place" | "lake" | "outro", name: string, input: PlannerInput): string {
    if (!input.narration) return "";
    const hi: Record<typeof kind, string> = {
      intro: `${name} की ओर चलते हैं।`,
      country: `यह ${name} है।`,
      river: `यह ${name} नदी है।`,
      place: `यह ${name} है।`,
      lake: `यह ${name} है।`,
      outro: `${name} का एक विहंगम दृश्य।`,
    };
    const en: Record<typeof kind, string> = {
      intro: `Let's travel to ${name}.`,
      country: `This is ${name}.`,
      river: `This is the ${name} river.`,
      place: `This is ${name}.`,
      lake: `This is ${name}.`,
      outro: `A wider view of ${name}.`,
    };
    return (input.language === "hi" ? hi : en)[kind];
  }

  private sceneFor(m: TextMatch, input: PlannerInput, primary: TextMatch): DraftScene {
    const name = this.displayName(m, input);
    const fit = m.hit.bbox ? zoomForBBox(m.hit.bbox) : 6.5;
    const base: Omit<DraftScene, "title" | "cameraMove" | "zoomStart" | "zoomEnd" | "narration" | "highlightCountries" | "rivers" | "labels"> = {
      durationSeconds: 6,
      placeName: m.hit.name,
      placeKind: m.hit.kind === "country" ? "country" : m.hit.kind,
      claims: [],
    };
    const countryHighlight = primary.hit.kind === "country" && primary.hit.iso3 ? [primary.hit.iso3] : [];
    switch (m.hit.kind) {
      case "country":
        return { ...base, title: m.hit.name, cameraMove: "zoom_to", zoomStart: Math.max(1, fit - 1.5), zoomEnd: fit, narration: this.narrationFor("country", name, input), highlightCountries: m.hit.iso3 ? [m.hit.iso3] : [], rivers: [], labels: [{ text: name, placeName: m.hit.name }] };
      case "river":
        return { ...base, durationSeconds: 7, title: `${name} river`, cameraMove: "follow_route", zoomStart: fit, zoomEnd: Math.min(10, fit + 0.6), narration: this.narrationFor("river", name, input), highlightCountries: countryHighlight, rivers: [name], labels: [] };
      case "lake":
        return { ...base, title: m.hit.name, cameraMove: "zoom_to", zoomStart: fit - 1, zoomEnd: fit, narration: this.narrationFor("lake", name, input), highlightCountries: countryHighlight, rivers: [], labels: [{ text: name, placeName: m.hit.name }] };
      case "place":
        return { ...base, title: m.hit.name, cameraMove: "zoom_to", zoomStart: 4.5, zoomEnd: 6, narration: this.narrationFor("place", name, input), highlightCountries: countryHighlight, rivers: [], labels: [{ text: name, placeName: m.hit.name }] };
    }
  }

  async draftStoryboard(input: PlannerInput): Promise<{ draft: DraftStoryboard; usage: { provider: string; calls: number } }> {
    const matches = findPlacesInText(input.prompt).slice(0, 8);
    if (matches.length === 0) {
      throw new PlannerError(
        "No known countries, cities, rivers or lakes were found in the prompt. Name at least one place (for example \"Nepal\" or \"Ganges\"), or configure an AI planner.",
        "no_places",
      );
    }
    const primary = matches.find((m) => m.hit.kind === "country") ?? matches[0]!;
    const primaryName = this.displayName(primary, input);
    const primaryFit = primary.hit.bbox ? zoomForBBox(primary.hit.bbox) : 5;

    const scenes: DraftScene[] = [
      {
        title: "Opening",
        durationSeconds: 6,
        placeName: primary.hit.name,
        placeKind: primary.hit.kind === "country" ? "country" : primary.hit.kind,
        cameraMove: "zoom_to",
        zoomStart: 0.6,
        zoomEnd: Math.max(1.5, primaryFit - 1.5),
        narration: this.narrationFor("intro", primaryName, input),
        labels: [],
        highlightCountries: [],
        rivers: [],
        claims: [],
      },
    ];
    for (const m of matches) scenes.push(this.sceneFor(m, input, primary));
    scenes.push({
      title: "Closing",
      durationSeconds: 5,
      placeName: primary.hit.name,
      placeKind: primary.hit.kind === "country" ? "country" : primary.hit.kind,
      cameraMove: "zoom_out",
      zoomStart: primaryFit,
      zoomEnd: Math.max(1, primaryFit - 2),
      narration: this.narrationFor("outro", primaryName, input),
      labels: [],
      highlightCountries: primary.hit.iso3 && primary.hit.kind === "country" ? [primary.hit.iso3] : [],
      rivers: [],
      claims: [],
    });

    // Long videos: give each found place more time rather than inventing extra scenes.
    const titleBase = input.title ?? `${primary.hit.name}: a map story`;
    const notes = [
      "Planned offline from place names in your prompt. Narration is placeholder text that only names each place: write the documentary narration yourself, or configure an AI planner (ANTHROPIC_API_KEY).",
    ];
    const unmatchedHints = /basin|terrain|himalaya|monsoon|flood/i.test(input.prompt)
      ? ["Basin outlines, terrain relief and flood extents are not in the bundled datasets, so they are not drawn."]
      : [];
    return {
      draft: { projectTitle: titleBase, scenes, notes: [...notes, ...unmatchedHints] },
      usage: { provider: this.id, calls: 0 },
    };
  }

  async draftScene(input: PlannerInput, _storyboard: Storyboard, scene: Scene, instructions?: string): Promise<{ draft: DraftScene; usage: { provider: string; calls: number } }> {
    // Re-derive the scene from places named in the instructions, else from the scene's own location.
    const text = [instructions ?? "", scene.location.name].join(" ");
    const matches = findPlacesInText(text);
    const m = matches[0];
    if (!m) {
      throw new PlannerError(`No known place found in "${text.trim()}". Name a country, city, river or lake.`, "no_places");
    }
    const draft = this.sceneFor(m, input, m);
    return { draft: { ...draft, durationSeconds: scene.durationSeconds }, usage: { provider: this.id, calls: 0 } };
  }
}
