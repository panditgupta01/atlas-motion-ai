import { connectDatabase, createLogger, createStorage, disconnectDatabase, loadConfig, ConfigError, UsageService } from "@atlas/server-core";
import { PlannerRegistry } from "@atlas/storyboard";
import { EspeakTtsProvider, imageryConfigFromEnv, ImageryTileService, TtsRegistry } from "@atlas/video-engine";
import { createApp } from "./app.js";
import { createBullQueuePort } from "./queue-adapter.js";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message + "\nCopy .env.example to .env and fill in the values.");
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger("api", config.LOG_LEVEL);
  await connectDatabase(config.MONGODB_URI);
  logger.info("connected to MongoDB");

  const queue = createBullQueuePort(config);
  const app = createApp({
    config,
    logger,
    storage: createStorage(config),
    queue,
    planners: new PlannerRegistry({ anthropicApiKey: config.ANTHROPIC_API_KEY, anthropicModel: config.ANTHROPIC_MODEL, defaultProvider: config.PLANNER_DEFAULT }),
    tts: new TtsRegistry([new EspeakTtsProvider()]),
    imagery: new ImageryTileService(imageryConfigFromEnv()),
    usage: new UsageService({ rendersPerDay: config.USAGE_RENDERS_PER_DAY, plansPerHour: config.USAGE_PLANS_PER_HOUR }),
  });
  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, "API listening"));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close();
    await queue.close().catch(() => undefined);
    await disconnectDatabase().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("API failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
