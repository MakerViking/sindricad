// Project a POINT, and project curves smooth (decision A7, Doug 22b + 23).
//
// A body corner or a point of an earlier sketch lands as a fixed projected
// point. What is KEPT matters more than what lands: a corner must persist as
// its edge's by:"match" fingerprint and an end index, never the picked
// position or the by:"nearest" selector the pick used to find the edge (a
// point re-binds to the wrong edge in silence). And every curve link made now
// carries `smooth`, which is what tells the sidecar to build sampled curves as
// one spline; a link that lacks it keeps building the faceted polyline.
//
// Drives the real click handler (`projectClick`) off SketchMode.prototype, as
// projectConstruction.test.ts does, with the viewport's picks and the
// sidecar's reply stubbed.
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { SketchMode } from "./sketchMode";
import { SketchPlane } from "./plane";
import { PROJECT_FILTERS, type ProjectFilter } from "./projectPanel";
import type { ResolvedEntity } from "./snap";
import type { EdgeFingerprint, ProjectedSource } from "../types";
import type { GeometryBackend, ProjectionRequest } from "../geometry/client";
import { DocumentStore } from "../document/store";
import { migrateDocument } from "../document/migrate";
import { t } from "../i18n";

const toasts: string[] = [];
vi.mock("../ui/toast", () => ({ toast: (m: string) => { toasts.push(m); return () => {}; } }));

const FP: EdgeFingerprint = { mid: [0, -10, 10], dir: [1, 0, 0], length: 20, curve: "line" };
/** the top front edge of a 20 mm box, as the viewport hands it over */
const EDGE = { id: "e7", body: "body1", points: [[-10, -10, 10], [10, -10, 10]] };

interface Picks {
  sketchPoint?: { sketchId: string; entityId: string; point: number; world: THREE.Vector3 } | null;
  corner?: { point: THREE.Vector3; edges: unknown[] } | null;
  /** screen position of a world point: x for the sketch point, 3 px off otherwise */
  screen?: (w: THREE.Vector3) => { x: number; y: number };
  reply?: unknown[];
  /** the committed entity a Sketch curves click lands on (a line if unset) */
  committed?: ResolvedEntity;
}

function projecting(filter: ProjectFilter, picks: Picks = {}) {
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  const entities: ResolvedEntity[] = [];
  const sent: ProjectionRequest[] = [];
  Object.assign(s, {
    active: true,
    tool: "project",
    plane: new SketchPlane("XY"),
    entities,
    editingId: null,
    projectBusy: false,
    constructionMode: false,
    projectPanel: { filter },
    overlay: {
      committedPointAt: () => picks.sketchPoint ?? null,
      committedCurveAt: () => ({ sketchId: "f1", entityId: "c1" }),
    },
    viewport: {
      projectToScreen: picks.screen ?? (() => ({ x: 5, y: 5 })),
      behindSurfaceAt: () => () => false,
      pickVertexAt: () => picks.corner ?? null,
      pickEntity: () => ({ kind: "edge", edge: EDGE, selector: { kind: "edge", by: "nearest", point: [-10, -10, 10] } }),
    },
    committedSource: () => ({ entity: picks.committed ?? { type: "line", id: "c1", x1: 0, y1: 0, x2: 1, y2: 1 } }),
    store: {
      projectGeometry: async (_plane: unknown, sources: ProjectionRequest[]) => {
        sent.push(...sources);
        return [{ source_index: 0, ok: true, curves: picks.reply ?? [] }];
      },
    },
    refreshActive() {},
    requestSolve() {},
    onState: null,
  });
  const click = () =>
    (s as unknown as { projectClick(e: PointerEvent): Promise<void> }).projectClick(
      { clientX: 5, clientY: 5, button: 0 } as unknown as PointerEvent,
    );
  return { s, entities, sent, click };
}

const landed = (entities: ResolvedEntity[]) =>
  entities.filter((e): e is Extract<ResolvedEntity, { type: "projected" }> => e.type === "projected");

describe("the Project tool offers points", () => {
  it("has a Points filter beside the curve filters", () => {
    expect(PROJECT_FILTERS.map((c) => c.key)).toContain("points");
  });
});

