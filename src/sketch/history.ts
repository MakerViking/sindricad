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
import type { ResolvedEntity } from "./snap";

/** The editable state one undo step restores — the whole of what a sketch edit
 *  can change. */
export type SketchSnapshot = {
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  patterns: SketchPattern[];
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

  private push(s: SketchSnapshot) {
    this.undoStack.push(s);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
    this.redoStack.length = 0;
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
