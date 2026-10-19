import path from "node:path";
import fs from "node:fs";
import { createCanvas, GlobalFonts, type Canvas, type Image, type ImageData, type SKRSContext2D } from "@napi-rs/canvas";
import { geoDistance, geoGraticule10, geoOrthographic, geoPath, type GeoPermissibleObjects } from "d3-geo";
import type { Feature, FeatureCollection, Geometry, LineString, MultiLineString, Position } from "geojson";
import { clipFeatures, findRepoRoot, getCountryFeature, getRiverFeatures, loadDataset, loadSimplified, type BBox, type DatasetId, type PreparedFeature } from "@atlas/geo";
import type { FormatLayout, FrameSize, Overlay, Scene } from "@atlas/shared";
import { scaleForZoom, visibleRadiusDegrees, type CameraState } from "./camera.js";
import { sampleRaster as sampleInto, tileZoomForScale, type Mosaic, type Raster } from "./imagery.js";


export function fontsDir(): string {
  return process.env.ATLAS_FONTS_DIR ? path.resolve(process.env.ATLAS_FONTS_DIR) : path.join(findRepoRoot(), "assets", "fonts");
}

let fontsRegistered = false;
export function registerFonts(): void {
  if (fontsRegistered) return;
  const dir = fontsDir();
  const latin = path.join(dir, "NotoSans.ttf");
  const deva = path.join(dir, "NotoSansDevanagari.ttf");
  if (!fs.existsSync(latin) || !fs.existsSync(deva)) {
    throw new Error(`Fonts missing in ${dir}. Run scripts/fetch-assets.sh to download Noto Sans and Noto Sans Devanagari (OFL).`);
  }
  GlobalFonts.registerFromPath(latin, "Noto Sans");
  GlobalFonts.registerFromPath(deva, "Noto Sans Devanagari");
  fontsRegistered = true;
}

const DEVANAGARI = /[ऀ-ॿ]/;
export function fontFamilyFor(text: string): string {
  return DEVANAGARI.test(text) ? '"Noto Sans Devanagari", "Noto Sans"' : '"Noto Sans", "Noto Sans Devanagari"';
}

export const PALETTE = {
  background: "#090d12",
  ocean: "#0e1822",
  oceanRim: "#1b2a38",
  land: "#1d2529",
  border: "#3a464d",
  graticule: "rgba(140,170,200,0.07)",
  river: "#3f8fd2",
  riverHighlight: "#7cc4ff",
  lake: "#163049",
  highlight: "#e0b04c",
  route: "#e8eef2",
  text: "#f2f5f7",
  textMuted: "#a9b4bb",
  halo: "rgba(5,8,12,0.85)",
  marker: "#ff6b4a",
};

/** Satellite imagery prepared for one scene (see MapSceneRenderer.prepareImagery). */
export interface SceneImagery {
  base: Raster | null;
  /** Detail mosaics by tile zoom. */
  mosaics: Map<number, Mosaic>;
  maxZoom: number;
  /** Credit lines for what this scene draws. */
  attribution: string[];
}

/** Colours used over satellite imagery, where the vector land fill is not drawn. */
export const SATELLITE_PALETTE = {
  space: "#05070a",
  border: "rgba(255,255,255,0.42)",
  borderShadow: "rgba(0,0,0,0.35)",
  river: "rgba(150,205,255,0.5)",
  atmosphere: "rgba(120,170,230,",
};

const MERC_LIMIT = Math.sin((85.0511287798 * Math.PI) / 180);

/**
 * Inverse of d3's geoOrthographic().rotate([-lon0, -lat0, roll]).scale(scale)
 * for a screen offset (dx right, dy up, in pixels) from the centre. Writes
 * [lonDeg, sinLat] into out and returns false for points off the globe.
 */
export function invertOrthographic(dx: number, dy: number, scale: number, lon0: number, sinP: number, cosP: number, sinG: number, cosG: number, out: Float64Array): boolean {
  const x = dx / scale;
  const y = dy / scale;
  const rho2 = x * x + y * y;
  if (rho2 > 1) return false;
  // Point on the unit sphere in the rotated frame (d3's cartesian convention), then undo the rotation.
  const xc = Math.sqrt(1 - rho2);
  const k = y * cosG - x * sinG;
  const lam = Math.atan2(x * cosG + y * sinG, xc * cosP + k * sinP);
  let lon = (lam * 180) / Math.PI + lon0;
  if (lon > 180) lon -= 360;
  else if (lon < -180) lon += 360;
  out[0] = lon;
  out[1] = k * cosP - xc * sinP;
  return true;
}

