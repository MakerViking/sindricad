// Move, Copy, Rotate and Scale: choose, then the point (Paul's reports from
// 2026-10-03):
//
//   53f5fcbb  "If I click Rotate first, I can only select a single line ... I
//             cannot do a multiselect ... I cannot select / snap to any of the
//             points on the sketch, all I can highlight is lines. ... the
//             degrees of rotation dialogue appears ... nowhere near the
//             rotation point I have picked"
//   8e712fc0  Mirror works nicely: select first, then the tool.
//   b64e2805  "Scale has same issue as Rotate: cannot snap on sketch points"
//   269bfb81  "if a user has not selected an element then warn/alert them
//             immediately ... don't let them highlight something in red, and
//             then warn them"
//
// Driven from where the user's input lands: the tool being armed (setTool),
// pointerdown and pointermove on the canvas, Enter and Esc, and keystrokes in
// the REAL on-canvas box (DimInput, against the fake DOM). A real SketchMode
// needs WebGL, so it is built off the prototype; what is stubbed is the
// viewport's screen<->plane mapping and rendering, never the logic under test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";

const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));

import { SketchMode } from "./sketchMode";
import { DimInput } from "./dimInput";
import { SketchPlane } from "./plane";
import { originGeometry } from "./origin";
import { candidatesFromEntities, type ResolvedEntity, type SnapKind } from "./snap";
import { PROJECTED_FIXED_MSG } from "./modify";
import { EDGE_HOVER } from "../viewport/colors3d";
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

/** 10 screen px per sketch mm, so the 10 px snap radius is 1 mm. */
const PX = 10;
const viewport = {
  screenToPlane: (cx: number, cy: number) => new THREE.Vector3(cx / PX, -cy / PX, 0),
  projectToScreen: (w: THREE.Vector3) => ({ x: w.x * PX, y: -w.y * PX }),
  pixelWorldSize: () => 1 / PX,
  camera: {},
  domElement: { setPointerCapture() {}, releasePointerCapture() {} },
  hoverEntity() {},
};

type Ptr = { button: number; clientX: number; clientY: number; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; pointerId: number; preventDefault(): void; stopPropagation(): void };
/** a primary press or move at sketch point (x, y) */
const at = (x: number, y: number, mods: { shift?: boolean; ctrl?: boolean } = {}): Ptr => ({
  button: 0, clientX: x * PX, clientY: -y * PX, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, metaKey: false, pointerId: 1,
  preventDefault() {}, stopPropagation() {},
});

interface Priv {
  onPointerDown(e: Ptr): void;
  onPointerMove(e: Ptr): void;
  onKey(e: unknown): void;
  setTool(tool: string): void;
  entities: ResolvedEntity[];
  selected: Set<string>;
  choosingPromptKey: string | null;
  lastPress: unknown;
}

// Two lines, a circle and a rectangle, away from each other and the origin.
const SHAPES = (): ResolvedEntity[] => [
  { type: "line", id: "a", x1: 10, y1: 10, x2: 30, y2: 10 },
  { type: "line", id: "b", x1: 10, y1: 20, x2: 30, y2: 20 },
  { type: "circle", id: "c", x: 50, y: 50, radius: 5 },
  { type: "rectangle", id: "r", x: -40, y: 30, width: 20, height: 10 },
];

/** The rectangle's inside, standing in for the area region.ts finds there:
 *  what a click inside the shape lands on when it misses every curve. */
const inRectArea = (p: THREE.Vector2) => p.x > -50 && p.x < -30 && p.y > 25 && p.y < 35;

