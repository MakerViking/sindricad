// What the tool badge actually does to the screen: whether it is showing, where
// it is, and which tool it claims.
//
// Rendered against the same element stub the inspector and timeline tests use
// (fakeDom.testkit.ts) — no jsdom in this repo. The host is a hand-rolled stub
// rather than a FakeEl because the one thing FakeEl cannot do is FORGET a
// listener, and "unmount leaks no global handler" is a behaviour worth holding.
import { describe, it, expect, beforeEach } from "vitest";
import { FakeEl, installFakeDocument } from "./fakeDom.testkit";
import { cursorSvg, mountToolCursor, type CursorRasteriser } from "./toolCursor";
import { icon, type IconName } from "./icons";
import { ViewCube } from "../viewport/viewCube";

installFakeDocument();

/** A listener target that can be asked what it is still listening for. */
class HostStub {
  readonly children: FakeEl[] = [];
  private handlers: Record<string, ((ev: unknown) => void)[]> = {};

  appendChild(c: FakeEl) {
    this.children.push(c);
    return c;
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.handlers[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void) {
    this.handlers[type] = (this.handlers[type] ?? []).filter((h) => h !== fn);
  }
  dispatch(type: string, ev?: unknown) {
    for (const fn of this.handlers[type] ?? []) fn(ev);
  }
  listenerCount() {
    return Object.values(this.handlers).reduce((n, hs) => n + hs.length, 0);
  }
}

const CANVAS = new FakeEl("canvas");
const PANEL = new FakeEl("aside"); // stands in for the palette / view controls

let host: HostStub;
let badge: FakeEl;
let cursor: ReturnType<typeof mountToolCursor>;

beforeEach(() => {
  host = new HostStub();
  cursor = mountToolCursor(host as unknown as HTMLElement, CANVAS as unknown as HTMLElement);
  const first = host.children[0];
  if (!first) throw new Error("mount appended nothing");
  badge = first;
});

/** The pointer at (x, y) over `target`. */
const move = (x: number, y: number, target: unknown = CANVAS) =>
  host.dispatch("pointermove", { clientX: x, clientY: y, target });

const showing = () => !badge.classList.contains("hidden");

describe("tool cursor badge", () => {
  it("stays hidden until a tool is armed", () => {
    expect(showing()).toBe(false);
    move(100, 100);
    expect(showing()).toBe(false); // pointer on the canvas, but nothing to report

    cursor.setTool("line");
    expect(showing()).toBe(true);
  });

  it("hides again when the tool is put away", () => {
    cursor.setTool("circle");
    move(100, 100);
    expect(showing()).toBe(true);

    cursor.setTool(null);
    expect(showing()).toBe(false);
  });

  it("treats Select as no tool", () => {
    // Select is the way OUT of every other tool and its icon is a pointer; a
    // pointer glyph trailing the pointer reads as a rendering bug.
    cursor.setTool("select");
    move(100, 100);
    expect(showing()).toBe(false);
  });

  it("follows the pointer, below and to the right of it", () => {
    cursor.setTool("line");
    move(200, 300);
    const first = badge.style.transform ?? "";
    const [x1, y1] = coords(first);
    expect(x1).toBeGreaterThan(200);
    expect(y1).toBeGreaterThan(300);
    // close enough to be read as attached to the pointer, not parked nearby
    expect(x1 - 200).toBeLessThan(40);
    expect(y1 - 300).toBeLessThan(40);

    move(210, 290);
    const [x2, y2] = coords(badge.style.transform ?? "");
    expect(x2 - x1).toBe(10);
    expect(y2 - y1).toBe(-10);
  });

  it("shows the armed tool's own icon, from icons.ts", () => {
    // Asserted through icon() rather than on the markup because the element stub
    // parses none: what matters is that the name RESOLVES — a name that doesn't
    // renders as an empty <svg>, which is the failure this typing exists to stop.
    for (const [tool, expected] of [
      ["line", "line"],
      ["centerRectangle", "centerRectangle"],
      ["dimension", "dimension"],
      // sketch tool names the ribbon spells with a -sketch suffix
      ["fillet", "fillet"],
      ["rotate", "rotate"],
    ] as [string, IconName][]) {
      cursor.setTool(tool);
      expect(badge.dataset.tool).toBe(expected);
      const svg = icon(badge.dataset.tool as IconName);
      expect(svg).not.toContain("undefined");
      expect(svg.length).toBeGreaterThan(80);
    }
  });

  it("does not show over a panel, only over the canvas", () => {
    cursor.setTool("line");
    move(100, 100);
    expect(showing()).toBe(true);

    move(100, 100, PANEL);
    expect(showing()).toBe(false);

    move(120, 120);
    expect(showing()).toBe(true);
  });

  it("hides when the pointer leaves the window", () => {
    cursor.setTool("line");
    move(100, 100);
    host.dispatch("pointerleave");
    expect(showing()).toBe(false);
  });

  it("drops every listener on unmount", () => {
    cursor.setTool("line");
    move(100, 100);
    expect(host.listenerCount()).toBeGreaterThan(0);

    cursor.unmount();
    expect(host.listenerCount()).toBe(0);
  });
});

// The badge is a DOM element chasing the pointer, so it trails it by the
// webview's whole input-to-screen pipeline; the #17 reporter saw it lag "as if
// it were attached to the cursor with an elastic connection". Drawn INTO the
// pointer as a CSS cursor image, the OS moves it with the pointer itself. The
// image is rasterised in the browser (verified by hand in Chromium and in
// WebKitGTK 2.52); these hold what this module does with the result.
describe("the tool rides the OS pointer as a cursor image (GH #17)", () => {
  const IMAGE = 'url("data:image/png;base64,AAAA") 9 9, crosshair';
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  function mountWith(rasterise: CursorRasteriser) {
    const h = new HostStub();
    const canvas = new FakeEl("canvas");
    const c = mountToolCursor(h as unknown as HTMLElement, canvas as unknown as HTMLElement, rasterise);
    const b = h.children[0]!;
    return {
      c,
      canvas,
      move: (x: number, y: number) => h.dispatch("pointermove", { clientX: x, clientY: y, target: canvas }),
      showing: () => !b.classList.contains("hidden"),
    };
  }

  it("puts the armed tool's icon into the canvas cursor, and the DOM badge steps aside", async () => {
    const asked: string[] = [];
    const m = mountWith(async (name) => { asked.push(name); return IMAGE; });
    m.c.setTool("line");
    m.move(100, 100);
    expect(m.showing(), "the badge stands in while the image is built").toBe(true);
    await settle();
    // RED on 83ecd3d: no cursor image at all, only the chasing badge
    expect(m.canvas.style.cursor).toBe(IMAGE);
    expect(m.showing()).toBe(false);
    m.move(140, 120);
    expect(m.showing(), "moving does not bring the badge back").toBe(false);
    // built once per icon, then reused
    m.c.setTool("circle");
    await settle();
    m.c.setTool("line");
    await settle();
    expect(asked).toEqual(["line", "circle"]);
    expect(m.canvas.style.cursor).toBe(IMAGE);
  });

  it("gives the canvas its own cursor back when the tool is put away, or on unmount", async () => {
    const m = mountWith(async () => IMAGE);
    m.c.setTool("line");
    await settle();
    m.c.setTool("select");
    expect(m.canvas.style.cursor).toBe("");
    m.c.setTool("line");
    expect(m.canvas.style.cursor).toBe(IMAGE); // cached: no wait the second time
    m.c.unmount();
    expect(m.canvas.style.cursor).toBe("");
  });

  it("keeps the DOM badge where the engine cannot have the image", async () => {
    const m = mountWith(async () => null);
    m.c.setTool("line");
    m.move(100, 100);
    await settle();
    expect(m.canvas.style.cursor ?? "").toBe("");
    expect(m.showing()).toBe(true);
  });

  it("never takes back a cursor another tool set on the same canvas", async () => {
    const m = mountWith(async () => IMAGE);
    m.c.setTool("line");
    await settle();
    m.canvas.style.cursor = "grab"; // a modeling tool's handle hover
    m.c.setTool(null);
    expect(m.canvas.style.cursor).toBe("grab");
  });

  // The ViewCube writes the same canvas's cursor from its own pointermove
  // listener, which runs before this module's (canvas, then body). Driven
  // through its real setHover: over a corner nub, then off the cube.
  it("gets the image back after the ViewCube borrows the cursor, and shows the badge meanwhile", async () => {
    const m = mountWith(async () => IMAGE);
    m.c.setTool("line");
    await settle();
    m.move(400, 300);
    expect(m.canvas.style.cursor).toBe(IMAGE);
    const setHover = (ViewCube.prototype as unknown as { setHover: (part: unknown) => void }).setHover;
    const cube = { canvas: m.canvas, hovered: null, repaintFace() {} };
    const nub = { kind: "corner", mesh: { material: { color: { setHex() {} }, opacity: 1 } }, baseColor: 0, hoverColor: 0 };

    setHover.call(cube, nub);
    m.move(1500, 60);
    expect(m.canvas.style.cursor, "the cube's own cursor wins over its corner").toBe("pointer");
    expect(m.showing(), "...and the DOM badge still says which tool is armed").toBe(true);

    setHover.call(cube, null);
    m.move(400, 300);
    // RED before this was fixed: the cube's "" had wiped the image, and the
    // badge stayed hidden because the module still thought its image was up.
    // No sign of the armed tool at all, until the next tool change.
    expect(m.canvas.style.cursor).toBe(IMAGE);
    expect(m.showing()).toBe(false);
  });

  it("lets any other non-empty cursor on the canvas win, and the DOM badge stands in", async () => {
    const m = mountWith(async () => IMAGE);
    m.c.setTool("line");
    await settle();
    expect(m.canvas.style.cursor).toBe(IMAGE);
    m.canvas.style.cursor = "grab"; // the canvas is shared: the modeling tools write grab/pointer/default
    m.move(100, 100);
    expect(m.canvas.style.cursor).toBe("grab");
    expect(m.showing()).toBe(true);
  });

  it("draws the crosshair on the hotspot it declares, in the stylesheet's colours only", () => {
    const svg = cursorSvg("line", { line: "L", halo: "H", chip: "C", edge: "E", glyph: "G", radius: 3 });
    // the declared hotspot is 9 9 (see rasteriseCursor): the arms meet on pixel 9's centre
    expect(svg).toContain("M1.5 9.5H7.5M11.5 9.5H17.5M9.5 1.5V7.5M9.5 11.5V17.5");
    expect(svg).toContain(icon("line").slice("<svg ".length, 40)); // the ribbon's own glyph
    expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b/i); // no colour of its own
  });
});

/** the x/y out of `translate(<x>px, <y>px)` */
function coords(transform: string): [number, number] {
  const m = /translate\(\s*(-?[\d.]+)px[ ,]+(-?[\d.]+)px\s*\)/.exec(transform);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new Error(`not a translate: ${JSON.stringify(transform)}`);
  }
  return [Number(m[1]), Number(m[2])];
}
