import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";
import { useQuery } from "@tanstack/react-query";
import { FORMAT_LAYOUTS, cameraAt, toMapLibreZoom, type AspectFormat, type Overlay, type Scene } from "@atlas/shared";
import { api } from "../../services/api";
import { overlayKey, revealLine } from "./MapPreview";

/**
 * Live Google Maps satellite preview (Maps JavaScript API). Preview only: Google's terms do not
 * allow its imagery in exported videos, so renders use the open imagery sources. Google draws its
 * own logo and data attribution; nothing here may cover them, so overlays keep the bottom strip clear.
 * Only one map is mounted at a time: Google content must not sit next to a non-Google map.
 */

const ATTRIBUTION_CLEARANCE_PX = 34;
const PALETTE = { highlight: "#e0b04c", river: "#7cc4ff", route: "#ff6b4a" };

let loader: Promise<void> | null = null;

/** Loads Google's script once, with the browser key from the API (never bundled into the app). */
function loadGoogleMaps(key: string): Promise<void> {
  if (window.google?.maps?.Map) return Promise.resolve();
  if (!loader) {
    loader = new Promise<void>((resolve, reject) => {
      const cb = "__atlasGoogleMapsReady";
      (window as unknown as Record<string, unknown>)[cb] = () => resolve();
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=${cb}`;
      s.async = true;
      s.onerror = () => {
        loader = null;
        reject(new Error("Google Maps could not be loaded. Check the network and the key's referrer restrictions."));
      };
      document.head.appendChild(s);
    });
  }
  return loader;
}

interface Props {
  scenes: Scene[];
  sceneIndex: number;
  format: AspectFormat;
  /** Normalised time within the scene, 0..1. */
  t: number;
}

export function GoogleMapPreview({ scenes, sceneIndex, format, t }: Props) {
  const cfg = useQuery({ queryKey: ["google-maps-key"], queryFn: api.googleMaps, staleTime: Infinity, retry: false });
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const dynamicRef = useRef<(google.maps.Marker | google.maps.Polyline)[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    if (!cfg.data || !containerRef.current) return;
    let cancelled = false;
    const el = containerRef.current;
    loadGoogleMaps(cfg.data.browserKey)
      .then(() => {
        if (cancelled) return;
        const map = new google.maps.Map(el, {
          mapTypeId: google.maps.MapTypeId.SATELLITE,
          center: { lat: 20, lng: 0 },
          zoom: 2,
          isFractionalZoomEnabled: true,
          disableDefaultUI: true,
          keyboardShortcuts: false,
          gestureHandling: "none",
          clickableIcons: false,
          backgroundColor: "#0d2236",
          ...(cfg.data.mapId ? { mapId: cfg.data.mapId } : {}),
        });
        map.data.setStyle((f) =>
          f.getProperty("kind") === "river"
            ? { strokeColor: PALETTE.river, strokeWeight: 2.4, strokeOpacity: 0.95, clickable: false }
            : { fillColor: PALETTE.highlight, fillOpacity: 0.16, strokeColor: PALETTE.highlight, strokeWeight: 1.6, clickable: false },
        );
        mapRef.current = map;
        setReady(true);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      dynamicRef.current.forEach((o) => o.setMap(null));
      dynamicRef.current = [];
      mapRef.current = null;
      setReady(false);
    };
  }, [cfg.data, format]);

  // Highlighted countries and rivers, drawn from the same Natural Earth features the renderer uses.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.data.forEach((f) => map.data.remove(f));
    if (countries.length + rivers.length > 0 && features.data) map.data.addGeoJson(features.data as FeatureCollection);
  }, [ready, features.data, countries.length, rivers.length]);

  // Camera, routes, arrows and labels for the current time, from the shared camera timeline.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !scene || !containerRef.current) return;
    const cam = cameraAt(scene, previous, t, FORMAT_LAYOUTS[format]);
    const { width, height } = containerRef.current.getBoundingClientRect();
    // MapLibre zoom is defined on 512 px tiles, Google's on 256 px tiles.
    map.moveCamera({ center: { lat: cam.latitude, lng: cam.longitude }, zoom: toMapLibreZoom(cam.zoom, Math.min(width, height), cam.latitude) + 1, heading: cam.roll });

    dynamicRef.current.forEach((o) => o.setMap(null));
    dynamicRef.current = [];
    const path = (coords: [number, number][]) => coords.map(([lng, lat]) => ({ lat, lng }));
    for (const o of scene.overlays) {
      if (o.type === "route") {
        dynamicRef.current.push(new google.maps.Polyline({ map, path: path(o.animate ? revealLine(o.coordinates, t / 0.8) : o.coordinates), strokeColor: o.color ?? PALETTE.route, strokeWeight: 3, clickable: false }));
      } else if (o.type === "arrow") {
        const k = Math.min(1, t / 0.6);
        const to: [number, number] = [o.from[0] + (o.to[0] - o.from[0]) * k, o.from[1] + (o.to[1] - o.from[1]) * k];
        dynamicRef.current.push(
          new google.maps.Polyline({ map, path: path([o.from, to]), strokeColor: "#ffffff", strokeWeight: 2.5, clickable: false, icons: [{ icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 3 }, offset: "100%" }] }),
        );
      }
    }
    const labelsVisible = t > 0.35;
    const addLabel = (lngLat: [number, number], text: string | undefined, withDot: boolean) => {
      dynamicRef.current.push(
        new google.maps.Marker({
          map,
          position: { lat: lngLat[1], lng: lngLat[0] },
          clickable: false,
          // textContent semantics: Marker labels are plain text, never HTML.
          label: text ? { text, color: "#ffffff", fontSize: "13px", fontWeight: "600" } : undefined,
          icon: withDot
            ? { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: PALETTE.route, fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2, labelOrigin: new google.maps.Point(0, -3.2) }
            : { path: google.maps.SymbolPath.CIRCLE, scale: 0, labelOrigin: new google.maps.Point(0, 0) },
        }),
      );
    };
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
  const notConfigured = cfg.isError;

  return (
    <div className={format === "9:16" ? "relative aspect-[9/16] h-full max-h-full" : "relative aspect-video w-full max-w-full"} style={format === "9:16" ? undefined : { maxHeight: "100%" }}>
      <div className="absolute inset-0 overflow-hidden rounded-md bg-[#0d2236]">
        <div ref={containerRef} className="h-full w-full" data-testid="google-map" />
      </div>
      {title && t < 0.85 && (
        <div className="pointer-events-none absolute inset-x-0 text-center" style={{ top: `${layout.titleY * 100}%` }}>
          <p className="text-xl font-semibold text-white drop-shadow-[0_2px_6px_rgba(0,0,0,.8)] sm:text-2xl">{title.text}</p>
          {title.subtitle && <p className="mt-1 text-sm text-white/80 drop-shadow">{title.subtitle}</p>}
        </div>
      )}
      {legend && (
        <div className="pointer-events-none absolute rounded bg-black/55 px-2.5 py-2 text-[11px] text-white" style={{ right: `${layout.safe.right * 100}%`, bottom: `max(${layout.safe.bottom * 100}%, ${ATTRIBUTION_CLEARANCE_PX + 8}px)` }}>
          {legend.items.map((i) => (
            <div key={i.label} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: i.color }} /> {i.label}
            </div>
          ))}
        </div>
      )}
      {scene?.narration && t > 0.05 && (
        <div className="pointer-events-none absolute inset-x-[8%] text-center" style={{ bottom: `max(${layout.safe.bottom * 100 * 0.6}%, ${ATTRIBUTION_CLEARANCE_PX}px)` }}>
          <span className="rounded bg-black/60 px-2 py-1 text-[12px] leading-relaxed text-white">{scene.narration.length > 110 ? `${scene.narration.slice(0, 110)}…` : scene.narration}</span>
        </div>
      )}
      {notConfigured && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-white/70">The Google Maps preview is not configured on this server (GOOGLE_MAPS_BROWSER_KEY).</div>}
      {!notConfigured && !ready && !error && <div className="absolute inset-0 flex items-center justify-center text-xs text-white/60">Loading Google Maps…</div>}
      {error && <div className="absolute inset-x-3 top-3 rounded bg-black/70 px-2 py-1 text-xs text-danger">{error}</div>}
    </div>
  );
}

