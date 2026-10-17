import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Build metadata, injected by the Docker build (APP_VERSION / GIT_SHA build args). Same rules as
// server/src/config.ts so the UI and /api/health always agree; local builds report "dev".
const rawVersion = process.env.APP_VERSION?.trim();
const appVersion = rawVersion && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(rawVersion) ? rawVersion : "dev";
const rawSha = process.env.GIT_SHA?.trim().toLowerCase();
const gitSha = rawSha && /^[0-9a-f]{7,40}$/.test(rawSha) ? rawSha : null;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __GIT_SHA__: JSON.stringify(gitSha),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET || "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
