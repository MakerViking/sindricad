// The 2D constraint solver's WASM warm-up must never become an app-level error.
//
// Field report, SindriCAD 0.1.73 on Windows (bug eec3752a): every startup showed
// "Something went wrong — check the console for details" and named nothing. The
// breadcrumb behind it was an unhandledrejection carrying a Content Security
// Policy violation — that WebView2 refused to compile the module, and V8 reports
// blocked WASM compilation through the same code-generation-from-strings hook it
// uses for `eval`, which is why the message talks about evaluating a string.
// `main.ts` called `void initSolver()` with no catch, so the rejection hit the
// global unhandledrejection net.
//
// These tests pin the contract that makes that impossible, without needing a
// WebView2: initSolver never rejects, and a failure is not cached forever.
//
// Each test builds its OWN mock with vi.doMock (NOT hoisted, applies to the next
// dynamic import) and its own module instance. A single shared vi.fn() reset in
// beforeEach does not work here: `wrapperPromise` is module state that outlives
// the reset, so the mock lifecycle and the module cache end up disagreeing.
import { describe, it, expect, vi } from "vitest";

// what a WebView2 that refuses to compile WebAssembly actually throws
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
  it("turns a CSP refusal into something a user can act on", async () => {
    const { SolverUnavailable } = await solverWith(works);
    const cause = new EvalError(CSP_MESSAGE);
    const e = new SolverUnavailable(cause);
    expect(e.message).toMatch(/WebView2/);
    expect(e.message).toMatch(/Sketching still works without constraints/);
    expect(e.cause).toBe(cause);
  });

  it("passes any other cause through rather than guessing", async () => {
    const { SolverUnavailable } = await solverWith(works);
    const e = new SolverUnavailable(new Error("fetch failed: 404 planegcs.wasm"));
    expect(e.message).toContain("404 planegcs.wasm");
    expect(e.message).not.toMatch(/WebView2/);
  });
});
