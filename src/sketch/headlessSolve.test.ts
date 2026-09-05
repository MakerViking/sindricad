// A headless solve has two failure modes that look identical from a `null`, and
// the caller has to tell them apart:
//
//   - the sketch could not be satisfied (conflict) -> keep the old coordinates,
//     say so; writing a driving dimension into the geometry anyway would put it
//     somewhere the user never asked for (applyDrivingDimsDirect's warning);
//   - the solver's WASM never came up (0.1.100 Windows WebView2, and our own
//     CSP — see solver.ts) -> NOTHING will ever satisfy that constraint, so a
//     typed length/diameter has to be written into the geometry directly or the
//     user types a number and watches nothing happen.
//
// Flattening both to null cost exactly that: DocumentStore.setSketchDimension
// could not reach its directDims fallback on the machines it was written for.
// So unavailability PROPAGATES from here and a failed solve does not.
//
// Each test builds its own module instance with vi.doMock + a dynamic import
// (the solver caches its wrapper in module state) — the pattern solver.test.ts
// established, and the reason its comment is worth reading first.
import { describe, it, expect, vi } from "vitest";
import type { Feature } from "../types";

// what the blocked Function constructor actually throws, verbatim from Chromium
const CSP_MESSAGE =
  "Evaluating a string as JavaScript violates the following Content Security Policy directive " +
  "because 'unsafe-eval' is not an allowed source of script: script-src 'self' 'wasm-unsafe-eval'";

/** headlessSolve + the SolverUnavailable class from the SAME module instance,
 *  over a planegcs whose init behaves as `impl` says. */
async function headlessWith(impl: () => Promise<unknown>) {
  vi.resetModules();
  vi.doMock("@salusoft89/planegcs", () => ({
    init_planegcs_module: vi.fn(impl),
    GcsWrapper: class {
      constructor(readonly sys: unknown) {}
    },
    SolveStatus: { Success: 0 },
  }));
  vi.doMock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({ default: "/planegcs.wasm" }));
  const [headless, solver] = await Promise.all([import("./headlessSolve"), import("./solver")]);
  return { ...headless, SolverUnavailable: solver.SolverUnavailable };
}

/** a line with a driving length — something a solve would have to satisfy */
const sketch = (): Extract<Feature, { type: "sketch" }> => ({
  id: "f1", type: "sketch", plane: "XY", name: "Sketch1",
  entities: [{ id: "l1", type: "line", x1: 0, y1: 0, x2: 30, y2: 0 }],
  constraints: [{ type: "distance", line: "l1", value: 50, id: "c0" }],
});

describe("solveSketchFeature failure modes", () => {
  it("propagates a solver that never came up, instead of looking like a conflict", async () => {
    const { solveSketchFeature, SolverUnavailable } = await headlessWith(() =>
      Promise.reject(new EvalError(CSP_MESSAGE)));
    // null here is what broke the inspector's no-solver fallback: the store
    // cannot see that nothing will EVER drive the dimension it just recorded.
    await expect(solveSketchFeature(sketch(), {})).rejects.toBeInstanceOf(SolverUnavailable);
  });

  it("still swallows a solve that ran and went wrong", async () => {
    // module up, wrapper unusable (no clear_data on the mock) — a solve that
    // failed for any reason other than "there is no solver" keeps the old
    // coordinates, silently, exactly as the param cascade has always assumed.
    const { solveSketchFeature } = await headlessWith(() => Promise.resolve({ GcsSystem: class {} }));
    await expect(solveSketchFeature(sketch(), {})).resolves.toBeNull();
  });
});
