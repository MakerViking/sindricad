// A Split Body piece of a body the user renamed is SHOWN as "<rename> (n)".
//
// The split tool used to WRITE those names as Browser renames, and a rename is
// keyed on a positional body id: an edit that made fewer pieces, or an undo,
// left "Bracket (2)" on whatever body took that id next; a redo lost the names;
// after a save and reopen nothing knew to take them off. The build now says
// which body each piece came from (`pieceOf`), and the store derives the name
// from that on every build, so there is nothing stored to go stale.
import { describe, expect, it } from "vitest";
import { DocumentStore } from "./store";
import type { CadDocument, RebuildResult } from "../types";
import type { GeometryBackend } from "../geometry/client";

type Body = NonNullable<RebuildResult["bodies"]>[number];

const body = (id: string, name: string, pieceOf?: [string, number]): Body => ({
  id, name, faceStart: 0, faceCount: 1, ...(pieceOf ? { pieceOf } : {}),
});

function storeReturning(results: Body[][]) {
  let i = 0;
  const be = {
    async rebuild() {
      const bodies = results[Math.min(i++, results.length - 1)]!;
      const result: RebuildResult = {
        mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
        edges: [],
        bbox: { min: [0, 0, 0], max: [1, 1, 1] },
        bodies,
      };
      return { ok: true as const, result };
    },
    async init() {},
    onStatus() { return () => {}; },
    onProgress() { return () => {}; },
    async cancel() { return true; },
  } as unknown as GeometryBackend;
  const doc: CadDocument = { parameters: {}, features: [] };
  return new DocumentStore(be, doc);
}

describe("split piece names", () => {
  it("a piece of a renamed body is shown under that rename, numbered", async () => {
    const store = storeReturning([[body("body1", "Case"), body("body2", "Case (2)", ["body1", 2]), body("body3", "Other")]]);
    await store.rebuildNow();
    expect(store.bodyName("body2"), "not renamed: the built name stands").toBeUndefined();
    store.setBodyName("body1", "Bracket");
    expect(store.bodyName("body2")).toBe("Bracket (2)");
    expect(store.bodyName("body3")).toBeUndefined();
    expect(store.namedBodies(store.buildState.result?.bodies).map((b) => b.name)).toEqual(["Bracket", "Bracket (2)", "Other"]);
    // the user's own name for the piece wins
    store.setBodyName("body2", "Lid");
    expect(store.bodyName("body2")).toBe("Lid");
  });

  it("the name follows the BUILD: when the id stops being a piece, it stops being named like one", async () => {
    // An edit to fewer pieces (or an undo): body2 is now some other feature's body.
    const store = storeReturning([
      [body("body1", "Case"), body("body2", "Case (2)", ["body1", 2])],
      [body("body1", "Case"), body("body2", "Cylinder")],
    ]);
    await store.rebuildNow();
    store.setBodyName("body1", "Bracket");
    expect(store.bodyName("body2")).toBe("Bracket (2)");
    await store.rebuildNow();
    expect(store.bodyName("body2"), "a stale piece name was left on the next body with that id").toBeUndefined();
    expect(store.bodyNamesMap(), "a derived name was stored, so it would be saved and outlive the split").toEqual({ body1: "Bracket" });
  });

  it("a piece of a piece is named through both", async () => {
    const store = storeReturning([[body("body1", "Case"), body("body2", "Case (2)", ["body1", 2]), body("body3", "Case (2) (2)", ["body2", 2])]]);
    await store.rebuildNow();
    store.setBodyName("body1", "Bracket");
    expect(store.bodyName("body3")).toBe("Bracket (2) (2)");
  });
});
