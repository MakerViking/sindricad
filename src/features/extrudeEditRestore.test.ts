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

/** Several sketches on the SAME plane, then the extrude — the arrangement route B
 *  needs, and the one `doc` cannot express. The extrude names its own sketch. */
function multiSketchDoc(
  sketches: { id: string; entities: SketchEntity[] }[],
  extrude: Partial<Feature> & object,
): CadDocument {
  return {
    features: [
      ...sketches.map((s) => ({ id: s.id, type: "sketch", plane: "XY", entities: s.entities })),
      { id: "ex1", type: "extrude", distance: 5, operation: "new", ...extrude } as Feature,
    ],
    parameters: [],
  } as unknown as CadDocument;
}

/** The three collaborators startEdit reads, plus the real overlay. `beginDrag`
 *  is replaced so the assertion is about the restored selection alone.
 *
 *  `written` captures what commit() hands to `replaceFeature`, which is the only
 *  place the document actually changes — the selection is just the tool's opinion
 *  until then. `buildState` is empty on purpose: with no solid in the model
 *  commit() skips the operation modal, so it runs to completion unattended. */
function harness(document_: CadDocument) {
  const overlay = new SketchOverlay();
  const written: { feature: Feature | null } = { feature: null };
  const store = {
    document: document_,
    isParamBound: () => false,
    beginEditPreview: () => {},
    endEditPreview: () => {},
    buildState: {},
    hiddenBodyIds: () => [],
    nextId: () => "new1",
    replaceFeature: (_id: string, f: Feature) => {
      written.feature = f;
    },
    addFeature: (f: Feature) => {
      written.feature = f;
    },
  };
  const viewport = {
    suspendPicking: false,
    pointInSolid: () => false,
    addToScene() {},
    removeFromScene() {},
    projectToScreen: () => ({ x: 0, y: 0 }),
    domElement: {
      style: {},
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
    },
  };
  const tool = new ExtrudeTool(viewport as never, overlay as never, store as never);
  // the real beginDrag drives DimInput and the THREE preview; only the phase
  // it sets is load-bearing here (onDown branches on it)
  (tool as unknown as { beginDrag: () => void; phase: string }).beginDrag = function () {
    (this as unknown as { phase: string }).phase = "drag";
  };
  prompt.text = null;
  const commit = () => (tool as unknown as { commit: () => Promise<void> }).commit();
  return { tool, overlay, written, commit };
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

// A committed edit is the only thing that changes the document, so the selection
// is not the contract — what `replaceFeature` receives is. An area the tool could
// not resolve is still an area of the feature: the sidecar builds it (its own
// resolution rule differs, and the stored point is still a valid fallback there),
// so dropping it because the EDIT TOOL could not draw it deletes geometry the
// model has. One ordinary depth change must never do that.
describe("ExtrudeTool commit after a PARTIAL restore", () => {
  /** shell + a disc off to the side; the disc's area is stored under ids that no
   *  longer exist, so the tool cannot resolve it while the sidecar still can
   *  fall back to its point. */
  const partial = () =>
    doc([...shell(), { id: "disc", type: "circle", x: 200, y: 0, radius: 10 }], {
      regions: [
        [45, 0, 0],
        [200, 0, 0],
      ],
      regionEntities: [["outer"], ["gone"]],
      regionHoleEntities: [[["inner"]], []],
    });

  it("keeps the unresolved area instead of deleting it", async () => {
    const { tool, written, commit } = harness(partial());
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regions).toHaveLength(2);
    expect(f.regionEntities).toHaveLength(2);
    expect(f.regionHoleEntities).toHaveLength(2);
    // the unresolved reference survives EXACTLY as the document had it: the tool
    // has no opinion about an area it could not find, and inventing one (or
    // dropping it) is a silent geometry change
    expect(f.regionEntities).toContainEqual(["gone"]);
    expect(f.regions).toContainEqual([200, 0, 0]);
  });

  it("still re-anchors the area it DID resolve", async () => {
    const { tool, written, commit } = harness(partial());
    tool.startEdit("ex1", () => {});
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    const wall = f.regionEntities!.findIndex((ids) => ids.includes("outer"));
    expect(wall).toBeGreaterThanOrEqual(0);
    expect(f.regionHoleEntities![wall]).toEqual([["inner"]]);
  });

  it("says the areas are KEPT, not that they need re-picking", () => {
    const { tool } = harness(partial());
    tool.startEdit("ex1", () => {});
    expect(prompt.text).toMatch(/1 of 2/);
    expect(prompt.text).toMatch(/kept/i);
  });

  it("drops the carried areas once the user changes the area set, and says so", async () => {
    const { tool, overlay, written, commit } = harness(partial());
    tool.startEdit("ex1", () => {});
    // Ctrl-click the disc: the user is re-stating which areas this feature has,
    // so the references the tool was holding on their behalf stop applying.
    // `regionUnder` needs a real camera to ray-cast; the gesture under test is
    // the modifier branch of onDown, so the hit itself is supplied.
    const disc = overlay.regions.find((wr) => wr.region.entityIds.includes("disc"))!;
    expect(disc).toBeDefined();
    (tool as unknown as { regionUnder: () => unknown }).regionUnder = () => disc;
    (tool as unknown as { onDown: (e: PointerEvent) => void }).onDown({
      button: 0,
      ctrlKey: true,
      clientX: 0,
      clientY: 0,
      preventDefault() {},
    } as unknown as PointerEvent);
    expect(prompt.text).toMatch(/no longer kept|dropped/i);

    await commit();
    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regionEntities).not.toContainEqual(["gone"]);
  });

  it("carries nothing when NOTHING resolved — that path re-picks from scratch", () => {
    const d = doc(shell(), {
      regions: [[45, 0, 0]],
      regionEntities: [["gone"]],
      regionHoleEntities: [[["inner"]]],
    });
    const { tool } = harness(d);
    tool.startEdit("ex1", () => {});
    expect(prompt.text).toMatch(/not found/);
    expect((tool as unknown as { editCarried: unknown[] }).editCarried).toEqual([]);
  });
});

