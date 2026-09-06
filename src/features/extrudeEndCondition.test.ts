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
import { DimInput } from "../sketch/dimInput";
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
// cancel() tears the tool's listeners down; node has no window
(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
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
      removeEventListener() {},
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

// --- the same keys, aimed at the DEPTH BOX (field report 88c9bdf0) ---------
//
// Everything above presses keys with `target: null`, i.e. at the canvas — which
// is a state the tool is almost never in: beginDrag opens the dim box and
// focuses it (and re-asserts focus next frame), so from the moment the arrow
// appears the caret is in the D field and every keystroke is aimed there. The
// helpers below reproduce THAT, and the guard at the top of onKey is finally
// entered. No jsdom in this repo, so HTMLInputElement is stood up by hand.
class FakeField {
  constructor(private touched: boolean) {}
  getAttribute(name: string): string | null {
    // exactly what DimInput writes: "1" while the text is unchanged since focus
    return name === "data-undo-passthrough" ? (this.touched ? "0" : "1") : null;
  }
}
(globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement ??= FakeField;

/** A keystroke delivered to the depth field. `touched` = the user has already
 *  typed a value into it, so letters are text rather than hotkeys. */
function fieldKey(k: string, opts: { touched?: boolean; shift?: boolean } = {}) {
  const prevented = { count: 0 };
  const e = {
    key: k,
    shiftKey: !!opts.shift,
    target: new FakeField(!!opts.touched),
    preventDefault() {
      prevented.count++;
    },
  } as unknown as KeyboardEvent;
  return { e, prevented };
}

/** Swap in a dim stub that reports the box as OPEN AND FOCUSED. The
 *  arbitration itself is DimInput's real `claimToolHotkey` — only "is this my
 *  own box" is faked — so these cases pin the shipped rule, not a restatement
 *  of it. Returns what the tool did to the box. */
function focusBox(t: { dim: unknown }) {
  const box = { hidden: false };
  const owner = { active: true, ownsTarget: () => true };
  t.dim = {
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

// Field report 88c9bdf0: "pressing T types a T into the dimension box instead of
// arming the target pick". onKey opened with a blanket bail-out for any key
// aimed at an input while the box was up — Escape was the only key let through —
// and the box owns focus for the whole drag phase, so T and Shift-T were dead
// keys in practice. The reporter's document is the failure frozen: an offset
// datum plane built to extrude up to, and an extrude carrying a blind 18.037 mm
// distance and no target at all.
//
// The nine T cases above could not see any of it: they press with `target: null`
// and a dim stub reporting isActive false, so the guard is never entered.
describe("ExtrudeTool hotkeys while the depth box has focus", () => {
  it("T arms the target pick and does not reach the field", () => {
    const { t } = harness();
    const box = focusBox(t);
    const { e, prevented } = fieldKey("t");

    t.onKey(e);

    expect(t.pickingTarget, "T went to the text field instead of the tool").toBe(true);
    expect(box.hidden, "the depth box survived, so Enter could still commit a distance").toBe(true);
    expect(prevented.count, "the letter was left to be typed into the box as well").toBe(1);
  });

  it("Shift-T clears the target from inside the box too", () => {
    const { t } = harness();
    t.setUpTo(FACE);
    focusBox(t);
    const { e, prevented } = fieldKey("T", { shift: true });

    t.onKey(e);

    expect(t.upTo, "the face target survived Shift-T").toBeNull();
    expect(t.upToPlane).toBeNull();
    expect(t.pickingTarget, "Shift-T armed a re-pick instead of clearing").toBe(false);
    expect(prevented.count).toBe(1);
  });

  it("once a depth has been typed, T stays TEXT", () => {
    // The other half of the rule: a user part-way through "25" who reaches for
    // "t" is typing, not aiming. Letters are rejected by the numeric parse
    // anyway, so the cost of being wrong here is only a stray character.
    const { t } = harness();
    focusBox(t);
    const { e, prevented } = fieldKey("t", { touched: true });

    t.onKey(e);

    expect(t.pickingTarget, "T was stolen from a field the user was typing in").toBe(false);
    expect(prevented.count, "the keystroke was swallowed, so the letter never arrived").toBe(0);
  });

  it("Enter still belongs to the field, not to the tool", () => {
    // Only the tool's own letter is arbitrated. Enter commits the box and Tab
    // locks and advances; if onKey started competing for them, typing a depth
    // and pressing Enter would run the tool's pick-phase branch instead.
    const { t } = harness();
    t.phase = "pick";
    t.selected = [{}];
    focusBox(t);
    const { e } = fieldKey("Enter");

    t.onKey(e);

    expect(t.phase, "Enter in the box started the drag behind DimInput's back").toBe("pick");
  });

  it("Escape in the box still cancels the whole extrude", () => {
    const { t } = harness();
    focusBox(t);
    const { e } = fieldKey("Escape");

    t.onKey(e);

    expect(t.active).toBe(false);
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
