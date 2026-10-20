import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { findRepoRoot } from "@atlas/geo";

/**
 * Satellite imagery for the renderer and the editor preview.
 *
 * Two layers:
 *  - a whole-world base image (NASA Blue Marble, equirectangular, public domain)
 *    read from disk, always available offline, about 10 km per pixel;
 *  - an optional detail layer of Web Mercator XYZ tiles from a provider whose
 *    terms allow use in exported video. Tiles are fetched server-side and cached
 *    on disk. When tiles cannot be fetched the base image is used and the
 *    attribution only names what was actually drawn.
 */

export type ImageryProviderId = "eox-s2cloudless" | "maptiler-satellite" | "custom" | "none";

export interface ImageryConfig {
  provider: ImageryProviderId;
  /** XYZ template with {z} {x} {y}, and optionally {key}. */
  tileUrl: string | null;
  /** Substituted for {key}. Server-side only; never sent to the browser. */
  tileKey: string | null;
  tileAttribution: string;
  maxZoom: number;
  cacheDir: string;
  baseImagePath: string;
  fetchTimeoutMs: number;
  /** Folder of prepared imagery regions (XYZ tiles plus region.json), used before the network provider. */
  regionsDir: string | null;
  /** Keep fetched provider tiles on disk between renders. Off where the provider's terms forbid server-side caching. */
  diskCache: boolean;
  /** Serve provider tiles to the editor preview through the API. Off where the terms forbid proxying. */
  previewProxy: boolean;
  /** TileJSON whose attribution field lists the imagery sources (used instead of tileAttribution when reachable). */
  tileJsonUrl?: string | null;
  /** Which video licence the operator holds for this provider (SATELLITE_VIDEO_LICENSE). */
  videoLicense?: string | null;
  /** Why the configured provider was refused (for example a Google provider), shown by check-env and the render log. */
  blocked?: string | null;
}

export const BASE_ATTRIBUTION = "Imagery: NASA Blue Marble";

interface Preset {
  url: string;
  attribution: string;
  maxZoom: number;
  label: string;
  license: string;
  tileJsonUrl?: string;
  /** Provider terms forbid keeping tiles in a server-side cache. */
  noDiskCache?: boolean;
  /** Provider terms require end users to request tiles directly, so the API must not proxy them. */
  noProxy?: boolean;
  /** Provider terms allow video only under a separate video licence, named in SATELLITE_VIDEO_LICENSE. */
  needsVideoLicense?: boolean;
}

const PRESETS: Record<Exclude<ImageryProviderId, "custom" | "none">, Preset> = {
  // The 2016 mosaic is the CC BY 4.0 release; later years are CC BY-NC-SA, which rules out commercial video.
  "eox-s2cloudless": {
    url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg",
    attribution: "Sentinel-2 cloudless by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)",
    maxZoom: 13,
    label: "Sentinel-2 cloudless 2016 (EOX)",
    license: "CC BY 4.0",
  },
  // MapTiler Satellite needs a key and a MapTiler video licence: the Flex plan covers channels up to
  // 100,000 subscribers; TV, broadcast and videos made for other people need a custom licence. Their
  // Cloud terms forbid server-side caching and proxying, so tiles stay in memory for one render and
  // the editor preview does not show them. See docs/IMAGERY_LICENSING.md.
  "maptiler-satellite": {
    url: "https://api.maptiler.com/tiles/satellite-v4/{z}/{x}/{y}?key={key}",
    tileJsonUrl: "https://api.maptiler.com/tiles/satellite-v4/tiles.json?key={key}",
    attribution: "Imagery: © MapTiler, © Maxar and other providers listed at maptiler.com/copyright",
    maxZoom: 16,
    label: "MapTiler Satellite",
    license: "MapTiler video licence (Flex or custom)",
    noDiskCache: true,
    noProxy: true,
    needsVideoLicense: true,
  },
};

const VIDEO_LICENSES = ["flex", "custom"] as const;

