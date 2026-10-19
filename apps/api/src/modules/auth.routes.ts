import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { loginSchema, registerSchema } from "@atlas/shared";
import { toUserDto, User, type UserDoc } from "@atlas/server-core";
import type { AppDeps } from "../deps.js";
import { AppError, parse } from "../errors.js";
import { clearSession, issueSession, requireAuth } from "../middleware/auth.js";

// A fixed hash so login takes the same time whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync("timing-equaliser-not-a-password", 12);

export function authRoutes(deps: AppDeps): Router {
  const r = Router();
  const limiter = rateLimit({ windowMs: 15 * 60_000, limit: deps.config.NODE_ENV === "test" ? 1000 : 20, standardHeaders: "draft-7", legacyHeaders: false });

  r.post("/register", limiter, async (req, res) => {
    const body = parse(registerSchema, req.body);
    const exists = await User.exists({ email: body.email });
    if (exists) throw new AppError(409, "email_taken", "An account with this email already exists.");
    const passwordHash = await bcrypt.hash(body.password, 12);
    const user = await User.create({ email: body.email, passwordHash });
    issueSession(res, deps.config, String(user._id));
    res.status(201).json({ user: toUserDto(user.toObject() as UserDoc) });
  });

  r.post("/login", limiter, async (req, res) => {
    const body = parse(loginSchema, req.body);
    const user = await User.findOne({ email: body.email }).select("+passwordHash").lean<UserDoc>();
    const ok = await bcrypt.compare(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new AppError(401, "invalid_credentials", "Email or password is incorrect.");
    if (user.status !== "active") throw new AppError(403, "account_disabled", "This account is disabled.");
    issueSession(res, deps.config, String(user._id));
    res.json({ user: toUserDto(user) });
  });

  r.post("/logout", (_req, res) => {
    clearSession(res, deps.config);
    res.status(204).end();
  });

  r.get("/me", requireAuth(deps.config), (req, res) => {
    res.json({ user: toUserDto(req.user!) });
  });

  return r;
}
