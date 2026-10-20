import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { geoOrthographic } from "d3-geo";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { FORMAT_LAYOUTS, sceneSchema, type FrameSize } from "@atlas/shared";
import {
  describeImagery,
  imageryConfigFromEnv,
  ImageryTileService,
  invertOrthographic,
  lonLatToTile,
  MapFrameRenderer,
  MapSceneRenderer,
  sceneCacheKey,
  tileZoomForScale,
  type ImageryConfig,
} from "@atlas/video-engine";
import { sceneFixture } from "../helpers/fixtures";

const hasBase = fs.existsSync(imageryConfigFromEnv().baseImagePath);

describe("imagery maths", () => {
  it("inverts d3's rotated orthographic projection, including roll", () => {
    const ll = new Float64Array(2);
    for (const [lon0, lat0, roll] of [
      [85, 27.5, 0],
      [-120, -40, 0],
      [170, 60, 12],
      [0, 0, -30],
    ] as const) {
      const scale = 900;
      const proj = geoOrthographic().rotate([-lon0, -lat0, roll]).scale(scale).translate([0, 0]);
      const g = (roll * Math.PI) / 180;
      for (const [dx, dy] of [
        [0, 0],
        [300, -200],
        [-650, 410],
        [120, 700],
      ] as const) {
        // d3 screen y grows downward; invertOrthographic takes y up.
        const expected = proj.invert!([dx, -dy])!;
        expect(invertOrthographic(dx, dy, scale, lon0, Math.sin((-lat0 * Math.PI) / 180), Math.cos((-lat0 * Math.PI) / 180), Math.sin(g), Math.cos(g), ll)).toBe(true);
        const dLon = ((ll[0]! - expected[0] + 540) % 360) - 180;
        expect(Math.abs(dLon)).toBeLessThan(1e-6);
        expect((Math.asin(ll[1]!) * 180) / Math.PI).toBeCloseTo(expected[1], 6);
      }
    }
    expect(invertOrthographic(1000, 0, 900, 0, 0, 1, 0, 1, ll)).toBe(false);
  });

  it("converts lon/lat to Web Mercator tile coordinates", () => {
    expect(lonLatToTile(0, 0, 1)).toEqual([1, 1]);
    const [x, y] = lonLatToTile(-180, 85.0511287798, 3);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(0, 6);
  });

  it("picks finer tile zooms for closer cameras and respects the provider's limit", () => {
    const a = tileZoomForScale(500, 27, 13);
    const b = tileZoomForScale(8000, 27, 13);
    expect(b).toBeGreaterThan(a);
    expect(tileZoomForScale(5_000_000, 27, 13)).toBe(13);
  });
});

