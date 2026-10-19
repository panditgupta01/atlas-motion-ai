import { defineConfig } from "tsup";

// Workspace packages ship TypeScript source, so they are bundled in; npm dependencies stay external.
export default defineConfig({
  entry: ["src/worker.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  noExternal: [/^@atlas\//],
  skipNodeModulesBundle: true,
});