/**
 * Google imagery cannot be drawn into exported videos: the Map Tiles API allows only
 * promotional videos of 30 s or less about your own app and forbids caching, and the
 * Google Maps Platform terms forbid exporting Google Maps Content or creating content from it.
 * See docs/IMAGERY_LICENSING.md. The editor can still show a live Google Maps preview.
 */
export const GOOGLE_EXPORT_BLOCKED =
  "Google imagery (Maps, Map Tiles API 2D or Photorealistic 3D Tiles, Earth) is not licensed for exported user videos; see docs/IMAGERY_LICENSING.md. Renders use the open imagery sources instead.";

/** Tile hosts that serve Google imagery. A custom provider pointing at one of them is refused. */
const GOOGLE_TILE_HOST = /(^|\.)(google\.[a-z.]+|googleapis\.com|gstatic\.com|ggpht\.com)$/i;

function isGoogleTileUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    return GOOGLE_TILE_HOST.test(new URL(url.replace(/\{[a-z]+\}/gi, "0")).hostname);
  } catch {
    return false;
  }
}

export function imageryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ImageryConfig {
  const root = findRepoRoot();
  const raw = (env.SATELLITE_PROVIDER ?? "eox-s2cloudless").trim() as ImageryProviderId;
  // A Google provider name is refused outright rather than silently swapped for another source.
  const googleRequested = /^google/i.test(raw);
  const provider: ImageryProviderId = googleRequested ? "none" : raw === "custom" || raw === "none" || raw === "eox-s2cloudless" || raw === "maptiler-satellite" ? raw : "eox-s2cloudless";
  const preset = provider === "custom" || provider === "none" ? null : PRESETS[provider];
  const maxZoom = Number(env.SATELLITE_MAX_ZOOM ?? preset?.maxZoom ?? 12);
  return {
    provider,
    tileUrl: provider === "custom" ? env.SATELLITE_TILE_URL?.trim() || null : preset?.url ?? null,
    tileKey: env.SATELLITE_TILE_KEY?.trim() || null,
    tileAttribution: provider === "custom" ? env.SATELLITE_ATTRIBUTION?.trim() || "" : env.SATELLITE_ATTRIBUTION?.trim() || preset?.attribution || "",
    diskCache: !preset?.noDiskCache,
    previewProxy: !preset?.noProxy,
    tileJsonUrl: preset?.tileJsonUrl ?? null,
    videoLicense: env.SATELLITE_VIDEO_LICENSE?.trim().toLowerCase() || null,
    maxZoom: Number.isFinite(maxZoom) ? Math.max(1, Math.min(18, Math.round(maxZoom))) : 12,
    cacheDir: path.resolve(env.SATELLITE_CACHE_DIR ?? path.join(root, "storage", "cache", "tiles")),
    baseImagePath: path.resolve(env.ATLAS_BASE_IMAGERY ?? path.join(root, "assets", "imagery", "blue-marble-4096.jpg")),
    fetchTimeoutMs: Number(env.SATELLITE_FETCH_TIMEOUT_MS ?? 10_000),
    blocked: googleRequested ? GOOGLE_EXPORT_BLOCKED : null,
    regionsDir: env.SATELLITE_REGIONS_DIR === "none" ? null : path.resolve(env.SATELLITE_REGIONS_DIR ?? path.join(root, "assets", "imagery", "regions")),
  };
}

/** Elevation tiles for the 3D view (Terrarium-encoded PNG). */
export interface TerrainConfig {
  tileUrl: string | null;
  attribution: string;
  maxZoom: number;
  cacheDir: string;
}

export const TERRAIN_ATTRIBUTION = "Terrain: Mapzen Terrain Tiles on AWS (SRTM, GMTED2010, ETOPO1 and others)";

