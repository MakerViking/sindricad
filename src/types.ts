// Shared API + document types. Source of truth for the TS side; mirrors the
// Python sidecar contract.

export type Params = Record<string, number>;
export type Num = number | string; // literal or parameter name

export type Vec3 = [number, number, number];

// A geometric "fingerprint" of an edge/face: enough scalar invariants to re-find
// THIS one entity on a freshly rebuilt body — robust to small kernel drift and to
// symmetric duplicates (which share some, but not all, invariants). The resolver
// scores candidates on whichever fields are present (see sidecar/geom_select.py),
// so a bare {mid,dir} already beats the old single-point `nearest`.
export interface EdgeFingerprint {
  mid: Vec3; // midpoint (curve parameter 0.5), world mm
  dir: Vec3; // unit tangent at 0.5, sign-normalized (edges are unoriented)
  length?: number; // curve length, mm
  curve?: "line" | "circle" | "ellipse" | "bspline" | "other";
  radius?: number; // circle/arc radius, mm — disambiguates concentric arcs
  center?: Vec3; // arc/circle center, mm
}
export interface FaceFingerprint {
  centroid: Vec3; // area centroid, world mm
  normal: Vec3; // unit outward normal at the centroid (oriented)
  area?: number; // mm^2
  surface?: "plane" | "cylinder" | "cone" | "sphere" | "torus" | "bspline" | "other";
  radius?: number; // cylinder/sphere/cone radius, mm
}

export type Selector =
  | { kind: "edge"; by: "axis"; axis: "X" | "Y" | "Z" }
  | { kind: "edge"; by: "nearest"; point: [number, number, number] }
  | { kind: "edge"; by: "all" }
  | { kind: "face"; by: "normal"; dir: [number, number, number] }
  | { kind: "face"; by: "nearest"; point: [number, number, number] }
  // --- v2: discriminating, drift-robust selection ---
  // `match` re-finds ONE entity by scored geometric fingerprint; `nth` breaks a
  // genuine tie (symmetric twins) by a rebuild-stable canonical order.
  | { kind: "edge"; by: "match"; fp: EdgeFingerprint; nth?: number }
  | { kind: "face"; by: "match"; fp: FaceFingerprint; nth?: number }
  // structural forms — encode intent instead of N independent point-picks:
  | { kind: "edge"; by: "tangentChain"; seed: EdgeFingerprint } // an edge + its tangent-continuous chain
  | { kind: "edge"; by: "ofFace"; face: FaceFingerprint }; // all edges bounding a face

// construction geometry is referenceable but does NOT form profiles.
// arc = 3 points: start (1), end (2), and a point it passes through (m).
// `id` is the stable identity that constraints reference (assigned on creation).
export type SketchEntity =
  | { type: "rectangle"; id?: string; width: Num; height: Num; x?: Num; y?: Num; construction?: boolean }
  | { type: "circle"; id?: string; radius: Num; x?: Num; y?: Num; construction?: boolean }
  | { type: "line"; id?: string; x1: Num; y1: Num; x2: Num; y2: Num; construction?: boolean }
  | { type: "arc"; id?: string; x1: Num; y1: Num; x2: Num; y2: Num; mx: Num; my: Num; construction?: boolean }
  // fit-point spline: interpolates a smooth curve through its points (≥2)
  | { type: "spline"; id?: string; points: { x: Num; y: Num }[]; construction?: boolean }
  // a sketch point: reference/snap geometry only — never forms a profile
  | { type: "point"; id?: string; x: Num; y: Num; construction?: boolean };

// 2D sketch constraints, solved by planegcs. Entities are referenced by their
// stable id (see sketch/id.ts) — never array index — so edit operations that
// reorder/split entities can't repoint a constraint. distance/diameter carry a
// driving value in mm.
export type SketchConstraint =
  | { type: "horizontal"; line: string }
  | { type: "vertical"; line: string }
  | { type: "parallel"; l1: string; l2: string }
  | { type: "perpendicular"; l1: string; l2: string }
  | { type: "equal"; l1: string; l2: string }
  | { type: "distance"; line: string; value: number }
  | { type: "diameter"; circle: string; value: number }
  // tangent: a line and a circle/arc touch (line tangent to the circle)
  | { type: "tangent"; line: string; circle: string }
  // coincident: two entity endpoints share a position. `e1`/`e2` are entity ids;
  // `p1`/`p2` are the endpoint index (0 = start, 1 = end) on each.
  | { type: "coincident"; e1: string; p1: number; e2: string; p2: number }
  // concentric: two circles/arcs share a center
  | { type: "concentric"; c1: string; c2: string }
  // midpoint: a point (endpoint of `e`/`p`) sits at the midpoint of a line
  | { type: "midpoint"; e: string; p: number; line: string }
  // symmetric: two endpoints mirror across a line (the symmetry axis)
  | { type: "symmetric"; e1: string; p1: number; e2: string; p2: number; line: string };

