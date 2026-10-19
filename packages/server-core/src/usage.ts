import type { Types } from "mongoose";
import { UsageEvent, type UsageEventDoc } from "./models.js";

export interface UsageLimits {
  rendersPerDay: number;
  plansPerHour: number;
}

export class UsageLimitError extends Error {
  constructor(message: string, public readonly retryAfterSeconds: number) {
    super(message);
    this.name = "UsageLimitError";
  }
}

/**
 * Configurable usage limits backed by recorded usage events. This is the hook
 * for a future credit system; no payments are involved. A limit of 0 means
 * unlimited (development only).
 */
export class UsageService {
  constructor(private readonly limits: UsageLimits) {}

  private async countSince(owner: Types.ObjectId | string, kinds: UsageEventDoc["kind"][], since: Date): Promise<number> {
    return UsageEvent.countDocuments({ owner, kind: { $in: kinds }, createdAt: { $gte: since } });
  }

  async assertCanPlan(owner: Types.ObjectId | string): Promise<void> {
    if (this.limits.plansPerHour === 0) return;
    const n = await this.countSince(owner, ["plan", "regenerate_scene"], new Date(Date.now() - 3600_000));
    if (n >= this.limits.plansPerHour) {
      throw new UsageLimitError(`You have reached the limit of ${this.limits.plansPerHour} storyboard generations per hour.`, 3600);
    }
  }

  async assertCanRender(owner: Types.ObjectId | string): Promise<void> {
    if (this.limits.rendersPerDay === 0) return;
    const n = await this.countSince(owner, ["render"], new Date(Date.now() - 24 * 3600_000));
    if (n >= this.limits.rendersPerDay) {
      throw new UsageLimitError(`You have reached the limit of ${this.limits.rendersPerDay} renders per day.`, 24 * 3600);
    }
  }

  async record(event: {
    owner: Types.ObjectId | string;
    kind: "plan" | "regenerate_scene" | "render";
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    calls?: number;
    renderSeconds?: number;
    project?: Types.ObjectId | string;
  }): Promise<void> {
    await UsageEvent.create(event);
  }
}
