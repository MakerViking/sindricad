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

// The cached 2D shape of a "projected" entity (Fusion-style Project): plain
// numbers only (no Num) — the SIDECAR authors these, rounded to 6 decimals, and
// refreshes them when the source geometry changes. arc = 3 points like a native
// arc; poly is the sampled fallback (tilted circles, bsplines, silhouettes).
export type ProjectedCurve =
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "circle"; x: number; y: number; r: number }
  | { kind: "arc"; x1: number; y1: number; x2: number; y2: number; mx: number; my: number }
  | { kind: "poly"; pts: [number, number][] };

/** THE addressable end samples of a projected poly: its first and last points,
 *  collapsed to one entry when the poly is closed (first == last — sidecar
 *  coordinates are exact, so plain equality is the closure test). The solver,
 *  the dimension reference points, and the endpoint pickers all address a poly
 *  through this one rule (indices 0/1 map onto the returned order). */
export function projEndSamples(cv: Extract<ProjectedCurve, { kind: "poly" }>): [number, number][] {
  const first = cv.pts[0], last = cv.pts[cv.pts.length - 1];
  if (!first) return [];
  if (!last || (last[0] === first[0] && last[1] === first[1])) return [first];
  return [first, last];
}

// What a projected entity is linked TO. Bodies are re-found by fingerprint
// selector (by:"match" — the sidecar authors the fingerprint); sketch curves by
// stable ids (no fingerprint needed). A multi-curve pick (a face boundary, a
// rectangle) emits N sibling entities sharing `group` so Break Link / delete can
// act on the whole projection.
export type ProjectedSource =
  | { kind: "edge" | "faceBoundary"; body: string; sel: Selector; group?: string }
  // `index`: this sibling's edge index within the source entity's deterministic
  // edge list (multi-edge sources only) — the sidecar's authoritative refresh
  // correspondence, stable across sibling deletions and source moves.
  | { kind: "sketchCurve"; sketch: string; entity: string; group?: string; index?: number }
  | { kind: "silhouette"; body: string; group?: string };

// One rebuild-time projection refresh entry (sidecar _recompute_projections):
// either a recomputed curve that moved beyond tolerance (stale:false — also
// clears a previous stale flag), or a source that stopped resolving
// (stale:true, last shape kept). Steady state emits nothing — that convergence
// contract is what terminates the store's associative refresh loop.
export type ProjectionUpdate =
  | { sketch: string; entity: string; curve: ProjectedCurve; stale: false }
  | { sketch: string; entity: string; stale: true };

/** Apply one ProjectionUpdate to a projected entity, returning the patched
 *  copy: a stale entry sets the flag (last shape kept); a curve entry writes
 *  the fresh curve and DELETES the flag (omit-when-false discipline, byte
 *  stability). Shared by the store's doc commit and the open-sketch session
 *  patch so the two write paths can't drift. */
export function applyProjectionUpdate<E extends { curve: ProjectedCurve; stale?: true }>(
  e: E,
  u: ProjectionUpdate,
): E {
  const next = { ...e };
  if (u.stale) {
    next.stale = true;
  } else {
    next.curve = u.curve;
    delete next.stale;
  }
  return next;
}

