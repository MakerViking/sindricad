// Field report 66d7eb71: the repair its Cut message gives is "move the profile
// back where you want it and dimension it to the new edge", and in the
// reporter's sketch the hole could not be dragged by its centre. The drag said
// "Projected geometry is fixed — Break Link to edit it", about the user's own
// circle.
//
// Two causes, measured on the reporter's sketch. Every frame of the drag came
// back from the solver with the sketch's projected ARC (the rim of a cylinder)
// listed as a conflict, so the pump threw each frame away; and it still moved
// its grab point to the cursor, so a few frames on the nearest point to it was
// a projected corner, and the drag was refused as a drag of that corner.
//
// Entered where the user enters: the real onPointerDown / onPointerMove /
// endDrag and the real solve pump (liveSketch). Only what draws is stubbed.
import { describe, it, expect, vi, beforeEach } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));

import { installFakeDocument } from "../ui/fakeDom.testkit";
import { liveSketch } from "./liveSketch.testkit";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

installFakeDocument();
vi.stubGlobal("requestAnimationFrame", () => 1);
vi.stubGlobal("cancelAnimationFrame", () => {});

type Circle = Extract<ResolvedEntity, { type: "circle" }>;

/** A plate's bottom edge and the rim of a cylinder on it, both projected, and
 *  a hole dimensioned 10 mm above the edge. */
const ents = (): ResolvedEntity[] => [
  { type: "projected", id: "edge", curve: { kind: "line", x1: 0, y1: 0, x2: 50, y2: 0 } },
  { type: "projected", id: "rim", curve: { kind: "arc", x1: 30, y1: 30, x2: 50, y2: 30, mx: 40, my: 40 } },
  { type: "circle", id: "hole", x: 10, y: 10, radius: 3 },
] as ResolvedEntity[];
const HELD = { type: "p2lDistance", e: "hole", p: 0, line: "edge", value: 10 } as SketchConstraint;
const hole = (live: ReturnType<typeof liveSketch>) => live.ent("hole") as Circle;

describe("dragging a point in a sketch with a projected arc", () => {
  beforeEach(() => { toasts.length = 0; });

  it("drags a dimensioned hole by its centre, along the line its dimension allows", async () => {
    const live = liveSketch(ents(), [HELD]);
    await live.settle();
    await live.drag([10, 10], [16, 12]);
    expect(hole(live).x).toBeCloseTo(16, 6);
    expect(hole(live).y).toBeCloseTo(10, 6); // the dimension still holds it
    expect(toasts).toEqual([]);
  });

  it("keeps hold of the grabbed point while frames are thrown away", async () => {
    // A sketch already in conflict (the hole both 10 and 12 mm above the
    // edge): every frame of a drag is thrown away, and nothing moves. The grab
    // point must stay on the hole, not follow the cursor until a projected
    // corner is the point nearest it (the post ends at (20,10)).
    const live = liveSketch(
      [
        { type: "projected", id: "edge", curve: { kind: "line", x1: 0, y1: 0, x2: 50, y2: 0 } },
        { type: "projected", id: "post", curve: { kind: "line", x1: 20, y1: 10, x2: 20, y2: 40 } },
        { type: "circle", id: "hole", x: 10, y: 10, radius: 3 },
      ] as ResolvedEntity[],
      [HELD, { ...HELD, value: 12 }] as SketchConstraint[],
    );
    await live.settle();
    await live.drag([10, 10], [19, 10], 9);
    expect(toasts.filter((m) => m.startsWith("Projected geometry is fixed"))).toEqual([]);
    expect(hole(live)).toMatchObject({ x: 10, y: 10 });
  });
});
