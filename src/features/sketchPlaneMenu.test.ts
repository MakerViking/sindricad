// Right-click a sketch > Copy sketch to plane… (Doug 27) and Move sketch
// plane… (Doug L3), entered where the user enters: the menu item's click.
//
// Everything below the click is real: contextMenus' sketchActions, the
// featureStarters entry points, the plane pick's canvas handler, the Offset
// Plane arrow tool (PlaneOffsetTool) and a DocumentStore. Faked: the viewport's
// raycasts (each test says what is under the cursor) and the sidecar, which
// answers nothing, so every plane comes from the document's cached `plane`.
//
// What is NOT covered here, stated rather than implied: whether the rebuilt
// geometry lands where the document says. The datum + planeId shape a move
// writes is the one Offset Plane has always written, and the region-point
// shift was replayed against the real builder when this was built.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installFakeDocument } from "../ui/fakeDom.testkit";
import type { CadDocument, Feature, RebuildReply, Selector, SketchConstraint, SketchEntity } from "../types";
import type { GeometryBackend } from "../geometry/client";

installFakeDocument();
// One frame at a time, on demand: the plane pick runs its result on the NEXT
// frame, and the arrow tool re-arms a frame every tick, so frames must not
// run by themselves.
let frames: (() => void)[] = [];
const flushFrame = () => { const due = frames; frames = []; for (const f of due) f(); };
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: () => void) => { frames.push(cb); return frames.length; };
(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = () => {};
(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };

const toasts: string[] = [];
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); } }));

const { DocumentStore } = await import("../document/store");
const { createFeatureStarters } = await import("./featureStarters");
const { PlaneOffsetTool } = await import("./planeOffsetTool");
const { createContextMenus } = await import("../ui/contextMenus");
const { t } = await import("../i18n");
const params = await import("../params/engine");

type Sketch = Extract<Feature, { type: "sketch" }>;
type Datum = Extract<Feature, { type: "datumPlane" }>;

function stubBackend(): GeometryBackend {
  return {
    async rebuild(): Promise<RebuildReply> { return { ok: false, error: { message: "stub" } }; },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
}

/** What the cursor is over when the plane pick's click lands. A datum quad is
 *  10 mm along the ray unless `datumBehind`, a base plane 20 mm. */
interface Under { face?: { plane: unknown; anchor: unknown }; datum?: string; base?: string; datumBehind?: boolean }

function world(doc: CadDocument) {
  const store = new DocumentStore(stubBackend(), doc);
  const status: string[] = [];
  const selected: (string | null)[] = [];
  let under: Under = {};
  let planePick = false;
  const canvasDown: ((e: unknown) => void)[] = [];
  const boxAt: number[][] = []; // every world point the arrow tool asked to put on screen
  const viewport = {
    suspendPicking: false,
    showAllPlanes() {},
    hoverPlane() {},
    hoverDatum() {},
    hoverFaceAt() {},
    clearHover() {},
    pickFacePlane: () => under.face?.plane ?? null,
    faceAnchor: () => under.face?.anchor ?? null,
    datumHitAt: () => (under.datum ? { id: under.datum, distance: under.datumBehind ? 30 : 10 } : null),
    basePlaneHitAt: () => (under.base ? { plane: under.base, distance: 20 } : null),
    pickPlane: () => under.base ?? null,
    // what the arrow tool reads outside a pointer event
    domElement: { addEventListener() {}, removeEventListener() {}, style: {} as Record<string, string> },
    projectToScreen: (p: { x: number; y: number; z: number }) => { boxAt.push([p.x, p.y, p.z]); return { x: 0, y: 0 }; },
    addToScene() {},
    removeFromScene() {},
    pixelWorldSize: () => 0.1,
    rayFrom: () => ({ intersectObjects: () => [] }),
  };
  const planeOffset = new PlaneOffsetTool(viewport as never, store);
  const toolBusy = () => planePick || planeOffset.active;
  const setStatus = (s: string) => { if (s) status.push(s); };
  const starters = createFeatureStarters({
    store,
    viewport,
    overlay: {},
    sketch: {},
    planeOffset,
    canvas: {
      addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === "pointerdown") canvasDown.push(fn); },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        if (type === "pointerdown") canvasDown.splice(canvasDown.indexOf(fn), 1);
      },
    },
    toolBusy,
    hasBody: () => true,
    setStatus,
    selectFeature: (id: string | null) => { selected.push(id); },
    refreshInspector: () => {},
    noteCommitted: () => {},
    isSketchConsumed: () => false,
    getSelectedFeature: () => null,
    setPlanePick: (v: boolean) => { planePick = v; },
  } as never);
  const menus = createContextMenus({
    store,
    toolBusy,
    setStatus,
    copySketchToPlane: starters.copySketchToPlane,
    moveSketchPlane: starters.moveSketchPlane,
  } as never);

  /** Right-click sketch `id` and choose `label`. */
  const choose = (id: string, label: string) => {
    const item = menus.sketchActions(id).find((i) => i.label === label);
    expect(item, `no "${label}" on the sketch's right-click menu`).toBeTruthy();
    item!.onClick!();
  };
  /** The plane pick's click, then the frame it runs its result on. */
  const clickPlane = (u: Under) => {
    under = u;
    expect(canvasDown.length, "no plane pick is waiting for a click").toBe(1);
    canvasDown[0]!({ button: 0, clientX: 1, clientY: 1, preventDefault() {}, stopImmediatePropagation() {} });
    flushFrame();
  };
  /** Type a distance into the arrow tool's box and press Enter. */
  const typeAndEnter = (mm: number) => {
    expect(planeOffset.active, "the arrow did not open").toBe(true);
    (planeOffset as unknown as { dim: { seed: (n: string, v: number) => void } }).dim.seed("offset", mm);
    (planeOffset as unknown as { commit: () => void }).commit();
  };
  const feature = <T extends Feature>(id: string) => store.document.features.find((f) => f.id === id) as T;
  return { store, status, selected, choose, clickPlane, typeAndEnter, feature, planeOffset, boxAt };
}

