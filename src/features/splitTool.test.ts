// The Split Body TOOL, driven the way the user drives it: pointer events on the
// canvas, row clicks offered through the Browser's pick hook, Enter and Escape
// on the document. Everything is the real SplitTool and SplitPanel; only the
// viewport's raycasts and the store are stubs, each answering one question
// the tool asks ("which body is under (x, y)?", "where is the datum?").
//
// What it does NOT cover, stated rather than implied: real raycasts, the drawn
// preview, and the rebuild. The sidecar half is tested through
// builder.rebuild(); the app as a whole was driven headless (see the CHANGELOG
// entry's verification notes).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import { FakeEl, byClass, installFakeDocument } from "../ui/fakeDom.testkit";
import mainSrc from "../main.ts?raw";

const toasts: { text: string; kind?: string }[] = [];
const prompts: (string | null)[] = [];
vi.mock("../ui/toast", () => ({ toast: (text: string, o?: { kind?: string }) => toasts.push({ text, ...(o?.kind ? { kind: o.kind } : {}) }) }));
vi.mock("../ui/prompt", () => ({ setPrompt: (p: string | null) => prompts.push(p) }));

/** The element classes focus.isEditableTarget tests against. A plain node run
 *  has none of them; with these an <input> made by createElement is one, and
 *  any other element is not. */
class FakeInput extends FakeEl {}
class NotThisKind {}
Object.assign(globalThis, {
  HTMLInputElement: FakeInput,
  HTMLTextAreaElement: NotThisKind,
  HTMLSelectElement: NotThisKind,
  HTMLElement: NotThisKind,
});

/** fakeDom's element, plus `remove()` and an innerHTML setter that keeps the
 *  caption span the panel's buttons write (same helper as texturePanel.test). */
function makeEl(tag: string): FakeEl {
  const el = tag === "input" ? new FakeInput(tag) : new FakeEl(tag);
  Object.defineProperty(el, "innerHTML", {
    get: () => "",
    set(html: string) {
      el.children.length = 0;
      if (html.includes("<span>")) el.children.push(new FakeEl("span"));
    },
  });
  return Object.assign(el, { remove() {}, blur() {} });
}

let keyHandler: ((e: unknown) => void) | null = null;
/** #viewport-overlay: where a label anchored to the model has to mount */
const overlay = new FakeEl("div");
installFakeDocument({ "viewport-overlay": overlay });
/** window listeners (the offset arrow's release is heard there) */
const win: Record<string, ((e: unknown) => void)[]> = {};
(globalThis as Record<string, unknown>).window = {
  addEventListener: (t: string, fn: (e: unknown) => void) => { (win[t] ??= []).push(fn); },
  removeEventListener: (t: string, fn: (e: unknown) => void) => { win[t] = (win[t] ?? []).filter((f) => f !== fn); },
};
const doc = globalThis.document as unknown as Record<string, unknown>;
doc.createElement = makeEl;
doc.addEventListener = (type: string, fn: (e: unknown) => void) => { if (type === "keydown") keyHandler = fn; };
doc.removeEventListener = (type: string) => { if (type === "keydown") keyHandler = null; };
(globalThis as Record<string, unknown>).requestAnimationFrame = () => 0;
(globalThis as Record<string, unknown>).cancelAnimationFrame = () => {};

const { SplitTool } = await import("./splitTool");
const THREE = await import("three");

const XY_UP = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };
const FACE_PLANE = { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] };

interface World {
  selectedBodies: string[];
  bodyAt: string | null;
  faceDist: number | null;
  datum: { id: string; distance: number } | null;
  /** the face under the cursor is flat (faceAnchor answers) */
  flat: boolean;
  originAt: "XY" | "XZ" | "YZ" | null;
  /** the cursor is over the ViewCube's corner */
  cube: boolean;
  /** the cursor is over the offset arrow */
  arrow: boolean;
  /** each body's own box, [min, max]; unset, every body fills -10..10 */
  boxes?: Record<string, [[number, number, number], [number, number, number]]>;
  /** the face and edge selection when the tool opens; ONE selected face is
   *  what selectedFaceSketchPlane answers (a flat face of body1 at z=10) */
  selectedFaces?: number[];
  selectedEdges?: string[];
}

