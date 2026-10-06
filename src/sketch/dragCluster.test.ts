// dragCluster() is the entity-set restriction a drag frame solves (GH #17
// drag speed, see pump() in sketchMode.ts): the connected component reachable
// from the grabbed point through a shared position (attachmentPoints +
// coincKey) or a shared constraint. These are pure, solver-free tests of the
// graph itself; the integration with pump() (what actually gets passed to
// compileAndSolve, and that release still sees everything) is covered in
// dragFrame.test.ts.
import { describe, it, expect } from "vitest";
import { dragCluster } from "./dragCluster";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";

describe("dragCluster", () => {
  it("follows a shared endpoint position, not just a shared id", () => {
    // A-B touch at (10,0) with no constraint at all: a plain draw-time join.
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "B", x1: 10, y1: 0, x2: 10, y2: 10 },
      { type: "line", id: "C", x1: 100, y1: 100, x2: 110, y2: 100 }, // elsewhere, untouching
    ];
    const cluster = dragCluster(ents, [], 10, 10); // grab B's free end
    expect(cluster).toEqual(new Set(["A", "B"]));
  });

  it("follows a constraint even with no shared position", () => {
    // Two circles far apart, tied only by an equal-radius-style constraint
    // (concentric is the one that names two entities without touching).
    const ents: ResolvedEntity[] = [
      { type: "circle", id: "X", x: 0, y: 0, radius: 5 },
      { type: "circle", id: "Y", x: 200, y: 200, radius: 5 },
      { type: "circle", id: "Z", x: 400, y: 400, radius: 5 }, // unrelated third circle
    ];
    const cons: SketchConstraint[] = [{ type: "concentric", c1: "X", c2: "Y" } as SketchConstraint];
    const cluster = dragCluster(ents, cons, 0, 0); // grab X's center
    expect(cluster).toEqual(new Set(["X", "Y"]));
    expect(cluster.has("Z")).toBe(false);
  });

  it("transitively includes a chain reached through more than one hop", () => {
    const ents: ResolvedEntity[] = [
      { type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 },
      { type: "line", id: "B", x1: 10, y1: 0, x2: 10, y2: 10 },
      { type: "line", id: "C", x1: 10, y1: 10, x2: 20, y2: 10 },
    ];
    const cluster = dragCluster(ents, [], 0, 0); // grab A's other end
    expect(cluster).toEqual(new Set(["A", "B", "C"]));
  });

  it("is empty when nothing has an attachment point at that position", () => {
    const ents: ResolvedEntity[] = [{ type: "line", id: "A", x1: 0, y1: 0, x2: 10, y2: 0 }];
    expect(dragCluster(ents, [], 500, 500).size).toBe(0);
  });

  it("strips a constraint's sub-id suffix before matching an entity id", () => {
    // A pattern-copy id ("R~2") is still the base entity for connectivity
    // purposes — the same convention sketchSolve's own entityRefs uses.
    const ents: ResolvedEntity[] = [
      { type: "circle", id: "R", x: 0, y: 0, radius: 5 },
      { type: "circle", id: "S", x: 50, y: 50, radius: 5 },
    ];
    const cons: SketchConstraint[] = [{ type: "concentric", c1: "R~2", c2: "S" } as SketchConstraint];
    const cluster = dragCluster(ents, cons, 0, 0);
    expect(cluster).toEqual(new Set(["R", "S"]));
  });
});