// construction geometry is referenceable but does NOT form profiles.
// arc = 3 points: start (1), end (2), and a point it passes through (m).
// `id` is the stable identity that constraints reference (assigned on creation).
//
// `dimPlace` is where a BADGE dimension's user placement lives — see the LABEL
// PLACEMENT note below. Only the badge-bearing types carry it (the ones
// entityDims() returns a dimension for): rectangle W/H, circle diameter,
// polygon radius, slot length/width, line length.
export type SketchEntity =
  | { type: "rectangle"; id?: string; width: Num; height: Num; x?: Num; y?: Num; construction?: boolean; dimPlace?: DimPlace }
  | { type: "circle"; id?: string; radius: Num; x?: Num; y?: Num; construction?: boolean; dimPlace?: DimPlace }
  | { type: "line"; id?: string; x1: Num; y1: Num; x2: Num; y2: Num; construction?: boolean; dimPlace?: DimPlace }
  | { type: "arc"; id?: string; x1: Num; y1: Num; x2: Num; y2: Num; mx: Num; my: Num; construction?: boolean }
  // fit-point spline: interpolates a smooth curve through its points (≥2)
  | { type: "spline"; id?: string; points: { x: Num; y: Num }[]; construction?: boolean }
  // a sketch point: reference/snap geometry only — never forms a profile
  | { type: "point"; id?: string; x: Num; y: Num; construction?: boolean }
  // parametric shapes: rigid regular polygon (center/radius/sides + first-vertex
  // angle, DEGREES — like every other angle field; pre-v2 files stored radians
  // and are migrated on load) and center-to-center slot (two arc centers +
  // width). The solver treats them as fixed; they're edited via their own
  // parameter dimensions.
  | { type: "polygon"; id?: string; x: Num; y: Num; radius: Num; sides: Num; angle: Num; construction?: boolean; dimPlace?: DimPlace }
  | { type: "slot"; id?: string; x1: Num; y1: Num; x2: Num; y2: Num; width: Num; construction?: boolean; dimPlace?: DimPlace }
  // Fusion-parity text: filled glyph faces from a system font; extrudes like any profile
  | { type: "text"; id?: string; text: string; x?: Num; y?: Num; height: Num;
      font?: string; style?: "regular" | "bold" | "italic" | "bolditalic";
      align?: "left" | "center" | "right"; angle?: Num;
      pathRef?: string; positionOnPath?: Num; boxWidth?: Num; construction?: boolean }
  // linked, FIXED reference geometry projected from existing 3D/2D geometry
  // (see ProjectedCurve/ProjectedSource). The solver pins it, modify tools
  // refuse it (Break Link converts it to native). `stale?: true` marks a source
  // that no longer resolves (last shape kept) — omitted when false (byte
  // stability, like every persisted flag).
  | { type: "projected"; id?: string; source: ProjectedSource; curve: ProjectedCurve; stale?: true; construction?: boolean };

// 2D sketch constraints, solved by planegcs. Entities are referenced by their
// stable id (see sketch/id.ts) — never array index — so edit operations that
// reorder/split entities can't repoint a constraint. distance/diameter carry a
// driving value in mm.
//
// LINE OPERAND IDS: a field that names a *line* (`line`, `l1`, `l2`) accepts
// either a plain entity id, or the compound form `"<rectangleId>~<k>"` naming
// one edge of a rectangle — k = 0..3 in rectCorners CCW order (bl→br, br→tr,
// tr→tl, tl→bl). The solver registers those 4 implicit edges already
// (sketchSolve's rectangle branch), so a rect edge is a first-class line
// operand for distance/angle/perpendicular-distance dims. Note the asymmetry:
// the constraint that NAMES such an edge is still an ordinary user constraint
// with the ordinary `k<i>` solver id — only the operand id contains `~`
// (`constraintIndexOf` decodes any `~` id to null, which is why the implicit
// ids can never be blamed for a conflict). Anything that validates a line
// operand must decode the compound form; in the sketcher that is
// entityDims.lineOperand and SketchMode.pruneConstraints.
//
// LABEL PLACEMENT: a dimension's label position is user-adjustable — dragging a
// label in the sketch persists where it went. Placement is stored in sketch MM
// as an offset from the dim's own natural anchor, and it lives in ONE of two
// places depending on which renderer owns the label:
//
//   * constraint-rendered dims (p2pDistance/p2lDistance/radius/angle and the rim
//     family radialGap/c2cDistance/c2lDistance/p2cDistance) carry `place` on the
//     CONSTRAINT — set by the dimension tool's placement click or by a label
//     drag, honoured by entityDims.constraintDims.
//   * badge dims (rectangle W/H, circle diameter, polygon radius, slot L/W, line
//     length) have no backing constraint in the general case — a circle shows a
//     diameter badge whether or not a `diameter` constraint exists — so their
//     placement lives on the ENTITY, in `dimPlace`, keyed by DimField, and is
//     honoured by entityDims(). (That's why `distance`/`diameter` constraints
//     still carry no `place`: their label is the entity's badge.)
//
// What the offset MEANS is per dimension kind, and each renderer documents its
// own rule: free 2D for a circle diameter (the vector sets the diameter line's
// angle AND the label's distance along it), perpendicular-only for the linear
// dims, radial-only for a polygon radius.
export type PlaceOffset = { ox: number; oy: number };

