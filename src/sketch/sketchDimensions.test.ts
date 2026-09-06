// A dimension badge sits ON the geometry it labels — a line's length badge
// lands at the line's midpoint, which is exactly where a user aims to
// right-click that line. The badge's pointerdown had no button guard, so a
// RIGHT press ran onOverlapPick (SketchMode.labelOverlapSelect), which replaces
// the whole selection with the one entity under the cursor. With two lines
// selected for a Parallel/Perpendicular constraint that ate the selection
// before the context menu was ever built.
//
// These run the real SketchDimensions against the fakeDom stub (no jsdom), so
// they observe the EFFECT a user would notice — did the selection hook fire,
// did the badge get marked selected — not that a guard exists in the source.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl, byClass, installFakeDocument } from "../ui/fakeDom.testkit";
import { SketchDimensions, dimBadgeFields } from "./sketchDimensions";
import { constraintDims } from "./entityDims";
import type { ResolvedEntity } from "./snap";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";

installFakeDocument();
// the badge reposition loop rides on rAF, which node has no notion of; the stub
// returns a handle and never re-enters, so show() runs exactly one pass
vi.stubGlobal("requestAnimationFrame", () => 1);
vi.stubGlobal("cancelAnimationFrame", () => {});

const viewport = {
  camera: new THREE.PerspectiveCamera(),
  projectToScreen: () => ({ x: 0, y: 0 }),
  projectToOverlay: () => ({ x: 0, y: 0, width: 900, height: 700 }),
} as unknown as Viewport;

const plane = {
  to3D: (x: number, y: number, out = new THREE.Vector3()) => out.set(x, y, 0),
} as unknown as SketchPlane;

/** A pointerdown as the browser delivers it, with the fields the handler reads. */
const press = (button: number, shiftKey = false) => ({
  button,
  shiftKey,
  clientX: 100,
  clientY: 100,
  pointerId: 1,
  stopPropagation: () => {},
  preventDefault: () => {},
});

const body = () => (globalThis as unknown as { document: { body: FakeEl } }).document.body;

describe("dimension badge: which mouse button acts", () => {
  let dims: SketchDimensions;
  let overlap: ReturnType<typeof vi.fn>;
  let badge: FakeEl;

  beforeEach(() => {
    body().innerHTML = "";
    dims = new SketchDimensions(viewport, () => {});
    overlap = vi.fn(() => true); // "geometry under the cursor claimed the pick"
    dims.onOverlapPick = overlap as unknown as (e: PointerEvent) => boolean;
    dims.show([], plane, [{ anchor: new THREE.Vector2(0, 0), valueMm: 10, commit: () => {} }]);
    const found = byClass(body(), "sketch-dim");
    expect(found).toHaveLength(1);
    badge = found[0]!;
  });

  it("ignores a right press, so the selection survives to the context menu", () => {
    badge.dispatch("pointerdown", press(2));
    expect(overlap).not.toHaveBeenCalled();
    expect(badge.classList.contains("is-selected")).toBe(false);
  });

  it("ignores a middle press (it belongs to camera pan)", () => {
    badge.dispatch("pointerdown", press(1));
    expect(overlap).not.toHaveBeenCalled();
  });

  it("still acts on a left press", () => {
    badge.dispatch("pointerdown", press(0));
    expect(overlap).toHaveBeenCalledTimes(1);
  });

  it("still forwards Shift+left, which toggles membership", () => {
    badge.dispatch("pointerdown", press(0, true));
    expect(overlap).toHaveBeenCalledTimes(1);
    expect((overlap.mock.calls[0]![0] as { shiftKey: boolean }).shiftKey).toBe(true);
  });

  it("marks the badge selected on a left press that geometry did not claim", () => {
    overlap.mockReturnValue(false);
    badge.dispatch("pointerdown", press(0));
    expect(badge.classList.contains("is-selected")).toBe(true);
  });

  it("opens the badge's own menu on the right-click that follows", () => {
    // the guard returns early, so the contextmenu listener registered after it
    // must still be wired — a right press then a right-click is one gesture
    const menu = vi.fn();
    dims.onLabelMenu = menu;
    badge.dispatch("pointerdown", press(2));
    badge.dispatch("contextmenu", { preventDefault: () => {}, stopPropagation: () => {} });
    expect(menu).toHaveBeenCalledTimes(1);
    expect(byClass(body(), "sketch-dim")).toHaveLength(1);
  });
});

