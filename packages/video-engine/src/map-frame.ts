import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { geoDistance, geoGraticule10, geoOrthographic, geoPath, type GeoPermissibleObjects } from "d3-geo";
import type { Feature, Geometry, LineString, MultiLineString, Position } from "geojson";
import { clipFeatures, getCountryFeature, getRiverFeatures, loadDataset, loadSimplified, type BBox, type DatasetId, type PreparedFeature } from "@atlas/geo";
import type { FormatLayout, FrameSize, Overlay, Scene } from "@atlas/shared";
import { scaleForZoom, visibleRadiusDegrees, type CameraState } from "./camera.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function fontsDir(): string {
  return process.env.ATLAS_FONTS_DIR ? path.resolve(process.env.ATLAS_FONTS_DIR) : path.resolve(here, "../../../assets/fonts");
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
 * Draws one map frame: an orthographic globe/regional view built from
 * Natural Earth vector data, plus the scene's overlays. This is a 2D
 * animated map renderer; it does not render terrain relief.
 */
export class MapFrameRenderer {
  readonly canvas: Canvas;
  private readonly ctx: Ctx;
  private readonly riverCache = new Map<string, Feature<Geometry>[]>();
  /** Scene-wide lon/lat window covering every frame; layers are clipped to it once per scene. */
  private window: BBox | null = null;
  private readonly layerCache = new Map<string, PreparedFeature[]>();

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
    const { camera, scene, t, layout } = input;
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

    const visible = (list: PreparedFeature[]) => list.filter((f) => bboxVisible(f.bbox, camera, radius));
    const countries = visible(this.layer("countries", camera.zoom));

    ctx.beginPath();
    for (const f of countries) pathGen(f.feature as GeoPermissibleObjects);
    ctx.fillStyle = PALETTE.land;
    ctx.fill();
    ctx.strokeStyle = PALETTE.border;
    ctx.lineWidth = lw(detailed ? 1.6 : 1);
    ctx.stroke();

    // Highlighted countries
    for (const o of scene.overlays) {
      if (o.type !== "highlight_country") continue;
      const cf = getCountryFeature(o.iso3);
      if (!cf) continue;
      const appear = Math.min(1, t / 0.3);
      ctx.beginPath();
      pathGen(cf.feature as GeoPermissibleObjects);
      ctx.globalAlpha = 0.16 * appear;
      ctx.fillStyle = o.color ?? PALETTE.highlight;
      ctx.fill();
      ctx.globalAlpha = appear;
      ctx.strokeStyle = o.color ?? PALETTE.highlight;
      ctx.lineWidth = lw(3);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Lakes and background rivers
    ctx.beginPath();
    for (const f of visible(this.layer("lakes", camera.zoom))) pathGen(f.feature as GeoPermissibleObjects);
    ctx.fillStyle = PALETTE.lake;
    ctx.fill();

    ctx.beginPath();
    for (const f of visible(this.layer("rivers", camera.zoom))) pathGen(f.feature as GeoPermissibleObjects);
    ctx.strokeStyle = PALETTE.river;
    ctx.globalAlpha = detailed ? 0.75 : 0.45;
    ctx.lineWidth = lw(detailed ? 2 : 1.2);
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
    const { ctx, size } = this;
    const px = Math.max(10, Math.round(this.unit() * 0.016));
    ctx.save();
    ctx.font = `${px}px "Noto Sans"`;
    ctx.fillStyle = "rgba(200,210,220,0.55)";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("Map data: Natural Earth", size.width - px, size.height - px * 0.8);
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
