// Rectangles, polygons and slots are ONE entity each (types.ts), not lines, and
// four reports from the same weeks tripped over that from different tools:
//
//   5650b766  Fillet on a rectangle "highlights the rectangle surround in red and
//             does not give me a fillet radius input box. If I draw 4 separate
//             lines it works ok."
//   be869d55  A polygon's side count "does not update until after I click the
//             tick box", and fillet/chamfer on a polygon selects the outline.
//   a237de6b  "Chamfer, Fillet, Move, Rotate don't work properly on closed
//             shapes like rectangles or polygons."
//   ffae1a6e  "I cannot modify a polygons rotation after it has been created."
//
// Fillet and Chamfer take a side of a rectangle or polygon and turn that one
// shape into lines when the corner is made (explode.test.ts has the rest), a
// slot says it has no corner, and the hover lights only what a click takes; a
// typed side count previews as it is typed; a polygon's centre
// and corners and a slot's centres are snap targets, so Rotate can pivot on
// them; and a polygon's radius, sides and rotation can be edited after the fact.
//
// Everything is driven from where the user's input lands: pointerdown and
// pointermove on the canvas, keystrokes in the REAL on-canvas box (DimInput,
// rendered against the fake DOM), the right-click menu. A real SketchMode needs
// WebGL, so it is built off the prototype; what is stubbed is the viewport's
// screen<->plane mapping and rendering, never the logic under test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";

const { prompts, toasts, menus } = vi.hoisted(() => ({
  prompts: [] as (string | null)[],
  toasts: [] as string[],
  menus: [] as { label: string; onClick?: () => void }[][],
}));
vi.mock("../ui/prompt", () => ({ setPrompt: (m: string | null) => void prompts.push(m) }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));
vi.mock("../ui/menu", () => ({
  contextMenu: (_x: number, _y: number, items: { label: string; onClick?: () => void }[]) => void menus.push(items),
  dismissContextMenu: () => {},
}));

import { SketchMode } from "./sketchMode";
import { ConstraintTools } from "./constraintTools";
import { DimInput } from "./dimInput";
import { SketchPlane } from "./plane";
import { candidatesFromEntities, type ResolvedEntity } from "./snap";
import { fieldText } from "../ui/units";
import { t } from "../i18n";

// The box's inputs, and SketchMode's key handler, narrow with instanceof.
class FakeInput extends FakeEl {
  constructor() {
    super("input");
  }
}
const g = globalThis as unknown as Record<string, unknown>;
g.HTMLInputElement = FakeInput;
g.HTMLTextAreaElement = class {};
g.HTMLSelectElement = class {};
g.HTMLElement = FakeEl;
g.Node = FakeEl;
installFakeDocument();
(g.document as { createElement(tag: string): FakeEl }).createElement = (tag: string) =>
  tag === "input" ? new FakeInput() : new FakeEl(tag);
vi.stubGlobal("requestAnimationFrame", () => 0);

/** 10 screen px per sketch mm, so the 10 px snap radius is 1 mm and the 9 px
 *  pick tolerance 0.9 mm, the figures SketchMode uses at this zoom. */
const PX = 10;
const viewport = {
  screenToPlane: (cx: number, cy: number) => new THREE.Vector3(cx / PX, -cy / PX, 0),
  projectToScreen: (w: THREE.Vector3) => ({ x: w.x * PX, y: -w.y * PX }),
  // mm per pixel, for the size of a hovered point's marker
  pixelWorldSize: () => 1 / PX,
  domElement: { setPointerCapture() {}, releasePointerCapture() {} },
  // no imported scan in a sketch-gesture fixture: nothing to snap onto
  scanVertexAt: () => null,
};

type Ptr = { button: number; clientX: number; clientY: number; ctrlKey: boolean; shiftKey: boolean; pointerId: number; preventDefault(): void; stopPropagation(): void };
/** a primary press or move at sketch point (x, y) */
const at = (x: number, y: number, button = 0): Ptr => ({
  button, clientX: x * PX, clientY: -y * PX, ctrlKey: false, shiftKey: false, pointerId: 1,
  preventDefault() {}, stopPropagation() {},
});

