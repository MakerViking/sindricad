import { defineConfig } from "vite";

// `process` is Node's. This config runs in Node, not the browser, and tsconfig
// only type-checks `src` — so it is declared locally rather than pulling in
// @types/node for a single line.
declare const process: { env: Record<string, string | undefined> };

// Tauri expects a fixed dev port and no auto-clearing of the screen so its
// logs survive. Frontend talks to the Python sidecar over WS directly.
//
// The port is overridable so a SECOND stack can run beside the first — a
// bug-fix session in one worktree while a feature session builds in another,
// or a headless capture rig. `strictPort` stays on deliberately: silently
// landing on 5174 when 5173 was taken would leave the Tauri window pointing at
// whichever stack happened to start first, which is a genuinely confusing way
// to lose an afternoon. Fail loudly instead.
//
// Use `npm run dev:alt` (5174 + sidecar 8766) rather than remembering three
// variables. The sidecar half already read SINDRI_SIDECAR_PORT; only the
// frontend was pinned.
const PORT = Number(process.env.SINDRI_VITE_PORT ?? 5173);

export default defineConfig({
  clearScreen: false,
  server: {
    port: PORT,
    strictPort: true,
  },
  // Tauri builds for a specific target; keep the chunk modern.
  build: {
    target: "esnext",
    minify: false,
    sourcemap: true,
  },
});