function harness(world: Partial<World> = {}) {
  const w: World = { selectedBodies: [], bodyAt: null, faceDist: null, datum: null, flat: true, originAt: null, cube: false, arrow: false, ...world };
  let selection = [...w.selectedBodies];
  let faces = [...(w.selectedFaces ?? [])];
  let edges = [...(w.selectedEdges ?? [])];
  const canvas: Record<string, ((e: unknown) => void)[]> = {};
  const viewport = {
    suspendPicking: false,
    domElement: {
      style: {} as Record<string, string>,
      addEventListener: (t: string, fn: (e: unknown) => void) => { (canvas[t] ??= []).push(fn); },
      removeEventListener: (t: string, fn: (e: unknown) => void) => { canvas[t] = (canvas[t] ?? []).filter((f) => f !== fn); },
    },
    getSelectedBodies: () => [...selection],
    setSelectedBodies: (ids: string[]) => { selection = [...ids]; },
    selectedFaceSketchPlane: () => (faces.length === 1 ? { plane: FACE_PLANE, face: { kind: "face", by: "nearest", point: [1, 1, 10], body: "body1" } } : null),
    getSelectedFaceIds: () => [...faces],
    deselectFaces: (ids: number[]) => { faces = faces.filter((f) => !ids.includes(f)); },
    selectFaces: (ids: number[]) => { for (const f of ids) if (!faces.includes(f)) faces.push(f); },
    clearSelection: () => { faces = []; edges = []; },
    originPlanesShown: false,
    showAllPlanes: (on: boolean) => { viewport.originPlanesShown = on; },
    hoverPlane: (p: unknown) => { viewport.hovered.push(p); },
    hoverDatum: () => {},
    hoverFaceAt: () => null,
    clearHover: () => {},
    bodiesBox: (ids: string[]) => {
      if (!ids.length) return null;
      if (!w.boxes) return new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
      const box = new THREE.Box3();
      for (const id of ids) {
        const b = w.boxes[id];
        if (b) box.union(new THREE.Box3(new THREE.Vector3(...b[0]), new THREE.Vector3(...b[1])));
      }
      return box.isEmpty() ? null : box;
    },
    modelBox: () => null,
    surfaceHitDistance: () => w.faceDist,
    datumHitAt: () => w.datum,
    pickFacePlane: () => (w.faceDist === null ? null : FACE_PLANE),
    faceAnchor: () => (w.flat ? { kind: "face", by: "nearest", point: [1, 1, 10], body: "body1" } : null),
    pickPlane: () => w.originAt,
    bodyIdAt: () => w.bodyAt,
    rayFrom: (_x: number, y: number) => ({
      intersectObjects: () => (w.arrow ? [{}] : []),
      ray: new THREE.Ray(new THREE.Vector3(0, -100, 100 - y / 10), new THREE.Vector3(0, 1, 0)),
    }),
    cubeHitsRegion: () => w.cube,
    hovered: [] as unknown[],
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 0, y: 0 }),
    projectToOverlay: () => ({ x: 10, y: 10, width: 900, height: 700 }),
    camera: { position: new THREE.Vector3(0, 0, 100), getWorldDirection: (v: InstanceType<typeof THREE.Vector3>) => v.set(0, 0, -1) },
    snapStep: () => 1,
    addToScene: () => {},
    removeFromScene: () => {},
    requestRender: () => {},
  };
  const added: Record<string, unknown>[] = [];
  const renames = new Map<string, string>();
  const replaced: { id: string; f: Record<string, unknown> }[] = [];
  const features: Record<string, unknown>[] = [{ id: "f1", type: "box" }, { id: "d1", type: "datumPlane", plane: "XY" }];
  const buildListeners = new Set<(s: unknown) => void>();
  const replaceFns: (() => void)[] = [];
  const docListeners = new Set<(d: unknown) => void>();
  const store = {
    buildState: { building: false, result: { bodies: [{ id: "body1", name: "Body1" }, { id: "body2", name: "Body2" }] } },
    document: { features },
    rollbackIndex: 2,
    isSuppressed: (_id: string) => false,
    isBodyVisible: () => true,
    bodyName: (id: string) => renames.get(id),
    nextId: () => "f9",
    isParamBound: () => false,
    addFeature: (f: Record<string, unknown>) => { added.push(f); features.push(f); },
    replaceFeature: (id: string, f: Record<string, unknown>) => { replaced.push({ id, f }); },
    beginEditPreview: () => {},
    endEditPreview: () => {},
    setBodyName: (id: string, name: string) => { if (name) renames.set(id, name); else renames.delete(id); },
    onBuild: (fn: (s: unknown) => void) => { buildListeners.add(fn); fn(store.buildState); return () => buildListeners.delete(fn); },
    onDocChange: (fn: (d: unknown) => void) => { docListeners.add(fn); fn(store.document); return () => docListeners.delete(fn); },
    onReplace: (fn: () => void) => { replaceFns.push(fn); return () => {}; },
  };
  let pickHook: ((p: unknown) => boolean) | null = null;
  const tool = new SplitTool({
    viewport: viewport as never,
    store: store as never,
    setTreePick: (fn) => { pickHook = fn as typeof pickHook; },
    datumPlane: (id) => (id === "d1" ? (XY_UP as never) : null),
    datumName: () => "Plane1",
  });
  const fire = (type: string, e: Record<string, unknown>) => { for (const fn of [...(canvas[type] ?? [])]) fn(e); };
  const click = (opts: { ctrl?: boolean; dx?: number } = {}) => {
    const base = { button: 0, clientX: 100, clientY: 100, ctrlKey: !!opts.ctrl, metaKey: false, altKey: false, buttons: 0, preventDefault() {}, stopImmediatePropagation() {} };
    fire("pointerdown", base);
    fire("pointerup", { ...base, clientX: 100 + (opts.dx ?? 0) });
  };
  const key = (k: string, target: unknown = {}) => keyHandler?.({ key: k, target, isComposing: false, preventDefault() {}, stopPropagation() {} });
  const tree = (p: unknown) => pickHook?.(p) ?? false;
  const done: (string | null)[] = [];
  const start = (seed?: { bodies?: string[]; planeId?: string }, selectedDatum: string | null = null) =>
    tool.start({ seed, selectedDatum }, (id) => done.push(id));
  /** a build state landing, the way DocumentStore publishes one */
  const emit = (state: Record<string, unknown>) => {
    (store as { buildState: unknown }).buildState = state;
    for (const fn of [...buildListeners]) fn(state);
  };
  /** an undo that takes the split back out of the document */
  const undoLast = () => {
    features.pop();
    for (const fn of [...docListeners]) fn(store.document);
  };
  const pointer = (type: string, e: Record<string, unknown> = {}) =>
    fire(type, { button: 0, clientX: 100, clientY: 100, ctrlKey: false, metaKey: false, altKey: false, buttons: 1, preventDefault() {}, stopImmediatePropagation() {}, ...e });
  const replaceDoc = () => { for (const fn of replaceFns) fn(); };
  return { tool, w, added, replaced, click, key, tree, done, start, selection: () => selection, faces: () => faces, edges: () => edges, viewport, store, features, emit, renames, undoLast, pointer, replaceDoc };
}

beforeEach(() => {
  toasts.length = 0;
  prompts.length = 0;
  keyHandler = null;
});

