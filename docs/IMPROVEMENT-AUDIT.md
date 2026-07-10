# SindriCAD Improvement Audit — 2026-07-10

> **Implementation status (same day):** everything in this report except the items below was implemented in three orchestrated waves on top of `df3886d` (uncommitted; all gates green: tsc+vite, cargo build + `cargo test --lib` 7/7, sidecar smoke/geomstore/selector suites, vitest 25 pass / 1 known skip). Also landed beyond this report: boolean no-op guards generalized to Combine and Sweep (sweep now routes through `_boolean_into_bodies`).
> **Still open, deliberately:** edge-line batching (§2.1 second half — still one draw call per edge); sidecar auto-respawn after crash (event + toast only; respawn waits on the ephemeral-port/token-refresh follow-up); `rust-geom` in required CI (manual workflow_dispatch job only — hosted runners lack OCCT 7.9); half-integer pattern divergence (documented vitest skip); live interactive QA of the Wave-3 refactors (gates cannot drive the real viewport — needs a user smoke-test).

**Method.** Two-wave multi-agent audit at commit `df3886d`: 10 specialist analysts (Python geometry core, frontend architecture, sketch subsystem, viewport performance, rebuild-pipeline performance, silent-failure hunting, Rust layer, UX, testing, documentation) produced 57 findings; every high/medium finding was then independently re-verified by an adversarial agent instructed to refute it against the real code. 45 survived, 1 was refuted, 11 low-severity items passed through unverified. The top five findings were additionally spot-checked by hand against the source. Items already tracked in `handoff.md` §Known issues were excluded.

**Severity:** high = user-visible breakage / data-loss / perf-cliff risk · medium = real maintainability/perf/UX cost · low = polish.
**Effort:** S = under ~1 h · M = a session · L = multi-session.

---

## 1. Critical stability (fix first)

### 1.1 Sidecar disconnect permanently wedges the rebuild pipeline — `src/geometry/client.ts:169` (high, S)
*Found independently by two analysts; hand-verified.* `call()` creates promises that can only resolve — there is no reject path in the class — and `ws.onclose` never touches `this.pending`. If the socket drops mid-`rebuild` (sidecar crash, OCCT segfault), the awaited promise never settles, so `DocumentStore.rebuilding` stays `true` forever (`store.ts:556`). The reconnect handler in `main.ts:665` calls `rebuildNow()`, which sees `rebuilding === true`, queues, and returns — so even a clean reconnect can never rebuild again. Full app reload required, risking unsaved work.
**Fix:** on `onclose`/`onerror`, settle every pending entry with a synthetic `{ ok: false, error }` and clear the map so `rebuildNow()`'s `finally` releases the flag; add a per-call timeout as backstop. Related low: malformed frames in `onmessage` are dropped silently (`client.ts:152`) — log them.

### 1.2 Editing a sketch with a pattern bakes derived copies into persisted entities — `src/sketch/sketchMode.ts:179` (high, S)
*Hand-verified — real data corruption.* `enter(editId)` assigns `this.entities = resolveEntities(f, ...)`, but `resolveEntities` (`src/sketch/resolve.ts:85-88`) appends every pattern's expanded copies (`p3#0`, `p3#1`, …) onto the returned array — despite its own comment "the copies are derived here, never stored as real entities." `finish()` then persists the whole array via `toSketchEntity` **and** keeps the pattern definitions, so every edit→finish cycle duplicates the pattern geometry. `src/ui/inspector.ts:97` shows the correct discipline (writes back into the original `f.entities` only).
**Fix:** resolve real entities and derived copies separately; only real entities are editable/persisted. Add the round-trip regression test (see §5.2).

### 1.3 Revolve/Loft silently discard the active body — `sidecar/builder.py:1260` (high, M)
*Hand-verified.* Both handlers do `act["shape"] = solid` when a body exists — the previous shape is dropped with no boolean, no warning. Extrude routes through `_boolean_into_bodies` and sweep has an `operation` field; revolve/loft are the only solid-creating features with neither, and `startRevolve`/`startLoft` (`src/main.ts:1223-1252`) lack the guard `startMirror` has. Zero test coverage for either feature.
**Fix:** give revolve/loft an `operation` field threaded through `_boolean_into_bodies` (preferred, matches extrude), or at minimum raise a ValueError when a body exists; add a smoke test locking in the behavior.

