// Regression guard for the ambient-selection lifecycle of the Texture tool.
//
// The bug this locks: the progressive renderer installs a FRESH Highlighter per
// installment (viewport.adoptProgressiveView, once at stream begin and again for
// every appended chunk), and a new Highlighter starts with an empty
// selectedFaces. So a chunked rebuild drops the ambient selection several times
// BEFORE store.onBuild fires. The tool's rAF tick, landing in that window with
// `rebuildLanded` still false, read the empty selection as a user deselect and
// discarded the faces the user had picked — "click a face, it highlights for a
// frame, then clears itself". Shipped in ee204bc; unrelated to any one feature,
// but only visible on documents big enough to stream.

import { describe, expect, it } from "vitest";
import { TextureTool } from "./textureTool";

// The panel's constructor is the only DOM this test touches: one createElement,
// a style assign, and a body.appendChild. Stubbed rather than pulling in jsdom
// for four assertions.
(globalThis as unknown as { document: unknown }).document ??= {
  createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {} }),
  body: { appendChild() {} },
};
// tick() re-arms itself; the harness drives it by hand instead.
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame ??= () => 0;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame ??= () => {};

/** The two collaborators tick() actually reads, and nothing else. */
function harness(opts: { building: boolean }) {
  let selected: number[] = [];
  const viewport = {
    getSelectedFaceIds: () => selected,
    selectFaces: (ids: number[]) => { selected = [...ids]; },
    getSelectedBodies: () => [] as string[],
    setSelectedBodies: () => {},
  };
  const store = { buildState: { building: opts.building, result: {} } };
  const tool = new TextureTool(viewport as never, store as never);
  const t = tool as unknown as {
    active: boolean;
    lastFaceIds: number[];
    rebuildLanded: boolean;
    raf: number;
    tick: () => void;
    refreshSummary: () => void;
    pushPreview: () => void;
  };
  t.active = true;
  // stub the two side effects a tick can trigger, so the test observes state only
  t.refreshSummary = () => {};
  t.pushPreview = () => {};
  return {
    t,
    setSelection: (ids: number[]) => { selected = ids; },
    currentSelection: () => selected,
    tick: () => { t.tick(); cancelAnimationFrame(t.raf); },
  };
}

describe("TextureTool ambient selection", () => {
  it("keeps the user's faces when a rebuild wipes the selection mid-stream", () => {
    const h = harness({ building: true });
    h.t.lastFaceIds = [7, 9];
    h.setSelection([]); // the progressive renderer just installed a fresh Highlighter
    h.tick();
    expect(h.t.lastFaceIds).toEqual([7, 9]);
  });

  it("still treats an empty selection as a deselect once the build has landed", () => {
    const h = harness({ building: false });
    h.t.lastFaceIds = [7, 9];
    h.setSelection([]);
    h.tick();
    expect(h.t.lastFaceIds).toEqual([]);
  });

  it("restores the members when a completed rebuild wiped them", () => {
    const h = harness({ building: false });
    h.t.lastFaceIds = [7, 9];
    h.t.rebuildLanded = true;
    h.setSelection([]);
    h.tick();
    expect(h.currentSelection()).toEqual([7, 9]);
    expect(h.t.lastFaceIds).toEqual([7, 9]);
  });

  it("picks up a genuine user selection made while idle", () => {
    const h = harness({ building: false });
    h.t.lastFaceIds = [];
    h.setSelection([3]);
    h.tick();
    expect(h.t.lastFaceIds).toEqual([3]);
  });
});