describe("Split Body, driven like a user", () => {
  it("preselected body + selected datum: Enter writes the contract feature", () => {
    const h = harness({ selectedBodies: ["body2"] });
    h.start(undefined, "d1");
    h.key("Enter");
    expect(h.added).toEqual([{ id: "f9", type: "split", keep: "both", groupSides: true, body: "body2", planeId: "d1", offset: 0 }]);
    expect(h.done).toEqual(["f9"]);
    expect(h.tool.active).toBe(false);
  });

  it("a click with nothing to pick does NOT commit, whichever field is active", () => {
    const h = harness({ selectedBodies: ["body2"] });
    h.start(undefined, "d1");
    h.click(); // both fields already filled, nothing armed, nothing under the cursor
    // make Tool the active field the way the user does: click its box
    const boxes = byClass((globalThis.document as unknown as { body: FakeEl }).body, "split-field");
    boxes.at(-1)!.dispatch("click");
    expect((h.tool as unknown as { state: { active: string } }).state.active).toBe("tool");
    h.click(); // Tool active, nothing under the cursor
    expect(h.added).toEqual([]);
    expect(h.tool.active).toBe(true);
  });

  it("canvas clicks fill Body, then Tool; Ctrl-click adds a second body", () => {
    const h = harness({ bodyAt: "body1" });
    h.start();
    h.click();
    h.w.bodyAt = "body2";
    // the plain click moved the active field on to Tool, so a body click now
    // is not a body pick; picking the tool first:
    h.w.faceDist = 50;
    h.click();
    // Body again, adding one with Ctrl
    h.tree({ kind: "body", id: "body2", additive: true });
    h.key("Enter");
    expect(h.added).toHaveLength(1);
    expect(h.added[0]).toMatchObject({ bodies: ["body1", "body2"], plane: FACE_PLANE, face: { body: "body1" } });
  });

  it("a Ctrl-click adds a body after a plain click has moved on to Tool (the verify run's order)", () => {
    // Open empty, click body1: Body is filled and Tool becomes the active
    // field. The Ctrl-click on body2 that follows is "this body too", as it is
    // on a Browser row. Routed by the active field it was a Tool pick: body2
    // was not added and a face of it became the splitting plane.
    const h = harness({ bodyAt: "body1", faceDist: 50 });
    h.start();
    h.click();
    h.w.bodyAt = "body2";
    h.click({ ctrl: true });
    const st = () => (h.tool as unknown as { state: { bodies: string[]; tool: unknown; active: string | null } }).state;
    expect(st().bodies).toEqual(["body1", "body2"]);
    expect(st().tool, "the Ctrl-click was taken as a splitting-tool pick").toBeNull();
    expect(st().active).toBe("tool");
    // and the next plain click still picks the tool
    h.click();
    h.key("Enter");
    expect(h.added[0]).toMatchObject({ bodies: ["body1", "body2"], plane: FACE_PLANE, face: { body: "body1" } });
  });

  it("a Ctrl-click with the tool already chosen adds the body and keeps the tool", () => {
    const h = harness({ selectedBodies: ["body1"], bodyAt: "body2", faceDist: 50 });
    h.start(undefined, "d1");
    h.click({ ctrl: true });
    h.key("Enter");
    expect(h.added[0]).toMatchObject({ bodies: ["body1", "body2"], planeId: "d1" });
    expect(h.added[0]).not.toHaveProperty("face");
  });

  it("with both fields filled, a click that misses the arrow does not re-aim the cut", () => {
    // The arrow is a 3 px shaft over the middle of the body: a press beside it
    // lands on the body's face. Taken as a Tool pick, it swapped the plane for
    // that face's and kept the offset (an XY cut at +12 became top face +12).
    const h = harness({ selectedBodies: ["body1"], bodyAt: "body1", faceDist: 50 });
    h.start(); // Body filled, Tool active
    h.tree({ kind: "origin", plane: "XY" }); // the tool, picked with Body already filled
    (h.tool as unknown as { state: { offset: number } }).state.offset = 5;
    h.click(); // a press beside the arrow, on the body's face
    h.key("Enter");
    expect(h.added[0]).toMatchObject({ body: "body1", plane: "XY", offset: 5 });
    expect(h.added[0], "the stray click re-aimed the cut at the face").not.toHaveProperty("face");
  });

  it("OK refuses a body the user picked that the plane cannot reach, and names it", () => {
    // The union of the targets' boxes straddles the plane as soon as one of
    // them does, and the sidecar records a missed body of a split over several
    // without a word. Stub: body1 -10..10, body2 a 3 mm box at z 0..3, plane
    // z=5 (the XY datum, offset 5).
    const h = harness({
      selectedBodies: ["body1", "body2"],
      boxes: { body1: [[-10, -10, -10], [10, 10, 10]], body2: [[20, 0, 0], [23, 3, 3]] },
    });
    h.start(undefined, "d1");
    (h.tool as unknown as { state: { offset: number } }).state.offset = 5;
    h.key("Enter");
    expect(h.added).toEqual([]);
    expect(prompts.at(-1)).toBe(t("feature.split.planeMissesBody", { name: "Body2" }));
    // taken out with a Ctrl-click, the rest is cut
    h.w.bodyAt = "body2";
    h.click({ ctrl: true });
    h.key("Enter");
    expect(h.added[0]).toMatchObject({ body: "body1", planeId: "d1", offset: 5 });
  });

  it("an edited split's saved bodies are not refused: an old cut-all names every visible body", () => {
    // Its plane misses most of them by design. Refused, "edit the split and
    // press OK" (splitLegacyFailed) could not be done without Ctrl-clicking out
    // every body the plane misses first.
    const boxes: World["boxes"] = { body1: [[-10, -10, -10], [10, 10, 10]], body2: [[20, 0, 0], [23, 3, 3]] };
    const h = harness({ boxes });
    const cutAll = { id: "f5", type: "split", keep: "both", planeId: "d1", bodies: ["body1", "body2"], groupSides: true, offset: 5 };
    h.features.push(cutAll);
    (h.store as { rollbackIndex: number }).rollbackIndex = h.features.length;
    expect(h.tool.startEdit("f5", () => {})).toBe(true);
    h.emit({ building: true, result: h.store.buildState.result });
    h.emit({ building: false, result: h.store.buildState.result });
    h.key("Enter");
    expect(h.replaced).toEqual([{ id: "f5", f: { ...cutAll } }]);
  });

  it("the Faces/Bodies switch does not leave the targets unlit", () => {
    // Going to Faces clears the viewport's body selection, and the targets are
    // painted AS that selection: OK would still cut them, with nothing lit.
    const h = harness({ selectedBodies: ["body1"] });
    h.start(undefined, "d1");
    h.viewport.setSelectedBodies([]); // what setSelectionMode("faces") does
    h.tool.selectionModeChanged();
    expect(h.selection()).toEqual(["body1"]);
    // main.ts tells the tool after both of its switch actions
    for (const arm of ['case "selmode": {', 'case "selmode-bodies": {']) {
      const at = mainSrc.indexOf(arm);
      expect(at, `no ${arm} in main.ts`).toBeGreaterThan(-1);
      const body = mainSrc.slice(at, mainSrc.indexOf("break;", at));
      expect(body, `${arm} does not tell the split tool`).toContain("splitTool.selectionModeChanged()");
    }
  });

  it("a datum lying ON the face under the cursor wins", () => {
    const h = harness({ selectedBodies: ["body1"], faceDist: 80, datum: { id: "d1", distance: 80 } });
    h.start();
    h.click();
    h.key("Enter");
    expect(h.added[0]).toMatchObject({ planeId: "d1" });
    expect(h.added[0]).not.toHaveProperty("face");
  });

  it("a curved face is refused in words and the Tool stays empty", () => {
    const h = harness({ selectedBodies: ["body1"], faceDist: 80, flat: false });
    h.start();
    h.click();
    expect(toasts).toEqual([{ text: t("feature.split.curvedFace"), kind: "warning" }]);
    h.key("Enter");
    expect(h.added).toEqual([]);
    expect(prompts.at(-1)).toBe(t("feature.split.needTool"));
  });

  it("the tool's row hook takes an origin row as the Tool (the tree's side: browserTreePick.test)", () => {
    const h = harness({ selectedBodies: ["body1"] });
    h.start();
    expect(h.tree({ kind: "origin", plane: "XZ" }), "the row click was not consumed, so the tree would start a sketch").toBe(true);
    h.key("Enter");
    expect(h.added[0]).toMatchObject({ plane: "XZ", body: "body1" });
  });

  it("the Browser hook is released when the tool ends", () => {
    const h = harness({ selectedBodies: ["body1"] });
    h.start();
    h.key("Escape");
    expect(h.tree({ kind: "origin", plane: "XY" })).toBe(false);
  });

  it("Escape cancels, writes nothing, and gives back the selection it painted over", () => {
    const h = harness({ selectedBodies: ["body2"] });
    h.start({ bodies: ["body1"] }, "d1");
    expect(h.selection()).toEqual(["body1"]); // the target is painted as the selection
    h.key("Escape");
    expect(h.added).toEqual([]);
    expect(h.done).toEqual([null]);
    expect(h.selection()).toEqual(["body2"]);
  });

  it("OK with no body names the missing field instead of writing half a feature", () => {
    const h = harness();
    h.start(undefined, "d1");
    h.key("Enter");
    expect(h.added).toEqual([]);
    expect(prompts.at(-1)).toBe(t("feature.split.needBody"));
  });

  it("OK refuses a plane that cannot reach the bodies, before any rebuild", () => {
    // the stub's targets fill -10..10; an XY datum moved to z=+50 misses them
    const h = harness({ selectedBodies: ["body1"] });
    h.start(undefined, "d1");
    (h.tool as unknown as { state: { offset: number } }).state.offset = 50;
    h.key("Enter");
    expect(h.added).toEqual([]);
    expect(prompts.at(-1)).toBe(t("feature.split.planeMisses"));
  });

  it("a focused Cancel button keeps Enter for itself", () => {
    const h = harness({ selectedBodies: ["body1"] });
    h.start(undefined, "d1");
    const cancel = (h.tool as unknown as { panel: { cancelButton: unknown } }).panel.cancelButton;
    h.key("Enter", cancel);
    expect(h.added).toEqual([]);
    expect(h.tool.active).toBe(true);
  });
});