const COPY = t("context.copySketchToPlane");
const MOVE = t("context.moveSketchPlane");

beforeEach(() => {
  frames = [];
  toasts.length = 0;
});

// --- Copy sketch to plane ----------------------------------------------------

/** One of most things a sketch can hold: a rectangle named by an EDGE operand,
 *  a dimension a parameter drives, a projected curve, a pattern, a text on a
 *  path, and a constraint on the synthetic origin (which is not the sketch's
 *  to rename). */
function richDoc(): CadDocument {
  const entities: SketchEntity[] = [
    { type: "rectangle", id: "r1", width: 40, height: 40, x: 0, y: 0, dimPlace: { width: { ox: 0, oy: 3 } } },
    { type: "circle", id: "e2", radius: 5, x: 10, y: 10 },
    { type: "line", id: "e3", x1: -20, y1: -30, x2: 20, y2: -30 },
    { type: "projected", id: "e4", source: { kind: "sketchCurve", sketch: "s0", entity: "z1" }, curve: { kind: "line", x1: -20, y1: 30, x2: 20, y2: 30 } },
    { type: "text", id: "e5", text: "A", height: 5, pathRef: "e3" },
  ];
  const constraints: SketchConstraint[] = [
    { type: "horizontal", line: "e3" },
    { type: "distance", id: "c5", line: "e3", value: 40 },
    { type: "p2lDistance", id: "c6", e: "e2", p: 0, line: "r1~0", value: 15, place: { ox: 1, oy: 2 } },
    { type: "coincident", e1: "e3", p1: 0, e2: "r1", p2: 0 },
    { type: "coincident", e1: "e2", p1: 0, e2: "__origin__", p2: 0 },
    { type: "fix", e: "e4", p: 0 },
    { type: "offset", id: "c8", pairs: [{ src: "e3", cpy: "e4" }], value: -60 },
  ];
  return {
    parameters: {},
    paramDefs: {
      w: { expr: "30", value: 30, unit: "mm" },
      d1: { expr: "w + 10", value: 40, unit: "mm", target: { kind: "constraint", sketch: "s1", constraint: "c5" } },
      d2: { expr: "2", value: 2, unit: "count", target: { kind: "pattern", sketch: "s1", pattern: "p7", field: "countX" } },
    },
    features: [
      { id: "s1", type: "sketch", plane: "XY", name: "Lid", entities, constraints,
        patterns: [{ id: "p7", type: "patternRect", sources: ["e2"], countX: 2, countY: 1, spacingX: 15, spacingY: 0 }] },
      { id: "x1", type: "extrude", sketch: "s1", distance: 10, operation: "new", regions: [[1, 2, 0]], regionEntities: [["r1"]] },
    ],
  };
}

