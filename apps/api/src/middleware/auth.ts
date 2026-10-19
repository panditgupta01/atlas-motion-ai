import type { RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { User, type AppConfig, type UserDoc } from "@atlas/server-core";
import { AppError } from "../errors.js";

export const SESSION_COOKIE = "atlas_session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserDoc;
    }
  }
}

export function issueSession(res: Response, config: AppConfig, userId: string): void {
  const token = jwt.sign({ sub: userId }, config.JWT_SECRET, { algorithm: "HS256", expiresIn: `${config.SESSION_TTL_HOURS}h` });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: config.SESSION_TTL_HOURS * 3600_000,
    path: "/",
  });
}

export function clearSession(res: Response, config: AppConfig): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: "lax", path: "/" });
}

export function requireAuth(config: AppConfig): RequestHandler {
  return async (req, _res, next) => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) return next(new AppError(401, "unauthenticated", "Please sign in."));
    let sub: string;
    try {
      const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
      sub = String(payload.sub);
    } catch {
      return next(new AppError(401, "session_expired", "Your session has expired. Please sign in again."));
    }
    const user = await User.findById(sub).lean<UserDoc>();
    if (!user || user.status !== "active") return next(new AppError(401, "unauthenticated", "Please sign in."));
    req.user = user;
    next();
  };
}

/**
 * CSRF defence for cookie sessions: state-changing requests must carry a
 * custom header, which browsers do not let cross-site forms or simple
 * requests set without a CORS preflight.
 */
export const requireClientHeader: RequestHandler = (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Atlas-Client") !== "web") {
    return next(new AppError(403, "missing_client_header", "Missing X-Atlas-Client header."));
  }
  next();
};