describe("re-opening a split", () => {
  it("an old split OK'd unchanged is written back exactly as it was", () => {
    // No `offset` is what tells the sidecar to rebuild it the old way, which
    // keeps its pieces behind the same positional ids (splitState.editedSplit).
    const h = harness();
    const old = { id: "f5", type: "split", keep: "top", plane: FACE_PLANE, body: "body1" };
    h.features.push(old);
    expect(h.tool.startEdit("f5", () => {})).toBe(true);
    h.emit({ building: true, result: h.store.buildState.result });
    h.emit({ building: false, result: h.store.buildState.result });
    h.key("Enter");
    expect(h.replaced).toEqual([{ id: "f5", f: old }]);
  });

  it("an old split whose keep changed becomes a panel split, carrying its missing groupSides", () => {
    const h = harness();
    h.features.push({ id: "f5", type: "split", keep: "top", plane: FACE_PLANE, body: "body1" });
    expect(h.tool.startEdit("f5", () => {})).toBe(true);
    h.emit({ building: true, result: h.store.buildState.result });
    h.emit({ building: false, result: h.store.buildState.result });
    const chips = byClass((globalThis.document as unknown as { body: FakeEl }).body, "tool-chip");
    chips.at(-3)!.dispatch("click"); // Both, the way the user changes it
    h.key("Enter");
    expect(h.replaced).toEqual([{ id: "f5", f: { id: "f5", type: "split", keep: "both", body: "body1", plane: FACE_PLANE, offset: 0 } }]);
  });

  it("an old split whose old way failed is converted by OK, as its red message says", () => {
    // splitLegacyFailed: "Edit the split and press OK to cut it part by part".
    // Written back unchanged, it stayed an old split and stayed red.
    const h = harness();
    const old = { id: "f5", type: "split", keep: "both", plane: FACE_PLANE, body: "body1", groupSides: true };
    h.features.push(old);
    (h.store.buildState.result as Record<string, unknown>).featureErrors = [{ feature_id: "f5", message: "x", code: "splitLegacyFailed" }];
    expect(h.tool.startEdit("f5", () => {})).toBe(true);
    h.emit({ building: true, result: h.store.buildState.result });
    h.emit({ building: false, result: h.store.buildState.result });
    h.key("Enter");
    expect(h.replaced).toEqual([{ id: "f5", f: { ...old, offset: 0 } }]);
  });

  it("declines an offset driven by a parameter, so the inspector takes it", () => {
    const h = harness();
    h.features.push({ id: "f5", type: "split", keep: "top", plane: "XY", body: "body1", offset: "gap" });
    expect(h.tool.startEdit("f5", () => {})).toBe(false);
    expect(h.tool.active).toBe(false);
  });
});