describe("imagery configuration", () => {
  it("defaults to the keyless Sentinel-2 cloudless 2016 layer", () => {
    const cfg = imageryConfigFromEnv({});
    expect(cfg.provider).toBe("eox-s2cloudless");
    expect(cfg.tileUrl).toContain("tiles.maps.eox.at");
    expect(describeImagery(cfg).license).toBe("CC BY 4.0");
  });

  it("requires attribution, a valid URL and a key for custom providers", () => {
    const issues = describeImagery(imageryConfigFromEnv({ SATELLITE_PROVIDER: "custom", SATELLITE_TILE_URL: "http://tiles.example.com/{z}/{x}/{y}.jpg?k={key}" })).issues.join(" ");
    expect(issues).toContain("SATELLITE_ATTRIBUTION");
    expect(issues).toContain("https URL");
    expect(issues).toContain("SATELLITE_TILE_KEY");
    const ok = describeImagery(imageryConfigFromEnv({ SATELLITE_PROVIDER: "custom", SATELLITE_TILE_URL: "https://tiles.example.com/{z}/{x}/{y}.jpg?k={key}", SATELLITE_TILE_KEY: "k", SATELLITE_ATTRIBUTION: "Example" }));
    expect(ok.issues.filter((i) => !i.startsWith("Base imagery"))).toEqual([]);
  });

  it("refuses Google imagery for exported videos, by provider name or by tile host", () => {
    const named = imageryConfigFromEnv({ SATELLITE_PROVIDER: "google-map-tiles" });
    expect(named.provider).toBe("none");
    expect(describeImagery(named).issues.join(" ")).toContain("not licensed for exported user videos");
    const hosted = imageryConfigFromEnv({ SATELLITE_PROVIDER: "custom", SATELLITE_TILE_URL: "https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?key={key}", SATELLITE_TILE_KEY: "k", SATELLITE_ATTRIBUTION: "Google" });
    expect(describeImagery(hosted).issues.join(" ")).toContain("not licensed for exported user videos");
    expect(new ImageryTileService(hosted).fetcher.providerEnabled).toBe(false);
    for (const url of ["https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", "https://khms0.googleapis.com/kh?v=1&x={x}&y={y}&z={z}"]) {
      expect(describeImagery(imageryConfigFromEnv({ SATELLITE_PROVIDER: "custom", SATELLITE_TILE_URL: url, SATELLITE_ATTRIBUTION: "x" })).issues.join(" ")).toContain("not licensed");
    }
  });

  it("needs a key and a stated video licence before MapTiler Satellite is used", () => {
    const none = describeImagery(imageryConfigFromEnv({ SATELLITE_PROVIDER: "maptiler-satellite" })).issues.join(" ");
    expect(none).toContain("SATELLITE_TILE_KEY");
    expect(none).toContain("SATELLITE_VIDEO_LICENSE");
    const bad = describeImagery(imageryConfigFromEnv({ SATELLITE_PROVIDER: "maptiler-satellite", SATELLITE_TILE_KEY: "k", SATELLITE_VIDEO_LICENSE: "yes" })).issues;
    expect(bad.join(" ")).toContain("SATELLITE_VIDEO_LICENSE");
    const ok = imageryConfigFromEnv({ SATELLITE_PROVIDER: "maptiler-satellite", SATELLITE_TILE_KEY: "k", SATELLITE_VIDEO_LICENSE: "custom" });
    expect(describeImagery(ok).issues.filter((i) => !i.startsWith("Base imagery"))).toEqual([]);
    expect(ok.tileUrl).toContain("api.maptiler.com/tiles/satellite-v4/");
  });

  it("puts the basemap and imagery source into clip cache keys", () => {
    const scene = sceneFixture();
    const sat = sceneCacheKey(scene, undefined, "16:9", "draft", 30, { basemap: "satellite", imagery: "eox" });
    expect(sceneCacheKey(scene, undefined, "16:9", "draft", 30, { basemap: "vector" })).not.toBe(sat);
    expect(sceneCacheKey(scene, undefined, "16:9", "draft", 30, { basemap: "satellite", imagery: "custom" })).not.toBe(sat);
  });
});