### 1.4 A dead sidecar is invisible: no crash detection, no restart, infinite silent retry (high, M)
Two halves, hand-verified on the Rust side:
- `src-tauri/src/sidecar.rs:146` — after spawn there is only the stdout pump and a one-shot 20 s readiness warning. Nothing ever calls `try_wait()`; a Python process that dies after `LISTENING` is never noticed and never respawned.
- `src/geometry/client.ts:179` (medium) — `scheduleReconnect()` retries every 500 ms forever with no cap and no user-facing signal.
**Fix:** supervisor thread in Rust that `try_wait()`s periodically and either respawns (rotating the token) or emits a `sidecar:died` event; frontend shows a persistent "geometry engine disconnected" banner with manual retry after N failures. Pairs with 1.1 so recovery actually works end to end.

### 1.5 Save / Save As fail silently — `src/io/files.ts:18` (high, S)
`writeTextFile` is unwrapped and every caller is `void saveDocument(store)`. Disk-full/permission errors vanish as unhandled rejections; the user's Ctrl+S appears to succeed and they may close the app. The same file already has `reportError()` used for export/import — route save failures through it.

### 1.6 Tool-concurrency guards are inconsistent (high, S + M)
- `src/main.ts:755` — `startFillet`/`startChamfer` have **no** busy check; `startPressPull`/`startExtrude` share a stale hand-rolled list missing `moveTool/measure/section/planePick`. Repro: open Section, click Fillet — both tools fight over the same clicks. **Fix:** every starter calls the canonical `toolBusy()` (`main.ts:1195`).
- `src/ui/choice.ts:50` (M) — an open `choose()`/`chooseMulti()` modal is invisible to `toolBusy()`, and its keydown handler only intercepts Escape/Arrows/Enter, so shortcuts (e.g. `e` → Extrude) fire underneath every awaiting modal (Mirror, Split, Combine, Revolve, Sweep, Primitive, Pattern, Section axis-pick). **Fix:** a module-level modal-open flag OR'd into `toolBusy()`, or swallow all keys while the backdrop is up.

### 1.7 No global unhandled-rejection backstop — `src/main.ts:1461` (medium, S)
The known Revolve/Loft/Sweep fire-and-forget issue is actually systemic: ~12 `void startX()` / `void exportModel()` / `void sendToPrinter()` call sites plus `void this.pump()` in sketch mode, with no `unhandledrejection`/`onerror` handler anywhere. One listener at bootstrap that logs + toasts closes the entire class at once.

### 1.8 Remaining medium stability items
| Finding | Where | Fix |
|---|---|---|
| Corrupt/truncated `.sindri` crashes load with zero feedback | `src/document/store.ts:488` | try/catch around `JSON.parse` → error toast naming the file |
| Autosave failures logged-and-forgotten — crash-recovery net can silently die | `src/io/recovery.ts:52` | toast after 2-3 consecutive failures |
| Move/cleanUp silently no-op on stale body ids (unlike Press/Pull, Delete Face, which raise) | `sidecar/builder.py:1345` | raise or push a diag entry like `_do_combine` |
| Fillet/chamfer on zero resolved edges → raw `IndexError: list index out of range` in the red chip | `sidecar/builder.py:1143` | `if not edges: raise ValueError("no edge found to fillet")` |
| Deleting a pattern's source entity silently shrinks the pattern | `src/sketch/sketchMode.ts:1441` | prune `pat.sources` in `afterModify()` + toast, mirroring constraint pruning |
| In-RAM mesh cache key ignores tolerance (disk key includes it) — latent staleness bug | `sidecar/server.py:149` | store tolerance alongside `shape`, require both to match |

---

## 2. Performance

### 2.1 Every rebuild reply forces a full-scene GPU rebuild — `src/viewport/render.ts:66` (high, L)
The wire protocol (client.ts `assemble()`) carefully avoids re-transmitting unchanged bodies via etags — then `buildModel()` concatenates ALL bodies into one `BufferGeometry`, runs `computeVertexNormals()` over the whole merged mesh, and `setModel` disposes + rebuilds unconditionally on every reply, including every live-preview drag tick. **Fix:** per-body `Mesh`/`BufferGeometry` keyed by body id, matching the etags already tracked; only rebuild changed bodies. Largest single perf win; also unlocks cheaper picking/highlight. (Related, same file line 110, L: one `LineMaterial` + one draw call per edge — batching into merged `LineSegments2` with per-vertex highlight colors is the long-term fix.)

### 2.2 Interactive-path quick wins (all S)
| Finding | Where | Fix |
|---|---|---|
| Mesh disk-cache write is unthrottled and double-fsyncs on every interactive tick (every param drag = new content key = guaranteed miss = inline fsync×2) — the checkpoint write a few lines later is already debounced by cost | `sidecar/server.py:178` | gate `put_mesh` like the checkpoint save, or move it off the reply path |
| Body-move drag re-uploads the ENTIRE position buffer every pointermove (`needsUpdate = true` = whole-buffer upload) | `src/viewport/viewport.ts:1361` | `BufferAttribute.addUpdateRange()` (three r180) scoped to the moved body's range |
| Render loop discards `rig.update(dt)`'s "did anything move" boolean and redraws every rAF forever | `src/viewport/viewport.ts:1489` | gate render on `moved` OR a dirty flag; idle viewport stops burning GPU/battery |
| `pickEdge()` copies the resolution vector into every edge material and reallocates a filtered array on every pointermove | `src/viewport/picking.ts:85` | delete the loop (resize already syncs it); cache the visible-edge array |

