// The 2D constraint solver's WASM warm-up must never become an app-level error.
//
// Field report, SindriCAD 0.1.73 on Windows (bug eec3752a): every startup showed
// "Something went wrong — check the console for details" and named nothing. The
// breadcrumb behind it was an unhandledrejection carrying a Content Security
// Policy violation. `main.ts` called `void initSolver()` with no catch, so the
// rejection hit the global unhandledrejection net.
//
// The CAUSE of that violation was misdiagnosed for weeks as "this webview
// refuses to compile WebAssembly, update your runtime". It is not. planegcs is
// an emscripten/embind module, and embind hands a SOURCE STRING to the
// `Function` constructor to build each invoker. `'wasm-unsafe-eval'` allows
// WASM compilation but NOT the Function constructor, so the shipping CSP killed
// the solver in every packaged build (never in `tauri dev`, which serves from
// vite with no CSP). Reporters ffff5144 / 9042ea56 / cdf4c0f7 on Windows and one
// on Linux were all sent to update a runtime that was never the problem.
//
// These tests pin the contract that makes the startup failure impossible, and
// pin the message AWAY from blaming the user's machine.
//
// Each test builds its OWN mock with vi.doMock (NOT hoisted, applies to the next
// dynamic import) and its own module instance. A single shared vi.fn() reset in
// beforeEach does not work here: `wrapperPromise` is module state that outlives
// the reset, so the mock lifecycle and the module cache end up disagreeing.
import { describe, it, expect, vi } from "vitest";

// what the blocked Function constructor actually throws, verbatim from Chromium
const CSP_MESSAGE =
  "Evaluating a string as JavaScript violates the following Content Security Policy directive " +
  "because 'unsafe-eval' is not an allowed source of script: script-src 'self' 'wasm-unsafe-eval'";

/** Fresh solver module whose WASM init behaves as `impl` says. Returns the
 *  module plus the spy, so a test can count instantiations. */
async function solverWith(impl: () => Promise<unknown>) {
  vi.resetModules();
  const instantiate = vi.fn(impl);
  vi.doMock("@salusoft89/planegcs", () => ({
    init_planegcs_module: instantiate,
    GcsWrapper: class {
      constructor(readonly sys: unknown) {}
    },
    SolveStatus: { Success: 0 },
  }));
  vi.doMock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({ default: "/planegcs.wasm" }));
  const mod = await import("./solver");
  return { ...mod, instantiate };
}

const refuses = () => Promise.reject(new EvalError(CSP_MESSAGE));
const works = () => Promise.resolve({ GcsSystem: class {} });

describe("constraint solver warm-up", () => {
  it("resolves false instead of rejecting when the WASM will not compile", async () => {
    const { initSolver } = await solverWith(refuses);
    // the assertion that matters: this must not throw, or the global
    // unhandledrejection net toasts a nameless error at every startup
    await expect(initSolver()).resolves.toBe(false);
  });

  it("reports success when the module comes up", async () => {
    const { initSolver } = await solverWith(works);
    await expect(initSolver()).resolves.toBe(true);
  });

  it("does not cache a failure — a later attempt retries and can succeed", async () => {
    let first = true;
    const { initSolver, instantiate } = await solverWith(() => {
      const r = first ? refuses() : works();
      first = false;
      return r;
    });
    expect(await initSolver()).toBe(false);
    // a rejected promise left in the cache would poison this forever: the user
    // could never recover without restarting, even after fixing the runtime
    expect(await initSolver()).toBe(true);
    expect(instantiate).toHaveBeenCalledTimes(2);
  });

  it("caches SUCCESS, so the module is instantiated once", async () => {
    const { initSolver, instantiate } = await solverWith(works);
    await initSolver();
    await initSolver();
    expect(instantiate).toHaveBeenCalledTimes(1);
  });
});

describe("SolverUnavailable", () => {
  it("blames the build, not the user's machine", async () => {
    const { SolverUnavailable } = await solverWith(works);
    const cause = new EvalError(CSP_MESSAGE);
    const e = new SolverUnavailable(cause);
    // The whole point of this test: three Windows reporters and one Linux
    // reporter were sent to update a runtime that was never the problem, and at
    // least one reinstalled WebView2 for nothing. The CSP is ours.
    expect(e.message).toMatch(/bug in SindriCAD/);
    expect(e.message).toMatch(/security policy/i);
    expect(e.message).not.toMatch(/WebView2|Microsoft Edge|WebKitGTK|update/i);
    // it must still say what the user CAN do, i.e. keep sketching
    expect(e.message).toMatch(/without constraints, dimensions or point dragging/);
    expect(e.cause).toBe(cause);
  });

  it("says the same thing on every platform — the cause is not environmental", async () => {
    const { SolverUnavailable } = await solverWith(works);
    // no user-agent sniffing left: one policy bug, one message
    const a = new SolverUnavailable(new EvalError(CSP_MESSAGE));
    const b = new SolverUnavailable(new EvalError(CSP_MESSAGE.replace("wasm-unsafe-eval", "self")));
    expect(a.message).toBe(b.message);
  });

  it("passes any other cause through rather than guessing", async () => {
    const { SolverUnavailable } = await solverWith(works);
    const e = new SolverUnavailable(new Error("fetch failed: 404 planegcs.wasm"));
    expect(e.message).toContain("404 planegcs.wasm");
    expect(e.message).not.toMatch(/security policy/i);
  });
});
