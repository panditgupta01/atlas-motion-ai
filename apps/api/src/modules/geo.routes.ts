import { Router } from "express";
import { z } from "zod";
import { datasetPath, getCountryByIso3, NATURAL_EARTH_ATTRIBUTION, searchGazetteer } from "@atlas/geo";
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

  r.get("/layers/:layer", (req, res) => {
    const layer = LAYERS[req.params.layer as keyof typeof LAYERS];
    if (!layer) return res.status(404).json({ error: { code: "not_found", message: "Unknown layer." } });
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("application/geo+json");
    res.sendFile(datasetPath(layer));
  });

  return r;
}
