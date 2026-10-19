import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap, Marker, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
// MapLibre finds its worker next to its own module, which breaks once Vite bundles it; point it at the emitted file.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { Feature, FeatureCollection } from "geojson";
import { useQuery } from "@tanstack/react-query";
import { FORMAT_LAYOUTS, cameraAt, type AspectFormat, type Overlay, type Scene } from "@atlas/shared";
import { api, layerUrl } from "../../services/api";

const PALETTE = {
  ocean: "#0d2236",
  land: "#26313a",
  border: "#4b5a66",
  water: "#3d7fb8",
  highlight: "#e0b04c",
  route: "#ff6b4a",
};

setWorkerUrl(workerUrl);

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function baseStyle(): StyleSpecification {
  return {
    version: 8,
    projection: { type: "globe" },
    sources: {
      countries: { type: "geojson", data: layerUrl("countries") },
      lakes: { type: "geojson", data: layerUrl("lakes") },
      rivers: { type: "geojson", data: layerUrl("rivers") },
      overlays: { type: "geojson", data: EMPTY },
      routes: { type: "geojson", data: EMPTY },
    },
    layers: [
      { id: "ocean", type: "background", paint: { "background-color": PALETTE.ocean } },
      { id: "land", type: "fill", source: "countries", paint: { "fill-color": PALETTE.land } },
      { id: "borders", type: "line", source: "countries", paint: { "line-color": PALETTE.border, "line-width": 0.6 } },
      { id: "highlight-fill", type: "fill", source: "overlays", filter: ["==", ["get", "kind"], "country"], paint: { "fill-color": PALETTE.highlight, "fill-opacity": 0.16 } },
      { id: "highlight-line", type: "line", source: "overlays", filter: ["==", ["get", "kind"], "country"], paint: { "line-color": PALETTE.highlight, "line-width": 1.6 } },
      { id: "lakes", type: "fill", source: "lakes", paint: { "fill-color": PALETTE.water, "fill-opacity": 0.8 } },
      { id: "rivers", type: "line", source: "rivers", paint: { "line-color": PALETTE.water, "line-width": 0.8, "line-opacity": 0.8 } },
      { id: "river-glow", type: "line", source: "overlays", filter: ["==", ["get", "kind"], "river"], paint: { "line-color": "#7cc4ff", "line-width": 6, "line-opacity": 0.25, "line-blur": 3 } },
      { id: "river-line", type: "line", source: "overlays", filter: ["==", ["get", "kind"], "river"], paint: { "line-color": "#7cc4ff", "line-width": 2.4 } },
      { id: "routes", type: "line", source: "routes", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["coalesce", ["get", "color"], PALETTE.route], "line-width": 3 } },
    ],
  };
}

/** Convert the renderer's zoom (0 = whole globe filling ~90% of the short side) to a MapLibre zoom. */
export function toMapLibreZoom(zoom: number, minSidePx: number, latitude: number): number {
  const radiusPx = minSidePx * 0.45 * Math.pow(2, zoom);
  const cosLat = Math.max(0.2, Math.cos((latitude * Math.PI) / 180));
  return Math.log2((radiusPx * 2 * Math.PI * cosLat) / 512);
}

function revealLine(coords: [number, number][], t: number): [number, number][] {
  if (t >= 1 || coords.length < 2) return coords;
  const n = Math.max(2, Math.ceil(coords.length * Math.max(0.02, t)));
  return coords.slice(0, n);
}

function overlayKey(overlays: Overlay[]) {
  const countries = overlays.flatMap((o) => (o.type === "highlight_country" ? [o.iso3] : [])).sort();
  const rivers = overlays.flatMap((o) => (o.type === "river" ? [o.datasetName] : [])).sort();
  return { countries, rivers };
}

interface Props {
  scenes: Scene[];
  sceneIndex: number;
  format: AspectFormat;
  /** Normalised time within the scene, 0..1. */
  t: number;
}

