// What happens to a number typed into the Move box, and to an Enter with
// nothing moved (Doug28b).
//
// The prompt says "type a value · Enter to commit", but a value typed before any
// arrow was touched had no axis to go to: Enter dropped it, committed nothing
// and closed the tool without a word. The same zero-translation guard closed the
// tool silently on an Enter with nothing moved at all. A clean click away with
// nothing moved and nothing typed is different: it has always meant "never
// mind", and still closes the tool.
//
// These drive the REAL MoveTool and its REAL DimInput through the element stub:
// the number goes in through the input's own `input` event and Enter through its
// own keydown, and an arrow is picked by a pointerdown the tool raycasts.
// What they do NOT cover, stated rather than implied: the arrow's visibility,
// the drag itself (axisDragDistance needs a camera) and the live ghost.
import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl, installFakeDocument } from "../ui/fakeDom.testkit";
import { t } from "../i18n";

const prompt = new FakeEl("div");
installFakeDocument({ prompt });
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = () => {};
(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };

const { MoveTool } = await import("./moveTool");

type Handler = (e: unknown) => void;

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

function setup() {
  const el = canvas();
  /** whether the next raycast lands on the X arrow */
  const aim = { onArrow: false };
  const viewport = {
    suspendPicking: false,
    domElement: el,
    bodiesCentroid: () => ({ x: 0, y: 0, z: 0 }),
    beginBodyMoveGhost() {},
    endBodyMoveGhost() {},
    setBodyMoveOffset() {},
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
  const added: Record<string, unknown>[] = [];
  const store = {
    nextId: () => "m1",
    addFeature: (f: Record<string, unknown>) => void added.push(f),
  };
  const body = document.body as unknown as FakeEl;
  const tool = new MoveTool(viewport as never, store as never);
  // the box this tool's DimInput just mounted (every tool mounts its own)
  const box = body.children[body.children.length - 1];
  const done: (string | null)[] = [];
  tool.start(["body1"], (id) => done.push(id));
  const input = box?.querySelector("input");
  if (!input) throw new Error("the Move box has no input");
  const pointer = (type: string) =>
    el.fire(type, {
      button: 0, clientX: 10, clientY: 10,
      preventDefault() {}, stopImmediatePropagation() {},
    });
  return {
    tool, added, done,
    /** what typing does: the text lands and the field's input event fires */
    type(text: string) {
      input.value = text;
      input.dispatch("input");
    },
    enter() {
      input.dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    },
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

beforeEach(() => {
  prompt.textContent = "";
});

describe("Move: a typed distance and an empty Enter", () => {
  it("keeps a distance typed before any arrow, and asks for the direction", () => {
    const m = setup();
    m.type("10");
    m.enter();
    expect(m.added, "a typed value with no axis must not commit").toEqual([]);
    expect(m.done, "the tool closed and dropped the value").toEqual([]);
    expect(m.tool.active).toBe(true);
    expect(prompt.textContent).toBe(t("feature.move.pickAxis"));
  });

  it("commits that same distance along the arrow clicked next", () => {
    const m = setup();
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
    const m = setup();
    m.enter();
    expect(m.added).toEqual([]);
    expect(m.done, "an empty Enter closed the tool").toEqual([]);
    expect(m.tool.active).toBe(true);
    expect(prompt.textContent).toBe(t("feature.move.nothingToCommit"));
  });

  it("still closes on a click away with nothing moved and nothing typed", () => {
    const m = setup();
    m.clickAway();
    expect(m.added).toEqual([]);
    expect(m.done, "a click away from an untouched gizmo means never mind").toEqual([null]);
    expect(m.tool.active).toBe(false);
  });

  it("keeps a typed distance with no direction through a click away", () => {
    const m = setup();
    m.type("10");
    m.clickAway();
    expect(m.added).toEqual([]);
    expect(m.done, "the click away dropped the typed value").toEqual([]);
    expect(m.tool.active).toBe(true);
    expect(prompt.textContent).toBe(t("feature.move.pickAxis"));
  });

  it("refuses text it cannot read rather than committing the last value", () => {
    const m = setup();
    m.clickArrow();
    m.type("1o");
    m.enter();
    expect(m.added).toEqual([]);
    expect(m.tool.active).toBe(true);
    expect(prompt.textContent).toBe(t("feature.badNumber"));
  });
});
