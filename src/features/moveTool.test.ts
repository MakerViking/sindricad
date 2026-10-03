// The Move tool: a number typed into the box at the cursor, an Enter with
// nothing moved (Doug28b), and the docked Move panel (Doug 28a): a move and a
// rotation typed while the move is made, what the rotation turns about, a move
// that only rotates, and a move re-opened for editing.
//
// Before the panel the only input was ONE box at the cursor, for the axis last
// dragged; rotation could only be typed into the inspector after the move was
// committed, and it always turned about the world origin, so a body 50 mm out
// swung round the origin instead of turning in place. A move that only rotated
// could not be made at all: zero translation was "nothing to commit".
//
// These drive the REAL MoveTool with its REAL DimInput and panel through the
// element stub: a number goes in through an input's own `input` event, Enter
// through its own keydown (the box) or the tool's key handler (the panel), a
// chip or OK through its click, and an arrow is picked by a pointerdown the tool
// raycasts. The ghost is read as the transform handed to the viewport, checked
// against corners worked out by hand, not against the function that made it.
// What they do NOT cover, stated rather than implied: the arrow's visibility,
// the drag itself (axisDragDistance needs a camera) and the meshes on screen.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { FakeEl, fakeFocus, installFakeDocument } from "../ui/fakeDom.testkit";
import { setFieldParams, setUnit } from "../ui/units";
import { t } from "../i18n";
import type { Feature } from "../types";
// TEXT, not an import: importing main.ts boots the whole app (ribbonActions.test.ts).
import mainSrc from "../main.ts?raw";

const prompt = new FakeEl("div");
installFakeDocument({ prompt });
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = () => {};
(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };

const { MoveTool, moveMatrix } = await import("./moveTool");

afterEach(() => {
  setUnit("mm");
  setFieldParams(() => ({}));
});

type Handler = (e: unknown) => void;
type Build = { building: boolean; result: { bodies: { id: string }[] } | null };

/** The canvas: listeners the tool registers, and a way to fire them. */
function canvas() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    style: {} as Record<string, string>,
    addEventListener(type: string, fn: Handler) {
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener(type: string, fn: Handler) {
      handlers.get(type)?.delete(fn);
    },
    fire(type: string, ev: unknown) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn(ev);
    },
  };
}

/** body1: a 10 x 20 x 30 box centred on (50, 0, 15) */
const BOX = new THREE.Box3(new THREE.Vector3(45, -10, 0), new THREE.Vector3(55, 10, 30));

