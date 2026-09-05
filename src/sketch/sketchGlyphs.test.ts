// A constraint glyph sits ON the geometry it constrains — the ∥ badge lands at
// the MIDPOINT of the line it names, the ⊙ badge on the shared endpoint — and
// the badge's "geometry beats label" hook (SketchMode.labelOverlapSelect) then
// hands that click to the entity underneath, selects it, and rebuilds the glyph
// layer out from under the badge. The click delete was therefore unreachable for
// every constraint whose badge lands on its own operand: report 59c5a7d7,
// "could not delete a parallel constraint, tried double clicking it".
//
// These drive the REAL SketchGlyphs over the fakeDom stub with the REAL
// pickEntity wired as the overlap hook, so they observe the EFFECT a user would
// notice — is the constraint gone from the document — rather than that a
// listener exists.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { FakeEl, byClass, installFakeDocument } from "../ui/fakeDom.testkit";
import { SketchGlyphs } from "./sketchGlyphs";
import { constraintGlyphs } from "./glyphs";
import { pickEntity } from "./modify";
import { compileAndSolve } from "./sketchSolve";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";

installFakeDocument();
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

const body = () => (globalThis as unknown as { document: { body: FakeEl } }).document.body;

/** The pick tolerance SketchMode feeds in: 9 px at the reporter's zoom. */
const TOL = 9 * 0.05;

/** A live glyph layer over `ents` + `cons`, wired the way SketchMode wires it:
 *  onDelete splices the constraint and REBUILDS (which destroys the badge), and
 *  onOverlapPick is a faithful copy of SketchMode.labelOverlapSelect — real
 *  pickEntity, and a rebuild when geometry claims the pick. */
function mount(ents: ResolvedEntity[], cons: SketchConstraint[]) {
  body().innerHTML = "";
  const glyphs = new SketchGlyphs(viewport);
  const state = { selected: "", menuFor: -1 };
  const redraw = () => glyphs.show(constraintGlyphs(ents, cons), plane, new Set(), new Set());
  glyphs.onDelete = (i) => { cons.splice(i, 1); redraw(); };
  glyphs.onOverlapPick = (e) => {
    const p = (e as unknown as { plane: THREE.Vector2 }).plane;
    const idx = pickEntity(ents, p, TOL);
    const ent = idx >= 0 ? ents[idx] : undefined;
    if (!ent) return false;
    state.selected = ent.id;
    redraw(); // refreshActive() → the badge is detached mid-gesture
    return true;
  };
  glyphs.onMenu = (_e, i) => { state.menuFor = i; glyphs.onDelete?.(i); };
  redraw();
  return { glyphs, state, badges: () => byClass(body(), "sketch-glyph") };
}

/** a mouse/pointer event as the handlers read it, carrying the sketch-plane
 *  point the badge sits at (the overlap hook converts screen→plane for real).
 *  `client` is the SCREEN position: the double-press detector reads it, so two
 *  presses that land far apart must not be read as one double-click. */
const evt = (at: THREE.Vector2, button = 0, client = { x: 0, y: 0 }) => ({
  button,
  clientX: client.x,
  clientY: client.y,
  plane: at,
  stopPropagation: () => {},
  preventDefault: () => {},
});

describe("report 59c5a7d7: a parallel glyph on its own line", () => {
  // the reporter's own geometry, lifted from his attached document: two lines
  // each held parallel to a rectangle EDGE, plus a point-to-line dimension.
  // (bug-reports/ is gitignored, so the numbers live here rather than a fixture.)
  const load = () => ({
    ents: [
      { type: "rectangle", id: "e1", x: 0, y: 0.0028419448963319383, width: 115.8277144353254, height: 68.7100973521085 },
      { type: "line", id: "e5", x1: -51.14769231494422, y1: 17.078464224740824, x2: -10.229663843610291, y2: 17.078464224740824 },
      { type: "line", id: "e7", x1: -56.67388223431796, y1: 10.330518902368029, x2: -56.67388223431796, y2: -29.352206827082245 },
    ] as ResolvedEntity[],
    cons: [
      { type: "parallel", l1: "e5", l2: "e1~2" },
      { type: "parallel", l1: "e7", l2: "e1~3" },
      { type: "p2lDistance", id: "c11", e: "e5", p: 0, line: "e1~0", value: 5 },
    ] as SketchConstraint[],
  });

  it("really does sit on the line it names (the precondition for the bug)", () => {
    const { ents, cons } = load();
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥");
    expect(g).toBeTruthy();
    expect(pickEntity(ents, g!.pos, TOL)).toBeGreaterThanOrEqual(0);
  });

  it("a left-click still belongs to the geometry underneath (unchanged)", () => {
    const { ents, cons } = load();
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥")!;
    const badge = m.badges()[0]!;
    badge.dispatch("pointerdown", evt(g.pos));
    badge.dispatch("click", evt(g.pos));
    expect(m.state.selected).toBe("e5");
    expect(cons.filter((c) => c.type === "parallel")).toHaveLength(2);
  });

  it("a right-click deletes it", () => {
    const { ents, cons } = load();
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥")!;
    const badge = m.badges()[0]!;
    badge.dispatch("pointerdown", evt(g.pos, 2));
    badge.dispatch("contextmenu", evt(g.pos, 2));
    expect(cons.some((c) => c.type === "parallel" && c.l1 === "e5")).toBe(false);
    expect(cons).toHaveLength(2);
  });

  it("a right press never hands the click to the geometry underneath", () => {
    const { ents, cons } = load();
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥")!;
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos, 2));
    expect(m.state.selected).toBe(""); // the badge survived to its own menu
  });

  it("a double-click deletes it — what the reporter tried", () => {
    const { ents, cons } = load();
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥")!;
    // a real double click: two press/click pairs. The first press hands the
    // click to the line underneath and REBUILDS, so the second press lands on a
    // different element — the badge cannot be the one remembering it happened.
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos));
    m.badges()[0]!.dispatch("click", evt(g.pos));
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos));
    expect(cons.some((c) => c.type === "parallel" && c.l1 === "e5")).toBe(false);
  });

  it("the click after a double-click delete does not delete a second constraint", () => {
    const { ents, cons } = load();
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥")!;
    const before = cons.length;
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos));
    m.badges()[0]!.dispatch("click", evt(g.pos));
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos));
    m.badges()[0]!.dispatch("click", evt(g.pos)); // the press's own trailing click
    expect(cons).toHaveLength(before - 1);
  });

  it("two presses on the same badge far apart on screen are not a double-click", () => {
    // The badge is one element wherever the camera is, so without the screen
    // distance guard a click here, a pan, and a click there would read as a
    // double-click and delete a constraint the user only ever single-clicked.
    const { ents, cons } = load();
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons).find((q) => q.label === "∥")!;
    const before = cons.length;
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos, 0, { x: 400, y: 120 }));
    m.badges()[0]!.dispatch("click", evt(g.pos, 0, { x: 400, y: 120 }));
    m.badges()[0]!.dispatch("pointerdown", evt(g.pos, 0, { x: 402, y: 300 }));
    expect(cons).toHaveLength(before);
  });
});

