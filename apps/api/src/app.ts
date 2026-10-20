import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import type { AppDeps } from "./deps.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { requireAuth, requireClientHeader } from "./middleware/auth.js";
import { assetRoutes } from "./modules/assets.routes.js";
import { authRoutes } from "./modules/auth.routes.js";
import { geoRoutes } from "./modules/geo.routes.js";
import { projectRoutes } from "./modules/projects.routes.js";
import { renderRoutes } from "./modules/renders.routes.js";
import { storyboardRoutes } from "./modules/storyboard.routes.js";
import { systemRoutes } from "./modules/system.routes.js";

/** Google's documented Content Security Policy needs for the Maps JavaScript API. */
const GOOGLE_MAPS_CSP = {
  "script-src": ["'self'", "https://*.googleapis.com", "https://*.gstatic.com", "https://*.google.com", "https://*.ggpht.com", "https://*.googleusercontent.com", "blob:"],
  "img-src": ["'self'", "data:", "blob:", "https://*.googleapis.com", "https://*.gstatic.com", "https://*.google.com", "https://*.googleusercontent.com"],
  "connect-src": ["'self'", "https://*.googleapis.com", "https://*.google.com", "https://*.gstatic.com", "data:", "blob:"],
  "font-src": ["'self'", "https://fonts.gstatic.com"],
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  "worker-src": ["'self'", "blob:"],
  "frame-src": ["https://*.google.com"],
};

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.config.NODE_ENV === "production" ? 1 : false);

  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req, res) => {
        const id = (req.headers["x-request-id"] as string | undefined)?.slice(0, 64) || crypto.randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/api/v1/health" },
    }),
  );
  // The Google Maps preview loads Google's script, styles, fonts and tiles, so its hosts are allowed only when a key is configured.
  const google = deps.config.GOOGLE_MAPS_BROWSER_KEY ? GOOGLE_MAPS_CSP : null;
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "same-site" },
      contentSecurityPolicy: google ? { directives: google } : undefined,
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || deps.config.corsOrigins.includes(origin)),
      credentials: true,
      allowedHeaders: ["Content-Type", "X-Atlas-Client", "X-Request-Id"],
      methods: ["GET", "POST", "PATCH", "DELETE"],
    }),
  );
  app.use(express.json({ limit: "512kb" }));
  app.use(cookieParser());
  app.use(
    "/api/",
    rateLimit({
      windowMs: 60_000,
      limit: deps.config.NODE_ENV === "test" ? 10_000 : 300,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      // Map tiles have their own, higher per-user limit (a globe preview loads dozens at once).
      skip: (req) => req.path.startsWith("/v1/geo/imagery/tiles/"),
    }),
  );
  app.use("/api/", requireClientHeader);

  const v1 = express.Router();
  const authed = requireAuth(deps.config);
  v1.use(systemRoutes(deps));
  v1.use("/auth", authRoutes(deps));
  v1.use("/geo", geoRoutes({
      imagery: deps.imagery,
      authed,
      test: deps.config.NODE_ENV === "test",
      googleMaps: deps.config.GOOGLE_MAPS_BROWSER_KEY ? { browserKey: deps.config.GOOGLE_MAPS_BROWSER_KEY, mapId: deps.config.GOOGLE_MAPS_MAP_ID ?? null } : null,
    }));
  const renders = renderRoutes(deps);
  v1.use("/projects", authed, projectRoutes(deps));
  v1.use("/projects/:projectId", authed, storyboardRoutes(deps));
  v1.use("/projects/:projectId", authed, renders.projectScoped);
  v1.use("/renders", authed, renders.renderScoped);
  v1.use("/assets", authed, assetRoutes(deps));

  app.use("/api/v1", v1);

  // Single-origin deployment: serve the built web app and fall back to index.html for client routes.
  const webDir = deps.config.WEB_DIST_DIR ? path.resolve(deps.config.WEB_DIST_DIR) : null;
  if (webDir && fs.existsSync(path.join(webDir, "index.html"))) {
    app.use(express.static(webDir, { index: false, maxAge: "1h", setHeaders: (res, file) => file.includes(`${path.sep}assets${path.sep}`) && res.setHeader("Cache-Control", "public, max-age=31536000, immutable") }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDir, "index.html")));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
