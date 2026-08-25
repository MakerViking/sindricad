// A visible sketch's profile areas must be pickable in BOTH selection modes.
//
// Field report (2026-08-26, Thomas): "I now only can select the sketch parts
// when in sketch mode, this used to work in non sketch mode too." It had nothing
// to do with sketch mode. He had switched the viewport to BODIES selection to
// assign filament slots to the extruded bodies, and never switched back — the
// mode is sticky, and its only indicator is a small chip reading "Faces" /
// "Bodies" sitting in a row of CAMERA buttons (ISO / Top / Front / Right / Fit /
// Auto / Faces), which reads as another view button.
//
// In bodies mode both handlers returned before the region hooks were consulted:
//   handleHover: `if (this.selectionMode === "bodies") return;`
//   handleClick: the bodies branch returns after picking a body
// so sketch hover AND sketch click died together, silently, and stayed dead.
//
// The mode chooses face-vs-body granularity for the SOLID. A sketch profile is
// neither a face nor a body, so the mode has no business disabling it — and the
// click path's own comment already says "Sketch has PRIORITY over the body".
//
// Asserted on source order because constructing a Viewport needs WebGL. What
// broke was the ORDER of two guards, which is exactly what this pins.

import { describe, it, expect } from "vitest";
import viewportSrc from "./viewport.ts?raw";

/** The body of a method, brace-matched from its declaration. */
function methodBody(name: string): string {
  const at = viewportSrc.indexOf(name);
  expect(at, `${name} is gone from viewport.ts — this test no longer knows where picking is decided`).toBeGreaterThan(-1);
  const open = viewportSrc.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < viewportSrc.length; i++) {
    if (viewportSrc[i] === "{") depth++;
    else if (viewportSrc[i] === "}" && --depth === 0) return viewportSrc.slice(open, i + 1);
  }
  throw new Error("unbalanced braces");
}

describe("sketch areas are pickable in bodies mode", () => {
  it("hover consults the sketch BEFORE the bodies-mode return", () => {
    const body = methodBody("private handleHover(");
    const region = body.indexOf("this.regionHoverAt?.(e.clientX, e.clientY)");
    const bodiesReturn = body.indexOf('this.selectionMode === "bodies"');
    expect(region, "handleHover no longer consults regionHoverAt").toBeGreaterThan(-1);
    expect(bodiesReturn).toBeGreaterThan(-1);
    expect(region, "the bodies-mode return fires first — sketch hover is dead again").toBeLessThan(bodiesReturn);
  });

  it("click consults the sketch BEFORE the bodies branch", () => {
    const body = methodBody("private handleClick(");
    const region = body.indexOf("this.regionPickAt?.(e.clientX, e.clientY");
    const bodiesBranch = body.indexOf("--- Bodies mode:");
    expect(region).toBeGreaterThan(-1);
    expect(bodiesBranch).toBeGreaterThan(-1);
    expect(region, "the bodies branch returns first — sketch click is dead again").toBeLessThan(bodiesBranch);
  });

  it("still lets an EDGE hit beat a sketch area in faces mode", () => {
    // An edge is a more specific target than the area behind it. That rule is
    // older than this fix and must survive it.
    const body = methodBody("private handleClick(");
    expect(body).toMatch(/hit\?\.kind !== "edge" && this\.regionPickAt\?\./);
  });

  it("keeps picking suppressed when the app has suppressed it", () => {
    // pickSuppressed is a separate gate (a tool owns the gesture, or a chunked
    // reply is streaming) and must still short-circuit everything, including the
    // new sketch-first path.
    for (const m of ["private handleHover(", "private handleClick("]) {
      const body = methodBody(m);
      const supp = body.indexOf("this.pickSuppressed");
      const region = body.search(/this\.region(Hover|Pick)At\?\./);
      expect(supp).toBeGreaterThan(-1);
      expect(supp, `${m}: pickSuppressed must gate the sketch path too`).toBeLessThan(region);
    }
  });
});