// Adding geometry that CROSSES a saved profile is not the sketch "changing" for
// that profile: nothing was moved or deleted, and the sidecar still resolves the
// reference (its rule is "these edges bound exactly one face", which a reference
// naming only SOME of a cell's boundary satisfies). Demanding that the traced id
// set match exactly made the tool refuse to reopen a feature the model still
// builds, which is a worse disagreement than the one being fixed.
describe("ExtrudeTool.startEdit after an entity was added across the profile", () => {
  it("still reopens on the piece the stored point is in", () => {
    // the shell's wall, then a line laid across the whole thing: every cell is
    // now bounded by {cross, ...}, so no cell carries {outer} alone any more
    const d = doc([...shell(), { id: "cross", type: "line", x1: -80, y1: 0, x2: 80, y2: 0 }], {
      regions: [[45, 0, 0]],
      regionEntities: [["outer"]],
      regionHoleEntities: [[["inner"]]],
    });
    const { tool, overlay } = harness(d);

    expect(tool.startEdit("ex1", () => {})).toBe(true);
    const sel = overlay.selectedRegions();
    expect(sel).toHaveLength(1);
    // a WALL piece, not one of the two halves of the hole
    expect(sel[0]!.region.entityIds).toContain("outer");
    expect(prompt.text ?? "").not.toMatch(/not found/);
  });
});

