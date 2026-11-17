// Choosing Rect or Circular Pattern keeps what is selected (field report
// 84d7021f: "I added a circle, selected it, then tried rectangular pattern -
// it did not offer any obvious way to control it"). An entity pattern copies
// the selection, but choosing the tool cleared it, so the first click on the
// canvas always answered "Select entities first". Selected through a real
// click, then the real setTool, which is what the ribbon calls.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
vi.mock("../ui/toast", () => ({ toast: () => () => {} }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));

import { liveSketch } from "./liveSketch.testkit";
import type { SketchTool } from "./sketchMode";

describe("choosing an entity pattern keeps the selection it will copy", () => {
  for (const tool of ["patternRect", "patternCircular"] as SketchTool[]) {
    it(`${tool} starts with the selected circle still selected`, () => {
      const live = liveSketch([{ type: "circle", id: "C", x: 20, y: 20, radius: 5 }]);
      live.click(25, 20); // on the circle
      expect([...live.s.selected]).toEqual(["C"]);
      (live.s as unknown as { setTool(t: SketchTool): void }).setTool(tool);
      expect([...live.s.selected]).toEqual(["C"]);
    });
  }

  it("control: a drawing tool still starts from a clean selection", () => {
    const live = liveSketch([{ type: "circle", id: "C", x: 20, y: 20, radius: 5 }]);
    live.click(25, 20);
    (live.s as unknown as { setTool(t: SketchTool): void }).setTool("line");
    expect([...live.s.selected]).toEqual([]);
  });
});
