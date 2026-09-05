// The datum-plane highlight channels: SELECTED and HOVERED, and the fact that
// they compose rather than fight.
//
// Field report c0cfee48 asked for hover feedback on an offset plane during an
// "up to" pick. The naive fix is to call highlightDatum on hover — and that
// ships two regressions at once: it overwrites `selectedDatum`, so the tool's
// hover silently becomes the document's selection, and the moment the cursor
// leaves a plane it dims the SELECTED one back to idle. Hence a second channel
// and one painter, with selected outranking hovered outranking idle.
//
// Constructing a Viewport needs WebGL, so the methods are taken off the
// prototype and given a stand-in `this` (the pattern faceAnchor.test.ts uses).
// The bodies — the precedence, the opacity numbers — are the real ones.

import { describe, it, expect } from "vitest";
import { Viewport } from "./viewport";

const proto = Viewport.prototype as unknown as {
  highlightDatum(id: string | null): void;
  hoverDatum(id: string | null): void;
  paintDatums(): void;
};

function planes(...ids: string[]) {
  const quads = ids.map((id) => ({ userData: { datumId: id }, material: { opacity: 0.12 } }));
  let renders = 0;
  const self = {
    datumQuads: quads,
    selectedDatum: null as string | null,
    hoveredDatum: null as string | null,
    requestRender: () => { renders++; },
    paintDatums: proto.paintDatums,
  };
  return {
    select: (id: string | null) => proto.highlightDatum.call(self as never, id),
    hover: (id: string | null) => proto.hoverDatum.call(self as never, id),
    opacity: (id: string) => quads.find((q) => q.userData.datumId === id)!.material.opacity,
    selectedDatum: () => self.selectedDatum,
    renders: () => renders,
  };
}

describe("datum plane highlight", () => {
  it("brightens the hovered plane above idle, but below selected", () => {
    const p = planes("a", "b");

    p.hover("b");

    expect(p.opacity("b")).toBe(0.24);
    expect(p.opacity("a")).toBe(0.12);
  });

  it("hovering does not steal the selection", () => {
    const p = planes("a", "b");
    p.select("a");

    p.hover("b");

    // both lit, and the selected one still reads as the brighter of the two
    expect(p.opacity("a")).toBe(0.32);
    expect(p.opacity("b")).toBe(0.24);
    expect(p.selectedDatum()).toBe("a");
  });

  it("un-hovering leaves the selected plane alone", () => {
    const p = planes("a", "b");
    p.select("a");
    p.hover("b");

    p.hover(null);

    expect(p.opacity("b")).toBe(0.12);
    expect(p.opacity("a")).toBe(0.32);
  });

  it("hovering the selected plane keeps it at the selected brightness", () => {
    const p = planes("a");
    p.select("a");

    p.hover("a");
    expect(p.opacity("a")).toBe(0.32);

    p.hover(null);
    expect(p.opacity("a")).toBe(0.32);
  });

  it("repeats of the same hover do not repaint", () => {
    // onMove fires per pixel of cursor travel; repainting (and re-rendering) on
    // every one of them for an unchanged highlight is pure waste.
    const p = planes("a");
    p.hover("a");
    const after = p.renders();

    p.hover("a");
    p.hover("a");

    expect(p.renders()).toBe(after);
  });
});
