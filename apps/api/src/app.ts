import crypto from "node:crypto";
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
  app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
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
    rateLimit({ windowMs: 60_000, limit: deps.config.NODE_ENV === "test" ? 10_000 : 300, standardHeaders: "draft-7", legacyHeaders: false }),
  );
  app.use("/api/", requireClientHeader);

  const v1 = express.Router();
  const authed = requireAuth(deps.config);
  v1.use(systemRoutes(deps));
  v1.use("/auth", authRoutes(deps));
  v1.use("/geo", geoRoutes());
  const renders = renderRoutes(deps);
  v1.use("/projects", authed, projectRoutes(deps));
  v1.use("/projects/:projectId", authed, storyboardRoutes(deps));
  v1.use("/projects/:projectId", authed, renders.projectScoped);
  v1.use("/renders", authed, renders.renderScoped);
  v1.use("/assets", authed, assetRoutes(deps));

  app.use("/api/v1", v1);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
