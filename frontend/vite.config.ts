import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// In dev, proxy API + WebSocket to the Python bridge on :8200 so `npm run dev` talks to a running board
// (or the --mock bridge). In production the bridge serves the built files, so same-origin paths just work.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8200",
      "/ws": { target: "ws://127.0.0.1:8200", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
