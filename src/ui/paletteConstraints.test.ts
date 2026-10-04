// The constraints as an icon grid in the Sketch Palette (round 2 decision B6,
// Doug L1).
//
// The ribbon folds its twelve constraints and Lock Dimension into one Constrain
// dropdown, and that group is the first to fold into "More" on a narrow window,
// so on a laptop every constraint was two or three clicks away. The palette
// now lists them all as icons, one click each, while the ribbon keeps its
// Constrain group exactly as it was.
//
// Rendered against the fake DOM, and pressed the way a user presses: a click
// event on the button.
import { describe, it, expect } from "vitest";
import { FakeEl, installFakeDocument } from "./fakeDom.testkit";

installFakeDocument();

import { SketchPalette } from "./sketchPalette";
import { SKETCH, leavesOf } from "./ribbon";

/** the palette's grid buttons, as rendered */
function grid() {
  const host = new FakeEl("aside");
  const palette = new SketchPalette(host as unknown as HTMLElement);
  const buttons = host.children.filter((c) => c.className === "palette-grid").flatMap((g) => g.children);
  return { palette, buttons };
}

const EVERY_CONSTRAINT = [
  "horizontal", "vertical", "parallel", "perpendicular", "equal", "tangent", "coincident",
  "concentric", "midpoint", "collinear", "symmetric", "fix", "lockDimension",
];

describe("the Sketch Palette's constraint grid", () => {
  it("offers every constraint tool, each as its own button", () => {
    const { buttons } = grid();
    expect(buttons.map((b) => b.dataset.action)).toEqual(EVERY_CONSTRAINT);
    expect(buttons.every((b) => b.tagName === "button" && b.className === "palette-tool")).toBe(true);
  });

  it("names each tool in full in its tooltip, where the ribbon has to shorten it", () => {
    const { buttons } = grid();
    const perp = buttons.find((b) => b.dataset.action === "perpendicular")!;
    expect(perp.title).toBe("Perpendicular");
    expect(perp.attrs["aria-label"]).toBe("Perpendicular");
    expect(buttons.find((b) => b.dataset.action === "lockDimension")!.title).toBe("Lock Dimension");
  });

  it("a click picks that tool through the same action the ribbon sends", () => {
    const { palette, buttons } = grid();
    const sent: string[] = [];
    palette.onAction = (a) => sent.push(a);
    buttons.find((b) => b.dataset.action === "tangent")!.dispatch("click");
    buttons.find((b) => b.dataset.action === "lockDimension")!.dispatch("click");
    expect(sent).toEqual(["tangent", "lockDimension"]);
  });

  it("lights the armed tool, and only that one", () => {
    const { palette, buttons } = grid();
    palette.setActiveTool("coincident");
    expect(buttons.filter((b) => b.classList.contains("active")).map((b) => b.dataset.action)).toEqual(["coincident"]);
    palette.setActiveTool("line");
    expect(buttons.some((b) => b.classList.contains("active"))).toBe(false);
  });

  it("leaves the ribbon's Constrain group as it was", () => {
    const group = SKETCH.find((g) => g.id === "CONSTRAINTS")!;
    expect(group.items.map((it) => ("children" in it ? leavesOf(it).map((l) => l.action) : it.action))).toEqual([
      "check-sketch",
      EVERY_CONSTRAINT,
    ]);
  });
});