function harness(features: Feature[] = [], opts: { bound?: boolean } = {}) {
  const el = canvas();
  /** whether the next raycast lands on the X arrow */
  const aim = { onArrow: false };
  /** the ghost's transform, as last handed to the viewport */
  const ghost: { m: THREE.Matrix4 | null; bodies: string[] } = { m: null, bodies: [] };
  const viewport = {
    suspendPicking: false,
    domElement: el,
    bodiesBox: (ids: string[]) => (ids.includes("body1") ? BOX.clone() : null),
    beginBodyMoveGhost(ids: string[]) {
      ghost.bodies = ids;
    },
    endBodyMoveGhost() {},
    setBodyMoveTransform(m: THREE.Matrix4) {
      ghost.m = m.clone();
    },
    projectToScreen: () => ({ x: 0, y: 0 }),
    addToScene() {},
    removeFromScene() {},
    pixelWorldSize: () => 0.1,
    snapStep: () => 1,
    // the first mesh handed in is the X arrow's shaft; the tool walks up to the
    // arrow group to read which axis it is. The ray looks straight down -Z.
    rayFrom: () => ({
      ray: new THREE.Ray(new THREE.Vector3(0, 0, 100), new THREE.Vector3(0, 0, -1)),
      intersectObjects: (meshes: unknown[]) => (aim.onArrow ? [{ object: meshes[0] }] : []),
    }),
  };
  const added: Feature[] = [];
  const replaced: { id: string; f: Feature }[] = [];
  const editPreview: string[] = [];
  const builds = new Set<(b: Build) => void>();
  const store = {
    document: { features, parameters: {} },
    buildState: { building: false, result: null } as Build,
    isParamBound: () => opts.bound === true,
    nextId: () => "m1",
    addFeature: (f: Feature) => void added.push(f),
    replaceFeature: (id: string, f: Feature) => void replaced.push({ id, f }),
    beginEditPreview: (id: string) => void editPreview.push(`begin ${id}`),
    endEditPreview: (rebuild = true) => void editPreview.push(`end ${rebuild}`),
    onBuild(fn: (b: Build) => void) {
      builds.add(fn);
      fn(store.buildState);
      return () => void builds.delete(fn);
    },
  };
  const body = document.body as unknown as FakeEl;
  const tool = new MoveTool(viewport as never, store as never);
  const internals = tool as unknown as { onKey(e: KeyboardEvent): void };
  // the box and the panel this tool just mounted (every tool mounts its own)
  const mine = (cls: string) => [...body.children].reverse().find((c) => c.className === cls)!;
  const box = mine("dim-input");
  const panelRoot = mine("tool-panel move-panel");
  const done: (string | null)[] = [];
  const pointer = (type: string) =>
    el.fire(type, {
      button: 0, clientX: 10, clientY: 10,
      preventDefault() {}, stopImmediatePropagation() {},
    });
  const boxInput = () => {
    const input = box.querySelector("input");
    if (!input) throw new Error("the Move box has no input");
    return input;
  };
  /** a panel row's input, by the label the user reads */
  const field = (label: string): FakeEl => {
    const row = panelRoot.children.find((r) => r.className === "tool-panel-row" && r.children[0]?.textContent === label);
    if (!row?.children[1]) throw new Error(`no "${label}" field in the Move panel`);
    return row.children[1];
  };
  const chip = (text: string): FakeEl => {
    const found: FakeEl[] = [];
    const walk = (e: FakeEl) => {
      if (e.tagName === "button" && e.className.startsWith("tool-chip") && e.textContent === text) found.push(e);
      e.children.forEach(walk);
    };
    walk(panelRoot);
    if (found.length !== 1) throw new Error(`expected one "${text}" chip, found ${found.length}`);
    return found[0]!;
  };
  const key = (k: string, target: unknown) =>
    ({
      key: k, target, isComposing: false, keyCode: 0, preventDefault() {}, stopPropagation() {},
    }) as unknown as KeyboardEvent;
  return {
    tool, added, replaced, editPreview, done, ghost, panelRoot,
    start() {
      tool.start(["body1"], (id) => done.push(id));
    },
    edit(id: string) {
      return tool.startEdit(id, (fid) => done.push(fid));
    },
    /** the store's rebuild: one starting, then one landing with these bodies */
    build(bodies: string[] = ["body1"]) {
      for (const fn of [...builds]) fn({ building: true, result: null });
      for (const fn of [...builds]) fn({ building: false, result: { bodies: bodies.map((id) => ({ id })) } });
    },
    /** what typing in the box at the cursor does: the text lands and its input event fires */
    type(text: string) {
      const input = boxInput();
      input.value = text;
      input.dispatch("input");
    },
    enter() {
      boxInput().dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    },
    boxInput,
    field,
    chip,
    /** typing into a panel row */
    typeRow(label: string, text: string) {
      const input = field(label);
      input.value = text;
      input.dispatch("input");
      return input;
    },
    /** Enter in a panel row, through the tool's own key handler */
    enterRow(label: string) {
      internals.onKey(key("Enter", field(label)));
    },
    ok() {
      const btns = panelRoot.children.find((c) => c.className === "tool-panel-buttons")!;
      btns.children[0]!.dispatch("click");
    },
    warning: () => panelRoot.children.find((c) => c.className === "tool-panel-warn")!.textContent,
    /** a click on the X arrow, no drag */
    clickArrow() {
      aim.onArrow = true;
      pointer("pointerdown");
      pointer("pointerup");
      aim.onArrow = false;
    },
    /** a clean click in empty canvas, the "click away" that commits */
    clickAway() {
      pointer("pointerdown");
      pointer("pointerup");
    },
  };
}

/** where the ghost puts a point, rounded so a test reads it like a drawing */
function lands(m: THREE.Matrix4 | null, p: [number, number, number]): number[] {
  if (!m) throw new Error("no ghost transform was handed to the viewport");
  const v = new THREE.Vector3(...p).applyMatrix4(m);
  return [v.x, v.y, v.z].map((n) => Math.round(n * 1e6) / 1e6 + 0); // + 0 turns -0 into 0
}

beforeEach(() => {
  prompt.textContent = "";
});

