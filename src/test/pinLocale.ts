// Vitest setup: the suite runs as an English host, whatever the OS is set to.
//
// src/i18n/index.ts picks the UI language at IMPORT time from
// navigator.language, and Node fills that in from the ICU default locale,
// which follows LANG/LC_ALL. The tests assert English text. While English was
// the only real locale that could not matter; once a second one is registered,
// a run on a Chinese system fails ~30 files that CI (an English runner) never
// sees. Setting LANG through `test.env` would be too late: ICU reads the locale
// when the process starts.
//
// setupFiles run before each test file's own imports, so this is in place
// before i18n reads it. `configurable`, so a test that needs another host
// language can still redefine it.
if (typeof navigator !== "undefined") {
  Object.defineProperty(navigator, "language", { value: "en", configurable: true });
}