/** the dimension a badge labels on its entity — the single definition;
 *  sketch/entityDims re-exports it as the name the sketcher uses. */
export type DimField = "width" | "height" | "diameter" | "length" | "radius";
/** per-entity badge label placements, keyed by which dimension they place */
export type DimPlace = Partial<Record<DimField, PlaceOffset>>;

/** Read an entity's badge label placements — safe on any entity (the ones that
 *  can't carry placements simply never have any).
 *
 *  Use this, NOT `"dimPlace" in e`: the field is OPTIONAL, so an entity whose
 *  labels have never been dragged has no such key at all, and the `in` idiom
 *  (which TypeScript happily accepts as narrowing) reports false for every
 *  fresh entity — placements would never be read, written, or persisted. */
export const dimPlaceOf = (e: { type: string }): DimPlace | undefined =>
  (e as { dimPlace?: DimPlace }).dimPlace;

/** The entity types that CARRY `dimPlace` — exactly the ones entityDims() gives
 *  a badge. The write-side guard (reading is safe on anything, see dimPlaceOf). */
export function isBadgeEntity<T extends { type: string }>(e: T): e is T & { dimPlace?: DimPlace } {
  switch (e.type) {
    case "rectangle": case "circle": case "line": case "polygon": case "slot":
      return true;
    default:
      return false;
  }
}