describe("Move: a typed distance and an empty Enter", () => {
  it("keeps a distance typed before any arrow, and asks for the direction", () => {
    const m = harness();
    m.start();
    m.type("10");
    m.enter();
    expect(m.added, "a typed value with no axis must not commit").toEqual([]);
    expect(m.done, "the tool closed and dropped the value").toEqual([]);
    expect(m.tool.active).toBe(true);
    expect(prompt.textContent).toBe(t("feature.move.pickAxis"));
  });

  it("commits that same distance along the arrow clicked next", () => {
    const m = harness();
    m.start();
    m.type("10");
    m.enter();
    m.clickArrow();
    m.enter();
    expect(m.added).toHaveLength(1);
    expect(m.added[0]).toMatchObject({ type: "move", dx: 10, dy: 0, dz: 0, bodies: ["body1"] });
    expect(m.done).toEqual(["m1"]);
    expect(m.tool.active).toBe(false);
  });

  it("says there is nothing to commit instead of closing silently", () => {
    const m = harness();
    m.start();
    m.enter();
    expect(m.added).toEqual([]);
    expect(m.done, "an empty Enter closed the tool").toEqual([]);
    expect(m.tool.active).toBe(true);
    expect(prompt.textContent).toBe(t("feature.move.nothingToCommit"));
  });

  it("still closes on a click away with nothing moved and nothing typed", () => {
    const m = harness();
    m.start();
    m.clickAway();
    expect(m.added).toEqual([]);
    expect(m.done, "a click away from an untouched gizmo means never mind").toEqual([null]);
    expect(m.tool.active).toBe(false);
  });

  it("keeps a typed distance with no direction through a click away", () => {
    const m = harness();
    m.start();
    m.type("10");
    m.clickAway();
    expect(m.added).toEqual([]);
    expect(m.done, "the click away dropped the typed value").toEqual([]);
    expect(m.tool.active).toBe(true);
    expect(prompt.textContent).toBe(t("feature.move.pickAxis"));
  });

  it("refuses text it cannot read rather than committing the last value", () => {
    const m = harness();
    m.start();
    m.clickArrow();
    m.type("1o");
    m.enter();
    expect(m.added).toEqual([]);
    expect(m.tool.active).toBe(true);
    expect(prompt.textContent).toBe(t("feature.badNumber"));
  });
});