describe("the solver stops enforcing a deleted constraint", () => {
  const seed = (): ResolvedEntity[] => [
    { type: "line", id: "a", x1: 0, y1: 0, x2: 40, y2: 0 },
    { type: "line", id: "b", x1: 0, y1: 10, x2: 40, y2: 16 },
  ];
  const angleOf = (ents: ResolvedEntity[], id: string) => {
    const e = ents.find((q) => q.id === id);
    if (e?.type !== "line") throw new Error("line lost");
    return Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
  };

  it("the two lines stop being pulled parallel once the glyph deletes it", async () => {
    const ents = seed();
    const cons: SketchConstraint[] = [{ type: "parallel", l1: "a", l2: "b" }];
    const held = await compileAndSolve(seed(), cons);
    expect(held.ok).toBe(true);
    expect(angleOf(held.entities, "b")).toBeCloseTo(angleOf(held.entities, "a"), 6);

    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons)[0]!;
    const badge = m.badges()[0]!;
    badge.dispatch("pointerdown", evt(g.pos, 2));
    badge.dispatch("contextmenu", evt(g.pos, 2));
    expect(cons).toHaveLength(0);

    const free = await compileAndSolve(seed(), cons);
    expect(free.ok).toBe(true);
    expect(angleOf(free.entities, "b")).not.toBeCloseTo(angleOf(free.entities, "a"), 3);
  });
});

// The audit behind report efc5d3f3 ("check which constraints are missing the
// ability to be deleted"): every geometric constraint type, with real geometry
// under its badge, must still be removable.
describe("every geometric constraint is deletable with geometry under its badge", () => {
  const scene = (): ResolvedEntity[] => [
    { type: "line", id: "a", x1: 0, y1: 0, x2: 40, y2: 0 },
    { type: "line", id: "b", x1: 0, y1: 10, x2: 40, y2: 10 },
    { type: "circle", id: "c1", x: 10, y: -20, radius: 5 },
    { type: "circle", id: "c2", x: 30, y: -20, radius: 5 },
  ];
  const cases: [string, SketchConstraint][] = [
    ["horizontal", { type: "horizontal", line: "a" }],
    ["vertical", { type: "vertical", line: "a" }],
    ["parallel", { type: "parallel", l1: "a", l2: "b" }],
    ["perpendicular", { type: "perpendicular", l1: "a", l2: "b" }],
    ["collinear", { type: "collinear", l1: "a", l2: "b" }],
    ["equal", { type: "equal", l1: "a", l2: "b" }],
    ["equalRadius", { type: "equalRadius", a: "c1", b: "c2" }],
    ["tangent", { type: "tangent", line: "a", circle: "c1" }],
    ["tangent2", { type: "tangent2", a: "c1", b: "c2" }],
    ["coincident", { type: "coincident", e1: "a", p1: 1, e2: "b", p2: 0 }],
    ["concentric", { type: "concentric", c1: "c1", c2: "c2" }],
    ["midpoint", { type: "midpoint", e: "c1", p: 0, line: "a" }],
    ["symmetric", { type: "symmetric", e1: "a", p1: 0, e2: "b", p2: 0, line: "a" }],
    ["fix", { type: "fix", e: "a", p: 0 }],
  ];

  it.each(cases)("%s", (_name, c) => {
    const ents = scene();
    const cons: SketchConstraint[] = [c];
    const m = mount(ents, cons);
    const g = constraintGlyphs(ents, cons)[0];
    expect(g).toBeTruthy(); // a constraint with no badge is its own bug
    const badge = m.badges()[0]!;
    badge.dispatch("pointerdown", evt(g!.pos, 2));
    badge.dispatch("contextmenu", evt(g!.pos, 2));
    expect(cons).toHaveLength(0);
  });
});