export interface FrameRenderInput {
  scene: Scene;
  camera: CameraState;
  /** Normalised scene time 0..1. */
  t: number;
  /** Absolute seconds since scene start (for pulses). */
  seconds: number;
  layout: FormatLayout;
  /** 0..1 brightness multiplier for scene-edge dips. */
  fade: number;
}

type Ctx = SKRSContext2D;

function bboxVisible(b: BBox, cam: CameraState, radius: number): boolean {
  if (radius >= 60) return true;
  const latMin = cam.latitude - radius;
  const latMax = cam.latitude + radius;
  if (b[3] < latMin || b[1] > latMax) return false;
  const maxLat = Math.min(89, Math.abs(cam.latitude) + radius);
  const lonHalf = radius / Math.cos((maxLat * Math.PI) / 180);
  if (lonHalf >= 180) return true;
  const lonMin = cam.longitude - lonHalf;
  const lonMax = cam.longitude + lonHalf;
  for (const shift of [-360, 0, 360]) {
    if (b[2] + shift >= lonMin && b[0] + shift <= lonMax) return true;
  }
  return false;
}

function lineParts(g: Geometry): Position[][] {
  if (g.type === "LineString") return [(g as LineString).coordinates];
  if (g.type === "MultiLineString") return (g as MultiLineString).coordinates;
  return [];
}

/** Truncate each line to a fraction of its vertex path length (planar in degrees; adequate for reveal animation). */
function partialLines(lines: Position[][], fraction: number): Position[][] {
  if (fraction >= 1) return lines;
  return lines.map((line) => {
    const seg: number[] = [];
    let total = 0;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      const d = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
      seg.push(d);
      total += d;
    }
    const stop = total * fraction;
    const out: Position[] = [line[0]!];
    let acc = 0;
    for (let i = 1; i < line.length; i++) {
      const d = seg[i - 1]!;
      if (acc + d >= stop) {
        const a = line[i - 1]!;
        const b = line[i]!;
        const k = d === 0 ? 0 : (stop - acc) / d;
        out.push([a[0]! + (b[0]! - a[0]!) * k, a[1]! + (b[1]! - a[1]!) * k]);
        break;
      }
      out.push(line[i]!);
      acc += d;
    }
    return out;
  });
}

/**
 * Draws one map frame: an orthographic globe/regional view with satellite
 * imagery (or a flat vector look) under Natural Earth borders and rivers,
 * plus the scene's overlays. This is a 2D renderer; it does not render
 * terrain relief.
 */
export class MapFrameRenderer {
  readonly canvas: Canvas;
  private readonly ctx: Ctx;
  private readonly riverCache = new Map<string, Feature<Geometry>[]>();
  /** Scene-wide lon/lat window covering every frame; layers are clipped to it once per scene. */
  private window: BBox | null = null;
  private readonly layerCache = new Map<string, PreparedFeature[]>();
  private imagery: SceneImagery | null = null;
  /** Imagery buffers by downscale factor (1 = full resolution). */
  private readonly pixelBuffers = new Map<number, { canvas: Canvas; pixels: ImageData }>();

  constructor(readonly size: FrameSize) {
    registerFonts();
    this.canvas = createCanvas(size.width, size.height);
    this.ctx = this.canvas.getContext("2d");
  }

