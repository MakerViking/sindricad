// keystrokeGuard holds a panel's re-render while a value is being typed in it,
// and must let go once the typing is over. A 'change' event used to be the only
// thing that let go, and a box closed with Escape (the parameters panel's name
// box) or text typed and then typed back fires none: the panel then skipped
// every later document change, an undo included.
import { describe, it, expect } from "vitest";
import { FakeEl } from "./fakeDom.testkit";
import { keystrokeGuard } from "./liveInputs";

describe("keystrokeGuard", () => {
  it("holds the render while a value is typed, and draws again once it is committed", () => {
    const root = new FakeEl("div");
    let renders = 0;
    const guarded = keystrokeGuard(root as unknown as HTMLElement, () => renders++);
    root.dispatch("input");
    guarded();
    expect(renders).toBe(0);
    root.dispatch("change");
    guarded();
    expect(renders).toBe(1);
  });

  it("draws again once focus leaves a box that never fired a change", () => {
    const root = new FakeEl("div");
    let renders = 0;
    const guarded = keystrokeGuard(root as unknown as HTMLElement, () => renders++);
    root.dispatch("input");
    root.dispatch("focusout");
    guarded();
    expect(renders).toBe(1);
  });
});
