import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { trimEntity, breakAt, extendLine, chamferCorner, offsetEntity, offsetChain, signedOffsetAt, breakLink } from "./modify";
import type { ResolvedEntity } from "./snap";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const arcRadius = (a: any) => {
  const ax = a.x1, ay = a.y1, bx = a.x2, by = a.y2, cx = a.mx, cy = a.my;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return Math.hypot(ax - ux, ay - uy);
};

describe("chamferCorner", () => {
  it("bevels two perpendicular lines, keeping their ids", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "B", x1: 10, y1: 0, x2: 10, y2: 10 },
    ];
    const out = chamferCorner(ents, 0, 1, 2)!;
    expect(out).not.toBeNull();
    const lines = out.filter((e) => e.type === "line");
    expect(lines.length).toBe(3); // A, B, bevel
    const A = out.find((e) => e.id === "A") as any, B = out.find((e) => e.id === "B") as any;
    expect(A.x2).toBeCloseTo(8); expect(A.y2).toBeCloseTo(0);          // shortened to setback
    expect(B.x2).toBeCloseTo(10); expect(B.y2).toBeCloseTo(2);
    const bevel = lines.find((e) => e.id !== "A" && e.id !== "B") as any;
    expect(bevel.x1).toBeCloseTo(8); expect(bevel.y1).toBeCloseTo(0);
    expect(bevel.x2).toBeCloseTo(10); expect(bevel.y2).toBeCloseTo(2);
  });
  it("returns null for parallel lines", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "B", x1: 0, y1: 5, x2: 10, y2: 5 },
    ];
    expect(chamferCorner(ents, 0, 1, 2)).toBeNull();
  });
});

describe("trimEntity — arcs & circles", () => {
  it("trims a circle to the complementary arc", () => {
    const ents: ResolvedEntity[] = [
      { type: "circle", id: "c", x: 0, y: 0, radius: 5 },
      { type: "line", id: "v", x1: 0, y1: -10, x2: 0, y2: 10 }, // crosses at (0,±5)
    ];
    const out = trimEntity(ents, 0, v(5, 0)); // click the right half
    expect(out.find((e) => e.type === "circle")).toBeUndefined();
    const arcs = out.filter((e) => e.type === "arc") as any[];
    expect(arcs.length).toBe(1);
    expect(arcs[0].mx).toBeCloseTo(-5, 1); // kept the LEFT half (mid at (-5,0))
    expect(arcs[0].my).toBeCloseTo(0, 1);
  });
  it("trims the middle span of an arc into two arcs", () => {
    const ents: ResolvedEntity[] = [
      { type: "arc", id: "a", x1: 5, y1: 0, x2: -5, y2: 0, mx: 0, my: 5 }, // upper half
      { type: "line", id: "l1", x1: 2.5, y1: -10, x2: 2.5, y2: 10 },
      { type: "line", id: "l2", x1: -2.5, y1: -10, x2: -2.5, y2: 10 },
    ];
    const out = trimEntity(ents, 0, v(0, 5)); // click the top-middle span
    expect(out.filter((e) => e.type === "arc").length).toBe(2);
  });
  it("deletes a circle with no crossings", () => {
    const ents: ResolvedEntity[] = [{ type: "circle", id: "c", x: 0, y: 0, radius: 5 }];
    expect(trimEntity(ents, 0, v(5, 0))).toEqual([]);
  });
});

describe("breakAt — arcs & circles", () => {
  it("splits an arc into two arcs", () => {
    const ents: ResolvedEntity[] = [{ type: "arc", id: "a", x1: 5, y1: 0, x2: -5, y2: 0, mx: 0, my: 5 }];
    const out = breakAt(ents, 0, v(0, 5));
    expect(out.filter((e) => e.type === "arc").length).toBe(2);
  });
  it("opens a circle into a single arc", () => {
    const ents: ResolvedEntity[] = [{ type: "circle", id: "c", x: 0, y: 0, radius: 5 }];
    const out = breakAt(ents, 0, v(5, 0));
    expect(out.find((e) => e.type === "circle")).toBeUndefined();
    expect(out.filter((e) => e.type === "arc").length).toBe(1);
  });
});

