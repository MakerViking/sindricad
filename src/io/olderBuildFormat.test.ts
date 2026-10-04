// Round 3 decision R1: a sketch that ties something to a rectangle's centre or
// to a polygon's or slot's corner, centre or side is SAVED as format v6, so an
// older build (0.1.232 reads up to v5) says on open that the file was made by a
// newer version instead of saying nothing and then dropping those constraints
// at the next edit of that sketch. Every other document is still saved as v5,
// so an older build keeps opening it without a word.
//
// Entered where the user enters: the real Coincident and Horizontal tools'
// clicks, the sketch's own commit (snapshotFeature, which Finish adds), the
// real Save handler (the document JSON it hands Rust's container_save) and the
// real Open handler. The older build is stood in for by its loader gate:
// migrateDocument reading up to v5, which is what 0.1.232's migrate.ts does on
// every open (its store.load toasts what that returns).
import { describe, it, expect, vi, beforeEach } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));
const disk = vi.hoisted(() => {
  // isTauri() is `"__TAURI_INTERNALS__" in window`, and Save notes the file in
  // Recent (localStorage): stand up exactly those, nothing more
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    __TAURI_INTERNALS__: {},
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  };
  const ls = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v) };
  return { files: new Map<string, string>() };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "container_save") return void disk.files.set(args["path"] as string, args["documentJson"] as string);
    if (cmd === "container_is_container") return true;
    if (cmd === "container_open") return disk.files.get(args["path"] as string);
    return undefined; // recovery_clear
  },
}));
vi.mock("../ui/toast", () => ({ toast: () => () => {} }));
vi.mock("../ui/prompt", () => ({ setPrompt: () => {} }));
vi.mock("../ui/menu", () => ({ contextMenu: vi.fn(), dismissContextMenu: vi.fn() }));

import { DocumentStore } from "../document/store";
import { FORMAT_VERSION, migrateDocument } from "../document/migrate";
import { liveSketch } from "../sketch/liveSketch.testkit";
import { ORIGIN_ID } from "../sketch/origin";
import { polygonPoints } from "../sketch/region";
import { resolveRealEntities } from "../sketch/resolve";
import { openDocumentAtPath, saveDocument } from "./files";
import { t } from "../i18n";
import type { GeometryBackend } from "../geometry/client";
import type { ResolvedEntity } from "../sketch/snap";
import type { CadDocument, Feature, SketchConstraint } from "../types";

/** The newest version 0.1.232 reads: its migrate.ts FORMAT_VERSION. */
const OLDER_BUILD_READS = 5;
const PATH = "/home/me/part.sindri";

/** A hexagon of radius 10 about (0, 0), corner 0 at (10, 0). */
const HEX: ResolvedEntity = { type: "polygon", id: "H", x: 0, y: 0, radius: 10, sides: 6, angle: 0 };
/** 40 x 20 about (10, 5): corner 0 at (-10, -5), centre (10, 5). */
const RECT: ResolvedEntity = { type: "rectangle", id: "R", x: 10, y: 5, width: 40, height: 20 };
/** 30 long from (10, 0) along X, 6 wide: centre 1 at (40, 0). */
const SLOT: ResolvedEntity = { type: "slot", id: "S", x1: 10, y1: 0, x2: 40, y2: 0, width: 6 };
const LINE: ResolvedEntity = { type: "line", id: "l", x1: 30, y1: 20, x2: 40, y2: 30 };
const POINT: ResolvedEntity = { type: "point", id: "P", x: 50, y: 12 };
/** the middle of side 0 of HEX turned 17 degrees: corner 0 to corner 1 */
const [C0, C1] = polygonPoints(0, 0, 10, 6, (17 * Math.PI) / 180);
const SIDE_0_MID = { x: (C0!.x + C1!.x) / 2, y: (C0!.y + C1!.y) / 2 };

const backend = {
  async rebuild() { return { ok: false, error: { message: "stub" } }; },
  async init() {}, onStatus() { return () => {}; }, connected: true,
} as unknown as GeometryBackend;