export type SketchConstraint =
  | { type: "horizontal"; line: string }
  | { type: "vertical"; line: string }
  | { type: "parallel"; l1: string; l2: string }
  | { type: "perpendicular"; l1: string; l2: string }
  | { type: "equal"; l1: string; l2: string }
  // A driven (reference) dimension is measurement-only: the solver ignores it and
  // it renders bracketed with the live measured value (see `isDriven`). Only the
  // *placed* dims (p2pDistance/p2lDistance/radius/angle) carry `driven?` — a line's
  // length and a circle's diameter always show their measurement via the entity's
  // own length/diameter badge, so reference mode doesn't apply to them.
  //
  // The value-bearing dims carry `id?` (see sketch/id.ts, "c" prefix): the stable
  // identity a parameter binding (ParamTarget) references — dims are otherwise
  // index-referenced, and edit operations splice the constraint array.
  | { type: "distance"; id?: string; line: string; value: number }
  | { type: "diameter"; id?: string; circle: string; value: number }
  // p2pDistance: driving distance between two picked points. `p*` selects the
  // point on each entity: 0/1 = start/end (lines, arcs, spline ends), 0..3 =
  // rectangle corner (rectCorners CCW order), 2 = arc center; a circle always
  // resolves to its center. Point entities ignore the index.
  | { type: "p2pDistance"; id?: string; e1: string; p1: number; e2: string; p2: number; value: number; driven?: boolean; place?: PlaceOffset }
  // p2lDistance: driving perpendicular distance from a picked point to a line
  // operand (same `p` semantics as p2pDistance; `line` may be a rect edge)
  | { type: "p2lDistance"; id?: string; e: string; p: number; line: string; value: number; driven?: boolean; place?: PlaceOffset }
  // --- EDGE-TO-EDGE (rim / tangent) dims ------------------------------------
  // Fusion's "Pick Circle/Arc Tangent" family: the distance to a circle/arc's
  // RIM rather than to its centre. Each maps to exactly one planegcs constraint
  // (no composite ids). Operands are circle/arc entity ids (native or projected).
  //
  // radialGap: wall thickness between two CONCENTRIC rounds — `outer.radius -
  // inner.radius = value`, SIGNED (planegcs `difference`, which touches only the
  // two radius params). The inner/outer roles are frozen at creation, which is
  // what stops the annulus solving inside-out. It is the radial gap only while
  // the two really are concentric, so the tool adds/expects a `concentric`
  // constraint alongside it (mirroring how a parallel-lines distance implies
  // `parallel`).
  | { type: "radialGap"; id?: string; inner: string; outer: string; value: number; driven?: boolean; place?: PlaceOffset }
  // c2cDistance: minimum edge-to-edge clearance between two non-concentric
  // rounds (planegcs `c2cdistance`). See entityDims.rimGap for the exact
  // (two-branch) measure and sketchSolve's solve guard for the branch invariant.
  | { type: "c2cDistance"; id?: string; c1: string; c2: string; value: number; driven?: boolean; place?: PlaceOffset }
  // c2lDistance: distance from a round's rim to a line operand (`line` may be a
  // rect edge), planegcs `c2ldistance`.
  | { type: "c2lDistance"; id?: string; circle: string; line: string; value: number; driven?: boolean; place?: PlaceOffset }
  // p2cDistance: distance from a picked point (same `p` semantics as
  // p2pDistance) to a round's rim, planegcs `p2cdistance`.
  | { type: "p2cDistance"; id?: string; e: string; p: number; circle: string; value: number; driven?: boolean; place?: PlaceOffset }
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
  | { type: "symmetric"; e1: string; p1: number; e2: string; p2: number; line: string }
  // angle: driving included angle (DEGREES) between two lines (solver works in radians)
  | { type: "angle"; id?: string; l1: string; l2: string; value: number; driven?: boolean; place?: PlaceOffset }
  // radius: driving radius (mm) of a circle OR arc entity `e`
  | { type: "radius"; id?: string; e: string; value: number; driven?: boolean; place?: PlaceOffset }
  // fix/lock: pin an entity point in place. `p` uses the dimPoint semantics
  // (0..3 = rect corner, circle center regardless of index, 2 = arc center,
  // else line/arc/spline endpoint). Fully removes that point's 2 DOF.
  | { type: "fix"; e: string; p: number }
  // collinear: two lines share one infinite axis (parallel + endpoint-on-line)
  | { type: "collinear"; l1: string; l2: string }
  // equalRadius: two circles/arcs (in any mix) share a radius
  | { type: "equalRadius"; a: string; b: string }
  // tangent2: general tangency between two curves (line/circle/arc, not line+line).
  // The older { type:"tangent"; line; circle } form is still accepted (old files).
  | { type: "tangent2"; a: string; b: string };

/** A driven (reference) dimension is measurement-only: the solver skips it and it
 *  renders bracketed with the live measured value. The single place that names the
 *  concept — only the placed dims (p2pDistance/p2lDistance/radius/angle and the
 *  rim family) can be driven. */
export function isDriven(c: SketchConstraint): boolean {
  return (c as { driven?: boolean }).driven === true;
}

/** THE list of dimension types that carry `driven` + `place` (the ones the
 *  dimension tool places and constraintDims renders). One predicate so the
 *  Reference toggle, the label editor and the renderer can't drift apart. */
export function isPlacedDim(
  c: SketchConstraint,
): c is Extract<SketchConstraint, { driven?: boolean }> {
  switch (c.type) {
    case "p2pDistance": case "p2lDistance": case "radius": case "angle":
    case "radialGap": case "c2cDistance": case "c2lDistance": case "p2cDistance":
      return true;
    default:
      return false;
  }
}