describe("extendLine — arcs", () => {
  it("grows an arc's end to the nearest crossing", () => {
    const ents: ResolvedEntity[] = [
      { type: "arc", id: "a", x1: 5, y1: 0, x2: 0, y2: 5, mx: 3.5355, my: 3.5355 }, // quarter 0→90°
      { type: "line", id: "l", x1: -10, y1: 3.5, x2: 0, y2: 3.5 }, // crosses circle at ~135°
    ];
    const out = extendLine(ents, 0, v(0, 5))!; // click near the (0,5) end
    expect(out).not.toBeNull();
    const a = out.find((e) => e.id === "a") as any;
    expect(a.x2).toBeLessThan(0); // end swept past 90° toward ~135°
    expect(arcRadius(a)).toBeCloseTo(5, 1); // radius preserved
  });
});

describe("offsetEntity", () => {
  it("offsets an arc concentrically (radius grows by dist)", () => {
    const ents: ResolvedEntity[] = [{ type: "arc", id: "a", x1: 5, y1: 0, x2: 0, y2: 5, mx: 3.5355, my: 3.5355 }];
    const out = offsetEntity(ents, 0, 3)!;
    expect(out.entities.length).toBe(2);
    expect(arcRadius(out.entities[1])).toBeCloseTo(8, 1);
    expect(out.linked).toBe(true);
    expect(out.pairs).toEqual([{ src: "a", cpy: (out.entities[1] as any).id }]);
  });

  // the construction flag used to be dropped on EVERY branch, so offsetting a
  // construction circle silently produced real geometry that then got extruded
  it.each([
    ["rectangle", { type: "rectangle", id: "r", width: 10, height: 6, x: 0, y: 0 }],
    ["circle", { type: "circle", id: "c", radius: 5, x: 0, y: 0 }],
    ["line", { type: "line", id: "l", x1: 0, y1: 0, x2: 10, y2: 0 }],
    ["arc", { type: "arc", id: "a", x1: 5, y1: 0, x2: 0, y2: 5, mx: 3.5355, my: 3.5355 }],
  ])("carries the construction flag through a %s offset", (_name, base) => {
    const ents = [{ ...(base as any), construction: true }] as ResolvedEntity[];
    const out = offsetEntity(ents, 0, 1)!;
    expect(out.entities[1]!.construction).toBe(true);
  });

  it("leaves a non-construction offset unflagged", () => {
    const ents: ResolvedEntity[] = [{ type: "circle", id: "c", radius: 5, x: 0, y: 0 }];
    expect(offsetEntity(ents, 0, 1)!.entities[1]!.construction).toBeUndefined();
  });

  it("pairs a rectangle by EDGE, which is what the constraint can reference", () => {
    const ents: ResolvedEntity[] = [{ type: "rectangle", id: "r", width: 10, height: 6, x: 0, y: 0 }];
    const out = offsetEntity(ents, 0, 2)!;
    const cpy = out.entities[1] as any;
    expect(cpy.width).toBe(14);
    expect(cpy.height).toBe(10);
    expect(out.pairs).toEqual([0, 1, 2, 3].map((k) => ({ src: `r~${k}`, cpy: `${cpy.id}~${k}` })));
  });

  // these four used to no-op in complete silence, after the user had already
  // typed a distance and pressed Enter
  it("offsets a spline by pushing its points along their normals", () => {
    const ents: ResolvedEntity[] = [
      { type: "spline", id: "s", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }] },
    ];
    const out = offsetEntity(ents, 0, 2)!;
    const cpy = out.entities[1] as any;
    expect(cpy.type).toBe("spline");
    expect(cpy.points.map((q: any) => q.y)).toEqual([2, 2, 2]);
    expect(out.linked).toBe(false); // rigid: no constraint can tie it
  });

  it("offsets a polygon to a concentric polygon (edges move by dist)", () => {
    const ents: ResolvedEntity[] = [{ type: "polygon", id: "p", x: 0, y: 0, radius: 10, sides: 6, angle: 0 }];
    const out = offsetEntity(ents, 0, 1)!;
    const cpy = out.entities[1] as any;
    // circumradius grows by dist / cos(pi/6) so the EDGES move out by exactly 1
    expect(cpy.radius).toBeCloseTo(10 + 1 / Math.cos(Math.PI / 6), 6);
    expect(cpy.sides).toBe(6);
    expect(out.linked).toBe(false);
  });

  it("offsets a slot by widening it (width is the overall width)", () => {
    const ents: ResolvedEntity[] = [{ type: "slot", id: "s", x1: 0, y1: 0, x2: 10, y2: 0, width: 4 }];
    const out = offsetEntity(ents, 0, 1.5)!;
    expect((out.entities[1] as any).width).toBe(7);
    expect(out.linked).toBe(false);
  });

  it("refuses to offset text or a point rather than silently doing nothing", () => {
    const text: ResolvedEntity[] = [{ type: "text", id: "t", text: "hi", x: 0, y: 0, height: 5, angle: 0 }];
    expect(offsetEntity(text, 0, 1)).toBeNull();
    const pt: ResolvedEntity[] = [{ type: "point", id: "p", x: 0, y: 0 }];
    expect(offsetEntity(pt, 0, 1)).toBeNull();
  });

  it("returns null when the distance collapses the shape", () => {
    const ents: ResolvedEntity[] = [{ type: "circle", id: "c", radius: 5, x: 0, y: 0 }];
    expect(offsetEntity(ents, 0, -5)).toBeNull();
  });
});