interface Priv {
  onPointerDown(e: Ptr): void;
  onPointerMove(e: Ptr): void;
  onContextMenu(e: Ptr): void;
  onKey(e: unknown): void;
  endDrag(pointerId?: number): void;
  modifyHover(e: Ptr): void;
  entities: ResolvedEntity[];
  selected: Set<string>;
  filletFirst: number | null;
  pendingBindings: Map<string, { expr: string; kind: string; name?: string }>;
  dim: DimInput;
}

function makeMode(entities: ResolvedEntity[], tool: string, selected: string[] = []) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  const dim = new DimInput();
  const seen = { previews: [] as unknown[][], solves: 0, modified: 0 };
  Object.assign(s, {
    active: true, tool, entities, constraints: [], patterns: [], selected: new Set(selected), dim, pointCarry: {},
    plane: new SketchPlane("XY"), viewport, gridSnap: false, gridCell: 5,
    candidates: candidatesFromEntities(entities), // what refreshActive builds
    dims: { clearSelection() {} },
    overlay: { setPreview: (objs: unknown[]) => void seen.previews.push(objs), activeRegionAt: () => null },
    constraintTools: { heldOperandId: () => null },
    patternFlow: { hasPending: () => false },
    filletFirst: null, clickPts: [], polygonSides: 6, lastCursor: new THREE.Vector2(), lastPress: null,
    offsetPick: null, polygonEdit: null, moveDrag: null, dragFrom: null, boxSel: null, textBoxStart: null,
    rightDownAt: null, rightDragged: false, trial: null, pendingBindings: new Map(),
    pickTol: () => 0.9,
    derivedEntities: () => [],
    textEntityAt: () => null,
    showSnap: () => {},
    entityCurve: (e: ResolvedEntity) => e, // a preview reads back as the entity it draws
    refreshActive: () => {},
    requestSolve: () => { seen.solves++; },
    afterModify: () => { seen.modified++; },
    onState: () => {},
  });
  const priv = s as unknown as Priv;
  const box = () => (dim as unknown as { fields: { def: { name: string }; input: FakeInput }[] }).fields;
  const input = (name: string) => {
    const f = box().find((x) => x.def.name === name);
    if (!f) throw new Error(`no ${name} field in the box`);
    return f.input;
  };
  /** what typing does: the browser rewrites the text and fires `input` */
  const type = (name: string, text: string) => {
    const el = input(name);
    el.value = text;
    el.dispatch("input");
  };
  const enter = (name: string) =>
    input(name).dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
  const lastPreview = () => seen.previews[seen.previews.length - 1] ?? [];
  return { s: priv, dim, seen, box, input, type, enter, lastPreview };
}

const LINES = (): ResolvedEntity[] => [
  { type: "line", id: "a", x1: -40, y1: 0, x2: 0, y2: 0 },
  { type: "line", id: "b", x1: 0, y1: 0, x2: 0, y2: 40 },
];
const RECT: ResolvedEntity = { type: "rectangle", id: "r", x: 100, y: 0, width: 40, height: 20 };
const POLY: ResolvedEntity = { type: "polygon", id: "p", x: 3.3, y: 7.7, radius: 10, sides: 6, angle: 17 };
const SLOT: ResolvedEntity = { type: "slot", id: "s", x1: -100, y1: 0, x2: -60, y2: 0, width: 10 };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** the message a refused slot pick must show, built from the same key */
const slotRefusal = (tool: "fillet" | "chamfer") =>
  t("sketch.modify.slotNoCorner", { tool: tool === "chamfer" ? t("tool.chamfer") : t("tool.fillet") });

beforeEach(() => { prompts.length = 0; toasts.length = 0; menus.length = 0; });