// A parametric pattern inside a sketch. Stored as a DEFINITION (sources + params)
// and expanded to derived entities at build/render time, so it stays editable
// (associative — change the count/spacing later). `sources` references entity ids.
// Derived entities get ids "<pattern.id>#<n>": render/build-only, so constraints
// and dimensions never target them (you dimension the source, like mainstream MCAD).
export type SketchPattern =
  // replicate the `sources` entities on a grid (skips the original instance)
  | { id: string; type: "patternRect"; sources: string[]; countX: Num; countY: Num; spacingX: Num; spacingY: Num }
  // replicate the `sources` entities around a center (cx,cy) over `angle` degrees
  | { id: string; type: "patternCircular"; sources: string[]; cx: Num; cy: Num; count: Num; angle: Num }
  // prebuilt hole generators — self-contained, emit circles at computed positions
  | { id: string; type: "hexHoles"; cx: Num; cy: Num; diameter: Num; spacing: Num; rings: Num }
  // honeycomb: hexagon OUTLINES tiled in a hex grid (each cell is a 6-line hexagon)
  | { id: string; type: "honeycomb"; cx: Num; cy: Num; diameter: Num; spacing: Num; rings: Num }
  | { id: string; type: "boltCircle"; cx: Num; cy: Num; bcd: Num; count: Num; diameter: Num }
  | { id: string; type: "gridHoles"; cx: Num; cy: Num; diameter: Num; countX: Num; countY: Num; spacingX: Num; spacingY: Num };

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
  | { id: string; type: "sketch"; plane: PlaneSpec; entities: SketchEntity[]; constraints?: SketchConstraint[]; patterns?: SketchPattern[]; name?: string }
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
      // Boolean participants are decided at CREATION, MCAD-style: the bodies
      // hidden when the user made this extrude are stored here and excluded
      // from its join/cut forever after — later eye toggles are pure display
      // and can never rewrite geometry history. Absent = legacy feature: the
      // builder falls back to the document's LIVE visibility map (old files
      // keep their exact behavior until re-saved through load-stamping).
      hiddenBodies?: string[];
    }
  | { id: string; type: "fillet"; edges: Selector | Selector[]; radius: Num }
  | { id: string; type: "chamfer"; edges: Selector | Selector[]; distance: Num }
  // Press/Pull one or more solid faces. `distance` is signed (the tool sets the
  // sign from the drag direction); `operation` is derived from the sign for the
  // timeline label. Planar faces extrude+boolean (boss/pocket); curved faces
  // offset the surface (e.g. resize a hole). With several faces, each is pushed by
  // the same `distance` along its own normal. `upTo` (a target face selector), when
  // set, extrudes each face up to that surface instead of by `distance`.
  | { id: string; type: "press-pull"; face: Selector | Selector[]; distance: Num; operation: "join" | "cut"; body?: string; upTo?: Selector }
  | { id: string; type: "deleteFace"; face: Selector | Selector[]; body?: string }
  | { id: string; type: "mirror"; plane: Plane3 }
  // `operation` is threaded through the same New/Join/Cut/Intersect boolean as
  // extrude (`_boolean_into_bodies`); absent = legacy feature, defaults to "new"
  // in the builder (old behavior was a silent overwrite of the active body's
  // shape — this is the data-loss bug the field fixes, so old docs now get a
  // separate body instead, not a resurrected overwrite).
  | { id: string; type: "revolve"; sketch: string; axis: Axis3; angle: Num; operation?: "new" | "join" | "cut" | "intersect" }
  // Loft blends through 2+ profiles in order. `profiles` (Fusion flow) lofts the
  // SELECTED profile regions across sketches — each carries its sketch id + a 3D
  // interior anchor (a ring keeps its hole → a tube). `sketches` is the legacy
  // whole-un-consumed-sketch fallback (ribbon). One of the two is present.
  | { id: string; type: "loft"; profiles?: { sketch: string; region: [number, number, number] }[]; sketches?: string[]; operation?: "new" | "join" | "cut" | "intersect" }
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
      // explode:false keeps a multi-solid payload as ONE body (large imported
      // assemblies: divides body count by solids-per-import). Absent/true =
      // historical one-body-per-solid behavior.
      explode?: boolean;
    }
  // Cut a body by a plane. keep=top/bottom keeps one side; keep=both splits it
  // into separate bodies. `body` targets a specific body (default: the active one);
  // `bodies` cuts every listed body (used for "cut all visible bodies"). The
  // cutting plane is either an inline `plane` or `planeId` (a datum plane by id).
  | { id: string; type: "split"; plane?: PlaneSpec; planeId?: string; keep: "top" | "bottom" | "both"; body?: string; bodies?: string[]; groupSides?: boolean }
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
  // Repair boolean rot on a body — or all bodies when `body` is omitted: unify
  // glued/overlapping solids left by joins of ragged imports, then collapse
  // facet debris (slivers, near-coplanar staircases). Parametric because
  // downstream booleans re-manufacture debris; best-effort in the sidecar (a
  // body it can't confidently clean passes through unchanged).
  | { id: string; type: "cleanUp"; body?: string; tolerance?: Num }
  // Remove bodies by id (mainstream MCAD "Remove"). Runs at its point in the timeline and
  // drops the listed bodies from the model — the way to delete a body from the
  // browser. Body ids are positional, so this is appended at the end.
  | { id: string; type: "removeBody"; bodies: string[] }
  // Printed surface texture: real mesh displacement (not appearance-only), computed
  // by the sidecar at tessellation time. `faces` absent = whole body (then `body`
  // names the target, required); present = the operated face set (mirrors
  // shell/draft's `faces`, not press-pull's singular `face`).
  | {
      id: string;
      type: "texture";
      kind: "knurl" | "hex" | "waves" | "ribs" | "voronoi" | "noise" | "image";
      faces?: Selector | Selector[];
      body?: string; // required when faces is absent; optional disambiguator otherwise
      depth: Num; // mm, displacement magnitude
      scale: Num; // mm, pattern period / cell size
      angle?: Num; // degrees — orientation (waves/ribs vertical vs diagonal; knurl/hex lattice rotation)
      offset?: Num; // mm, phase shift (advanced)
      sharpness?: Num; // 0..1, edge crispness (knurl/hex/waves/ribs)
      direction?: "out" | "in" | "both"; // procedural kinds: emboss/deboss/symmetric (default "out")
      seed?: Num; // voronoi/noise
      invert?: boolean; // image kind: emboss vs deboss sample reading
      imagePath?: string; // image kind: absolute path, sidecar reads by path (like import's brep flow)
      colorSlot?: Num; // palette slot the textured faces print in (two-tone inlay); absent = body's own color
    };

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