export function terrainConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TerrainConfig {
  const root = findRepoRoot();
  const url = env.TERRAIN_TILE_URL?.trim();
  return {
    tileUrl: url === "none" ? null : url || "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png",
    attribution: env.TERRAIN_ATTRIBUTION?.trim() || TERRAIN_ATTRIBUTION,
    maxZoom: Math.max(1, Math.min(15, Number(env.TERRAIN_MAX_ZOOM ?? 12) || 12)),
    cacheDir: path.resolve(env.TERRAIN_CACHE_DIR ?? path.join(root, "storage", "cache", "terrain")),
  };
}

/** A TileFetcher for elevation tiles, sharing the cache, retry and back-off logic. */
export function terrainFetcher(t: TerrainConfig): TileFetcher {
  return new TileFetcher({
    provider: t.tileUrl ? "custom" : "none",
    tileUrl: t.tileUrl,
    tileKey: null,
    tileAttribution: t.attribution,
    maxZoom: t.maxZoom,
    cacheDir: t.cacheDir,
    baseImagePath: "",
    fetchTimeoutMs: 15_000,
    regionsDir: null,
    diskCache: true,
    previewProxy: true,
  });
}

export interface ImageryRegion {
  name: string;
  attribution: string;
  license?: string;
  /** [west, south, east, north] in degrees. */
  bbox: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  dir: string;
}

/**
 * Prepared imagery regions on disk, such as a Sentinel-2 mosaic built with
 * scripts/imagery/bake_sentinel2.py. Each region folder holds {z}/{x}/{y}.jpg
 * (or .png where the region's edge leaves part of a tile empty) and region.json.
 */
export class RegionTileStore {
  /** How often the folder is read again, so a region finished while the app runs is picked up without a restart. */
  static readonly RESCAN_MS = 30_000;
  private list: ImageryRegion[] = [];
  private scannedAt = 0;

  constructor(private readonly dir: string | null) {
    this.scan();
  }

  get regions(): ImageryRegion[] {
    if (this.dir && Date.now() - this.scannedAt > RegionTileStore.RESCAN_MS) this.scan();
    return this.list;
  }

  /** Reads every region.json in the folder. bake_sentinel2.py writes region.json last, so half-built regions are skipped. */
  private scan(): void {
    this.scannedAt = Date.now();
    const dir = this.dir;
    if (!dir || !fs.existsSync(dir)) return;
    const found: ImageryRegion[] = [];
    for (const name of fs.readdirSync(dir).sort()) {
      const meta = path.join(dir, name, "region.json");
      if (!fs.existsSync(meta)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(meta, "utf8")) as Omit<ImageryRegion, "dir">;
        if (!r.attribution || !Array.isArray(r.bbox)) continue;
        found.push({ ...r, name: r.name ?? name, dir: path.join(dir, name) });
      } catch {
        /* unreadable region.json: skip the region */
      }
    }
    // Sharper regions first, so a detailed region sits on top of a wider, coarser one.
    this.list = found.sort((a, b) => b.maxZoom - a.maxZoom || a.name.localeCompare(b.name));
  }

  getTile(z: number, x: number, y: number): { body: Buffer; region: ImageryRegion } | null {
    return this.getTiles(z, x, y, 1)[0] ?? null;
  }

  /**
   * Region tiles for this position, top first. Stops at the first opaque (JPEG) tile, because the
   * baker writes JPEG only for tiles with no transparent pixels.
   */
  getTiles(z: number, x: number, y: number, limit = Infinity): { body: Buffer; region: ImageryRegion }[] {
    const out: { body: Buffer; region: ImageryRegion }[] = [];
    for (const r of this.regions) {
      if (out.length >= limit) break;
      if (z < r.minZoom || z > r.maxZoom) continue;
      const [x0, y1] = lonLatToTile(r.bbox[0], r.bbox[1], z);
      const [x1, y0] = lonLatToTile(r.bbox[2], r.bbox[3], z);
      if (x < Math.floor(x0) || x > Math.floor(x1) || y < Math.floor(y0) || y > Math.floor(y1)) continue;
      let opaque = false;
      for (const ext of [".jpg", ".png"]) {
        const f = path.join(r.dir, String(z), String(x), `${y}${ext}`);
        try {
          out.push({ body: fs.readFileSync(f), region: r });
          opaque = ext === ".jpg";
          break;
        } catch {
          /* not in this region */
        }
      }
      if (opaque) break;
    }
    return out;
  }
}