describe("Fillet and Chamfer on a rectangle, polygon or slot", () => {
  it("the control: two separate lines open the radius box", () => {
    const { s, dim, box } = makeMode(LINES(), "fillet");
    s.onPointerDown(at(-20, 0));
    s.onPointerDown(at(0, 20));
    expect(dim.isActive).toBe(true);
    expect(box().map((f) => f.def.name)).toEqual(["radius"]);
    expect(toasts).toEqual([]);
  });

  it("takes two sides of a rectangle, and turns it into lines only when the fillet is made", () => {
    const ents = [...LINES(), clone(RECT)];
    const { s, dim, box, type, enter } = makeMode(ents, "fillet");
    s.onPointerDown(at(105, -10)); // the rectangle's bottom side
    s.onPointerDown(at(120, 2)); // its right side
    expect(toasts).toEqual([]);
    expect(dim.isActive, "two sides of one rectangle open the radius box").toBe(true);
    expect(box().map((f) => f.def.name)).toEqual(["radius"]);
    expect(s.entities.some((e) => e.type === "rectangle"), "nothing changes until the fillet is made").toBe(true);
    type("radius", "3");
    enter("radius");
    expect(s.entities.some((e) => e.type === "rectangle")).toBe(false);
    expect(s.entities.filter((e) => e.type === "line").length).toBe(2 + 4);
    expect(s.entities.filter((e) => e.type === "arc").length).toBe(1);
    expect(toasts).toEqual([t("sketch.modify.explodedForCorner", { shape: t("sketch.entity.rectangle"), tool: t("tool.fillet") })]);
  });

  it("a line and a rectangle side that never meet leave the rectangle a rectangle, and say so", () => {
    const ents = [...LINES(), clone(RECT)];
    const { s, dim, type, enter } = makeMode(ents, "fillet");
    const before = JSON.stringify(ents);
    s.onPointerDown(at(-20, 0)); // line a, horizontal
    s.onPointerDown(at(105, -10)); // the rectangle's bottom: parallel to it
    expect(dim.isActive).toBe(true);
    type("radius", "3");
    enter("radius");
    expect(JSON.stringify(s.entities), "no fillet, so no explode").toBe(before);
    // the size was typed, so silence would read as a broken tool
    expect(toasts).toEqual([t("sketch.modify.cornerNoFit", { tool: t("tool.fillet") })]);
  });

  it("Chamfer takes a polygon's side, and a slot says it has no corner", () => {
    const poly = makeMode([clone(POLY)], "chamfer");
    // the middle of the polygon's first side, well away from its corners
    const a = (17 * Math.PI) / 180, b = a + Math.PI / 3;
    poly.s.onPointerDown(at(3.3 + 5 * (Math.cos(a) + Math.cos(b)), 7.7 + 5 * (Math.sin(a) + Math.sin(b))));
    expect(toasts).toEqual([]);
    expect(poly.s.filletFirst, "the side is armed").toBe(0);

    const slot = makeMode([clone(SLOT)], "fillet");
    slot.s.onPointerDown(at(-80, 5)); // a straight side of the slot
    expect(toasts).toEqual([slotRefusal("fillet")]);
    expect(slot.s.filletFirst).toBeNull();
  });

  it("takes the line the hover lit when that line ends on a shape's corner", () => {
    // Lines drawn from a polygon's corner, AFTER the polygon. A click half a
    // millimetre along line a is inside the snap radius of the shared corner;
    // picked at the snapped corner, the tie went to the polygon (first in the
    // list) and the click blamed the polygon for a line the hover had lit.
    const ents: ResolvedEntity[] = [
      { type: "polygon", id: "p", x: 0, y: 0, radius: 10, sides: 6, angle: 0 },
      { type: "line", id: "a", x1: 10, y1: 0, x2: 40, y2: 0 },
      { type: "line", id: "b", x1: 10, y1: 0, x2: 10, y2: 30 },
    ];
    const { s, dim, lastPreview } = makeMode(ents, "fillet");
    s.modifyHover(at(10.5, 0));
    expect((lastPreview() as THREE.Object3D[]).map((o) => o.userData.entityId)).toEqual(["a"]);
    s.onPointerDown(at(10.5, 0));
    expect(toasts, "the hover lit a line; the click must not blame the polygon").toEqual([]);
    expect(s.filletFirst, "the click takes the line the hover lit").toBe(1);
    s.onPointerDown(at(10, 15)); // line b
    expect(dim.isActive).toBe(true);
  });
});

