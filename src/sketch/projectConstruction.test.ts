// Projecting an edge as CONSTRUCTION geometry.
//
// A user with many years of CAD asked for "the ability to select an edge of an
// existing solid or from an earlier sketch and use it for construction geometry
// in a new sketch". Most of it already existed: the Project tool's filter
// covers solid edges, an earlier sketch's curves and body silhouettes. The gap
// was that the projected-entity creation site was the ONE that ignored
// Construction mode, so a projection always joined the profile and could never
// be pure reference.
//
// This drives the real click handler (`projectClick`) off SketchMode.prototype,
// with the sidecar's reply stubbed, and reads back the entity that landed.
import { describe, it, expect } from "vitest";
import { SketchMode } from "./sketchMode";
import { SketchPlane } from "./plane";
import { PROJECT_FILTERS } from "./projectPanel";
import type { ResolvedEntity } from "./snap";

describe("the Project tool can reach the geometry asked for", () => {
  it("offers solid edges, an earlier sketch's curves, and a silhouette", () => {
    const keys = PROJECT_FILTERS.map((c) => c.key);
    expect(keys, "the Project tool no longer offers solid edges").toContain("edges");
    expect(keys, "an earlier sketch's curves can no longer be projected").toContain("sketchCurves");
    expect(keys).toContain("silhouette");
  });
});

/** A sketch in the Project tool, Sketch-curves filter, with one committed curve
 *  under the cursor and the sidecar answering with one projected line. */
function projecting(constructionMode: boolean) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  const entities: ResolvedEntity[] = [];
  Object.assign(s, {
    active: true,
    tool: "project",
    plane: new SketchPlane("XY"),
    entities,
    editingId: null,
    projectBusy: false,
    constructionMode,
    projectPanel: { filter: "sketchCurves" },
    overlay: { committedCurveAt: () => ({ sketchId: "f1", entityId: "e1" }) },
    viewport: { projectToScreen: () => ({ x: 0, y: 0 }) },
    committedSource: () => ({}),
    store: {
      projectGeometry: async () => [
        { ok: true, curves: [{ curve: { kind: "line", points: [[0, 0], [10, 0]] } }] },
      ],
    },
    refreshActive() {},
    requestSolve() {},
    onState: null,
  });
  return { s, entities };
}

const click = { clientX: 5, clientY: 5, button: 0 } as unknown as PointerEvent;

describe("a projection honours Construction mode", () => {
  it("lands as construction geometry when the mode is on", async () => {
    const { s, entities } = projecting(true);
    await (s as unknown as { projectClick(e: PointerEvent): Promise<void> }).projectClick(click);
    const p = entities.find((e) => e.type === "projected");
    expect(p, "the projection did not land at all").toBeDefined();
    expect(
      (p as { construction?: boolean }).construction,
      "a projected edge ignored Construction mode, so it always joins the profile and cannot be pure reference",
    ).toBe(true);
  });

  it("serialises exactly as before when the mode is off", async () => {
    const { s, entities } = projecting(false);
    await (s as unknown as { projectClick(e: PointerEvent): Promise<void> }).projectClick(click);
    const p = entities.find((e) => e.type === "projected");
    expect(p).toBeDefined();
    // the key must be ABSENT, not false: an off-mode projection written as
    // `construction: false` would change every saved sketch byte for byte
    expect("construction" in (p as object), "an off-mode projection now writes a construction key").toBe(false);
  });
});
