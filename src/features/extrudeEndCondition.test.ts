// Extrude END CONDITIONS — "extrude up to that face / plane" (GitHub issue #41,
// field report ffab4ece).
//
// Two of these lock mistakes that were made and caught while writing the feature,
// which is why they are worth having rather than being restatements of the code:
//
//  1. `beginDrag` must NOT clear the target. The obvious place to reset a fresh
//     end condition is beginDrag — but startEdit CALLS beginDrag, and so does
//     onDown when the user re-states the area set. Resetting there means editing
//     the depth of an "up to" extrude silently turns it back into a blind one,
//     because commit writes what these fields hold and deletes what they don't.
//     Exactly the class this tool already guards for carried areas.
//
//  2. A T-mode click that hits NOTHING must not fall through to the
//     clean-click-commits path. Otherwise aiming at a target and missing fires a
//     stray plain commit — the audit finding that shaped press/pull's branch.

import { describe, expect, it, vi } from "vitest";
import { ExtrudeTool } from "./extrudeTool";
import { DEFAULT_EXTRUDE_DISTANCE } from "../document/numFields";

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

type Sel = { kind: string; by: string; point: [number, number, number] };

function harness(opts: { face?: Sel | null; datum?: string | null } = {}) {
  const overlay = {
    toggleRegionSelection: () => {},
    selectedRegions: () => [],
    setHoverRegion: () => {},
    regions: [],
  };
  /** What is currently LIT on screen, as the real hover calls would leave it. */
  const lit: { face: number | null; datum: string | null } = { face: null, datum: null };
  const viewport = {
    suspendPicking: false,
    domElement: {
      style: {} as { cursor?: string },
      addEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    },
    pickFaceForPressPull: () => (opts.face ? { selector: opts.face, faceId: 7, bodyId: "b1" } : null),
    pickDatumAt: () => opts.datum ?? null,
    projectToScreen: () => ({ x: 0, y: 0 }),
    // raycasts the same body meshes pickFaceForPressPull does, hence one `face`
    hoverFaceAt() {
      lit.face = opts.face ? 7 : null;
      return lit.face;
    },
    clearHover() {
      lit.face = null;
    },
    hoverDatum(id: string | null) {
      lit.datum = id;
    },
    requestRender() {},
  };
  const store = {};

  const tool = new ExtrudeTool(viewport as never, overlay as never, store as never);
  const t = tool as unknown as {
    active: boolean;
    phase: "pick" | "drag";
    editId: string | null;
    selected: unknown[];
    distance: number;
    upTo: Sel | null;
    upToPlane: string | null;
    pickingTarget: boolean;
    dim: unknown;
    onMove: (e: PointerEvent) => void;
    onDown: (e: PointerEvent) => void;
    onKey: (e: KeyboardEvent) => void;
    beginDrag: () => void;
    setUpTo: (target: Sel | string) => void;
    commit: () => Promise<void>;
    updatePreview: () => void;
    regionUnder: () => unknown;
  };

  const commit = vi.fn(async () => {});
  t.commit = commit;
  t.updatePreview = () => {};
  t.regionUnder = () => null;
  t.dim = { isActive: false, show() {}, seed() {}, hide() {}, updateFromCursor() {}, position() {} };
  t.active = true;
  t.phase = "drag";

  return { t, commit, lit, viewport };
}

const click = () =>
  ({
    button: 0,
    clientX: 10,
    clientY: 10,
    preventDefault() {},
    stopImmediatePropagation() {},
  }) as unknown as PointerEvent;

const key = (k: string) => ({ key: k, target: null }) as unknown as KeyboardEvent;
/** Shift held: what the keyboard actually delivers for Shift-T is key "T". */
const shiftKey = (k: string) => ({ key: k, target: null, shiftKey: true }) as unknown as KeyboardEvent;

const FACE: Sel = { kind: "face", by: "nearest", point: [0, 0, 10] };

