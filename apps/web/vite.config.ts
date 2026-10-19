import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = process.env.VITE_API_PROXY ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The API is served from the same origin in development so session cookies work.
    proxy: { "/api": { target: api, changeOrigin: false } },
  },
  preview: { port: 4173, proxy: { "/api": { target: api } } },
  build: { sourcemap: true, chunkSizeWarningLimit: 1500 },
});
