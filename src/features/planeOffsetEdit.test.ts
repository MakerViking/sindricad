// Moving an offset plane after it has been made.
//
// Field report df10c0b3 (0.1.181, Windows): "press/pull to an offset plane, then
// move the offset plane and expect the surface to move with the offset plane...
// does not visibly do this."
//
// The parametric link was never broken. Measured against the real builder: a box
// 40x40x10 with a datum on XY at offset 20 / 30 / 40 and a press/pull up to it
// gives body volumes 40000 / 56000 / 72000 mm³ — exactly 40x40x10 per 10 mm of
// plane. `upToOffset` is honoured too, negatives included (-15/-5/0/+5 →
// 32000/48000/56000/64000).
//
// What was missing was any way to MOVE the plane. `editFeature` had no
// datumPlane arm, so double-clicking it landed in the inspector; this tool was
// creation-only; and Move takes bodies, so selecting the plane and pressing M
// silently dragged the last body instead. The plane never moved, so of course
// nothing followed it.
//
// These drive the real PlaneOffsetTool against DOM and viewport stubs. What they
// do NOT cover, stated rather than implied: the drag itself (that needs a
// raycast against the gizmo) and whether the arrow is visible. A human still has
// to grab it.
import { describe, it, expect, beforeEach } from "vitest";
import { installFakeDocument } from "../ui/fakeDom.testkit";

installFakeDocument();
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= () => 0;
(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame ??= () => {};
(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };

const { PlaneOffsetTool } = await import("./planeOffsetTool");
const mainSrc = (await import("../main.ts?raw")).default;

const XY = { origin: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], xdir: [1, 0, 0] as [number, number, number] };

/** Just the viewport surface PlaneOffsetTool touches outside a pointer event. */
function stubViewport() {
  return {
    suspendPicking: false,
    domElement: {
      addEventListener() {},
      removeEventListener() {},
      style: {} as Record<string, string>,
    },
    projectToScreen: () => ({ x: 0, y: 0 }),
    addToScene() {},
    removeFromScene() {},
    pixelWorldSize: () => 0.1,
    rayFrom: () => ({ intersectObjects: () => [] }),
  };
}

interface Patch { id: string; patch: Record<string, unknown> }

function stubStore(features: Record<string, unknown>[], bound = false) {
  const patches: Patch[] = [];
  return {
    patches,
    store: {
      document: { features },
      isParamBound: () => bound,
      updateFeature: (id: string, patch: Record<string, unknown>) => patches.push({ id, patch }),
    },
  };
}

function make(features: Record<string, unknown>[], bound = false) {
  const { store, patches } = stubStore(features, bound);
  const tool = new PlaneOffsetTool(stubViewport() as never, store as never);
  return { tool, patches };
}

const datum = (offset: number | undefined = 12) => ({ id: "d1", type: "datumPlane", plane: XY, ...(offset === undefined ? {} : { offset }) });

/** What grabbing the arrow does: the handle unlocks the field (so cursor
 *  tracking owns it again) and the drag writes `value`. */
function drag(tool: unknown, mm: number) {
  (tool as { dim: { unlock: (n: string) => void } }).dim.unlock("offset");
  (tool as { value: number }).value = mm;
}
/** What typing does: the field holds the number and re-locks. */
function type(tool: unknown, mm: number) {
  (tool as { dim: { seed: (n: string, v: number) => void } }).dim.seed("offset", mm);
}
function commit(tool: unknown) {
  (tool as { commit: () => void }).commit();
}

let done: (string | null)[];
beforeEach(() => { done = []; });