describe("ExtrudeTool up-to target", () => {
  it("setUpTo is a one-way door: a plane target clears a face target", () => {
    const { t } = harness();
    t.setUpTo(FACE);
    expect(t.upTo).toEqual(FACE);
    expect(t.upToPlane).toBeNull();

    t.setUpTo("d1");
    expect(t.upToPlane).toBe("d1");
    // The sidecar REFUSES a feature carrying both rather than picking one, so
    // this is not tidiness — a stale upTo here is a feature that cannot build.
    expect(t.upTo).toBeNull();

    t.setUpTo(FACE);
    expect(t.upToPlane).toBeNull();
  });

  it("beginDrag KEEPS the target — startEdit routes through it", () => {
    const { t } = harness();
    t.editId = "ex1";
    t.setUpTo("d1");

    t.beginDrag();

    expect(t.upToPlane).toBe("d1");
  });

  it("beginDrag keeps a face target through an area re-state too", () => {
    const { t } = harness();
    t.editId = "ex1";
    t.setUpTo(FACE);

    t.beginDrag();

    expect(t.upTo).toEqual(FACE);
  });

  it("T arms target picking and hides the depth field", () => {
    const { t } = harness();
    let hidden = false;
    t.dim = { isActive: false, show() {}, seed() {}, hide: () => { hidden = true; }, updateFromCursor() {}, position() {} };

    t.onKey(key("t"));

    expect(t.pickingTarget).toBe(true);
    // Enter must not be able to commit a plain distance mid-pick.
    expect(hidden).toBe(true);
  });

  it("Escape out of target picking returns to the depth gesture, not a cancel", () => {
    const { t } = harness();
    t.onKey(key("t"));
    expect(t.pickingTarget).toBe(true);

    t.onKey(key("Escape"));

    expect(t.pickingTarget).toBe(false);
    expect(t.active).toBe(true); // still editing — Escape was consumed by the pick
  });

  it("a T-mode click on a FACE sets the target and commits", async () => {
    const { t, commit } = harness({ face: FACE });
    t.onKey(key("t"));

    t.onDown(click());

    expect(t.upTo).toEqual(FACE);
    expect(commit).toHaveBeenCalled();
  });

  it("a T-mode click that MISSES the body falls back to a datum", () => {
    const { t, commit } = harness({ face: null, datum: "d1" });
    t.onKey(key("t"));

    t.onDown(click());

    expect(t.upToPlane).toBe("d1");
    expect(commit).toHaveBeenCalled();
  });

  it("a body hit WINS over a datum under the same cursor", () => {
    // BODY-FIRST precedence, matching viewport.handleClick: a plane's 80x80 quad
    // floating in front of the solid must never steal a face pick.
    const { t } = harness({ face: FACE, datum: "d1" });
    t.onKey(key("t"));

    t.onDown(click());

    expect(t.upTo).toEqual(FACE);
    expect(t.upToPlane).toBeNull();
  });

  it("a T-mode click hitting NOTHING must not commit", () => {
    const { t, commit } = harness({ face: null, datum: null });
    t.onKey(key("t"));

    t.onDown(click());

    expect(commit).not.toHaveBeenCalled();
    expect(t.upTo).toBeNull();
    expect(t.upToPlane).toBeNull();
    expect(t.pickingTarget).toBe(true); // still waiting, not silently dropped
  });

  // GH #41: a target used to be a one-way door — `setUpTo` could only SET one,
  // so a saved "up to that face" extrude could never go back to a plain depth
  // (and taper, hidden while a target exists, stayed unreachable forever). The
  // inspector's row is the primary control; this is the tool's parity gesture.
  it("Shift-T clears a face target without cancelling the tool", () => {
    const { t } = harness();
    t.setUpTo(FACE);

    t.onKey(shiftKey("T"));

    expect(t.upTo, "the face target survived Shift-T").toBeNull();
    expect(t.upToPlane).toBeNull();
    expect(t.pickingTarget, "Shift-T armed a re-pick instead of clearing").toBe(false);
    expect(t.active, "Shift-T cancelled the whole extrude").toBe(true);
  });

  it("Shift-T clears a datum-plane target too", () => {
    const { t } = harness();
    t.setUpTo("d1");

    t.onKey(shiftKey("T"));

    expect(t.upToPlane, "the plane target survived Shift-T").toBeNull();
    expect(t.upTo).toBeNull();
  });

  it("Shift-T gives a target-only extrude a real depth to fall back on", () => {
    // An up-to extrude never read its distance, so it can legitimately sit at 0
    // — and a plain extrude of 0 is refused by the sidecar. Clearing the target
    // has to leave a depth that builds, not a red timeline chip.
    const { t } = harness();
    t.setUpTo("d1");
    t.distance = 0;

    t.onKey(shiftKey("T"));

    expect(t.distance, "the cleared extrude commits a zero depth").toBe(DEFAULT_EXTRUDE_DISTANCE);
  });

  it("plain T still arms picking, and Shift-T with nothing to clear is inert", () => {
    const { t } = harness();

    t.onKey(shiftKey("T"));
    expect(t.pickingTarget, "Shift-T armed a pick with no target set").toBe(false);

    t.onKey(key("t"));
    expect(t.pickingTarget).toBe(true);
  });

  it("T does nothing in the pick phase — there is no extrude to aim yet", () => {
    const { t } = harness();
    t.phase = "pick";

    t.onKey(key("t"));

    expect(t.pickingTarget).toBe(false);
  });
});

// The same gap press/pull was reported for (field report c0cfee48), verbatim in
// this tool: T armed the target pick and then nothing under the cursor lit up,
// so the mode was invisible until the click had already committed.
describe("ExtrudeTool up-to target hover", () => {
  const move = () => ({ clientX: 10, clientY: 10 }) as PointerEvent;

  it("moving over a datum plane in T mode brightens it", () => {
    const h = harness({ face: null, datum: "d1" });
    h.t.onKey(key("t"));

    h.t.onMove(move());

    expect(h.lit.datum, "the plane the click would bind was not lit").toBe("d1");
    expect(h.viewport.domElement.style.cursor).toBe("pointer");
  });

  it("moving over a target face highlights the face", () => {
    const h = harness({ face: FACE });
    h.t.onKey(key("t"));

    h.t.onMove(move());

    expect(h.lit.face).toBe(7);
  });

  it("a body in front of a plane lights the face and NOT the plane", () => {
    const h = harness({ face: FACE, datum: "d1" });
    h.t.onKey(key("t"));

    h.t.onMove(move());

    expect(h.lit.face).toBe(7);
    expect(h.lit.datum).toBeNull();
  });

  it("Escaping out of T mode puts the highlights out", () => {
    const h = harness({ face: null, datum: "d1" });
    h.t.onKey(key("t"));
    h.t.onMove(move());
    expect(h.lit.datum).toBe("d1");

    h.t.onKey(key("Escape"));

    expect(h.lit.datum, "the plane stayed lit after T mode ended").toBeNull();
    expect(h.lit.face).toBeNull();
  });

  it("outside T mode a move over a plane lights nothing", () => {
    const h = harness({ face: null, datum: "d1" });

    h.t.onMove(move());

    expect(h.lit.datum).toBeNull();
  });
});
