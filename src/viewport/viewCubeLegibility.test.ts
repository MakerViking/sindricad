// The navigation cube has to be legible on a dark viewport.
//
// Field report 7bed5869 (0.1.171, Windows): "In dark mode the navigation cube is
// nearly impossible to see... text is unreadable, corner and edge controls are
// invisible. A 'nice to have' would be to grab the cube with the mouse and rotate
// it."
//
// Two separate faults, both arithmetic rather than taste, which is why they can
// be tested rather than eyeballed:
//
//  1. The face plates carried `MeshBasicMaterial({ map, color: COLOR_FACE })`.
//     `color` MULTIPLIES the map. The label canvas was cleared to rgba(0,0,0,0)
//     and the material was `transparent: false`, so alpha was thrown away and
//     each face rendered as texRGB × COLOR_FACE — black where the canvas was
//     clear, and #cdd4de × #2b313c ≈ #222934 where the text was. A multiply can
//     only darken, so no label colour could have fixed it.
//  2. The edge and corner nubs were `opacity: 0` until hovered. Not dim:
//     entirely absent. There was no way to learn they could be clicked.
//
// (The "grab the cube and rotate it" wish is a feature request and is NOT
// addressed here.)
import { describe, it, expect } from "vitest";
import {
  COLOR_FACE, COLOR_FACE_HOVER, COLOR_BODY, COLOR_OUTLINE,
  LABEL_INK, LABEL_INK_HOVER, NUB_IDLE_OPACITY, NUB_HOVER_OPACITY,
} from "./viewCube";
import viewCubeSrc from "./viewCube.ts?raw";

type RGB = [number, number, number];

const fromHexNum = (n: number): RGB => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const fromHexStr = (s: string): RGB => {
  const m = /^#([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${s}`);
  const n = parseInt(m[1]!, 16);
  return fromHexNum(n);
};

/** WCAG relative luminance. */
function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio, 1 (identical) … 21 (black on white). */
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** What a MeshBasicMaterial actually shows: map × color, per channel. */
function multiply(map: RGB, tint: RGB): RGB {
  return [
    Math.round((map[0] * tint[0]) / 255),
    Math.round((map[1] * tint[1]) / 255),
    Math.round((map[2] * tint[2]) / 255),
  ];
}

// WCAG AA for large text. The cube's labels are 56px bold, comfortably "large".
const AA_LARGE = 3;

describe("the cube's labels are readable", () => {
  it("label ink against the face it sits on clears WCAG AA (large)", () => {
    const ratio = contrast(fromHexStr(LABEL_INK), fromHexNum(COLOR_FACE));
    expect(ratio, `label contrast is ${ratio.toFixed(2)}:1 — the text is not readable`).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it("the HOVER state is readable too, not just the idle one", () => {
    // Hover fills the plate with the selection accent; dark ink goes on top.
    const ratio = contrast(fromHexStr(LABEL_INK_HOVER), fromHexNum(COLOR_FACE_HOVER));
    expect(ratio, `hovered label contrast is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it("shows what the old tint did, so the fix cannot be undone by accident", () => {
    // The bug, reproduced as arithmetic. Multiplying the old ink by the old face
    // tint lands within a hair of the black background it sat on.
    const OLD_INK: RGB = fromHexStr("#cdd4de");
    const shown = multiply(OLD_INK, fromHexNum(COLOR_FACE));
    const background = multiply([0, 0, 0], fromHexNum(COLOR_FACE)); // cleared canvas
    const ratio = contrast(shown, background);
    expect(
      ratio,
      "multiplying the label by the face tint no longer destroys it — either the constants "
        + "changed or this reconstruction of the bug is wrong",
    ).toBeLessThan(AA_LARGE);
  });

  it("the face material carries no tint over its map", () => {
    // The behavioural half needs a WebGLRenderer, so the one line that would
    // bring the bug straight back is pinned as source.
    const at = viewCubeSrc.indexOf("map: tex");
    expect(at, "the face plates no longer carry a map — this test's slice is stale").toBeGreaterThan(-1);
    const decl = viewCubeSrc.slice(at, viewCubeSrc.indexOf("}", at));
    expect(
      decl,
      "the face material tints its map again; `color` MULTIPLIES the texture and can only "
        + "darken it, which is exactly how the labels became unreadable (field report 7bed5869)",
    ).toContain("color: 0xffffff");
  });

  it("paints the plate opaquely rather than relying on a cleared canvas", () => {
    const at = viewCubeSrc.indexOf("private paintLabel(");
    expect(at, "no paintLabel() — this test's slice is stale").toBeGreaterThan(-1);
    const body = viewCubeSrc.slice(at, viewCubeSrc.indexOf("\n  }", at));
    expect(
      body,
      "paintLabel no longer fills the plate, so with `transparent: false` the discarded alpha "
        + "renders the face as flat black again",
    ).toContain("fillRect(");
  });
});

describe("the cube is visible at all", () => {
  it("the edge and corner nubs are not invisible when idle", () => {
    expect(
      NUB_IDLE_OPACITY,
      "the nubs are back to opacity 0 — \"corner and edge controls are invisible\" (7bed5869)",
    ).toBeGreaterThan(0.15);
    expect(NUB_IDLE_OPACITY, "the idle nubs are so solid they compete with the faces").toBeLessThan(0.6);
    expect(NUB_HOVER_OPACITY, "hovering a nub no longer makes it stand out").toBeGreaterThan(NUB_IDLE_OPACITY);
  });

  it("the silhouette reads against a dark viewport", () => {
    // The outline used to be #05070a — a black line around a dark cube on a dark
    // background. Measured against the darkest thing behind it.
    const VIEWPORT_DARK: RGB = [0x14, 0x17, 0x1c];
    expect(
      contrast(fromHexNum(COLOR_OUTLINE), VIEWPORT_DARK),
      "the cube's outline does not separate it from the viewport behind it",
    ).toBeGreaterThan(2);
  });

  it("the filler body reads as a solid cube, not as holes between the plates", () => {
    expect(
      contrast(fromHexNum(COLOR_BODY), [0x14, 0x17, 0x1c]),
      "the cube's body is as dark as the viewport, so the gaps between face plates read as holes",
    ).toBeGreaterThan(1.5);
  });
});