// Report ad6f8d54: "Trying to delete a dimension in a sketch... nothing
// happens." A line's driving length and a circle's driving diameter render
// through the ENTITY's own badge (constraintDims deliberately skips them), and
// that badge carried no onDelete at all — the right-click menu offered "Delete
// dimension" DISABLED and the Delete key fell through to entity deletion. And a
// left-click opens the inline editor and focuses it, so the Delete a user
// presses next was swallowed as text editing.
describe("an entity badge backed by a driving constraint", () => {
  const line = { type: "line", id: "L", x1: 0, y1: 0, x2: 40, y2: 0 } as unknown as Parameters<
    SketchDimensions["show"]
  >[0][number];

  /** the badge SketchDimensions built for the line's length */
  const badgeOf = () => {
    const root = body().children[0]!;
    const el = root.children[0];
    if (!el) throw new Error("no badge");
    return el;
  };

  /** a live "constraint array" the host resolves the badge against, exactly as
   *  SketchMode.entityDimConstraint does */
  function mount(governed: boolean) {
    body().innerHTML = "";
    const cons = governed ? [{ type: "distance", line: "L", value: 40 }] : [];
    const dims = new SketchDimensions(viewport, () => {});
    const menu = vi.fn();
    dims.onLabelMenu = menu;
    dims.onEntityConstraint = () => (cons.length ? () => { cons.length = 0; } : "free");
    dims.show([line], plane, []);
    return { dims, cons, menu };
  }

  it("offers an ENABLED delete that removes the constraint", () => {
    const { cons, menu } = mount(true);
    badgeOf().dispatch("contextmenu", { preventDefault: () => {}, stopPropagation: () => {} });
    expect(menu).toHaveBeenCalledTimes(1);
    const del = (menu.mock.calls[0]![1] as { del: (() => void) | null }).del;
    expect(del).toBeTruthy();
    del!();
    expect(cons).toHaveLength(0);
  });

  it("the Delete key removes the badge the user right-clicked", () => {
    const { dims, cons } = mount(true);
    badgeOf().dispatch("contextmenu", { preventDefault: () => {}, stopPropagation: () => {} });
    expect(dims.deleteSelected()).toBe(true);
    expect(cons).toHaveLength(0);
  });

  it("Delete in the just-opened editor deletes the DIMENSION, not the text", () => {
    const { cons } = mount(true);
    const badge = badgeOf();
    badge.dispatch("pointerdown", press(0));
    badge.dispatch("click", { stopPropagation: () => {} });
    const input = badge.querySelector("input");
    expect(input).toBeTruthy();
    input!.dispatch("keydown", { key: "Delete", stopPropagation: () => {}, preventDefault: () => {} });
    expect(cons).toHaveLength(0);
  });

  it("once the user has typed, Delete is text editing again", () => {
    const { cons } = mount(true);
    const badge = badgeOf();
    badge.dispatch("pointerdown", press(0));
    badge.dispatch("click", { stopPropagation: () => {} });
    const input = badge.querySelector("input")!;
    input.value = "4";
    input.dispatch("input");
    input.dispatch("keydown", { key: "Delete", stopPropagation: () => {}, preventDefault: () => {} });
    expect(cons).toHaveLength(1);
  });

  it("an ungoverned length badge reads as a measurement and offers nothing to delete", () => {
    const { menu } = mount(false);
    const badge = badgeOf();
    expect(badge.className).toContain("sketch-dim-measured");
    badge.dispatch("contextmenu", { preventDefault: () => {}, stopPropagation: () => {} });
    expect((menu.mock.calls[0]![1] as { del: unknown }).del).toBeNull();
  });

  it("a governed badge keeps the plain driving-dimension styling", () => {
    mount(true);
    expect(badgeOf().className).toBe("sketch-dim");
  });

  // The editor opens with the whole value SELECTED, which is the only reason
  // Delete there can mean "delete the dimension": the key would have wiped the
  // text anyway. A user who clicks into the open editor to place a caret and
  // presses Backspace means the character before it — deleting their whole
  // dimension instead destroys work (undoable, but a surprise nobody asked for).
  it("Backspace after clicking a caret into the editor edits the TEXT", () => {
    const { cons } = mount(true);
    const badge = badgeOf();
    badge.dispatch("pointerdown", press(0));
    badge.dispatch("click", { stopPropagation: () => {} });
    const input = badge.querySelector("input")!;
    expect(input.selectionEnd).toBe(input.value.length); // as the editor opened it
    input.selectionStart = 2; // the user clicked between the digits
    input.selectionEnd = 2;
    input.dispatch("keydown", { key: "Backspace", stopPropagation: () => {}, preventDefault: () => {} });
    expect(cons).toHaveLength(1);
  });

  it("Delete after clicking a caret into the editor edits the TEXT", () => {
    const { cons } = mount(true);
    const badge = badgeOf();
    badge.dispatch("pointerdown", press(0));
    badge.dispatch("click", { stopPropagation: () => {} });
    const input = badge.querySelector("input")!;
    input.selectionStart = 0;
    input.selectionEnd = 0;
    input.dispatch("keydown", { key: "Delete", stopPropagation: () => {}, preventDefault: () => {} });
    expect(cons).toHaveLength(1);
  });
});