describe("the Fillet hover lights only what Fillet can take", () => {
  const lit = (objs: unknown[]) =>
    (objs as THREE.Object3D[]).map((o) => o.userData.entityId as string);

  it("lights the one rectangle side the click would take, not the outline", () => {
    const { s, lastPreview } = makeMode([...LINES(), clone(RECT)], "fillet");
    s.modifyHover(at(105, -10));
    expect(lit(lastPreview())).toEqual(["r~0"]);
  });

  it("lights nothing on a slot, which has no corner to take", () => {
    const { s, lastPreview } = makeMode([clone(SLOT)], "fillet");
    s.modifyHover(at(-80, 5));
    expect(lit(lastPreview())).toEqual([]);
  });

  it("still lights a line", () => {
    const { s, lastPreview } = makeMode([...LINES(), clone(RECT)], "chamfer");
    s.modifyHover(at(-20, 0));
    expect(lit(lastPreview())).toContain("a");
  });

  it("leaves Trim's highlight on the shape alone, because Trim does act on the shape", () => {
    // Trim lights the span of the side it would remove (trimSpan), so what is
    // lit is one of the rectangle's own edges ("r~k") rather than the whole
    // outline; either way it is the shape, never refused the way Fillet is.
    const { s, lastPreview } = makeMode([...LINES(), clone(RECT)], "trim");
    s.modifyHover(at(105, -10));
    const ids = lit(lastPreview());
    expect(ids.length, "Trim lit nothing on the rectangle").toBeGreaterThan(0);
    expect(ids.every((id) => id === "r" || id.startsWith("r~"))).toBe(true);
  });
});

describe("a typed polygon side count previews before the tick", () => {
  const sidesDrawn = (pv: unknown[]) => (pv[0] as { sides: number } | undefined)?.sides;

  it("redraws as the count is typed, without waiting for the mouse", () => {
    const { s, type, seen, lastPreview } = makeMode([], "polygon");
    s.onPointerDown(at(0, 0)); // centre: the box opens
    s.onPointerMove(at(10, 0)); // the rubber band, at the default 6
    expect(sidesDrawn(lastPreview())).toBe(6);
    const drawn = seen.previews.length;
    type("sides", "8");
    expect(seen.previews.length, "typing did not redraw the preview").toBeGreaterThan(drawn);
    expect(sidesDrawn(lastPreview())).toBe(8);
    s.onPointerMove(at(10, 1)); // and a later move keeps the typed count
    expect(sidesDrawn(lastPreview())).toBe(8);
  });

  it("keeps the last committed count while the typed one is not buildable", () => {
    const { s, type, lastPreview } = makeMode([], "polygon");
    s.onPointerDown(at(0, 0));
    s.onPointerMove(at(10, 0));
    type("sides", "2");
    expect(sidesDrawn(lastPreview())).toBe(6);
    type("sides", "100");
    expect(sidesDrawn(lastPreview())).toBe(6);
    type("sides", "");
    expect(sidesDrawn(lastPreview())).toBe(6);
  });

  it("builds the count it previewed", () => {
    const { s, type } = makeMode([], "polygon");
    s.onPointerDown(at(0, 0));
    s.onPointerMove(at(10, 0));
    type("sides", "8");
    s.onPointerDown(at(10, 0));
    const poly = s.entities.find((e) => e.type === "polygon") as { sides: number } | undefined;
    expect(poly?.sides).toBe(8);
  });
});

describe("Rotate pivots on a polygon's centre", () => {
  it("snaps the pivot click onto the centre, so the polygon turns in place", () => {
    const { s, type, enter } = makeMode([clone(POLY)], "rotate", ["p"]);
    // half a millimetre off the centre: inside the snap radius, far outside
    // any rounding, and off the grid
    s.onPointerDown(at(3.3 + 0.4, 7.7 - 0.3));
    type("angle", "30");
    enter("angle");
    const p = s.entities[0] as { x: number; y: number; angle: number };
    expect(p.x).toBeCloseTo(3.3, 9);
    expect(p.y).toBeCloseTo(7.7, 9);
    expect(p.angle).toBeCloseTo(47, 9);
  });

  it("snaps onto a corner, too, and the line's end is JOINED to it", () => {
    const { s } = makeMode([clone(POLY)], "line");
    const a = (17 * Math.PI) / 180;
    const corner = { x: 3.3 + 10 * Math.cos(a), y: 7.7 + 10 * Math.sin(a) };
    s.onPointerDown(at(corner.x + 0.3, corner.y + 0.3)); // a line starts here
    s.onPointerDown(at(40, 40));
    const line = s.entities.find((e) => e.type === "line") as { id: string; x1: number; y1: number } | undefined;
    expect(line?.x1).toBeCloseTo(corner.x, 9);
    expect(line?.y1).toBeCloseTo(corner.y, 9);
    // the corner is a point the solver has now (point 0), so the snap records
    // the join the way it does on a rectangle's corner
    expect((s as unknown as { constraints: unknown[] }).constraints)
      .toContainEqual({ type: "coincident", e1: "p", p1: 0, e2: line!.id, p2: 0 });
  });

  it("a centre rectangle drawn from a point joins its CENTRE to it", () => {
    const { s } = makeMode([{ type: "point", id: "q", x: 20, y: 10 }], "centerRectangle");
    s.onPointerDown(at(20.2, 10.3)); // the centre, snapped onto the point
    s.onPointerDown(at(35, 20)); // a corner, on nothing
    const rect = s.entities.find((e) => e.type === "rectangle") as { id: string; x: number; y: number } | undefined;
    expect([rect?.x, rect?.y]).toEqual([20, 10]);
    expect((s as unknown as { constraints: unknown[] }).constraints)
      .toEqual([{ type: "coincident", e1: "q", p1: 0, e2: rect!.id, p2: 4 }]);
  });
});

