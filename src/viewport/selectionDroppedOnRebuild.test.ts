// A new model view gets a new Highlighter, and the Highlighter holds the body
// selection, so every rebuild drops it. Dropped silently, the "N bodies
// selected" prompt and the Browser's selected rows went on showing a selection
// that no longer existed (seen after undoing a Split Body: "359 bodies
// selected" over an empty selection). The swap has to say so.
import { describe, expect, it } from "vitest";
import { Viewport } from "./viewport";

function vp(selected: string[]) {
  const v = Object.create(Viewport.prototype) as Record<string, unknown>;
  let fired = 0;
  v.highlighter = { getSelectedBodies: () => [...selected] };
  v.onBodySelectionChange = () => { fired++; };
  const adopt = (next: unknown) => (v as unknown as { adoptHighlighter(h: unknown): void }).adoptHighlighter(next);
  return { adopt, fired: () => fired, v };
}

describe("a rebuild that drops the body selection", () => {
  it("tells the selection's listeners", () => {
    const p = vp(["body1", "body2"]);
    p.adopt({ getSelectedBodies: () => [] });
    expect(p.fired(), "the selection was dropped and nobody was told").toBe(1);
    p.adopt(null);
    expect(p.fired(), "nothing was selected the second time: no news").toBe(1);
  });

  it("says nothing when there was no selection to drop", () => {
    const p = vp([]);
    p.adopt({ getSelectedBodies: () => [] });
    expect(p.fired()).toBe(0);
  });
});