### 2.3 Medium perf
- **Hover/select repaint is O(model)** — `src/viewport/highlight.ts:150`: full linear scan of all triangle faceIds plus whole-color-buffer reupload per hover. Build a `Map<faceId, triangles[]>` once in `buildModel()` + `addUpdateRange`. (M)
- **Tessellation tolerance hardcoded at 0.1 mm absolute** — `sidecar/tessellate.py:21`: a 500 mm frame and a 5 mm bracket mesh to the same deviation. Scale interactive tolerance to bbox diagonal; export already uses its own fine 0.02. (M — do after 1.8's cache-key fix, which it would otherwise trip.)
- **`printer_upload_and_print` does `std::fs::read` inside an async command** — `src-tauri/src/printer.rs:347`: blocks a tokio worker for the duration of a large gcode read. `tokio::fs::read` or `spawn_blocking`. (S)

---

## 3. UX

- **Raw internal exceptions reach the user verbatim** — `sidecar/builder.py:1376`: the per-feature `except Exception` passes `str(ex)` from OCCT/build123d internals straight into the toast. Distinguish the app's own ValueErrors from internal exceptions; give the latter a human fallback message. (medium, M)
- **Section tool has no typed value entry** — `src/features/sectionTool.ts:70`: every other draggable-numeric tool wires DimInput; Section is drag-only. (medium, S)
- Lows: `fillet-sketch` ribbon entry missing its `key: "F"` tooltip (`ribbon.ts:150`); `chooseMulti()` lacks the autofocus/Enter handling `choose()` was specifically hardened with (`choice.ts:135`); dead ternary in `resolveShortcut()` (`shortcuts.ts:67`).

---

## 4. Refactoring

Ordered by value; all behavior-preserving and incremental.

1. **`builder.py` rebuild dispatch** (medium, L) — the ~300-line `if/elif` chain over 25 feature types inside `rebuild()` (`builder.py:1082-1374`), all closing over local closures. Extract `_handle_<type>(f, ctx)` functions + a dict dispatch; start with the trivial handlers (box/cylinder/sphere/removeBody). Highest-risk file in the repo to regress silently — do this with the smoke suite green at every step.
2. **`main.ts` god module** (medium, L) — 1710 lines: 5 context-menu builders, ~20 `start*` functions, 3 copy-pasted floating panels with manual `innerHTML` + Esc-listener boilerplate, a 240-line `handleAction` switch, and ownerless module-level state. Carve into `ui/contextMenus.ts`, `features/featureStarters.ts`, `ui/panels/*` with one shared `FloatingPanel` helper.
3. **`SketchMode` class** (medium, L) — 1615 lines, ~30 fields, ~100 methods. Extract the constraint-tool click handling (~1310-1432) and pattern placement/edit flow (~568-673) into collaborators, the way `modify.ts` already externalizes trim/fillet/offset.
4. **`DocumentStore` overlay boilerplate** (medium, M) — six hand-written copies of the map/get/set/toJSON/load pattern (`store.ts:320-499`). Extract an `Overlay<T>` helper so overlay #7 can't forget a step.
5. **Untyped WS protocol layer** (medium, M) — `client.ts:187`: `Promise<any>` end-to-end; a sidecar field rename produces silent `undefined`s instead of compile errors. Type `call<T>()` per op and `assemble()` against the real v2 wire shape. This is the file that enforces the app's central contract.
6. **Selector-v2 dead weight** (medium, S) — `geom_select.py:20`: ~180 lines of `by:"match"`/`"tangentChain"` machinery mirrored in geom.rs, with zero production call sites (picking emits only `nearest`/`normal`). Either wire persistent edge references to use it, or mark it deferred in the docstring.
7. Lows: dead `_chain_keys` (`builder.py:1518`); `SKETCH_TOOLS`/`SKETCH_MODIFY`/`NON_REPEATABLE` hand-maintained action sets duplicating ribbon knowledge (`main.ts:1397`); needless `export` on `noteCommitted` (`main.ts:600`); `printer_probe` missing the HTTP-status check its siblings have (`printer.rs:250`).

---

## 5. Testing

1. **CI runs zero tests** — `.github/workflows/build.yml` (high, S): the pipeline builds installers only; the ~9.7k lines of sidecar tests and the Rust unit tests run only when a developer remembers. Add a test job (sidecar scripts on Linux + `cargo test --lib`) gating the build. Note: the sidecar test files are `__main__` scripts, not pytest-discoverable — `pytest sidecar/` silently collects 0 tests (`test_ws.py:21`, low) — so CI must invoke them directly.
2. **Frontend: zero tests, no runner installed** — `package.json` (high, M): add vitest (native to the existing Vite setup) and start with the pure headless modules: `src/sketch/pattern.ts` `expandPattern` (including the known half-integer divergence) and `src/sketch/region.ts` `detectRegions`/`pointInRegion` — the TS half of mirrored invariant #6, currently tested only on the Python side. First test to write: the **resolve→edit→finish round trip for patterned sketches** (`resolve.ts:85`, medium) — it directly locks in the §1.2 fix.
3. **`sidecar.rs` has zero tests** (medium, S): extract `resolve_runtime()`'s fallback chain (bundled → dev venv → error) into a pure helper testable with tempdir fixtures — this is where packaging bugs actually live.
4. **`rust-geom` is never compiled by CI** (medium, S): `cargo check --features rust-geom` in CI so the 2320-line geom.rs (67 unwrap/expect calls) can't bit-rot invisibly.
5. **Spline is the only sketch primitive with no rebuild coverage** (medium, S): add a smoke test extruding a spline profile and one with a spline inside a pattern (`builder.py:3452`).

---

## 6. Documentation

Timely: the repo is about to go **public** for the grant submission — items 1-3 are what a first-time evaluator hits.

1. **README demands a system OpenCASCADE the default build no longer needs** (`README.md:106`, high, S) — contradicts `docs/PACKAGING.md`; an evaluator installs cmake+OCCT for nothing. Drop it from prerequisites; note OCCT is only for opt-in `rust-geom`.
2. **README's sidecar setup bypasses the lockfile** (`README.md:113`, medium, S) — tells contributors to run the exact unpinned install the project already learned is wrong. Replace with `uv sync`.
3. **NOTICE.md omits ~15 runtime deps that ship in the sidecar bundle** (`NOTICE.md:31`, medium, S) — build123d's transitive deps (numpy, scipy, sympy, ezdxf, ipython, …) are distributed in the ~800 MB runtime but unlisted, so the file's own attribution claim is currently false for a shipped build. Mostly permissive licenses — a paperwork fix; consider generating it from `uv.lock` so it can't drift.
4. **No shippable ARCHITECTURE.md** (medium, M) — the invariants live only in the internal handoff. Extract: 3-layer diagram, the 7 hard invariants, wire-protocol summary, bundled-runtime layout.
5. **The WS JSON protocol has no documented reference** (`server.py:667`, medium, M) — the central contract (7 ops + progress-frame convention) is only recoverable by reading server.py and client.ts end to end. A short docs/PROTOCOL.md (or an ARCHITECTURE.md section).
6. Lows: shortcuts/`?` HUD never mentioned in any shipped doc (`README.md:21`); `builder.py:14` docstring still says "verified against build123d 0.10.x".

---

## Suggested execution order

**Batch A — stability quick wins (one session, all S):** 1.1 WS reject-on-close, 1.2 pattern-baking fix, 1.5 save error surfacing, 1.6 `toolBusy()` consolidation, 1.7 unhandledrejection backstop, corrupt-load catch, fillet/chamfer empty-edges ValueError, autosave-failure toast.

**Batch B — before going public (S):** README OCCT + `uv sync` fixes, NOTICE.md dependency sweep, CI test job.

**Batch C — perf quick wins (S):** fsync throttle (server.py:178), `addUpdateRange` for body-move drag, idle-render gate, pickEdge cleanup, RAM-cache tolerance key.

**Batch D — foundations (M):** vitest + pattern/region/round-trip tests; revolve/loft operation field + tests; sidecar crash supervision + disconnect banner; choose()-modal busy flag; exception-message translation layer; Section DimInput.

**Batch E — the big three (L, plan-first per standing rule):** per-body meshes in the render layer (2.1), builder.py dispatch extraction, main.ts/SketchMode carving. Each unlocks follow-ups (edge batching, adaptive tessellation, typed protocol).

---

## Appendix

**Refuted (1):** "Cross-tool busy guard is three drifted lists" (`main.ts:1023`) — verifier found `startMove` *does* call `toolBusy()` at line 1024 and the "three lists" framing was inflated; the legitimate kernel (startPressPull/startExtrude use a stale partial list) survives as §1.6.

**Verification stats:** 57 raw findings → 46 high/medium adversarially verified → 45 confirmed, 1 refuted, 0 merely restating known issues. 11 lows passed through unverified (listed inline above). 56 agents, ~3.7M tokens, ~11 min wall clock.
