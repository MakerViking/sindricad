// The docked Extrude panel (GH #41): everything an extrude has, typed while it
// is being made instead of in the inspector afterwards.
//
// Paul asked for three things on #41; (c) was "type start offset, taper and
// target offset during creation". Before the panel the tool had ONE field, the
// distance, and a click on an up-to target committed on the spot, so a target
// offset could not be typed first at all.
//
// These drive the REAL ExtrudeTool with the REAL panel, depth box and sketch
// overlay on the element stub, through what a user does: click a chip, type in
// a field, press a key, click OK. What is asserted is the feature handed to the
// store, the live preview handed to it, and the ghost the tool drew.

import { describe, expect, it, afterEach } from "vitest";
import * as THREE from "three";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";
import { SketchOverlay } from "../sketch/overlay";
import { setFieldParams, setUnit } from "../ui/units";
import type { CadDocument, Feature } from "../types";
// TEXT, not an import: importing main.ts boots the whole app (ribbonActions.test.ts).
import mainSrc from "../main.ts?raw";

installFakeDocument();
(globalThis as unknown as { window: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
// no jsdom: the depth box's hotkey arbitration starts with an instanceof
(globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement ??= FakeEl;
(globalThis as unknown as { Node: unknown }).Node ??= FakeEl;

const { ExtrudeTool } = await import("./extrudeTool");

afterEach(() => {
  setUnit("mm");
  setFieldParams(() => ({}));
});

/** Two 20x20 areas on XY (A at x=-30, B at x=+30), construction planes 20
 *  and 40 above, and `ex1` extruding A with whatever `saved` adds. */
function doc(saved: Record<string, unknown> = {}): CadDocument {
  return {
    features: [
      {
        id: "s1", type: "sketch", plane: "XY",
        entities: [
          { id: "ra", type: "rectangle", x: -30, y: 0, width: 20, height: 20 },
          { id: "rb", type: "rectangle", x: 30, y: 0, width: 20, height: 20 },
        ],
      },
      { id: "d1", type: "datumPlane", plane: "XY", offset: 20 },
      { id: "d2", type: "datumPlane", plane: "XY", offset: 40 },
      {
        id: "ex1", type: "extrude", sketch: "s1", distance: 15, operation: "new",
        regions: [[-30, 0, 0]], regionEntities: [["ra"]], regionHoleEntities: [[]],
        ...saved,
      },
    ],
    parameters: { lift: 6 },
  } as unknown as CadDocument;
}

type Build = { building: boolean; result: unknown; errorFeatureId: string | null; errorMessage: string | null };

function harness(opts: { saved?: Record<string, unknown>; hasSolid?: boolean } = {}) {
  const body = (globalThis.document as unknown as { body: FakeEl }).body;
  body.children.length = 0;
  const d = doc(opts.saved);
  const overlay = new SketchOverlay();
  overlay.update(d);
  const scene = new THREE.Scene();
  const viewport = {
    suspendPicking: false,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    projectToScreen: () => ({ x: 400, y: 300 }),
    tiltOffAxis: () => true,
    pointInSolid: () => false,
    pickFaceForPressPull: () => null,
    pickEntity: () => null,
    pickVertexAt: () => null,
    // the construction plane under the cursor, wherever the click is
    planeHitsAt: (): { id: string; datum: boolean; distance: number }[] => [{ id: "d1", datum: true, distance: 30 }],
    datumPlaneOf: (id: string) => ({ id, origin: [0, 0, id === "d2" ? 40 : 20], normal: [0, 0, 1] }),
    showAllPlanes() {},
    hoverPlane() {},
    behindSurfaceAt: () => () => false,
    hoverFaceAt: () => null,
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
  const editPreviews: (Feature | null)[] = [];
  const builds: ((b: Build) => void)[] = [];
  const store = {
    document: d,
    isParamBound: () => false,
    boundExpr: () => null,
    beginEditPreview() {},
    endEditPreview() {},
    setPreview: (f: Feature | null) => previews.push(f),
    setEditPreview: (f: Feature | null) => editPreviews.push(f),
    buildState: opts.hasSolid ? { result: { mesh: { positions: [0, 0, 0] } } } : {},
    hiddenBodyIds: () => [],
    nextId: () => "new1",
    addFeature: (f: Feature) => added.push(f),
    replaceFeature: (_id: string, f: Feature) => added.push(f),
    onBuild: (fn: (b: Build) => void) => {
      builds.push(fn);
      return () => {};
    },
  };
  const tool = new ExtrudeTool(viewport as never, overlay, store as never);
  const internals = tool as unknown as {
    onKey(e: KeyboardEvent): void;
    onDown(e: PointerEvent): void;
    onUp(e: PointerEvent): void;
  };

  const panel = () => {
    const root = body.children.find((c) => c.className === "tool-panel extrude-panel");
    if (!root) throw new Error("the Extrude panel is not on the page");
    return root;
  };
  const visible = (el: FakeEl) => el.style.display !== "none";
  /** a number row's input, by the label the user reads */
  const field = (label: string): FakeEl => {
    const row = panel().children.find((r) => r.className === "tool-panel-row" && r.children[0]?.textContent === label && r.children[1]?.tagName === "input");
    if (!row) throw new Error(`no "${label}" field in the panel`);
    return row.children[1]!;
  };
  const rowOf = (label: string) => panel().children.find((r) => r.children[0]?.textContent === label)!;
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
    const el = field(label);
    el.value = text;
    el.dispatch("input");
    return el;
  };
  const ok = () => {
    const btns = panel().children.find((c) => c.className === "tool-panel-buttons")!;
    btns.children[0]!.dispatch("click");
  };
  const warning = () => panel().children.find((c) => c.className === "tool-panel-warn")!;
  /** the depth box on the canvas */
  const depthBox = () => {
    const root = body.children.find((c) => c.className === "dim-input")!;
    return root.children[0]?.children[0];
  };
  const keyAt = (k: string, target: unknown = null, shift = false) =>
    ({
      key: k, target, shiftKey: shift, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0,
      preventDefault() {}, stopPropagation() {},
    }) as unknown as KeyboardEvent;
  /** The ghost's prisms: the only lit meshes the tool puts in the scene. */
  const ghostZ = (): [number, number] | null => {
    const box = new THREE.Box3();
    let any = false;
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material instanceof THREE.MeshStandardMaterial) {
        const g = (o as THREE.Mesh).geometry;
        g.computeBoundingBox();
        box.union(g.boundingBox!);
        any = true;
      }
    });
    return any ? [Math.round(box.min.z * 1000) / 1000, Math.round(box.max.z * 1000) / 1000] : null;
  };
  const areaA = () => overlay.regions.find((wr) => wr.region.entityIds.includes("ra"))!;
  /** Extrude on area A, as a click on it before pressing E does. */
  const create = () => {
    overlay.toggleRegionSelection(areaA(), false);
    tool.start(() => {});
  };
  /** A left click on the canvas: the press, then the release in place. */
  const click = (mods: { ctrlKey?: boolean } = {}) => {
    const ev = { button: 0, clientX: 10, clientY: 10, buttons: 1, ...mods, preventDefault() {}, stopImmediatePropagation() {} };
    internals.onDown(ev as unknown as PointerEvent);
    internals.onUp(ev as unknown as PointerEvent);
  };
  /** Text typed into the depth box beside the cursor. */
  const typeDepth = (text: string) => {
    const box = depthBox()!;
    box.value = text;
    box.dispatch("input");
    return box;
  };
  return {
    tool, internals, viewport, store, added, previews, editPreviews, builds,
    panel, visible, field, rowOf, chip, type, ok, warning, depthBox, keyAt, ghostZ, create, click, typeDepth,
  };
}