describe("signedOffsetAt — the cursor-side convention", () => {
  it("is positive to the LEFT of a line's stored direction", () => {
    const l: ResolvedEntity = { type: "line", id: "l", x1: 0, y1: 0, x2: 10, y2: 0 };
    expect(signedOffsetAt(l, v(5, 3))).toBeCloseTo(3, 6);
    expect(signedOffsetAt(l, v(5, -3))).toBeCloseTo(-3, 6);
  });

  it("is positive OUTSIDE a closed shape", () => {
    const c: ResolvedEntity = { type: "circle", id: "c", radius: 5, x: 0, y: 0 };
    expect(signedOffsetAt(c, v(8, 0))).toBeCloseTo(3, 6);
    expect(signedOffsetAt(c, v(2, 0))).toBeCloseTo(-3, 6);
    const r: ResolvedEntity = { type: "rectangle", id: "r", width: 10, height: 10, x: 0, y: 0 };
    expect(signedOffsetAt(r, v(7, 0))).toBeCloseTo(2, 6);
    expect(signedOffsetAt(r, v(3, 0))).toBeCloseTo(-2, 6);
    const s: ResolvedEntity = { type: "slot", id: "s", x1: 0, y1: 0, x2: 10, y2: 0, width: 4 };
    expect(signedOffsetAt(s, v(5, 5))).toBeCloseTo(3, 6);
  });

  it("agrees with offsetEntity's sign, so the preview lands under the cursor", () => {
    // a cursor OUTSIDE the circle must produce a BIGGER copy
    const ents: ResolvedEntity[] = [{ type: "circle", id: "c", radius: 5, x: 0, y: 0 }];
    const d = signedOffsetAt(ents[0]!, v(8, 0))!;
    expect((offsetEntity(ents, 0, d)!.entities[1] as any).radius).toBeCloseTo(8, 6);
  });
});

