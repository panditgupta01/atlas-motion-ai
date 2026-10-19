import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { Browser, BrowserType, Page } from "playwright-core";
import type { FeatureCollection } from "geojson";
import type { Camera3D, FrameSize } from "@atlas/shared";
import { ImageryTileService, terrainFetcher, type ImageryConfig, type TerrainConfig, type TileFetcher } from "./imagery.js";

/**
 * 3D terrain view: MapLibre GL running in headless Chromium draws satellite
 * imagery draped over elevation tiles, with borders, rivers and highlighted
 * countries on the ground. Each frame is read back as a JPEG; labels, title
 * cards and credits are drawn on top by the Skia renderer.
 *
 * Chromium comes from playwright-core: set CHROMIUM_PATH, or install a
 * Playwright Chromium (PLAYWRIGHT_BROWSERS_PATH). Without a GPU it renders
 * with SwiftShader on the CPU, at roughly 0.5 to 1.5 s per 1080p frame.
 */

const require = createRequire(import.meta.url);

function maplibreDist(): string {
  return path.join(path.dirname(require.resolve("maplibre-gl/package.json")), "dist");
}

/** Data the page draws for one scene, all in lon/lat. */
export interface Globe3DSceneData {
  borders: FeatureCollection;
  rivers: FeatureCollection;
  highlights: FeatureCollection;
  /** Detail imagery max zoom, so MapLibre over-zooms instead of asking for tiles that do not exist. */
  detailMaxZoom: number;
  terrain: boolean;
  exaggeration: number;
}

/** Per-frame data: the camera, animated lines, and points whose screen positions are needed for labels. */
export interface Globe3DFrameInput {
  camera: Camera3D;
  /** Overlay rivers and routes, already cut to their reveal progress. */
  lines: FeatureCollection;
  anchors: [number, number][];
}

