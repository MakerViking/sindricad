// Tells Rust the webview got far enough to run our code. Nothing else.
//
// Loaded from index.html BEFORE main.ts, and deliberately importing nothing but
// the Tauri IPC call. ES module imports are hoisted and evaluated before any
// statement in the importing module, so a ping placed at the top of main.ts
// would not run if any one of its ~40 imports threw while loading. Kept
// separate, the two failures can be told apart:
//
//   no ping          -> the document never loaded, or Tauri IPC is unreachable
//   ping, broken UI  -> the page loaded and our own code failed
//
// CAVEAT, measured not assumed: `vite build` merges both entry scripts into one
// chunk and emits a single <script> tag, so that separation is real in dev but
// only best-effort in the shipped bundle — module ordering inside the chunk is
// Rollup's to decide. The watchdog's message is worded to cover both cases
// rather than claim a distinction the build might not preserve.
//
// Issue #3 spent four rounds guessing at this from the outside, because a blank
// window looks identical either way. The other half is the frontend load
// watchdog in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";

// Best-effort by design. Outside Tauri (a plain browser, a vitest run) there is
// no IPC to call and that is not an error worth surfacing: the watchdog only
// exists inside the packaged app, and a rejection here would be an uncaught
// promise on every non-Tauri load.
invoke("frontend_ready").catch(() => {});