describe("offsetChain", () => {
  const round = (n: number) => Math.round(n * 100) / 100;
  const offsetEnds = (r: any, originalIds: string[]) =>
    r.entities.filter((e: any) => e.type === "line" && !originalIds.includes(e.id))
      .flatMap((e: any) => [[round(e.x1), round(e.y1)], [round(e.x2), round(e.y2)]]);

  it("miters an open L-chain of two lines", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "B", x1: 10, y1: 0, x2: 10, y2: 10 },
    ];
    const out = offsetChain(ents, 0, 2)!;
    expect(out).not.toBeNull();
    expect(out.entities.length).toBe(4); // 2 originals + 2 offset
    const ends = offsetEnds(out, ["A", "B"]);
    expect(ends).toContainEqual([8, 2]); // the shared miter corner
    expect(ends).toContainEqual([0, 2]); // A's free end offset
    expect(ends).toContainEqual([8, 10]); // B's free end offset
    expect(out.pairs.map((p) => p.src).sort()).toEqual(["A", "B"]);
  });

  it("offsets a closed square inward into a smaller concentric square", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "L0", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "L1", x1: 10, y1: 0, x2: 10, y2: 10 },
      { type: "line", id: "L2", x1: 10, y1: 10, x2: 0, y2: 10 },
      { type: "line", id: "L3", x1: 0, y1: 10, x2: 0, y2: 0 },
    ];
    const out = offsetChain(ents, 0, 2)!;
    expect(out.entities.length).toBe(8); // 4 originals + 4 offset
    const ends = offsetEnds(out, ["L0", "L1", "L2", "L3"]);
    for (const corner of [[2, 2], [8, 2], [8, 8], [2, 8]]) expect(ends).toContainEqual(corner);
  });

  it("returns null for a lone line (caller falls back to single-entity offset)", () => {
    const ents: ResolvedEntity[] = [{ type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 }];
    expect(offsetChain(ents, 0, 2)).toBeNull();
  });

  it("returns null at a junction (a vertex shared by 3+ curves)", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "B", x1: 10, y1: 0, x2: 10, y2: 10 },
      { type: "line", id: "C", x1: 10, y1: 0, x2: 20, y2: 0 }, // T-junction at (10,0)
    ];
    expect(offsetChain(ents, 0, 2)).toBeNull();
  });

  // ARCS: previously the adjacency map admitted only lines, so a filleted
  // profile broke into disconnected pieces and offset as loose fragments
  it("keeps a line-arc-line profile connected and offsets it as one unit", () => {
    // 10-long line, quarter fillet of R2 at the corner, then a line going up
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 8, y2: 0 },
      { type: "arc", id: "F", x1: 8, y1: 0, x2: 10, y2: 2, mx: 8 + Math.SQRT2, my: 2 - Math.SQRT2 },
      { type: "line", id: "B", x1: 10, y1: 2, x2: 10, y2: 10 },
    ];
    const out = offsetChain(ents, 0, 1)!;
    expect(out).not.toBeNull();
    // all three members offset, and the arc came through AS an arc
    expect(out.pairs.map((p) => p.src).sort()).toEqual(["A", "B", "F"]);
    const copies = out.entities.slice(3);
    expect(copies.map((e) => e.type).sort()).toEqual(["arc", "line", "line"]);
    // the offset arc stays concentric with the source fillet, radius 2-1=1
    // (travelling A→F→B the fillet is CCW, so a left offset shrinks it)
    const arc = copies.find((e) => e.type === "arc")!;
    expect(arcRadius(arc)).toBeCloseTo(1, 3);
    // and its ends still meet the neighbouring offset lines
    const pts = copies.filter((e) => e.type === "line").flatMap((e: any) => [v(e.x1, e.y1), v(e.x2, e.y2)]);
    for (const end of [v((arc as any).x1, (arc as any).y1), v((arc as any).x2, (arc as any).y2)]) {
      expect(Math.min(...pts.map((q) => q.distanceTo(end)))).toBeLessThan(1e-6);
    }
  });

  it("does not fling a spike when a corner is nearly collinear (miter limit)", () => {
    // two almost-straight segments: an unbounded miter shoots far off-sketch
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "B", x1: 10, y1: 0, x2: 20, y2: 0.02 },
    ];
    const out = offsetChain(ents, 0, 1)!;
    const far = out.entities.slice(2).flatMap((e: any) => [Math.hypot(e.x1, e.y1), Math.hypot(e.x2, e.y2)]);
    expect(Math.max(...far)).toBeLessThan(100);
  });

  it("drops members swallowed by an inward offset instead of self-intersecting", () => {
    // a 10x10 square offset inward by 6 would invert every side
    const ents: ResolvedEntity[] = [
      { type: "line", id: "L0", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "L1", x1: 10, y1: 0, x2: 10, y2: 10 },
      { type: "line", id: "L2", x1: 10, y1: 10, x2: 0, y2: 10 },
      { type: "line", id: "L3", x1: 0, y1: 10, x2: 0, y2: 0 },
    ];
    const out = offsetChain(ents, 0, 6);
    // either nothing survives, or whatever does still runs the right way
    if (out) {
      for (const e of out.entities.slice(4) as any[]) {
        const src = ents.find((s: any) => s.id === out.pairs.find((p) => p.cpy === e.id)?.src) as any;
        if (!src) continue;
        const dot = (e.x2 - e.x1) * (src.x2 - src.x1) + (e.y2 - e.y1) * (src.y2 - src.y1);
        expect(dot).toBeGreaterThan(0);
      }
    }
  });

  it("carries the construction flag onto every chain copy", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0, construction: true },
      { type: "line", id: "B", x1: 10, y1: 0, x2: 10, y2: 10, construction: true },
    ];
    const out = offsetChain(ents, 0, 2)!;
    for (const e of out.entities.slice(2)) expect(e.construction).toBe(true);
  });
});

