// assemble() returns the PREVIOUS RebuildResult by reference when a reply's
// bodies all arrive as unchanged stubs and nothing else moved. Without it every
// no-op rebuild rebuilt ~98 MiB of typed arrays (0.171 s on the reference
// assembly), and the viewport — which keys its own fast path on result identity
// — rebuilt the whole scene behind it.
//
// The risk is the mirror image: returning a stale object when something DID
// change. These tests pin both directions.
import { describe, expect, it } from "vitest";
import { Geometry } from "./client";
import type { RebuildResult } from "../types";

function full(id: string, etag: string) {
  return {
    id, name: id, etag,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    faceIds: [0],
    faceCount: 1,
    edges: [],
  };
}
const stub = (id: string, etag: string) => ({ id, name: id, etag, unchanged: true as const });

function client() {
  const g = new Geometry();
  const call = (bodies: unknown[], extra: Record<string, unknown> = {}) =>
    (g as unknown as { assemble(r: unknown): RebuildResult | null }).assemble({
      protocol: 2, bodies, bbox: { min: [0, 0, 0], max: [1, 1, 1] }, ...extra,
    });
  return call;
}

describe("assemble no-op fast path", () => {
  it("returns the SAME object when every body is an unchanged stub", () => {
    const a = client();
    const first = a([full("b1", "e1"), full("b2", "e2")]);
    const second = a([stub("b1", "e1"), stub("b2", "e2")]);
    expect(first).not.toBeNull();
    expect(second).toBe(first); // identity, not just equality
  });

  it("returns a NEW object when a body's etag changed", () => {
    const a = client();
    const first = a([full("b1", "e1")]);
    const second = a([full("b1", "e2")]);
    expect(second).not.toBe(first);
    expect(second).not.toBeNull();
  });

  it("returns a NEW object when a body is removed", () => {
    const a = client();
    const first = a([full("b1", "e1"), full("b2", "e2")]);
    const second = a([stub("b1", "e1")]);
    expect(second).not.toBe(first);
    expect(second!.bodies).toHaveLength(1);
  });

  it("returns a NEW object when a body is added", () => {
    const a = client();
    const first = a([full("b1", "e1")]);
    const second = a([stub("b1", "e1"), full("b2", "e2")]);
    expect(second).not.toBe(first);
    expect(second!.bodies).toHaveLength(2);
  });

  it("returns a NEW object when the bbox moved", () => {
    const a = client();
    const first = a([full("b1", "e1")]);
    const second = a([stub("b1", "e1")], { bbox: { min: [0, 0, 0], max: [9, 9, 9] } });
    expect(second).not.toBe(first);
  });

  it("returns a NEW object when a featureError appears with identical geometry", () => {
    const a = client();
    const first = a([full("b1", "e1")]);
    const second = a([stub("b1", "e1")], { featureError: { message: "boom" } });
    expect(second).not.toBe(first);
    expect(second!.featureError).toEqual({ message: "boom" });
  });

  it("returns a NEW object when a featureError CLEARS", () => {
    const a = client();
    a([full("b1", "e1")]);
    const withErr = a([stub("b1", "e1")], { featureError: { message: "boom" } });
    const cleared = a([stub("b1", "e1")]);
    expect(cleared).not.toBe(withErr);
    expect(cleared!.featureError).toBeUndefined();
  });

  it("returns a NEW object when a body is RENAMED (same etag)", () => {
    const a = client();
    const first = a([full("b1", "e1")]);
    const second = a([{ id: "b1", name: "renamed", etag: "e1", unchanged: true as const }]);
    expect(second).not.toBe(first);
    expect(second!.bodies?.[0]?.name).toBe("renamed");
  });

  it("does not fire on the very first reply (nothing cached yet)", () => {
    const a = client();
    expect(a([full("b1", "e1")])).not.toBeNull();
  });

  it("still resyncs (null) for a stub with no backing payload", () => {
    const a = client();
    expect(a([stub("ghost", "e9")])).toBeNull();
  });
});
