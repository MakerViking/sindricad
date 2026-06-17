import { defineConfig } from "vite";

// Tauri expects a fixed dev port and no auto-clearing of the screen so its
// logs survive. Frontend talks to the Python sidecar over WS directly.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  // Tauri builds for a specific target; keep the chunk modern.
  build: {
    target: "esnext",
    minify: false,
    sourcemap: true,
  },
});