describe("the Move panel (Doug 28)", () => {
  it("commits a move that only rotates, turning the body in place about its centre", () => {
    const m = harness();
    m.start();
    m.typeRow(t("inspector.field.rotateZ"), "90");
    // the ghost turns the box about (50, 0, 15): its corner (55, 10, 0) is 5
    // and 10 off the centre, and a quarter turn puts it 10 back and 5 across
    expect(lands(m.ghost.m, [50, 0, 15]), "the centre must stay put").toEqual([50, 0, 15]);
    expect(lands(m.ghost.m, [55, 10, 0])).toEqual([40, 5, 0]);
    m.ok();
    expect(m.added, "a rotation alone is a move, and must commit").toHaveLength(1);
    expect(m.added[0]).toEqual({
      id: "m1", type: "move", dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 90, bodies: ["body1"], pivot: [50, 0, 15],
    });
    expect(m.done).toEqual(["m1"]);
  });

  it("turns about the origin when Origin is chosen, as a move without a pivot always has", () => {
    const m = harness();
    m.start();
    m.chip(t("feature.move.panel.pivotOrigin")).dispatch("click");
    m.typeRow(t("inspector.field.rotateZ"), "90");
    expect(lands(m.ghost.m, [50, 0, 15]), "a quarter turn about the origin").toEqual([0, 50, 15]);
    m.ok();
    expect(m.added[0]).toMatchObject({ rz: 90 });
    expect("pivot" in m.added[0]!, "an origin move must be written exactly as before the panel").toBe(false);
  });

  it("takes a translation and a rotation together, with Enter in a row as OK", () => {
    const m = harness();
    m.start();
    m.typeRow(t("inspector.field.moveX"), "10");
    m.typeRow(t("inspector.field.moveZ"), "-2.5");
    m.typeRow(t("inspector.field.rotateX"), "45");
    // turned about its own centre and then carried along: the centre goes
    // exactly where the translation says
    expect(lands(m.ghost.m, [50, 0, 15])).toEqual([60, 0, 12.5]);
    m.enterRow(t("inspector.field.rotateX"));
    expect(m.added[0]).toMatchObject({ dx: 10, dy: 0, dz: -2.5, rx: 45, ry: 0, rz: 0, pivot: [50, 0, 15] });
  });

  it("reads a row in the display unit and keeps it exact (1/16 in is 1.5875 mm)", () => {
    setUnit("in");
    const m = harness();
    m.start();
    m.typeRow(t("inspector.field.moveY"), "1/16");
    m.ok();
    expect(m.added[0]!.type === "move" && m.added[0]!.dy).toBe(1.5875);
  });

  it("a value typed at the cursor for the arrow taken fills that arrow's row", () => {
    const m = harness();
    m.start();
    m.clickArrow();
    m.type("7");
    expect(m.field(t("inspector.field.moveX")).value).toBe("7");
    expect(lands(m.ghost.m, [50, 0, 15])).toEqual([57, 0, 15]);
  });

  it("refuses a row it cannot read, and says so in the panel", () => {
    const m = harness();
    m.start();
    m.typeRow(t("inspector.field.rotateY"), "4o");
    m.ok();
    expect(m.added).toEqual([]);
    expect(m.tool.active).toBe(true);
    expect(m.warning()).toBe(t("feature.badNumber"));
  });

  // The box at the cursor holds the last good value for the axis last
  // dragged, and OK used to write it into that axis's row before looking for
  // an unreadable row: the typo vanished and the old number was committed.
  it("refuses a typo in the row of the arrow last dragged, not commits the box's old value", () => {
    const m = harness();
    m.start();
    m.clickArrow();
    m.typeRow(t("inspector.field.moveX"), "12");
    const row = m.typeRow(t("inspector.field.moveX"), "12..5");
    m.enterRow(t("inspector.field.moveX"));
    expect(m.added, "the typo was swapped for 12 and committed").toEqual([]);
    expect(m.tool.active).toBe(true);
    expect(m.warning()).toBe(t("feature.badNumber"));
    expect(row.value, "the typo must stay where the user can see it").toBe("12..5");
  });

  it("refuses that typo too when the value came from the box at the cursor", () => {
    const m = harness();
    m.start();
    m.clickArrow();
    m.type("7");
    m.typeRow(t("inspector.field.moveX"), "7..5");
    m.ok();
    expect(m.added).toEqual([]);
    expect(m.warning()).toBe(t("feature.badNumber"));
  });

  // Taking an arrow does not move focus by itself (the press is
  // preventDefault'ed so a drag keeps the caret), so after typing in the panel
  // the next keys went into that row: a 7 for the arrow became Rotate Z 907.
  it("taking an arrow after typing in the panel puts the keys in the box at the cursor", () => {
    const m = harness();
    m.start();
    const rz = m.field(t("inspector.field.rotateZ"));
    rz.focus(); // the user clicks into the row...
    m.typeRow(t("inspector.field.rotateZ"), "90"); // ...and types
    m.clickArrow();
    expect(fakeFocus.el, "the keys typed next still go to Rotate Z").toBe(m.boxInput());
  });

  it("says in the panel that nothing moves on an OK with every row at 0", () => {
    const m = harness();
    m.start();
    m.ok();
    expect(m.added).toEqual([]);
    expect(m.tool.active).toBe(true);
    expect(m.warning()).toBe(t("feature.move.panel.nothingMoved"));
  });
});