describe("breakLink — projected → native, same id", () => {
  const SRC = { kind: "sketchCurve", sketch: "s0", entity: "e0" } as const;
  const proj = (id: string, curve: any, extra: object = {}): ResolvedEntity =>
    ({ type: "projected", id, source: SRC, curve, ...extra }) as ResolvedEntity;

  it("maps line/arc/circle curves onto the native field shapes", () => {
    const ents: ResolvedEntity[] = [
      proj("L", { kind: "line", x1: 1, y1: 2, x2: 3, y2: 4 }),
      proj("A", { kind: "arc", x1: 5, y1: 0, x2: -5, y2: 0, mx: 0, my: 5 }),
      proj("C", { kind: "circle", x: 7, y: 8, r: 2.5 }), // note: r → radius
    ];
    const out = breakLink(ents, new Set(["L", "A", "C"]));
    expect(out[0]).toEqual({ type: "line", id: "L", x1: 1, y1: 2, x2: 3, y2: 4 });
    expect(out[1]).toEqual({ type: "arc", id: "A", x1: 5, y1: 0, x2: -5, y2: 0, mx: 0, my: 5 });
    expect(out[2]).toEqual({ type: "circle", id: "C", x: 7, y: 8, radius: 2.5 });
  });

  it("drops source/stale, carries construction", () => {
    const ents: ResolvedEntity[] = [
      proj("S", { kind: "line", x1: 0, y1: 0, x2: 1, y2: 0 }, { stale: true, construction: true }),
    ];
    const out = breakLink(ents, new Set(["S"]));
    // exact shape: no source, no stale, no leftover projected-only fields
    expect(out[0]).toEqual({ type: "line", id: "S", x1: 0, y1: 0, x2: 1, y2: 0, construction: true });
  });

  it("poly → spline through the same points; closed poly keeps its closing point", () => {
    const open: [number, number][] = [[0, 0], [5, 1], [10, 0]];
    const closed: [number, number][] = [[0, 0], [5, 5], [10, 0], [0, 0]];
    const out = breakLink(
      [proj("P", { kind: "poly", pts: open }), proj("Q", { kind: "poly", pts: closed })],
      new Set(["P", "Q"]),
    );
    expect(out[0]).toEqual({ type: "spline", id: "P", points: [{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 10, y: 0 }] });
    // C0-closed spline: first == last point survives, so the closed poly's one
    // addressable endpoint (index 0, projEndSamples) still resolves
    expect(out[1]).toEqual({
      type: "spline", id: "Q",
      points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }, { x: 0, y: 0 }],
    });
  });

  it("touches only the listed ids; native entities pass through", () => {
    const native: ResolvedEntity = { type: "line", id: "n", x1: 0, y1: 0, x2: 1, y2: 1 };
    const kept = proj("keep", { kind: "line", x1: 0, y1: 0, x2: 2, y2: 0 });
    const out = breakLink([native, kept, proj("go", { kind: "circle", x: 0, y: 0, r: 1 })], new Set(["go"]));
    expect(out[0]).toBe(native);
    expect(out[1]).toBe(kept); // sibling stays linked — Break Link is per-entity
    expect(out[2]!.type).toBe("circle");
  });
});