describe("after the split has built", () => {
  const built = (ids: string[], errs: { feature_id: string }[] = []) => ({
    building: false,
    result: { bodies: ids.map((id) => ({ id, name: id })), featureErrors: errs },
  });

  it("selects every piece, and writes no rename onto them", () => {
    // A renamed body's pieces are NAMED by the store from the build's own
    // lineage (store.bodyName, pieceOf). Written as renames they stayed on
    // whatever body later took the positional id.
    const h = harness({ selectedBodies: ["body1"] });
    h.renames.set("body1", "Bracket");
    h.start(undefined, "d1");
    h.key("Enter");
    h.emit({ building: true, result: h.store.buildState.result });
    h.emit(built(["body1", "body2", "body3"]));
    expect(h.selection()).toEqual(["body1", "body3"]);
    expect([...h.renames.keys()], "the tool wrote a rename").toEqual(["body1"]);
  });

  it("selects only the targets the split CHANGED: an All-visible cut leaves the missed ones unselected", () => {
    // Field file: "All visible" at its datum selected all 583 bodies after the
    // cut, the 193 the plane missed included, so the next Move or Export acted
    // on the whole assembly.
    const h = harness();
    const stamped = (list: [string, string][]) => ({ building: false, result: { bodies: list.map(([id, etag]) => ({ id, name: id, etag })), featureErrors: [] } });
    h.emit(stamped([["body1", "a"], ["body2", "b"]]));
    h.start();
    h.tree({ kind: "origin", plane: "XY" });
    // tick "All visible bodies", the way the user does
    const panel = (h.tool as unknown as { panel: { allVisible: FakeEl & { checked: boolean } } }).panel;
    panel.allVisible.checked = true;
    panel.allVisible.dispatch("change");
    h.key("Enter");
    expect(h.added[0]).toMatchObject({ bodies: ["body1", "body2"] });
    h.emit({ building: true, result: h.store.buildState.result });
    h.emit(stamped([["body1", "a2"], ["body2", "b"], ["body3", "c"]]));
    expect(h.selection(), "the body the plane missed was selected as a piece").toEqual(["body1", "body3"]);
  });

  it("ignores a rebuild that was already running when OK was pressed", () => {
    const h = harness({ selectedBodies: ["body1"] });
    (h.store.buildState as { building: boolean }).building = true; // one in flight
    h.start(undefined, "d1");
    h.key("Enter");
    // the in-flight build settles first, WITHOUT the split: a stranger body4
    // (some other feature's) must not be taken for a piece
    h.emit(built(["body1", "body2", "body4"]));
    expect(h.selection(), "the stale build was read as the split's result").toEqual([]);
    h.emit({ building: true, result: null });
    h.emit(built(["body1", "body2", "body3"]));
    expect(h.selection()).toEqual(["body1", "body3"]);
  });

  it("does nothing when the split failed: the red toast is the answer", () => {
    const h = harness({ selectedBodies: ["body1"] });
    h.renames.set("body1", "Bracket");
    h.start(undefined, "d1");
    h.key("Enter");
    h.emit({ building: true, result: h.store.buildState.result });
    h.emit(built(["body1", "body2", "body3"], [{ feature_id: "f9" }]));
    expect(h.renames.size).toBe(1);
    expect(h.selection()).toEqual([]);
  });
});