describe("re-opening a move", () => {
  const saved = (extra: Record<string, unknown> = {}) =>
    ({
      id: "mv", type: "move", name: "Lift", dx: 0, dy: 0, dz: 5, rx: 0, ry: 0, rz: 45,
      bodies: ["body1"], pivot: [50, 0, 15], ...extra,
    }) as unknown as Feature;

  it("opens the panel on the saved values once the model before the move is on screen", () => {
    const m = harness([saved()]);
    expect(m.edit("mv")).toBe(true);
    expect(m.editPreview).toEqual(["begin mv"]);
    expect(m.ghost.bodies, "the ghost must wait for the model before the move").toEqual([]);
    m.build();
    expect(m.ghost.bodies).toEqual(["body1"]);
    expect(m.field(t("inspector.field.moveZ")).value).toBe("5");
    expect(m.field(t("inspector.field.rotateZ")).value).toBe("45");
    expect(m.chip(t("feature.move.panel.pivotCentre")).classList.contains("on")).toBe(true);
    // the saved pivot, not a centre measured again off the model
    expect(lands(m.ghost.m, [50, 0, 15])).toEqual([50, 0, 20]);
  });

  it("OK replaces the move in place, keeping what it does not show", () => {
    const m = harness([saved()]);
    m.edit("mv");
    m.build();
    m.typeRow(t("inspector.field.rotateZ"), "90");
    m.ok();
    expect(m.added).toEqual([]);
    expect(m.replaced).toHaveLength(1);
    expect(m.replaced[0]!.id).toBe("mv");
    expect(m.replaced[0]!.f).toEqual({ ...saved(), rz: 90 });
    expect(m.editPreview).toEqual(["begin mv", "end false"]);
    expect(m.done).toEqual(["mv"]);
  });

  it("OK with nothing changed writes back the very move it opened", () => {
    const before = saved({ dx: 0.1234567 });
    const m = harness([before]);
    m.edit("mv");
    m.build();
    m.ok();
    expect(JSON.stringify(m.replaced[0]!.f)).toBe(JSON.stringify(before));
  });

  // The pivot is a point saved with the move, so an earlier step that moves the
  // body leaves it behind. Reopened, that move used to light Centre while the
  // ghost swung the body about the old point, and Centre could not put it back
  // on the middle: it WAS the old point.
  describe("a saved pivot an earlier step has left off the middle", () => {
    const offMiddle = () => saved({ pivot: [0, 0, 15] }); // body1's middle is (50, 0, 15)

    it("lights neither chip, and says where it turns about", () => {
      const m = harness([offMiddle()]);
      m.edit("mv");
      m.build();
      expect(m.chip(t("feature.move.panel.pivotCentre")).classList.contains("on"), "Centre is not where it turns").toBe(false);
      expect(m.chip(t("feature.move.panel.pivotOrigin")).classList.contains("on")).toBe(false);
      expect(m.warning()).toBe(t("feature.move.panel.savedPivot", { x: "0 mm", y: "0 mm", z: "15 mm" }));
      // the ghost turns about the saved point, as the build does: 45 degrees
      // about the Z line through (0, 0) carries (50, 0) to (35.36, 35.36)
      expect(lands(m.ghost.m, [50, 0, 15])).toEqual([35.355339, 35.355339, 20]);
    });

    it("OK with nothing changed keeps the saved point", () => {
      const before = offMiddle();
      const m = harness([before]);
      m.edit("mv");
      m.build();
      m.ok();
      expect(JSON.stringify(m.replaced[0]!.f)).toBe(JSON.stringify(before));
    });

    it("Centre turns it about the middle as it is now", () => {
      const m = harness([offMiddle()]);
      m.edit("mv");
      m.build();
      m.chip(t("feature.move.panel.pivotCentre")).dispatch("click");
      expect(lands(m.ghost.m, [50, 0, 15]), "turned in place, then lifted").toEqual([50, 0, 20]);
      expect(m.warning()).toBe("");
      m.ok();
      expect(m.replaced[0]!.f).toMatchObject({ pivot: [50, 0, 15] });
    });
  });

  it("an old move with no pivot reopens on Origin and stays without one", () => {
    const m = harness([saved({ pivot: undefined })]);
    m.edit("mv");
    m.build();
    expect(m.chip(t("feature.move.panel.pivotOrigin")).classList.contains("on")).toBe(true);
    m.ok();
    expect("pivot" in m.replaced[0]!.f).toBe(false);
  });

  it("Esc puts the timeline back and changes nothing", () => {
    const m = harness([saved()]);
    m.edit("mv");
    m.build();
    m.tool.cancel();
    expect(m.replaced).toEqual([]);
    expect(m.editPreview).toEqual(["begin mv", "end true"]);
    expect(m.done).toEqual([null]);
  });

  it("leaves a move set by a parameter to the inspector", () => {
    const m = harness([saved()], { bound: true });
    expect(m.edit("mv")).toBe(false);
    expect(m.editPreview).toEqual([]);
  });

  it("is what double-clicking a move does", () => {
    const fn = mainSrc.slice(mainSrc.indexOf("function editFeature("));
    expect(fn).toMatch(/case "move":\s*\n\s*if \(!moveTool\.startEdit\(id, done\)\) toInspector\(\);/);
  });
});

describe("the ghost and the build agree", () => {
  // The same twelve numbers as test_smoke.py's MOVE_PINNED, which the sidecar
  // test checks the built body against: build123d's
  // Pos(1,2,3) * Pos(10,-5,7) * Rot(30,45,60) * Pos(-10,5,-7). If either side
  // changes its rotation order or its pivot rule, one of the two fails.
  const MOVE_PINNED = [
    [0.353553390593, -0.612372435696, 0.707106781187, -0.547143552718],
    [0.926776695297, 0.126826484044, -0.353553390593, -9.158760798592],
    [0.126826484044, 0.78033008589, 0.612372435696, 8.346778539136],
  ];

  it("moveMatrix is build123d's Pos * Pos(pivot) * Rot * Pos(-pivot)", () => {
    const m = moveMatrix({ x: 1, y: 2, z: 3 }, [30, 45, 60], { x: 10, y: -5, z: 7 });
    const e = m.elements; // column-major
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) expect(e[c * 4 + r]!).toBeCloseTo(MOVE_PINNED[r]![c]!, 9);
    }
  });
});
