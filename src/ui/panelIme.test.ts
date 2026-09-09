// Escape while an IME is converting must not take a floating panel down.
//
// A CJK user's Escape means "cancel the conversion the input method is
// offering", not "close this". Both listeners here are CAPTURE-phase and on
// `window`, so they see that keystroke wherever the caret is — including the
// parameter rows FloatingPanel itself hosts (paramsDialog) and any dimension
// or rename field open behind the measure readout. Closing on it drops the
// panel out from under someone mid-word.
//
// Drives the real FloatingPanel and the real MeasureTool against the fakeDom
// stub and asserts the effect: the panel is still on screen / the tool is still
// measuring, and a genuine Escape still dismisses it.
import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { FakeEl, installFakeDocument } from "./fakeDom.testkit";

/** fakeDom + remove(), so "is it still on screen" is a question a test can ask. */
class El extends FakeEl {
  parent: El | null = null;
  override appendChild(c: FakeEl): FakeEl {
    (c as El).parent = this;
    return super.appendChild(c);
  }
  override append(...cs: FakeEl[]) {
    for (const c of cs) (c as El).parent = this;
    super.append(...cs);
  }
  /** The measure tool detaches its canvas listeners on stop(). Nothing here
   *  dispatches a pointer event, so dropping them is a no-op — but the call has
   *  to exist or the tool cannot be stopped at all. */
  removeEventListener() {}
  remove() {
    const kids = this.parent?.children;
    if (kids) {
      const i = kids.indexOf(this);
      if (i >= 0) kids.splice(i, 1);
    }
    this.parent = null;
  }
}

installFakeDocument();
const doc = globalThis.document as unknown as { createElement(t: string): El; body: El };
doc.createElement = (tag: string) => new El(tag);
const body = new El("body");
doc.body = body;

type Handler = (e: unknown) => void;
const winKeys: Handler[] = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (type: string, fn: Handler) => {
    if (type === "keydown") winKeys.push(fn);
  },
  removeEventListener: (type: string, fn: Handler) => {
    const i = winKeys.indexOf(fn);
    if (type === "keydown" && i >= 0) winKeys.splice(i, 1);
  },
};

const { FloatingPanel } = await import("./panels");
const { MeasureTool } = await import("../features/measureTool");
import type { Viewport } from "../viewport/viewport";

/** A keydown as the engines we ship on report it. The 229 case keeps the real
 *  key name: engines differ on whether they also mask `key` as "Process", and a
 *  fixture that masks it would pass with or without the guard. */
function key(k: string, composing: "no" | "isComposing" | "keyCode229" = "no") {
  return {
    key: k,
    isComposing: composing === "isComposing",
    keyCode: composing === "keyCode229" ? 229 : 0,
    preventDefault() {},
    stopPropagation() {},
    target: null,
  };
}

const press = (e: unknown) => {
  for (const fn of [...winKeys]) fn(e);
};

beforeEach(() => {
  winKeys.length = 0;
  body.children.length = 0;
});

describe("FloatingPanel (Properties / Interference / Overhang) while an IME is composing", () => {
  function open() {
    const panel = new FloatingPanel();
    let closed = 0;
    panel.open("<div>props</div>", { closeOnEsc: true, onClose: () => closed++ });
    return { onScreen: () => body.children.length > 0, closed: () => closed };
  }

  it("stays open when Escape cancels a conversion", () => {
    const p = open();
    expect(p.onScreen()).toBe(true);
    press(key("Escape", "isComposing"));
    expect(p.onScreen()).toBe(true);
    expect(p.closed()).toBe(0);
  });

  it("stays open for an engine that only reports keyCode 229", () => {
    const p = open();
    press(key("Escape", "keyCode229"));
    expect(p.onScreen()).toBe(true);
    expect(p.closed()).toBe(0);
  });

  it("closes on a real Escape", () => {
    const p = open();
    press(key("Escape"));
    expect(p.onScreen()).toBe(false);
    expect(p.closed()).toBe(1);
  });
});

describe("Measure tool while an IME is composing", () => {
  function start() {
    const canvas = new El("canvas");
    const viewport = {
      domElement: canvas as unknown as HTMLElement,
      suspendPicking: false,
      clearSelection: () => {},
      setMeasureMarker: () => {},
      hoverEntity: () => {},
      camera: new THREE.PerspectiveCamera(),
    } as unknown as Viewport;
    const tool = new MeasureTool(viewport);
    let done = 0;
    tool.start(() => done++);
    return { tool, done: () => done };
  }

  it("keeps measuring when Escape cancels a conversion", () => {
    const m = start();
    press(key("Escape", "isComposing"));
    expect(m.tool.active).toBe(true);
    expect(m.done()).toBe(0);
  });

  it("keeps measuring for an engine that only reports keyCode 229", () => {
    const m = start();
    press(key("Escape", "keyCode229"));
    expect(m.tool.active).toBe(true);
  });

  it("still exits on a real Escape", () => {
    const m = start();
    press(key("Escape"));
    expect(m.tool.active).toBe(false);
    expect(m.done()).toBe(1);
  });
});
