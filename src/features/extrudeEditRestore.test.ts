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

  it("HOLDS the areas when nothing resolved, and still says a pick replaces them", () => {
    // This used to carry nothing here, on the reasoning that carrying into a set
    // the user is rebuilding by hand would add areas invisibly. That reasoning
    // was right about the hazard and wrong about the remedy: it removed the
    // hazard by discarding the areas. They are held now, and onDown's pick
    // branch drops them the moment the user states a set — so the add can no
    // longer happen and the loss no longer has to.
    const d = doc(shell(), {
      regions: [[45, 0, 0]],
      regionEntities: [["gone"]],
      regionHoleEntities: [[["inner"]]],
    });
    const { tool } = harness(d);
    tool.startEdit("ex1", () => {});
    // ids that name nothing: the sketch really did change, so this wording stays
    expect(prompt.text).toMatch(/not found/);
    expect(prompt.text).toMatch(/replaces/);
    expect((tool as unknown as { editCarried: unknown[] }).editCarried).toHaveLength(1);
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

  // The fence INSIDE selectRegionsByEntities, which nothing pinned: the id
  // lookup runs against `this.regions.filter(wr => wr.sketchId === sketchId)`,
  // not against every region in the document. Without that filter an id the
  // feature's own sketch no longer has, but a NEIGHBOUR does, resolves to the
  // neighbour's cell and is committed as the feature's area. Entity ids are only
  // unique within a sketch, so this is reachable whenever two sketches share an
  // id — which the tracer's own `e1`, `e2`, … naming makes ordinary, not exotic.
  it("does not resolve an id that only the OTHER sketch still has", async () => {
    const d = multiSketchDoc(
      [
        // "own" no longer has an `outer` entity at all — only a small square
        // whose id differs, so the reference cannot resolve inside its own sketch
        { id: "own", entities: [{ id: "leftover", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }] },
        // the neighbour DOES carry `outer`, and is coplanar
        { id: "other", entities: [{ id: "outer", type: "rectangle", x: 0, y: 0, width: 400, height: 400 }] },
      ],
      { sketch: "own", regions: [[45, 0, 0]], regionEntities: [["outer"]], regionHoleEntities: [[[]]] },
    );
    const { tool, written, commit } = harness(d);
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    await commit();

    // Nothing resolves inside "own", so the area is HELD and written back
    // exactly as the document had it. What the fence is for is the neighbour:
    // without it the id resolves against "other" instead, and this commits its
    // 400x400 area and re-points `sketch` at it.
    //
    // This used to assert that nothing was written at all, which was true only
    // because a commit with no selection cancelled. That cancel is gone for the
    // edit path, so the fence is now asserted directly rather than through a
    // side effect of it.
    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f).not.toBeNull();
    expect(f.sketch, "the feature was re-pointed at the coplanar neighbour").toBe("own");
    expect(f.regions, "the neighbour's area was committed").toEqual([[45, 0, 0]]);
    expect(f.regionEntities).toEqual([["outer"]]);
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

// The MIXED document above only reaches the id-less arm because a SIBLING
// reference carries ids. A wholly pre-0.1.123 feature — no `regionEntities` key
// at all — never entered that function: startEdit forked on `if (ents?.length)`
// and sent the whole list down `selectRegionsByPoints`, which drops a point that
// is inside nothing with no record that it existed. Every such area vanished
// from `regions` on a bare depth change, with no banner: exactly the silent
// deletion the id-bearing path was built to prevent, still live for the oldest
// documents in the field — the ones most likely to have been edited since.
describe("ExtrudeTool.startEdit on a WHOLLY legacy feature (no regionEntities key)", () => {
  /** Two discs and a feature that names both by point alone. `moved` shifts the
   *  sketch +20 in x, which is enough that the small disc's saved point (200,0)
   *  is 20 mm from its new centre and so outside r=5, while the big disc's
   *  (0,0) is 20 mm from ITS new centre and still inside r=50. So one area
   *  resolves and one cannot — the mixed outcome that makes the drop visible. */
  const discs = (moved: boolean): SketchEntity[] => {
    const dx = moved ? 20 : 0;
    return [
      { id: "a", type: "circle", x: dx, y: 0, radius: 50 },
      { id: "b", type: "circle", x: 200 + dx, y: 0, radius: 5 },
    ];
  };
  const legacy = (moved: boolean) =>
    doc(discs(moved), {
      regions: [
        [0, 0, 0],
        [200, 0, 0],
      ],
    });

  it("keeps the area whose point now lands in no cell, instead of deleting it", async () => {
    const { tool, written, commit } = harness(legacy(true));
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    await commit(); // a BARE depth edit: the user touched nothing else

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regions).toHaveLength(2);
    expect(f.regions).toContainEqual([200, 0, 0]); // the unresolvable point, untouched
  });

  it("says the area is KEPT rather than dropping it in silence", () => {
    const { tool } = harness(legacy(true));
    tool.startEdit("ex1", () => {});
    expect(prompt.text).toMatch(/1 of 2/);
    expect(prompt.text).toMatch(/kept/i);
  });

  it("CONTROL: with the sketch unmoved both areas resolve and commit", async () => {
    // The harness can produce two areas; it is the MOVE that loses one. Without
    // this the test above would also pass against a tool that always wrote 2.
    const { tool, written, commit } = harness(legacy(false));
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regions).toHaveLength(2);
    expect(f.regionEntities).toContainEqual(["a"]);
    expect(f.regionEntities).toContainEqual(["b"]);
  });

  it("still lets the user deliberately REMOVE an area", async () => {
    // The distinguishing question for the carry rule: holding an area the tool
    // could not draw must not make the area set unchangeable. Both discs resolve
    // here, so this is removal with nothing carried — the ordinary gesture.
    const { tool, overlay, written, commit } = harness(legacy(false));
    tool.startEdit("ex1", () => {});
    const small = overlay.regions.find((wr) => wr.region.entityIds.includes("b"))!;
    expect(small).toBeDefined();
    (tool as unknown as { regionUnder: () => unknown }).regionUnder = () => small;
    (tool as unknown as { onDown: (e: PointerEvent) => void }).onDown({
      button: 0,
      ctrlKey: true,
      clientX: 0,
      clientY: 0,
      preventDefault() {},
    } as unknown as PointerEvent);
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regionEntities).toEqual([["a"]]);
    expect(f.regions).toHaveLength(1);
  });

  it("lets the user shed a CARRIED area too, by re-stating the set", async () => {
    // The carried area is invisible, so the only way to shed it is the gesture
    // that re-states the whole set. Ctrl-click the small disc on, then off:
    // selection back where it started, carried gone, and it SAID so.
    const { tool, overlay, written, commit } = harness(legacy(true));
    tool.startEdit("ex1", () => {});
    const small = overlay.regions.find((wr) => wr.region.entityIds.includes("b"))!;
    expect(small).toBeDefined();
    (tool as unknown as { regionUnder: () => unknown }).regionUnder = () => small;
    const ctrlClick = () =>
      (tool as unknown as { onDown: (e: PointerEvent) => void }).onDown({
        button: 0,
        ctrlKey: true,
        clientX: 0,
        clientY: 0,
        preventDefault() {},
      } as unknown as PointerEvent);
    ctrlClick(); // add
    expect(prompt.text).toMatch(/no longer kept|dropped/i);
    ctrlClick(); // remove again
    await commit();

    const shed = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(shed.regionEntities).toEqual([["a"]]);
    expect(shed.regions).not.toContainEqual([200, 0, 0]);
  });

  it("writes BOTH saved areas when they now land in the same cell", async () => {
    // The one measured behaviour change of routing legacy areas per-reference.
    // Old path: `selectRegionsByPoints` stores both points and `selectedRegions`
    // matches them to the same region, so two saved areas committed as ONE
    // (measured: `OLD selectedRegions: 1`). New path resolves each reference on
    // its own and hands back the same WorldRegion twice (`NEW resolved: 2
    // distinct: 1`), so both entries survive. Two identical entries union to the
    // same solid and the count is stable across further edits (both now carry
    // the same ids and resolve to the same cell), whereas the old collapse was
    // itself a silent drop of an entry the document had — which is the defect
    // this whole file is about. Reachable when a dividing entity was deleted
    // between the save and the edit.
    const d = doc([{ id: "c", type: "circle", x: 0, y: 0, radius: 50 }], {
      regions: [
        [10, 0, 0],
        [-10, 0, 0],
      ],
    });
    const { tool, written, commit } = harness(d);
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regions).toHaveLength(2);
    expect(f.regionEntities).toEqual([["c"], ["c"]]);
  });
  // The regression this file's own fix introduced. Routing wholly-legacy
  // features through selectRegionsByEntities imported its "exactly one hit or
  // refuse" rule, which is right for an ID-BEARING reference and wrong for a
  // point-only one: the ids narrowing to several cells is genuinely ambiguous,
  // but a bare point sitting inside overlapping cells is ORDINARY. Two exactly
  // coincident circles produce one region per closed loop, so the stored point
  // hits both. Reported shape: a legacy extrude under a text glyph, on a
  // document that has not changed at all.
  const twins = (): SketchEntity[] => [
    { id: "c1", type: "circle", x: 0, y: 0, radius: 30 },
    { id: "c2", type: "circle", x: 0, y: 0, radius: 30 },
  ];
  const twinLegacy = () => doc(twins(), { regions: [[0, 0, 0]] });

  it("holds a legacy area whose point lands in two overlapping cells", async () => {
    // NOTHING HAS MOVED. The tool cannot say which cell the user meant, which is
    // a reason to refuse to DRAW the area and never a reason to drop it. Before
    // this it went down the nothing-resolved arm holding nothing, so the area
    // survived only as long as the user did not pick — and the banner invited
    // exactly that.
    const { tool, written, commit } = harness(twinLegacy());
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    expect(
      (tool as unknown as { editCarried: unknown[] }).editCarried,
      "the area was not held",
    ).toHaveLength(1);
    // and the area survives a bare commit rather than being replaced
    await commit();
    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f, "the edit was discarded instead of applied").not.toBeNull();
    expect(f.regions).toHaveLength(1);
    expect(f.regions).toContainEqual([0, 0, 0]);
  });

  it("applies a typed depth even when no area could be drawn", async () => {
    // The edit used to be thrown away here: commit read the sketch off the first
    // SELECTED region, found none, and cancelled — so a user who opened the
    // feature, typed a depth and pressed Enter got nothing at all, with no
    // message. Everything needed was present except a selection, and the sketch
    // is named by the feature itself.
    const { tool, written, commit } = harness(twinLegacy());
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    (tool as unknown as { distance: number }).distance = 12.5;
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f, "the depth edit was discarded").not.toBeNull();
    expect(f.distance).toBeCloseTo(12.5);
    expect(f.sketch, "the feature's own sketch must be preserved").toBe("s1");
    expect(f.regions, "the held area was not written back").toHaveLength(1);
  });

  it("CONTROL: creating with nothing selected still CANCELS, not just writes nothing", async () => {
    // The empty-selection cancel is load-bearing for the CREATE flow — without
    // it, Enter after removing the last area silently threw the extrude away
    // (GitHub #14). The carried-only path must not have widened past editing.
    //
    // Asserting `tool.active` rather than only "nothing was written", because
    // nothing-was-written passes for the WRONG reason: a later guard returns
    // early when no sketch can be named, so the tool writes nothing either way
    // and the assertion could not see the cancel disappear. Verified by
    // mutation — widening carriedOnly to `!this.selected.length` leaves the
    // write-nothing assertion green and this one red.
    const { tool, written, commit } = harness(twinLegacy());
    tool.start(() => {}); // create, not edit: nothing selected, nothing carried
    expect(tool.active).toBe(true);
    await commit();
    expect(written.feature, "a create with no areas wrote a feature").toBeNull();
    expect(tool.active, "the tool was left alive instead of cancelling").toBe(false);
  });

  it("does not blame the sketch for an ambiguity the sketch did not cause", () => {
    const { tool } = harness(twinLegacy());
    tool.startEdit("ex1", () => {});
    expect(prompt.text).toBeTruthy();
    expect(prompt.text, "told the user their sketch changed when it had not")
      .not.toMatch(/sketch changed/i);
  });

  it("a re-pick REPLACES the held area rather than adding to it invisibly", async () => {
    // The safety half of carrying on the nothing-resolved path. The carried area
    // cannot be seen, so if picking did not drop it the user would commit two
    // areas having chosen one — which is why the carry used to be skipped here
    // altogether, losing the area instead. Dropping on the pick is what makes
    // holding it safe.
    //
    // The pickable area is a THIRD, distant circle: picking one of the twins
    // would select both, because the overlay's selection is point-based and the
    // twins share every point. That is the fixture's nature, not the tool's, and
    // asserting through it would measure the wrong thing.
    const withSpare = doc(
      [...twins(), { id: "d", type: "circle", x: 200, y: 0, radius: 10 }],
      { regions: [[0, 0, 0]] },
    );
    const { tool, overlay, written, commit } = harness(withSpare);
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    const spare = overlay.regions.find((wr) => wr.region.entityIds.includes("d"))!;
    expect(spare, "fixture: the spare circle produced no region").toBeDefined();
    (tool as unknown as { regionUnder: () => unknown }).regionUnder = () => spare;
    (tool as unknown as { onDown: (e: PointerEvent) => void }).onDown({
      button: 0,
      ctrlKey: false,
      clientX: 0,
      clientY: 0,
      preventDefault() {},
    } as unknown as PointerEvent);
    expect(prompt.text, "the drop was not announced").toMatch(/no longer kept/i);
    await commit();

    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regionEntities, "the invisible carried area rode along").toEqual([["d"]]);
    expect(f.regions, "more areas were written than were picked").toHaveLength(1);
  });

  it("CONTROL: one circle alone resolves and is drawn, so the twin IS the cause", async () => {
    // Without this the test above would pass against a tool that never resolves
    // anything at all.
    const single = doc([{ id: "c1", type: "circle", x: 0, y: 0, radius: 30 }], {
      regions: [[0, 0, 0]],
    });
    const { tool, written, commit } = harness(single);
    expect(tool.startEdit("ex1", () => {})).toBe(true);
    await commit();
    const f = written.feature as Extract<Feature, { type: "extrude" }>;
    expect(f.regions).toHaveLength(1);
    expect(f.regionEntities).toEqual([["c1"]]);
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