/** Every entity id a constraint names (a rect edge decoded to its rectangle). */
function operandIds(c: SketchConstraint): string[] {
  const vals = Object.entries(c)
    .filter(([k]) => ["line", "l1", "l2", "circle", "e1", "e2", "e", "c1", "c2", "inner", "outer", "a", "b"].includes(k))
    .map(([, v]) => v as string);
  if (c.type === "offset") for (const p of c.pairs) vals.push(p.src, p.cpy);
  return vals.map((v) => v.split("~")[0]!);
}

describe("Copy sketch to plane", () => {
  it("lands a copy with new ids on the picked base plane, constraints and dimensions carried", () => {
    const w = world(richDoc());
    const before = structuredClone(w.feature<Sketch>("s1"));
    w.choose("s1", COPY);
    w.clickPlane({ base: "XZ" });

    const feats = w.store.document.features;
    expect(feats.map((f) => f.type), "the copy should be one new sketch at the end").toEqual(["sketch", "extrude", "sketch"]);
    const copy = feats[2] as Sketch;
    expect(w.selected.at(-1), "the copy is not what got selected").toBe(copy.id);
    expect(copy.plane).toBe("XZ");
    expect(copy.planeId).toBeUndefined();
    expect(copy.face).toBeUndefined();
    expect(copy.name).toBe(t("sketch.copyName", { name: "Lid" }));

    // new ids, one per source entity, in the source's order
    const ids = copy.entities.map((e) => e.id!);
    expect(ids).toHaveLength(5);
    const srcIds = before.entities.map((e) => e.id!);
    expect(ids.filter((id) => srcIds.includes(id)), "the copy reuses source entity ids").toEqual([]);
    const copyOf = new Map(srcIds.map((id, i) => [id, ids[i]!]));

    // every constraint, retargeted onto the copy's own entities
    expect(copy.constraints).toHaveLength(7);
    for (const c of copy.constraints!) {
      for (const id of operandIds(c)) {
        expect(ids.includes(id) || id === "__origin__", `${c.type} still names ${id}`).toBe(true);
      }
    }
    const p2l = copy.constraints!.find((c) => c.type === "p2lDistance") as Extract<SketchConstraint, { type: "p2lDistance" }>;
    expect(p2l.line, "a rectangle EDGE operand lost its edge index").toBe(`${copyOf.get("r1")}~0`);
    expect(p2l.place).toEqual({ ox: 1, oy: 2 });
    expect(copy.constraints!.find((c) => c.type === "coincident" && (c as { e2: string }).e2 === "__origin__"),
      "the constraint to the sketch origin was lost or renamed").toBeTruthy();

    // dimensions get new ids too, and the parameter expression follows them
    const dist = copy.constraints!.find((c) => c.type === "distance") as Extract<SketchConstraint, { type: "distance" }>;
    expect(dist.id).toBeTruthy();
    expect(dist.id).not.toBe("c5");
    const defs = w.store.document.paramDefs!;
    const bound = Object.entries(defs).find(([, d]) => d.target?.kind === "constraint" && d.target.sketch === copy.id);
    expect(bound, "the copied dimension lost its parameter expression").toBeTruthy();
    expect(bound![1].expr).toBe("w + 10");
    expect(bound![1].target).toEqual({ kind: "constraint", sketch: copy.id, constraint: dist.id });
    expect(defs.d1!.target, "the SOURCE dimension's binding moved").toEqual({ kind: "constraint", sketch: "s1", constraint: "c5" });

    // the pattern and its parameter
    expect(copy.patterns).toHaveLength(1);
    const pat = copy.patterns![0]!;
    expect(pat.id).not.toBe("p7");
    expect((pat as { sources: string[] }).sources).toEqual([copyOf.get("e2")]);
    expect(Object.values(defs).some((d) => d.target?.kind === "pattern" && d.target.sketch === copy.id && d.target.pattern === pat.id)).toBe(true);

    // projected geometry comes across as an ordinary line, the link broken
    const proj = copy.entities[3]!;
    expect(proj).toEqual({ type: "line", id: copyOf.get("e4"), x1: -20, y1: 30, x2: 20, y2: 30 });
    // the text keeps following its path, the copy's path
    expect((copy.entities[4] as { pathRef: string }).pathRef).toBe(copyOf.get("e3"));
    expect((copy.entities[0] as { dimPlace?: unknown }).dimPlace).toEqual({ width: { ox: 0, oy: 3 } });

    expect(w.feature<Sketch>("s1"), "copying changed the source sketch").toEqual(before);
  });

  it("is one undo step", () => {
    const w = world(richDoc());
    const before = structuredClone(w.store.document);
    w.choose("s1", COPY);
    w.clickPlane({ base: "XZ" });
    w.store.undo();
    expect(w.store.document.features).toEqual(before.features);
    expect(w.store.document.paramDefs).toEqual(before.paramDefs);
    expect(w.store.canUndo).toBe(false);
  });

  it("keeps the link to a picked construction plane, so the copy follows its offset", () => {
    const doc = richDoc();
    doc.features.unshift({ id: "d0", type: "datumPlane", plane: "XY", offset: 25 });
    const w = world(doc);
    w.choose("s1", COPY);
    w.clickPlane({ datum: "d0", base: "XY" }); // the datum's quad is in front of the base plane
    const copy = w.store.document.features.at(-1) as Sketch;
    expect(copy.planeId, "a datum pick copied onto a frozen plane").toBe("d0");
    expect(copy.plane).toEqual({ origin: [0, 0, 25], normal: [0, 0, 1], xdir: [1, 0, 0] });
  });

  it("takes a base plane in front of a construction plane's quad", () => {
    const doc = richDoc();
    doc.features.unshift({ id: "d0", type: "datumPlane", plane: "XY", offset: 25 });
    const w = world(doc);
    w.choose("s1", COPY);
    w.clickPlane({ datum: "d0", base: "XZ", datumBehind: true });
    const copy = w.store.document.features.at(-1) as Sketch;
    expect(copy.plane, "a datum quad behind the base plane stole the pick").toBe("XZ");
    expect(copy.planeId).toBeUndefined();
  });

  it("keeps the face reference of a picked body face", () => {
    const w = world(richDoc());
    const plane = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const anchor = { kind: "face", by: "nearest", point: [5, 5, 10], body: "body1" };
    w.choose("s1", COPY);
    w.clickPlane({ face: { plane, anchor }, datum: "d0" }); // a face wins over a quad
    const copy = w.store.document.features.at(-1) as Sketch;
    expect(copy.plane).toEqual(plane);
    expect(copy.face).toEqual(anchor);
    expect(copy.planeId).toBeUndefined();
  });

  /** A sketch whose circle is a quarter of its line, the line's length set by
   *  `widthParam` (a name the user typed, or an auto dN). */
  function quarterDoc(widthParam: string): CadDocument {
    return {
      parameters: {},
      paramDefs: {
        [widthParam]: { expr: "40", value: 40, unit: "mm", target: { kind: "constraint", sketch: "s1", constraint: "c1" } },
        d7: { expr: `${widthParam} / 4`, value: 10, unit: "mm", target: { kind: "constraint", sketch: "s1", constraint: "c2" } },
      },
      features: [{
        id: "s1", type: "sketch", plane: "XY",
        entities: [{ type: "line", id: "e1", x1: 0, y1: 0, x2: 40, y2: 0 }, { type: "circle", id: "e2", radius: 5, x: 20, y: 20 }],
        constraints: [{ type: "distance", id: "c1", line: "e1", value: 40 }, { type: "diameter", id: "c2", circle: "e2", value: 10 }],
      }],
    };
  }
  /** The [line length, circle diameter] dimensions of sketch `id` after the
   *  parameter edits `set` are evaluated, the way the store's recompute does. */
  function dimsAfter(doc: CadDocument, id: string, set: Record<string, string>): number[] {
    const d = structuredClone(doc);
    for (const [name, expr] of Object.entries(set)) d.paramDefs![name]!.expr = expr;
    params.recompute(d);
    const s = d.features.find((f) => f.id === id) as Sketch;
    return s.constraints!.map((c) => (c as { value: number }).value);
  }
  const copyIdOf = (doc: CadDocument) => doc.features.at(-1)!.id;
  const boundTo = (doc: CadDocument, sketch: string, c: SketchConstraint) =>
    Object.entries(doc.paramDefs!).find(([, def]) => def.target?.kind === "constraint" && def.target.sketch === sketch
      && def.target.constraint === (c as { id: string }).id)!;

  it("lets a dimension the user named drive the copy's matching dimension, so the copy agrees with itself", () => {
    const w = world(quarterDoc("width"));
    w.choose("s1", COPY);
    w.clickPlane({ base: "XZ" });
    const doc = w.store.document;
    const copy = w.feature<Sketch>(copyIdOf(doc));
    const [len, dia] = copy.constraints!;
    expect(boundTo(doc, copy.id, len!)[1].expr, "the copy's width froze at a number").toBe("width");
    expect(boundTo(doc, copy.id, dia!)[1].expr).toBe("width / 4");

    expect(dimsAfter(doc, copy.id, { width: "60" }), "the copy's width and its quarter disagree").toEqual([60, 15]);
    expect(dimsAfter(doc, "s1", { width: "60" })).toEqual([60, 15]);
  });

  it("points a dimension that refers to another one of the same sketch at the copy's own", () => {
    const w = world(quarterDoc("d1"));
    w.choose("s1", COPY);
    w.clickPlane({ base: "XZ" });
    const doc = w.store.document;
    const copy = w.feature<Sketch>(copyIdOf(doc));
    const [lenName, lenDef] = boundTo(doc, copy.id, copy.constraints![0]!);
    expect(lenName).not.toBe("d1");
    expect(lenDef.expr).toBe("40");
    expect(boundTo(doc, copy.id, copy.constraints![1]!)[1].expr, "the copy's circle follows the SOURCE's width")
      .toBe(`${lenName} / 4`);
    expect(doc.paramDefs!.d7!.expr, "the source's own expression changed").toBe("d1 / 4");

    expect(dimsAfter(doc, copy.id, { [lenName]: "60" })).toEqual([60, 15]);
    expect(dimsAfter(doc, copy.id, { d1: "80" }), "editing the source's width moved the copy's circle").toEqual([40, 10]);
  });

  it("does not touch a document without a parameter table", () => {
    const doc = richDoc();
    delete doc.paramDefs;
    const w = world(doc);
    w.choose("s1", COPY);
    w.clickPlane({ base: "YZ" });
    expect(w.store.document.paramDefs, "a copy added a parameter table nobody asked for").toBeUndefined();
  });

  it("says so when the sketch is gone by the time the entry is chosen", () => {
    const w = world(richDoc());
    const item = w.status.length;
    w.store.removeFeature("s1");
    w.choose("s1", COPY);
    expect(w.status.slice(item)).toEqual([t("feature.starters.sketchGone")]);
  });
});