describe("re-opening an offset plane", () => {
  it("accepts a datum plane and becomes active", () => {
    const { tool } = make([datum(12)]);
    expect(tool.startEdit("d1", (id) => done.push(id)), "startEdit refused an ordinary offset plane").toBe(true);
    expect(tool.active).toBe(true);
  });

  it("refuses anything that is not a datum plane, so the caller falls back", () => {
    const { tool } = make([{ id: "b1", type: "box", length: 1, width: 1, height: 1 }]);
    expect(tool.startEdit("b1", () => {}), "startEdit took a box").toBe(false);
    expect(tool.active).toBe(false);
  });

  it("refuses an id that no longer exists", () => {
    const { tool } = make([datum(12)]);
    expect(tool.startEdit("ghost", () => {})).toBe(false);
    expect(tool.active).toBe(false);
  });

  it("refuses a parameter-driven offset — that belongs to the inspector", () => {
    // Same rule fillet/chamfer follow: a value driven by an expression must not
    // be silently overwritten by a drag.
    const { tool } = make([datum(12)], true);
    expect(tool.startEdit("d1", () => {}), "startEdit grabbed a parameter-bound offset").toBe(false);
    expect(tool.active).toBe(false);
  });

  it("refuses to open twice", () => {
    const { tool } = make([datum(12)]);
    expect(tool.startEdit("d1", () => {})).toBe(true);
    expect(tool.startEdit("d1", () => {}), "a second startEdit re-entered a live tool").toBe(false);
  });

  it("treats a plane with no saved offset as zero rather than throwing", () => {
    const { tool } = make([datum(undefined)]);
    expect(tool.startEdit("d1", () => {})).toBe(true);
  });
});

describe("what committing an edit writes", () => {
  it("patches the SAME feature, so it is one undo step and not a new plane", () => {
    const { tool, patches } = make([datum(12)]);
    tool.startEdit("d1", (id) => done.push(id));
    drag(tool, 25);
    commit(tool);
    expect(patches.length, "commit wrote something other than one patch").toBe(1);
    expect(patches[0]!.id, "commit created a new plane instead of moving this one").toBe("d1");
    expect(patches[0]!.patch).toEqual({ offset: 25 });
    expect(done, "the caller was not told which feature to re-select").toEqual(["d1"]);
  });

  it("keeps a DRAGGED negative offset negative", () => {
    // The abs-display trap: the field displays |value| while dragging, so an
    // unguarded read-back flips a negative offset positive. Grabbing the handle
    // unlocks the field (215db097), which is what makes `value` authoritative.
    const { tool, patches } = make([datum(12)]);
    tool.startEdit("d1", () => {});
    drag(tool, -8);
    commit(tool);
    expect(patches[0]!.patch, "a dragged negative offset came back positive").toEqual({ offset: -8 });
  });

  it("keeps a TYPED negative offset negative, and the field wins over the drag", () => {
    // Typing re-locks the field, and a locked field is the truth — the old code
    // re-applied the drag's sign onto |v| and sent a typed -8 back as +8.
    const { tool, patches } = make([datum(12)]);
    tool.startEdit("d1", () => {});
    type(tool, -8);
    commit(tool);
    expect(patches[0]!.patch, "a typed negative offset came back positive").toEqual({ offset: -8 });
  });

  it("a plane opened and committed untouched keeps the offset it had", () => {
    // startEdit SEEDS the field (userDriven), so an accidental double-click and
    // Enter must be a no-op in value terms, not a reset to zero.
    const { tool, patches } = make([datum(12)]);
    tool.startEdit("d1", () => {});
    commit(tool);
    expect(patches[0]!.patch, "opening and confirming a plane moved it").toEqual({ offset: 12 });
  });

  it("writes nothing on cancel", () => {
    const { tool, patches } = make([datum(12)]);
    tool.startEdit("d1", (id) => done.push(id));
    tool.cancel();
    expect(patches, "cancel still moved the plane").toEqual([]);
    expect(done, "cancel did not report a cancel").toEqual([null]);
    expect(tool.active).toBe(false);
  });

  it("leaves no edit state behind for the next use", () => {
    // editId/onEditDone surviving a cleanup would make the NEXT create-mode
    // commit patch a feature instead of returning a plane.
    const { tool, patches } = make([datum(12)]);
    tool.startEdit("d1", () => {});
    tool.cancel();
    expect((tool as unknown as { editId: string | null }).editId).toBeNull();
    expect(patches).toEqual([]);
  });
});

