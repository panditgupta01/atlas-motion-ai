import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError, type ZodType, type infer as Infer } from "zod";
import { PlannerError } from "@atlas/storyboard";
import { UsageLimitError } from "@atlas/server-core";
import { InvalidTransitionError } from "@atlas/shared";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found.`);

/** Parse request data with a Zod schema, turning failures into a 400 with field details. */
export function parse<T extends ZodType>(schema: T, data: unknown): Infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(
      400,
      "validation_error",
      "Some fields are invalid.",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, "route_not_found", `No route for ${req.method} ${req.path}.`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = String(req.id ?? "");
  let status = 500;
  let code = "internal_error";
  let message = "Something went wrong on the server. The error has been logged.";
  let details: unknown;
  const headers: Record<string, string> = {};

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof PlannerError) {
    status = err.code === "not_configured" ? 503 : err.code === "no_places" ? 422 : err.code === "refused" ? 422 : 502;
    code = `planner_${err.code}`;
    message = err.message;
    details = err.details;
  } else if (err instanceof UsageLimitError) {
    status = 429;
    code = "usage_limit";
    message = err.message;
    headers["Retry-After"] = String(err.retryAfterSeconds);
  } else if (err instanceof InvalidTransitionError) {
    status = 409;
    code = "invalid_state";
    message = err.message;
  } else if (err instanceof ZodError) {
    status = 400;
    code = "validation_error";
    message = "Some fields are invalid.";
    details = err.issues;
  } else if (err?.type === "entity.too.large") {
    status = 413;
    code = "payload_too_large";
    message = "Request body is too large.";
  } else if (err?.type === "entity.parse.failed") {
    status = 400;
    code = "invalid_json";
    message = "Request body is not valid JSON.";
  } else if (err?.name === "CastError") {
    status = 404;
    code = "not_found";
    message = "Resource not found.";
  }

  if (status >= 500) req.log?.error({ err }, "request failed");
  else req.log?.warn({ code, message }, "request rejected");
  res.set(headers).status(status).json({ error: { code, message, details, requestId } });
};
