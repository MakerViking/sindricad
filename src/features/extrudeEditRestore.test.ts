// Re-opening a committed extrude must land on the area the user actually
// extruded — and when it cannot, it must SAY so rather than pick something.
//
// Field report 19314fdc ("extrude the shell wall ... the result is never the
// shell, but the inside loop extrusion") was about the BUILD, and the sidecar
// half fixed that by re-deriving the anchor from the recorded entity ids. The
// edit path is the other half, and it corrupts rather than mis-draws: a stored
// area is a world POINT (field a20cca53), so once the sketch moves the point can
// land inside that profile's HOLE. `pointInRegion` is "inside the outer loop AND
// outside every hole", so the restore selected the HOLE's region — and committing
// any edit, even a bare depth change, wrote that hole's point and entity ids back
// over the feature. Silent, one gesture, indistinguishable from a depth change.
//
// These run the REAL SketchOverlay against the REAL region tracer, so what is
// asserted is the containment rule that shipped, not a re-statement of it. Only
// `beginDrag` is stubbed: it drives DimInput and the THREE preview, and the
// question here is which areas came back selected.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { SketchOverlay } from "../sketch/overlay";
import { ExtrudeTool } from "./extrudeTool";
import type { CadDocument, Feature, SketchEntity } from "../types";

// setPrompt's banner, captured; DimInput's constructor is the only other DOM
// these paths touch (stubbed the way extrudeTool.test.ts does).
const prompt = { text: null as string | null };
const promptEl = {
  set textContent(t: string) {
    prompt.text = t;
  },
  get textContent() {
    return prompt.text ?? "";
  },
  classList: {
    add() {
      prompt.text = null;
    },
    remove() {},
  },
};
(globalThis as unknown as { document: unknown }).document = {
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
  getElementById: (id: string) => (id === "prompt" ? promptEl : null),
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener() {},
  removeEventListener() {},
};

/** A 100x100 outer / 80x80 inner shell cross-section, offset by (dx,dy).
 *  At dx=dy=0 the wall's material covers x in [40,50] at y=0. */
function shell(dx = 0, dy = 0): SketchEntity[] {
  return [
    { id: "outer", type: "rectangle", x: dx, y: dy, width: 100, height: 100 },
    { id: "inner", type: "rectangle", x: dx, y: dy, width: 80, height: 80 },
  ];
}

function doc(entities: SketchEntity[], extrude: Partial<Feature> & object): CadDocument {
  return {
    features: [
      { id: "s1", type: "sketch", plane: "XY", entities },
      {
        id: "ex1",
        type: "extrude",
        sketch: "s1",
        distance: 5,
        operation: "new",
        ...extrude,
      } as Feature,
    ],
    parameters: [],
  } as unknown as CadDocument;
}

/** The three collaborators startEdit reads, plus the real overlay. `beginDrag`
 *  is replaced so the assertion is about the restored selection alone. */
function harness(document_: CadDocument) {
  const overlay = new SketchOverlay();
  const store = {
    document: document_,
    isParamBound: () => false,
    beginEditPreview: () => {},
  };
  const viewport = {
    suspendPicking: false,
    domElement: { style: {}, addEventListener() {} },
  };
  const tool = new ExtrudeTool(viewport as never, overlay as never, store as never);
  (tool as unknown as { beginDrag: () => void }).beginDrag = () => {};
  prompt.text = null;
  return { tool, overlay };
}

/** Which of the shell's two cells came back selected, named by the entities that
 *  bound its outer loop: ["outer"] is the wall, ["inner"] is the hole's own disk. */
const selectedOuterIds = (overlay: SketchOverlay): string[][] =>
  overlay.selectedRegions().map((wr) => wr.region.entityIds);