// --- parameters/equations engine (frontend-only; the sidecar sees numbers) ---

/** Canonical unit kind of a parameter: lengths are mm, angles degrees, counts raw. */
export type ParamUnit = "mm" | "deg" | "count";

/** Where a MODEL parameter's evaluated value is written. All ids are the existing
 *  stable ids (feature.id, entity.id, pattern.id, constraint.id) — never indices.
 *  Entity targets are only used for solver-rigid shapes (polygon/slot/text);
 *  solved geometry is driven through a dimension constraint instead. */
export type ParamTarget =
  | { kind: "feature"; feature: string; field: string }
  | { kind: "constraint"; sketch: string; constraint: string }
  | { kind: "entity"; sketch: string; entity: string; field: string }
  | { kind: "pattern"; sketch: string; pattern: string; field: string };

/** One row of the parameter table. `expr` is the source of truth; `value` is the
 *  cached evaluation result in canonical units and is ALWAYS present, so a build
 *  (and any pre-expression reader) can run without evaluating anything. */
export interface ParamDef {
  expr: string;
  value: number;
  unit: ParamUnit;
  comment?: string;
  /** present = model parameter (dN, drives one field); absent = user parameter. */
  target?: ParamTarget;
  /** RESERVED (unimplemented): driven-dim params are geometry→value sources. */
  driven?: boolean;
}

