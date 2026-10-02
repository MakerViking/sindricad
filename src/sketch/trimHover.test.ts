// The Trim hover shows EXACTLY the piece the click removes.
//
// Field reports 04f02508 + 65a9c203 (same reporter, same day): "Trim tool does
// not trim to the nearest crossing, it deletes the whole line", retracted an
// hour later with "it does work... there is no highlight to show which section
// will be trimmed - this confused me". With Trim armed, hovering a curve lit the
// WHOLE entity red, on the stated premise that trim acts on whole entities. It
// does not: it removes the span between the nearest crossings. The highlight
// predicted a different trim from the one the click made.
//
// These enter where the user does: a pointermove with Trim armed (onPointerMove
// -> modifyHover) records what is drawn red, and a press at the same spot
// (onPointerDown -> trimClick) makes the real trim. The oracle is the shape of
// the result, sampled densely along the ORIGINAL curve: every point of it must
// be on the red piece or on what the click kept, never on both and never on
// neither. A whole-entity highlight fails that wherever anything is kept.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";

const { drawn, toasts } = vi.hoisted(() => ({ drawn: [] as unknown[][], toasts: [] as string[] }));
vi.mock("./overlay", async (importOriginal) => {
  const real = await importOriginal<typeof import("./overlay")>();
  // record what the hover draws; draw nothing (no WebGL here)
  return { ...real, curveObjects: (ents: unknown[]) => { drawn.push(ents); return []; } };
});
vi.mock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));

import { SketchMode } from "./sketchMode";
import { arcCenterRadius } from "./arc";
import { distToSeg } from "./geom2d";
import { rectCorners } from "./region";
import { newEntityId } from "./id";
import type { ResolvedEntity } from "./snap";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const TAU = Math.PI * 2;
const ccw = (from: number, to: number) => (((to - from) % TAU) + TAU) % TAU;

interface Priv {
  onPointerMove(e: PointerEvent): void;
  onPointerDown(e: PointerEvent): void;
  entities: ResolvedEntity[];
}

/** a SketchMode with Trim armed, whose collaborators are stubs and whose
 *  cursor is wherever `at` says */
function trimMode(entities: ResolvedEntity[]) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  const cursor = { p: v(0, 0) };
  Object.assign(s, {
    active: true, tool: "trim", entities, constraints: [], patterns: [],
    rightDownAt: null, boxSel: null, offsetPick: null, filletFirst: null, lastPress: null,
    plane: {}, selected: new Set<string>(),
    dims: { clearSelection() {} },
    overlay: { setPreview: () => {} },
    planePoint: () => cursor.p.clone(),
    pickTol: () => 1,
    refreshActive: () => {},
    requestSolve: () => {},
    onState: () => {},
  });
  const ev = { button: 0, clientX: 0, clientY: 0, shiftKey: false, ctrlKey: false, preventDefault() {}, stopPropagation() {} };
  const priv = s as unknown as Priv;
  return {
    hover(at: THREE.Vector2): ResolvedEntity {
      cursor.p = at;
      drawn.length = 0;
      priv.onPointerMove(ev as unknown as PointerEvent);
      const red = drawn[0] as ResolvedEntity[] | undefined;
      expect(red, "the trim hover drew nothing").toBeDefined();
      return red![0]!;
    },
    click(at: THREE.Vector2): ResolvedEntity[] {
      cursor.p = at;
      priv.onPointerDown(ev as unknown as PointerEvent);
      return priv.entities;
    },
  };
}

/** distance from p to a line, arc or circle — exact, not tessellated */
function distTo(e: ResolvedEntity, p: THREE.Vector2): number {
  if (e.type === "line") return distToSeg(v(e.x1, e.y1), v(e.x2, e.y2), p);
  if (e.type === "circle") return Math.abs(p.distanceTo(v(e.x, e.y)) - e.radius);
  if (e.type === "arc") {
    const { c, r } = arcCenterRadius(e)!;
    const a = (x: number, y: number) => Math.atan2(y - c.y, x - c.x);
    const aS = a(e.x1, e.y1), aE = a(e.x2, e.y2), aT = a(e.mx, e.my);
    const [s, sweep] = ccw(aS, aT) <= ccw(aS, aE) ? [aS, ccw(aS, aE)] : [aE, ccw(aE, aS)];
    if (ccw(s, a(p.x, p.y)) <= sweep) return Math.abs(p.distanceTo(c) - r);
    return Math.min(p.distanceTo(v(e.x1, e.y1)), p.distanceTo(v(e.x2, e.y2)));
  }
  throw new Error(`distTo: ${e.type}`);
}