export type Plane3 = "XY" | "XZ" | "YZ";
export type Axis3 = "X" | "Y" | "Z";

// an arbitrary plane (e.g. derived from a face or an offset): origin + x axis +
// normal, all in world mm. The in-plane Y axis is normal × xdir.
export type PlaneDef = {
  origin: [number, number, number];
  normal: [number, number, number];
  xdir: [number, number, number];
};
export type PlaneSpec = Plane3 | PlaneDef;

export type Feature =
  | { id: string; type: "sketch"; plane: PlaneSpec; entities: SketchEntity[]; constraints?: SketchConstraint[]; name?: string }
  | {
      id: string;
      type: "extrude";
      sketch: string;
      distance: Num;
      operation: "new" | "join" | "cut" | "intersect";
      // interior points of the chosen profile areas (sidecar resolves each to a
      // face, with holes, and unions them). `region` is the legacy single-area form.
      regions?: [number, number, number][];
      region?: [number, number, number];
    }
  | { id: string; type: "fillet"; edges: Selector | Selector[]; radius: Num }
  | { id: string; type: "chamfer"; edges: Selector | Selector[]; distance: Num }
  // Press/Pull a single solid face. `distance` is signed (the tool sets the sign
  // from the drag direction); `operation` is derived from the sign for the
  // timeline label. Planar faces extrude+boolean (boss/pocket); curved faces
  // offset the surface (e.g. resize a hole).
  | { id: string; type: "press-pull"; face: Selector; distance: Num; operation: "join" | "cut"; body?: string }
  | { id: string; type: "mirror"; plane: Plane3 }
  | { id: string; type: "revolve"; sketch: string; axis: Axis3; angle: Num }
  | { id: string; type: "loft"; sketches: string[] }
  // Sweep a closed profile sketch along an open path sketch (a line/arc/spline).
  | { id: string; type: "sweep"; profile: string; path: string; operation: "new" | "join" | "cut" }
  // A persistent construction/datum plane in the timeline. Carries no geometry;
  // sketches and splits reference it by id (resolved to its PlaneSpec on rebuild).
  // `plane` is the source reference and `offset` shifts along its normal (mm), so
  // the offset stays editable after creation; absent offset = coincident.
  | { id: string; type: "datumPlane"; plane: PlaneSpec; offset?: number; name?: string }
  // An imported body (STL/3MF/STEP/OBJ). The sewn/native solid is embedded as a
  // base64 BREP string so the document is self-contained and rebuilds
  // deterministically without the original file. `solid` is false for a
  // non-watertight mesh (a surface body — reference / section / sketch-over only).
  | {
      id: string;
      type: "import";
      format: "stl" | "3mf" | "step" | "obj" | "brep";
      name: string;
      brep: string;
      source?: string;
      solid?: boolean;
    }
  // Cut a body by a plane. keep=top/bottom keeps one side; keep=both splits it
  // into separate bodies. `body` targets a specific body (default: the active one);
  // `bodies` cuts every listed body (used for "cut all visible bodies"). The
  // cutting plane is either an inline `plane` or `planeId` (a datum plane by id).
  | { id: string; type: "split"; plane?: PlaneSpec; planeId?: string; keep: "top" | "bottom" | "both"; body?: string; bodies?: string[] }
  // Boolean-combine bodies. The target is modified in place; tool bodies are
  // consumed unless keepTools. Omitted target/tools default to "all bodies".
  | { id: string; type: "combine"; operation: "join" | "cut" | "intersect"; target?: string; tools?: string[]; keepTools?: boolean }
  // Primitive bodies (centered at the origin). Each creates a new body; edit the
  // dimensions in the inspector. Handy as boolean tool bodies for Combine.
  | { id: string; type: "box"; length: Num; width: Num; height: Num }
  | { id: string; type: "cylinder"; radius: Num; height: Num }
  | { id: string; type: "sphere"; radius: Num }
  // Hollow the active body to a wall thickness, removing the selected faces
  // (none = a fully closed hollow).
  | { id: string; type: "shell"; thickness: Num; faces?: Selector | Selector[] }
  // Taper the selected faces by an angle about a neutral plane (pull axis).
  | { id: string; type: "draft"; faces: Selector | Selector[]; angle: Num; axis: Axis3 }
  // Replicate the active body on a grid / around an axis (copies are unioned).
  | { id: string; type: "patternRect"; countX: Num; countY: Num; spacingX: Num; spacingY: Num }
  | { id: string; type: "patternCircular"; count: Num; angle: Num; axis: Axis3 }
  // Merge near-coplanar facets of an imported mesh (angular tolerance, degrees):
  // recovers planar faces / reduces facet count. Coarsens curved regions.
  | { id: string; type: "simplifyMesh"; tolerance: Num }
  // Scale the active body uniformly about the origin (factor; 1 = unchanged).
  | { id: string; type: "scale"; factor: Num }
  // Move the active body — or the bodies listed in `bodies` (multi-select) —:
  // translate (dx,dy,dz mm) + rotate (rx,ry,rz degrees, about origin).
  | { id: string; type: "move"; dx: Num; dy: Num; dz: Num; rx: Num; ry: Num; rz: Num; bodies?: string[] }
  // Remove bodies by id (Fusion "Remove"). Runs at its point in the timeline and
  // drops the listed bodies from the model — the way to delete a body from the
  // browser. Body ids are positional, so this is appended at the end.
  | { id: string; type: "removeBody"; bodies: string[] };

