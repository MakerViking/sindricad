// What the tool badge actually does to the screen: whether it is showing, where
// it is, and which tool it claims.
//
// Rendered against the same element stub the inspector and timeline tests use
// (fakeDom.testkit.ts) — no jsdom in this repo. The host is a hand-rolled stub
// rather than a FakeEl because the one thing FakeEl cannot do is FORGET a
// listener, and "unmount leaks no global handler" is a behaviour worth holding.
import { describe, it, expect, beforeEach } from "vitest";
import { FakeEl, installFakeDocument } from "./fakeDom.testkit";
import { mountToolCursor } from "./toolCursor";
import { icon, type IconName } from "./icons";

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

/** the x/y out of `translate(<x>px, <y>px)` */
function coords(transform: string): [number, number] {
  const m = /translate\(\s*(-?[\d.]+)px[ ,]+(-?[\d.]+)px\s*\)/.exec(transform);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new Error(`not a translate: ${JSON.stringify(transform)}`);
  }
  return [Number(m[1]), Number(m[2])];
}
