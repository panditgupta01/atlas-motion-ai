import { AnthropicPlanner } from "./anthropic-planner.js";
import { GazetteerPlanner } from "./gazetteer-planner.js";
import { PlannerError, type PlannerProvider } from "./types.js";

export interface PlannerRegistryConfig {
  anthropicApiKey?: string;
  anthropicModel?: string;
  /** "auto" picks Claude when configured, else the offline gazetteer planner. */
  defaultProvider: "auto" | "anthropic" | "gazetteer";
}

export class PlannerRegistry {
  readonly providers: PlannerProvider[];

  constructor(private readonly config: PlannerRegistryConfig, extra: PlannerProvider[] = []) {
    this.providers = [
      new AnthropicPlanner({ apiKey: config.anthropicApiKey, model: config.anthropicModel }),
      new GazetteerPlanner(),
      ...extra,
    ];
  }

  defaultId(): string {
    if (this.config.defaultProvider !== "auto") return this.config.defaultProvider;
    return this.providers.find((p) => p.id === "anthropic")?.isConfigured() ? "anthropic" : "gazetteer";
  }

  get(id?: string): PlannerProvider {
    const wanted = id ?? this.defaultId();
    const p = this.providers.find((x) => x.id === wanted);
    if (!p) throw new PlannerError(`Unknown planner "${wanted}".`, "not_configured");
    if (!p.isConfigured()) throw new PlannerError(`Planner "${p.label}" is not configured on this server.`, "not_configured");
    return p;
  }
}