// A second sketch on the SAME plane is not part of this feature — a feature names
// ONE sketch. But the overlay's selection is world POINTS, and `selectedRegions`
// matches a point against every region within ~1e-3 mm of the plane, so reading
// the selection back after resolving by entity launders the identity the ids just
// established: the neighbour's region came back selected, commit wrote it into
// `regions`/`regionEntities`, and `sketch` followed whichever sketch sorted first
// in the timeline. Measured against the sidecar on the first document below:
// 18000 mm3 of shell wall became 50000 mm3, and on the second (neighbour first)
// 800000 mm3 — on nothing but reopen, change the depth, click.
describe("ExtrudeTool edit with a COPLANAR second sketch", () => {
  const big: SketchEntity[] = [
    { id: "big", type: "rectangle", x: 0, y: 0, width: 400, height: 400 },
  ];
  const wallRef = {
    sketch: "own",
    regions: [[45, 0, 0]],
    regionEntities: [["outer"]],
    regionHoleEntities: [[["inner"]]],
  };

  it("commits only its OWN sketch's area, with the neighbour later in the timeline", async () => {
    // the shell has moved, so the stored point is inside the hole AND inside the
    // neighbour's big rectangle — both wrong answers are on the table
    const d = multiSketchDoc(
      [{ id: "own", entities: shell(30, 20) }, { id: "other", entities: big }],
      wallRef,
    );
    const { tool, written, commit } = harness(d);
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regionEntities).toEqual([["outer"]]);
    expect(f.regions).toHaveLength(1);
    expect(f.sketch).toBe("own");
  });

  it("commits only its OWN sketch's area, with the neighbour EARLIER in the timeline", async () => {
    // document order decides which sketch `first.sketchId` reads, so the same
    // defect re-targets the feature's whole `sketch` field this way round
    const d = multiSketchDoc(
      [{ id: "other", entities: big }, { id: "own", entities: shell() }],
      wallRef,
    );
    const { tool, written, commit } = harness(d);
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.sketch).toBe("own"); // NOT rewritten to the neighbour
    expect(f.regionEntities).toEqual([["outer"]]);
    expect(f.regions).toHaveLength(1);
  });

  it("a LEGACY area (no ids at all) is fenced to its own sketch too", async () => {
    // Pre-0.1.123 documents resolve by point alone, so there is no id resolution
    // to keep them out of the neighbour — the fence has to be the sketch itself.
    // The neighbour is first in the timeline, so this also holds `sketch`.
    const d = multiSketchDoc(
      [{ id: "other", entities: big }, { id: "own", entities: shell() }],
      { sketch: "own", regions: [[45, 0, 0]] },
    );
    const { tool, written, commit } = harness(d);
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regions).toHaveLength(1);
    expect(f.regionEntities).toEqual([["outer"]]); // the wall, re-anchored
    expect(f.sketch).toBe("own");
  });

  it("Ctrl-clicking its OWN area does not drag the overlapping neighbour in", async () => {
    // The neighbour's 400x400 covers every point of the shell, so any anchor the
    // user adds is inside it too. What the click states is one area, not two.
    const d = multiSketchDoc(
      [{ id: "other", entities: big }, { id: "own", entities: shell() }],
      wallRef,
    );
    const { tool, overlay, written, commit } = harness(d);
    tool.startEdit("ex1", () => {});
    const ownHole = overlay.regions.find(
      (wr) => wr.sketchId === "own" && wr.region.entityIds.includes("inner"),
    )!;
    expect(ownHole).toBeDefined();
    (tool as unknown as { regionUnder: () => unknown }).regionUnder = () => ownHole;
    (tool as unknown as { onDown: (e: PointerEvent) => void }).onDown({
      button: 0,
      ctrlKey: true,
      clientX: 0,
      clientY: 0,
      preventDefault() {},
    } as unknown as PointerEvent);
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.sketch).toBe("own");
    expect(f.regionEntities).toEqual([["outer"], ["inner"]]);
  });

  it("refuses a Ctrl-click on the neighbour's area, and says why", async () => {    const d = multiSketchDoc(
      [{ id: "own", entities: shell() }, { id: "other", entities: big }],
      wallRef,
    );
    const { tool, overlay, written, commit } = harness(d);
    tool.startEdit("ex1", () => {});
    const foreign = overlay.regions.find((wr) => wr.sketchId === "other")!;
    expect(foreign).toBeDefined();
    (tool as unknown as { regionUnder: () => unknown }).regionUnder = () => foreign;
    (tool as unknown as { onDown: (e: PointerEvent) => void }).onDown({
      button: 0,
      ctrlKey: true,
      clientX: 0,
      clientY: 0,
      preventDefault() {},
    } as unknown as PointerEvent);
    // silently ignoring it is the affordance bug, silently taking it is the
    // geometry bug — so it is refused out loud
    expect(prompt.text).toMatch(/different sketch/i);

    await commit();
    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regionEntities).toEqual([["outer"]]);
    expect(f.sketch).toBe("own");
  });
});

