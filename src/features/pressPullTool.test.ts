// Press/Pull is a DISPATCHER, and this pins the dispatch table.
//
// Field report (the reporter behind 383e7bfd): "press/pull just the bolt hole"
// was impossible. In Fusion, Press Pull sends a profile to Extrude, a face to
// Offset Face and an edge to Fillet; ours understood only faces, so a click on
// a sketch profile fell through pickFaceForPressPull and silently orbited the
// camera. main.ts's regionPickAt could not cover for it either — it bails on
// toolBusy(), which includes pressPull.active.
//
// The tool does not start anything itself (featureStarters owns that); it hands
// the click back. Two things about that handoff are easy to get wrong and are
// asserted below: it must NOT report onDone(null) — the starter's callback
// would record a committed feature that never existed — and it must leave
// viewport.suspendPicking false, or the receiving tool's start() re-raises it
// over a flag that never came down and the viewport stops picking for good.

import { describe, expect, it, vi } from "vitest";
import { PressPullTool, type PressPullHandoff } from "./pressPullTool";
import { DimInput } from "../sketch/dimInput";

// DimInput's constructor and setPrompt are the only DOM these paths touch.
// Stubbed rather than pulling in jsdom, matching extrudeTool.test.ts. `window`
// is stubbed too because these tests drive the REAL start()/cleanup() pair
// rather than poking privates — the listener bookkeeping is part of what the
// handoff has to get right. The drag-phase tests below also open the real
// DimInput box and build the real gizmo, hence setAttribute/focus/select and
// the animation-frame pair (node has neither).
(globalThis as unknown as { document: unknown }).document ??= {
  createElement: () => ({
    style: {},
    appendChild() {},
    addEventListener() {},
    setAttribute() {},
    focus() {},
    select() {},
    remove() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  }),
  body: { appendChild() {} },
  getElementById: () => null,
};
(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
};
// never fire the callback: tick() is a render loop, and nothing here tests it
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame ??= () => 0;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame ??= () => {};
// The drag-phase tests below press T while the REAL DimInput box is open, and
// DimInput has to decide whether that letter is a hotkey or text — which starts
// with an `instanceof HTMLInputElement` node does not have. `getAttribute`
// returns what DimInput writes on a field whose text is unchanged since focus.
class FakeField {
  constructor(private touched = false) {}
  getAttribute(name: string): string | null {
    return name === "data-undo-passthrough" ? (this.touched ? "0" : "1") : null;
  }
}
(globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement ??= FakeField;

type Entity = { kind: "edge"; edge: { id: string } } | { kind: "face"; faceId: number };
type Region = { sketchId: string; interior3D: { x: number; y: number } };
type FaceHit = { selector: unknown; faceId: number; anchor: unknown; normal: unknown; bodyId: string | null };

/** What is under the cursor. Any subset may be present at once — that is the
 *  whole point: the order the tool tests them IS the behaviour under test. */
interface World {
  entity?: Entity | null;
  region?: Region | null;
  face?: FaceHit | null;
  /** a datum plane's quad under the cursor (viewport.pickDatumAt) */
  datum?: string | null;
}

function harness(world: World, opts: { realDrag?: boolean } = {}) {
  const handoffs: PressPullHandoff[] = [];
  const dragged: FaceHit[] = [];
  const added: Record<string, unknown>[] = [];
  const onDone = vi.fn();
  /** What is currently LIT on screen — the state the real hover calls leave
   *  behind, not the fact that they were called. */
  const lit: { face: number | null; datum: string | null } = { face: null, datum: null };

  const overlay = {
    committedRegionAtRay: () => world.region ?? null,
  };
  const viewport = {
    suspendPicking: false,
    domElement: { style: {} as { cursor?: string }, addEventListener() {}, removeEventListener() {} },
    pickEntity: () => world.entity ?? null,
    // `.ray` feeds the region pick; `.intersectObjects` feeds the gizmo hit-test
    rayFrom: () => ({ ray: {}, intersectObjects: () => [] }),
    pickFaceForPressPull: () => world.face ?? null,
    pickDatumAt: () => world.datum ?? null,
    selectedFacesForPressPull: () => null, // no pre-selection: start() arms the pick phase
    projectToScreen: () => ({ x: 0, y: 0 }),
    addToScene() {},
    removeFromScene() {},
    setPressPullGhost() {},
    clearPressPullGhost() {},
    // the real one clears the previous highlight, then lights the face it hit —
    // it raycasts the same body meshes pickFaceForPressPull does, hence the
    // shared `world.face`
    hoverFaceAt() {
      lit.face = world.face?.faceId ?? null;
      return lit.face;
    },
    clearHover() {
      lit.face = null;
    },
    hoverDatum(id: string | null) {
      lit.datum = id;
    },
  };
  const store = {
    nextId: () => `f${added.length + 1}`,
    addFeature: (f: Record<string, unknown>) => added.push(f),
  };

  const tool = new PressPullTool(viewport as never, store as never, overlay as never);
  const t = tool as unknown as {
    active: boolean;
    phase: "pick" | "drag";
    value: number;
    onMove: (e: PointerEvent) => void;
    onDown: (e: PointerEvent) => void;
    onUp: (e: PointerEvent) => void;
    onKey: (e: KeyboardEvent) => void;
    beginDrag: (...args: unknown[]) => void;
    dim: unknown;
  };

  tool.start(onDone, (h) => handoffs.push(h));
  // the dispatch tests only care THAT the drag was begun; the drag-phase tests
  // need the real one (it owns the up-to state this file also pins)
  if (!opts.realDrag) {
    t.beginDrag = (sel, ids, anchor, normal, bodyId) =>
      dragged.push({ selector: sel, faceId: (ids as number[])[0]!, anchor, normal, bodyId } as FaceHit);
  }

  return { tool, t, handoffs, dragged, added, onDone, viewport, lit };
}

/** A left click that records whether the tool consumed it. */
function click() {
  const consumed = { prevented: false, stopped: false };
  const e = {
    button: 0,
    clientX: 10,
    clientY: 10,
    preventDefault: () => { consumed.prevented = true; },
    stopImmediatePropagation: () => { consumed.stopped = true; },
  } as unknown as PointerEvent;
  return { e, consumed };
}

const EDGE: Entity = { kind: "edge", edge: { id: "e7" } };
const FACE_ENTITY: Entity = { kind: "face", faceId: 3 };
const REGION: Region = { sketchId: "s1", interior3D: { x: 0, y: 0 } };
const FACE: FaceHit = { selector: { kind: "face" }, faceId: 3, anchor: {}, normal: {}, bodyId: "b1" };

// The dispatch table, enumerated. Adding a fourth pickable kind means adding a
// row here — the ratchet is that every kind has a named destination, so a new
// one cannot be silently dropped into the face branch.
const DISPATCH: {
  what: string;
  world: World;
  expect: "fillet" | "extrude" | "presspull" | "nothing";
}[] = [
  { what: "an edge", world: { entity: EDGE }, expect: "fillet" },
  { what: "a sketch profile", world: { entity: FACE_ENTITY, region: REGION, face: FACE }, expect: "extrude" },
  { what: "a body face", world: { entity: FACE_ENTITY, face: FACE }, expect: "presspull" },
  { what: "empty space", world: {}, expect: "nothing" },
];

describe("PressPullTool dispatch", () => {
  for (const row of DISPATCH) {
    it(`sends ${row.what} to ${row.expect}`, () => {
      const h = harness(row.world);
      const { e } = click();

      h.t.onDown(e);

      const kinds = h.handoffs.map((x) => x.kind);
      if (row.expect === "fillet") {
        expect(kinds).toEqual(["edge"]);
        expect(h.dragged).toEqual([]);
      } else if (row.expect === "extrude") {
        expect(kinds).toEqual(["region"]);
        expect(h.dragged).toEqual([]);
      } else if (row.expect === "presspull") {
        expect(kinds).toEqual([]);
        expect(h.dragged).toHaveLength(1);
      } else {
        expect(kinds).toEqual([]);
        expect(h.dragged).toEqual([]);
      }
    });
  }

  // The standing model-view priority is EDGE > sketch REGION > body FACE, which
  // the user has insisted on twice. These two pin it at the points where the
  // kinds actually overlap on screen.
  it("an edge over a profile still goes to Fillet", () => {
    const h = harness({ entity: EDGE, region: REGION, face: FACE });
    h.t.onDown(click().e);
    expect(h.handoffs.map((x) => x.kind)).toEqual(["edge"]);
  });

  it("a profile lying on a face goes to Extrude, not Press/Pull", () => {
    const h = harness({ entity: FACE_ENTITY, region: REGION, face: FACE });
    h.t.onDown(click().e);
    expect(h.handoffs.map((x) => x.kind)).toEqual(["region"]);
    expect(h.dragged).toEqual([]);
  });

  it("carries the region and the edge through, not just their kind", () => {
    const viaRegion = harness({ region: REGION });
    viaRegion.t.onDown(click().e);
    expect(viaRegion.handoffs[0]).toEqual({ kind: "region", region: REGION });

    const viaEdge = harness({ entity: EDGE });
    viaEdge.t.onDown(click().e);
    expect(viaEdge.handoffs[0]).toEqual({ kind: "edge", edge: EDGE.edge });
  });
});

describe("PressPullTool handoff post-conditions", () => {
  for (const world of [{ entity: EDGE }, { region: REGION }]) {
    const kind = world.entity ? "edge" : "region";

    it(`standing down for a ${kind} does not report a commit`, () => {
      const h = harness(world);
      h.t.onDown(click().e);
      // cancel() would have fired onDone(null) here, and the starter would have
      // recorded a null committed id for a feature that was never begun.
      expect(h.onDone).not.toHaveBeenCalled();
    });

    it(`standing down for a ${kind} releases the tool and the viewport`, () => {
      const h = harness(world);
      expect(h.viewport.suspendPicking).toBe(true); // start() raised it

      h.t.onDown(click().e);

      expect(h.tool.active).toBe(false);
      expect(h.viewport.suspendPicking).toBe(false);
    });

    it(`consumes the click it hands off for a ${kind}`, () => {
      const h = harness(world);
      const { e, consumed } = click();
      h.t.onDown(e);
      // Without this the same click also reaches the viewport underneath and
      // orbits the camera while the next tool is coming up.
      expect(consumed).toEqual({ prevented: true, stopped: true });
    });
  }

  it("leaves a click on empty space alone so it can orbit", () => {
    const h = harness({});
    const { e, consumed } = click();
    h.t.onDown(e);
    expect(consumed).toEqual({ prevented: false, stopped: false });
    expect(h.tool.active).toBe(true); // still armed, waiting for a real target
  });
});

// Bug #88 (field report ffab4ece): the reporter made an offset plane, picked a
// face, and wanted to extrude up to that plane — and a datum could not even be
// NAMED as a target. Datum quads live in their own three.js group, so
// pickFaceForPressPull (bodies only) returns null over one: the click was
// consumed, the prompt re-showed, and nothing said why.
describe("PressPullTool up-to a datum plane", () => {
  /** The face-picked, arrow-showing state every up-to click starts from. */
  function startDrag(h: ReturnType<typeof harness>) {
    h.t.beginDrag([{ kind: "face" }], [3], { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, "b1");
  }
  const TARGET_FACE: FaceHit = { selector: { kind: "face" }, faceId: 7, anchor: {}, normal: {}, bodyId: "b2" };

  it("in T mode, a click that misses every body but hits a plane binds the plane", () => {
    const h = harness({ face: null, datum: "dp" }, { realDrag: true });
    startDrag(h);
    h.t.onKey({ key: "t" } as KeyboardEvent);

    h.t.onDown(click().e);

    expect(h.added).toHaveLength(1);
    expect(h.added[0]!.upToPlane).toBe("dp");
    // both set is invalid by contract — the sidecar refuses such a feature
    expect("upTo" in h.added[0]!).toBe(false);
  });

  it("in T mode, a body in front of a plane still wins the pick", () => {
    const h = harness({ face: TARGET_FACE, datum: "dp" }, { realDrag: true });
    startDrag(h);
    h.t.onKey({ key: "t" } as KeyboardEvent);

    h.t.onDown(click().e);

    expect(h.added[0]!.upTo).toEqual(TARGET_FACE.selector);
    expect(h.added[0]!.upToPlane).toBeUndefined();
  });

  // THE regression trap: the clean-click branch runs on every click that isn't
  // on the gizmo and isn't on the operation's own faces. A datum fallback there
  // would turn "click empty space to commit" into "extrude up to this plane"
  // whenever an 80x80 quad happens to sit under the cursor.
  it("outside T mode, a clean click over a plane commits the plain distance", () => {
    const h = harness({ face: null, datum: "dp" }, { realDrag: true });
    startDrag(h);
    h.t.value = 5;

    const { e } = click();
    h.t.onDown(e);
    h.t.onUp(e);

    expect(h.added).toHaveLength(1);
    expect(h.added[0]!.distance).toBe(5);
    expect(h.added[0]!.upToPlane).toBeUndefined();
    expect(h.added[0]!.upTo).toBeUndefined();
  });

  it("the next operation does not inherit the last one's plane", () => {
    const h = harness({ face: null, datum: "dp" }, { realDrag: true });
    startDrag(h);
    h.t.onKey({ key: "t" } as KeyboardEvent);
    h.t.onDown(click().e); // commits up-to-plane and tears the tool down

    h.tool.start(h.onDone);
    startDrag(h);
    h.t.value = 4;
    const { e } = click();
    h.t.onDown(e);
    h.t.onUp(e);

    expect(h.added).toHaveLength(2);
    expect(h.added[1]!.upToPlane).toBeUndefined();
    expect(h.added[1]!.distance).toBe(4);
  });
});

// Field report c0cfee48: "I pressed T and moved over the offset plane and
// nothing lit up, so I could not tell what it was aimed at" — the click DID
// bind the plane. T mode used to hit-test only the tool's own arrow, so a target
// under the cursor, face or plane, was invisible until it was already committed.
//
// The highlight has to agree with onDown, which is what the last two cases pin:
// a plane the click would ignore, lit, is worse than no highlight at all.
describe("PressPullTool up-to target hover", () => {
  function armT(h: ReturnType<typeof harness>) {
    // the face-picked, arrow-showing state, then T for "extrude up to"
    h.t.beginDrag([{ kind: "face" }], [3], { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, "b1");
    h.t.onKey({ key: "t" } as KeyboardEvent);
  }
  const move = () => ({ clientX: 10, clientY: 10 }) as PointerEvent;
  const TARGET_FACE: FaceHit = { selector: { kind: "face" }, faceId: 7, anchor: {}, normal: {}, bodyId: "b2" };
  /** one of the operation's OWN faces — beginDrag above is holding faceId 3 */
  const OWN_FACE: FaceHit = { selector: { kind: "face" }, faceId: 3, anchor: {}, normal: {}, bodyId: "b1" };

  it("moving over a datum plane brightens it", () => {
    const h = harness({ face: null, datum: "dp" }, { realDrag: true });
    armT(h);

    h.t.onMove(move());

    expect(h.lit.datum, "the plane the click would bind was not lit").toBe("dp");
    expect(h.viewport.domElement.style.cursor).toBe("pointer");
  });

  it("moving over a target face highlights the face", () => {
    const h = harness({ face: TARGET_FACE, datum: null }, { realDrag: true });
    armT(h);

    h.t.onMove(move());

    expect(h.lit.face).toBe(7);
    expect(h.viewport.domElement.style.cursor).toBe("pointer");
  });

  it("a body in front of a plane lights the face and NOT the plane", () => {
    // BODY-FIRST, mirroring the click: an 80x80 quad behind the solid is not
    // what a click here would bind, so it must not look like it is.
    const h = harness({ face: TARGET_FACE, datum: "dp" }, { realDrag: true });
    armT(h);

    h.t.onMove(move());

    expect(h.lit.face).toBe(7);
    expect(h.lit.datum).toBeNull();
  });

  it("one of the operation's own faces lights nothing", () => {
    // onDown binds neither a face it is already extruding nor — because the
    // body was hit — the plane behind it. Nothing is targetable here.
    const h = harness({ face: OWN_FACE, datum: "dp" }, { realDrag: true });
    armT(h);

    h.t.onMove(move());

    expect(h.lit.face, "the operation's own face was lit as a target").toBeNull();
    expect(h.lit.datum).toBeNull();
    expect(h.viewport.domElement.style.cursor).toBe("default");
  });

  it("Escaping out of T mode puts the highlights out", () => {
    const h = harness({ face: null, datum: "dp" }, { realDrag: true });
    armT(h);
    h.t.onMove(move());
    expect(h.lit.datum).toBe("dp");

    h.t.onKey({ key: "Escape" } as KeyboardEvent);

    expect(h.lit.datum, "the plane stayed lit after T mode ended").toBeNull();
    expect(h.lit.face).toBeNull();
  });

  it("outside T mode a move over a plane lights nothing", () => {
    const h = harness({ face: null, datum: "dp" }, { realDrag: true });
    h.t.beginDrag([{ kind: "face" }], [3], { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, "b1");

    h.t.onMove(move());

    // the plain drag phase is not aiming at anything — a lit plane there would
    // promise an up-to the click does not make
    expect(h.lit.datum).toBeNull();
  });
});

// The Extrude half of field report 88c9bdf0 (T typed into the depth box instead
// of arming the target pick) did not bite here — press/pull's onKey has no input
// guard, so T always reached the tool. What DID leak is the letter: nothing on
// the path called preventDefault, so the "t" was typed into the box as well, and
// press/pull only got away with it because dim.hide() tears the box down a line
// later. These pin the arbitration now that it is explicit, and pin the other
// half of the rule: a letter aimed at a box the user is typing in is text.
describe("PressPullTool T while the depth box has focus", () => {
  /** A keystroke delivered to the open depth field. */
  function fieldKey(k: string, opts: { touched?: boolean } = {}) {
    const prevented = { count: 0 };
    const e = {
      key: k,
      target: new FakeField(!!opts.touched),
      preventDefault() {
        prevented.count++;
      },
    } as unknown as KeyboardEvent;
    return { e, prevented };
  }

  /** Report the box as open and focused, with DimInput's REAL arbitration —
   *  only "is this my own box" is faked. */
  function focusBox(h: ReturnType<typeof harness>) {
    const box = { hidden: false };
    const owner = { active: true, ownsTarget: () => true };
    h.t.dim = {
      isActive: true,
      show() {},
      seed() {},
      updateFromCursor() {},
      position() {},
      hide() {
        box.hidden = true;
      },
      claimToolHotkey: (e: KeyboardEvent) => DimInput.prototype.claimToolHotkey.call(owner, e),
    };
    return box;
  }

  const startDrag = (h: ReturnType<typeof harness>) =>
    h.t.beginDrag([{ kind: "face" }], [3], { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, "b1");
  const move = () => ({ clientX: 10, clientY: 10 }) as PointerEvent;

  it("T arms the target pick and does not reach the field", () => {
    const h = harness({ face: null, datum: "dp" }, { realDrag: true });
    startDrag(h);
    const box = focusBox(h);
    const { e, prevented } = fieldKey("t");

    h.t.onKey(e);

    // only T mode hit-tests a datum plane, so a lit plane IS the armed pick
    h.t.onMove(move());
    expect(h.lit.datum, "T did not arm the target pick").toBe("dp");
    expect(box.hidden, "the depth box survived, so Enter could still commit a distance").toBe(true);
    expect(prevented.count, "the letter was left to be typed into the box as well").toBe(1);
  });

  it("once a depth has been typed, T stays TEXT", () => {
    const h = harness({ face: null, datum: "dp" }, { realDrag: true });
    startDrag(h);
    focusBox(h);
    const { e, prevented } = fieldKey("t", { touched: true });

    h.t.onKey(e);

    h.t.onMove(move());
    expect(h.lit.datum, "T was stolen from a field the user was typing in").toBeNull();
    expect(prevented.count, "the keystroke was swallowed, so the letter never arrived").toBe(0);
  });
});
