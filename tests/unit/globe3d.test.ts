import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { FORMAT_LAYOUTS, camera3dAt, defaultPitch } from "@atlas/shared";
import { imageryConfigFromEnv, ImageryTileService, lonLatToTile, RegionTileStore, terrainConfigFromEnv, TileFetcher } from "@atlas/video-engine";
import { sceneFixture } from "../helpers/fixtures";

describe("3D camera", () => {
  const layout = FORMAT_LAYOUTS["16:9"];

  it("tilts more as the camera comes closer, and looks straight down at the whole globe", () => {
    expect(defaultPitch(1)).toBe(0);
    expect(defaultPitch(3)).toBeGreaterThan(defaultPitch(2));
    expect(defaultPitch(10)).toBe(65);
    const scene = sceneFixture({ camera: { move: "zoom_to", zoomStart: 1, zoomEnd: 5, easing: "ease_in_out" } });
    expect(camera3dAt(scene, undefined, 1, layout, 1080).pitch).toBeGreaterThan(camera3dAt(scene, undefined, 0, layout, 1080).pitch);
  });

  it("uses the scene's own pitch and heading when given, and turns during an orbit", () => {
    const fixed = sceneFixture({ camera: { move: "static", zoomStart: 5, zoomEnd: 5, easing: "linear", pitch: 30, bearing: 90 } });
    expect(camera3dAt(fixed, undefined, 0.5, layout, 1080)).toMatchObject({ pitch: 30, bearing: 90 });
    const orbit = sceneFixture({ camera: { move: "orbit", zoomStart: 5, zoomEnd: 5, easing: "linear" } });
    const a = camera3dAt(orbit, undefined, 0, layout, 1080).bearing;
    const b = camera3dAt(orbit, undefined, 1, layout, 1080).bearing;
    expect(b - a).toBeCloseTo(50);
  });

  it("converts to a higher MapLibre zoom for a bigger frame", () => {
    const scene = sceneFixture({ camera: { move: "static", zoomStart: 4, zoomEnd: 4, easing: "linear" } });
    expect(camera3dAt(scene, undefined, 0.5, layout, 2160).zoom).toBeCloseTo(camera3dAt(scene, undefined, 0.5, layout, 1080).zoom + 1, 5);
  });
});

// A prepared region on disk with one solid tile: a labelled test fixture, not real imagery.
describe("prepared imagery regions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-regions-"));
  const [tx, ty] = lonLatToTile(86.9, 27.9, 8).map(Math.floor) as [number, number];
  const c = createCanvas(256, 256);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#00ff00";
  ctx.fillRect(0, 0, 256, 256);
  fs.mkdirSync(path.join(dir, "test-region", "8", String(tx)), { recursive: true });
  fs.writeFileSync(path.join(dir, "test-region", "8", String(tx), `${ty}.jpg`), c.toBuffer("image/jpeg"));
  fs.writeFileSync(path.join(dir, "test-region", "region.json"), JSON.stringify({ name: "test-region", attribution: "Test region (fixture)", bbox: [86.5, 27.5, 87.5, 28.5], minZoom: 5, maxZoom: 8 }));
  fs.mkdirSync(path.join(dir, "broken"));
  fs.writeFileSync(path.join(dir, "broken", "region.json"), "{ not json");

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads region.json, skips unreadable regions, and serves tiles only inside the region", () => {
    const store = new RegionTileStore(dir);
    expect(store.regions.map((r) => r.name)).toEqual(["test-region"]);
    expect(store.getTile(8, tx, ty)?.region.attribution).toBe("Test region (fixture)");
    expect(store.getTile(9, tx * 2, ty * 2)).toBeNull();
    expect(store.getTile(8, tx + 40, ty)).toBeNull();
    expect(new RegionTileStore(null).regions).toEqual([]);
  });

  it("uses the region before any provider and credits it", async () => {
    const fetcher = new TileFetcher({ ...imageryConfigFromEnv({}), provider: "none", regionsDir: dir });
    expect(fetcher.enabled).toBe(true);
    expect(fetcher.providerEnabled).toBe(false);
    expect(await fetcher.getTile(8, tx, ty)).not.toBeNull();
    expect([...fetcher.usedSources]).toEqual(["Test region (fixture)"]);
    expect(await fetcher.getTile(8, tx + 40, ty)).toBeNull();
  });

  it("stacks a sharper region's partly transparent edge tile over a wider region", async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-stack-"));
    try {
      const write = (name: string, maxZoom: number, ext: "png" | "jpg", color: string, half: boolean) => {
        const cv = createCanvas(256, 256);
        const g = cv.getContext("2d");
        g.fillStyle = color;
        g.fillRect(0, 0, half ? 128 : 256, 256);
        fs.mkdirSync(path.join(d2, name, "8", String(tx)), { recursive: true });
        fs.writeFileSync(path.join(d2, name, "8", String(tx), `${ty}.${ext}`), ext === "png" ? cv.toBuffer("image/png") : cv.toBuffer("image/jpeg"));
        fs.writeFileSync(path.join(d2, name, "region.json"), JSON.stringify({ name, attribution: `${name} (fixture)`, bbox: [86, 27, 88, 29], minZoom: 5, maxZoom }));
      };
      write("a-wide", 8, "jpg", "#0000ff", false);
      write("z-sharp", 12, "png", "#ff0000", true);
      const fetcher = new TileFetcher({ ...imageryConfigFromEnv({}), provider: "none", regionsDir: d2 });
      expect(fetcher.regions.regions.map((r) => r.name)).toEqual(["z-sharp", "a-wide"]);
      const { loadImage } = await import("@napi-rs/canvas");
      const img = await loadImage((await fetcher.getTile(8, tx, ty))!);
      const cv = createCanvas(256, 256);
      cv.getContext("2d").drawImage(img, 0, 0);
      const px = (x: number) => [...cv.getContext("2d").getImageData(x, 128, 1, 1).data].slice(0, 3);
      expect(px(40)).toEqual([255, 0, 0]);
      expect(px(200)[2]).toBeGreaterThan(200);
      expect([...fetcher.usedSources].sort()).toEqual(["a-wide (fixture)", "z-sharp (fixture)"]);
    } finally {
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });

  it("turns regions and terrain off with 'none'", async () => {
    expect(imageryConfigFromEnv({ SATELLITE_REGIONS_DIR: "none" }).regionsDir).toBeNull();
    expect(terrainConfigFromEnv({ TERRAIN_TILE_URL: "none" }).tileUrl).toBeNull();
    const svc = new ImageryTileService({ ...imageryConfigFromEnv({}), provider: "none", regionsDir: null }, terrainConfigFromEnv({ TERRAIN_TILE_URL: "none" }));
    expect(svc.terrain).toBeNull();
    expect(await svc.getTerrainTile(3, 1, 1)).toBeNull();
  });
});
