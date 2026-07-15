import { defineConfig } from "vitest/config";

// Headless unit tests only (no DOM/Tauri APIs mocked yet) — scope to src/**/*.test.ts
// so vitest doesn't try to walk node_modules or the sidecar's Python tests.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: false,
    coverage: {
      // scope the report to the core-logic dirs (loop target #15). The large
      // interactive-UI / Tauri / ws files (sketchMode, overlay, client, files)
      // are e2e territory, not unit-testable, so they stay out of the denominator.
      provider: "v8",
      include: ["src/document/**", "src/sketch/**", "src/geometry/**", "src/io/**"],
      reporter: ["text-summary"],
    },
  },
});