/** dense samples along the original curve */
function samples(e: ResolvedEntity, n = 2000): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  const seg = (a: THREE.Vector2, b: THREE.Vector2) => {
    for (let i = 1; i < n; i++) out.push(a.clone().lerp(b, i / n));
  };
  if (e.type === "line") seg(v(e.x1, e.y1), v(e.x2, e.y2));
  else if (e.type === "rectangle") {
    const c = rectCorners(e.x, e.y, e.width, e.height);
    c.forEach((a, k) => seg(a, c[(k + 1) % 4]!));
  } else if (e.type === "circle") {
    for (let i = 0; i < n; i++) out.push(v(e.x + Math.cos((i / n) * TAU) * e.radius, e.y + Math.sin((i / n) * TAU) * e.radius));
  } else if (e.type === "arc") {
    const { c, r } = arcCenterRadius(e)!;
    const a = (x: number, y: number) => Math.atan2(y - c.y, x - c.x);
    const aS = a(e.x1, e.y1), aE = a(e.x2, e.y2), aT = a(e.mx, e.my);
    const [s, sweep] = ccw(aS, aT) <= ccw(aS, aE) ? [aS, ccw(aS, aE)] : [aE, ccw(aE, aS)];
    for (let i = 1; i < n; i++) out.push(v(c.x + Math.cos(s + (i / n) * sweep) * r, c.y + Math.sin(s + (i / n) * sweep) * r));
  }
  return out;
}

/** Hover at `at`, then click there, and check that the red piece and what the
 *  click kept tile the original curve exactly. */
function expectHoverIsTheTrim(ents: ResolvedEntity[], index: number, at: THREE.Vector2) {
  const original = ents[index]!;
  const others = new Set(ents.filter((_, i) => i !== index));
  const m = trimMode([...ents]);
  const red = m.hover(at);
  const kept = m.click(at).filter((e) => !others.has(e));
  // the cut points themselves belong to both sides
  const ends = red.type === "line" || red.type === "arc" ? [v(red.x1, red.y1), v(red.x2, red.y2)] : [];
  let checked = 0;
  for (const q of samples(original)) {
    if (ends.some((c) => c.distanceTo(q) < 1e-4)) continue;
    const onRed = distTo(red, q) < 1e-7;
    const onKept = kept.some((k) => distTo(k, q) < 1e-7);
    expect(onRed !== onKept, `(${q.x.toFixed(3)}, ${q.y.toFixed(3)}) is on ${onRed ? "both" : "neither"}`).toBe(true);
    checked++;
  }
  expect(checked).toBeGreaterThan(1000);
  return { red, kept };
}

beforeEach(() => { toasts.length = 0; });

