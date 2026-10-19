import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
          // Renders in tests never fetch real tiles or read prepared regions; tile paths are tested against local fixtures.
          env: { SATELLITE_PROVIDER: "none", SATELLITE_REGIONS_DIR: "none", TERRAIN_TILE_URL: "none" },
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          // Renders in tests never fetch real tiles or read prepared regions; tile paths are tested against local fixtures.
          env: { SATELLITE_PROVIDER: "none", SATELLITE_REGIONS_DIR: "none", TERRAIN_TILE_URL: "none" },
          // One MongoDB database per file; files run in sequence to keep the shared mongod quiet.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          environment: "node",
          // Renders in tests never fetch real tiles or read prepared regions; tile paths are tested against local fixtures.
          env: { SATELLITE_PROVIDER: "none", SATELLITE_REGIONS_DIR: "none", TERRAIN_TILE_URL: "none" },
          fileParallelism: false,
          testTimeout: 300_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
