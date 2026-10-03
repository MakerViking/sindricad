// Insert ▸ Part from File (Doug 29), and the Open guard in front of a STEP.
//
// Entered where the click lands: insertPartFromFile and openDocument, with only
// the native pieces stubbed (the file dialog, Rust's container read, the toast)
// and a fake sidecar standing in for `insertDocument` and `rebuild`. What is
// judged is the EFFECT on the document: the feature that lands, the names and
// colours its parts carry, what the sidecar was asked to build, one undo step.
//
// The sidecar half (that the payload rebuilds into the same bodies, in the same
// place, and leaves the open document's cache alone) is
// sidecar/test_insert_document.py.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import type { CadDocument, Feature, InsertReply, RebuildReply, RebuildResult } from "../types";
import { t } from "../i18n";
import { insertedNodes } from "./files";

const PART_PATH = "/parts/Standoff kit.sindri";

/** A saved part file: three features past a rollback marker and a suppressed
 *  one, two renamed bodies, a hidden one, its own palette and colours. */
function partFile(): CadDocument {
  return {
    version: 4,
    parameters: { h: 20 },
    features: [
      { id: "s1", type: "sketch", plane: "XY", entities: [] },
      { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new" },
      { id: "e2", type: "extrude", sketch: "s1", distance: 5, operation: "new" },
      { id: "e3", type: "extrude", sketch: "s1", distance: 5, operation: "new" },
      { id: "e4", type: "extrude", sketch: "s1", distance: 5, operation: "new" },
    ] as Feature[],
    rollback: 4,
    suppressed: ["e2"],
    bodyVisibility: { body3: false },
    bodyNames: { body1: "Standoff", body2: "Nut" },
    // the part file's own palette: slot 0 is a red, slot 1 a blue
    palette: [
      { name: "Red PLA", color: "#d23b30" },
      { name: "Blue PETG", color: "#3050c8" },
    ],
    bodyColors: { body1: 1, body2: 0 },
  };
}

/** What the sidecar answers for that file: two parts under a root. */
function insertReply(): Extract<InsertReply, { ok: true }> {
  return {
    ok: true, geom: "blob:kit", name: "Standoff kit", solid: true, faces: 12,
    nodes: [
      { name: "Standoff kit", parent: null },
      { name: "Body1", parent: 0 },
      { name: "Body2", parent: 0 },
    ],
    parts: [{ node: 1, faces: 6 }, { node: 2, faces: 6 }],
    bodies: ["body1", "body2"],
    pieceOf: {},
  };
}

describe("insertedNodes names and colours each part as the other document did", () => {
  it("takes the user's renames and the source palette's colours", () => {
    const nodes = insertedNodes(insertReply(), partFile());
    expect(nodes).toEqual([
      { name: "Standoff kit", parent: null },
      { name: "Standoff", parent: 0, color: "#3050c8" },
      { name: "Nut", parent: 0, color: "#d23b30" },
    ]);
  });

  it("names a split piece of a renamed body the way that document's Browser did", () => {
    const res = { ...insertReply(), pieceOf: { body2: ["body1", 2] as [string, number] } };
    const nodes = insertedNodes(res, { bodyNames: { body1: "Bracket" } });
    expect(nodes[1]!.name).toBe("Bracket");
    expect(nodes[2]!.name).toBe(t("feature.split.pieceName", { name: "Bracket", n: 2 }));
  });

  it("keeps the built name, or the file's name for a single body, when the user gave none", () => {
    expect(insertedNodes(insertReply(), {}).map((n) => n.name)).toEqual(["Standoff kit", "Body1", "Body2"]);
    const one = {
      nodes: [{ name: "M3x10", parent: null }], parts: [{ node: 0, faces: 6 }],
      bodies: ["body1"], pieceOf: {},
    };
    expect(insertedNodes(one, {})[0]!.name).toBe("M3x10");
    expect(insertedNodes(one, { bodyNames: { body1: "Screw" } })[0]!.name).toBe("Screw");
  });

  it("reads colours against the DEFAULT palette when the file saved none", () => {
    // an untouched palette is not written, but its slots still mean its colours
    const nodes = insertedNodes(insertReply(), { bodyColors: { body1: 2 } });
    expect(nodes[1]!.color).toBe("#d23b30");
    expect(nodes[2]!.color).toBeUndefined(); // no slot there, so no colour here
  });

  it("does not trust the file: a name must be a string and a slot a number", () => {
    const hostile = {
      bodyNames: { body1: { evil: true } } as unknown as Record<string, string>,
      bodyColors: { body1: "1" } as unknown as Record<string, number>,
    };
    const nodes = insertedNodes(insertReply(), hostile);
    expect(nodes[1]).toEqual({ name: "Body1", parent: 0 });
  });
});

describe("Insert ▸ Part from File", () => {
  let reported: string[];
  let toasts: string[];
  let invoked: string[];
  let picked: string | null;
  let fileText: string;

  beforeEach(() => {
    reported = [];
    toasts = [];
    invoked = [];
    picked = PART_PATH;
    fileText = JSON.stringify(partFile());
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    };
    vi.doMock("@tauri-apps/plugin-dialog", () => ({
      open: async () => picked,
      message: async (m: string) => void reported.push(m),
    }));
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: async (cmd: string) => {
        invoked.push(cmd);
        if (cmd === "container_is_container") return true;
        if (cmd === "container_open") return fileText;
        throw new Error(`unexpected invoke ${cmd}`);
      },
    }));
    vi.doMock("../ui/toast", () => ({ toast: (m: string) => void toasts.push(m) }));
  });

  afterEach(() => {
    vi.doUnmock("@tauri-apps/plugin-dialog");
    vi.doUnmock("@tauri-apps/api/core");
    vi.doUnmock("../ui/toast");
    vi.resetModules();
    delete (globalThis as unknown as Record<string, unknown>).window;
  });

  /** A sidecar that answers `insertDocument` with `reply` and builds the
   *  assembly: the plate, plus one body per part of an import. Body ids are
   *  positional, as the real sidecar's are. */
  function fakeSidecar(reply: InsertReply) {
    const sent: { doc: CadDocument; name: string }[] = [];
    const backend = {
      async init() {}, onStatus() { return () => {}; }, connected: true,
      async insertDocument(doc: CadDocument, name: string, onStarted?: (id: string) => void) {
        onStarted?.("ins-1");
        sent.push({ doc: structuredClone(doc), name });
        return reply;
      },
      async rebuild(doc: CadDocument): Promise<RebuildReply> {
        const bodies: { id: string; name: string; faceStart: number; faceCount: number; nodeRef?: string }[] = [];
        for (const f of doc.features) {
          if (f.type === "box") bodies.push({ id: `body${bodies.length + 1}`, name: "Plate", faceStart: 0, faceCount: 6 });
          if (f.type !== "import") continue;
          (f.parts ?? []).forEach((p) => bodies.push({
            id: `body${bodies.length + 1}`, name: f.nodes?.[p.node]?.name ?? f.name,
            faceStart: 0, faceCount: p.faces, nodeRef: `${f.id}/${p.node}`,
          }));
        }
        return {
          ok: true,
          result: {
            mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0) },
            edges: [], bbox: { min: [0, 0, 0], max: [1, 1, 1] }, bodies,
          } as unknown as RebuildResult,
        };
      },
    } as unknown as GeometryBackend;
    return { backend, sent };
  }

  /** The open document: a plate, with a palette that holds the part file's two
   *  colours in DIFFERENT slots, so a carried slot number would be wrong. */
  async function assembly(backend: GeometryBackend, palette = [
    { name: "White", color: "#e8e8e8" },
    { name: "Blue", color: "#3050c8" },
    { name: "Black", color: "#202020" },
    { name: "Red", color: "#d23b30" },
  ]) {
    const store = new DocumentStore(backend, { parameters: {}, features: [] });
    store.loadDocument({
      parameters: {},
      features: [{ id: "b1", type: "box", length: 100, width: 100, height: 2 } as Feature],
      palette,
    });
    store.markSaved("/projects/Enclosure.sindri");
    await vi.waitFor(() => expect(store.buildState.result?.bodies?.length).toBe(1));
    return store;
  }

  it("lands the other file's visible bodies as one import, named and coloured as there", async () => {
    const { backend, sent } = fakeSidecar(insertReply());
    const store = await assembly(backend);
    const { insertPartFromFile } = await import("./files");
    await insertPartFromFile(store, backend);
    await vi.waitFor(() => expect(store.buildState.result?.bodies?.length).toBe(3));

    // What the sidecar was asked to build is the file as OPEN would build it:
    // cut at its rollback marker, the suppressed feature gone, the old extrudes
    // stamped, and its hidden body still hidden.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe("Standoff kit");
    expect(sent[0]!.doc.features.map((f) => f.id)).toEqual(["s1", "e1", "e3"]);
    expect(sent[0]!.doc.features.filter((f) => f.type === "extrude").every((f) => "hiddenBodies" in f)).toBe(true);
    expect(sent[0]!.doc.bodyVisibility).toEqual({ body3: false });
    expect(sent[0]!.doc.parameters).toEqual({ h: 20 });

    const feature = store.document.features.at(-1)!;
    expect(feature).toMatchObject({
      type: "import", format: "brep", name: "Standoff kit", geom: "blob:kit",
      source: PART_PATH, solid: true, parts: insertReply().parts,
    });
    expect((feature as { nodes?: unknown }).nodes).toEqual([
      { name: "Standoff kit", parent: null },
      { name: "Standoff", parent: 0, color: "#3050c8" },
      { name: "Nut", parent: 0, color: "#d23b30" },
    ]);
    // Matched into THIS palette by colour: the blue part is slot 1 here and the
    // red one slot 3, though the part file had them at 1 and 0.
    await vi.waitFor(() => expect(store.bodyColorSlot("body2")).toBe(1));
    expect(store.bodyColorSlot("body3")).toBe(3);
    expect(store.bodyColorSlot("body1")).toBeUndefined(); // the plate is left alone
    expect(reported).toEqual([]);
    expect(toasts).toEqual([]); // nothing failed, nothing was lost

    // one undo takes the whole insert back out
    store.undo();
    expect(store.document.features.map((f) => f.id)).toEqual(["b1"]);
  });

  // Body ids are positional. A colour written once on "body2" stayed there
  // after the insert was undone, and the next body the user made took the id
  // and wore it, on screen and in a coloured 3MF (review of this feature).
  it("takes its colours out with it on undo, and brings them back on redo", async () => {
    const { backend } = fakeSidecar(insertReply());
    const store = await assembly(backend);
    const { insertPartFromFile } = await import("./files");
    await insertPartFromFile(store, backend);
    await vi.waitFor(() => expect(store.bodyColorSlot("body3")).toBe(3));

    store.undo();
    // at once, not after the rebuild: a save in between must not keep them
    expect(store.bodyColorsMap()).toEqual({});
    await vi.waitFor(() => expect(store.buildState.result?.bodies?.length).toBe(1));

    store.redo();
    await vi.waitFor(() => expect(store.bodyColorSlot("body2")).toBe(1));
    expect(store.bodyColorSlot("body3")).toBe(3);
  });

  it("leaves no colour for the next body to take the id", async () => {
    const { backend } = fakeSidecar(insertReply());
    const store = await assembly(backend);
    const { insertPartFromFile } = await import("./files");
    await insertPartFromFile(store, backend);
    await vi.waitFor(() => expect(store.bodyColorSlot("body2")).toBe(1));
    store.undo();
    await vi.waitFor(() => expect(store.buildState.result?.bodies?.length).toBe(1));

    // An unrelated import, which also gets the insert's freed feature id.
    const id = store.nextId();
    store.addFeature({
      id, type: "import", format: "step", name: "Other", geom: "blob:other", solid: true,
      nodes: [{ name: "Other", parent: null }], parts: [{ node: 0, faces: 6 }],
    } as Feature);
    await vi.waitFor(() => expect(store.buildState.result?.bodies?.length).toBe(2));
    expect(store.buildState.result!.bodies![1]).toMatchObject({ id: "body2", nodeRef: `${id}/0` });
    expect(store.bodyColorSlot("body2")).toBeUndefined();
  });

  it("follows its bodies when they are renumbered, keeping a colour the user changed", async () => {
    const { backend } = fakeSidecar(insertReply());
    const store = await assembly(backend);
    const { insertPartFromFile } = await import("./files");
    await insertPartFromFile(store, backend);
    await vi.waitFor(() => expect(store.bodyColorSlot("body3")).toBe(3));
    store.setBodyColorSlot("body2", 0); // the user makes the Standoff white

    store.removeFeature("b1"); // the plate goes: the parts become body1 and body2
    await vi.waitFor(() => expect(store.buildState.result?.bodies?.map((b) => b.id)).toEqual(["body1", "body2"]));
    expect(store.bodyColorsMap()).toEqual({ body1: 0, body2: 3 });
  });

  it("says which colour became which when this palette does not hold one", async () => {
    const { backend } = fakeSidecar(insertReply());
    // the part file's blue is here, its red is not: the nearest is the black
    const store = await assembly(backend, [
      { name: "White", color: "#e8e8e8" },
      { name: "Blue", color: "#3050c8" },
      { name: "Black", color: "#202020" },
      { name: "Green", color: "#30a050" },
    ]);
    const { insertPartFromFile } = await import("./files");
    await insertPartFromFile(store, backend);
    expect(store.bodyColorsMap()).toEqual({ body2: 1, body3: 2 });
    expect(toasts).toEqual([t("file.insert.colorsMatched", {
      count: 1, n: "1", name: "Standoff kit.sindri",
      pairs: t("file.insert.colorPair", { from: "Red PLA", to: "Black" }),
    })]);
  });

  it("says what did not come across", async () => {
    const { backend } = fakeSidecar({ ...insertReply(), failed: 2, appearanceLost: 1 });
    const store = await assembly(backend);
    const { insertPartFromFile } = await import("./files");
    await insertPartFromFile(store, backend);
    expect(toasts).toEqual([
      t("file.insert.failed", { count: 2, n: "2", name: "Standoff kit.sindri" }),
      t("file.insert.appearanceLost", { count: 1, n: "1", name: "Standoff kit.sindri" }),
    ]);
  });

  it("refuses the document that is already open, before reading anything", async () => {
    const { backend, sent } = fakeSidecar(insertReply());
    const store = await assembly(backend);
    picked = "/projects/Enclosure.sindri";
    const { insertPartFromFile } = await import("./files");
    await insertPartFromFile(store, backend);
    expect(reported).toEqual([t("file.insert.self")]);
    expect(invoked).toEqual([]);
    expect(sent).toEqual([]);
    expect(store.document.features.map((f) => f.id)).toEqual(["b1"]);
  });

  it("reports a refusal in the user's language and changes nothing", async () => {
    const { backend } = fakeSidecar({ ok: false, message: "sidecar prose", code: "insertNoBodies" });
    const store = await assembly(backend);
    const { insertPartFromFile } = await import("./files");
    await insertPartFromFile(store, backend);
    expect(reported).toEqual([t("file.error.insert", {
      name: "Standoff kit.sindri", reason: t("engine.error.insertNoBodies"),
    })]);
    expect(store.document.features.map((f) => f.id)).toEqual(["b1"]);
  });

  it("says nothing and adds nothing when the user cancels", async () => {
    const { backend } = fakeSidecar({ ok: false, cancelled: true, message: "cancelled" });
    const store = await assembly(backend);
    const { insertPartFromFile } = await import("./files");
    await insertPartFromFile(store, backend);
    expect(reported).toEqual([]);
    expect(store.document.features.map((f) => f.id)).toEqual(["b1"]);
  });

  it("reports a file that is not a document, however it is broken", async () => {
    const { backend, sent } = fakeSidecar(insertReply());
    const store = await assembly(backend);
    const { insertPartFromFile } = await import("./files");
    for (const broken of ["not json at all", "42", '{"parameters": {}}', '{"features": [null]}']) {
      reported = [];
      fileText = broken;
      await insertPartFromFile(store, backend);
      expect(reported, broken).toHaveLength(1);
      expect(reported[0], broken).toContain("Standoff kit.sindri");
    }
    expect(sent).toEqual([]);
    expect(store.document.features.map((f) => f.id)).toEqual(["b1"]);
  });

  it("survives a palette and overlays of the wrong shape", async () => {
    fileText = JSON.stringify({ ...partFile(), palette: "red", bodyNames: 7, bodyColors: [1, 2] });
    const { backend } = fakeSidecar(insertReply());
    const store = await assembly(backend);
    const { insertPartFromFile } = await import("./files");
    await insertPartFromFile(store, backend);
    expect(reported).toEqual([]);
    expect((store.document.features.at(-1) as { nodes?: unknown }).nodes).toEqual(insertReply().nodes);
  });
});