  /**
   * Prepare for a scene: compute the area any frame can show and clip map
   * layers to it once, so per-frame drawing only touches nearby geometry.
   */
  beginScene(cameras: CameraState[]): void {
    this.layerCache.clear();
    this.window = null;
    let w: BBox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const cam of cameras) {
      const r = visibleRadiusDegrees(scaleForZoom(cam.zoom, this.size), this.size) * 1.15;
      if (r >= 45) return;
      const maxLat = Math.min(89, Math.abs(cam.latitude) + r);
      const lonHalf = r / Math.cos((maxLat * Math.PI) / 180);
      w = [Math.min(w[0], cam.longitude - lonHalf), Math.min(w[1], cam.latitude - r), Math.max(w[2], cam.longitude + lonHalf), Math.max(w[3], cam.latitude + r)];
    }
    if (w[0] < -180 || w[2] > 180 || w[1] < -90 || w[3] > 90 || !Number.isFinite(w[0])) return;
    this.window = w;
  }

  /** Satellite imagery for the next frames, or null for the vector-only look. */
  setImagery(imagery: SceneImagery | null): void {
    this.imagery = imagery;
  }

  /**
   * Fill the globe with satellite imagery: every pixel is inverse-projected to
   * lon/lat and sampled from the best available layer (detail mosaic at the
   * frame's tile zoom, then coarser mosaics, then the whole-world base image).
   */
  private drawSatellite(camera: CameraState, scale: number): void {
    const img = this.imagery!;
    const z = tileZoomForScale(scale, camera.latitude, img.maxZoom);
    const layers: Mosaic[] = [];
    for (let zz = z; zz >= 0; zz--) {
      const m = img.mosaics.get(zz);
      if (m) layers.push(m);
    }
    // The base image is at least 2x upscaled at every zoom it is used for, so frames drawn only
    // from it are computed at half resolution and scaled up, which looks the same and is 4x faster.
    const factor = layers.length ? 1 : 2;
    let buf = this.pixelBuffers.get(factor);
    if (!buf) {
      const canvas = factor === 1 ? this.canvas : createCanvas(Math.ceil(this.size.width / factor), Math.ceil(this.size.height / factor));
      buf = { canvas, pixels: canvas.getContext("2d").createImageData(canvas.width, canvas.height) };
      this.pixelBuffers.set(factor, buf);
    }
    const width = buf.canvas.width;
    const height = buf.canvas.height;
    scale /= factor;
    const out = buf.pixels.data;
    const base = img.base;
    const sinP = Math.sin((-camera.latitude * Math.PI) / 180);
    const cosP = Math.cos((-camera.latitude * Math.PI) / 180);
    const g = (camera.roll * Math.PI) / 180;
    const sinG = Math.sin(g);
    const cosG = Math.cos(g);
    const ll = new Float64Array(2);
    const cx = width / 2;
    const cy = height / 2;

    // Sample one pixel from lon, Mercator y (NaN outside Mercator's range) and latitude.
    const shade = (lon: number, my: number, lat: number, o: number) => {
      out[o + 3] = 255;
      if (my === my && layers.length) {
        const mx = (lon + 180) / 360;
        for (const m of layers) {
          const world = 256 * 2 ** m.z;
          let x = mx * world - m.tx0 * 256 - 0.5;
          if (x < 0) x += world;
          else if (x >= m.raster.width && x - world >= 0) x -= world;
          if (sampleInto(m.raster, x, my * world - m.ty0 * 256 - 0.5, 0, out, o)) return;
        }
      }
      if (base && sampleInto(base, ((lon + 180) / 360) * base.width - 0.5, ((90 - lat) / 180) * base.height - 0.5, base.width, out, o)) return;
      out[o] = 14;
      out[o + 1] = 24;
      out[o + 2] = 34;
    };
    const exact = (px: number, py: number) => {
      const o = (py * width + px) * 4;
      if (!invertOrthographic(px + 0.5 - cx, cy - (py + 0.5), scale, camera.longitude, sinP, cosP, sinG, cosG, ll)) {
        out[o] = 5;
        out[o + 1] = 7;
        out[o + 2] = 10;
        out[o + 3] = 255;
        return;
      }
      const sl = ll[1]!;
      shade(ll[0]!, sl < MERC_LIMIT && sl > -MERC_LIMIT ? 0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI) : NaN, (Math.asin(sl) * 180) / Math.PI, o);
    };

    // The inverse projection is smooth away from the limb, so it is computed exactly on a coarse
    // grid and interpolated inside blocks; blocks touching the limb or the antimeridian use exact maths.
    const STEP = 8;
    const gw = Math.ceil(width / STEP) + 1;
    const gh = Math.ceil(height / STEP) + 1;
    const gLon = new Float64Array(gw * gh);
    const gMy = new Float64Array(gw * gh);
    const gLat = new Float64Array(gw * gh);
    const gIn = new Uint8Array(gw * gh);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        if (invertOrthographic(i * STEP + 0.5 - cx, cy - (j * STEP + 0.5), scale, camera.longitude, sinP, cosP, sinG, cosG, ll)) {
          const sl = ll[1]!;
          gIn[k] = sl < MERC_LIMIT && sl > -MERC_LIMIT ? 1 : 0;
          gLon[k] = ll[0]!;
          gMy[k] = 0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI);
          gLat[k] = (Math.asin(sl) * 180) / Math.PI;
        }
      }
    }
    for (let bj = 0; bj < gh - 1; bj++) {
      const y0 = bj * STEP;
      const y1 = Math.min(height, y0 + STEP);
      for (let bi = 0; bi < gw - 1; bi++) {
        const x0 = bi * STEP;
        const x1 = Math.min(width, x0 + STEP);
        const k00 = bj * gw + bi;
        const k10 = k00 + 1;
        const k01 = k00 + gw;
        const k11 = k01 + 1;
        const lons = [gLon[k00]!, gLon[k10]!, gLon[k01]!, gLon[k11]!];
        if (!(gIn[k00] && gIn[k10] && gIn[k01] && gIn[k11]) || Math.max(...lons) - Math.min(...lons) > 90) {
          for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) exact(px, py);
          continue;
        }
        for (let py = y0; py < y1; py++) {
          const fy = (py - y0) / STEP;
          const lonL = lons[0]! + (lons[2]! - lons[0]!) * fy;
          const lonR = lons[1]! + (lons[3]! - lons[1]!) * fy;
          const myL = gMy[k00]! + (gMy[k01]! - gMy[k00]!) * fy;
          const myR = gMy[k10]! + (gMy[k11]! - gMy[k10]!) * fy;
          const laL = gLat[k00]! + (gLat[k01]! - gLat[k00]!) * fy;
          const laR = gLat[k10]! + (gLat[k11]! - gLat[k10]!) * fy;
          let o = (py * width + x0) * 4;
          for (let px = x0; px < x1; px++, o += 4) {
            const fx = (px - x0) / STEP;
            shade(lonL + (lonR - lonL) * fx, myL + (myR - myL) * fx, laL + (laR - laL) * fx, o);
          }
        }
      }
    }
    if (factor === 1) {
      this.ctx.putImageData(buf.pixels, 0, 0);
    } else {
      buf.canvas.getContext("2d").putImageData(buf.pixels, 0, 0);
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = "high";
      this.ctx.drawImage(buf.canvas, 0, 0, this.size.width, this.size.height);
    }
  }

  /** Thin atmosphere glow around the limb when the globe edge is in view. */
  private drawAtmosphere(scale: number): void {
    const { ctx, size } = this;
    if (scale > Math.hypot(size.width, size.height)) return;
    const cx = size.width / 2;
    const cy = size.height / 2;
    const glow = ctx.createRadialGradient(cx, cy, scale * 0.985, cx, cy, scale * 1.08);
    glow.addColorStop(0, `${SATELLITE_PALETTE.atmosphere}0.55)`);
    glow.addColorStop(0.35, `${SATELLITE_PALETTE.atmosphere}0.18)`);
    glow.addColorStop(1, `${SATELLITE_PALETTE.atmosphere}0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, scale * 1.08, 0, Math.PI * 2);
    ctx.arc(cx, cy, scale * 0.985, 0, Math.PI * 2, true);
    ctx.fill();
    const shade = ctx.createRadialGradient(cx, cy, scale * 0.7, cx, cy, scale);
    shade.addColorStop(0, "rgba(0,0,0,0)");
    shade.addColorStop(1, "rgba(0,0,0,0.35)");
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(cx, cy, scale, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Map layer at the right level of detail for a zoom, clipped to the scene window. */
  private layer(kind: "countries" | "rivers" | "lakes", zoom: number): PreparedFeature[] {
    const level = zoom < 1.8 ? "110m" : zoom < 3.2 ? "50m" : zoom < 5.5 ? "10m-s" : "10m";
    const key = `${kind}:${level}`;
    let hit = this.layerCache.get(key);
    if (hit) return hit;
    const base = level === "10m-s" ? loadSimplified(`${kind}10m` as DatasetId, 0.008) : loadDataset(`${kind}${level}` as DatasetId);
    hit = this.window ? clipFeatures(base, this.window) : base;
    this.layerCache.set(key, hit);
    return hit;
  }

  private unit(): number {
    return Math.min(this.size.width, this.size.height);
  }

  private rivers(name: string): Feature<Geometry>[] {
    let f = this.riverCache.get(name);
    if (!f) {
      f = getRiverFeatures(name);
      this.riverCache.set(name, f);
    }
    return f;
  }

  render(input: FrameRenderInput): Canvas {
    const { ctx, size } = this;
    const { camera, scene, t } = input;
    const scale = scaleForZoom(camera.zoom, size);
    const projection = geoOrthographic()
      .rotate([-camera.longitude, -camera.latitude, camera.roll])
      .scale(scale)
      .translate([size.width / 2, size.height / 2])
      .clipAngle(90)
      .precision(0.5);
    const pathGen = geoPath(projection, ctx as unknown as Parameters<typeof geoPath>[1] & object);
    const radius = visibleRadiusDegrees(scale, size);
    const detailed = camera.zoom >= 3.2;
    const u = this.unit();
    const lw = (px: number) => Math.max(0.5, (px * u) / 1080);

    ctx.save();
    const satellite = this.imagery !== null;
    const visible = (list: PreparedFeature[]) => list.filter((f) => bboxVisible(f.bbox, camera, radius));
    const countries = visible(this.layer("countries", camera.zoom));

    if (satellite) {
      this.drawSatellite(camera, scale);
      this.drawAtmosphere(scale);
      // Borders over imagery: a dark under-stroke keeps them visible over bright desert and snow.
      ctx.beginPath();
      for (const f of countries) pathGen(f.feature as GeoPermissibleObjects);
      ctx.lineJoin = "round";
      ctx.strokeStyle = SATELLITE_PALETTE.borderShadow;
      ctx.lineWidth = lw(detailed ? 3 : 2);
      ctx.stroke();
      ctx.strokeStyle = SATELLITE_PALETTE.border;
      ctx.lineWidth = lw(detailed ? 1.4 : 0.9);
      ctx.stroke();
    } else {
      ctx.fillStyle = PALETTE.background;
      ctx.fillRect(0, 0, size.width, size.height);

      // Ocean disc
      ctx.beginPath();
      pathGen({ type: "Sphere" } as GeoPermissibleObjects);
      ctx.fillStyle = PALETTE.ocean;
      ctx.fill();
      ctx.strokeStyle = PALETTE.oceanRim;
      ctx.lineWidth = lw(2);
      ctx.stroke();

      // Graticule
      ctx.beginPath();
      pathGen(geoGraticule10());
      ctx.strokeStyle = PALETTE.graticule;
      ctx.lineWidth = lw(1);
      ctx.stroke();

      ctx.beginPath();
      for (const f of countries) pathGen(f.feature as GeoPermissibleObjects);
      ctx.fillStyle = PALETTE.land;
      ctx.fill();
      ctx.strokeStyle = PALETTE.border;
      ctx.lineWidth = lw(detailed ? 1.6 : 1);
      ctx.stroke();
    }

    // Highlighted countries
    for (const o of scene.overlays) {
      if (o.type !== "highlight_country") continue;
      const cf = getCountryFeature(o.iso3);
      if (!cf) continue;
      const appear = Math.min(1, t / 0.3);
      ctx.beginPath();
      pathGen(cf.feature as GeoPermissibleObjects);
      ctx.globalAlpha = (satellite ? 0.12 : 0.16) * appear;
      ctx.fillStyle = o.color ?? PALETTE.highlight;
      ctx.fill();
      ctx.globalAlpha = appear;
      ctx.strokeStyle = o.color ?? PALETTE.highlight;
      ctx.lineWidth = lw(3);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Lakes and background rivers. Imagery already shows water, so only faint river lines go over it.
    if (!satellite) {
      ctx.beginPath();
      for (const f of visible(this.layer("lakes", camera.zoom))) pathGen(f.feature as GeoPermissibleObjects);
      ctx.fillStyle = PALETTE.lake;
      ctx.fill();
    }

    ctx.beginPath();
    for (const f of visible(this.layer("rivers", camera.zoom))) pathGen(f.feature as GeoPermissibleObjects);
    ctx.strokeStyle = satellite ? SATELLITE_PALETTE.river : PALETTE.river;
    ctx.globalAlpha = satellite ? (detailed ? 0.6 : 0.3) : detailed ? 0.75 : 0.45;
    ctx.lineWidth = lw(detailed ? (satellite ? 1.4 : 2) : 1.2);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.globalAlpha = 1;

    this.drawOverlays(input, projection, pathGen, lw);
    this.drawAttribution();

    if (input.fade < 1) {
      ctx.fillStyle = `rgba(0,0,0,${(1 - input.fade).toFixed(3)})`;
      ctx.fillRect(0, 0, size.width, size.height);
    }
    ctx.restore();
    return this.canvas;
  }

  /** Rivers (cut to their reveal progress) and routes for the 3D page, which drapes them on the terrain. */
  overlayLines3d(scene: Scene, t: number): FeatureCollection {
    const reveal = Math.min(1, t / 0.7);
    const features: Feature[] = [];
    for (const o of scene.overlays) {
      if (o.type === "river") {
        const lines = this.rivers(o.datasetName).flatMap((f) => lineParts(f.geometry));
        features.push({ type: "Feature", properties: { kind: "river" }, geometry: { type: "MultiLineString", coordinates: o.animate ? partialLines(lines, reveal) : lines } });
      } else if (o.type === "route") {
        const coords = o.animate ? partialLines([o.coordinates], reveal)[0]! : o.coordinates;
        features.push({ type: "Feature", properties: { kind: "route", color: o.color ?? PALETTE.route }, geometry: { type: "LineString", coordinates: coords } });
      }
    }
    return { type: "FeatureCollection", features };
  }

  /** Points whose screen positions the 3D page reports back, keyed by overlay index. */
  overlayAnchors3d(scene: Scene, t: number): { key: string; lonLat: [number, number] }[] {
    const reveal = Math.min(1, t / 0.7);
    const out: { key: string; lonLat: [number, number] }[] = [];
    scene.overlays.forEach((o, i) => {
      if (o.type === "marker" || o.type === "location_label") out.push({ key: String(i), lonLat: [o.longitude, o.latitude] });
      else if (o.type === "river" && o.label) {
        const lines = this.rivers(o.datasetName).flatMap((f) => lineParts(f.geometry));
        if (lines.length) {
          const longest = lines.reduce((a, b) => (b.length > a.length ? b : a));
          const mid = longest[Math.floor(longest.length / 2)];
          if (mid) out.push({ key: String(i), lonLat: [mid[0]!, mid[1]!] });
        }
      } else if (o.type === "route" && o.label) {
        const coords = o.animate ? partialLines([o.coordinates], reveal)[0]! : o.coordinates;
        const last = coords[coords.length - 1];
        if (last) out.push({ key: String(i), lonLat: [last[0]!, last[1]!] });
      } else if (o.type === "arrow") {
        out.push({ key: `${i}:from`, lonLat: o.from });
        out.push({ key: `${i}:to`, lonLat: o.to });
      }
    });
    return out;
  }

  /**
   * Finish a 3D frame: draw the terrain image from the browser, then markers,
   * labels, arrows, legend, title card and credits at the screen positions the
   * page reported, then the scene-edge fade.
   */
  composite3d(input: FrameRenderInput, image: Image, anchors: Map<string, [number, number] | null>, credits: string[]): Canvas {
    const { ctx, size } = this;
    const { scene, t, layout } = input;
    const u = this.unit();
    const lw = (px: number) => Math.max(0.5, (px * u) / 1080);
    const reveal = Math.min(1, t / 0.7);
    ctx.save();
    ctx.drawImage(image, 0, 0, size.width, size.height);
    scene.overlays.forEach((o, i) => {
      if (o.type === "arrow") {
        const a = anchors.get(`${i}:from`);
        const b = anchors.get(`${i}:to`);
        if (a && b) this.arrow(a[0], a[1], b[0], b[1], reveal, lw, o.label);
        return;
      }
      const p = anchors.get(String(i));
      if (!p) return;
      if (o.type === "river" && o.label) this.label(o.label, p[0], p[1], u * 0.032, Math.min(1, t / 0.4), "#cfe8ff");
      else if (o.type === "route" && o.label) this.label(o.label, p[0], p[1] - u * 0.03, u * 0.03, 1);
      else if (o.type === "marker") {
        const r = u * 0.012;
        if (o.pulse) {
          const phase = (input.seconds % 1.6) / 1.6;
          ctx.beginPath();
          ctx.arc(p[0], p[1], r + phase * r * 3, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,107,74,${(1 - phase).toFixed(3)})`;
          ctx.lineWidth = lw(3);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
        ctx.fillStyle = PALETTE.marker;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = lw(2.5);
        ctx.stroke();
        if (o.label) this.label(o.label, p[0], p[1] - r * 2.6, u * 0.034, Math.min(1, t / 0.3));
      } else if (o.type === "location_label") {
        this.label(o.text, p[0], p[1], u * 0.045, Math.min(1, Math.max(0, (t - 0.15) / 0.3)), PALETTE.text, true);
      }
    });
    const legend = scene.overlays.find((o): o is Extract<Overlay, { type: "legend" }> => o.type === "legend");
    if (legend) this.legend(legend.items, layout);
    const title = scene.overlays.find((o): o is Extract<Overlay, { type: "title_card" }> => o.type === "title_card");
    if (title) this.titleCard(title.text, title.subtitle, layout, t);
    this.drawCredits(credits);
    if (input.fade < 1) {
      ctx.fillStyle = `rgba(0,0,0,${(1 - input.fade).toFixed(3)})`;
      ctx.fillRect(0, 0, size.width, size.height);
    }
    ctx.restore();
    return this.canvas;
  }

  private isFacing(lonLat: [number, number], cam: CameraState): boolean {
    return geoDistance(lonLat, [cam.longitude, cam.latitude]) < Math.PI / 2 - 0.01;
  }

  private drawOverlays(
    input: FrameRenderInput,
    projection: ReturnType<typeof geoOrthographic>,
    pathGen: ReturnType<typeof geoPath>,
    lw: (px: number) => number,
  ): void {
    const { ctx } = this;
    const { scene, t, camera, layout } = input;
    const u = this.unit();
    const reveal = Math.min(1, t / 0.7);

    for (const o of scene.overlays) {
      if (o.type === "river") {
        const lines = this.rivers(o.datasetName).flatMap((f) => lineParts(f.geometry));
        const partial = o.animate ? partialLines(lines, reveal) : lines;
        ctx.beginPath();
        pathGen({ type: "MultiLineString", coordinates: partial } as GeoPermissibleObjects);
        ctx.strokeStyle = "rgba(124,196,255,0.25)";
        ctx.lineWidth = lw(12);
        ctx.stroke();
        ctx.strokeStyle = PALETTE.riverHighlight;
        ctx.lineWidth = lw(4.5);
        ctx.stroke();
        if (o.label && lines.length) {
          const longest = lines.reduce((a, b) => (b.length > a.length ? b : a));
          const mid = longest[Math.floor(longest.length / 2)] as [number, number];
          if (mid && this.isFacing(mid, camera)) {
            const p = projection(mid);
            if (p) this.label(o.label, p[0], p[1], u * 0.032, Math.min(1, t / 0.4), "#cfe8ff");
          }
        }
      } else if (o.type === "route") {
        const coords = o.animate ? partialLines([o.coordinates], reveal)[0]! : o.coordinates;
        ctx.beginPath();
        pathGen({ type: "LineString", coordinates: coords } as GeoPermissibleObjects);
        ctx.setLineDash([lw(14), lw(10)]);
        ctx.strokeStyle = o.color ?? PALETTE.route;
        ctx.lineWidth = lw(4);
        ctx.stroke();
        ctx.setLineDash([]);
        if (o.label) {
          const last = coords[coords.length - 1] as [number, number];
          const p = this.isFacing(last, camera) ? projection(last) : null;
          if (p) this.label(o.label, p[0], p[1] - u * 0.03, u * 0.03, 1);
        }
      } else if (o.type === "arrow") {
        const a = this.isFacing(o.from, camera) ? projection(o.from) : null;
        const b = this.isFacing(o.to, camera) ? projection(o.to) : null;
        if (a && b) this.arrow(a[0], a[1], b[0], b[1], reveal, lw, o.label);
      }
    }

    for (const o of scene.overlays) {
      if (o.type === "marker") {
        const ll: [number, number] = [o.longitude, o.latitude];
        if (!this.isFacing(ll, camera)) continue;
        const p = projection(ll);
        if (!p) continue;
        const r = u * 0.012;
        if (o.pulse) {
          const phase = (input.seconds % 1.6) / 1.6;
          ctx.beginPath();
          ctx.arc(p[0], p[1], r + phase * r * 3, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,107,74,${(1 - phase).toFixed(3)})`;
          ctx.lineWidth = lw(3);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
        ctx.fillStyle = PALETTE.marker;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = lw(2.5);
        ctx.stroke();
        if (o.label) this.label(o.label, p[0], p[1] - r * 2.6, u * 0.034, Math.min(1, t / 0.3));
      } else if (o.type === "location_label") {
        const ll: [number, number] = [o.longitude, o.latitude];
        if (!this.isFacing(ll, camera)) continue;
        const p = projection(ll);
        if (p) this.label(o.text, p[0], p[1], u * 0.045, Math.min(1, Math.max(0, (t - 0.15) / 0.3)), PALETTE.text, true);
      }
    }

    const legend = scene.overlays.find((o): o is Extract<Overlay, { type: "legend" }> => o.type === "legend");
    if (legend) this.legend(legend.items, layout);
    const title = scene.overlays.find((o): o is Extract<Overlay, { type: "title_card" }> => o.type === "title_card");
    if (title) this.titleCard(title.text, title.subtitle, layout, t);
  }

  label(text: string, x: number, y: number, px: number, alpha: number, color = PALETTE.text, bold = false): void {
    if (alpha <= 0) return;
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${bold ? "600 " : ""}${Math.round(px)}px ${fontFamilyFor(text)}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Keep labels inside the frame.
    const w = ctx.measureText(text).width;
    const margin = this.unit() * 0.04;
    const cx = Math.min(this.size.width - margin - w / 2, Math.max(margin + w / 2, x));
    ctx.lineJoin = "round";
    ctx.strokeStyle = PALETTE.halo;
    ctx.lineWidth = px * 0.22;
    ctx.strokeText(text, cx, y);
    ctx.fillStyle = color;
    ctx.fillText(text, cx, y);
    ctx.restore();
  }

  private arrow(x1: number, y1: number, x2: number, y2: number, k: number, lw: (n: number) => number, label?: string): void {
    const { ctx } = this;
    const x = x1 + (x2 - x1) * k;
    const y = y1 + (y2 - y1) * k;
    ctx.save();
    ctx.strokeStyle = PALETTE.route;
    ctx.fillStyle = PALETTE.route;
    ctx.lineWidth = lw(4);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x, y);
    ctx.stroke();
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const h = lw(18);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - h * Math.cos(ang - 0.45), y - h * Math.sin(ang - 0.45));
    ctx.lineTo(x - h * Math.cos(ang + 0.45), y - h * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (label) this.label(label, (x1 + x2) / 2, (y1 + y2) / 2 - lw(24), this.unit() * 0.03, k);
  }

  private legend(items: { label: string; color: string }[], layout: FormatLayout): void {
    const { ctx, size } = this;
    const u = this.unit();
    const px = Math.round(u * 0.028);
    const pad = u * 0.02;
    const rowH = px * 1.6;
    ctx.save();
    ctx.font = `${px}px "Noto Sans", "Noto Sans Devanagari"`;
    const w = Math.max(...items.map((i) => ctx.measureText(i.label).width)) + px * 2.2 + pad * 2;
    const h = items.length * rowH + pad * 2 - (rowH - px);
    const x = size.width * layout.safe.left;
    const y = layout.legendCorner === "top-left" ? size.height * (layout.safe.top + 0.12) : size.height * (1 - layout.safe.bottom) - h - u * 0.12;
    ctx.fillStyle = "rgba(9,13,18,0.78)";
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, u * 0.01);
    ctx.fill();
    ctx.stroke();
    items.forEach((item, i) => {
      const cy = y + pad + i * rowH + px / 2;
      ctx.fillStyle = item.color;
      ctx.fillRect(x + pad, cy - px * 0.35, px * 0.7, px * 0.7);
      ctx.fillStyle = PALETTE.text;
      ctx.textBaseline = "middle";
      ctx.font = `${px}px ${fontFamilyFor(item.label)}`;
      ctx.fillText(item.label, x + pad + px * 1.4, cy);
    });
    ctx.restore();
  }

  private titleCard(text: string, subtitle: string | undefined, layout: FormatLayout, t: number): void {
    const { ctx, size } = this;
    const u = this.unit();
    const alpha = Math.min(1, t / 0.15) * (t > 0.85 ? Math.max(0, (1 - t) / 0.15) : 1);
    const maxW = size.width * (1 - layout.safe.left - layout.safe.right);
    const px = Math.round(u * layout.textScale * 1.35);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `700 ${px}px ${fontFamilyFor(text)}`;
    const lines = wrapText(ctx, text, maxW);
    const y0 = size.height * layout.titleY;
    lines.forEach((line, i) => this.label(line, size.width / 2, y0 + i * px * 1.25, px, alpha, PALETTE.text, true));
    if (subtitle) {
      const spx = Math.round(px * 0.5);
      this.label(subtitle, size.width / 2, y0 + lines.length * px * 1.25 + spx * 0.6, spx, alpha, PALETTE.textMuted);
    }
    ctx.restore();
  }

  private drawAttribution(): void {
    this.drawCredits([...(this.imagery?.attribution ?? []), "Map data: Natural Earth"]);
  }

  private drawCredits(lines: string[]): void {
    const { ctx, size } = this;
    const px = Math.max(10, Math.round(this.unit() * 0.016));
    ctx.save();
    ctx.font = `${px}px "Noto Sans"`;
    ctx.fillStyle = "rgba(200,210,220,0.55)";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    // Pack credits onto as few lines as fit in most of the frame width, so they stay small.
    const maxWidth = size.width * 0.7;
    const credits: string[] = [];
    for (const line of lines) {
      const last = credits[credits.length - 1];
      if (last && ctx.measureText(`${last} · ${line}`).width <= maxWidth) credits[credits.length - 1] = `${last} · ${line}`;
      else credits.push(line);
    }
    credits.reverse().forEach((line, i) => ctx.fillText(line, size.width - px, size.height - px * 0.8 - i * px * 1.35));
    ctx.restore();
  }
}

export function wrapText(ctx: Ctx, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}
