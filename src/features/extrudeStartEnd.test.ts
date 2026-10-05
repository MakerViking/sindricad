// Extrude's start and end OBJECTS (GH #41 a and b): start from a face, a
// plane, a point or a line, and run up to a point or a line as well as a face
// or a plane. Paul's goal on #41 is a box and its lid from ONE sketch: the lid
// starts from the box's top face, so it follows the box when the box changes.
//
// These drive the REAL ExtrudeTool with the REAL panel and sketch overlay, as a
// user does: a chip, a click in the model, OK. What is asserted is what lands
// in the feature, because that is what the sidecar builds and what has to
// FOLLOW the geometry: a sketch entity by id, a body edge or face by the
// by:"match" fingerprint the sidecar authored, never the by:"nearest" point
// the click produced (that re-binds to the wrong edge in silence).

import { describe, expect, it, afterEach } from "vitest";
import * as THREE from "three";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";
import { SketchOverlay } from "../sketch/overlay";
import { setFieldParams, setUnit } from "../ui/units";
import type { CadDocument, Feature, Selector } from "../types";
import type { QueryResult } from "../geometry/client";

installFakeDocument();
(globalThis as unknown as { window: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
(globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement ??= FakeEl;
(globalThis as unknown as { Node: unknown }).Node ??= FakeEl;

const { ExtrudeTool } = await import("./extrudeTool");

afterEach(() => {
  setUnit("mm");
  setFieldParams(() => ({}));
});

/** The view the clicks are made in: looking along +Y, so world x runs right
 *  and world z runs UP the screen, 4 px to the mm, origin at (400, 300). */
const toScreen = (w: THREE.Vector3) => ({ x: 400 + 4 * w.x, y: 300 - 4 * w.z });

/** Area A (20x20 at x=-30) on XY is the profile. Sketch s2 stands on XZ with
 *  reference geometry: a point at height 12, a level line at 15, a tilted line,
 *  an arc and a rectangle. A construction plane 20 above XY. */
function doc(saved: Record<string, unknown> = {}): CadDocument {
  return {
    features: [
      {
        id: "s1", type: "sketch", plane: "XY",
        entities: [{ id: "ra", type: "rectangle", x: -30, y: 0, width: 20, height: 20 }],
      },
      {
        id: "s2", type: "sketch", plane: "XZ",
        entities: [
          { id: "p1", type: "point", x: 5, y: 12 },
          { id: "l1", type: "line", x1: 30, y1: 15, x2: 50, y2: 15 },
          { id: "l2", type: "line", x1: 60, y1: 10, x2: 70, y2: 30 },
          { id: "a1", type: "arc", x1: -60, y1: 40, x2: -40, y2: 40, mx: -50, my: 50 },
          // a rectangle x 150..170, height 20..30 (x, y is its centre): side 0
          // its bottom, 1 its right, 2 its top (rectCorners order)
          { id: "rq", type: "rectangle", x: 160, y: 25, width: 20, height: 10 },
          // a hexagon round (220, 25) with corner 0 at 0 degrees: its side 1
          // runs level across the top, at 25 + 10 sin 60
          { id: "hx", type: "polygon", x: 220, y: 25, radius: 10, sides: 6, angle: 0 },
          // a level slot x 260..290 at height 25, 10 wide: side 0 on the left of
          // its axis (on top, at 30), side 1 below (20), round ends to x 255 and 295
          { id: "sl", type: "slot", x1: 260, y1: 25, x2: 290, y2: 25, width: 10 },
        ],
      },
      { id: "d1", type: "datumPlane", plane: "XY", offset: 20 },
      {
        id: "ex1", type: "extrude", sketch: "s1", distance: 15, operation: "new",
        regions: [[-30, 0, 0]], regionEntities: [["ra"]], regionHoleEntities: [[]],
        ...saved,
      },
    ],
    parameters: {},
  } as unknown as CadDocument;
}

type Reply = (r: QueryResult[]) => void;

function harness(opts: { saved?: Record<string, unknown> } = {}) {
  const body = (globalThis.document as unknown as { body: FakeEl }).body;
  body.children.length = 0;
  const d = doc(opts.saved);
  const overlay = new SketchOverlay();
  overlay.update(d);
  const scene = new THREE.Scene();
  const planesShown: boolean[] = [];
  const viewport = {
    suspendPicking: false,
    camera: new THREE.PerspectiveCamera(),
    pixelWorldSize: () => 0.25,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    projectToScreen: toScreen,
    tiltOffAxis: () => true,
    pointInSolid: (_p: THREE.Vector3): boolean => false,
    // what the model has under the cursor, set per test
    pickEntity: (): unknown => null,
    pickFaceForPressPull: (): unknown => null,
    pickFacePlane: (): unknown => null,
    faceAnchor: (): unknown => null,
    pickVertexAt: (): unknown => null,
    // the planes under the cursor, nearest first (none unless a test says so)
    planeHitsAt: (): { id: string; datum: boolean; distance: number }[] => [],
    datumPlaneOf: (id: string) => (id === "d1" ? { id, origin: [0, 0, 20], normal: [0, 0, 1] } : null),
    // whether a world point is behind a body at the cursor (none unless a test says so)
    behindSurfaceAt: (): ((w: THREE.Vector3) => boolean) => () => false,
    showAllPlanes: (on: boolean) => planesShown.push(on),
    hoverPlane() {},
    hoverFaceAt: () => null,
    hoverEdge() {},
    // straight down onto area A, wherever the click is
    rayFrom: () => ({ ray: new THREE.Ray(new THREE.Vector3(-30, 0, 50), new THREE.Vector3(0, 0, -1)) }),
    clearHover() {},
    hoverDatum() {},
    domElement: {
      style: {},
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
    },
  };
  const added: Feature[] = [];
  const previews: (Feature | null)[] = [];
  const queries: { items: { kind: string; body: string; sel: Selector }[]; editingId: string | null }[] = [];
  const replies: Reply[] = [];
  const store = {
    document: d,
    isParamBound: () => false,
    boundExpr: () => null,
    beginEditPreview() {},
    endEditPreview() {},
    setPreview: (f: Feature | null) => previews.push(f),
    setEditPreview: (f: Feature | null) => previews.push(f),
    buildState: {},
    hiddenBodyIds: () => [],
    nextId: () => "new1",
    addFeature: (f: Feature) => added.push(f),
    replaceFeature: (_id: string, f: Feature) => added.push(f),
    onBuild: () => () => {},
    queryReferences: (items: { kind: string; body: string; sel: Selector }[], editingId: string | null) => {
      queries.push({ items, editingId });
      return new Promise<QueryResult[]>((res) => replies.push(res));
    },
  };
  const tool = new ExtrudeTool(viewport as never, overlay, store as never);
  const internals = tool as unknown as { onKey(e: KeyboardEvent): void; onDown(e: PointerEvent): void; onUp(e: PointerEvent): void };

  const panel = () => {
    const root = body.children.find((c) => c.className === "tool-panel extrude-panel");
    if (!root) throw new Error("the Extrude panel is not on the page");
    return root;
  };
  const visible = (el: FakeEl) => el.style.display !== "none";
  const rowOf = (label: string) => {
    const r = panel().children.find((c) => c.children[0]?.textContent === label);
    if (!r) throw new Error(`no "${label}" row`);
    return r;
  };
  /** the text in a pick box */
  const box = (label: string) => rowOf(label).children[1]!.children[0]!.textContent;
  const chip = (text: string): FakeEl => {
    const found: FakeEl[] = [];
    const walk = (el: FakeEl) => {
      if (el.tagName === "button" && el.className.startsWith("tool-chip") && el.textContent === text) found.push(el);
      el.children.forEach(walk);
    };
    walk(panel());
    if (found.length !== 1) throw new Error(`expected one "${text}" chip, found ${found.length}`);
    return found[0]!;
  };
  const type = (label: string, text: string) => {
    const row = panel().children.find((r) => r.className === "tool-panel-row" && r.children[0]?.textContent === label)!;
    const el = row.children[1]!;
    el.value = text;
    el.dispatch("input");
  };
  const ok = () => panel().children.find((c) => c.className === "tool-panel-buttons")!.children[0]!.dispatch("click");
  const warning = () => panel().children.find((c) => c.className === "tool-panel-warn")!.textContent;
  const keyAt = (k: string) =>
    ({ key: k, target: null, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0, preventDefault() {}, stopPropagation() {} }) as unknown as KeyboardEvent;
  /** a click in the model at a world point, as the screen shows it */
  const clickAt = (w: [number, number, number]) => {
    const s = toScreen(new THREE.Vector3(...w));
    const ev = { button: 0, clientX: s.x, clientY: s.y, buttons: 1, preventDefault() {}, stopImmediatePropagation() {} };
    internals.onDown(ev as unknown as PointerEvent);
    internals.onUp(ev as unknown as PointerEvent);
  };
  /** The sidecar answers the last query with this storable reference. */
  const answer = async (sel: Selector, bodyId = "body1") => {
    replies.shift()!([{ index: 0, ok: true, count: 1, entities: [{ body: bodyId, sel }] }]);
    await Promise.resolve();
    await Promise.resolve();
  };
  const create = () => {
    overlay.toggleRegionSelection(overlay.regions.find((wr) => wr.region.entityIds.includes("ra"))!, false);
    tool.start(() => {});
  };
  return { tool, internals, viewport, overlay, store, added, previews, queries, replies, planesShown, panel, visible, rowOf, box, chip, type, ok, warning, keyAt, clickAt, answer, create };
}

const last = <T,>(xs: T[]): T => xs[xs.length - 1]!;

/** A straight vertical body edge from (90,0,0) to (90,0,15), clear of the
 *  reference sketch on screen, as the viewport hands one over: its world
 *  polyline (a straight edge tessellates to its two ends) and its body. */
const VERTICAL = { id: "e9", body: "body1", points: [[90, 0, 0], [90, 0, 15]] as [number, number, number][] };
/** ...and the level top edge of the same box, (85,0,15) to (95,0,15). */
const TOP = { id: "e8", body: "body1", points: [[85, 0, 15], [95, 0, 15]] as [number, number, number][] };
const nearestOf = (e: { body: string; points: [number, number, number][] }) => ({
  kind: "edge" as const, by: "nearest" as const,
  point: e.points[0]!.map((v, i) => (v + e.points[1]![i]!) / 2) as [number, number, number], body: e.body,
});
/** what the sidecar authors for the vertical edge: its fingerprint points UP */
const VERTICAL_FP: Selector = { kind: "edge", by: "match", fp: { mid: [90, 0, 7.5], dir: [0, 0, 1], length: 15, curve: "line" } };
const TOP_FP: Selector = { kind: "edge", by: "match", fp: { mid: [90, 0, 15], dir: [1, 0, 0], length: 10, curve: "line" } };

describe("Start = Object", () => {
  it("a click on a sketch point fills the Start box, and the feature names the point by id", () => {
    const h = harness();
    h.create();
    expect(h.visible(h.rowOf("Start from")), "the Start box shows before Object is chosen").toBe(false);
    h.chip("Object").dispatch("click");
    expect(h.visible(h.rowOf("Start from"))).toBe(true);
    expect(last(h.planesShown), "the origin planes are not drawn to be picked").toBe(true);

    h.clickAt([5, 0, 12]); // p1
    expect(h.box("Start from")).toBe("Sketch point");
    expect(last(h.planesShown), "the origin planes stayed up after the pick").toBe(false);
    // the start object previews through the real build
    expect(last(h.previews)).toMatchObject({ startFrom: { kind: "sketchPoint", sketch: "s2", entity: "p1", pointIndex: 0 } });

    h.type("Start offset", "2");
    h.ok();
    expect(h.added).toHaveLength(1);
    expect(h.added[0]).toMatchObject({
      startFrom: { kind: "sketchPoint", sketch: "s2", entity: "p1", pointIndex: 0 },
      startOffset: 2,
      distance: 10,
    });
  });

  it("OK with an empty Start box says what is missing, rather than building from the sketch", () => {
    const h = harness();
    h.create();
    h.chip("Object").dispatch("click");
    h.ok();
    expect(h.added).toEqual([]);
    expect(h.warning()).not.toBe("");
    // Escape with nothing picked puts Start back to where it was
    h.internals.onKey(h.keyAt("Escape"));
    expect(h.tool.active, "Escape out of the pick cancelled the extrude").toBe(true);
    expect(h.chip("Profile plane").classList.contains("on")).toBe(true);
    h.ok();
    expect("startFrom" in h.added[0]!).toBe(false);
  });

  it("choosing Offset while the Start box waits gives the depth box back", () => {
    const h = harness();
    h.create();
    const dim = () => (h.tool as unknown as { dim: { isActive: boolean } }).dim.isActive;
    expect(dim(), "precondition: the depth box is up").toBe(true);
    h.chip("Object").dispatch("click");
    expect(dim(), "Enter in the depth box could commit while the Start box waits").toBe(false);
    h.chip("Offset").dispatch("click");
    expect(dim(), "the depth box stayed away, so the distance could not be typed beside the arrow").toBe(true);
  });

  it("a tilted plane or a tilted line is refused on the click, saying why, and the box waits", () => {
    const h = harness();
    h.create();
    h.chip("Object").dispatch("click");
    h.viewport.planeHitsAt = () => [{ id: "XZ", datum: false, distance: 50 }];
    h.clickAt([0, 0, 90]);
    expect(h.warning()).toContain("tilted");
    expect(h.box("Start from"), "the tilted plane filled the box").toBe("Click a face, plane, point or line");
    h.viewport.planeHitsAt = () => [];

    h.clickAt([65, 0, 20]); // l2, the tilted line
    expect(h.warning()).toContain("isn't parallel");
    h.clickAt([40, 0, 15]); // l1, level
    expect(h.box("Start from")).toBe("Sketch line");
    expect(h.warning(), "the refusal outlived the good pick").toBe("");
  });

  it("a construction plane parallel to the sketch is a start", () => {
    const h = harness();
    h.create();
    h.chip("Object").dispatch("click");
    h.viewport.planeHitsAt = () => [{ id: "d1", datum: true, distance: 30 }];
    h.clickAt([0, 0, 90]);
    expect(h.box("Start from")).toBe("Plane1");
    h.ok();
    expect(h.added[0]).toMatchObject({ startFrom: { kind: "plane", plane: "d1" } });
  });

  it("a face is stored as the sidecar's by:\"match\" fingerprint, never the clicked point", async () => {
    const h = harness();
    h.create();
    h.chip("Object").dispatch("click");
    const nearest: Selector = { kind: "face", by: "nearest", point: [90, 2, 15] };
    h.viewport.pickEntity = () => ({ kind: "face" });
    h.viewport.pickFaceForPressPull = () => ({ selector: nearest, faceId: 3, bodyId: "body1", normal: new THREE.Vector3(0, 0, 1), anchor: new THREE.Vector3(90, 2, 15) });
    h.viewport.pickFacePlane = () => ({ origin: [0, 0, 15], normal: [0, 0, 1], xdir: [1, 0, 0] });
    h.viewport.faceAnchor = () => ({ ...nearest, body: "body1" });
    h.clickAt([90, 0, 15]);
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]!.items).toEqual([{ kind: "face", body: "body1", sel: nearest }]);
    expect(h.queries[0]!.editingId, "a new extrude asks about the whole model").toBeNull();
    expect(h.box("Start from")).toBe("Reading the pick");
    // OK waits for the reply rather than committing without the start
    h.ok();
    expect(h.added).toEqual([]);
    expect(h.warning()).toContain("still reading");

    const top: Selector = { kind: "face", by: "match", fp: { centroid: [90, 0, 15], normal: [0, 0, 1], area: 100, surface: "plane" } };
    await h.answer(top);
    expect(h.box("Start from")).toBe("Picked face");
    h.ok();
    expect((h.added[0] as { startFrom: unknown }).startFrom).toEqual({ kind: "face", face: { ...top, body: "body1" } });
  });

  it("a curved or a tilted face is refused on the click", () => {
    const h = harness();
    h.create();
    h.chip("Object").dispatch("click");
    h.viewport.pickEntity = () => ({ kind: "face" });
    const face = (normal: [number, number, number]) => ({
      selector: { kind: "face", by: "nearest", point: [90, 0, 5] }, faceId: 3, bodyId: "body1",
      normal: new THREE.Vector3(...normal), anchor: new THREE.Vector3(90, 0, 5),
    });
    h.viewport.pickFaceForPressPull = () => face([1, 0, 0]);
    h.viewport.pickFacePlane = () => ({ origin: [90, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0] });
    h.viewport.faceAnchor = () => ({ kind: "face", by: "nearest", point: [90, 0, 5], body: "body1" });
    h.clickAt([90, 0, 5]);
    expect(h.warning()).toContain("tilted");
    h.viewport.faceAnchor = () => null; // not flat
    h.clickAt([90, 0, 5]);
    expect(h.warning()).toContain("curved");
    expect(h.queries, "a refused face was sent to be stored").toEqual([]);
  });

  it("a reply that a clear overtook is dropped", async () => {
    const h = harness();
    h.create();
    h.chip("Object").dispatch("click");
    h.viewport.pickVertexAt = () => ({ point: new THREE.Vector3(90, 0, 15), edges: [VERTICAL] });
    h.clickAt([90, 0, 15]);
    expect(h.queries).toHaveLength(1);
    h.chip("Profile plane").dispatch("click");
    await h.answer(VERTICAL_FP);
    h.ok();
    expect("startFrom" in h.added[0]!, "a late reply put back a start the user had cleared").toBe(false);
  });
});

describe("Up to a point or a line", () => {
  it("a sketch point and a level sketch line are targets; a tilted line is refused", () => {
    const h = harness();
    h.create();
    h.internals.onKey(h.keyAt("t"));
    h.clickAt([65, 0, 20]); // l2
    expect(h.warning()).toContain("isn't parallel");
    expect(h.added).toEqual([]);
    h.clickAt([40, 0, 15]); // l1
    expect(h.box("Up to")).toBe("Sketch line");
    // with a target set, a click on another one aims there instead
    h.clickAt([5, 0, 12]); // p1
    expect(h.box("Up to")).toBe("Sketch point");
    h.type("Target offset", "-2");
    h.ok();
    expect(h.added[0]).toMatchObject({ upToRef: { kind: "sketchPoint", sketch: "s2", entity: "p1", pointIndex: 0 }, upToOffset: -2 });
    expect("upToPlane" in h.added[0]! || "upTo" in h.added[0]!, "two targets at once, which the build refuses").toBe(false);
  });

  it("an arc is not a line", () => {
    const h = harness();
    h.create();
    h.internals.onKey(h.keyAt("t"));
    h.clickAt([-50, 0, 50]); // on the arc, away from its ends and centre
    expect(h.warning()).toContain("isn't a straight line");
  });

  it("an origin plane is a target while the pick is open", () => {
    const h = harness();
    h.create();
    h.internals.onKey(h.keyAt("t"));
    expect(last(h.planesShown)).toBe(true);
    h.viewport.planeHitsAt = () => [{ id: "YZ", datum: false, distance: 50 }];
    h.clickAt([0, 0, 90]);
    expect(h.box("Up to")).toBe("YZ plane");
    h.ok();
    expect(h.added[0]).toMatchObject({ upToPlane: "YZ" });
  });

  it("a body edge is authored by the sidecar and stored by fingerprint with its body", async () => {
    const h = harness();
    h.create();
    h.internals.onKey(h.keyAt("t"));
    h.viewport.pickEntity = () => ({ kind: "edge", edge: TOP, selector: nearestOf(TOP) });
    h.clickAt([90, 0, 15]);
    expect(h.queries[0]!.items).toEqual([{ kind: "edge", body: "body1", sel: nearestOf(TOP) }]);
    await h.answer(TOP_FP);
    expect(h.box("Up to")).toBe("Edge");
    h.ok();
    expect((h.added[0] as { upToRef: unknown }).upToRef).toEqual({ kind: "edge", edge: { ...TOP_FP, body: "body1" } });
  });

  it("a vertical edge is refused before anything is sent; a curved one answered by the sidecar is too", async () => {
    const h = harness();
    h.create();
    h.internals.onKey(h.keyAt("t"));
    h.viewport.pickEntity = () => ({ kind: "edge", edge: VERTICAL, selector: nearestOf(VERTICAL) });
    h.clickAt([90, 0, 7]);
    expect(h.warning()).toContain("isn't parallel");
    expect(h.queries).toEqual([]);
    // a flat-looking edge that turns out to be an arc
    h.viewport.pickEntity = () => ({ kind: "edge", edge: TOP, selector: nearestOf(TOP) });
    h.clickAt([90, 0, 15]);
    await h.answer({ kind: "edge", by: "match", fp: { mid: [90, 0, 15], dir: [1, 0, 0], length: 11, curve: "circle", radius: 30 } });
    expect(h.warning()).toContain("isn't straight");
    expect(h.box("Up to")).toBe("Click a face, plane, point or line");
  });

  it("a corner is an END of a fingerprinted edge, numbered along the fingerprint's direction", async () => {
    for (const [z, end] of [[15, 1], [0, 0]] as const) {
      const h = harness();
      h.create();
      h.internals.onKey(h.keyAt("t"));
      h.viewport.pickVertexAt = () => ({ point: new THREE.Vector3(90, 0, z), edges: [VERTICAL] });
      h.clickAt([90, 0, z]);
      expect(h.queries[0]!.items[0], "a corner was not sent as its edge").toEqual({ kind: "edge", body: "body1", sel: nearestOf(VERTICAL) });
      await h.answer(VERTICAL_FP);
      expect(h.box("Up to")).toBe("Corner");
      h.ok();
      expect((h.added[0] as { upToRef: unknown }).upToRef, `the corner at z=${z}`).toEqual({
        kind: "vertex", edge: { ...VERTICAL_FP, body: "body1" }, end,
      });
    }
  });
});

describe("an edit reopens the start and the target", () => {
  it("shows them in their boxes and writes them back untouched", () => {
    const start = { kind: "sketchPoint", sketch: "s2", entity: "p1", pointIndex: 0 };
    const end = { kind: "vertex", edge: { ...VERTICAL_FP, body: "body1" }, end: 1 };
    const h = harness({ saved: { startFrom: start, startOffset: 1, upToRef: end } });
    expect(h.tool.startEdit("ex1", () => {})).toBe(true);
    expect(h.chip("Object").classList.contains("on")).toBe(true);
    expect(h.box("Start from")).toBe("Sketch point");
    expect(h.box("Up to")).toBe("Corner");
    expect(last(h.previews), "the edit did not preview its start and target").toMatchObject({ startFrom: start, upToRef: end });
    h.ok();
    expect(h.added[0]).toMatchObject({ startFrom: start, startOffset: 1, upToRef: end });
  });
});

describe("Extrude started on a selected face", () => {
  const fromFace = (normal: [number, number, number]) => ({
    selector: { kind: "face", by: "nearest", point: [90, 2, 15], body: "body1" } as Selector,
    bodyId: "body1",
    normal: new THREE.Vector3(...normal),
    anchor: new THREE.Vector3(90, 2, 15),
  });

  it("starts from that face once the profile is picked, with a start offset measured from it", async () => {
    const h = harness();
    const start = (h.tool.start as (done: () => void, o: object) => void).bind(h.tool);
    h.overlay.toggleRegionSelection(h.overlay.regions.find((wr) => wr.region.entityIds.includes("ra"))!, false);
    start(() => {}, { fromFace: fromFace([0, 0, 1]) });
    expect(h.chip("Object").classList.contains("on")).toBe(true);
    expect(h.queries[0]!.items).toEqual([{ kind: "face", body: "body1", sel: fromFace([0, 0, 1]).selector }]);
    const top: Selector = { kind: "face", by: "match", fp: { centroid: [90, 0, 15], normal: [0, 0, 1], area: 100, surface: "plane" } };
    await h.answer(top);
    h.type("Start offset", "3");
    h.ok();
    expect(h.added[0]).toMatchObject({ startFrom: { kind: "face", face: { ...top, body: "body1" } }, startOffset: 3 });
  });

  it("a face that is not parallel to the profile is refused, and the Start box waits for another", () => {
    const h = harness();
    const start = (h.tool.start as (done: () => void, o: object) => void).bind(h.tool);
    h.overlay.toggleRegionSelection(h.overlay.regions.find((wr) => wr.region.entityIds.includes("ra"))!, false);
    start(() => {}, { fromFace: fromFace([1, 0, 0]) });
    expect(h.queries).toEqual([]);
    expect(h.warning()).toContain("tilted");
    expect(h.rowOf("Start from").classList.contains("active"), "the box is not waiting for a click").toBe(true);
  });
});

// Review of the first cut, driven in the real app: a rectangle's side was
// refused as "isn't a straight line" and, because a sketch curve outranked the
// body, a rectangle drawn on a face stopped that face being picked near it; a
// sketch BEHIND a body took clicks aimed at the body; an origin plane in front
// of a construction plane could not be clicked; and a start object froze the
// operation guess, so a recess typed as -2 from a lid's start face stayed Join.
describe("what a click names, after review", () => {
  /** A flat face of body1 under the cursor, 30 above the sketch. */
  const faceUnder = (h: ReturnType<typeof harness>) => {
    const nearest: Selector = { kind: "face", by: "nearest", point: [160, 0, 30] };
    h.viewport.pickEntity = () => ({ kind: "face" });
    h.viewport.pickFaceForPressPull = () => ({ selector: nearest, faceId: 3, bodyId: "body1", normal: new THREE.Vector3(0, 0, 1), anchor: new THREE.Vector3(160, 0, 30) });
    h.viewport.pickFacePlane = () => ({ origin: [0, 0, 30], normal: [0, 0, 1], xdir: [1, 0, 0] });
    h.viewport.faceAnchor = () => ({ ...nearest, body: "body1" });
    return nearest;
  };

  it("a side of a rectangle, polygon or slot is a line, named the way its sketch's constraints name it (R3)", () => {
    // the middle of each side, with no body behind it, and a plane far
    // behind that is not what was aimed at
    const sides: [[number, number, number], string][] = [
      [[160, 0, 30], "rq~2"],
      [[160, 0, 20], "rq~0"],
      [[220, 0, 25 + 10 * Math.sin(Math.PI / 3)], "hx~1"],
      [[275, 0, 30], "sl~0"],
      [[275, 0, 20], "sl~1"],
    ];
    for (const [at, entity] of sides) {
      const h = harness();
      h.create();
      h.internals.onKey(h.keyAt("t"));
      h.viewport.planeHitsAt = () => [{ id: "d1", datum: true, distance: 200 }];
      h.clickAt(at);
      expect(h.box("Up to"), entity).toBe("Sketch line");
      expect(h.warning(), entity).toBe("");
      h.ok();
      expect(h.added[0], entity).toMatchObject({ upToRef: { kind: "sketchLine", sketch: "s2", entity } });
    }
  });

  it("a side square to the profile is refused like a tilted line, and a slot's round end is no line", () => {
    const h = harness();
    h.create();
    h.internals.onKey(h.keyAt("t"));
    h.viewport.planeHitsAt = () => [{ id: "d1", datum: true, distance: 200 }];
    h.clickAt([170, 0, 25]); // rq's right side
    expect(h.warning()).toContain("isn't parallel");
    h.clickAt([295, 0, 25]); // the tip of sl's round end
    expect(h.warning()).toContain("isn't a straight line");
    expect(h.box("Up to")).toBe("Click a face, plane, point or line");
    // a curve that is no line gives way to a face behind it
    const nearest = faceUnder(h);
    h.clickAt([295, 0, 25]);
    expect(h.box("Up to"), "the round end blocked the face behind it").toBe("Picked face");
    h.ok();
    expect(h.added[0]).toMatchObject({ upTo: nearest });
  });

  it("a side as the start: the arrow starts on it, and an edit reopens it and writes it back untouched", () => {
    const start = { kind: "sketchLine", sketch: "s2", entity: "rq~2" };
    const h = harness();
    h.create();
    h.chip("Object").dispatch("click");
    h.clickAt([160, 0, 30]);
    expect(h.box("Start from")).toBe("Sketch line");
    h.ok();
    expect(h.added[0]).toMatchObject({ startFrom: start });

    const e = harness({ saved: { startFrom: start, startOffset: 1 } });
    expect(e.tool.startEdit("ex1", () => {})).toBe(true);
    expect(e.box("Start from")).toBe("Sketch line");
    // measured off the document before any build: the top side is at 30
    expect((e.tool as unknown as { effectiveStart(): number }).effectiveStart()).toBe(31);
    e.ok();
    expect(e.added[0]).toMatchObject({ startFrom: start, startOffset: 1 });
  });

  it("a sketch point or line hidden behind a body does not take a click aimed at the body", async () => {
    const h = harness();
    h.create();
    h.chip("Object").dispatch("click");
    faceUnder(h);
    // the reference sketch stands behind the body at every pixel
    h.viewport.behindSurfaceAt = () => () => true;
    h.clickAt([5, 0, 12]); // p1
    expect(h.queries, "the hidden sketch point took the click").toHaveLength(1);
    expect(h.queries[0]!.items[0]!.kind).toBe("face");
    await h.answer({ kind: "face", by: "match", fp: { centroid: [160, 0, 30], normal: [0, 0, 1], area: 100, surface: "plane" } });
    h.chip("Object").dispatch("click");
    h.clickAt([40, 0, 15]); // l1
    expect(h.queries, "the hidden sketch line took the click").toHaveLength(2);
    // in front of the body, the same point is still the start, and the reply
    // for the face the hidden line let through, arriving after it, is dropped
    h.viewport.behindSurfaceAt = () => () => false;
    h.chip("Object").dispatch("click");
    h.clickAt([5, 0, 12]);
    expect(h.box("Start from")).toBe("Sketch point");
    await h.answer({ kind: "face", by: "match", fp: { centroid: [160, 0, 30], normal: [0, 0, 1], area: 100, surface: "plane" } });
    expect(h.box("Start from"), "a late reply overwrote a newer pick").toBe("Sketch point");
  });

  it("an origin plane in front of a construction plane is the one clicked", () => {
    const h = harness();
    h.create();
    h.internals.onKey(h.keyAt("t"));
    h.viewport.planeHitsAt = () => [
      { id: "YZ", datum: false, distance: 10 },
      { id: "d1", datum: true, distance: 40 },
    ];
    h.clickAt([0, 0, 90]);
    expect(h.box("Up to"), "the construction plane behind took the click").toBe("YZ plane");
  });

  it("a plane level with the profile is passed over for the one behind it", () => {
    const h = harness();
    h.create();
    h.chip("Object").dispatch("click");
    // XY is the profile's own plane: neither a start nor an end
    h.viewport.planeHitsAt = () => [
      { id: "XY", datum: false, distance: 10 },
      { id: "d1", datum: true, distance: 30 },
    ];
    h.clickAt([0, 0, 90]);
    expect(h.box("Start from")).toBe("Plane1");
    expect(h.warning()).toBe("");
  });

  it("a construction plane lying on an origin plane wins the tie", () => {
    const h = harness();
    h.create();
    h.internals.onKey(h.keyAt("t"));
    h.viewport.datumPlaneOf = (id: string) => ({ id, origin: [0, 0, 0], normal: [1, 0, 0] });
    h.viewport.planeHitsAt = () => [
      { id: "YZ", datum: false, distance: 10 },
      { id: "d1", datum: true, distance: 10 },
    ];
    h.clickAt([0, 0, 90]);
    expect(h.box("Up to")).toBe("Plane1");
  });

  it("a negative distance from a start object guesses Cut, as it does from the sketch (the seal recess)", () => {
    const h = harness();
    // a body from the sketch up to 12, the height of sketch point p1
    (h.store as { buildState: unknown }).buildState = { result: { mesh: { positions: [0, 0, 0] } } };
    h.viewport.pointInSolid = (p: THREE.Vector3) => p.z > 0 && p.z < 12;
    h.create();
    h.chip("Object").dispatch("click");
    h.clickAt([5, 0, 12]); // p1, on top of the body
    expect(h.chip("Join").classList.contains("on"), "+10 from the top of the body is not Join").toBe(true);
    h.type("Distance", "-2");
    expect(h.chip("Cut").classList.contains("on"), "-2 from the start object stayed Join").toBe(true);
    expect(last(h.previews), "the preview was not rebuilt as a cut").toMatchObject({ operation: "cut", distance: -2 });
    h.type("Distance", "4");
    expect(h.chip("Join").classList.contains("on")).toBe(true);
    h.type("Distance", "-2");
    h.ok();
    expect(h.added[0]).toMatchObject({ operation: "cut", distance: -2, startFrom: { kind: "sketchPoint", entity: "p1" } });
  });
});