describe("projecting a body corner", () => {
  const corner = { point: new THREE.Vector3(10, -10, 10), edges: [EDGE] };
  const reply = [{ fp: FP, end: 1, curve: { kind: "point", x: 10, y: -10 } }];

  it("asks for the corner as an END of its edge, and keeps the fingerprint and the end", async () => {
    const { entities, sent, click } = projecting("points", { corner, reply });
    await click();
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.kind).toBe("vertex");
    // pick time: the edge by a point on its middle (never its corner, which
    // three edges share) and where the corner is
    expect(req).toMatchObject({ body: "body1", sel: { kind: "edge", by: "nearest", point: [0, -10, 10] }, point: [10, -10, 10] });
    const [p] = landed(entities);
    expect(p, "the corner did not land").toBeDefined();
    expect(p!.curve).toEqual({ kind: "point", x: 10, y: -10 });
    expect(
      p!.source,
      "a corner must persist as fingerprint + end: a stored position or by:nearest selector re-binds to the wrong edge in silence",
    ).toEqual({ kind: "vertex", body: "body1", sel: { kind: "edge", by: "match", fp: FP }, end: 1 } satisfies ProjectedSource);
  });

  it("refuses the same corner twice", async () => {
    const { entities, click } = projecting("points", { corner, reply });
    await click();
    toasts.length = 0;
    await click();
    expect(landed(entities)).toHaveLength(1);
    expect(toasts).toEqual(["That point is already projected into this sketch"]);
  });

  it("lands nothing when the reply names no edge to keep", async () => {
    const { entities, click } = projecting("points", { corner, reply: [{ curve: { kind: "point", x: 10, y: -10 } }] });
    await click();
    expect(landed(entities)).toHaveLength(0);
  });
});

describe("projecting a point of an earlier sketch", () => {
  const sketchPoint = { sketchId: "f1", entityId: "l1", point: 1, world: new THREE.Vector3(4, 2, 0) };
  const reply = [{ curve: { kind: "point", x: 4, y: 2 } }];

  it("keeps the sketch, the entity and the point's index", async () => {
    const { entities, sent, click } = projecting("points", { sketchPoint, reply });
    await click();
    const want: ProjectedSource = { kind: "sketchPoint", sketch: "f1", entity: "l1", pointIndex: 1 };
    expect(sent).toEqual([want]);
    const [p] = landed(entities);
    expect(p!.source).toEqual(want);
    expect(p!.curve).toEqual({ kind: "point", x: 4, y: 2 });
  });

  it("refuses the same point twice without asking the sidecar", async () => {
    const { entities, sent, click } = projecting("points", { sketchPoint, reply });
    await click();
    toasts.length = 0;
    await click();
    expect(sent).toHaveLength(1);
    expect(landed(entities)).toHaveLength(1);
    expect(toasts).toEqual(["That point is already projected into this sketch"]);
  });

  it("takes whichever of a sketch point and a body corner is nearer the cursor", async () => {
    const corner = { point: new THREE.Vector3(10, -10, 10), edges: [EDGE] };
    // the sketch point sits 1 px from the cursor, the corner 6 px
    const near = projecting("points", {
      sketchPoint, corner, reply,
      screen: (w) => (w.x === 4 ? { x: 6, y: 5 } : { x: 11, y: 5 }),
    });
    await near.click();
    expect(near.sent[0]?.kind).toBe("sketchPoint");
    const far = projecting("points", {
      sketchPoint, corner, reply: [{ fp: FP, end: 1, curve: { kind: "point", x: 10, y: -10 } }],
      screen: (w) => (w.x === 4 ? { x: 11, y: 5 } : { x: 6, y: 5 }),
    });
    await far.click();
    expect(far.sent[0]?.kind).toBe("vertex");
  });

  it("does nothing with no point under the cursor", async () => {
    const { entities, sent, click } = projecting("points", {});
    await click();
    expect(sent).toEqual([]);
    expect(landed(entities)).toEqual([]);
  });
});