describe("a polygon's radius, sides and rotation stay editable after it is made", () => {
  /** the double-click: press, release, press again at the same spot */
  const doubleClick = (s: Priv, x: number, y: number) => {
    s.onPointerDown(at(x, y));
    s.endDrag(1);
    s.onPointerDown(at(x, y));
  };
  // the middle of POLY's first side
  const a = (17 * Math.PI) / 180, b = a + Math.PI / 3;
  const SIDE = { x: 3.3 + 5 * (Math.cos(a) + Math.cos(b)), y: 7.7 + 5 * (Math.sin(a) + Math.sin(b)) };

  it("double-click opens the box seeded with the polygon's own values", () => {
    const { s, dim, input } = makeMode([clone(POLY)], "select");
    doubleClick(s, SIDE.x, SIDE.y);
    expect(dim.isActive).toBe(true);
    // the first click took the side under it (GH #17); the double-click takes
    // the whole polygon, as it does a whole rectangle or slot
    expect([...s.selected]).toEqual([POLY.id]);
    expect(input("radius").value).toBe(fieldText(10, "length"));
    expect(input("sides").value).toBe(fieldText(6, "count"));
    expect(input("angle").value).toBe(fieldText(17, "angle"));
  });

  it("previews a typed rotation live, and Enter writes it and nothing else", () => {
    const { s, dim, type, enter, seen, lastPreview } = makeMode([clone(POLY)], "select");
    doubleClick(s, SIDE.x, SIDE.y);
    type("angle", "0");
    expect((lastPreview()[0] as { angle: number }).angle).toBe(0);
    expect((s.entities[0] as { angle: number }).angle, "the preview must not write").toBe(17);
    enter("angle");
    expect(s.entities[0]).toEqual({ ...POLY, angle: 0 });
    expect(seen.solves, "the edit must bank an undo step").toBe(1);
    expect(dim.isActive).toBe(false);
    expect(lastPreview()).toEqual([]);
  });

  it("keeps the typed preview while the pointer passes over the polygon's side and away", () => {
    // The Select hover lights the side under the pointer on the same layer
    // (GH #17's point-level selection): it must not draw over the box's preview.
    const { s, type, lastPreview } = makeMode([clone(POLY)], "select");
    Object.assign((s as unknown as { overlay: object }).overlay, { setHoverRegion() {} });
    doubleClick(s, SIDE.x, SIDE.y);
    type("angle", "0");
    s.onPointerMove(at(SIDE.x, SIDE.y));
    s.onPointerMove(at(SIDE.x + 30, SIDE.y + 30));
    expect(lastPreview()).toHaveLength(1);
    expect((lastPreview()[0] as { angle: number }).angle).toBe(0);
  });

  it("opened from the right-click menu, drops the side the hover had lit", () => {
    const { s, lastPreview } = makeMode([clone(POLY)], "select");
    Object.assign((s as unknown as { overlay: object }).overlay, { setHoverRegion() {} });
    s.onPointerMove(at(SIDE.x, SIDE.y));
    expect(lastPreview(), "the side under the pointer is lit").toHaveLength(1);
    s.onContextMenu(at(SIDE.x, SIDE.y, 2));
    const edit = menus[0]?.find((i) => i.label === t("sketch.menu.editPolygon"));
    expect(edit).toBeDefined();
    edit!.onClick!();
    expect(lastPreview()).toEqual([]);
  });

  it("is on the right-click menu of a lone polygon, and only there", () => {
    const { s, dim, type, enter } = makeMode([clone(POLY), ...LINES()], "select");
    s.onContextMenu(at(SIDE.x, SIDE.y, 2));
    const item = menus[0]?.find((i) => i.label === t("sketch.menu.editPolygon"));
    expect(item).toBeDefined();
    item?.onClick?.();
    expect(dim.isActive).toBe(true);
    type("sides", "8");
    type("radius", "12");
    enter("radius");
    expect(s.entities[0]).toEqual({ ...POLY, sides: 8, radius: 12 });

    menus.length = 0;
    s.selected = new Set(["p", "a"]);
    s.onContextMenu(at(SIDE.x, SIDE.y, 2));
    expect(menus[0]?.some((i) => i.label === t("sketch.menu.editPolygon"))).toBe(false);
  });

  it("refuses a side count it cannot build, and leaves the polygon and the box as they were", () => {
    const { s, dim, type, enter, seen } = makeMode([clone(POLY)], "select");
    doubleClick(s, SIDE.x, SIDE.y);
    type("angle", "45");
    type("sides", "2");
    enter("sides");
    expect(prompts).toContain(t("sketch.polygonEdit.badValue", { error: t("sketch.polygonEdit.sidesRange") }));
    expect(s.entities[0], "a refusal must not write the fields that WERE fine").toEqual(POLY);
    expect(seen.solves).toBe(0);
    expect(dim.isActive).toBe(true);
  });

  it("leaves a bound field's formula alone when another field is edited, and rewrites it when that field is", () => {
    const { s, type, enter, input } = makeMode([clone(POLY)], "select");
    const bound = { expr: "w/2", kind: "length" };
    s.pendingBindings.set("e:p:radius", bound);
    doubleClick(s, SIDE.x, SIDE.y);
    // a bound field reopens its formula, as the radius badge does: shown as
    // its number, the formula was invisible until a typed value replaced it
    expect(input("radius").value).toBe("w/2");
    expect(input("sides").value).toBe(fieldText(6, "count"));
    type("angle", "30");
    enter("angle");
    expect(s.pendingBindings.get("e:p:radius")).toBe(bound);
    expect((s.entities[0] as { radius: number }).radius).toBe(10);

    doubleClick(s, SIDE.x, SIDE.y);
    type("radius", "14");
    enter("radius");
    // a number typed over a bound field becomes the binding's literal; written
    // to the entity alone, the next parameter sync would put w/2 straight back
    expect(s.pendingBindings.get("e:p:radius")?.expr).toBe("14");
    expect((s.entities[0] as { radius: number }).radius).toBe(14);
  });

  it("reopens a formula bound in the DOCUMENT too, and an edit elsewhere leaves it bound", () => {
    const { s, type, enter, input } = makeMode([clone(POLY)], "select");
    // an existing sketch whose polygon's side count is driven by parameter n
    Object.assign(s, {
      editingId: "sk1",
      store: {
        boundExpr: (tg: { entity?: string; field?: string }) =>
          tg.entity === "p" && tg.field === "sides" ? { name: "p_sides", expr: "n", value: 6 } : null,
      },
    });
    doubleClick(s, SIDE.x, SIDE.y);
    expect(input("sides").value).toBe("n");
    expect(input("radius").value).toBe(fieldText(10, "length"));
    type("angle", "30");
    enter("angle");
    expect(s.entities[0]).toEqual({ ...POLY, angle: 30 });
    expect(s.pendingBindings.has("e:p:sides"), "an untouched formula is not rewritten").toBe(false);
  });

  it("Esc in the box puts everything back", () => {
    const { s, dim, type, input, lastPreview } = makeMode([clone(POLY)], "select");
    doubleClick(s, SIDE.x, SIDE.y);
    type("angle", "90");
    s.onKey({ key: "Escape", target: input("angle"), preventDefault() {} });
    expect(s.entities[0]).toEqual(POLY);
    expect(dim.isActive).toBe(false);
    expect(lastPreview()).toEqual([]);
  });
});