export function MapPreview({ scenes, sceneIndex, format, t }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scene = scenes[sceneIndex];
  const previous = sceneIndex > 0 ? scenes[sceneIndex - 1] : undefined;

  const { countries, rivers } = useMemo(() => overlayKey(scene?.overlays ?? []), [scene?.overlays]);
  const features = useQuery({
    queryKey: ["overlay-features", countries.join(","), rivers.join("|")],
    enabled: countries.length + rivers.length > 0,
    staleTime: Infinity,
    queryFn: () => api.overlayFeatures(countries, rivers),
  });

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: baseStyle(),
      center: [0, 20],
      zoom: 1,
      interactive: false,
      attributionControl: { compact: true, customAttribution: "Natural Earth" },
      fadeDuration: 0,
    });
    map.on("load", () => setReady(true));
    map.on("error", (e) => setLoadError(e.error?.message ?? "Map preview failed to load"));
    mapRef.current = map;
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, [format]);

  // Highlighted countries and rivers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("overlays") as GeoJSONSource | undefined)?.setData(countries.length + rivers.length > 0 ? (features.data ?? EMPTY) : EMPTY);
  }, [ready, features.data, countries.length, rivers.length]);

  // Camera, routes, arrows and HTML labels for the current time.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !scene || !containerRef.current) return;
    const layout = FORMAT_LAYOUTS[format];
    const cam = cameraAt(scene, previous, t, layout);
    const { width, height } = containerRef.current.getBoundingClientRect();
    map.jumpTo({ center: [cam.longitude, cam.latitude], zoom: toMapLibreZoom(cam.zoom, Math.min(width, height), cam.latitude), bearing: cam.roll });

    const lines: Feature[] = [];
    for (const o of scene.overlays) {
      if (o.type === "route") {
        lines.push({ type: "Feature", properties: { color: o.color ?? null }, geometry: { type: "LineString", coordinates: o.animate ? revealLine(o.coordinates, t / 0.8) : o.coordinates } });
      } else if (o.type === "arrow") {
        const k = Math.min(1, t / 0.6);
        const to: [number, number] = [o.from[0] + (o.to[0] - o.from[0]) * k, o.from[1] + (o.to[1] - o.from[1]) * k];
        lines.push({ type: "Feature", properties: { color: "#ffffff" }, geometry: { type: "LineString", coordinates: [o.from, to] } });
      }
    }
    (map.getSource("routes") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: lines });

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    const addLabel = (lngLat: [number, number], text: string | undefined, withDot: boolean) => {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.gap = "6px";
      if (withDot) {
        const dot = document.createElement("div");
        dot.className = "map-marker";
        el.appendChild(dot);
      }
      if (text) {
        const label = document.createElement("span");
        label.className = "map-label";
        label.textContent = text; // textContent, never innerHTML: labels are user text
        el.appendChild(label);
      }
      markersRef.current.push(new Marker({ element: el, anchor: withDot ? "left" : "center", offset: withDot ? [-6, 0] : [0, 0] }).setLngLat(lngLat).addTo(map));
    };
    const labelsVisible = t > 0.35;
    for (const o of scene.overlays) {
      if (o.type === "marker") addLabel([o.longitude, o.latitude], labelsVisible ? o.label : undefined, true);
      else if (o.type === "location_label" && labelsVisible) addLabel([o.longitude, o.latitude], o.text, false);
      else if (o.type === "arrow" && o.label && labelsVisible) addLabel(o.to, o.label, false);
      else if (o.type === "route" && o.label && labelsVisible) addLabel(o.coordinates[Math.floor(o.coordinates.length / 2)]!, o.label, false);
    }
  }, [ready, scene, previous, t, format]);

  const title = scene?.overlays.find((o): o is Extract<Overlay, { type: "title_card" }> => o.type === "title_card");
  const legend = scene?.overlays.find((o): o is Extract<Overlay, { type: "legend" }> => o.type === "legend");
  const layout = FORMAT_LAYOUTS[format];

  return (
    <div className={format === "9:16" ? "relative aspect-[9/16] h-full max-h-full" : "relative aspect-video w-full max-w-full"} style={format === "9:16" ? undefined : { maxHeight: "100%" }}>
      {/* MapLibre's stylesheet forces position: relative on the map element, so size it from a wrapper. */}
      <div className="absolute inset-0 overflow-hidden rounded-md bg-[#0d2236]">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      {title && t < 0.85 && (
        <div className="pointer-events-none absolute inset-x-0 text-center" style={{ top: `${layout.titleY * 100}%` }}>
          <p className="text-xl font-semibold text-white drop-shadow-[0_2px_6px_rgba(0,0,0,.8)] sm:text-2xl">{title.text}</p>
          {title.subtitle && <p className="mt-1 text-sm text-white/80 drop-shadow">{title.subtitle}</p>}
        </div>
      )}
      {legend && (
        <div className="pointer-events-none absolute rounded bg-black/55 px-2.5 py-2 text-[11px] text-white" style={{ right: `${layout.safe.right * 100}%`, bottom: `${layout.safe.bottom * 100}%` }}>
          {legend.items.map((i) => (
            <div key={i.label} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: i.color }} /> {i.label}
            </div>
          ))}
        </div>
      )}
      {scene?.narration && t > 0.05 && (
        <div className="pointer-events-none absolute inset-x-[8%] text-center" style={{ bottom: `${layout.safe.bottom * 100 * 0.6}%` }}>
          <span className="rounded bg-black/60 px-2 py-1 text-[12px] leading-relaxed text-white">{scene.narration.length > 110 ? `${scene.narration.slice(0, 110)}…` : scene.narration}</span>
        </div>
      )}
      {!ready && !loadError && <div className="absolute inset-0 flex items-center justify-center text-xs text-white/60">Loading map data…</div>}
      {loadError && <div className="absolute inset-x-3 top-3 rounded bg-black/70 px-2 py-1 text-xs text-danger">{loadError}</div>}
      {features.isError && <div className="absolute inset-x-3 top-3 rounded bg-black/70 px-2 py-1 text-xs text-warn">Highlight shapes could not be loaded.</div>}
    </div>
  );
}
