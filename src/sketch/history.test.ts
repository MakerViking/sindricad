import { describe, it, expect } from "vitest";
import { SketchHistory, cloneSnapshot, type SketchSnapshot } from "./history";
import type { ResolvedEntity } from "./snap";

const line = (id: string, x2 = 10): ResolvedEntity => ({ type: "line", id, x1: 0, y1: 0, x2, y2: 0 });
const snap = (ents: ResolvedEntity[], cons: SketchSnapshot["constraints"] = []): SketchSnapshot =>
  ({ entities: ents, constraints: cons, patterns: [] });

describe("SketchHistory", () => {
  it("banks one step per change and restores the previous state", () => {
    const h = new SketchHistory();
    const s0 = snap([line("a")]);
    h.reset(s0);
    expect(h.canUndo).toBe(false);

    const s1 = snap([line("a"), line("b")]);
    expect(h.bankIfChanged(s1)).toBe(true);
    expect(h.depth).toBe(1);

    const s2 = snap([line("a"), line("b"), line("c")]);
    h.bankIfChanged(s2);
    expect(h.depth).toBe(2);

    // step back one at a time, not all the way to the start
    expect(h.undo(s2)).toEqual(s1);
    expect(h.undo(s1)).toEqual(s0);
    expect(h.undo(s0)).toBe(null);
  });

  it("banks nothing when the state is unchanged", () => {
    const h = new SketchHistory();
    const s = snap([line("a")]);
    h.reset(s);
    expect(h.bankIfChanged(cloneSnapshot(s))).toBe(false);
    expect(h.canUndo).toBe(false);
  });

  // the solver moving geometry to satisfy constraints is NOT a user edit;
  // SketchMode re-arms after each settled solve, which must not bank
  it("arm() re-baselines without banking — the derived/solver exclusion", () => {
    const h = new SketchHistory();
    h.reset(snap([line("a", 10)]));
    h.arm(snap([line("a", 12)])); // e.g. the solver nudged it, or a param sync
    expect(h.canUndo).toBe(false);
    // and the NEXT real edit is measured from the new baseline
    h.bankIfChanged(snap([line("a", 12), line("b")]));
    expect(h.undo(snap([line("a", 12), line("b")]))).toEqual(snap([line("a", 12)]));
  });

  it("undoing does not itself become an undo step, and redo round-trips", () => {
    const h = new SketchHistory();
    const s0 = snap([line("a")]);
    const s1 = snap([line("a"), line("b")]);
    h.reset(s0);
    h.bankIfChanged(s1);

    expect(h.undo(s1)).toEqual(s0);
    expect(h.depth).toBe(0); // the undo consumed the step, didn't add one
    expect(h.canRedo).toBe(true);
    expect(h.redo(s0)).toEqual(s1);
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
  });

  it("a new edit after an undo clears the redo branch", () => {
    const h = new SketchHistory();
    const s0 = snap([line("a")]);
    h.reset(s0);
    h.bankIfChanged(snap([line("a"), line("b")]));
    h.undo(snap([line("a"), line("b")]));
    expect(h.canRedo).toBe(true);
    h.bankIfChanged(snap([line("a"), line("z")]));
    expect(h.canRedo).toBe(false);
  });

  // a drag mutates every frame but must collapse to ONE step
  it("bankBefore collapses a continuous gesture into a single step", () => {
    const h = new SketchHistory();
    const start = snap([line("a", 10)]);
    h.reset(start);
    // forty frames happened without touching the history at all
    const end = snap([line("a", 40)]);
    expect(h.bankBefore(start, end)).toBe(true);
    expect(h.depth).toBe(1);
    expect(h.undo(end)).toEqual(start);
  });

  it("bankBefore no-ops when the gesture moved nothing", () => {
    const h = new SketchHistory();
    const s = snap([line("a")]);
    h.reset(s);
    expect(h.bankBefore(s, cloneSnapshot(s))).toBe(false);
    expect(h.canUndo).toBe(false);
  });

  it("stores copies, so mutating the state you passed in can't corrupt history", () => {
    const h = new SketchHistory();
    const s0 = snap([line("a", 10)]);
    h.reset(s0);
    h.bankIfChanged(snap([line("a", 20)]));
    (s0.entities[0] as { x2: number }).x2 = 999; // the caller scribbles on its own object
    expect(h.undo(snap([line("a", 20)]))!.entities[0]).toMatchObject({ x2: 10 });
  });

  it("hands out copies, so scribbling on a restored state can't corrupt history", () => {
    const h = new SketchHistory();
    h.reset(snap([line("a", 10)]));
    const s1 = snap([line("a", 20)]);
    h.bankIfChanged(s1);
    const back = h.undo(s1)!;
    (back.entities[0] as { x2: number }).x2 = 999;
    // redo still returns the state as it was banked, not the scribbled one
    expect(h.redo(snap([line("a", 10)]))!.entities[0]).toMatchObject({ x2: 20 });
  });

  it("caps the stack so a long session can't grow unbounded", () => {
    const h = new SketchHistory(5);
    h.reset(snap([line("a", 0)]));
    for (let i = 1; i <= 20; i++) h.bankIfChanged(snap([line("a", i)]));
    expect(h.depth).toBe(5);
    // the oldest entries were dropped, the most recent five survive
    expect(h.undo(snap([line("a", 20)]))!.entities[0]).toMatchObject({ x2: 19 });
  });

  it("reset() clears both stacks — leaving a sketch starts fresh", () => {
    const h = new SketchHistory();
    h.reset(snap([line("a")]));
    h.bankIfChanged(snap([line("a"), line("b")]));
    expect(h.canUndo).toBe(true);
    h.reset(snap([line("x")]));
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });

  it("tracks constraints and patterns, not just entities", () => {
    const h = new SketchHistory();
    const s0 = snap([line("a")]);
    h.reset(s0);
    const s1 = snap([line("a")], [{ type: "horizontal", line: "a" }]);
    expect(h.bankIfChanged(s1)).toBe(true);
    expect(h.undo(s1)).toEqual(s0);
  });
});