export interface ImageryStatus {
  provider: ImageryProviderId;
  label: string;
  license: string;
  attribution: string;
  maxZoom: number;
  baseImage: boolean;
  /** Problems an operator must fix, e.g. a custom provider without attribution. */
  issues: string[];
}

export function describeImagery(cfg: ImageryConfig): ImageryStatus {
  const issues: string[] = [];
  if (cfg.provider === "custom") {
    if (!cfg.tileUrl) issues.push("SATELLITE_PROVIDER=custom needs SATELLITE_TILE_URL.");
    else if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(cfg.tileUrl) || !cfg.tileUrl.includes("{z}") || !cfg.tileUrl.includes("{x}") || !cfg.tileUrl.includes("{y}")) issues.push("SATELLITE_TILE_URL must be an https URL (or http on localhost) containing {z}, {x} and {y}.");
    if (cfg.tileUrl?.includes("{key}") && !cfg.tileKey) issues.push("SATELLITE_TILE_URL uses {key} but SATELLITE_TILE_KEY is not set.");
    if (!cfg.tileAttribution) issues.push("SATELLITE_ATTRIBUTION is required for a custom provider; it is drawn on every frame.");
    if (isGoogleTileUrl(cfg.tileUrl)) issues.push(GOOGLE_EXPORT_BLOCKED);
  }
  if (cfg.blocked) issues.push(cfg.blocked);
  const presetOf = cfg.provider === "custom" || cfg.provider === "none" ? null : PRESETS[cfg.provider];
  if (presetOf && presetOf.url.includes("{key}") && !cfg.tileKey) issues.push(`SATELLITE_PROVIDER=${cfg.provider} needs SATELLITE_TILE_KEY.`);
  if (presetOf?.needsVideoLicense && !VIDEO_LICENSES.includes(cfg.videoLicense as (typeof VIDEO_LICENSES)[number]))
    issues.push(`${presetOf.label} may be used in videos only under its video licence. Set SATELLITE_VIDEO_LICENSE to "flex" (own channel, up to 100,000 subscribers) or "custom" (a licence agreed with MapTiler) once you hold one.`);
  const baseImage = fs.existsSync(cfg.baseImagePath);
  if (!baseImage) issues.push(`Base imagery missing at ${cfg.baseImagePath}. Run scripts/fetch-assets.sh.`);
  const preset = cfg.provider === "custom" || cfg.provider === "none" ? null : PRESETS[cfg.provider];
  return {
    provider: cfg.provider,
    label: preset?.label ?? (cfg.provider === "custom" ? "Custom tile provider" : "NASA Blue Marble only"),
    license: preset?.license ?? (cfg.provider === "custom" ? "Set by your provider's terms" : "Public domain"),
    attribution: cfg.provider === "none" ? BASE_ATTRIBUTION : cfg.tileAttribution,
    maxZoom: cfg.provider === "none" ? 6 : cfg.maxZoom,
    baseImage,
    issues,
  };
}

/** Identifies the imagery a clip was drawn with, for render cache keys. */
export function imageryCacheTag(cfg: ImageryConfig): string {
  return `${cfg.provider}:${cfg.tileUrl ?? ""}:${cfg.maxZoom}`;
}

// ---------------------------------------------------------------------------
// Rasters

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8ClampedArray;
}