// A local XYZ server standing in for a tile provider: every tile is solid red, so a frame shows
// whether detail tiles were drawn. This is a labelled test fixture, not real imagery.
describe.skipIf(!hasBase)("satellite rendering with a tile provider (local fixture server)", () => {
  let server: http.Server;
  let base: string;
  let requests = 0;
  let fail = false;
  let redTile: Buffer;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-tiles-"));
  const size: FrameSize = { width: 480, height: 270 };
  const scene = sceneSchema.parse({
    id: "s1",
    durationSeconds: 3,
    location: { name: "Nepal", latitude: 27.7, longitude: 85.3, source: "gazetteer" },
    camera: { move: "static", zoomStart: 4, zoomEnd: 4 },
  });
  const camera = { longitude: 85.3, latitude: 27.7, zoom: 4, roll: 0 };

  const cfg = (tag: string): ImageryConfig => ({
    ...imageryConfigFromEnv(),
    provider: "custom",
    tileUrl: `${base}/${tag}/{z}/{x}/{y}.jpg`,
    tileKey: null,
    tileAttribution: "Test tiles (fixture)",
    maxZoom: 12,
    cacheDir: path.join(tmp, "cache"),
    fetchTimeoutMs: 2000,
  });

  async function centrePixel(r: MapSceneRenderer) {
    const frame = new MapFrameRenderer(size);
    frame.beginScene([camera]);
    const prepared = await r.prepareImagery([camera], size);
    frame.setImagery(prepared.imagery);
    frame.render({ scene, camera, t: 1, seconds: 1, layout: FORMAT_LAYOUTS["16:9"], fade: 1 });
    const px = frame.canvas.getContext("2d").getImageData(size.width / 2, size.height / 2, 1, 1).data;
    return { px: [px[0]!, px[1]!, px[2]!], report: prepared.report };
  }

  beforeAll(async () => {
    const c = createCanvas(256, 256);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 256, 256);
    redTile = await c.encode("jpeg", 90);
    server = http.createServer((req, res) => {
      requests++;
      if (fail) {
        res.writeHead(500).end("down");
        return;
      }
      if (req.url?.includes("tiles.json")) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ attribution: '<a href="x">&copy; Fixture Imagery</a> <a>&copy; Second Source</a>' }));
        return;
      }
      res.writeHead(200, { "Content-Type": "image/jpeg" }).end(redTile);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("draws detail tiles at close zoom, credits the provider, and caches tiles on disk", async () => {
    const { px, report } = await centrePixel(new MapSceneRenderer({ imagery: cfg("ok") }));
    expect(px[0]).toBeGreaterThan(150);
    expect(px[1]).toBeLessThan(80);
    expect(report.detailZooms.length).toBeGreaterThan(0);
    expect(report.attribution).toContain("Test tiles (fixture)");
    expect(report.degraded).toBe(false);

    const before = requests;
    await centrePixel(new MapSceneRenderer({ imagery: cfg("ok") }));
    expect(requests).toBe(before);
  });

  it("falls back to the base image when tiles fail, and reports it", async () => {
    fail = true;
    const { px, report } = await centrePixel(new MapSceneRenderer({ imagery: cfg("down") }));
    fail = false;
    expect(px[0]).toBeLessThan(150);
    expect(report.degraded).toBe(true);
    expect(report.attribution).not.toContain("Test tiles (fixture)");
    expect(report.attribution).toContain("Imagery: NASA Blue Marble");
    expect(report.note).toContain("HTTP 500");
  });

  it("keeps MapTiler-style providers out of the disk cache and the preview proxy, and credits their TileJSON sources", async () => {
    const mt = { ...cfg("mt"), ...imageryConfigFromEnv({ SATELLITE_PROVIDER: "maptiler-satellite", SATELLITE_TILE_KEY: "k", SATELLITE_VIDEO_LICENSE: "flex" }) };
    const live = { ...mt, tileUrl: `${base}/mt/{z}/{x}/{y}?key={key}`, tileJsonUrl: `${base}/mt/tiles.json?key={key}`, cacheDir: path.join(tmp, "mt-cache"), regionsDir: null };
    expect(live.diskCache).toBe(false);
    expect(live.previewProxy).toBe(false);
    const fetcher = new ImageryTileService(live).fetcher;
    expect(fetcher.providerEnabled).toBe(true);
    expect(await fetcher.getTile(6, 47, 26)).not.toBeNull();
    expect(fs.existsSync(path.join(tmp, "mt-cache"))).toBe(false);
    expect([...fetcher.usedSources]).toEqual(["Imagery: © Fixture Imagery © Second Source"]);

    const before = requests;
    const preview = new ImageryTileService(live, null, true);
    expect((await preview.getTile(6, 47, 26))?.source).toBe("base");
    expect(requests).toBe(before);
  });

  it("serves preview tiles generated from the base image when no provider is configured", async () => {
    const svc = new ImageryTileService({ ...imageryConfigFromEnv(), provider: "none" });
    const tile = await svc.getTile(2, 2, 1);
    expect(tile?.source).toBe("base");
    const img = await loadImage(tile!.body);
    expect([img.width, img.height]).toEqual([256, 256]);
    expect(await svc.getTile(2, 9, 1)).toBeNull();
    expect(await svc.getTile(12, 0, 0)).toBeNull();
  });
});
