/// <reference types="node" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Default 500 kB warns on every build; desktop bundles are often larger without being a problem.
    chunkSizeWarningLimit: 1000,
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome109" : "safari16",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
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
          return undefined;
        },
      },
    },
  },
});