function makeMode(selected: string[] = [], extra: ResolvedEntity[] = [], areaSelected = false) {
  const entities = [...originGeometry(), ...SHAPES(), ...extra];
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  const dim = new DimInput();
  const seen = {
    previews: [] as THREE.Object3D[][], snaps: [] as (SnapKind | null)[], states: 0,
    /** what main.ts's onState puts in the prompt pill: the choosing prompt, or
     *  (null) the tool's own prompt, which is about the point */
    prompts: [] as (string | null)[],
  };
  const area = { region: "the rectangle's inside" };
  Object.assign(s, {
    active: true, tool: "select", entities, constraints: [], patterns: [], selected: new Set(selected), dim,
    pointCarry: {}, regionCarry: {}, plane: new SketchPlane("XY"), viewport, gridSnap: false, gridCell: 5,
    candidates: candidatesFromEntities(entities), // what refreshActive builds
    dims: { clearSelection() {}, setInteractive() {} },
    glyphs: { setInteractive() {} },
    textPanel: { hide() {} },
    projectPanel: { hide() {} },
    overlay: {
      setPreview: (objs: THREE.Object3D[]) => void seen.previews.push(objs),
      setSnap: (_w: unknown, kind?: SnapKind) => void seen.snaps.push(kind ?? null),
      setSnapScale() {},
      activeRegionAt: (p: THREE.Vector2) => (inRectArea(p) ? area : null),
      selectedActiveRegions: () => (areaSelected ? [area] : []),
      activeTextIdAt: () => null,
    },
    constraintTools: { heldOperandId: () => null, resetPending() {}, hasPending: () => false },
    patternFlow: { hasPending: () => false, flushPending() {} },
    filletFirst: null, clickPts: [], splinePts: [], lastCursor: new THREE.Vector2(), lastPress: null,
    offsetPick: null, polygonEdit: null, moveDrag: null, dragFrom: null, boxSel: null, textBoxStart: null,
    rightDownAt: null, rightDragged: false, trial: null, pendingBindings: new Map(), dimPicks: [],
    moveBase: null, transformPivot: null, pickingTargets: false,
    pickTol: () => 0.9,
    derivedEntities: () => [],
    refreshActive: () => {},
    requestSolve: () => {},
    afterModify: () => {},
    onState: () => { seen.states++; seen.prompts.push((s as unknown as Priv).choosingPromptKey); },
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
  const enterIn = (name: string) =>
    input(name).dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
  /** a key pressed over the canvas, not into a box */
  const key = (k: string) => priv.onKey({ key: k, target: null, preventDefault() {} });
  /** a fresh press each time, so two clicks never read as a double-click */
  const click = (x: number, y: number, mods: { shift?: boolean; ctrl?: boolean } = {}) => {
    priv.lastPress = null;
    priv.onPointerDown(at(x, y, mods));
  };
  const lastPreview = () => seen.previews[seen.previews.length - 1] ?? [];
  const prompt = () => seen.prompts[seen.prompts.length - 1];
  const boxAt = () => {
    const st = (dim as unknown as { root: { style: Record<string, string> } }).root.style;
    return { left: st.left, top: st.top };
  };
  const ent = (id: string) => priv.entities.find((e) => e.id === id) as unknown as Record<string, number>;
  return { s: priv, dim, seen, input, type, enterIn, key, click, lastPreview, prompt, boxAt, ent };
}

/** the entity ids and colours a preview draws */
const litIds = (objs: THREE.Object3D[]) => [...new Set(objs.map((o) => o.userData.entityId as string))];
function colours(objs: THREE.Object3D[]): number[] {
  const out = new Set<number>();
  for (const o of objs) {
    o.traverse((c) => {
      const m = (c as unknown as { material?: { color?: THREE.Color } }).material;
      if (m?.color) out.add(m.color.getHex());
    });
  }
  return [...out];
}

beforeEach(() => { toasts.length = 0; });

describe("armed with nothing selected, the tool says so at once and its clicks choose", () => {
  it.each([
    ["move", "sketch.transform.selectFirstMove", "sketch.prompt.moveChoose"],
    ["copy", "sketch.transform.selectFirstCopy", "sketch.prompt.copyChoose"],
    ["rotate", "sketch.transform.selectFirstRotate", "sketch.prompt.rotateChoose"],
    ["scale", "sketch.transform.selectFirstScale", "sketch.prompt.scaleChoose"],
  ])("%s says what to select before any click", (tool, toastKey, promptKey) => {
    const { s } = makeMode();
    s.setTool(tool);
    expect(toasts).toEqual([t(toastKey)]);
    expect(s.choosingPromptKey).toBe(promptKey);
  });

  it("a selection made first is used as it is, the way Mirror uses one", () => {
    const { s } = makeMode(["a", "b"]);
    s.setTool("rotate");
    expect(toasts).toEqual([]);
    expect(s.choosingPromptKey, "straight to the pivot: main.ts shows the tool's own prompt").toBeNull();
    expect([...s.selected]).toEqual(["a", "b"]);
  });

  it("lights what a click would select in the hover colour, never the modify red", () => {
    const { s, lastPreview } = makeMode();
    s.setTool("rotate");
    s.onPointerMove(at(20, 10.2)); // on line a
    expect(litIds(lastPreview())).toEqual(["a"]);
    expect(colours(lastPreview())).toEqual([EDGE_HOVER]);
    s.onPointerMove(at(5, -8)); // on nothing
    expect(lastPreview()).toEqual([]);
  });

  it("a click selects, Shift or Ctrl adds and drops, and nothing complains", () => {
    const { s, click } = makeMode();
    s.setTool("rotate");
    toasts.length = 0; // the arming toast
    click(20, 10.2);
    expect([...s.selected]).toEqual(["a"]);
    click(20, 20.2, { ctrl: true });
    expect([...s.selected].sort()).toEqual(["a", "b"]);
    click(55, 50, { shift: true }); // the circle's rim
    expect([...s.selected].sort()).toEqual(["a", "b", "c"]);
    click(20, 10.2, { shift: true }); // again: dropped
    expect([...s.selected].sort()).toEqual(["b", "c"]);
    expect(s.choosingPromptKey, "still choosing after a pick: Enter ends it").toBe("sketch.prompt.rotateChoose");
    expect(toasts).toEqual([]);
  });

  it("a plain click on another curve takes it alone, and says so when that lets several go", () => {
    const { s, click } = makeMode();
    s.setTool("rotate");
    click(20, 10.2);
    toasts.length = 0;
    click(55, 50); // the circle's rim: one chosen thing swapped for another, as Select does
    expect([...s.selected]).toEqual(["c"]);
    expect(toasts).toEqual([]);
    click(20, 20.2, { shift: true });
    click(-40, 25.2); // the middle of the rectangle's bottom: a midpoint selects, it is no pivot
    expect([...s.selected]).toEqual(["r"]);
    expect(toasts).toEqual([t("sketch.transform.choseOnlyThis")]);
  });

  it("the point to turn about, clicked before Enter, keeps what is chosen and says to press Enter", () => {
    const { s, click, lastPreview } = makeMode();
    s.setTool("rotate");
    click(20, 10.2);
    click(20, 20.2, { shift: true });
    click(55, 50, { shift: true });
    toasts.length = 0;
    // the rectangle's corner: it used to swap all three for the rectangle, unsaid
    s.onPointerMove(at(-30.1, 25.1));
    expect(lastPreview(), "not lit: a plain click there would not choose it").toEqual([]);
    click(-30.1, 25.1);
    expect([...s.selected].sort()).toEqual(["a", "b", "c"]);
    // a's own end: it used to leave the choice as it was, unsaid
    click(10.1, 10.1);
    expect([...s.selected].sort()).toEqual(["a", "b", "c"]);
    expect(toasts).toEqual([t("sketch.transform.pressEnter"), t("sketch.transform.pressEnter")]);
    // Shift says "add": the corner's rectangle is chosen
    s.onPointerMove(at(-30.1, 25.1, { shift: true }));
    expect(litIds(lastPreview())).toEqual(["r"]);
    click(-30.1, 25.1, { shift: true });
    expect([...s.selected].sort()).toEqual(["a", "b", "c", "r"]);
  });

  it("a plain click on the one thing chosen says to press Enter, rather than nothing", () => {
    const { s, click } = makeMode();
    s.setTool("scale");
    click(20, 10.2);
    toasts.length = 0;
    click(22, 9.9);
    expect([...s.selected]).toEqual(["a"]);
    expect(toasts).toEqual([t("sketch.transform.pressEnter")]);
  });

  it("an area selected inside a shape is not called nothing, and a click inside one says to click its curves", () => {
    const armed = makeMode([], [], true);
    armed.s.setTool("rotate");
    expect(toasts, "the filled area is on screen: 'nothing is selected' would be false").toEqual([t("sketch.transform.areaNotCurves")]);
    expect(armed.s.choosingPromptKey).toBe("sketch.prompt.rotateChoose");

    const { s, click } = makeMode();
    s.setTool("move");
    toasts.length = 0;
    click(-45, 32); // inside the rectangle, on none of its sides
    expect([...s.selected]).toEqual([]);
    expect(toasts).toEqual([t("sketch.transform.areaNotCurves")]);
    click(20, 10.2);
    toasts.length = 0;
    click(-45, 32, { shift: true }); // adding the shape
    expect(toasts).toEqual([t("sketch.transform.areaNotCurves")]);
    toasts.length = 0;
    click(-45, 32); // a plain click there, with something chosen, is a free pivot point
    expect(toasts).toEqual([t("sketch.transform.pressEnter")]);
    expect([...s.selected]).toEqual(["a"]);
  });

  it("an origin axis is never chosen, and a click on nothing says to press Enter", () => {
    const { s, click } = makeMode();
    s.setTool("move");
    click(20, 10.2);
    toasts.length = 0;
    click(70, 0.1); // on the X axis, far from anything drawn
    expect([...s.selected]).toEqual(["a"]);
    expect(toasts).toEqual([t("sketch.transform.pressEnter")]);
  });

  it("projected geometry is refused when it is clicked, not after the move", () => {
    const projected = {
      type: "projected", id: "pj",
      source: { kind: "edge", body: "body1", sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
      curve: { kind: "line", x1: 10, y1: -20, x2: 30, y2: -20 },
    } as unknown as ResolvedEntity;
    const { s, click, lastPreview } = makeMode([], [projected]);
    s.setTool("rotate");
    toasts.length = 0;
    s.onPointerMove(at(20, -20.1));
    expect(lastPreview(), "not lit: the click would not take it").toEqual([]);
    click(20, -20.1);
    expect([...s.selected]).toEqual([]);
    expect(toasts).toEqual([PROJECTED_FIXED_MSG]);
  });

  it("Enter with nothing chosen says what to select again, and stays choosing", () => {
    const { s, key } = makeMode();
    s.setTool("scale");
    toasts.length = 0;
    key("Enter");
    expect(toasts).toEqual([t("sketch.transform.selectFirstScale")]);
    expect(s.choosingPromptKey).toBe("sketch.prompt.scaleChoose");
  });
});

describe("after Enter, the point snaps like a drawing click and the box opens beside it", () => {
  /** armed with nothing, a and b chosen, Enter */
  const chooseLines = (tool: string) => {
    const m = makeMode();
    m.s.setTool(tool);
    m.click(20, 10.2);
    m.click(20, 20.2, { ctrl: true });
    m.key("Enter");
    toasts.length = 0;
    return m;
  };

  it("Enter moves on to the point, and the hover shows the snap marker on points, not lit curves", () => {
    const { s, seen, lastPreview } = chooseLines("rotate");
    expect(s.choosingPromptKey).toBeNull();
    expect([...s.selected].sort()).toEqual(["a", "b"]);
    const hover = (x: number, y: number) => {
      s.onPointerMove(at(x, y));
      return { snap: seen.snaps[seen.snaps.length - 1], lit: lastPreview() };
    };
    // an endpoint, a circle centre, a rectangle corner, the origin
    expect(hover(10.3, 9.8)).toEqual({ snap: "endpoint", lit: [] });
    expect(hover(50.4, 49.7)).toEqual({ snap: "center", lit: [] });
    expect(hover(-30.2, 25.3)).toEqual({ snap: "endpoint", lit: [] });
    expect(hover(0.3, -0.2)).toEqual({ snap: "endpoint", lit: [] });
    // on a line, away from its points: no curve lit (the old hover lit it red)
    expect(hover(20, 10.2).lit).toEqual([]);
  });

  it("the prompt pill follows the step: what to select, then the point, then what to select again", () => {
    const { s, click, key, prompt } = makeMode();
    s.setTool("rotate");
    expect(prompt()).toBe("sketch.prompt.rotateChoose");
    click(20, 10.2);
    click(20, 20.2, { ctrl: true });
    key("Enter");
    expect(prompt(), "Enter: the pill moves on to the point").toBeNull();
    key("Escape");
    expect([...s.selected]).toEqual([]);
    expect(prompt(), "Esc cleared the selection: back to what to select").toBe("sketch.prompt.rotateChoose");
  });

  it("an arc's centre is a pivot, as it is a drawing snap", () => {
    const h = Math.SQRT1_2 * 10;
    const arc = { type: "arc", id: "k", x1: 70, y1: -30, x2: 60, y2: -20, mx: 60 + h, my: -30 + h } as ResolvedEntity;
    const m = makeMode([], [arc]);
    m.s.setTool("rotate");
    m.click(20, 10.2);
    m.key("Enter");
    m.s.onPointerMove(at(60.3, -29.8));
    expect(m.seen.snaps[m.seen.snaps.length - 1]).toBe("center");
    m.click(60.3, -29.8);
    m.type("angle", "90");
    m.enterIn("angle");
    const a = m.ent("a");
    expect([a.x1, a.y1, a.x2, a.y2].map((v) => +v!.toFixed(9))).toEqual([20, -80, 20, -60]);
  });

  it("Rotate turns about the snapped corner, with the angle box beside it", () => {
    const { s, dim, type, enterIn, click, boxAt, ent } = chooseLines("rotate");
    click(10.3, 9.8); // half a millimetre off a's start
    expect(dim.isActive).toBe(true);
    // DimInput.position puts the box 16 px right of and below the point
    expect(boxAt()).toEqual({ left: `${10 * PX + 16}px`, top: `${-10 * PX + 16}px` });
    type("angle", "90");
    enterIn("angle");
    const a = ent("a"), b = ent("b");
    expect([a.x1, a.y1, a.x2, a.y2].map((v) => +v!.toFixed(9))).toEqual([10, 10, 10, 30]);
    expect([b.x1, b.y1, b.x2, b.y2].map((v) => +v!.toFixed(9))).toEqual([0, 10, 0, 30]);
    expect([...s.selected].sort(), "the rotated geometry stays selected for another turn").toEqual(["a", "b"]);
  });

  it("Scale grows about the snapped circle centre, with the factor box beside it", () => {
    const { dim, type, enterIn, click, boxAt, ent } = chooseLines("scale");
    click(50.4, 49.7);
    expect(dim.isActive).toBe(true);
    expect(boxAt()).toEqual({ left: `${50 * PX + 16}px`, top: `${-50 * PX + 16}px` });
    type("factor", "2");
    enterIn("factor");
    const a = ent("a");
    expect([a.x1, a.y1, a.x2, a.y2].map((v) => +v!.toFixed(9))).toEqual([-30, -30, 10, -30]);
  });

  it("Move takes a snapped base point and a snapped destination", () => {
    const { click, ent } = chooseLines("move");
    click(30.2, 20.3); // b's end
    click(-29.8, 25.2); // the rectangle's bottom-right corner
    const b = ent("b");
    expect([b.x1, b.y1, b.x2, b.y2].map((v) => +v!.toFixed(9))).toEqual([-50, 25, -30, 25]);
  });

  it("Esc with the box open drops the pivot and keeps the selection", () => {
    const { s, dim, click, input } = chooseLines("rotate");
    click(10.3, 9.8);
    s.onKey({ key: "Escape", target: input("angle"), preventDefault() {} });
    expect(dim.isActive).toBe(false);
    expect([...s.selected].sort()).toEqual(["a", "b"]);
    expect(s.choosingPromptKey).toBeNull();
  });

  it("Esc that clears the selection goes back to choosing, which again lasts until Enter", () => {
    const { s, key, click } = chooseLines("rotate");
    key("Escape");
    expect([...s.selected]).toEqual([]);
    expect(s.choosingPromptKey).toBe("sketch.prompt.rotateChoose");
    click(20, 10.2);
    click(20, 20.2, { shift: true });
    expect([...s.selected].sort(), "the second pick adds, rather than being taken as the pivot").toEqual(["a", "b"]);
  });
});
