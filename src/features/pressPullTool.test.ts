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

// DimInput's constructor and setPrompt are the only DOM these paths touch.
// Stubbed rather than pulling in jsdom, matching extrudeTool.test.ts. `window`
// is stubbed too because these tests drive the REAL start()/cleanup() pair
// rather than poking privates — the listener bookkeeping is part of what the
// handoff has to get right.
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
(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
};

type Entity = { kind: "edge"; edge: { id: string } } | { kind: "face"; faceId: number };
type Region = { sketchId: string; interior3D: { x: number; y: number } };
type FaceHit = { selector: unknown; faceId: number; anchor: unknown; normal: unknown; bodyId: string | null };

/** What is under the cursor. Any subset may be present at once — that is the
 *  whole point: the order the tool tests them IS the behaviour under test. */
interface World {
  entity?: Entity | null;
  region?: Region | null;
  face?: FaceHit | null;
}

function harness(world: World) {
  const handoffs: PressPullHandoff[] = [];
  const dragged: FaceHit[] = [];
  const onDone = vi.fn();

  const overlay = {
    committedRegionAtRay: () => world.region ?? null,
  };
  const viewport = {
    suspendPicking: false,
    domElement: { style: {}, addEventListener() {}, removeEventListener() {} },
    pickEntity: () => world.entity ?? null,
    rayFrom: () => ({ ray: {} }),
    pickFaceForPressPull: () => world.face ?? null,
    selectedFacesForPressPull: () => null, // no pre-selection: start() arms the pick phase
    clearPressPullGhost() {},
    clearHover() {},
  };
  const store = {};

  const tool = new PressPullTool(viewport as never, store as never, overlay as never);
  const t = tool as unknown as {
    active: boolean;
    phase: "pick" | "drag";
    onDown: (e: PointerEvent) => void;
    beginDrag: (...args: unknown[]) => void;
  };

  tool.start(onDone, (h) => handoffs.push(h));
  t.beginDrag = (sel, ids, anchor, normal, bodyId) =>
    dragged.push({ selector: sel, faceId: (ids as number[])[0]!, anchor, normal, bodyId } as FaceHit);

  return { tool, t, handoffs, dragged, onDone, viewport };
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
