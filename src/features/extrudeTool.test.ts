// Regression guard for editing a committed extrude's AREA SET.
//
// The bug this locks (field report af3d6887, 0.1.103, Windows): "I extruded 2
// cylinders with a single extrude... I then wanted to edit the extrude so only 1
// cylinder was extruded but no matter how I tried I could not do this."
//
// startEdit restores the saved regions and, because it found some, goes straight
// to beginDrag() — phase "drag". beginDrag then sets the prompt "Editing extrude:
// Ctrl-click areas to add/remove". But onDown's region-toggle branch only exists
// under phase === "pick"; in drag phase EVERY left click fell through to
// commit(). So the affordance the prompt advertises had no reachable handler, and
// each attempt to deselect an area committed the extrude unchanged instead.
//
// main.ts's regionPickAt could not cover for it either — it bails on toolBusy().

import { describe, expect, it, vi } from "vitest";
import { ExtrudeTool } from "./extrudeTool";

// DimInput's constructor and setPrompt are the only DOM these paths touch.
// Stubbed rather than pulling in jsdom, matching textureTool.test.ts.
(globalThis as unknown as { document: unknown }).document ??= {
  createElement: () => ({
    style: {},
    appendChild() {},
    addEventListener() {},
    remove() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  }),
  body: { appendChild() {} },
  getElementById: () => null,
};

type Region = { sketchId: string; interior3D: { x: number; y: number } };

/** Only the collaborators onDown actually reads. */
function harness(regionUnderCursor: Region | null, selectedNow: Region[]) {
  let selection = [...selectedNow];
  const toggled: Region[] = [];

  const overlay = {
    toggleRegionSelection: (r: Region) => {
      toggled.push(r);
      const i = selection.indexOf(r);
      if (i >= 0) selection.splice(i, 1);
      else selection.push(r);
    },
    selectedRegions: () => selection,
    setHoverRegion: () => {},
    regions: [] as Region[],
  };
  const viewport = { suspendPicking: false, domElement: { style: {} } };
  const store = {};

  const tool = new ExtrudeTool(viewport as never, overlay as never, store as never);
  const t = tool as unknown as {
    active: boolean;
    phase: "pick" | "drag";
    editId: string | null;
    selected: Region[];
    onDown: (e: PointerEvent) => void;
    onUp: (e: PointerEvent) => void;
    regionUnder: (x: number, y: number) => Region | null;
    commit: () => Promise<void>;
    updatePreview: () => void;
    disposePreviewGeom: () => void;
  };

  t.active = true;
  t.phase = "drag"; // where startEdit leaves an edit with resolvable areas
  t.editId = "ex1";
  t.selected = [...selectedNow];
  t.regionUnder = () => regionUnderCursor;

  const commit = vi.fn(async () => {});
  t.commit = commit;
  t.updatePreview = () => {};
  t.disposePreviewGeom = () => {};

  return { t, commit, toggled, currentSelection: () => selection };
}

const click = (mods: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean }) =>
  ({ button: 0, clientX: 10, clientY: 10, preventDefault() {}, ...mods }) as unknown as PointerEvent;

describe("ExtrudeTool editing an area set", () => {
  it("Ctrl-click on an area removes it instead of committing", () => {
    const a = { sketchId: "s1", interior3D: { x: 0, y: 0 } };
    const b = { sketchId: "s1", interior3D: { x: 20, y: 0 } };
    const h = harness(b, [a, b]);

    h.t.onDown(click({ ctrlKey: true }));

    expect(h.commit).not.toHaveBeenCalled();
    expect(h.toggled).toEqual([b]);
    expect(h.currentSelection()).toEqual([a]);
    expect(h.t.selected).toEqual([a]);
  });

  it("treats Shift and Meta the same way as Ctrl", () => {
    const a = { sketchId: "s1", interior3D: { x: 0, y: 0 } };
    for (const mods of [{ shiftKey: true }, { metaKey: true }]) {
      const h = harness(a, [a]);
      h.t.onDown(click(mods));
      expect(h.commit).not.toHaveBeenCalled();
    }
  });

  it("falls back to pick when the last area is removed, rather than previewing nothing", () => {
    const a = { sketchId: "s1", interior3D: { x: 0, y: 0 } };
    const h = harness(a, [a]);

    h.t.onDown(click({ ctrlKey: true }));

    expect(h.commit).not.toHaveBeenCalled();
    expect(h.t.selected).toEqual([]);
    expect(h.t.phase).toBe("pick");
  });

  it("a modifier click on empty space does nothing — it must not commit", () => {
    const a = { sketchId: "s1", interior3D: { x: 0, y: 0 } };
    const h = harness(null, [a]);

    h.t.onDown(click({ ctrlKey: true }));

    expect(h.commit).not.toHaveBeenCalled();
    expect(h.t.selected).toEqual([a]);
  });

  it("still commits on a PLAIN click — the fix must not break committing", () => {
    // A click is now the press AND the release: commit moved to onUp so that a
    // press which misses the depth handle and then drags cannot commit the
    // feature the user was still editing (extrudeArrowHandle.test.ts pins that
    // side). What a "plain click commits" means is unchanged; where it is
    // decided is not.
    const a = { sketchId: "s1", interior3D: { x: 0, y: 0 } };
    const h = harness(a, [a]);

    h.t.onDown(click({}));
    expect(h.commit, "committing on the press again — a miss would destroy work").not.toHaveBeenCalled();
    h.t.onUp(click({}));

    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.toggled).toEqual([]);
  });
});
