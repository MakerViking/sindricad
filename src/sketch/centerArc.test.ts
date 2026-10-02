// The centre-point arc (a tester's request, the Fusion-style "Center Point Arc"):
// click the centre, click the start, sweep, click the end.
//
// It stores the SAME entity the 3-point arc does — start, end, and a point the
// arc passes through — so everything downstream (rendering, regions, the solver,
// the sidecar's B-rep edge) is shared. What is new is the sweep: the arc has to
// go the way the cursor went, including past 180 degrees, which a plain atan2 of
// the end click cannot tell you. These drive the real click and move handlers
// with only the screen-to-plane step stubbed, and read the entity that lands.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { SketchMode } from "./sketchMode";
import { advanceCenterArcSweep, arcCenterRadius, arcPolyline, centerArcEntity, MAX_CENTER_ARC_SWEEP } from "./arc";
import type { ResolvedEntity } from "./snap";

const DEG = Math.PI / 180;
const v = (x: number, y: number) => new THREE.Vector2(x, y);
const C = { x: 10, y: 20 };
const S = { x: 30, y: 20 }; // radius 20, start pointing along +X

/** a cursor on the circle at `deg` from the start, CCW positive */
const on = (deg: number, r = 20) => ({ x: C.x + r * Math.cos(deg * DEG), y: C.y + r * Math.sin(deg * DEG) });

/** sweep the cursor from 0 to `toDeg` in small steps, the way a hand does */
function sweepTo(toDeg: number): number {
  let sweep = 0;
  const n = Math.ceil(Math.abs(toDeg) / 5);
  for (let i = 1; i <= n; i++) sweep = advanceCenterArcSweep(sweep, C, S, on((toDeg * i) / n));
  return sweep;
}

describe("the sweep follows the cursor", () => {
  it("goes the way the cursor went, either way round", () => {
    expect(sweepTo(60) / DEG).toBeCloseTo(60, 6);
    expect(sweepTo(-60) / DEG).toBeCloseTo(-60, 6);
  });

  it("carries on past 180 degrees instead of flipping to the short way", () => {
    // at 270 the end click alone sits at -90; only the history says 270
    expect(sweepTo(270) / DEG).toBeCloseTo(270, 6);
    expect(sweepTo(-200) / DEG).toBeCloseTo(-200, 6);
  });

  it("can come back the way it went", () => {
    let s = sweepTo(200);
    for (let d = 195; d >= 30; d -= 5) s = advanceCenterArcSweep(s, C, S, on(d));
    expect(s / DEG).toBeCloseTo(30, 6);
  });

  it("stops short of a full circle", () => {
    expect(sweepTo(400)).toBeCloseTo(MAX_CENTER_ARC_SWEEP, 9);
    expect(sweepTo(-400)).toBeCloseTo(-MAX_CENTER_ARC_SWEEP, 9);
  });

  it("ignores a cursor on the centre, where it has no direction", () => {
    expect(advanceCenterArcSweep(1.2, C, S, C)).toBe(1.2);
  });

  it("reads only the cursor's ANGLE, not its distance", () => {
    expect(advanceCenterArcSweep(0, C, S, on(40, 3)) / DEG).toBeCloseTo(40, 6);
  });
});

describe("the arc it builds", () => {
  it("starts at the start, ends on the radius, and passes through mid-sweep", () => {
    const e = centerArcEntity(C, S, 270 * DEG);
    expect([e.x1, e.y1]).toEqual([S.x, S.y]);
    expect(e.x2).toBeCloseTo(on(270).x, 9);
    expect(e.y2).toBeCloseTo(on(270).y, 9);
    expect(e.mx).toBeCloseTo(on(135).x, 9);
    expect(e.my).toBeCloseTo(on(135).y, 9);
    const cr = arcCenterRadius(e)!;
    expect(cr.c.x).toBeCloseTo(C.x, 9);
    expect(cr.c.y).toBeCloseTo(C.y, 9);
    expect(cr.r).toBeCloseTo(20, 9);
  });

  it("is drawn the long way round when it was swept the long way round", () => {
    // what the overlay and the region code actually draw from the entity
    const e = centerArcEntity(C, S, 270 * DEG);
    const pts = arcPolyline(v(e.x1, e.y1), v(e.x2, e.y2), v(e.mx, e.my), 54);
    // every 5 degrees from 0 to 270, counter-clockwise
    pts.forEach((p, i) => {
      expect(p.x, `sample ${i}`).toBeCloseTo(on(i * 5).x, 6);
      expect(p.y, `sample ${i}`).toBeCloseTo(on(i * 5).y, 6);
    });
  });
});

// --- through the tool's own click and move handlers ---------------------------

