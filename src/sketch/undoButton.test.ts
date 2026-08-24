// The title-bar UNDO button must work while a sketch is open.
//
// Field report (2026-08-24, Thomas): "In sketches, we've lost the possibility of
// undo!" Undo was not gone — Ctrl+Z still routed to `sketch.undoEdit()` and the
// in-sketch history was banking steps correctly. What was dead was the only
// VISIBLE affordance:
//
//   store.onDocChange(() => {
//     undoBtn.disabled = !store.canUndo;   // <- asks the DOCUMENT
//   });
//
// Two independent faults in those two lines, and either alone is enough to
// disable the button for an entire sketch session:
//
//  1. WRONG SOURCE. In-sketch geometry is not in the document, so `store.canUndo`
//     knows nothing about it. On a fresh document it is false, so the button
//     starts disabled and every sketch edit leaves it disabled.
//  2. WRONG HOOK. `store.onDocChange` does not fire when you draw a line — the
//     document has not changed — so the expression was not even re-evaluated
//     while sketching.
//
// The Edit MENU (main.ts's Menubar) had the right expression all along
// (`sketch.active ? sketch.canUndoSketch : store.canUndo`), which is what makes
// this a wiring omission rather than a design question: one file answered the
// same question two different ways.
//
// The main.ts half is asserted as SOURCE, for the reason featureEditReachable
// gives: importing main.ts boots the whole app. So it pins the EXPRESSION, not
// the presence of an identifier — and it anchors itself first, so a rename fails
// loudly instead of passing with a hole. The behavioural half — that banking a
// step actually NOTIFIES, which is what makes the refresh fire — is a real test
// against the real History below.

import { describe, it, expect } from "vitest";
import mainSrc from "../main.ts?raw";
import { SketchHistory } from "./history";
import type { SketchSnapshot } from "./history";

/** The `{...}` block starting at `openAt`, brace-matched. */
function balancedBlock(src: string, openAt: number): string {
  let depth = 0;
  for (let i = openAt; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(openAt, i + 1);
  }
  throw new Error("unbalanced braces from index " + openAt);
}

function fnBody(src: string, decl: string): string {
  const at = src.indexOf(decl);
  expect(at, `no \`${decl}\` in main.ts — this test no longer knows where the button state is decided`).toBeGreaterThan(-1);
  return balancedBlock(src, src.indexOf("{", at));
}

describe("undo button wiring (main.ts source)", () => {
  it("computes the button state from the SKETCH when one is open", () => {
    const body = fnBody(mainSrc, "function refreshUndoButtons(");
    // the whole point: the sketch is consulted, not just the store
    expect(body).toMatch(/sketch\.active\s*\?\s*sketch\.canUndoSketch\s*:\s*store\.canUndo/);
    expect(body).toMatch(/sketch\.active\s*\?\s*sketch\.canRedoSketch\s*:\s*store\.canRedo/);
    expect(body).toContain("undoBtn.disabled");
    expect(body).toContain("redoBtn.disabled");
  });

  it("never assigns the button state straight from store.canUndo again", () => {
    // The exact shape of the bug. Anywhere in the file, not just in the
    // refresher — reintroducing it next to the correct call would still win,
    // because whichever assignment runs last decides what the user sees.
    expect(mainSrc).not.toMatch(/undoBtn\.disabled\s*=\s*!store\.canUndo\s*;/);
    expect(mainSrc).not.toMatch(/redoBtn\.disabled\s*=\s*!store\.canRedo\s*;/);
  });

  it("refreshes on the SKETCH's state hook, not only on document change", () => {
    // store.onDocChange alone cannot see an in-sketch edit. If this assertion is
    // ever removed, the button silently goes stale again the moment a sketch
    // opens — the failure is invisible to every other test in the suite.
    const body = fnBody(mainSrc, "sketch.onState = () =>");
    expect(body).toContain("refreshUndoButtons()");
  });

  it("still refreshes on document change, for the model-mode half", () => {
    const at = mainSrc.indexOf("store.onDocChange(");
    expect(at).toBeGreaterThan(-1);
    expect(balancedBlock(mainSrc, mainSrc.indexOf("{", at))).toContain("refreshUndoButtons()");
  });

  it("the Edit menu and the buttons ask the SAME question", () => {
    // They disagreed for as long as the bug existed. Pin that they match, so a
    // future change to one is not silently a divergence.
    const menu = mainSrc.match(/label:\s*"Undo"[\s\S]{0,200}?disabled:\s*\(\)\s*=>\s*!\(([^)]*)\)/);
    expect(menu, "the Edit > Undo item no longer has a `disabled` predicate").not.toBeNull();
    expect((menu![1] ?? "").replace(/\s+/g, "")).toBe("sketch.active?sketch.canUndoSketch:store.canUndo");
  });
});

// --- the behavioural half: banking has to be observable ---------------------

const snap = (n: number): SketchSnapshot => ({
  entities: Array.from({ length: n }, (_, i) => ({ type: "line", id: `e${i}`, x1: 0, y1: 0, x2: i + 1, y2: 0 })),
  constraints: [],
  patterns: [],
}) as unknown as SketchSnapshot;

describe("SketchHistory reports whether it banked", () => {
  it("bankIfChanged returns true exactly when a step was added", () => {
    const h = new SketchHistory();
    h.arm(snap(1));

    // unchanged: nothing banked, and the caller must not claim otherwise —
    // sketchMode gates its onState notification on this return value, so a
    // return of `true` here would fire a UI refresh on every settling solve.
    expect(h.bankIfChanged(snap(1))).toBe(false);
    expect(h.canUndo).toBe(false);

    expect(h.bankIfChanged(snap(2))).toBe(true);
    expect(h.canUndo).toBe(true);
  });

  it("bankBefore returns false for a drag that moved nothing", () => {
    const h = new SketchHistory();
    expect(h.bankBefore(snap(2), snap(2))).toBe(false);
    expect(h.canUndo).toBe(false);
    expect(h.bankBefore(snap(1), snap(2))).toBe(true);
    expect(h.canUndo).toBe(true);
  });

  it("an undo re-arms, so the solve that follows it cannot re-bank", () => {
    // applyHistory calls requestSolve, which calls bankIfChanged. If undo did
    // not re-arm the baseline, that solve would bank the state it just restored
    // and the stack would never drain.
    const h = new SketchHistory();
    h.arm(snap(1));
    h.bankIfChanged(snap(2));
    const prev = h.undo(snap(2));
    expect(prev).not.toBeNull();
    expect(h.bankIfChanged(prev!)).toBe(false);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(true);
  });
});