describe("what the tool must NOT take over", () => {
  it("Enter and Escape in a text field OUTSIDE the panel stay that field's", () => {
    // The Ctrl+K palette, a Browser rename, an inspector field: Enter there
    // committed the split, Escape there cancelled the whole command.
    const h = harness({ selectedBodies: ["body1"] });
    h.start(undefined, "d1");
    const foreign = new FakeInput("input");
    h.key("Enter", foreign);
    h.key("Escape", foreign);
    expect(h.added).toEqual([]);
    expect(h.tool.active).toBe(true);
    // the panel's own Offset field still commits on Enter
    const panel = (h.tool as unknown as { panel: { root: FakeEl } }).panel.root;
    const offset = byClass(panel, "tool-panel-input").at(0) ?? panel.querySelector("input")!;
    expect(offset).toBeInstanceOf(FakeInput);
    h.key("Enter", offset);
    expect(h.added).toHaveLength(1);
  });

  it("a release OFF the canvas ends the arrow drag, and so does a move with the button up", () => {
    const h = harness({ selectedBodies: ["body1"], arrow: true });
    h.start(undefined, "d1");
    const grabbing = () => (h.tool as unknown as { grabbing: boolean }).grabbing;
    const offset = () => (h.tool as unknown as { state: { offset: number } }).state.offset;
    h.pointer("pointerdown");
    expect(grabbing()).toBe(true);
    // let go over the docked panel: the canvas never hears it, the window does
    for (const fn of [...(win.pointerup ?? [])]) fn({ button: 0 });
    expect(grabbing(), "the arrow stayed latched after a release off the canvas").toBe(false);
    h.pointer("pointermove", { clientY: 40, buttons: 0 });
    expect(offset()).toBe(0);
    // the button came up where nothing told us: the next bare move lets go
    h.pointer("pointerdown");
    h.pointer("pointermove", { clientY: 60, buttons: 0 });
    expect(grabbing()).toBe(false);
    expect(win.pointerup ?? [], "the window listener outlived the drag").toHaveLength(0);
  });

  it("a click on the ViewCube is not a pick of the body behind it", () => {
    const h = harness({ selectedBodies: ["body1", "body2"], bodyAt: "body2", cube: true });
    h.start(undefined, "d1");
    h.click();
    expect((h.tool as unknown as { state: { bodies: string[] } }).state.bodies).toEqual(["body1", "body2"]);
  });

  it("a datum from a right-click seed or the selection is checked like a clicked one", () => {
    // The Browser offers "Split bodies with this plane…" on every datum row,
    // past the rollback marker and suppressed ones included. Unchecked, the
    // panel drew a preview, took OK and wrote a split that went red.
    const h = harness({ selectedBodies: ["body1"] });
    h.features.push({ id: "d2", type: "datumPlane", plane: "XY" }); // after the rollback point (2)
    h.start({ planeId: "d2" });
    expect(toasts.at(-1)).toEqual({ text: t("feature.split.planeNotYet", { name: "Plane1" }), kind: "warning" });
    expect((h.tool as unknown as { state: { tool: unknown; active: string } }).state).toMatchObject({ tool: null, active: "tool" });
    h.key("Enter");
    expect(h.added).toEqual([]);
    h.key("Escape");
    // the selected datum too
    const g = harness({ selectedBodies: ["body1"] });
    g.store.isSuppressed = (id: string) => id === "d1";
    g.start(undefined, "d1");
    expect(toasts.at(-1)).toEqual({ text: t("feature.split.planeSuppressed", { name: "Plane1" }), kind: "warning" });
    expect((g.tool as unknown as { state: { tool: unknown } }).state.tool).toBeNull();
  });

  it("a suppressed datum made BEFORE the split is refused for being suppressed, not for coming later", () => {
    const h = harness({ selectedBodies: ["body1"] });
    h.store.isSuppressed = (id: string) => id === "d1";
    h.start();
    h.tree({ kind: "datum", id: "d1" });
    expect(toasts.at(-1)).toEqual({ text: t("feature.split.planeSuppressed", { name: "Plane1" }), kind: "warning" });
    expect((h.tool as unknown as { state: { tool: unknown } }).state.tool).toBeNull();
  });

  it("a datum later in the timeline, or suppressed, is refused in words (Browser and canvas)", () => {
    const h = harness({ selectedBodies: ["body1"] });
    h.features.push({ id: "d2", type: "datumPlane", plane: "XY" }); // after the rollback point (2)
    h.start();
    expect(h.tree({ kind: "datum", id: "d2" })).toBe(true);
    expect(toasts.at(-1)).toEqual({ text: t("feature.split.planeNotYet", { name: "Plane1" }), kind: "warning" });
    expect((h.tool as unknown as { state: { tool: unknown } }).state.tool).toBeNull();
    h.w.datum = { id: "d2", distance: 50 };
    h.click();
    expect((h.tool as unknown as { state: { tool: unknown } }).state.tool).toBeNull();
    // one made before the split is fine
    h.tree({ kind: "datum", id: "d1" });
    expect((h.tool as unknown as { state: { tool: unknown } }).state.tool).toEqual({ kind: "datum", id: "d1" });
  });

  it("while editing, the edited split's own position decides which datums exist", () => {
    const h = harness();
    h.features.push({ id: "f5", type: "split", keep: "top", planeId: "d1", body: "body1", offset: 0 });
    h.features.push({ id: "d3", type: "datumPlane", plane: "XY" }); // after the split
    (h.store as { rollbackIndex: number }).rollbackIndex = h.features.length;
    h.tool.startEdit("f5", () => {});
    h.emit({ building: true, result: h.store.buildState.result });
    h.emit({ building: false, result: h.store.buildState.result });
    h.tree({ kind: "datum", id: "d3" });
    expect((h.tool as unknown as { state: { tool: unknown } }).state.tool).toEqual({ kind: "datum", id: "d1" });
  });

  it("an edit waits for the ROLLED-BACK model when a build was already running", () => {
    // That build settles first, with the whole timeline in it; read as the
    // rollback, an old split with no body got the full model's LAST body.
    const h = harness();
    h.features.push({ id: "f5", type: "split", keep: "both", plane: FACE_PLANE, offset: 0 });
    (h.store.buildState as { building: boolean }).building = true;
    h.tool.startEdit("f5", () => {});
    h.emit({ building: false, result: { bodies: [{ id: "body1", name: "b" }, { id: "body2", name: "b" }, { id: "body3", name: "b" }] } });
    h.emit({ building: true, result: null });
    h.emit({ building: false, result: { bodies: [{ id: "body1", name: "b" }] } });
    h.key("Enter");
    expect(h.replaced[0]?.f).toMatchObject({ body: "body1" });
  });

  it("opening another document ends the tool instead of leaving it armed with stale ids", () => {
    const h = harness({ selectedBodies: ["body1"] });
    h.start(undefined, "d1");
    h.replaceDoc();
    expect(h.tool.active).toBe(false);
    h.key("Enter");
    expect(h.added).toEqual([]);
  });

  it("hovering where a HIDDEN origin plane runs does not light it up", () => {
    const h = harness({ selectedBodies: ["body1"], originAt: "XY" });
    h.start(undefined, "d1"); // the Tool is filled, so the origin planes are hidden
    (h.tool as unknown as { state: { active: string } }).state.active = "tool";
    (h.tool as unknown as { hover: (x: number, y: number) => void }).hover(100, 100);
    expect(h.viewport.hovered.at(-1)).toBeNull();
  });

  it("the Above label mounts in the viewport's clipped overlay, not on <body>", () => {
    const h = harness({ selectedBodies: ["body1"] });
    overlay.children.length = 0; // earlier tests' markers (the stub's remove() is a no-op)
    h.start(undefined, "d1");
    expect(byClass(overlay, "split-above-marker")).toHaveLength(1);
    expect(byClass((globalThis.document as unknown as { body: FakeEl }).body, "split-above-marker")).toHaveLength(0);
    h.key("Escape");
  });
});