// The ids name several cells and the stored point is in NONE of them: nothing
// available can say which piece the user extruded. Picking one is a guess written
// to disk, which is the whole defect class — so the reference is refused and kept.
describe("ExtrudeTool.startEdit when the ids tie and the point cannot break it", () => {
  /** the shell moved to (30,20) with a line laid across it: {outer} is carried by
   *  BOTH wall pieces, and the stored (45,0,0) is inside the moved hole, so it is
   *  in neither of them. */
  const ambiguous = (extra: SketchEntity[] = []) => [
    ...shell(30, 20),
    { id: "cross", type: "line", x1: -80, y1: 0, x2: 80, y2: 0 } as SketchEntity,
    ...extra,
  ];

  it("selects nothing and says the sketch changed, instead of picking a piece", () => {
    const d = doc(ambiguous(), {
      regions: [[45, 0, 0]],
      regionEntities: [["outer"]],
      regionHoleEntities: [[["inner"]]],
    });
    const { tool, overlay } = harness(d);

    expect(tool.startEdit("ex1", () => {})).toBe(true);
    expect(overlay.selectedRegions()).toEqual([]);
    expect(prompt.text).toMatch(/not found/);
  });

  it("keeps that reference byte for byte when another area DID resolve", async () => {
    // a disc off to the side resolves cleanly, so the edit stays in drag phase and
    // commits — and the tied reference must come back out exactly as it went in,
    // not re-anchored to whichever piece was picked.
    const d = doc(ambiguous([{ id: "disc", type: "circle", x: 300, y: 0, radius: 10 }]), {
      regions: [
        [45, 0, 0],
        [300, 0, 0],
      ],
      regionEntities: [["outer"], ["disc"]],
      regionHoleEntities: [[["inner"]], []],
    });
    const { tool, written, commit } = harness(d);
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    expect(prompt.text).toMatch(/1 of 2/);
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regionEntities).toContainEqual(["outer"]);
    expect(f.regions).toContainEqual([45, 0, 0]); // the stale point, untouched
    expect(f.regionEntities).not.toContainEqual(["cross", "inner", "outer"]);
    expect(f.regionEntities).toHaveLength(2);
  });
});

// A reference with no ids resolves by point, and a point that is now inside
// nothing resolves to nothing. That is not a reason to drop the area: it is the
// same "the tool cannot find it" case as dead ids, and the sidecar may still
// build it. It is carried, not deleted.
describe("ExtrudeTool.startEdit with a MIXED document (some areas have no ids)", () => {
  it("carries an id-less area whose point now lands in no cell", async () => {
    const d = doc([...shell(), { id: "disc", type: "circle", x: 200, y: 0, radius: 10 }], {
      regions: [
        [45, 0, 0],
        [1000, 1000, 0], // off in space: inside no region of this sketch
      ],
      regionEntities: [["outer"], []],
      regionHoleEntities: [[["inner"]], []],
    });
    const { tool, written, commit } = harness(d);
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    expect(prompt.text).toMatch(/1 of 2/);
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regions).toContainEqual([1000, 1000, 0]);
    expect(f.regions).toHaveLength(2);
  });
});