describe("ExtrudeTool.startEdit restoring a holed area", () => {
  it("re-opens on the WALL after the sketch moved, not on the hole", () => {
    // (45,0,0) is in the wall as saved. After the +30/+20 move the inner
    // rectangle spans x[-10,70] y[-20,60] — so the stored point is now inside
    // the HOLE, and the point-only restore selects the hole's disk.
    const d = doc(shell(30, 20), {
      regions: [[45, 0, 0]],
      regionEntities: [["outer"]],
      regionHoleEntities: [[["inner"]]],
    });
    const { tool, overlay } = harness(d);

    expect(tool.startEdit("ex1", () => {})).toBe(true);
    expect(selectedOuterIds(overlay)).toEqual([["outer"]]);
  });

  it("re-anchors the stored point onto the moved wall, so committing repairs it", () => {
    // The corruption is committed, not shown: whatever is selected here is what
    // extrudeTool writes back as `regions`/`regionEntities`/`regionHoleEntities`.
    const d = doc(shell(30, 20), {
      regions: [[45, 0, 0]],
      regionEntities: [["outer"]],
      regionHoleEntities: [[["inner"]]],
    });
    const { tool, overlay } = harness(d);
    tool.startEdit("ex1", () => {});

    const wr = overlay.selectedRegions()[0]!;
    // in the moved wall's material: inside the 100x100, outside the 80x80
    const p = new THREE.Vector2(wr.region.interior.x, wr.region.interior.y);
    expect(Math.max(Math.abs(p.x - 30), Math.abs(p.y - 20))).toBeGreaterThan(40);
    expect(Math.max(Math.abs(p.x - 30), Math.abs(p.y - 20))).toBeLessThan(50);
  });

  it("an unmoved holed area still restores to the wall", () => {
    const d = doc(shell(), {
      regions: [[45, 0, 0]],
      regionEntities: [["outer"]],
      regionHoleEntities: [[["inner"]]],
    });
    const { tool, overlay } = harness(d);

    expect(tool.startEdit("ex1", () => {})).toBe(true);
    expect(selectedOuterIds(overlay)).toEqual([["outer"]]);
  });

  it("a legacy feature with no entity ids still opens on its stored point", () => {
    // Pre-0.1.123 documents carry no ids at all. Refusing them would be a
    // regression, so the point stays the fallback — exactly what the sidecar
    // does (`if not eids or plane is None: return None`).
    const d = doc(shell(), { regions: [[45, 0, 0]] });
    const { tool, overlay } = harness(d);

    expect(tool.startEdit("ex1", () => {})).toBe(true);
    expect(selectedOuterIds(overlay)).toEqual([["outer"]]);
  });

  it("ids that no longer resolve select nothing and say the sketch changed", () => {
    // The entity really is gone. Falling back to the point here is the corrupting
    // gesture this fix removes, so nothing is selected and the banner says why.
    const d = doc(shell(30, 20), {
      regions: [[45, 0, 0]],
      regionEntities: [["deleted"]],
      regionHoleEntities: [[["inner"]]],
    });
    const { tool, overlay } = harness(d);

    expect(tool.startEdit("ex1", () => {})).toBe(true);
    expect(overlay.selectedRegions()).toEqual([]);
    expect(prompt.text).toMatch(/sketch changed/);
  });

  it("one unresolvable area among two keeps the other and names the count", () => {
    const d = doc([...shell(), { id: "disc", type: "circle", x: 200, y: 0, radius: 10 }], {
      regions: [
        [45, 0, 0],
        [200, 0, 0],
      ],
      regionEntities: [["outer"], ["gone"]],
      regionHoleEntities: [[["inner"]], []],
    });
    const { tool, overlay } = harness(d);

    expect(tool.startEdit("ex1", () => {})).toBe(true);
    expect(selectedOuterIds(overlay)).toEqual([["outer"]]);
    expect(prompt.text).toMatch(/1 of 2/);
  });

  it("two cells sharing an outer entity set are told apart by the stored point", () => {
    // A line across a square: both halves are bounded by the same {square,line}
    // set, so the ids cannot discriminate and the point must. This is the case
    // the sidecar refuses outright (`len(faces) != 1`) and falls back on.
    const entities: SketchEntity[] = [
      { id: "sq", type: "rectangle", x: 0, y: 0, width: 100, height: 100 },
      { id: "cut", type: "line", x1: -60, y1: 0, x2: 60, y2: 0 },
    ];
    const d = doc(entities, {
      regions: [[0, 25, 0]],
      regionEntities: [["cut", "sq"]],
      regionHoleEntities: [[]],
    });
    const { tool, overlay } = harness(d);

    expect(tool.startEdit("ex1", () => {})).toBe(true);
    const sel = overlay.selectedRegions();
    expect(sel).toHaveLength(1);
    expect(sel[0]!.region.interior.y).toBeGreaterThan(0); // the TOP half
  });
});