describe("the Trim hover lights exactly what the click removes", () => {
  const crossed = (): ResolvedEntity[] => [
    { type: "line", id: "h", x1: -20, y1: 0, x2: 20, y2: 0 },
    { type: "line", id: "v1", x1: -5, y1: -10, x2: -5, y2: 10 },
    { type: "line", id: "v2", x1: 5, y1: -10, x2: 5, y2: 10 },
  ];

  it("a line: the middle span", () => {
    const { red, kept } = expectHoverIsTheTrim(crossed(), 0, v(1, 0.2));
    expect(kept).toHaveLength(2); // a whole-line highlight overlaps both of these
    expect(red.type).toBe("line");
  });

  it("a line: the end span", () => {
    expectHoverIsTheTrim(crossed(), 0, v(14, -0.2));
  });

  it("an arc: the span between two crossings", () => {
    const ents: ResolvedEntity[] = [
      { type: "arc", id: "a", x1: 10, y1: 0, x2: -10, y2: 0, mx: 0, my: 10 },
      { type: "line", id: "l1", x1: 4, y1: -20, x2: 4, y2: 20 },
      { type: "line", id: "l2", x1: -4, y1: -20, x2: -4, y2: 20 },
    ];
    expectHoverIsTheTrim(ents, 0, v(0, 10.1));
  });

  it("a circle: the side under the cursor", () => {
    const ents: ResolvedEntity[] = [
      { type: "circle", id: "c", x: 0, y: 0, radius: 10 },
      { type: "line", id: "l", x1: 3, y1: -20, x2: 3, y2: 20 },
    ];
    const { kept } = expectHoverIsTheTrim(ents, 0, v(10.1, 0));
    expect(kept.map((e) => e.type)).toEqual(["arc"]);
  });

  it("a rectangle: the span of the edge under the cursor, not the rectangle", () => {
    const ents: ResolvedEntity[] = [
      { type: "rectangle", id: "r", x: 50, y: 75, width: 100, height: 150 },
      { type: "line", id: "v", x1: 30, y1: -20, x2: 30, y2: 20 },
    ];
    const { red } = expectHoverIsTheTrim(ents, 0, v(70, 0.3));
    // the bottom edge from the crossing at x=30 to the corner at x=100
    expect(red.type).toBe("line");
    const r = red as Extract<ResolvedEntity, { type: "line" }>;
    expect([r.x1, r.x2].sort((p, q) => p - q)).toEqual([30, 100]);
  });

  // A line that cuts a circle near its top: two REAL crossings, close together.
  // Merged into one "touch", as a radial tangency band 1e-6*r wide would merge
  // them (up to 2.8e-3*r apart), the chord between them cannot be trimmed: the
  // click between them removes everything from the merged point to the line's
  // end, and the hover agrees.
  for (const [R, half] of [[20, 0.025], [100, 0.125], [1000, 1]] as const) {
    it(`a line cutting a circle at two crossings ${2 * half} mm apart (r=${R}): the chord between them`, () => {
      const d = Math.sqrt(R * R - half * half);
      const ents: ResolvedEntity[] = [
        { type: "line", id: "l", x1: -50, y1: d, x2: 50, y2: d },
        { type: "circle", id: "c", x: 0, y: 0, radius: R },
      ];
      const { red, kept } = expectHoverIsTheTrim(ents, 0, v(half / 2, d));
      const r = red as Extract<ResolvedEntity, { type: "line" }>;
      expect([r.x1, r.x2].sort((p, q) => p - q)).toEqual([expect.closeTo(-half, 9), expect.closeTo(half, 9)]);
      expect(kept).toHaveLength(2);
    });
  }

  it("a line nothing crosses: the whole line, which is what the click deletes", () => {
    const ents: ResolvedEntity[] = [{ type: "line", id: "lone", x1: 0, y1: 0, x2: 10, y2: 0 }];
    const { kept } = expectHoverIsTheTrim(ents, 0, v(5, 0.1));
    expect(kept).toHaveLength(0);
  });

  // A guard, not a regression test: the hover plans a trim on EVERY pointer
  // move, and the trim itself mints ids for the pieces it keeps. Planning
  // through the click's code path must not mint them, or each frame would
  // burn ids for pieces that never exist.
  it("burns no entity ids while hovering", () => {
    // one of each shape, each crossed so the plan has pieces to build
    const ents: ResolvedEntity[] = [
      { type: "rectangle", id: "r", x: 0, y: 0, width: 20, height: 20 },
      { type: "line", id: "rx", x1: 0, y1: -20, x2: 0, y2: -5 }, // crosses the rectangle's bottom
      { type: "circle", id: "c", x: 100, y: 0, radius: 10 },
      { type: "line", id: "cx", x1: 80, y1: 0, x2: 120, y2: 0 }, // crosses the circle twice
      { type: "arc", id: "a", x1: 210, y1: 0, x2: 190, y2: 0, mx: 200, my: 10 },
      { type: "line", id: "ax", x1: 200, y1: -5, x2: 200, y2: 20 }, // crosses the arc's top
    ];
    const m = trimMode(ents);
    const before = Number(newEntityId().slice(1));
    const hovered = new Set<string>();
    for (const at of [v(5, -10.1), v(107.1, 7.1), v(207.1, 7.1), v(0, -15)]) {
      for (let k = 0; k < 10; k++) hovered.add(m.hover(at).id);
    }
    // the hover really did plan a rectangle edge, a circle, an arc and a line
    expect(hovered).toEqual(new Set(["a", "c", "r~0", "rx"]));
    expect(Number(newEntityId().slice(1))).toBe(before + 1);
  });
});