// A polygon or slot SIDE is something Coincident can put a point on (pointOn,
// `p~k` / `s~0|1`): the hover lights the side the click would take and nothing
// where the click would be refused, and a new side count re-aims a point put on
// a side, because side k of a hexagon is not side k of an octagon.
describe("Coincident and the sides of a polygon or slot", () => {
  const lit = (objs: unknown[]) =>
    (objs as THREE.Object3D[]).map((o) => o.userData.entityId as string);
  /** the hover asks the REAL ConstraintTools, the way SketchMode's does */
  const coincidentMode = (ents: ResolvedEntity[]) => {
    const m = makeMode(ents, "coincident");
    Object.assign(m.s, {
      constraintTools: new ConstraintTools({
        tool: () => "coincident",
        entities: () => m.s.entities,
        constraints: () => [],
        pickTol: () => 0.9,
        getFilletFirst: () => null,
        setFilletFirst() {},
        requestSolve() {},
        warn() {},
        setPendingPoints() {},
        addConstraint() {},
      }),
    });
    return m;
  };
  const deg = Math.PI / 180;
  /** the point `d` mm out from POLY's centre at `angle` degrees */
  const around = (angle: number, d: number) => ({
    x: 3.3 + d * Math.cos(angle * deg),
    y: 7.7 + d * Math.sin(angle * deg),
  });
  const SIDE0 = around(17 + 30, 10 * Math.cos(30 * deg)); // the middle of side 0
  const CORNER1 = around(17 + 60, 10);

  it("the hover lights the one side under the cursor, not the outline", () => {
    const { s, lastPreview } = coincidentMode([clone(POLY)]);
    s.modifyHover(at(SIDE0.x, SIDE0.y));
    expect(lit(lastPreview())).toEqual(["p~0"]);
  });

  it("and on a polygon's corner, the corner the click takes, painted over the side beside it", () => {
    const { s, lastPreview } = coincidentMode([clone(POLY)]);
    s.modifyHover(at(CORNER1.x, CORNER1.y));
    const ids = lit(lastPreview());
    expect(ids.length, `lit: ${ids.join(", ")}`).toBe(2);
    expect(["p~0", "p~1"]).toContain(ids[0]);
  });

  it("and nothing on a slot's round end, which it would refuse", () => {
    const { s, lastPreview } = coincidentMode([clone(SLOT)]);
    s.modifyHover(at(-80, 5)); // the middle of the straight side above the axis
    expect(lit(lastPreview())).toEqual(["s~0"]);
    s.modifyHover(at(-55, 0)); // the round end past (-60, 0)
    expect(lit(lastPreview())).toEqual([]);
  });

  // P sits on the middle of side 2 (at 167 degrees), Q on the middle of side 5
  // (at 347 degrees), each held there by a point-on
  const editSides = (sides: string) => {
    const mid = (k: number) => around(17 + 60 * k + 30, 10 * Math.cos(30 * deg));
    const P = mid(2), Q = mid(5);
    const { s, type, enter } = makeMode([
      clone(POLY),
      { type: "point", id: "P", x: P.x, y: P.y },
      { type: "point", id: "Q", x: Q.x, y: Q.y },
    ], "select");
    const cons = [
      { type: "pointOn", e: "P", p: 0, curve: "p~2" },
      { type: "pointOn", e: "Q", p: 0, curve: "p~5" },
    ];
    (s as unknown as { constraints: unknown[] }).constraints = cons;
    s.onContextMenu(at(SIDE0.x, SIDE0.y, 2));
    menus[0]?.find((i) => i.label === t("sketch.menu.editPolygon"))?.onClick?.();
    type("sides", sides);
    enter("sides");
    expect((s.entities[0] as { sides: number }).sides).toBe(Number(sides));
    return (s as unknown as { constraints: { curve: string }[] }).constraints.map((c) => c.curve);
  };

  it("more sides: each point-on moves to the side its point is on now", () => {
    // an octagon's side 3 spans 152..197 degrees and its side 7 spans 332..17;
    // the octagon's side 2 and side 5 are somewhere else entirely, and the
    // solve used to pull P and Q onto those sides' lines, off the polygon
    expect(editSides("8")).toEqual(["p~3", "p~7"]);
  });

  it("fewer sides: the same, so a side that is gone does not drop the point", () => {
    // a pentagon's side 2 spans 161..233 degrees and its side 4 spans 305..17
    expect(editSides("5")).toEqual(["p~2", "p~4"]);
  });
});