export async function decodeRaster(src: string | Buffer): Promise<Raster> {
  const img = await loadImage(src);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

let baseCache: { path: string; raster: Promise<Raster | null> } | null = null;

/** The whole-world base image, decoded once per process. Null when the file is missing. */
export function loadBaseImagery(cfg: ImageryConfig): Promise<Raster | null> {
  if (baseCache?.path !== cfg.baseImagePath) {
    const p = cfg.baseImagePath;
    baseCache = { path: p, raster: fs.existsSync(p) ? decodeRaster(p) : Promise.resolve(null) };
  }
  return baseCache.raster;
}

// Mild documentary grade: a touch more contrast and a little darker, so overlays read clearly.
const GRADE = (() => {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(((i - 118) * 1.1 + 118) * 0.92);
  return lut;
})();

/**
 * Bilinear sample of an RGBA raster at fractional pixel (x, y) into out[o..o+2].
 * xWrap > 0 wraps x around that width (whole-world rasters). Returns false when
 * the point is outside the raster or lands on a transparent (missing) pixel.
 */
export function sampleRaster(r: Raster, x: number, y: number, xWrap: number, out: Uint8ClampedArray, o: number): boolean {
  const w = r.width;
  const h = r.height;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  let x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let x1 = x0 + 1;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  if (xWrap > 0) {
    while (x0 < 0) x0 += xWrap;
    while (x0 >= xWrap) x0 -= xWrap;
    x1 = x0 + 1 < xWrap ? x0 + 1 : 0;
  } else {
    if (x0 < 0 || x0 > w - 1) return false;
    if (x1 > w - 1) x1 = x0;
  }
  const d = r.data;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  if (d[i00 + 3]! < 128 || d[i11 + 3]! < 128) return false;
  const a = (1 - fx) * (1 - fy);
  const b = fx * (1 - fy);
  const c = (1 - fx) * fy;
  const e = fx * fy;
  out[o] = GRADE[(d[i00]! * a + d[i10]! * b + d[i01]! * c + d[i11]! * e) | 0]!;
  out[o + 1] = GRADE[(d[i00 + 1]! * a + d[i10 + 1]! * b + d[i01 + 1]! * c + d[i11 + 1]! * e) | 0]!;
  out[o + 2] = GRADE[(d[i00 + 2]! * a + d[i10 + 2]! * b + d[i01 + 2]! * c + d[i11 + 2]! * e) | 0]!;
  return true;
}

// ---------------------------------------------------------------------------
// Tiles

const MERC_MAX_LAT = 85.0511287798;

export function lonLatToTile(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const la = Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, lat));
  const s = Math.sin((la * Math.PI) / 180);
  const x = ((lon + 180) / 360) * n;
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return [x, y];
}

/**
 * Fetches XYZ tiles with a disk cache. Never throws: a tile that cannot be
 * fetched resolves to null. After repeated network failures the provider is
 * skipped for a while so a render does not wait on thousands of timeouts.
 */
/** Draws overlapping region tiles bottom-up (the list is top first) into one PNG. */
async function stackTiles(top: Buffer[]): Promise<Buffer> {
  const canvas = createCanvas(256, 256);
  const ctx = canvas.getContext("2d");
  for (const body of [...top].reverse()) ctx.drawImage(await loadImage(body), 0, 0, 256, 256);
  return canvas.encode("png");
}

export class TileFetcher {
  private failures = 0;
  private skipUntil = 0;
  private inflight = new Map<string, Promise<Buffer | null>>();
  private active = 0;
  private queue: (() => void)[] = [];
  lastError: string | null = null;
  readonly regions: RegionTileStore;
  /** Credit lines for every tile handed out since the last reset (regions and provider). */
  readonly usedSources = new Set<string>();

  private attributionFromTileJson: string | null = null;
  private tileJson: Promise<void> | null = null;

  constructor(private readonly cfg: ImageryConfig, private readonly concurrency = 6) {
    this.regions = new RegionTileStore(cfg.regionsDir);
  }

  /** The provider's credit line: its TileJSON attribution when it was fetched, else the configured text. */
  get attribution(): string {
    return this.attributionFromTileJson ?? this.cfg.tileAttribution;
  }