describe("the edit gesture reaches it", () => {
  it("editFeature routes a datumPlane to the tool, with the inspector fallback", () => {
    const at = mainSrc.indexOf('case "datumPlane":');
    expect(
      at,
      "editFeature has no datumPlane arm again — double-clicking an offset plane lands in the "
        + "inspector and there is no way to drag it (field report df10c0b3)",
    ).toBeGreaterThan(-1);
    const arm = mainSrc.slice(at, at + 200);
    expect(arm, "the datumPlane arm does not open the offset tool").toContain("planeOffset.startEdit(id, done)");
    expect(
      arm,
      "the arm does not fall back to the inspector when the tool declines — a "
        + "parameter-driven offset would become a dead double-click",
    ).toContain("toInspector()");
  });

  it("the tool is constructed with the store it now needs", () => {
    expect(mainSrc, "PlaneOffsetTool lost the store it writes the offset through")
      .toContain("new PlaneOffsetTool(viewport, store)");
  });
});

// The handle rides the plane it moves.
//
// The gizmo was positioned at `anchor` — the SOURCE plane's origin — while the
// ghost sat at anchor + normal x offset. On a plane already 60 mm out that put
// the arrow back at the parent face, nowhere near the quad it was dragging.
// Observed in the app during hand-testing, not from a report.
describe("where the drag handle sits", () => {
  /** run one animation frame's worth of gizmo placement */
  function frame(tool: unknown) {
    (tool as unknown as { tick: () => void }).tick();
  }
  const posOf = (tool: unknown, part: "gizmo" | "ghost") =>
    (tool as Record<string, { position: { x: number; y: number; z: number } }>)[part]!.position;

  it("puts the arrow on the plane, not on the origin it is measured from", () => {
    const { tool } = make([datum(60)]);
    tool.startEdit("d1", () => {});
    frame(tool);
    // XY datum at +60: the plane, and so the handle, are 60 up the Z normal
    expect(posOf(tool, "gizmo").z, "the arrow is still anchored at the source plane").toBeCloseTo(60, 6);
  });

  it("keeps the arrow and the ghost on the same point as the value changes", () => {
    const { tool } = make([datum(60)]);
    tool.startEdit("d1", () => {});
    for (const v of [60, 98, 0, -25]) {
      drag(tool, v);
      (tool as unknown as { updateGhost: () => void }).updateGhost();
      frame(tool);
      const g = posOf(tool, "gizmo");
      const h = posOf(tool, "ghost");
      expect(g.z, `arrow off the plane at offset ${v}`).toBeCloseTo(v, 6);
      expect(h.z, `ghost off the plane at offset ${v}`).toBeCloseTo(v, 6);
      expect(g.z, `arrow and ghost parted company at offset ${v}`).toBeCloseTo(h.z, 6);
    }
  });

  it("still starts at the source plane when the offset is zero", () => {
    // Create mode opens at 0, so the arrow begins exactly where it always did
    // and only rides outward as the user drags. No change to that gesture.
    const { tool } = make([datum(0)]);
    tool.startEdit("d1", () => {});
    frame(tool);
    expect(posOf(tool, "gizmo").z).toBeCloseTo(0, 6);
  });

  it("measures the offset from the SOURCE plane, not from wherever the arrow is", () => {
    // anchor must stay put: it is what the offset is measured from, and moving
    // it would make each drag relative to the last and compound.
    const { tool, patches } = make([datum(60)]);
    tool.startEdit("d1", () => {});
    frame(tool);
    expect((tool as unknown as { anchor: { z: number } }).anchor.z, "the anchor drifted onto the plane").toBeCloseTo(0, 6);
    drag(tool, 25);
    commit(tool);
    expect(patches[0]!.patch, "the committed offset is relative to the arrow, not the source").toEqual({ offset: 25 });
  });
});