const last = <T,>(xs: T[]): T => xs[xs.length - 1]!;

describe("creating an extrude from the panel", () => {
  it("a start offset typed in the panel lands on the feature, and the ghost starts there", () => {
    const h = harness();
    h.create();
    expect(h.ghostZ(), "precondition: a 10 mm ghost on the sketch").toEqual([0, 10]);
    expect(h.visible(h.rowOf("Start offset")), "the offset field shows before Offset is chosen").toBe(false);

    h.chip("Offset").dispatch("click");
    expect(h.visible(h.rowOf("Start offset"))).toBe(true);
    h.type("Start offset", "5");
    expect(h.ghostZ(), "the ghost did not move to the start offset").toEqual([5, 15]);

    h.ok();
    expect(h.added).toHaveLength(1);
    expect(h.added[0]).toMatchObject({ startOffset: 5, distance: 10 });
    expect("symmetric" in h.added[0]!, "an ordinary extrude grew a symmetric key").toBe(false);
  });

  it("Symmetric puts the profile in the middle, from the chip or the S key", () => {
    const h = harness();
    h.create();
    h.chip("Symmetric").dispatch("click");
    expect(h.ghostZ(), "symmetric 10 must span -5..5").toEqual([-5, 5]);
    // S where the key is free (focus off any text box) toggles it back
    h.internals.onKey(h.keyAt("s"));
    expect(h.ghostZ()).toEqual([0, 10]);
    expect(h.chip("One side").classList.contains("on")).toBe(true);
    h.internals.onKey(h.keyAt("S"));
    expect(h.chip("Symmetric").classList.contains("on")).toBe(true);

    h.ok();
    expect(h.added[0]).toMatchObject({ symmetric: true, distance: 10 });
  });

  it("S in the depth box is the first letter of a name, not the Symmetric key", () => {
    const h = harness();
    h.create();
    let claimed = false;
    const s = { ...h.keyAt("s", h.depthBox()), preventDefault: () => void (claimed = true) } as unknown as KeyboardEvent;
    h.internals.onKey(s);
    expect(claimed, "S was taken from the box, so `size*2` became `ize*2`").toBe(false);
    expect(h.chip("One side").classList.contains("on"), "S in the box toggled Symmetric").toBe(true);
  });

  it("a name typed into the depth box is read; a misspelt one is refused, not replaced by the last depth", () => {
    setFieldParams(() => ({ wall: 2 }));
    const h = harness();
    h.create();
    const box = h.typeDepth("wal*2");
    expect(box.classList.contains("invalid"), "the box gave no sign it cannot read that").toBe(true);
    box.dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    expect(h.added, "the seeded 10 mm was committed with the typo still on screen").toEqual([]);
    expect(h.warning().textContent).not.toBe("");
    expect(h.tool.active, "a refused Enter closed the tool").toBe(true);

    h.typeDepth("wall*2").dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    expect(h.added).toHaveLength(1);
    expect(h.added[0]).toMatchObject({ distance: 4 });
  });

  it("OK with a distance of 0 says why nothing happens", () => {
    const h = harness();
    h.create();
    h.type("Distance", "0");
    h.ok();
    expect(h.added).toEqual([]);
    expect(h.warning().textContent, "OK did nothing and said nothing").toContain("can't be 0");
    h.type("Distance", "5");
    expect(h.warning().textContent, "the warning outlived the zero").toBe("");
  });

  it("removing the last area takes the panel down with the depth box, and brings it back on a pick", () => {
    const h = harness();
    h.create();
    h.chip("Offset").dispatch("click");
    const offset = h.type("Start offset", "5");
    h.click({ ctrlKey: true }); // Ctrl-click area A away
    expect(h.visible(h.panel()), "the panel stayed up with nothing to extrude (GitHub #14)").toBe(false);
    // Enter in a field of that panel used to reach commit(), which cancels the
    // whole extrude on an empty selection
    h.internals.onKey(h.keyAt("Enter", offset));
    expect(h.tool.active, "the extrude was thrown away silently").toBe(true);
    expect(h.added).toEqual([]);

    h.click(); // pick area A again
    expect(h.visible(h.panel())).toBe(true);
    expect(h.field("Start offset").value, "the typed start offset was lost").toBe("5");
  });

  it("symmetric composes with the start offset: the offset plane is the midplane", () => {
    const h = harness();
    h.create();
    h.chip("Offset").dispatch("click");
    h.type("Start offset", "4");
    h.chip("Symmetric").dispatch("click");
    expect(h.ghostZ()).toEqual([-1, 9]);
  });

  it("a click on the target FILLS the Up-to box; a target offset is typed, then Enter commits", () => {
    const h = harness();
    h.create();
    h.chip("Symmetric").dispatch("click");
    h.internals.onKey(h.keyAt("t"));
    expect(h.visible(h.rowOf("Up to")), "T did not open the Up-to box").toBe(true);

    h.internals.onDown({ button: 0, clientX: 10, clientY: 10, preventDefault() {}, stopImmediatePropagation() {} } as unknown as PointerEvent);
    expect(h.added, "the click on the target committed, so no target offset could be typed").toEqual([]);
    expect(h.rowOf("Up to").children[1]!.children[0]!.textContent, "the box does not name the plane").toBe("Plane1");
    // a target makes these meaningless, and an input that is ignored is a lie
    expect(h.visible(h.rowOf("Taper"))).toBe(false);
    expect(h.visible(h.rowOf("Distance"))).toBe(false);
    expect(h.visible(h.rowOf("Target offset"))).toBe(true);

    const offset = h.type("Target offset", "3");
    h.internals.onKey(h.keyAt("Enter", offset));
    expect(h.added).toHaveLength(1);
    expect(h.added[0]).toMatchObject({ upToPlane: "d1", upToOffset: 3 });
    expect("symmetric" in h.added[0]!, "symmetric was written beside a target, which the sidecar refuses").toBe(false);
  });

  it("a click on another face or plane aims there instead of committing to the first target", () => {
    const h = harness();
    h.create();
    h.internals.onKey(h.keyAt("t"));
    h.click(); // Plane1
    h.viewport.planeHitsAt = () => [{ id: "d2", datum: true, distance: 10 }];
    h.click(); // the plane the user meant
    expect(h.added, "the second click committed the first target").toEqual([]);
    expect(h.rowOf("Up to").children[1]!.children[0]!.textContent).toBe("Plane2");
    // a click on nothing still commits, on the release
    h.viewport.planeHitsAt = () => [];
    h.click();
    expect(h.added).toHaveLength(1);
    expect(h.added[0]).toMatchObject({ upToPlane: "d2" });
  });

  it("a target previews through the real build, and the preview is handed back before the commit", () => {
    const h = harness();
    h.create();
    h.internals.onKey(h.keyAt("t"));
    h.internals.onDown({ button: 0, clientX: 10, clientY: 10, preventDefault() {}, stopImmediatePropagation() {} } as unknown as PointerEvent);
    expect(last(h.previews), "the target was not previewed").toMatchObject({ upToPlane: "d1" });
    expect(h.ghostZ(), "the straight ghost stayed up over the built preview").toBeNull();
    h.ok();
    expect(last(h.previews), "the preview was left in the model").toBeNull();
  });

  it("a taper previews through the real build, says why it cannot be built, and goes away when cleared", () => {
    const h = harness();
    h.create();
    h.type("Taper", "60");
    expect(last(h.previews)).toMatchObject({ taper: 60, id: "new1" });
    // the build refuses it: the reason is in the panel before OK is pressed
    for (const fn of h.builds) {
      fn({
        building: false,
        result: { featureErrors: [{ feature_id: "new1", message: "Extrude: a 60° taper doesn't work on this profile" }] },
        errorFeatureId: null,
        errorMessage: null,
      });
    }
    expect(h.warning().textContent).toContain("60° taper");
    h.type("Taper", "");
    expect(last(h.previews)).toBeNull();
    expect(h.ghostZ()).toEqual([0, 10]);
    h.ok();
    expect("taper" in h.added[0]!).toBe(false);
  });

  it("the operation is the panel's: no dialog after the click", () => {
    const h = harness({ hasSolid: true });
    h.create();
    // pulled away from the (stubbed) body: the guess is Join
    expect(h.chip("Join").classList.contains("on")).toBe(true);
    h.chip("Cut").dispatch("click");
    expect(h.warning().textContent, "a cut where there is nothing to cut went unsaid").not.toBe("");
    h.ok();
    expect(h.added).toHaveLength(1);
    expect((h.added[0] as { operation: string }).operation).toBe("cut");
  });

  it("offers no operation when there is nothing to combine with", () => {
    const h = harness();
    h.create();
    expect(h.visible(h.rowOf("Operation"))).toBe(false);
    h.ok();
    expect((h.added[0] as { operation: string }).operation).toBe("new");
  });

  it("refuses OK on a field it cannot read, rather than using the last number", () => {
    const h = harness();
    h.create();
    h.chip("Offset").dispatch("click");
    h.type("Start offset", "3.14.15");
    h.ok();
    expect(h.added).toEqual([]);
    expect(h.warning().textContent).not.toBe("");
  });

  it("reads an expression the way the depth box does: 1/16 in inches is a sixteenth of an inch", () => {
    setUnit("in");
    const h = harness();
    h.create();
    h.chip("Offset").dispatch("click");
    h.type("Start offset", "1/16");
    h.ok();
    expect((h.added[0] as { startOffset: number }).startOffset).toBe(25.4 / 16);
  });

  it("a depth of 1/16 in inches is saved as exactly a sixteenth of an inch, from the box or the panel", () => {
    // Integration check 4b: both stored 1.588 (rounded to 1 um), so the
    // extrude was 952.8 mm3 where a sixteenth of an inch gives 952.5.
    setUnit("in");
    const fromBox = harness();
    fromBox.create();
    fromBox.typeDepth("1/16").dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    expect((fromBox.added[0] as { distance: number }).distance).toBe(25.4 / 16);

    for (const text of ["1/16", "1/16 in", "1/32"]) {
      const fromPanel = harness();
      fromPanel.create();
      fromPanel.type("Distance", text);
      fromPanel.ok();
      expect((fromPanel.added[0] as { distance: number }).distance, text).toBe(text === "1/32" ? 25.4 / 32 : 25.4 / 16);
    }
  });

  it("a typed depth loses only its float fuzz", () => {
    const h = harness();
    h.create();
    h.typeDepth("0.1+0.2").dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    expect((h.added[0] as { distance: number }).distance).toBe(0.3);
  });
});