// The review round's findings, each driven the way the user hits it.
type Internals = {
  state: { offset: number; tool: unknown; active: string | null; bodies: string[]; allVisible: boolean };
  panel: { root: FakeEl; offset: FakeInput };
};
const inner = (tool: unknown) => tool as Internals;
/** a build landing twice: the rollback of an edit, seen starting and settling */
const settle = (h: ReturnType<typeof harness>) => {
  h.emit({ building: true, result: h.store.buildState.result });
  h.emit({ building: false, result: h.store.buildState.result });
};

describe("the offset field and the arrow agree", () => {
  it("a value typed, then the arrow dragged, then the field left: OK cuts where the preview is", () => {
    // The arrow's press keeps focus in the field. setOffset skipped a focused
    // field, so it went on holding the typed 5 while the preview moved; leaving
    // the field sent that 5 back (its `change`), and the cut jumped back.
    const h = harness({ selectedBodies: ["body1"], arrow: true });
    h.start(undefined, "d1");
    const off = inner(h.tool).panel.offset;
    doc.activeElement = off; // the caret stays in the field throughout
    try {
      off.value = "5";
      off.dispatch("input");
      expect(inner(h.tool).state.offset).toBe(5);
      h.pointer("pointerdown");
      h.pointer("pointermove", { clientY: 80 }); // up 2 mm, still inside the -10..10 targets
      for (const fn of [...(win.pointerup ?? [])]) fn({ button: 0 });
      const dragged = inner(h.tool).state.offset;
      expect(dragged, "the drag did not move the cut (the test proves nothing)").not.toBe(5);
      expect(Number(off.value), "the field kept the typed value while the preview moved").toBe(dragged);
      off.dispatch("change"); // the field loses focus
      expect(inner(h.tool).state.offset, "leaving the field put the stale typed value back").toBe(dragged);
      h.key("Enter", off);
      expect(h.added[0]).toMatchObject({ offset: dragged });
    } finally {
      delete doc.activeElement;
    }
  });
});

describe("re-opening a split whose datum cannot cut there any more", () => {
  const toolField = (h: ReturnType<typeof harness>) => byClass(inner(h.tool).panel.root, "split-field")[1]!;
  const toolText = (h: ReturnType<typeof harness>) => byClass(toolField(h), "split-field-value")[0]!.textContent;

  it("a datum moved after the split: Tool is empty and lit, said why, and Enter writes no dead planeId", () => {
    const h = harness();
    h.features.push({ id: "f5", type: "split", keep: "both", planeId: "d2", body: "body1", offset: 0 });
    h.features.push({ id: "d2", type: "datumPlane", plane: "XY" }); // now AFTER the split
    (h.store as { rollbackIndex: number }).rollbackIndex = h.features.length;
    expect(h.tool.startEdit("f5", () => {})).toBe(true);
    expect(toasts.at(-1)).toEqual({ text: t("feature.split.planeNotYet", { name: "Plane1" }), kind: "warning" });
    settle(h);
    expect(inner(h.tool).state).toMatchObject({ tool: null, active: "tool", bodies: ["body1"] });
    expect(toolText(h), "the Tool field still reads as filled").toBe(t("feature.split.toolNone"));
    expect(toolField(h).classList.contains("active")).toBe(true);
    h.key("Enter");
    expect(h.replaced, "OK wrote the planeId back").toEqual([]);
    expect(prompts.at(-1)).toBe(t("feature.split.needTool"));
    // picking a plane that exists makes it whole again
    h.tree({ kind: "datum", id: "d1" });
    h.key("Enter");
    expect(h.replaced[0]?.f).toMatchObject({ planeId: "d1", body: "body1" });
  });

  it("a deleted datum is said as deleted, not as a plane named 'Plane0'", () => {
    const h = harness();
    h.features.push({ id: "f5", type: "split", keep: "both", planeId: "d9", body: "body1", offset: 0 });
    h.tool.startEdit("f5", () => {});
    expect(toasts.at(-1)).toEqual({ text: t("feature.split.planeGone"), kind: "warning" });
    settle(h);
    h.key("Enter");
    expect(h.replaced).toEqual([]);
  });

  it("a suppressed datum is refused the same way", () => {
    const h = harness();
    h.store.isSuppressed = (id: string) => id === "d1";
    h.features.push({ id: "f5", type: "split", keep: "both", planeId: "d1", body: "body1", offset: 0 });
    h.tool.startEdit("f5", () => {});
    expect(toasts.at(-1)).toEqual({ text: t("feature.split.planeSuppressed", { name: "Plane1" }), kind: "warning" });
    settle(h);
    h.key("Enter");
    expect(h.replaced).toEqual([]);
  });

  it("OK checks the datum again: suppressed while the panel was open, it is refused, not written", () => {
    const h = harness({ selectedBodies: ["body1"] });
    h.start(undefined, "d1");
    h.store.isSuppressed = (id: string) => id === "d1"; // from the Browser, mid-command
    h.key("Enter");
    expect(h.added).toEqual([]);
    expect(prompts.at(-1)).toBe(t("feature.split.planeSuppressed", { name: "Plane1" }));
    expect(inner(h.tool).state).toMatchObject({ tool: null, active: "tool" });
  });
});

