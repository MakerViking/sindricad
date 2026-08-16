# Proving the constraint solver starts under the tightened CSP

The goal: ship `script-src 'self' 'wasm-unsafe-eval'` — i.e. drop `'unsafe-eval'` —
without killing the 2D constraint solver.

**This cannot be verified in `tauri dev`, and no unit test in this repo can verify it
either.** It has to be a packaged build, driven by hand. That is the whole reason the
bug survived to three Windows reporters and one Linux reporter, one of whom reinstalled
WebView2 for a bug that was our own configuration file.

Blocked on: a planegcs build with emscripten `-s DYNAMIC_EXECUTION=0` (upstream
[Salusoft89/planegcs#12](https://github.com/Salusoft89/planegcs/pull/12), open). Until
that artifact exists, do **not** flip the policy — the sections below are the procedure
for the day it lands, plus a negative control you can run today.

---

## 0. Why `tauri dev` cannot reproduce it

Two policies live in `src-tauri/tauri.conf.json`: `csp` and `devCsp`. Tauri chooses
between them in `AppManager::csp` (tauri 2.11.5, `src/manager/mod.rs`):

```rust
fn csp(&self) -> Option<Csp> {
  if !crate::is_dev() { self.config.app.security.csp.clone() } else { … dev_csp … }
}
```

and `is_dev()` is `!cfg!(feature = "custom-protocol")` (`src/lib.rs:308`). The Tauri CLI
turns `custom-protocol` on for **every `tauri build`, including `--debug`** — so a
`--debug` build gets the *packaged* policy while still being a debug binary with
devtools. That is the vehicle this procedure uses.

That last claim is read from tauri's source and the CLI's behaviour, not measured here —
but it cannot change the outcome, because `src/security/csp.test.ts` holds `csp` and
`devCsp` identical on `script-src`. Whichever of the two a build picks, the policy under
test is the same one. §3 shows you which it actually was.

Whichever policy is chosen is injected as a `<meta http-equiv="Content-Security-Policy">`
into the HTML **served by tauri's asset protocol** (`tauri_utils::html::inject_csp`), plus
a matching response header. Under `tauri dev` the page comes from the vite dev server
instead, so nothing is injected and no CSP applies at all. `devCsp` still has to stay in
step with `csp` — `src/security/csp.test.ts` asserts that — because the day the dev setup
changes, a stale `devCsp` becomes the policy nobody reviewed.

The sink itself: planegcs is an emscripten/embind module, and embind's
`craftInvokerFunction` builds each invoker by concatenating JavaScript **source text** and
handing it to the `Function` constructor. `'wasm-unsafe-eval'` permits WebAssembly
compilation only; the `Function` constructor needs `'unsafe-eval'`. Nothing about this is
WebAssembly, and nothing about it is the user's webview.

---

## 1. Static pre-flight (cheap, scriptable)

```sh
npm run build
sh scripts/check-csp-solver.sh
```

It prints the policy, the checksum of the installed planegcs glue, and whether the
Function-constructor sink survives into `dist/`; it exits non-zero on the one combination
that is always wrong — a tightened policy shipping the stock glue. It **cannot** prove the
solver starts. Treat a green run as permission to continue, not as a result.

---

## 2. Build a packaged app (Linux)

```sh
npm run tauri build -- --debug --no-bundle
```

Binary: `src-tauri/target/debug/sindricad`. Run it straight from a terminal so stderr is
visible:

```sh
./src-tauri/target/debug/sindricad
```

- `--debug` keeps devtools available while still applying the **packaged** `csp`
  (see §0). `--no-bundle` skips AppImage/deb packaging, which this check does not need.
- The Python geometry sidecar is irrelevant here: the constraint solver is frontend WASM
  and needs no sidecar. Without the bundled `sidecar-runtime` resource the app falls back
  to `sidecar/.venv` (`src-tauri/src/sidecar.rs`); if that is missing you get a sidecar
  error and can still complete every step below.

For the release shape (no devtools — UI observation only):

```sh
npm run tauri build          # bundles under src-tauri/target/release/bundle/
```

---

## 3. Confirm which policy is actually live

Right-click → **Inspect Element** (available in the `--debug` build), then in the console:

```js
document.querySelector('meta[http-equiv="Content-Security-Policy"]').content
```

Expect `script-src 'self' 'wasm-unsafe-eval'` with **no** `'unsafe-eval'`. If the meta tag
is absent you are looking at a dev-server page, not a packaged build, and everything below
is meaningless.

---

## 4. Observe the solver

There is **no console handle in a production bundle.** `window.__sindri` and the other
debug handles in `src/main.ts` are behind `import.meta.env.DEV`, and vite drops the branch:
after `npm run build`, `grep -c __sindri dist/assets/*.js` is `0` (verified). Drive the UI.

1. **A constraint that visibly moves geometry.** New sketch on any plane → draw two rough
   lines → apply *Horizontal* (or *Coincident* on two endpoints).
   - PASS: the geometry snaps.
   - FAIL: a red toast, *"The 2D constraint solver could not start: this build's security
     policy blocks the code it needs to initialise…"* (`SolverUnavailable`,
     `src/sketch/solver.ts`). That message means the policy regressed, never that the
     machine needs updating.
2. **Full constraint.** Keep constraining until the sketch reaches 0 DOF — the curves turn
   white (`sketchMode.ts`). A dead solver never recolours them.
3. **Drag a constrained point.** Under a live solver the neighbours follow; under a dead
   one nothing is enforced.

In the `--debug` build the console additionally shows `sketch solve failed: …` with the
underlying `EvalError`, and the startup breadcrumb `[solver] constraint solver unavailable`.

---

## 5. The negative control — do not skip it

A passing §4 proves nothing on its own: an app that never injected the CSP also passes. You
need to have seen the same procedure **fail**.

**Runnable today, before the artifact exists** (and worth doing — it converts the whole
diagnosis from an argument into an observation): tighten both policy lines, build per §2,
and confirm §4 produces the toast. Then revert. If it does *not* fail, the diagnosis is
wrong and the vendoring work is pointless — find out now.

**After vendoring:** with the tightened policy in place and §4 passing, restore the stock
glue (`npm ci`, or copy the published `planegcs.js` back over the vendored one), rebuild,
and confirm §4 fails again. One variable, both directions.

---

## 6. Traps

1. **The devtools console is not a probe.** Inspector-originated evaluation is exempt from
   the page's CSP, so `new Function("return 1")` typed into the console can succeed while
   the page's own code is blocked. Only the app's own behaviour counts.
2. **Grepping for `new Function(` finds nothing.** Closure minification renamed embind's
   helper; the shipped spelling is `function qb(b){var a=Function; … a.apply(c,b)}`. Grep
   for `var a=Function` — it is present in `dist/assets/index-*.js` today.
3. **A green `npx vitest run` says nothing about this.** No test in the repo evaluates a
   CSP; `src/security/csp.test.ts` pins the policy TEXT and `src/security/noDynamicEval.test.ts`
   keeps first-party code off the sink. Neither exercises a browser.
4. **`package.json` declares `^1.1.7`.** A lockfile refresh resolves 1.2.0 and would
   reinstall unpatched glue over whatever vendoring mechanism is chosen — and bump the
   solver a minor version at the same time. Pin it exactly when vendoring, and re-run §1.
5. **A `--no-bundle` binary is not a release build.** It shares the CSP path (same
   `custom-protocol` feature) but tests neither the bundled sidecar runtime nor the updater.

---

## 7. The change, and the way back

Both lines of `src-tauri/tauri.conf.json` (`app.security.csp` and `app.security.devCsp`),
identically:

```diff
-script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval';
+script-src 'self' 'wasm-unsafe-eval';
```

`TARGET_SCRIPT_SRC` in `src/security/csp.test.ts` holds the target string; the pin test in
that file fails on the flip by design, so the person flipping it has to come back here.

Rollback is the same edit reversed — put `'unsafe-eval'` back on both lines and rebuild. It
is a config-only change; nothing else in the tree depends on the policy text.
