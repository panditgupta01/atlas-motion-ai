import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { checkGeoData } from "@atlas/geo";
import { frameSizeFor } from "@atlas/shared";
import { Globe3DSession, imageryConfigFromEnv, MapSceneRenderer, registerFonts, terrainConfigFromEnv, validateVideoFile } from "@atlas/video-engine";
import { sceneFixture } from "../helpers/fixtures";

// The 3D view needs headless Chromium (Playwright's, or CHROMIUM_PATH). Tiles and terrain stay
// offline here (vitest.config.ts), so the globe shows the bundled Blue Marble image without relief.
async function chromiumWorks() {
  const s = new Globe3DSession({ width: 64, height: 64 }, imageryConfigFromEnv(), terrainConfigFromEnv());
  try {
    await s.open();
    return true;
  } catch {
    return false;
  } finally {
    await s.close().catch(() => undefined);
  }
}

const ready = checkGeoData().ok && fs.existsSync(imageryConfigFromEnv().baseImagePath);
const chromium = ready && (await chromiumWorks());
if (!chromium) console.warn("Skipping the 3D render test: needs Chromium, Natural Earth data and the base imagery.");

describe.skipIf(!ready)("3D terrain view", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-3d-"));
  const scene = sceneFixture({ durationSeconds: 2, camera: { move: "zoom_to", zoomStart: 2, zoomEnd: 4, easing: "ease_in_out" } });
  registerFonts();

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it.skipIf(!chromium)("renders a tilted globe clip that passes validation and credits its sources", async () => {
    const renderer = new MapSceneRenderer();
    const output = path.join(tmp, "globe.mp4");
    try {
      const res = await renderer.renderScene({ scene, format: "16:9", quality: "draft", fps: 24, basemap: "satellite3d", output });
      expect(res.imagery.basemap).toBe("satellite3d");
      expect(res.imagery.attribution).toContain("Imagery: NASA Blue Marble");
      expect(res.imagery.attribution).toContain("Map data: Natural Earth");
      const size = frameSizeFor("16:9", "draft");
      const report = await validateVideoFile(output, { ...size, fps: 24, durationSeconds: 2, requireAudio: false });
      expect(report.issues).toEqual([]);
      // Mid-clip (no fade) the camera looks at Nepal: the centre is lit imagery, not dark space.
      const png = path.join(tmp, "mid.png");
      execFileSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", output, "-frames:v", "1", "-y", png]);
      const img = await loadImage(png);
      const c = createCanvas(img.width, img.height);
      c.getContext("2d").drawImage(img, 0, 0);
      const d = c.getContext("2d").getImageData(img.width / 2 - 20, img.height / 2 - 20, 40, 40).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
      expect(sum / (d.length / 4)).toBeGreaterThan(35);
    } finally {
      await renderer.close();
    }
  }, 600_000);

  it("falls back to the flat satellite view when Chromium cannot start, and says so", async () => {
    const saved = process.env.CHROMIUM_PATH;
    process.env.CHROMIUM_PATH = path.join(tmp, "no-such-chromium");
    const renderer = new MapSceneRenderer();
    try {
      const res = await renderer.renderScene({ scene, format: "16:9", quality: "draft", fps: 24, basemap: "satellite3d", output: path.join(tmp, "flat.mp4") });
      expect(res.imagery.basemap).toBe("satellite");
      expect(res.imagery.degraded).toBe(true);
      expect(res.imagery.note).toMatch(/flat satellite view was used/);
      expect(fs.existsSync(res.output)).toBe(true);
    } finally {
      await renderer.close();
      if (saved === undefined) delete process.env.CHROMIUM_PATH;
      else process.env.CHROMIUM_PATH = saved;
    }
  });
});