describe("All visible, as the contract has it", () => {
  it("only the 'All visible bodies (N)' choice writes allVisible: true", () => {
    const h = harness({ selectedBodies: ["body1", "body2"] });
    h.start(undefined, "d1");
    h.key("Enter");
    expect(h.added[0]).toMatchObject({ bodies: ["body1", "body2"] });
    expect(h.added[0], "explicit picks were written as All visible").not.toHaveProperty("allVisible");
    const g = harness();
    g.start(undefined, "d1");
    const all = (g.tool as unknown as { panel: { allVisible: FakeEl & { checked: boolean } } }).panel.allVisible;
    all.checked = true;
    all.dispatch("change");
    g.key("Enter");
    expect(g.added[0]).toMatchObject({ bodies: ["body1", "body2"], allVisible: true });
  });

  it("an old 'Cut all bodies' re-opened and changed stays All visible, so the bodies its plane misses stay quiet", () => {
    const h = harness();
    const old = { id: "f5", type: "split", keep: "top", planeId: "d1", bodies: ["body1", "body2"], groupSides: true };
    h.features.push(old);
    (h.store as { rollbackIndex: number }).rollbackIndex = h.features.length;
    h.tool.startEdit("f5", () => {});
    settle(h);
    expect(inner(h.tool).state.allVisible).toBe(true);
    h.key("Enter");
    expect(h.replaced[0], "an unchanged OK must write the old split back as it was").toEqual({ id: "f5", f: old });
    const g = harness();
    g.features.push({ ...old });
    (g.store as { rollbackIndex: number }).rollbackIndex = g.features.length;
    g.tool.startEdit("f5", () => {});
    settle(g);
    const chips = byClass(inner(g.tool).panel.root, "tool-chip");
    chips[0]!.dispatch("click"); // Keep: Both
    g.key("Enter");
    expect(g.replaced[0]?.f).toMatchObject({ keep: "both", bodies: ["body1", "body2"], allVisible: true, offset: 0 });
  });

  it("an old 'Cut all bodies' OK'd untouched after a body was hidden or shown is written back as it was", () => {
    // All visible lists the bodies visible at OK. Compared with the saved list,
    // a body hidden since made the untouched OK a change: the split was
    // rewritten as a panel split and the hidden body was not cut any more,
    // re-targeting every later feature that names one of its pieces.
    const old = { id: "f5", type: "split", keep: "top", planeId: "d1", bodies: ["body1", "body2"], groupSides: true };
    const hidden = harness();
    hidden.features.push({ ...old });
    (hidden.store as { rollbackIndex: number }).rollbackIndex = hidden.features.length;
    hidden.store.isBodyVisible = ((id: string) => id !== "body2") as () => boolean;
    hidden.tool.startEdit("f5", () => {});
    settle(hidden);
    expect(inner(hidden.tool).state.allVisible).toBe(true);
    hidden.key("Enter");
    expect(hidden.replaced, "a body hidden since").toEqual([{ id: "f5", f: old }]);

    const shown = harness();
    shown.features.push({ ...old });
    (shown.store as { rollbackIndex: number }).rollbackIndex = shown.features.length;
    shown.tool.startEdit("f5", () => {});
    shown.emit({ building: true, result: shown.store.buildState.result });
    shown.emit({ building: false, result: { bodies: ["body1", "body2", "body3"].map((id) => ({ id, name: id })) } });
    shown.key("Enter");
    expect(shown.replaced, "a body shown since").toEqual([{ id: "f5", f: old }]);
  });
});

describe("the review round's smaller findings", () => {
  it("a filled Tool clicked to pick again prompts for a plane, and an origin plane can be clicked in the model", () => {
    const h = harness({ selectedBodies: ["body1"], originAt: "XZ" });
    h.start(undefined, "d1");
    expect(prompts.at(-1)).toBe(t("feature.split.prompt.ready"));
    byClass(inner(h.tool).panel.root, "split-field")[1]!.dispatch("click");
    expect(prompts.at(-1), "a re-activated field said 'press OK'").toBe(t("feature.split.prompt.tool"));
    expect(h.viewport.originPlanesShown, "the origin planes stayed hidden on a re-pick").toBe(true);
    h.click(); // nothing but the XZ origin plane under the cursor
    h.key("Enter");
    expect(h.added[0]).toMatchObject({ plane: "XZ", body: "body1" });
    expect(h.added[0]).not.toHaveProperty("planeId");
  });

  it("opening takes only the face that filled Tool, and Cancel gives it back; an edge stays selected", () => {
    const h = harness({ selectedBodies: ["body1"], selectedFaces: [7], selectedEdges: ["e1"] });
    h.start();
    expect(inner(h.tool).state.tool).toMatchObject({ kind: "face" });
    expect(h.faces(), "the face that filled Tool is still lit").toEqual([]);
    expect(h.edges(), "an edge the command does not use was cleared").toEqual(["e1"]);
    h.key("Escape");
    expect(h.faces(), "Cancel did not give the face back").toEqual([7]);
    expect(h.selection()).toEqual(["body1"]);
    // a face the command did NOT take (the selected datum filled Tool) is left alone
    const g = harness({ selectedBodies: ["body1"], selectedFaces: [7] });
    g.start(undefined, "d1");
    expect(g.faces()).toEqual([7]);
  });

  it("after a rebuild mid-command the old face ids name other faces, so Cancel does not paint them", () => {
    const h = harness({ selectedBodies: ["body1"], selectedFaces: [7] });
    h.start();
    h.emit({ building: false, result: { bodies: [{ id: "body1", name: "Body1" }, { id: "body2", name: "Body2" }] } });
    h.key("Escape");
    expect(h.faces()).toEqual([]);
  });
});
