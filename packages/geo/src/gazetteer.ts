import type { Feature, Geometry, LineString, MultiLineString, Position } from "geojson";
import type { GazetteerHit } from "@atlas/shared";
import { loadDataset, type BBox, type PreparedFeature } from "./data.js";

export interface GazetteerEntry extends GazetteerHit {
  /** Lower-cased names and aliases used for matching. */
  keys: string[];
  /** Ranking weight; lower is more prominent. */
  rank: number;
}

/**
 * Curated name equivalences for rivers whose Natural Earth names differ from
 * common English/Hindi usage. Each maps a common name to the exact dataset
 * name. Keep this list small and only add well-established equivalences.
 */
export const RIVER_ALIASES: Record<string, string> = {
  koshi: "Sapt",
  kosi: "Sapt",
  "sapta koshi": "Sapt",
  "sapt kosi": "Sapt",
  ganga: "Ganges",
  karnali: "Ghäghara",
  ghaghara: "Ghäghara",
  gandaki: "Gandak",
  narayani: "Gandak",
  teesta: "Tista",
  "yarlung tsangpo": "Yarlung",
  // Hindi names. Natural Earth has no name_hi for rivers, so common Devanagari spellings map to the dataset names.
  "कोसी": "Sapt",
  "कोशी": "Sapt",
  "सप्तकोशी": "Sapt",
  "गंडक": "Gandak",
  "गंडकी": "Gandak",
  "नारायणी": "Gandak",
  "करनाली": "Ghäghara",
  "घाघरा": "Ghäghara",
  "गंगा": "Ganges",
  "यमुना": "Yamuna",
  "ब्रह्मपुत्र": "Brahmaputra",
  "तीस्ता": "Tista",
  "सिंधु": "Indus",
  "कृष्णा": "Krishna",
  "नर्मदा": "Narmada",
  "कावेरी": "Cauvery",
  "चंबल": "Chambal",
  "सतलुज": "Sutlej",
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function bboxCenter(b: BBox): [number, number] {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** A representative point on a line: the vertex at half the cumulative vertex count. */
function lineMidpoint(g: Geometry): Position | undefined {
  const lines: Position[][] =
    g.type === "LineString" ? [(g as LineString).coordinates] : g.type === "MultiLineString" ? (g as MultiLineString).coordinates : [];
  const all = lines.flat();
  return all[Math.floor(all.length / 2)];
}

function mergeBBox(a: BBox | undefined, b: BBox): BBox {
  if (!a) return [...b] as BBox;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

let entries: GazetteerEntry[] | null = null;

export function buildGazetteer(): GazetteerEntry[] {
  if (entries) return entries;
  const out: GazetteerEntry[] = [];

  for (const { feature, bbox } of loadDataset("countries10m")) {
    const p = feature.properties;
    const name = str(p.NAME);
    const iso3 = str(p.ADM0_A3);
    const lon = num(p.LABEL_X);
    const lat = num(p.LABEL_Y);
    if (!name || !iso3 || lon === undefined || lat === undefined) continue;
    const nameHi = str(p.NAME_HI);
    const keys = new Set([name, str(p.NAME_LONG), str(p.ADMIN), str(p.NAME_EN), nameHi].filter(Boolean).map((k) => k!.toLowerCase()));
    out.push({ id: `country:${iso3}`, kind: "country", name, nameHi, latitude: lat, longitude: lon, iso3, bbox, keys: [...keys], rank: num(p.LABELRANK) ?? 5 });
  }

  for (const { feature } of loadDataset("places10m")) {
    const p = feature.properties;
    const name = str(p.name);
    const lat = num(p.latitude);
    const lon = num(p.longitude);
    if (!name || lat === undefined || lon === undefined) continue;
    const keys = new Set([name, str(p.nameascii), str(p.namealt)].filter(Boolean).map((k) => k!.toLowerCase()));
    out.push({
      id: `place:${num(p.ne_id) ?? `${name}-${lat}-${lon}`}`,
      kind: "place",
      name,
      latitude: lat,
      longitude: lon,
      iso3: str(p.adm0_a3),
      country: str(p.adm0name),
      keys: [...keys],
      rank: 6 + (num(p.scalerank) ?? 10),
    });
  }

  const rivers = new Map<string, { bbox?: BBox; mid?: Position; rank: number; alt?: string; en?: string }>();
  for (const { feature, bbox } of loadDataset("rivers10m")) {
    const p = feature.properties;
    const name = str(p.name);
    if (!name || str(p.featurecla) === "Lake Centerline") continue;
    const cur = rivers.get(name) ?? { rank: num(p.scalerank) ?? 10 };
    cur.bbox = mergeBBox(cur.bbox, bbox);
    cur.mid ??= lineMidpoint(feature.geometry);
    cur.rank = Math.min(cur.rank, num(p.scalerank) ?? 10);
    cur.alt ??= str(p.name_alt);
    cur.en ??= str(p.name_en);
    rivers.set(name, cur);
  }
  const aliasesByName = new Map<string, string[]>();
  for (const [alias, target] of Object.entries(RIVER_ALIASES)) {
    aliasesByName.set(target, [...(aliasesByName.get(target) ?? []), alias]);
  }
  for (const [name, r] of rivers) {
    if (!r.bbox || !r.mid) continue;
    const [lon, lat] = r.mid as [number, number];
    const keys = new Set([name, r.alt, r.en, ...(aliasesByName.get(name) ?? [])].filter(Boolean).map((k) => k!.toLowerCase()));
    out.push({ id: `river:${name}`, kind: "river", name, latitude: lat, longitude: lon, bbox: r.bbox, keys: [...keys], rank: 5 + r.rank });
  }

  for (const { feature, bbox } of loadDataset("lakes10m")) {
    const p = feature.properties;
    const name = str(p.name);
    if (!name) continue;
    const [lon, lat] = bboxCenter(bbox);
    const nameHi = str(p.name_hi);
    const keys = new Set([name, str(p.name_en), nameHi].filter(Boolean).map((k) => k!.toLowerCase()));
    out.push({ id: `lake:${num(p.ne_id) ?? name}`, kind: "lake", name, nameHi, latitude: lat, longitude: lon, bbox, keys: [...keys], rank: 8 + (num(p.scalerank) ?? 10) });
  }

  entries = out;
  return out;
}

function toHit(e: GazetteerEntry): GazetteerHit {
  const { keys: _k, rank: _r, ...hit } = e;
  return hit;
}

export function searchGazetteer(query: string, limit = 10, kinds?: GazetteerHit["kind"][]): GazetteerHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { e: GazetteerEntry; score: number }[] = [];
  for (const e of buildGazetteer()) {
    if (kinds && !kinds.includes(e.kind)) continue;
    let best = Infinity;
    for (const k of e.keys) {
      if (k === q) best = Math.min(best, 0);
      else if (k.startsWith(q)) best = Math.min(best, 1);
      else if (k.includes(q)) best = Math.min(best, 2);
    }
    if (best < Infinity) scored.push({ e, score: best * 100 + e.rank });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => toHit(s.e));
}

export function getGazetteerEntry(id: string): GazetteerHit | undefined {
  const e = buildGazetteer().find((x) => x.id === id);
  return e ? toHit(e) : undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Natural Earth gives some features everyday words as alternate names (a lake
 * whose English name is "Bay", rivers called "Red" or "New"). In free text these
 * only count when followed by the feature type, e.g. "Red River".
 */
const GENERIC_WORDS = new Set([
  "bay", "lake", "river", "sea", "gulf", "delta", "island", "mount", "new", "great", "little", "black", "white", "red",
  "blue", "green", "long", "grand", "big", "lower", "upper", "north", "south", "east", "west", "central", "valley", "da", "salt", "clear",
]);

export interface TextMatch {
  hit: GazetteerHit;
  matched: string;
  index: number;
}

/**
 * Find gazetteer entries mentioned in free text (English or Hindi). Countries,
 * rivers and lakes match by any name; populated places only when prominent
 * (scalerank ≤ 7) and written with a capital letter, to avoid matching common words.
 */
export function findPlacesInText(text: string): TextMatch[] {
  const lower = text.toLowerCase();
  const found: TextMatch[] = [];
  for (const e of buildGazetteer()) {
    if (e.kind === "place" && e.rank > 13) continue;
    for (const key of e.keys) {
      if (key.length < 3) continue;
      const isDevanagari = /[ऀ-ॿ]/.test(key);
      // \b does not work for Devanagari, so use explicit non-letter boundaries.
      const re = isDevanagari
        ? new RegExp(`(^|[\\s,.;:!?()"'।])${escapeRegex(key)}(?=$|[\\s,.;:!?()"'।]|[क-ह])`)
        : new RegExp(`(^|[^\\p{L}])${escapeRegex(key)}(?=$|[^\\p{L}])`, "u");
      const m = re.exec(lower);
      if (!m) continue;
      const index = m.index + (m[1]?.length ?? 0);
      if (GENERIC_WORDS.has(key)) {
        const after = lower.slice(index + key.length);
        const typeWord = e.kind === "river" ? /^\s+river\b/ : e.kind === "lake" ? /^\s+lake\b/ : null;
        if (!typeWord || !typeWord.test(after)) continue;
      }
      if (e.kind === "place") {
        const original = text.slice(index, index + key.length);
        if (original[0] !== original[0]?.toUpperCase()) continue;
      }
      found.push({ hit: toHit(e), matched: key, index });
      break;
    }
  }
  // Drop matches fully contained in a longer match at the same position (e.g. "Kosi" inside "Sapt Kosi").
  found.sort((a, b) => a.index - b.index || b.matched.length - a.matched.length);
  const result: TextMatch[] = [];
  for (const m of found) {
    const overlapped = result.some((r) => m.index >= r.index && m.index + m.matched.length <= r.index + r.matched.length && r.hit.kind !== "country" && m.hit.id !== r.hit.id && m.matched.length < r.matched.length);
    if (!overlapped && !result.some((r) => r.hit.id === m.hit.id)) result.push(m);
  }
  return result;
}

export function getCountryFeature(iso3: string): PreparedFeature | undefined {
  return loadDataset("countries10m").find((f) => f.feature.properties.ADM0_A3 === iso3);
}

export function getRiverFeatures(datasetName: string): Feature<Geometry, Record<string, unknown>>[] {
  return loadDataset("rivers10m")
    .filter((f) => f.feature.properties.name === datasetName)
    .map((f) => f.feature);
}

/** Test hook. */
export function resetGazetteer(): void {
  entries = null;
}

export function getCountryByIso3(iso3: string): GazetteerHit | undefined {
  const e = buildGazetteer().find((x) => x.kind === "country" && x.iso3 === iso3);
  return e ? toHit(e) : undefined;
}
