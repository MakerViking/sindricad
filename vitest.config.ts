import { defineConfig } from "vitest/config";

// Headless unit tests only (no DOM/Tauri APIs mocked yet) — scope to src/**/*.test.ts
// so vitest doesn't try to walk node_modules or the sidecar's Python tests.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: false,
  },
});