  /** Reads the provider's TileJSON once, for an attribution that names every imagery source it serves. */
  loadTileJsonAttribution(): Promise<void> {
    if (!this.cfg.tileJsonUrl) return Promise.resolve();
    this.tileJson ??= (async () => {
      try {
        const res = await fetch(this.cfg.tileJsonUrl!.replace("{key}", encodeURIComponent(this.cfg.tileKey ?? "")), { signal: AbortSignal.timeout(this.cfg.fetchTimeoutMs) });
        if (!res.ok) return;
        const text = String(((await res.json()) as { attribution?: unknown }).attribution ?? "")
          .replace(/<[^>]*>/g, " ")
          .replace(/&copy;/g, "©")
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim();
        if (text) this.attributionFromTileJson = `Imagery: ${text}`.slice(0, 300);
      } catch {
        /* keep the configured attribution */
      }
    })();
    return this.tileJson;
  }

  /** True when the network provider is configured. */
  get providerEnabled(): boolean {
    return this.cfg.provider !== "none" && !!this.cfg.tileUrl && describeImagery(this.cfg).issues.every((i) => i.startsWith("Base imagery"));
  }

  /** True when any detail source exists: the provider or a prepared region. */
  get enabled(): boolean {
    return this.providerEnabled || this.regions.regions.length > 0;
  }

  get available(): boolean {
    return this.providerEnabled && Date.now() >= this.skipUntil;
  }