// The skeptic's Problem A (Doug 29): File ▸ Open takes STEP and mesh files and
// ADDS them to the open document, but asked "Save your changes before opening
// another document?" BEFORE the picker. Picking Discard cleared the recovery
// slot for a document that was never replaced, and a user bringing a STEP into
// their model was told it was about to go away.
describe("File ▸ Open asks to save only when a document will replace this one", () => {
  let picked: string;
  let invoked: string[];

  beforeEach(() => {
    invoked = [];
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    };
    vi.doMock("@tauri-apps/plugin-dialog", () => ({
      open: async () => picked,
      message: async () => {},
    }));
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: async (cmd: string) => {
        invoked.push(cmd);
        if (cmd === "container_is_container") return true;
        if (cmd === "container_open") return JSON.stringify({ parameters: {}, features: [] });
        throw new Error(`unexpected invoke ${cmd}`);
      },
    }));
    vi.doMock("./recentFiles", () => ({ noteRecent: () => {} })); // localStorage
  });

  afterEach(() => {
    vi.doUnmock("@tauri-apps/plugin-dialog");
    vi.doUnmock("@tauri-apps/api/core");
    vi.doUnmock("./recentFiles");
    vi.resetModules();
    delete (globalThis as unknown as Record<string, unknown>).window;
  });

  function backendWithImport() {
    const imported: string[] = [];
    const backend = {
      async init() {}, onStatus() { return () => {}; }, connected: true,
      async importGeometry(path: string) {
        imported.push(path);
        return { ok: true, name: "bracket", geom: "blob:bracket", solid: true, faces: 6 };
      },
      async rebuild(): Promise<RebuildReply> {
        return { ok: false, error: { message: "stub" } };
      },
    } as unknown as GeometryBackend;
    return { backend, imported };
  }

  it("a STEP picked in Open is added without asking", async () => {
    picked = "/tmp/bracket.step";
    const { backend, imported } = backendWithImport();
    const store = new DocumentStore(backend, { parameters: {}, features: [] });
    store.addFeature({ id: "b1", type: "box", length: 1, width: 1, height: 1 } as Feature);
    const confirm = vi.fn(async () => false);
    const { openDocument } = await import("./files");
    await openDocument(store, backend, confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(imported).toEqual(["/tmp/bracket.step"]);
    expect(store.document.features.map((f) => f.type)).toEqual(["box", "import"]);
  });

  it("a document picked in Open asks first, and backing out keeps this one", async () => {
    picked = "/tmp/other.sindri";
    const { backend } = backendWithImport();
    const store = new DocumentStore(backend, { parameters: {}, features: [] });
    store.addFeature({ id: "b1", type: "box", length: 1, width: 1, height: 1 } as Feature);
    const confirm = vi.fn(async () => false);
    const { openDocument } = await import("./files");
    await openDocument(store, backend, confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(invoked).toEqual([]); // nothing was even read
    expect(store.document.features.map((f) => f.id)).toEqual(["b1"]);

    confirm.mockResolvedValue(true);
    await openDocument(store, backend, confirm);
    expect(store.document.features).toEqual([]);
    expect(store.filePath).toBe("/tmp/other.sindri");
  });
});
