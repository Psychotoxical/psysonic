/// <reference types="node" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

/** Vite 8 crawls all `*.html` for dep pre-bundling — exclude vendored research trees and Rust artifacts. */
const optimizeDepsEntries = [
  "index.html",
  "!research/**",
  "!src-tauri/**",
  "!**/target/**",
  "!dist/**",
  "!coverage/**",
];

export default defineConfig({
  plugins: [react()],
  // `@/* → src/*` — must mirror vitest.config.ts + tsconfig paths. The dev and
  // build resolvers differ: tsconfig `paths` covers tsc + `vite build`, but
  // `vite dev` needs this explicit alias or `@/` imports fail to resolve.
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  optimizeDeps: {
    entries: optimizeDepsEntries,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/research/**", "**/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // licenses.json + auth persist payload exceed 1 MB; expected for a desktop app.
    chunkSizeWarningLimit: 1600,
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome109" : "safari16",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      input: "index.html",
      output: {
        // Vendor chunks isolate dependencies that change rarely from app code,
        // so a normal app update doesn't invalidate the cached vendor bundles
        // (helps especially with the Tauri updater pulling deltas).
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/react-router-dom/")) {
            return "react";
          }
          if (
            id.includes("/@tauri-apps/api/") ||
            id.includes("/@tauri-apps/plugin-shell/") ||
            id.includes("/@tauri-apps/plugin-dialog/") ||
            id.includes("/@tauri-apps/plugin-fs/") ||
            id.includes("/@tauri-apps/plugin-process/") ||
            id.includes("/@tauri-apps/plugin-store/") ||
            id.includes("/@tauri-apps/plugin-updater/")
          ) {
            return "tauri";
          }
          if (id.includes("/i18next/") || id.includes("/react-i18next/")) {
            return "i18n";
          }
          if (id.includes("/data/licenses.json")) {
            return "licenses";
          }
          return undefined;
        },
      },
    },
  },
});