/** A SketchMode with its collaborators stubbed: a pointer's client x/y IS the
 *  sketch-plane point, and the preview hands back the entities it was given. */
function makeMode() {
  const s = Object.create(SketchMode.prototype) as SketchMode;
  const state = s as unknown as Record<string, unknown>; // the private fields the stubs fill
  const previews: ResolvedEntity[][] = [];
  Object.assign(state, {
    active: true,
    tool: "arcCenter",
    entities: [] as ResolvedEntity[],
    clickPts: [],
    arcSweep: 0,
    constructionMode: false,
    rightDownAt: null,
    boxSel: null,
    lastCursor: new THREE.Vector2(),
    dims: { clearSelection() {} },
    doublePress: () => false,
    snapAt: (x: number, y: number) => ({ p: v(x, y), kind: "free" }),
    showSnap: () => {},
    entityCurve: (ent: ResolvedEntity) => ent,
    overlay: { setPreview: (objs: ResolvedEntity[]) => previews.push(objs) },
    refreshActive: () => {},
    requestSolve: () => {},
  });
  const ev = (p: { x: number; y: number }) => ({ button: 0, clientX: p.x, clientY: p.y, ctrlKey: false, preventDefault() {} });
  const down = (p: { x: number; y: number }) => (s as unknown as { onPointerDown(e: unknown): void }).onPointerDown(ev(p));
  const move = (p: { x: number; y: number }) => (s as unknown as { onPointerMove(e: unknown): void }).onPointerMove(ev(p));
  const arcs = () => (state.entities as ResolvedEntity[]).filter((e) => e.type === "arc");
  return { s, state, down, move, arcs, previews };
}

describe("drawing one with the mouse", () => {
  it("click centre, click start, sweep 270 degrees, click: a 270 degree arc", () => {
    const m = makeMode();
    m.down(C);
    m.down(S);
    for (let d = 5; d <= 270; d += 5) m.move(on(d, 25)); // the hand need not stay on the radius
    m.down(on(270, 25));
    const [arc] = m.arcs();
    expect(arc, "no arc was committed").toBeTruthy();
    const a = arc as Extract<ResolvedEntity, { type: "arc" }>;
    expect([a.x1, a.y1]).toEqual([S.x, S.y]);
    // the end is projected onto the radius the start set, not left at the click
    expect(a.x2).toBeCloseTo(on(270).x, 6);
    expect(a.y2).toBeCloseTo(on(270).y, 6);
    // ...and the through-point says it went the LONG way
    expect(a.mx).toBeCloseTo(on(135).x, 6);
    expect(a.my).toBeCloseTo(on(135).y, 6);
  });

  it("sweeping clockwise instead gives the other arc between the same ends", () => {
    const m = makeMode();
    m.down(C);
    m.down(S);
    for (let d = -5; d >= -90; d -= 5) m.move(on(d));
    m.down(on(-90));
    const a = m.arcs()[0] as Extract<ResolvedEntity, { type: "arc" }>;
    expect(a.mx).toBeCloseTo(on(-45).x, 6);
    expect(a.my).toBeCloseTo(on(-45).y, 6);
  });

  it("previews the radius, then the arc as it is swept", () => {
    const m = makeMode();
    m.down(C);
    m.move(on(10));
    expect(m.previews.at(-1)?.[0]?.type).toBe("line");
    m.down(S);
    m.move(on(30));
    expect(m.previews.at(-1)?.[0]?.type).toBe("arc");
    expect(m.arcs()).toEqual([]); // nothing committed by hovering
  });

  it("makes nothing from a start click on the centre or an end click on the start", () => {
    const m = makeMode();
    m.down(C);
    m.down(C); // no radius: still waiting for the start
    m.down(S);
    m.down(S); // no sweep: still waiting for the end
    expect(m.arcs()).toEqual([]);
    m.move(on(45));
    m.down(on(45));
    expect(m.arcs()).toHaveLength(1);
  });

  it("does not hand a half-drawn arc's clicks to the next tool", () => {
    const m = makeMode();
    m.down(C);
    m.down(S);
    // setTool's own collaborators, so the real setTool can run
    Object.assign(m.state, {
      dim: { hide() {} }, textPanel: { hide() {} }, projectPanel: { hide() {} },
      viewport: { hoverEntity() {} }, dropTextPreview: () => false, constraintTools: { resetPending() {} },
      selected: new Set(), patternFlow: { flushPending() {} }, glyphs: { setInteractive() {} },
      resetDimPicks: () => {},
    });
    (m.state.dims as Record<string, unknown>).setInteractive = () => {};
    m.s.setTool("circle3");
    expect(m.state.clickPts).toEqual([]);
  });
});
