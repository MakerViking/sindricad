// The ribbon was re-laid-out after every sketch solve (GH #17).
//
// main.ts's sketch.onState runs setContext + setActiveSketchTool, and onState
// fired at the end of every solve, a drag frame included. setContext always
// ran reflow(), which reads clientWidth/offsetWidth: a forced layout of the
// whole ribbon, measured at a 1.6 ms share of every drag frame on the
// reporter's sketch, for a ribbon that had not changed. These count how often
// the ribbon re-packs for the calls onState actually makes.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeEl, installFakeDocument } from "./fakeDom.testkit";
import { Ribbon } from "./ribbon";

installFakeDocument();
vi.stubGlobal("ResizeObserver", class { observe() {} });

const reflow = vi.spyOn(Ribbon.prototype as unknown as { reflow: () => void }, "reflow");

/** The private state a test reaches into: the popup the ribbon holds open. */
type Inside = { sketch: { el: Record<string, unknown> }; overflowPopup: { remove(): void } | null };

/** A ribbon as main.ts mounts it, with the one DOM call the stub lacks. */
function mount(): Ribbon {
  const r = new Ribbon(new FakeEl("div") as unknown as HTMLElement);
  (r as unknown as Inside).sketch.el.querySelectorAll = () => [];
  return r;
}

/** exactly what sketch.onState does to the ribbon on every call */
const onState = (r: Ribbon, tool: string) => {
  r.setContext("sketch");
  r.setActiveSketchTool(tool);
};

beforeEach(() => {
  reflow.mockClear();
});

describe("the ribbon re-packs when its layout can change, not on every sketch update (GH #17)", () => {
  it("re-packs on entering the sketch context, and not again for the same context", () => {
    const r = mount();
    reflow.mockClear();
    onState(r, "select"); // entering the sketch
    expect(reflow).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) onState(r, "select"); // ten solves, ten drag frames
    // RED on 83ecd3d: one re-pack per call, 11 in all
    expect(reflow).toHaveBeenCalledTimes(1);
    r.setContext("model"); // leaving it is a real switch
    expect(reflow).toHaveBeenCalledTimes(2);
  });

  it("still closes an open popup on every update: Escape and a tool change rely on it", () => {
    const r = mount();
    onState(r, "select");
    let removed = 0;
    const inside = r as unknown as Inside;
    inside.overflowPopup = { remove: () => { removed++; } };
    onState(r, "select"); // same context, so no re-pack...
    expect(removed).toBe(1); // ...but the popup is gone
    expect(inside.overflowPopup).toBeNull();
  });

  it("re-packs when a tool swaps a split button's face, which can change its width", () => {
    const r = mount();
    onState(r, "select");
    reflow.mockClear();
    onState(r, "vertical"); // the Constrain split's face goes from Horizontal to Vertical
    expect(reflow).toHaveBeenCalledTimes(1);
    onState(r, "vertical"); // already showing
    onState(r, "select"); // not in a split
    expect(reflow).toHaveBeenCalledTimes(1);
  });
});