export type FeatureType = Feature["type"];

// A redefined ViewCube side: the model face the user mapped to a cube side. The
// stored face is oriented toward the camera when that side is clicked. `normal`
// faces out of the model surface; `up` is the in-view up direction (screen +Y).
export type ViewCubeSide =
  | "front"
  | "back"
  | "left"
  | "right"
  | "top"
  | "bottom";
export type ViewOverride = { normal: [number, number, number]; up: [number, number, number] };

export interface CadDocument {
  parameters: Params;
  features: Feature[];
  // optional per-side ViewCube redefinitions; persisted with the document.
  viewOverrides?: Partial<Record<ViewCubeSide, ViewOverride>>;
  // --- non-geometry project state, persisted so reopening fully restores the
  // session (the geometry rebuild ignores these; only parameters+features build).
  /** file-format version, for future migrations (current = 1). */
  version?: number;
  /** feature ids currently suppressed (skipped on rebuild). */
  suppressed?: string[];
  /** timeline rollback marker: count of active features; absent/null = all built. */
  rollback?: number | null;
  /** explicit per-sketch show/hide overrides (id → visible). */
  sketchVisibility?: Record<string, boolean>;
  /** explicit per-body show/hide overrides (body id → visible). */
  bodyVisibility?: Record<string, boolean>;
  /** explicit per-body display-name overrides (body id → name). Body ids are
   *  positional, so a rename re-attaches if an upstream feature is reordered. */
  bodyNames?: Record<string, string>;
  /** filament palette (≤4 slots for the U1 toolchanger); slot index → name+hex. */
  palette?: { name: string; color: string }[];
  /** per-body palette-slot assignment (body id → slot index into `palette`). */
  bodyColors?: Record<string, number>;
}

// Optional per-selector resolution diagnostic (selector v2). Lets a rebuild surface
// a low-confidence / best-effort match WITHOUT failing the build; downstream tooling
// (e.g. an importer deciding parametric-vs-captured) reads it. Code that ignores
// `diagnostics` behaves exactly as before.
export interface ResolveDiag {
  feature_id?: string;
  kind: "edge" | "face";
  resolved: number; // how many entities the selector matched
  confidence: number; // 0..1 — margin to the runner-up candidate (1 = lone clear winner)
  lossy: boolean; // a marginal / drift-path match was taken
  reason?: string;
}

export interface RebuildResult {
  mesh: { positions: number[]; indices: number[]; faceIds: number[] };
  edges: { id: string; points: [number, number, number][]; body?: string }[];
  bbox: { min: number[]; max: number[] };
  // per-body metadata: which faceId range each body occupies in the merged mesh
  // (lets the browser tree list bodies and picking map a face back to its body).
  bodies?: { id: string; name: string; faceStart: number; faceCount: number }[];
  // selector-resolution diagnostics, when any selector resolved with low confidence.
  diagnostics?: ResolveDiag[];
}

export type RebuildReply =
  | { ok: true; result: RebuildResult }
  | { ok: false; error: { feature_id?: string; message: string } };

export type ExportFormat = "step" | "stl" | "3mf";

// Import: the format the user picks, and the sidecar's reply for an `import` op —
// the embeddable BREP payload plus a little metadata for the new `import` feature.
export type ImportFormat = "stl" | "3mf" | "step" | "obj" | "brep";
export type ImportReply =
  | { ok: true; brep: string; name: string; solid: boolean; faces: number }
  | { ok: false; message: string };