// Report dff87040: "I don't have any obvious way to constrain a dimension."
// A measured badge now offers Lock on its right-click menu, and a driving one
// offers the inverse. These observe the CONSTRAINT LIST afterwards, not that a
// callback fired.
describe("locking and unlocking a dimension from the badge menu", () => {
  const rect = { type: "rectangle", id: "R", x: 0, y: 0, width: 100, height: 50 } as unknown as Parameters<
    SketchDimensions["show"]
  >[0][number];

  const rightClick = (el: FakeEl) =>
    el.dispatch("contextmenu", { preventDefault: () => {}, stopPropagation: () => {} });
  const actionsFrom = (menu: ReturnType<typeof vi.fn>) =>
    menu.mock.calls[0]![1] as { del: (() => void) | null; lock: (() => void) | null; unlock: (() => void) | null };
  /** every rendered badge, in order — byClass matches the class list EXACTLY,
   *  and a measured/driven badge carries a second class */
  const badges = () => body().children[0]!.children;

  /** a rectangle whose width badge nothing governs — the reporter's case */
  function mountRect(governed: boolean) {
    body().innerHTML = "";
    const cons: { type: string; line?: string; value?: number }[] = governed
      ? [{ type: "distance", line: "R~0", value: 100 }]
      : [];
    const dims = new SketchDimensions(viewport, () => {});
    const menu = vi.fn();
    dims.onLabelMenu = menu;
    dims.onEntityConstraint = (_i, f) =>
      f === "width" && cons.length ? () => { cons.length = 0; } : "free";
    dims.onEntityLock = (_i, f) =>
      f === "width" && !cons.length ? () => { cons.push({ type: "distance", line: "R~0", value: 100 }); } : null;
    dims.show([rect], plane, []);
    return { cons, menu, badge: badges()[0]! }; // width comes first
  }

  it("a rectangle's width badge no longer claims to be a driving dimension", () => {
    const { badge } = mountRect(false);
    expect(badge.className).toContain("sketch-dim-measured");
  });

  it("Lock on that badge creates the constraint that holds the width", () => {
    const { cons, menu, badge } = mountRect(false);
    rightClick(badge);
    const a = actionsFrom(menu);
    expect(a.del).toBeNull(); // nothing to delete yet
    expect(a.lock).toBeTruthy();
    a.lock!();
    expect(cons).toEqual([{ type: "distance", line: "R~0", value: 100 }]);
  });

  it("once locked, the badge reads as driving and offers Delete instead of Lock", () => {
    const { cons, menu, badge } = mountRect(true);
    expect(badge.className).toBe("sketch-dim");
    rightClick(badge);
    const a = actionsFrom(menu);
    expect(a.lock).toBeNull();
    expect(a.del).toBeTruthy();
    a.del!();
    expect(cons).toHaveLength(0);
  });

  /** a placed (constraint-backed) dim, driven or driving */
  function mountPlaced(driven: boolean) {
    body().innerHTML = "";
    const state = { driven };
    const dims = new SketchDimensions(viewport, () => {});
    const menu = vi.fn();
    dims.onLabelMenu = menu;
    dims.show([], plane, [
      {
        anchor: new THREE.Vector2(0, 0),
        valueMm: 100,
        commit: () => {},
        ...(driven ? { driven: true } : {}),
        onDelete: () => {},
        ...(driven
          ? { onLock: () => { state.driven = false; } }
          : { onUnlock: () => { state.driven = true; } }),
      },
    ]);
    return { state, menu, badge: badges()[0]! };
  }

  it("a reference dim offers Lock, and locking makes it drive", () => {
    const { state, menu, badge } = mountPlaced(true);
    expect(badge.className).toContain("sketch-dim-driven");
    rightClick(badge);
    const a = actionsFrom(menu);
    expect(a.unlock).toBeNull();
    a.lock!();
    expect(state.driven).toBe(false);
  });

  it("a driving placed dim offers Unlock, which makes it a reference again", () => {
    const { state, menu, badge } = mountPlaced(false);
    rightClick(badge);
    const a = actionsFrom(menu);
    expect(a.lock).toBeNull();
    a.unlock!();
    expect(state.driven).toBe(true);
  });
});