describe("a point clicked under Sketch curves", () => {
  // The first place a user looks for an earlier sketch's point is the Sketch
  // curves filter: a point there used to light up, then come back with the
  // sidecar's raw 'a "point" entity has no curve to project'.
  const reply = [{ curve: { kind: "point", x: 4, y: 2 } }];
  const want: ProjectedSource = { kind: "sketchPoint", sketch: "f1", entity: "c1", pointIndex: 0 };

  it("projects a sketch point as a point", async () => {
    const { entities, sent, click } = projecting("sketchCurves", { reply, committed: { type: "point", id: "c1", x: 4, y: 2 } });
    await click();
    expect(sent).toEqual([want]);
    expect(landed(entities).map((p) => p.source)).toEqual([want]);
    toasts.length = 0;
    await click();
    expect(sent, "the second click asked the sidecar again").toHaveLength(1);
    expect(toasts).toEqual(["That point is already projected into this sketch"]);
  });

  it("projects an earlier sketch's projected point as a point", async () => {
    const committed: ResolvedEntity = {
      type: "projected", id: "c1", curve: { kind: "point", x: 4, y: 2 },
      source: { kind: "sketchPoint", sketch: "f0", entity: "p0", pointIndex: 0 },
    };
    const { sent, click } = projecting("sketchCurves", { reply, committed });
    await click();
    expect(sent).toEqual([want]);
  });
});

describe("every curve link made now is a smooth one", () => {
  const poly = { kind: "poly", pts: [[0, 0], [1, 1], [2, 0]], smooth: true };

  it("an edge", async () => {
    const { entities, sent, click } = projecting("edges", { reply: [{ fp: FP, curve: poly }] });
    await click();
    expect(sent[0]).toMatchObject({ kind: "edge", smooth: true });
    expect(landed(entities)[0]!.source).toEqual({ kind: "edge", body: "body1", sel: { kind: "edge", by: "match", fp: FP }, smooth: true });
  });

  it("a sketch curve", async () => {
    const { entities, sent, click } = projecting("sketchCurves", { reply: [{ curve: poly }] });
    await click();
    expect(sent[0]).toEqual({ kind: "sketchCurve", sketch: "f1", entity: "c1", smooth: true });
    expect(landed(entities)[0]!.source).toEqual({ kind: "sketchCurve", sketch: "f1", entity: "c1", smooth: true });
  });

  it("a silhouette", async () => {
    const { entities, sent, click } = projecting("silhouette", { reply: [{ curve: poly }] });
    await click();
    expect(sent[0]).toEqual({ kind: "silhouette", body: "body1", smooth: true });
    expect(landed(entities)[0]!.source).toEqual({ kind: "silhouette", body: "body1", smooth: true });
  });
});

// An older beta (0.1.232) has no projected point: drawing, snapping, finding
// the areas of, checking or solving a sketch holding one throws there. So the
// document is saved as format v6, which that beta warns about on open (the
// mechanism decision R1 set up for shape operands). A smooth curve is no
// such thing: that beta builds it in straight pieces, as it always did.
describe("the format a projection is saved in", () => {
  const backend = {
    async rebuild() { return { ok: false, error: { message: "stub" } }; },
    async init() {}, onStatus() { return () => {}; }, connected: true,
  } as unknown as GeometryBackend;
  /** what Save writes for a document with a sketch of `entities` */
  const saved = (entities: ResolvedEntity[]) => {
    const store = new DocumentStore(backend, { parameters: {}, features: [] });
    store.addFeature({ id: "f2", type: "sketch", plane: "XY", entities: landed(entities) });
    return store.toObject();
  };

  it("is v6 with a projected point, and the older beta warns on open", async () => {
    const corner = { point: new THREE.Vector3(10, -10, 10), edges: [EDGE] };
    const { entities, click } = projecting("points", { corner, reply: [{ fp: FP, end: 1, curve: { kind: "point", x: 10, y: -10 } }] });
    await click();
    const doc = saved(entities);
    expect(doc.version).toBe(6);
    expect(migrateDocument(structuredClone(doc), 5)).toEqual([t("file.warning.newerVersion")]);
  });

  it("stays v5 with only a smooth curve, and the older beta opens it without a word", async () => {
    const poly = { kind: "poly", pts: [[0, 0], [1, 1], [2, 0]], smooth: true };
    const { entities, click } = projecting("edges", { reply: [{ fp: FP, curve: poly }] });
    await click();
    const doc = saved(entities);
    expect(doc.version).toBe(5);
    expect(migrateDocument(structuredClone(doc), 5)).toEqual([]);
  });
});
