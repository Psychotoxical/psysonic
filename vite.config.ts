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
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      output: {
        // Vendor chunks isolate dependencies that change rarely from app code,
        // so a normal app update doesn't invalidate the cached vendor bundles
        // (helps especially with the Tauri updater pulling deltas).
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          tauri: [
            "@tauri-apps/api",
            "@tauri-apps/plugin-shell",
            "@tauri-apps/plugin-dialog",
            "@tauri-apps/plugin-fs",
            "@tauri-apps/plugin-process",
            "@tauri-apps/plugin-store",
            "@tauri-apps/plugin-updater",
          ],
          i18n: ["i18next", "react-i18next"],
        },
      },
    },
  },
});