// A SIGNED dimension: the smart tool's horizontal/vertical distances (DX/DY).
// types.ts makes the operand order the sign — value is e2 - e1 along the axis —
// so a badge really reads "-30 mm" when the second point sits left of the first,
// and dimensionTool.p2pPlan states the contract that goes with it: "typing a
// negative value moves it to the other side rather than being silently
// absolutised."
//
// The editor gate only ever accepted a positive length, so the badge showed a
// number the user could not type back: "-30" was rejected and silently reverted
// to the old value, and the unsigned "30" typed instead wrote +30 and moved the
// point to the mirrored side — a 60 mm jump from an edit that looked like a
// no-op. Unreachable before DX/DY badges existed at all, which is why it ships
// with them.
describe("a signed distance badge (DX/DY)", () => {
  /** one extra dim, the way SketchMode feeds constraintDims' output through */
  const mountExtra = (valueMm: number, signed: boolean) => {
    body().innerHTML = "";
    const dims = new SketchDimensions(viewport, () => {});
    const committed: number[] = [];
    dims.show([], plane, [
      {
        anchor: new THREE.Vector2(0, 0),
        valueMm,
        commit: (v) => committed.push(v),
        ...(signed ? { signed: true } : {}),
      },
    ]);
    const badge = byClass(body(), "sketch-dim")[0]!;
    return { badge, committed };
  };

  const openEditor = (badge: FakeEl) => {
    badge.dispatch("pointerdown", press(0));
    badge.dispatch("click", { stopPropagation: () => {} });
    return badge.querySelector("input")!;
  };
  const enter = (input: FakeEl, text: string) => {
    input.value = text;
    input.dispatch("input");
    input.dispatch("keydown", { key: "Enter", stopPropagation: () => {}, preventDefault: () => {} });
  };

  it("opens on the value it displays, and takes that same value back", () => {
    const { badge, committed } = mountExtra(-30, true);
    const input = openEditor(badge);
    expect(input.value).toBe("-30"); // what the badge reads
    enter(input, "-30");
    expect(committed).toEqual([-30]);
  });

  it("takes the OTHER sign too — that is how a point moves to the other side", () => {
    const { badge, committed } = mountExtra(-30, true);
    enter(openEditor(badge), "30");
    expect(committed).toEqual([30]);
  });

  it("still refuses zero, which would collapse the badge out of existence", () => {
    // constraintDims drops a dim whose two anchors coincide (meas < 1e-6), so a
    // committed 0 would leave a dimension with no badge — invisible, and back
    // to being undeletable, which is the whole bug this cluster is about.
    const { badge, committed } = mountExtra(-30, true);
    enter(openEditor(badge), "0");
    expect(committed).toEqual([]);
  });

  it("refuses nonsense, as any dim does", () => {
    const { badge, committed } = mountExtra(-30, true);
    enter(openEditor(badge), "left a bit");
    expect(committed).toEqual([]);
  });

  it("an ordinary length badge still refuses a negative", () => {
    const { badge, committed } = mountExtra(40, false);
    enter(openEditor(badge), "-40");
    expect(committed).toEqual([]);
  });

  // The two halves joined: a real p2pDistanceX constraint, through the real
  // constraintDims and the real badge-field mapping SketchMode spreads, must
  // produce a badge that takes its own reading back. Without this the sign
  // could reach the READOUT and still not reach the editor, which is precisely
  // how it shipped the first time.
  it("a real leftward DX constraint round-trips the value it displays", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "a", x1: 0, y1: 0, x2: 0, y2: 0 },
      { type: "line", id: "b", x1: -30, y1: 0, x2: -30, y2: 0 },
    ];
    const cd = constraintDims(ents, [
      { type: "p2pDistanceX", e1: "a", p1: 0, e2: "b", p2: 0, value: -30 },
    ])[0]!;
    body().innerHTML = "";
    const dims = new SketchDimensions(viewport, () => {});
    const committed: number[] = [];
    dims.show([], plane, [{ ...dimBadgeFields(cd), commit: (v) => committed.push(v) }]);
    const badge = byClass(body(), "sketch-dim")[0]!;
    const input = openEditor(badge);
    expect(input.value).toBe("-30");
    enter(input, "-30");
    expect(committed).toEqual([-30]);
  });
});
