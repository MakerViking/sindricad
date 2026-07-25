import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { trimEntity, breakAt, extendLine, chamferCorner, offsetEntity, offsetLineChain, breakLink } from "./modify";
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

describe("offsetEntity — arc", () => {
  it("offsets an arc concentrically (radius grows by dist)", () => {
    const ents: ResolvedEntity[] = [{ type: "arc", id: "a", x1: 5, y1: 0, x2: 0, y2: 5, mx: 3.5355, my: 3.5355 }];
    const out = offsetEntity(ents, 0, 3)!;
    expect(out.length).toBe(2);
    expect(arcRadius(out[1])).toBeCloseTo(8, 1);
  });
});

describe("offsetLineChain", () => {
  const round = (n: number) => Math.round(n * 100) / 100;
  const offsetEnds = (all: ResolvedEntity[], originalIds: string[]) =>
    all.filter((e) => e.type === "line" && !originalIds.includes(e.id))
      .flatMap((e) => [[round((e as any).x1), round((e as any).y1)], [round((e as any).x2), round((e as any).y2)]]);

  it("miters an open L-chain of two lines", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "B", x1: 10, y1: 0, x2: 10, y2: 10 },
    ];
    const out = offsetLineChain(ents, 0, 2)!;
    expect(out).not.toBeNull();
    expect(out.length).toBe(4); // 2 originals + 2 offset
    const ends = offsetEnds(out, ["A", "B"]);
    // offset up (+y) for A, left (−x) for B, mitered at (8,2)
    expect(ends).toContainEqual([8, 2]); // the shared miter corner
    expect(ends).toContainEqual([0, 2]); // A's free end offset
    expect(ends).toContainEqual([8, 10]); // B's free end offset
  });

  it("offsets a closed square inward into a smaller concentric square", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "L0", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "L1", x1: 10, y1: 0, x2: 10, y2: 10 },
      { type: "line", id: "L2", x1: 10, y1: 10, x2: 0, y2: 10 },
      { type: "line", id: "L3", x1: 0, y1: 10, x2: 0, y2: 0 },
    ];
    const out = offsetLineChain(ents, 0, 2)!;
    expect(out.length).toBe(8); // 4 originals + 4 offset
    const ends = offsetEnds(out, ["L0", "L1", "L2", "L3"]);
    for (const corner of [[2, 2], [8, 2], [8, 8], [2, 8]]) expect(ends).toContainEqual(corner);
  });

  it("returns null for a lone line (caller falls back to single-entity offset)", () => {
    const ents: ResolvedEntity[] = [{ type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 }];
    expect(offsetLineChain(ents, 0, 2)).toBeNull();
  });

  it("returns null at a junction (a vertex shared by 3+ lines)", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "B", x1: 10, y1: 0, x2: 10, y2: 10 },
      { type: "line", id: "C", x1: 10, y1: 0, x2: 20, y2: 0 }, // T-junction at (10,0)
    ];
    expect(offsetLineChain(ents, 0, 2)).toBeNull();
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