let warnings: string[];
beforeEach(() => { warnings = []; disk.files.clear(); });

function openStore(): DocumentStore {
  const store = new DocumentStore(backend, { parameters: {}, features: [] });
  store.onWarning = (m) => void warnings.push(m); // main.ts: a toast
  return store;
}

/** Draw `ents` in a new sketch, click `tool` at each point in turn, and press
 *  Finish: the sketch's own snapshot, added the way finish() adds it. */
async function finishSketch(store: DocumentStore, ents: ResolvedEntity[], tool: string, ...at: { x: number; y: number }[]) {
  const live = liveSketch(ents);
  live.s.tool = tool as typeof live.s.tool;
  for (const q of at) live.click(q.x, q.y);
  await live.settle();
  Object.assign(live.s, { store, editingId: null });
  const sketch = (live.s as unknown as { snapshotFeature(): Feature | null }).snapshotFeature()!;
  store.addFeature(sketch);
  return sketch.type === "sketch" ? sketch.constraints ?? [] : [];
}

/** Save through the real handler and read back the document it wrote. */
async function save(store: DocumentStore): Promise<CadDocument> {
  store.markSaved(PATH);
  await saveDocument(store);
  return JSON.parse(disk.files.get(PATH)!) as CadDocument;
}

describe("a sketch an older build would lose constraints from is saved as v6", () => {
  const cases: [string, ResolvedEntity[], string, { x: number; y: number }[], SketchConstraint][] = [
    ["a polygon's corner on a line's end", [HEX, LINE], "coincident", [{ x: 10, y: 0 }, { x: 30, y: 20 }],
      { type: "coincident", e1: "H", p1: 0, e2: "l", p2: 0 }],
    ["a polygon's centre on the origin", [{ ...HEX, x: 12, y: -7 }], "coincident", [{ x: 12, y: -7 }, { x: 0, y: 0 }],
      { type: "coincident", e1: "H", p1: -1, e2: ORIGIN_ID, p2: 0 }],
    ["a rectangle's centre on the origin", [RECT], "coincident", [{ x: 10, y: 5 }, { x: 0, y: 0 }],
      { type: "coincident", e1: "R", p1: 4, e2: ORIGIN_ID, p2: 0 }],
    ["a slot's centre on a sketch point", [SLOT, POINT], "coincident", [{ x: 40, y: 0 }, { x: 50, y: 12 }],
      { type: "coincident", e1: "S", p1: 1, e2: "P", p2: 0 }],
    ["Horizontal on a polygon's side", [{ ...HEX, angle: 17 }], "horizontal", [SIDE_0_MID],
      { type: "horizontal", line: "H~0" }],
  ];

  it.each(cases)("%s", async (_name, ents, tool, at, made) => {
    const store = openStore();
    expect(await finishSketch(store, ents, tool, ...at), "what the tool made").toEqual([made]);
    const saved = await save(store);
    expect(saved.version).toBe(6);
    // the older build: one toast on open, which it had none of before
    expect(migrateDocument(saved, OLDER_BUILD_READS)).toEqual([t("file.warning.newerVersion")]);

    // and this build opens its own file without a word, the constraint intact
    const again = openStore();
    expect(await openDocumentAtPath(again, PATH)).toBe("ok");
    expect(warnings).toEqual([]);
    const sk = again.document.features.find((f) => f.type === "sketch");
    expect(sk?.type === "sketch" ? sk.constraints : null).toEqual([made]);
    expect((await save(again)).version, "and saves it as v6 again").toBe(6);
  });
});

