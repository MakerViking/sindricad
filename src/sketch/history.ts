// In-sketch undo/redo history: the pure state machine, kept out of SketchMode so
// it can be tested headlessly (SketchMode itself needs a viewport and a WebGL
// overlay). SketchMode owns one of these and feeds it snapshots.
//
// The design problem this solves: a sketch has ~59 sites that mutate its
// geometry, and hand-listing them is how an undo feature ends up silently
// missing one. Instead of instrumenting each, SketchMode diffs against a rolling
// `preEdit` snapshot at the single choke point every user mutation passes
// through (requestSolve). Anything that must NOT be undoable — the solver's own
// write-back, parameter sync, projection refresh — either never reaches that
// point or re-arms `preEdit` first so it compares equal.

import type { SketchConstraint, SketchPattern } from "../types";
import type { RegionCarry } from "../document/store";
import type { PointCarry } from "../document/pointCarry";
import type { ResolvedEntity } from "./snap";

/** The editable state one undo step restores — the whole of what a sketch edit
 *  can change. */
export type SketchSnapshot = {
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  patterns: SketchPattern[];
  /** the extrude area references an edit re-pointed (SketchMode.regionCarry);
   *  absent when there are none */
  regionCarry?: RegionCarry;
  /** what an edit renamed, for the extrude points and lines that name it
   *  (SketchMode.pointCarry); absent when there are none */
  pointCarry?: PointCarry;
};

export function cloneSnapshot(s: SketchSnapshot): SketchSnapshot {
  return JSON.parse(JSON.stringify(s)) as SketchSnapshot;
}

const same = (a: SketchSnapshot, b: SketchSnapshot) =>
  JSON.stringify(a) === JSON.stringify(b);

export class SketchHistory {
  private undoStack: SketchSnapshot[] = [];
  private redoStack: SketchSnapshot[] = [];
  /** The last SETTLED state: always the pre-mutation snapshot an undo restores. */
  private preEdit: SketchSnapshot | null = null;

  constructor(private readonly cap = 100) {}

  /** Start (or restart) a session with `now` as the baseline. */
  reset(now?: SketchSnapshot) {
    this.undoStack = [];
    this.redoStack = [];
    this.preEdit = now ? cloneSnapshot(now) : null;
  }

  /** Re-arm the baseline without banking. Used when the state settles after a
   *  solve, and by DERIVED updates to make themselves invisible to bankIfChanged. */
  arm(now: SketchSnapshot) {
    this.preEdit = cloneSnapshot(now);
  }

  /** Bank one step if `now` differs from the baseline. Returns whether it did. */
  bankIfChanged(now: SketchSnapshot): boolean {
    if (!this.preEdit || same(now, this.preEdit)) return false;
    this.push(this.preEdit);
    this.preEdit = cloneSnapshot(now);
    return true;
  }

  /** Bank an explicit before-state — for a gesture that mutated continuously and
   *  should collapse to ONE step (a drag), whose frames never reached
   *  bankIfChanged. No-ops when nothing actually changed. */
  bankBefore(before: SketchSnapshot, now: SketchSnapshot): boolean {
    if (same(before, now)) return false;
    this.push(cloneSnapshot(before));
    this.preEdit = cloneSnapshot(now);
    return true;
  }

  /** Record `s` as the state the next undo restores.
   *
   *  The same state twice in a row is an undo that changes nothing, so it is
   *  recorded once. Two banks of one state happen when a gesture banks itself on
   *  release (bankBefore, from the snapshot taken when it began) after an edit
   *  made while it was held had already banked that same starting state:
   *  pressing X mid-drag gave the drag an empty second undo (integration 6b).
   *  The redo stack still goes either way: the sketch has changed. */
  private push(s: SketchSnapshot) {
    this.redoStack.length = 0;
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && same(top, s)) return;
    this.undoStack.push(s);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
  }

  /** The state to restore, or null when there is nothing to undo. Re-arms the
   *  baseline to the restored state so the undo itself is never banked. */
  undo(now: SketchSnapshot): SketchSnapshot | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(cloneSnapshot(now));
    this.preEdit = cloneSnapshot(prev);
    return cloneSnapshot(prev); // never hand out a reference into the history
  }

  redo(now: SketchSnapshot): SketchSnapshot | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(cloneSnapshot(now));
    this.preEdit = cloneSnapshot(next);
    return cloneSnapshot(next);
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  /** depth, for tests and diagnostics */
  get depth(): number { return this.undoStack.length; }
}
