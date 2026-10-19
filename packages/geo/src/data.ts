import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Feature, FeatureCollection, Geometry, LineString, MultiLineString, MultiPolygon, Polygon, Position } from "geojson";
import { bboxClip } from "@turf/turf";

export type BBox = [number, number, number, number];

export interface PreparedFeature {
  feature: Feature<Geometry, Record<string, unknown>>;
  bbox: BBox;
}

export const NATURAL_EARTH_ATTRIBUTION = "Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com (public domain).";
export const NATURAL_EARTH_LICENSE = "Public domain (Natural Earth terms of use)";

export const DATASETS = {
  countries10m: "ne_10m_admin_0_countries.geojson",
  countries50m: "ne_50m_admin_0_countries.geojson",
  rivers10m: "ne_10m_rivers_lake_centerlines.geojson",
  rivers50m: "ne_50m_rivers_lake_centerlines.geojson",
  lakes10m: "ne_10m_lakes.geojson",
  lakes50m: "ne_50m_lakes.geojson",
  places10m: "ne_10m_populated_places_simple.geojson",
  countries110m: "ne_110m_admin_0_countries.geojson",
  rivers110m: "ne_110m_rivers_lake_centerlines.geojson",
  lakes110m: "ne_110m_lakes.geojson",
} as const;
export type DatasetId = keyof typeof DATASETS;

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root: ATLAS_ROOT, else the nearest parent containing pnpm-workspace.yaml.
 * Works both from TypeScript sources and from bundled dist/ files.
 */
export function findRepoRoot(from: string = here): string {
  if (process.env.ATLAS_ROOT) return path.resolve(process.env.ATLAS_ROOT);
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/** Data directory: ATLAS_GEO_DATA_DIR, else `<repo>/data/natural-earth`. */
export function geoDataDir(): string {
  if (process.env.ATLAS_GEO_DATA_DIR) return path.resolve(process.env.ATLAS_GEO_DATA_DIR);
  return path.join(findRepoRoot(), "data", "natural-earth");
}

export function datasetPath(id: DatasetId): string {
  return path.join(geoDataDir(), DATASETS[id]);
}

export class GeoDataMissingError extends Error {
  constructor(file: string) {
    super(`Geographic dataset not found: ${file}. Run "pnpm fetch:geodata" (scripts/fetch-geodata.sh) to download Natural Earth data.`);
    this.name = "GeoDataMissingError";
  }
}

export function checkGeoData(): { ok: boolean; missing: string[] } {
  const missing = (Object.keys(DATASETS) as DatasetId[]).filter((id) => !fs.existsSync(datasetPath(id))).map((id) => DATASETS[id]);
  return { ok: missing.length === 0, missing };
}

function eachPosition(g: Geometry, fn: (p: Position) => void): void {
  switch (g.type) {
    case "Point":
      fn(g.coordinates);
      break;
    case "MultiPoint":
    case "LineString":
      g.coordinates.forEach(fn);
      break;
    case "MultiLineString":
    case "Polygon":
      g.coordinates.forEach((r) => r.forEach(fn));
      break;
    case "MultiPolygon":
      g.coordinates.forEach((p) => p.forEach((r) => r.forEach(fn)));
      break;
    case "GeometryCollection":
      g.geometries.forEach((x) => eachPosition(x, fn));
      break;
  }
}

export function geometryBBox(g: Geometry): BBox {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  eachPosition(g, ([x, y]) => {
    if (x === undefined || y === undefined) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });
  return [minX, minY, maxX, maxY];
}

const cache = new Map<DatasetId, PreparedFeature[]>();

export function loadDataset(id: DatasetId): PreparedFeature[] {
  const hit = cache.get(id);
  if (hit) return hit;
  const file = datasetPath(id);
  if (!fs.existsSync(file)) throw new GeoDataMissingError(file);
  const fc = JSON.parse(fs.readFileSync(file, "utf8")) as FeatureCollection<Geometry, Record<string, unknown>>;
  const prepared = fc.features
    .filter((f) => f.geometry)
    .map((feature) => ({ feature, bbox: geometryBBox(feature.geometry) }));
  cache.set(id, prepared);
  return prepared;
}

/** Test hook: drop cached datasets. */
export function clearGeoCache(): void {
  cache.clear();
}

// ---------- Level of detail ----------

function sqSegDist(p: Position, a: Position, b: Position): number {
  let x = a[0]!, y = a[1]!;
  let dx = b[0]! - x, dy = b[1]! - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0]! - x) * dx + (p[1]! - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]!; y = b[1]!; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0]! - x;
  dy = p[1]! - y;
  return dx * dx + dy * dy;
}

/** Douglas-Peucker simplification (iterative) of a coordinate list. */
export function simplifyLine(points: Position[], tolerance: number, minPoints = 2): Position[] {
  if (points.length <= minPoints) return points;
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxD = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(points[i]!, points[first]!, points[last]!);
      if (d > maxD) { maxD = d; index = i; }
    }
    if (index > 0 && maxD > sqTol) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = points.filter((_, i) => keep[i]);
  return out.length >= minPoints ? out : points;
}

export function simplifyGeometry(g: Geometry, tolerance: number): Geometry {
  const ring = (r: Position[]) => simplifyLine(r, tolerance, 4);
  switch (g.type) {
    case "LineString":
      return { type: g.type, coordinates: simplifyLine(g.coordinates, tolerance) };
    case "MultiLineString":
      return { type: g.type, coordinates: g.coordinates.map((l) => simplifyLine(l, tolerance)) };
    case "Polygon":
      return { type: g.type, coordinates: g.coordinates.map(ring) };
    case "MultiPolygon":
      return { type: g.type, coordinates: g.coordinates.map((p) => p.map(ring)) };
    default:
      return g;
  }
}

const simplifiedCache = new Map<string, PreparedFeature[]>();

/** A dataset simplified to a tolerance in degrees (cached per process). */
export function loadSimplified(id: DatasetId, tolerance: number): PreparedFeature[] {
  const key = `${id}@${tolerance}`;
  const hit = simplifiedCache.get(key);
  if (hit) return hit;
  const out = loadDataset(id).map((f) => ({ bbox: f.bbox, feature: { ...f.feature, geometry: simplifyGeometry(f.feature.geometry, tolerance) } }));
  simplifiedCache.set(key, out);
  return out;
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Features intersecting a window, clipped to it. The window must not cross the antimeridian. */
export function clipFeatures(features: PreparedFeature[], window: BBox): PreparedFeature[] {
  const out: PreparedFeature[] = [];
  for (const f of features) {
    if (!bboxIntersects(f.bbox, window)) continue;
    const t = f.feature.geometry.type;
    if (t !== "Polygon" && t !== "MultiPolygon" && t !== "LineString" && t !== "MultiLineString") {
      out.push(f);
      continue;
    }
    const inside = f.bbox[0] >= window[0] && f.bbox[2] <= window[2] && f.bbox[1] >= window[1] && f.bbox[3] <= window[3];
    if (inside) {
      out.push(f);
      continue;
    }
    const clipped = bboxClip(f.feature as Feature<LineString | MultiLineString | Polygon | MultiPolygon>, window) as Feature<Geometry, Record<string, unknown>>;
    out.push({ feature: clipped, bbox: f.bbox });
  }
  return out;
}