describe("every other document is still saved as v5", () => {
  it("a rectangle's CORNER on the origin, and a polygon nothing names", async () => {
    const store = openStore();
    const made = await finishSketch(store, [RECT, { ...HEX, x: 60, y: 60 }], "coincident", { x: -10, y: -5 }, { x: 0, y: 0 });
    expect(made).toEqual([{ type: "coincident", e1: "R", p1: 0, e2: ORIGIN_ID, p2: 0 }]);
    const saved = await save(store);
    expect(saved.version).toBe(5);
    expect(migrateDocument(saved, OLDER_BUILD_READS), "the older build opens it without a word").toEqual([]);
  });

  it("an empty document", async () => {
    const saved = await save(openStore());
    expect(saved.version).toBe(5);
    expect(migrateDocument(saved, OLDER_BUILD_READS)).toEqual([]);
  });
});

// The stamp's cost in the older build: 0.1.232's migrateDocument returns at its
// version gate before it reserves the loaded dimension ids, so a dimension
// added there to a v6 sketch can take an id another one in it already has
// (measured in the real 0.1.232: Lock on a second line gave it the first
// line's c3), and it saves the twins as v5. Both halves are this build's side
// of that: a twin gets its own id when such a file comes back, and this build
// does not repeat the slip on a file from a build newer than it.
describe("dimension ids across builds", () => {
  const line = (id: string, len: number) => ({ type: "line" as const, id, x1: 0, y1: 0, x2: len, y2: 0 });
  const file = (version: number, entities: object[], constraints: SketchConstraint[], paramDefs?: CadDocument["paramDefs"]) =>
    JSON.stringify({ version, parameters: {}, ...(paramDefs ? { paramDefs } : {}), features: [{ id: "f1", type: "sketch", plane: "XY", entities, constraints }] });
  const dimsOf = (store: DocumentStore) => {
    const sk = store.document.features[0];
    return sk?.type === "sketch" ? (sk.constraints ?? []) : [];
  };

  it("the twins an older build saved each get their own id, the first keeping its binding", async () => {
    // what 0.1.232 wrote: Lock on e2 took e1's c3, and d1 was bound to e1's
    disk.files.set(PATH, file(5, [line("e1", 30), line("e2", 20)], [
      { type: "distance", line: "e1", value: 30, id: "c3" },
      { type: "distance", line: "e2", value: 20, id: "c3" },
    ], { d1: { expr: "30", value: 30, unit: "mm", target: { kind: "constraint", sketch: "f1", constraint: "c3" } } }));
    const store = openStore();
    expect(await openDocumentAtPath(store, PATH)).toBe("ok");
    expect(warnings).toEqual([]);
    const [first, second] = dimsOf(store) as { line: string; id: string }[];
    expect(first).toMatchObject({ line: "e1", id: "c3" });
    expect(second!.line).toBe("e2");
    expect(second!.id, "a fresh id of its own").not.toBe("c3");
    expect(store.document.paramDefs?.["d1"]?.target).toEqual({ kind: "constraint", sketch: "f1", constraint: "c3" });
  });

  it("a dimension added to a sketch from a NEWER build does not take an id it already has", async () => {
    // ids past anything this file's earlier tests handed out, the dimension's
    // the highest: entering the sketch reserves e7000 and e7001, so without
    // the dimension's reservation the next id would be c7002 again
    disk.files.set(PATH, file(FORMAT_VERSION + 1, [line("e7000", 30), line("e7001", 20)], [
      { type: "distance", line: "e7000", value: 30, id: "c7002" },
    ]));
    const store = openStore();
    expect(await openDocumentAtPath(store, PATH)).toBe("ok");
    expect(warnings).toEqual([t("file.warning.newerVersion")]);

    const sk = store.document.features[0]!;
    if (sk.type !== "sketch") throw new Error("no sketch");
    const live = liveSketch(resolveRealEntities(sk, {}), structuredClone(sk.constraints ?? []));
    live.s.selected.add("e7001");
    live.s.lockDimensionCommand();
    await live.settle();
    const added = live.s.constraints.find((c) => c.type === "distance" && c.line === "e7001") as { id?: string } | undefined;
    expect(added, "Lock made the second line's length").toBeDefined();
    expect(added!.id).not.toBe("c7002");
  });
});
