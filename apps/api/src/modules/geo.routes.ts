import { Router } from "express";
import { z } from "zod";
import { datasetPath, getCountryByIso3, getCountryFeature, getRiverFeatures, NATURAL_EARTH_ATTRIBUTION, searchGazetteer, simplifyGeometry } from "@atlas/geo";
import { parse } from "../errors.js";

const LAYERS = { countries: "countries50m", rivers: "rivers50m", lakes: "lakes50m", "countries-detail": "countries10m", "rivers-detail": "rivers10m" } as const;

/** Geographic lookup for the editor: gazetteer search and the vector layers the map preview draws. */
export function geoRoutes(): Router {
  const r = Router();

  r.get("/search", (req, res) => {
    const q = parse(
      z.object({ q: z.string().trim().min(1).max(80), limit: z.coerce.number().int().min(1).max(25).default(10), kind: z.enum(["country", "place", "river", "lake"]).optional() }),
      req.query,
    );
    res.json({ items: searchGazetteer(q.q, q.limit, q.kind ? [q.kind] : undefined), attribution: NATURAL_EARTH_ATTRIBUTION });
  });

  r.get("/countries/:iso3", (req, res) => {
    const hit = getCountryByIso3(String(req.params.iso3).toUpperCase());
    if (!hit) return res.status(404).json({ error: { code: "not_found", message: "Country not found." } });
    res.json(hit);
  });

  /**
   * The exact features the renderer draws for highlight_country and river overlays
   * (10m data, lightly simplified), so the editor preview matches the video.
   */
  r.get("/overlay-features", (req, res) => {
    const q = parse(
      z.object({
        countries: z.string().max(400).optional(),
        rivers: z.string().max(2000).optional(),
      }),
      req.query,
    );
    const iso3s = (q.countries ?? "").split(",").filter((c) => /^[A-Z]{3}$/.test(c)).slice(0, 20);
    const rivers = (q.rivers ?? "").split("|").map((n) => n.trim()).filter(Boolean).slice(0, 20);
    const features = [
      ...iso3s.flatMap((iso3) => {
        const f = getCountryFeature(iso3);
        return f ? [{ type: "Feature" as const, properties: { kind: "country", iso3 }, geometry: simplifyGeometry(f.feature.geometry, 0.01) }] : [];
      }),
      ...rivers.flatMap((name) =>
        getRiverFeatures(name).map((f) => ({ type: "Feature" as const, properties: { kind: "river", name }, geometry: simplifyGeometry(f.geometry, 0.005) })),
      ),
    ];
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({ type: "FeatureCollection", features });
  });

  r.get("/layers/:layer", (req, res) => {
    const layer = LAYERS[req.params.layer as keyof typeof LAYERS];
    if (!layer) return res.status(404).json({ error: { code: "not_found", message: "Unknown layer." } });
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("application/geo+json");
    res.sendFile(datasetPath(layer));
  });

  return r;
}