describe("an edit reopens the panel on the saved feature", () => {
  it("shows the saved values, and writes back what was changed and what was not", () => {
    const h = harness({ saved: { startOffset: 4, taper: 7, symmetric: true, operation: "cut" } });
    expect(h.tool.startEdit("ex1", () => {})).toBe(true);
    expect(h.field("Start offset").value).toBe("4");
    expect(h.field("Taper").value).toBe("7");
    expect(h.chip("Offset").classList.contains("on")).toBe(true);
    expect(h.chip("Symmetric").classList.contains("on")).toBe(true);
    expect(h.chip("Cut").classList.contains("on"), "the edit did not open on the saved operation").toBe(true);
    // a saved taper previews through the real build from the start
    expect(last(h.editPreviews)).toMatchObject({ taper: 7, symmetric: true });

    h.type("Taper", "0");
    expect(last(h.editPreviews)).toBeNull();
    h.ok();
    const f = h.added[0] as Record<string, unknown>;
    expect(f.startOffset, "a value nobody touched was dropped").toBe(4);
    expect("taper" in f, "the cleared taper was written").toBe(false);
    expect(f.symmetric).toBe(true);
    expect(f.operation).toBe("cut");
  });

  it("a value bound to a parameter is shown, not typed over, and kept as the binding", () => {
    const h = harness({ saved: { startOffset: "lift" } });
    expect(h.tool.startEdit("ex1", () => {})).toBe(true);
    const f = h.field("Start offset");
    expect(f.value).toBe("lift");
    expect(f.disabled, "a bound value could be typed over, and the binding would put it back").toBe(true);
    expect(h.ghostZ(), "the ghost did not start at the parameter's value").toEqual([6, 21]);
    // and it cannot be switched off from here either
    h.chip("Profile plane").dispatch("click");
    expect(h.chip("Offset").classList.contains("on")).toBe(true);
    expect(h.warning().textContent).not.toBe("");
    h.ok();
    expect((h.added[0] as Record<string, unknown>).startOffset).toBe("lift");
  });
});

// A taper or an up-to target previews as a real feature appended to every
// rebuild (store.setPreview), and nothing on a document replacement clears
// that, so Ctrl+N or Ctrl+O with the panel open built the old document's
// preview into the new one. main.ts closes the open tool on every replacement;
// the wiring is read off main.ts as text (inspectorPanel.test.ts does the same).
describe("a document replacement closes the open tool", () => {
  it("cancels modeling tools in a store.onReplace handler", () => {
    const handlers = [...mainSrc.matchAll(/^store\.onReplace\(\([^)]*\) => \{\n([\s\S]*?)\n\}\);$/gm)].map((m) => m[1]!);
    expect(handlers.length, "found no onReplace handler: the pattern is stale").toBeGreaterThan(0);
    expect(
      handlers.some((body) => /^\s*cancelModelingTool\(\);$/m.test(body)),
      "a replacement leaves the tool and its preview open",
    ).toBe(true);
    const at = mainSrc.indexOf("\nfunction cancelModelingTool(");
    expect(mainSrc.slice(at, mainSrc.indexOf("\n}\n", at))).toContain("if (extrude.active) extrude.cancel();");
  });
});
