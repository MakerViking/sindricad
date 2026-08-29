// What the numeric box does while you drag a 3D handle.
//
// Two field reports about the same box, from opposite directions:
//
//   215db097 — "The Press/Pull tool does not display in the input field the
//     distance manually pushed or pulled using the arrow, which makes the arrow
//     effectively useless."
//   f8d48678 — "The manual chamfer adjustment system using the arrow does not
//     provide decimal feedback: you can see the chamfer increasing or
//     decreasing, but the value in the input field is rounded to the nearest
//     whole number."
//
// The first is DimInput's `userDriven` latch. Typing (or seeding, when a feature
// is re-opened for editing) freezes a field so cursor tracking cannot clobber
// what the user wrote — correct, and DimInput has always had `unlock()` for the
// moment a 3D handle is grabbed, since taking hold of a manipulator is as
// deliberate a statement of the value as typing one. Only extrudeTool ever
// called it. Every other arrow in the app left the box frozen at the old figure
// while the geometry moved underneath.
//
// The second is the snap: drag values are snapped to a clean zoom-scaled step
// (5/1/0.5/0.1 mm), which at ordinary zoom is 1 mm, so the box only ever showed
// whole numbers. That default stays — round numbers are what you want almost
// every time — with Ctrl/Cmd as the escape hatch.
import { describe, it, expect } from "vitest";
import { niceStep } from "./units";

// The four tools that own a draggable arrow and a numeric box, and the field
// name each one tracks. extrudeTool is included because it is the one that was
// already right — if it regresses, this catches that too.
const ARROW_TOOLS: { file: string; field: string; src: string }[] = [
  { file: "extrudeTool", field: '"distance"', src: "" },
  { file: "pressPullTool", field: '"distance"', src: "" },
  { file: "edgeFeatureTool", field: "this.field.name", src: "" },
  { file: "faceOffsetTool", field: '"distance"', src: "" },
  { file: "planeOffsetTool", field: '"offset"', src: "" },
];
import extrudeSrc from "../features/extrudeTool.ts?raw";
import pressPullSrc from "../features/pressPullTool.ts?raw";
import edgeSrc from "../features/edgeFeatureTool.ts?raw";
import faceOffsetSrc from "../features/faceOffsetTool.ts?raw";
import planeOffsetSrc from "../features/planeOffsetTool.ts?raw";
import dimInputSrc from "../sketch/dimInput.ts?raw";
import viewportSrc from "../viewport/viewport.ts?raw";
ARROW_TOOLS[0]!.src = extrudeSrc;
ARROW_TOOLS[1]!.src = pressPullSrc;
ARROW_TOOLS[2]!.src = edgeSrc;
ARROW_TOOLS[3]!.src = faceOffsetSrc;
ARROW_TOOLS[4]!.src = planeOffsetSrc;

describe("grabbing a handle hands the box back to the drag", () => {
  it("DimInput still offers the unlock these tools depend on", () => {
    // Guards the guard: if unlock() is renamed or its meaning changes, the
    // assertions below would pass on a string that no longer does anything.
    expect(dimInputSrc, "DimInput.unlock() is gone — the assertions below are vacuous").toContain("unlock(name: string)");
    expect(
      dimInputSrc,
      "updateFromCursor no longer skips userDriven fields, so the latch this unlocks does not exist",
    ).toContain("!f.userDriven");
  });

  for (const t of ARROW_TOOLS) {
    it(`${t.file} unlocks its field when the handle is grabbed`, () => {
      expect(t.src.length, `${t.file} source did not load`).toBeGreaterThan(0);
      expect(
        t.src,
        `${t.file} never calls dim.unlock(), so once the user has typed in the box (or the box `
          + `was seeded by re-opening the feature) dragging the arrow moves the geometry and `
          + `leaves the number frozen — "which makes the arrow effectively useless" (215db097)`,
      ).toContain(`this.dim.unlock(${t.field})`);
    });
  }

  it("unlocks at the GRAB, not at tool start", () => {
    // Unlocking when the tool opens would defeat the latch entirely: a typed
    // value would be overwritten by the next cursor move. It has to happen on
    // the pointerdown that takes hold of the handle.
    for (const t of ARROW_TOOLS) {
      const at = t.src.indexOf(`this.dim.unlock(${t.field})`);
      const before = t.src.slice(Math.max(0, at - 900), at);
      expect(
        before,
        `${t.file} unlocks somewhere that is not a handle grab — a typed value would be `
          + `overwritten by the next pointer move`,
      ).toMatch(/grabProj|this\.grab\s*=|onArrow/);
    }
  });
});

describe("the drag snap has a fine mode", () => {
  it("snapStep takes a `fine` flag and it actually makes the step smaller", () => {
    expect(viewportSrc, "snapStep no longer accepts a fine flag").toMatch(/snapStep\(at: THREE\.Vector3, fine = false\)/);
    // the arithmetic, independent of the viewport: two decades below the coarse
    // step is finer than a pixel of travel at any sane zoom
    const coarse = niceStep(0.12 * 8);
    expect(coarse, "niceStep no longer returns a clean step").toBeGreaterThan(0);
    expect(coarse / 100, "the fine step is not meaningfully finer than the coarse one").toBeLessThan(coarse / 10);
  });

  it("the coarse default really does quantise to whole numbers at ordinary zoom", () => {
    // The report, as arithmetic: at a typical ~0.12 mm/px the step is 1 mm, so
    // every value the box could show is an integer. This is what f8d48678 saw.
    expect(niceStep(0.12 * 8)).toBe(1);
  });

  it("the two tools the reports name pass the modifier through", () => {
    for (const [name, src] of [["edgeFeatureTool", edgeSrc], ["pressPullTool", pressPullSrc]] as const) {
      expect(
        src,
        `${name} snaps its drag without offering the fine modifier, so the arrow can only `
          + `produce whole numbers at ordinary zoom (field report f8d48678)`,
      ).toMatch(/snapStep\(this\.anchor,\s*e\.ctrlKey \|\| e\.metaKey\)/);
    }
  });

  it("tells the user the modifier exists", () => {
    // An escape hatch nobody can discover is not an escape hatch. The reporter
    // could already have zoomed in for a finer step and did not find that either.
    expect(
      edgeSrc,
      "the fillet/chamfer drag prompt does not mention the fine-step modifier",
    ).toMatch(/Ctrl.{0,12}fine|fine steps/i);
  });
});