  private cachePath(z: number, x: number, y: number): string {
    const tag = crypto.createHash("sha1").update(this.cfg.tileUrl ?? "").digest("hex").slice(0, 10);
    return path.join(this.cfg.cacheDir, tag, String(z), String(x), `${y}.img`);
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  /** Prepared-region imagery only, never the network provider. */
  async regionTile(z: number, x: number, y: number): Promise<Buffer | null> {
    const n = 2 ** z;
    const local = this.regions.getTiles(z, ((x % n) + n) % n, y);
    return local.length === 0 ? null : local.length === 1 ? local[0]!.body : stackTiles(local.map((l) => l.body));
  }

  getTile(z: number, x: number, y: number): Promise<Buffer | null> {
    if (!this.enabled || z < 0 || z > this.cfg.maxZoom || y < 0 || y >= 2 ** z) return Promise.resolve(null);
    const n = 2 ** z;
    const wx = ((x % n) + n) % n;
    const local = this.regions.getTiles(z, wx, y);
    if (local.length) {
      for (const l of local) this.usedSources.add(l.region.attribution);
      return local.length === 1 ? Promise.resolve(local[0]!.body) : stackTiles(local.map((l) => l.body));
    }
    if (!this.providerEnabled) return Promise.resolve(null);
    const file = this.cachePath(z, wx, y);
    const key = `${z}/${wx}/${y}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      if (this.cfg.diskCache) {
        try {
          const cached = await fs.promises.readFile(file);
          this.usedSources.add(this.attribution);
          return cached;
        } catch {
          /* not cached */
        }
      }
      if (!this.available) return null;
      await this.loadTileJsonAttribution();
      return this.slot(async () => {
        if (!this.available) return null;
        const url = this.cfg.tileUrl!.replace("{z}", String(z)).replace("{x}", String(wx)).replace("{y}", String(y)).replace("{key}", encodeURIComponent(this.cfg.tileKey ?? ""));
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(this.cfg.fetchTimeoutMs), headers: { "User-Agent": "AtlasMotion/0.1 (map video renderer)" } });
          if (res.status === 404) return null;
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const type = res.headers.get("content-type") ?? "";
          if (!type.startsWith("image/")) throw new Error(`unexpected content type ${type || "(none)"}`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (this.cfg.diskCache) {
            await fs.promises.mkdir(path.dirname(file), { recursive: true });
            await fs.promises.writeFile(`${file}.tmp`, buf);
            await fs.promises.rename(`${file}.tmp`, file);
          }
          this.failures = 0;
          this.usedSources.add(this.attribution);
          return buf;
        } catch (err) {
          this.lastError = `${(err as Error).message}`.slice(0, 200);
          if (++this.failures >= 8) {
            this.skipUntil = Date.now() + 5 * 60_000;
            this.failures = 0;
          }
          return null;
        }
      });
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

/** A block of tiles at one zoom level, decoded into a single raster. */
export interface Mosaic {
  z: number;
  /** Tile index of the mosaic's top-left tile (x may be negative or past 2^z; it wraps). */
  tx0: number;
  ty0: number;
  cols: number;
  rows: number;
  raster: Raster;
  /** Per tile: true when the tile is real imagery (missing tiles stay transparent). */
  coverage: number;
}

export const MOSAIC_MAX_PX = 6144;

/** Assemble the tiles covering a lon/lat box at zoom z. Returns null when nothing could be fetched. */
export async function buildMosaic(fetcher: TileFetcher, z: number, bbox: [number, number, number, number]): Promise<Mosaic | null> {
  const n = 2 ** z;
  const [x0f, y1f] = lonLatToTile(bbox[0], bbox[1], z);
  const [x1f, y0f] = lonLatToTile(bbox[2], bbox[3], z);
  const tx0 = Math.floor(x0f);
  const ty0 = Math.max(0, Math.floor(y0f));
  const cols = Math.min(n, Math.floor(x1f) - tx0 + 1);
  const rows = Math.min(n - ty0, Math.floor(y1f) - ty0 + 1);
  if (cols <= 0 || rows <= 0 || cols * 256 > MOSAIC_MAX_PX || rows * 256 > MOSAIC_MAX_PX) return null;
  const canvas = createCanvas(cols * 256, rows * 256);
  const ctx = canvas.getContext("2d");
  let got = 0;
  const jobs: Promise<void>[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      jobs.push(
        fetcher.getTile(z, tx0 + c, ty0 + r).then(async (buf) => {
          if (!buf) return;
          try {
            const img = await loadImage(buf);
            ctx.drawImage(img, c * 256, r * 256, 256, 256);
            got++;
          } catch {
            /* undecodable tile: leave transparent */
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
  if (got === 0) return null;
  return { z, tx0, ty0, cols, rows, raster: { width: cols * 256, height: rows * 256, data: ctx.getImageData(0, 0, cols * 256, rows * 256).data }, coverage: got / (cols * rows) };
}

/** Tile zoom whose ground resolution at `lat` matches a projection scale (pixels per radian). */
export function tileZoomForScale(scale: number, lat: number, maxZoom: number): number {
  const cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const z = Math.ceil(Math.log2((scale * 2 * Math.PI * cos) / 256) - 0.25);
  return Math.max(0, Math.min(maxZoom, z));
}

/** Render one 256 px Web Mercator tile from the equirectangular base image. */
export async function renderBaseTile(base: Raster, z: number, x: number, y: number): Promise<Buffer> {
  const canvas = createCanvas(256, 256);
  const ctx = canvas.getContext("2d");
  const id = ctx.createImageData(256, 256);
  const out = id.data;
  const world = 256 * 2 ** z;
  for (let py = 0; py < 256; py++) {
    const my = (y * 256 + py + 0.5) / world;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
    const sy = ((90 - lat) / 180) * base.height - 0.5;
    for (let px = 0; px < 256; px++) {
      const lon = ((x * 256 + px + 0.5) / world) * 360 - 180;
      const o = (py * 256 + px) * 4;
      sampleRaster(base, ((lon + 180) / 360) * base.width - 0.5, sy, base.width, out, o);
      out[o + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return canvas.encode("jpeg", 85);
}

export interface ServedTile {
  body: Buffer;
  contentType: string;
  source: "detail" | "base";
}

/**
 * Tiles for the editor preview, served by the API so provider keys stay on the
 * server and the browser only talks to its own origin. Detail tiles come from
 * the configured provider (shared disk cache with the renderer); anything it
 * cannot supply is generated from the base image.
 */
export class ImageryTileService {
  readonly fetcher: TileFetcher;
  /** Elevation tiles for the 3D preview; null when terrain is off. */
  readonly terrain: TileFetcher | null;
  private readonly baseTiles = new Map<string, Promise<Buffer>>();

  constructor(
    readonly cfg: ImageryConfig,
    readonly terrainCfg: TerrainConfig | null = null,
    /** True for the editor preview served by the API; false for the renderer's own use. */
    readonly forPreview = false,
  ) {
    this.fetcher = new TileFetcher(cfg);
    this.terrain = terrainCfg?.tileUrl ? terrainFetcher(terrainCfg) : null;
  }

  /** One elevation tile (Terrarium PNG), or null when terrain is off or the tile is out of range. */
  async getTerrainTile(z: number, x: number, y: number): Promise<ServedTile | null> {
    const n = 2 ** z;
    if (!this.terrain || !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0 || z > this.terrainCfg!.maxZoom || x < 0 || x >= n || y < 0 || y >= n) return null;
    const buf = await this.terrain.getTile(z, x, y);
    return buf ? { body: buf, contentType: sniffImageType(buf), source: "detail" } : null;
  }

  /** Highest zoom the preview should request. */
  get maxZoom(): number {
    return this.fetcher.enabled ? this.cfg.maxZoom : BASE_TILE_MAX_ZOOM;
  }

  /**
   * One tile. layer "any" (the preview) returns detail imagery composited over
   * the base where the detail tile is partly empty, else the base tile; "base"
   * and "detail" return only that layer (the 3D renderer stacks them itself).
   */
  async getTile(z: number, x: number, y: number, layer: "any" | "base" | "detail" = "any"): Promise<ServedTile | null> {
    const n = 2 ** z;
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0 || z > 18 || x < 0 || x >= n || y < 0 || y >= n) return null;
    if (layer !== "base" && z >= 4 && this.fetcher.enabled) {
      // Providers that forbid proxying are never fetched for the preview; it shows regions and the base layer.
      const buf = this.forPreview && !this.cfg.previewProxy ? await this.fetcher.regionTile(z, x, y) : await this.fetcher.getTile(z, x, y);
      if (buf) {
        const type = sniffImageType(buf);
        if (layer === "detail" || type !== "image/png") return { body: buf, contentType: type, source: "detail" };
        const base = await this.baseTile(z, x, y);
        if (!base) return { body: buf, contentType: type, source: "detail" };
        const canvas = createCanvas(256, 256);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(await loadImage(base), 0, 0);
        ctx.drawImage(await loadImage(buf), 0, 0, 256, 256);
        return { body: await canvas.encode("jpeg", 88), contentType: "image/jpeg", source: "detail" };
      }
    }
    if (layer === "detail" || z > BASE_TILE_MAX_ZOOM) return null;
    const body = await this.baseTile(z, x, y);
    return body ? { body, contentType: "image/jpeg", source: "base" } : null;
  }

  private async baseTile(z: number, x: number, y: number): Promise<Buffer | null> {
    const base = await loadBaseImagery(this.cfg);
    if (!base) return null;
    const key = `${z}/${x}/${y}`;
    let p = this.baseTiles.get(key);
    if (!p) {
      p = renderBaseTile(base, z, x, y);
      this.baseTiles.set(key, p);
      // Small LRU: drop the oldest entries.
      if (this.baseTiles.size > 2000) this.baseTiles.delete(this.baseTiles.keys().next().value!);
    }
    return p;
  }
}

/** Past this zoom the base image is only blur, so the preview stops asking for base tiles. */
export const BASE_TILE_MAX_ZOOM = 7;

function sniffImageType(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return "image/webp";
  return "image/jpeg";
}
