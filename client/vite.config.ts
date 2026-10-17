import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Same image policy as the production server (ALLOW_REMOTE_IMAGES), so remote images in notes
// behave the same in development. The rest of the production CSP would break Vite's dev tooling.
const allowRemoteImages = /^(true|1|yes|on)$/i.test(process.env.ALLOW_REMOTE_IMAGES ?? "");
const devImageCsp = `img-src 'self' data: blob:${allowRemoteImages ? " https:" : ""}`;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    headers: {
      "Content-Security-Policy": devImageCsp,
    },
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET || "http://localhost:3001",
        changeOrigin: true,
        configure: (proxy) => {
          // changeOrigin rewrites Host; pass the original one on for the backend's Origin (CSRF) check
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.headers.host) proxyReq.setHeader("X-Forwarded-Host", req.headers.host);
          });
        },
      },
    },
  },
});
