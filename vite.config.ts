import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Set by `tauri android dev` / `tauri ios dev` so the device can reach the dev server.
const host = process.env.TAURI_DEV_HOST;
// Set to "true" by `tauri build --debug` / `tauri dev`; unset for release builds.
const debug = process.env.TAURI_ENV_DEBUG === "true";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // es2022: youtubei.js ships private methods (#x()) and the engine uses ??=; keeping them native
    // avoids relying on down-levelling. Tailwind 4 already needs Chromium 111+ / Safari 16.4+
    // (WebView2 evergreen, WebKitGTK 2.40+, current Android System WebView), all ES2022-capable.
    target: "es2022",
    outDir: "dist",
    cssCodeSplit: true,
    // Release: minified (Vite's default minifier), no source maps. Debug builds keep both readable.
    minify: !debug,
    sourcemap: debug,
    // The lazy engine chunk (youtubei.js) is roughly 1 MB minified; it is loaded async, never in the entry chunk.
    chunkSizeWarningLimit: 1500,
  },
});
