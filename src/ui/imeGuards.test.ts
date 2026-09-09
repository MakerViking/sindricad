// Every keyboard handler that can cancel or commit while a Japanese IME
// conversion is open. Escape cancels a conversion; Enter confirms a candidate;
// the arrow keys walk the candidate list. A handler that acts on any of those
// mid-composition takes the keystroke the IME was waiting for AND does
// something the user never asked for — closes the tool, reverts the edit,
// steps the number.
//
// Asserted against the SOURCE, and deliberately: these handlers are registered
// on `window` in capture phase inside classes that need a WebGL viewport, and
// this repo has no jsdom. What it pins is the single thing that regressed —
// that a handler intercepting those keys consults the shared guard at all. The
// behavioural half lives in textPanel.test.ts and textOnFacePanel.test.ts,
// which drive real panel objects over the fake-DOM stub.
//
// `?raw` rather than node:fs: that is how this repo already reads its own
// source in a test (see dragHandleValue.test.ts), and tsconfig carries no node
// types, so the fs import does not even compile.
import { describe, expect, it } from "vitest";

import extrudeSrc from "../features/extrudeTool.ts?raw";
import pressPullSrc from "../features/pressPullTool.ts?raw";
import faceOffsetSrc from "../features/faceOffsetTool.ts?raw";
import sectionSrc from "../features/sectionTool.ts?raw";
import textureToolSrc from "../features/textureTool.ts?raw";
import textOnFaceToolSrc from "../features/textOnFaceTool.ts?raw";
import textPanelSrc from "../sketch/textPanel.ts?raw";
import textOnFacePanelSrc from "../features/textOnFacePanel.ts?raw";
import unitsSrc from "./units.ts?raw";
import focusSrc from "./focus.ts?raw";

const INTERCEPTORS: [string, string][] = [
  ["extrudeTool", extrudeSrc],
  ["pressPullTool", pressPullSrc],
  ["faceOffsetTool", faceOffsetSrc],
  ["sectionTool", sectionSrc],
  ["textureTool", textureToolSrc],
  ["textOnFaceTool", textOnFaceToolSrc],
  ["sketch textPanel", textPanelSrc],
  ["textOnFacePanel", textOnFacePanelSrc],
  ["units numericInput", unitsSrc],
];

describe("IME composition is respected wherever a key is intercepted", () => {
  for (const [name, src] of INTERCEPTORS) {
    it(`${name} consults the shared guard`, () => {
      expect(src, `${name} intercepts keys but never asks whether an IME is composing`).toContain(
        "isImeComposing",
      );
      // ONE implementation of the rule. A second copy is how two handlers end
      // up disagreeing about what "composing" means.
      expect(src, `${name} defines its own composition test instead of importing the shared one`).not.toMatch(
        /function isImeComposing/,
      );
    });
  }

  it("the shared guard reads both signals", () => {
    // `isComposing` is the standard one; keyCode 229 is what several engines
    // report for a key pressed during a composition, and on some of them it is
    // the only signal there is.
    expect(focusSrc).toContain("isComposing");
    expect(focusSrc).toContain("229");
  });
});