export interface CadDocument {
  parameters: Params;
  /** Parameter table (source of truth for expressions). `parameters` is the
   *  derived name→value cache regenerated from this on save/send, so the sidecar
   *  and pre-v2 readers keep working off plain numbers. Absent = legacy doc. */
  paramDefs?: Record<string, ParamDef>;
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
  /** explicit per-construction-plane show/hide overrides (datum feature id → visible). */
  planeVisibility?: Record<string, boolean>;
  /** explicit per-body display-name overrides (body id → name). Body ids are
   *  positional, so a rename re-attaches if an upstream feature is reordered. */
  bodyNames?: Record<string, string>;
  /** filament palette (≤4 slots for the U1 toolchanger); slot index → name+hex,
   *  plus an optional material type (e.g. "PLA") when synced from the printer. */
  palette?: { name: string; color: string; material?: string }[];
  /** per-body palette-slot assignment (body id → slot index into `palette`). */
  bodyColors?: Record<string, number>;
}

// Optional per-selector resolution diagnostic (selector v2). Lets a rebuild surface
// a low-confidence / best-effort match WITHOUT failing the build; downstream tooling
// (e.g. an importer deciding parametric-vs-captured) reads it. Code that ignores
// `diagnostics` behaves exactly as before.
export interface ResolveDiag {
  feature_id?: string;
  // "combine" = a dangling-reference combine skipped (no-op);
  // "edgeOpFailed" = a fillet/chamfer failed and `failed` names the edges the
  // sidecar's per-edge probe blamed (or ALL members when only the combination
  // fails), so the UI can paint exactly those edges red.
  kind: "edge" | "face" | "combine" | "edgeOpFailed";
  resolved: number; // how many entities matched (0 for a skipped combine)
  confidence: number; // 0..1 — margin to the runner-up candidate (1 = lone clear winner)
  lossy: boolean; // a marginal / drift-path match was taken (or a feature was skipped)
  reason?: string;
  failed?: { mid: [number, number, number] }[]; // edgeOpFailed only: failed edges' midpoints
}

// Mesh wire arrays arrive either as plain JSON number arrays (text replies,
// the Rust in-process backend) or as typed-array views over a binary WS frame
// — every consumer only indexes / reads .length, valid on both members.
export type F32Wire = number[] | Float32Array;
export type U32Wire = number[] | Uint32Array;

export interface RebuildResult {
  mesh: { positions: F32Wire; indices: U32Wire; faceIds: U32Wire; normals?: F32Wire };
  edges: { id: string; points: [number, number, number][]; body?: string }[];
  bbox: { min: Vec3; max: Vec3 };
  // per-body metadata: which faceId range each body occupies in the merged mesh
  // (lets the browser tree list bodies and picking map a face back to its body).
  // `etag` (when the backend supplies one) is a content fingerprint the render
  // layer diffs to decide whether a body needs rebuilding at all — absent means
  // "always rebuild" (e.g. the in-process Rust backend, which has no etag cache).
  bodies?: { id: string; name: string; faceStart: number; faceCount: number; faceOwners?: (string | null)[]; textureColorSlots?: (number | null)[]; etag?: string }[];
  // selector-resolution diagnostics, when any selector resolved with low confidence.
  diagnostics?: ResolveDiag[];
  // set when features failed but the rest of the timeline still built — the
  // mesh above is everything EXCEPT the failed features' effects. featureError
  // is the LAST (most downstream) failure — the one closest to the user's
  // latest action; featureErrors lists them all, timeline order. The reply is
  // still ok:true so the model renders alongside the error banner.
  featureError?: { feature_id?: string; message: string };
  featureErrors?: { feature_id?: string; message: string }[];
  // projected-curve refresh entries from this rebuild (absent at steady state);
  // the store lands them via a derived, no-undo commit — see
  // DocumentStore.commitProjectionRefresh.
  projectionUpdates?: ProjectionUpdate[];
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