// --- Move sketch plane -------------------------------------------------------

function moveDoc(sketch: Partial<Sketch> = {}, before: Feature[] = [], after: Feature[] = []): CadDocument {
  return {
    parameters: {},
    features: [
      ...before,
      { id: "s1", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", width: 40, height: 40 }], ...sketch } as Sketch,
      { id: "x1", type: "extrude", sketch: "s1", distance: 10, operation: "new", regions: [[1, 2, 0]], regionEntities: [["r1"]] },
      ...after,
    ],
  };
}

describe("Move sketch plane", () => {
  it("parks a sketch on a base plane on a new datum just before it, and carries the extrude's area with it", () => {
    const w = world(moveDoc());
    w.choose("s1", MOVE);
    w.typeAndEnter(5);

    const [datum, s1, x1] = w.store.document.features as [Datum, Sketch, Extract<Feature, { type: "extrude" }>];
    expect(datum.type, "the datum is not immediately before the sketch").toBe("datumPlane");
    expect(datum.plane).toBe("XY");
    expect(datum.offset).toBe(5);
    expect(s1.planeId).toBe(datum.id);
    expect(s1.plane).toEqual({ origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] });
    expect(x1.regions, "the extrude's area point stayed on the old plane").toEqual([[1, 2, 5]]);
    expect(x1.regionEntities).toEqual([["r1"]]);
    expect(w.selected.at(-1), "the datum whose Offset moves the sketch is not selected").toBe(datum.id);
  });

  it("is one undo step, and moving by nothing changes nothing", () => {
    const w = world(moveDoc());
    const before = structuredClone(w.store.document.features);
    w.choose("s1", MOVE);
    w.typeAndEnter(0);
    expect(w.store.document.features).toEqual(before);
    expect(w.store.canUndo, "a move of 0 left an undo step").toBe(false);

    w.choose("s1", MOVE);
    w.typeAndEnter(-7.5);
    expect((w.store.document.features[0] as Datum).offset).toBe(-7.5);
    w.store.undo();
    expect(w.store.document.features).toEqual(before);
    expect(w.store.canUndo).toBe(false);
  });

  it("stands the arrow on the sketch's curves, not on its plane's origin, and still moves by the typed distance", () => {
    // On a face the plane's origin is the world origin projected onto it: far
    // from a part that is not at the origin, and off screen.
    const face: Selector = { kind: "face", by: "nearest", point: [50, 30, 10], body: "body1" };
    const plane = { origin: [0, 0, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number], xdir: [1, 0, 0] as [number, number, number] };
    const w = world(moveDoc({ plane, face, entities: [{ type: "rectangle", id: "r1", x: 50, y: 30, width: 40, height: 20 }] }));
    w.choose("s1", MOVE);
    expect(w.boxAt[0], "the arrow and its Offset box opened away from the sketch").toEqual([50, 30, 10]);
    w.typeAndEnter(3);
    const [datum, s1] = w.store.document.features as [Datum, Sketch];
    expect(datum.offset).toBe(3);
    // the sketch's own frame keeps its origin: its curves keep their place on it
    expect(s1.plane).toEqual({ origin: [0, 0, 13], normal: [0, 0, 1], xdir: [1, 0, 0] });
  });

  it("warns that fillets and other position picks after the sketch may now sit on a different edge", () => {
    const fillet = { id: "f3", type: "fillet", edges: [{ kind: "edge", by: "nearest", point: [0, 20, 10] }], radius: 1 } as unknown as Feature;
    const w = world(moveDoc({}, [], [fillet]));
    w.choose("s1", MOVE);
    w.typeAndEnter(10);
    expect(toasts).toEqual([t("feature.starters.sketchPlaneMovedPicks")]);
  });

  it("does not warn for picks that follow a move: a sketch on a face, or every edge", () => {
    const onTop = { id: "s2", type: "sketch", plane: { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] },
      face: { kind: "face", by: "nearest", point: [5, 5, 10] }, entities: [] } as unknown as Feature;
    const all = { id: "f3", type: "fillet", edges: { kind: "edge", by: "all" }, radius: 1 } as unknown as Feature;
    const w = world(moveDoc({}, [], [onTop, all]));
    w.choose("s1", MOVE);
    w.typeAndEnter(10);
    expect(toasts).toEqual([]);
  });

  it("moves a face-anchored sketch's face reference onto the datum, which then follows the face", () => {
    const face: Selector = { kind: "face", by: "nearest", point: [5, 5, 10], body: "body1" };
    const plane = { origin: [0, 0, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number], xdir: [1, 0, 0] as [number, number, number] };
    const w = world(moveDoc({ plane, face }));
    w.choose("s1", MOVE);
    w.typeAndEnter(3);
    const [datum, s1] = w.store.document.features as [Datum, Sketch];
    expect(datum).toMatchObject({ type: "datumPlane", plane, face, offset: 3 });
    // `face` outranks `planeId` on rebuild, so it MUST leave the sketch
    expect(s1.face, "the sketch kept its face and would ignore the datum").toBeUndefined();
    expect(s1.planeId).toBe(datum.id);
    expect(s1.plane).toEqual({ origin: [0, 0, 13], normal: [0, 0, 1], xdir: [1, 0, 0] });
  });

  it("on a datum only this sketch uses, moves that datum instead of stacking a second one", () => {
    const d0: Datum = { id: "d0", type: "datumPlane", plane: "XY", offset: 10 };
    const doc = moveDoc({ planeId: "d0", plane: { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] } }, [d0]);
    (doc.features[2] as { regions: number[][] }).regions = [[1, 2, 10]]; // ON the datum
    const w = world(doc);
    w.choose("s1", MOVE);
    w.typeAndEnter(5);
    const feats = w.store.document.features;
    expect(feats.map((f) => f.id)).toEqual(["d0", "s1", "x1"]);
    expect((feats[0] as Datum).offset).toBe(15);
    expect((feats[1] as Sketch).planeId).toBe("d0");
    expect((feats[2] as { regions: unknown }).regions).toEqual([[1, 2, 15]]);
    // and a second move keeps editing the same datum
    w.choose("s1", MOVE);
    w.typeAndEnter(-15);
    expect(w.store.document.features.map((f) => f.id)).toEqual(["d0", "s1", "x1"]);
    expect((w.store.document.features[0] as Datum).offset).toBe(0);
  });

  it("starts from where its datum IS after the datum's Offset was edited, not from the sketch's stale cache", () => {
    // The Inspector's Offset row patches only the datum, so the sketch's cached
    // `plane` still says 10 while the sketch is built at 30, and a datum with no
    // face gets no entry in the rebuild's resolved planes.
    const d0: Datum = { id: "d0", type: "datumPlane", plane: "XY", offset: 30 };
    const w = world(moveDoc({ planeId: "d0", plane: { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] } }, [d0]));
    w.choose("s1", MOVE);
    w.typeAndEnter(5);
    expect(w.feature<Datum>("d0").offset).toBe(35);
    expect(w.feature<Sketch>("s1").plane, "the cache was moved from the stale 10, not from 30")
      .toEqual({ origin: [0, 0, 35], normal: [0, 0, 1], xdir: [1, 0, 0] });
  });

  it("does not drag other features along when the datum is shared, and says the sketch left it", () => {
    const d0: Datum = { id: "d0", type: "datumPlane", plane: "XY", offset: 10 };
    const onD0 = { planeId: "d0", plane: { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] } } as const;
    const s2 = { id: "s2", type: "sketch", ...onD0, entities: [] } as unknown as Feature;
    const w = world(moveDoc(structuredClone(onD0) as Partial<Sketch>, [d0], [s2]));
    w.choose("s1", MOVE);
    w.typeAndEnter(5);
    const feats = w.store.document.features;
    expect(feats.map((f) => f.type)).toEqual(["datumPlane", "datumPlane", "sketch", "extrude", "sketch"]);
    expect((feats[0] as Datum).offset, "the shared datum moved, and every other sketch on it with it").toBe(10);
    const mine = feats[1] as Datum;
    expect(mine.plane, "the new datum does not start where the sketch was").toEqual(onD0.plane);
    expect(mine.offset).toBe(5);
    expect((feats[2] as Sketch).planeId).toBe(mine.id);
    expect((feats[4] as Sketch).planeId).toBe("d0");
    expect(toasts).toEqual([t("feature.starters.sketchPlaneDetached")]);
  });

  it("refuses, naming the parameter, when the sketch's own datum is driven by an expression", () => {
    const doc = moveDoc({ planeId: "d0", plane: { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] } },
      [{ id: "d0", type: "datumPlane", plane: "XY", offset: 20 }]);
    doc.paramDefs = {
      h: { expr: "10", value: 10, unit: "mm" },
      lift: { expr: "2 * h", value: 20, unit: "mm", target: { kind: "feature", feature: "d0", field: "offset" } },
    };
    const w = world(doc);
    const before = structuredClone(w.store.document);
    w.choose("s1", MOVE);
    expect(w.planeOffset.active, "the arrow opened on a parameter-driven plane").toBe(false);
    expect(w.status.at(-1)).toBe(t("feature.starters.sketchPlaneByParam", { name: "lift" }));
    expect(w.store.document).toEqual(before);
  });

  it("rewrites a plain-number parameter on the datum's offset, or the move would not stick", () => {
    const doc = moveDoc({ planeId: "d0", plane: { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] } },
      [{ id: "d0", type: "datumPlane", plane: "XY", offset: 20 }]);
    doc.paramDefs = { lift: { expr: "20", value: 20, unit: "mm", target: { kind: "feature", feature: "d0", field: "offset" } } };
    const w = world(doc);
    w.choose("s1", MOVE);
    w.typeAndEnter(5);
    expect((w.store.document.features[0] as Datum).offset).toBe(25);
    expect(w.store.document.paramDefs!.lift!.expr).toBe("25");
  });

  it("carries a loft's profile on the moved sketch, and leaves its other profiles alone", () => {
    const loft = { id: "l1", type: "loft", profiles: [{ sketch: "s1", region: [0, 0, 0] }, { sketch: "s9", region: [0, 0, 50] }] } as unknown as Feature;
    const w = world(moveDoc({}, [], [loft]));
    w.choose("s1", MOVE);
    w.typeAndEnter(4);
    expect((w.feature<Extract<Feature, { type: "loft" }>>("l1")).profiles).toEqual([
      { sketch: "s1", region: [0, 0, 4] },
      { sketch: "s9", region: [0, 0, 50] },
    ]);
  });

  it("moves along the sketch's own normal on a tilted base plane", () => {
    // XZ's normal is -Y (SketchPlane and build123d agree): a positive move goes to -Y
    const doc = moveDoc({ plane: "XZ" });
    (doc.features[1] as { regions: number[][] }).regions = [[1, 0, 2]]; // a point ON XZ
    const w = world(doc);
    w.choose("s1", MOVE);
    w.typeAndEnter(5);
    const [datum, s1, x1] = w.store.document.features as [Datum, Sketch, Extract<Feature, { type: "extrude" }>];
    expect(datum).toMatchObject({ plane: "XZ", offset: 5 });
    expect(s1.plane).toEqual({ origin: [0, -5, 0], normal: [0, -1, 0], xdir: [1, 0, 0] });
    expect(x1.regions).toEqual([[1, -5, 2]]);
  });

  it("keeps a rolled-back marker below the sketch it was below", () => {
    const fillet = { id: "f3", type: "fillet", edges: [], radius: 1 } as unknown as Feature;
    const w = world(moveDoc({}, [], [fillet]));
    w.store.setRollback(2); // s1 and x1 built, the fillet rolled back
    w.choose("s1", MOVE);
    w.typeAndEnter(5);
    expect(w.store.rollbackIndex, "the inserted datum pushed the extrude past the marker").toBe(3);
  });

  it("refuses a suppressed sketch the way opening it to edit does", () => {
    const w = world(moveDoc());
    w.store.toggleSuppress("s1");
    w.choose("s1", MOVE);
    expect(w.planeOffset.active).toBe(false);
    expect(w.status.at(-1)).toBe(t("status.unsuppressToEdit"));
  });
});