export interface Globe3DFrame {
  jpeg: Buffer;
  /** Screen position for each anchor, or null when it is off screen or behind the horizon. */
  anchors: ([number, number] | null)[];
  /** False when some tiles were still missing after the wait limit. */
  complete: boolean;
}

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/maplibre/maplibre-gl.css">
<style>html,body,#map{margin:0;width:100%;height:100%;background:#05070a;overflow:hidden}</style></head><body><div id="map"></div>
<script type="module">
import { Map as M, setWorkerUrl } from "/maplibre/maplibre-gl.mjs";
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
const empty = { type: "FeatureCollection", features: [] };
let map = null;
window.setScene = async (s) => {
  if (map) map.remove();
  const o = location.origin;
  const style = {
    version: 8,
    projection: { type: "globe" },
    sky: {
      "sky-color": "#3f6fb5", "horizon-color": "#c8dcf2", "fog-color": "#bfd0e3",
      "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.8,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 6, 1, 9, 0.2],
    },
    sources: {
      base: { type: "raster", tiles: [o + "/tiles/base/{z}/{x}/{y}"], tileSize: 256, maxzoom: 6 },
      detail: { type: "raster", tiles: [o + "/tiles/detail/{z}/{x}/{y}"], tileSize: 256, minzoom: 5, maxzoom: s.detailMaxZoom },
      borders: { type: "geojson", data: s.borders },
      rivers: { type: "geojson", data: s.rivers },
      highlights: { type: "geojson", data: s.highlights },
      lines: { type: "geojson", data: empty },
    },
    layers: [
      { id: "space", type: "background", paint: { "background-color": "#05070a" } },
      { id: "base", type: "raster", source: "base", paint: { "raster-fade-duration": 0, "raster-contrast": 0.05 } },
      // Fade detail in by zoom so the edge of a prepared region never shows in wide shots.
      { id: "detail", type: "raster", source: "detail", paint: { "raster-fade-duration": 0, "raster-opacity": ["interpolate", ["linear"], ["zoom"], 4.2, 0, 5.4, 1] } },
      { id: "hl-fill", type: "fill", source: "highlights", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.13 } },
      { id: "rivers", type: "line", source: "rivers", paint: { "line-color": "#a6d4ff", "line-opacity": 0.45, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 10, 1.6] } },
      { id: "borders-shadow", type: "line", source: "borders", paint: { "line-color": "rgba(0,0,0,0.35)", "line-width": ["interpolate", ["linear"], ["zoom"], 2, 1.5, 10, 3] } },
      { id: "borders", type: "line", source: "borders", paint: { "line-color": "rgba(255,255,255,0.55)", "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 10, 1.4] } },
      { id: "hl-line", type: "line", source: "highlights", paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 2, 1.5, 10, 3.5] } },
      { id: "river-glow", type: "line", source: "lines", filter: ["==", ["get", "kind"], "river"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#7cc4ff", "line-opacity": 0.3, "line-blur": 4, "line-width": ["interpolate", ["linear"], ["zoom"], 3, 6, 10, 14] } },
      { id: "river-line", type: "line", source: "lines", filter: ["==", ["get", "kind"], "river"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#8fd0ff", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 2, 10, 4.5] } },
      { id: "route-line", type: "line", source: "lines", filter: ["==", ["get", "kind"], "route"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-dasharray": [3, 2], "line-width": ["interpolate", ["linear"], ["zoom"], 3, 2.5, 10, 4.5] } },
    ],
  };
  if (s.terrain) {
    style.sources.dem = { type: "raster-dem", tiles: [o + "/tiles/dem/{z}/{x}/{y}"], tileSize: 256, maxzoom: 12, encoding: "terrarium" };
    style.terrain = { source: "dem", exaggeration: s.exaggeration };
  }
  map = new M({ container: "map", style, interactive: false, fadeDuration: 0, attributionControl: false, pixelRatio: 1, maxPitch: 85,
    canvasContextAttributes: { preserveDrawingBuffer: true, antialias: false } });
  await new Promise((r) => map.once("load", r));
};
window.renderFrame = async (f) => {
  map.jumpTo({ center: [f.camera.longitude, f.camera.latitude], zoom: f.camera.zoom, pitch: f.camera.pitch, bearing: f.camera.bearing });
  map.getSource("lines").setData(f.lines);
  const t0 = performance.now();
  let complete = true;
  for (;;) {
    await new Promise((r) => requestAnimationFrame(r));
    if (map.areTilesLoaded() && map.isStyleLoaded()) break;
    if (performance.now() - t0 > 60000) { complete = false; break; }
  }
  map.redraw();
  const canvas = map.getCanvas();
  const w = canvas.width, h = canvas.height;
  const anchors = f.anchors.map((ll) => {
    const p = map.project(ll);
    if (!(p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h)) return null;
    // Hidden behind the globe: the point's distance from the centre exceeds the visible horizon.
    const c = map.getCenter();
    const toRad = Math.PI / 180;
    const cosD = Math.sin(c.lat * toRad) * Math.sin(ll[1] * toRad) + Math.cos(c.lat * toRad) * Math.cos(ll[1] * toRad) * Math.cos((ll[0] - c.lng) * toRad);
    return cosD > 0.05 ? [p.x, p.y] : null;
  });
  const url = canvas.toDataURL("image/jpeg", 0.94);
  return { jpeg: url.slice(url.indexOf(",") + 1), anchors, complete };
};
window.ready = true;
</script></body></html>`;

const TYPES: Record<string, string> = { ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

/** Local HTTP server for the page: MapLibre assets plus imagery and terrain tiles from the server-side caches. */
class Globe3DServer {
  private server: http.Server | null = null;
  readonly imagery: ImageryTileService;
  readonly dem: TileFetcher;
  origin = "";

  constructor(imageryCfg: ImageryConfig, terrainCfg: TerrainConfig) {
    this.imagery = new ImageryTileService(imageryCfg);
    this.dem = terrainFetcher(terrainCfg);
  }

  async start(): Promise<void> {
    const dist = maplibreDist();
    this.server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
        if (url.pathname.startsWith("/maplibre/")) {
          const name = path.basename(url.pathname);
          const file = path.join(dist, name);
          if (!/^[\w.-]+$/.test(name) || !fs.existsSync(file)) return res.writeHead(404).end();
          return res.writeHead(200, { "content-type": TYPES[path.extname(name)] ?? "application/octet-stream" }).end(fs.readFileSync(file));
        }
        const m = url.pathname.match(/^\/tiles\/(base|detail|dem)\/(\d+)\/(\d+)\/(\d+)$/);
        if (m) {
          const [z, x, y] = [Number(m[2]), Number(m[3]), Number(m[4])];
          if (m[1] === "dem") {
            const buf = await this.dem.getTile(z, x, y);
            return buf ? res.writeHead(200, { "content-type": "image/png" }).end(buf) : res.writeHead(404).end();
          }
          const tile = await this.imagery.getTile(z, x, y, m[1] as "base" | "detail");
          return tile ? res.writeHead(200, { "content-type": tile.contentType }).end(tile.body) : res.writeHead(404).end();
        }
        res.writeHead(404).end();
      })().catch(() => res.writeHead(500).end());
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise((r) => this.server!.close(r));
    this.server = null;
  }
}

/** Where to find Chromium: CHROMIUM_PATH, else Playwright's own install. */
export function chromiumExecutable(): string | undefined {
  const p = process.env.CHROMIUM_PATH?.trim();
  return p ? p : undefined;
}

export class Globe3DUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Globe3DUnavailableError";
  }
}

/** One browser page rendering 3D frames at a fixed size. Reuse it across scenes; close it when done. */
export class Globe3DSession {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly server: Globe3DServer;

  constructor(readonly size: FrameSize, imageryCfg: ImageryConfig, terrainCfg: TerrainConfig) {
    this.server = new Globe3DServer(imageryCfg, terrainCfg);
  }

  /** Detail tile sources used so far (for credits). */
  get imageryFetcher(): TileFetcher {
    return this.server.imagery.fetcher;
  }

  get terrainAvailable(): boolean {
    return this.server.dem.providerEnabled;
  }

  get terrainLastError(): string | null {
    return this.server.dem.lastError;
  }

  async open(): Promise<void> {
    let chromium: BrowserType;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      throw new Globe3DUnavailableError("playwright-core is not installed, so the 3D view cannot render.");
    }
    await this.server.start();
    try {
      this.browser = await chromium.launch({
        executablePath: chromiumExecutable(),
        args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-dev-shm-usage"],
      });
    } catch (err) {
      await this.server.stop();
      throw new Globe3DUnavailableError(`Chromium could not start for the 3D view: ${(err as Error).message.split("\n")[0]}. Set CHROMIUM_PATH or install Playwright's Chromium.`);
    }
    this.page = await this.browser.newPage({ viewport: { width: this.size.width, height: this.size.height }, deviceScaleFactor: 1 });
    await this.page.goto(`${this.server.origin}/`);
    await this.page.waitForFunction(() => (globalThis as unknown as { ready?: boolean }).ready === true);
  }

  async setScene(data: Globe3DSceneData): Promise<void> {
    await this.page!.evaluate((d) => (globalThis as unknown as { setScene: (d: unknown) => Promise<void> }).setScene(d), data as unknown as Record<string, unknown>);
  }

  async frame(input: Globe3DFrameInput): Promise<Globe3DFrame> {
    const r = await this.page!.evaluate(
      (f) => (globalThis as unknown as { renderFrame: (f: unknown) => Promise<{ jpeg: string; anchors: ([number, number] | null)[]; complete: boolean }> }).renderFrame(f),
      input as unknown as Record<string, unknown>,
    );
    return { jpeg: Buffer.from(r.jpeg, "base64"), anchors: r.anchors, complete: r.complete };
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.page = null;
    await this.server.stop();
  }
}
