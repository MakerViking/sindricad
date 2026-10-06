// importGeometry rebuilds the sidecar's reply from a WHITELIST of fields, so a
// field the sidecar sends but the list omits is dropped silently before
// files.ts builds the feature. `meshOnly` was dropped that way on first run:
// the scan imported, the toast was right, and the rebuild then refused the body
// because the feature no longer said it was a mesh.

import { describe, expect, it } from "vitest";
import { Geometry } from "./client";

function withReply(result: unknown): Geometry {
  const g = new Geometry();
  (g as unknown as { call: () => Promise<unknown> }).call = async () => ({ ok: true, result });
  return g;
}

describe("importGeometry reply", () => {
  it("keeps meshOnly and the triangle count of an imported scan", async () => {
    const g = withReply({
      geom: "abc", name: "dragon", solid: false, faces: 0, meshOnly: true, triangles: 1340732,
      reference: { why: "tooManyTriangles", triangles: 1340732, limit: 150000 },
    });
    const r = await g.importGeometry("/x/dragon.stl", "stl");
    expect(r.ok && r.meshOnly).toBe(true);
    expect(r.ok && r.triangles).toBe(1340732);
    expect(r.ok && r.reference?.triangles).toBe(1340732);
  });

  it("adds no meshOnly key to an ordinary import", async () => {
    const r = await withReply({ geom: "abc", name: "box", solid: true, faces: 6 }).importGeometry("/x/box.stl", "stl");
    expect(r.ok && "meshOnly" in r).toBe(false);
  });
});
