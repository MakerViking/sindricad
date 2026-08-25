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
  // Position within a group of circles sharing a centre: rank is the index in
  // ascending-radius order, group is how many share that centre. THIS PAIR IS
  // WHAT MAKES A CONCENTRIC REFERENCE SURVIVE A SCALE CHANGE — with it, a tube's
  // outer rim stays the outer rim; without it the match falls back to absolute
  // radius and lands on the inner one. The sidecar has always authored them;
  // they were simply never declared, and they survived only because the reply
  // object is passed through by reference. Reconstruct a fingerprint field by
  // field against the old type and TypeScript silently hides both, downgrading
  // the reference with no error anywhere.
  radius_rank?: number;
  radius_group?: number;
}
export interface FaceFingerprint {
  centroid: Vec3; // area centroid, world mm
  normal: Vec3; // unit outward normal at the centroid (oriented)
  area?: number; // mm^2
  surface?: "plane" | "cylinder" | "cone" | "sphere" | "torus" | "bspline" | "other";
  radius?: number; // cylinder/sphere/cone radius, mm
}

/** Which body a selector resolves against. The tools stamp this from the edge
 *  or face the user actually clicked; the sidecar groups a feature's selectors
 *  by it (`_group_sels_by_body`) so a fillet/chamfer/shell/draft only ever
 *  reshapes bodies the selection touched — one feature may span several.
 *
 *  ABSENT = the active (last-created) body. That is the pre-binding behaviour
 *  and is kept purely so documents saved before the tools stamped bodies still
 *  build; it is exactly the fallback that let a `by:"nearest"` pick silently
 *  edit the wrong body on a multi-body model. Never omit it on a fresh pick. */
type SelectorBody = { body?: string };

export type Selector = (
  | { kind: "edge"; by: "axis"; axis: "X" | "Y" | "Z" }
  | { kind: "edge"; by: "nearest"; point: [number, number, number] }
  | { kind: "edge"; by: "all" }
  // Both backends have always implemented this; only the type omitted it.
  | { kind: "face"; by: "all" }
  | { kind: "face"; by: "normal"; dir: [number, number, number] }
  | { kind: "face"; by: "nearest"; point: [number, number, number] }
  // --- v2: discriminating, drift-robust selection ---
  // `match` re-finds ONE entity by scored geometric fingerprint; `nth` breaks a
  // genuine tie (symmetric twins) by a rebuild-stable canonical order.
  | { kind: "edge"; by: "match"; fp: EdgeFingerprint; nth?: number }
  | { kind: "face"; by: "match"; fp: FaceFingerprint; nth?: number }
  // structural forms — encode intent instead of N independent point-picks:
  | { kind: "edge"; by: "tangentChain"; seed: EdgeFingerprint } // an edge + its tangent-continuous chain
  | { kind: "edge"; by: "ofFace"; face: FaceFingerprint } // all edges bounding a face
) &
  SelectorBody;

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
  // `p1`/`p2` are the point index — 0 = start, 1 = end on a line/arc/spline, and
  // 0..3 for a RECTANGLE CORNER (rectCorners CCW order), the same `p` semantics
  // p2pDistance and `fix` use. One convention for a corner, in every constraint
  // that names a point: sketchSolve's endpointPoint and dimPoint both resolve it.
  | { type: "coincident"; e1: string; p1: number; e2: string; p2: number }
  // concentric: two circles/arcs share a center
  | { type: "concentric"; c1: string; c2: string }
  // midpoint: a point (`e`/`p`, same semantics as coincident) sits at the
  // midpoint of a line operand (`line` may be a rect edge)
  | { type: "midpoint"; e: string; p: number; line: string }
  // symmetric: two points (same semantics as coincident) mirror across a line
  // operand (the symmetry axis; may be a rect edge)
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
  | { type: "tangent2"; a: string; b: string }
  // --- OFFSET ----------------------------------------------------------------
  // The associative link the Offset tool creates: ONE constraint for the whole
  // operation, holding every source→copy pair it produced, governed by a SINGLE
  // editable distance. That's the Fusion behaviour — offsetting a 4-line
  // rectangle gives you one dimension, not four — and it's why this is a
  // composite rather than N independent dims the user would have to keep in sync.
  //
  // It needs no new planegcs primitive. Each pair expands (with the `k<i>a`
  // sub-id suffix convention that midpoint/collinear already use) into:
  //   line ↔ line   → parallel + ONE p2l_distance from a copy endpoint to the
  //                   source line (parallel makes the second endpoint's
  //                   distance follow, so pinning it too is pure redundancy)
  //   rect edge     → ONE p2l_distance, no parallel: the rectangle's implicit
  //                   horizontal/vertical constraints already lock direction
  //   round ↔ round → centre coincident + radiusDifference (the signed
  //                   `difference` primitive radialGap uses)
  //
  // `value` is SIGNED: the sign is the side the copy sits on. planegcs's
  // p2l_distance is unsigned, so the side is held by rimBranch's pre/post-solve
  // comparison in sketchSolve, exactly as it holds an annulus from inverting.
  //
  // DOF note: a closed chain is exactly determined (its corner coincidences take
  // up the slack — a 4-line square lands on zero remaining DOF), but a LONE
  // offset line keeps 2 DOF (both endpoints still slide along it) and a lone
  // offset arc keeps its sweep free. That is real under-constraint and the
  // sketch reports it as such — not a silent failure.
  | { type: "offset"; id?: string; pairs: { src: string; cpy: string }[]; value: number; driven?: boolean; place?: PlaceOffset };

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
    case "offset":
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
  // `planeId` (optional) is a by-id reference to a datumPlane feature, and takes
  // precedence over `plane` on rebuild. It follows the `split` precedent rather
  // than overloading `plane` with ids, because SketchPlane's string branch has
  // no default: an unrecognised id there would silently render as XY at the
  // world origin. `plane` stays populated with the RESOLVED placement as a
  // cache, so every frontend consumer keeps working without resolving datums —
  // and an older build opening the file still places the sketch correctly.
  // This is what makes an offset plane's distance stay editable after creation.
  | { id: string; type: "sketch"; plane: PlaneSpec; planeId?: string; entities: SketchEntity[]; constraints?: SketchConstraint[]; patterns?: SketchPattern[]; name?: string }
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
      // The sketch entities bounding each entry in `regions`, in the same order.
      // A point does not survive the geometry moving: drag the circle you extruded
      // and the stored point stays behind, lands inside the profile that now covers
      // it, and THAT is extruded instead — silently, because containment succeeds
      // (field report a20cca53). The ids do survive, so the sidecar re-derives the
      // anchor from them and only falls back to the point when they cannot name one
      // profile on their own (two halves of a split square share an entity set).
      // Absent on documents written before this existed; those keep point-only
      // behaviour exactly.
      regionEntities?: string[][];
      // Entities bounding each selected region's HOLE loops, parallel to
      // `regionEntities`. Without them the outer loop alone rebuilds a SOLID
      // face whose centre sits inside the hole, and both halves of the app then
      // resolve that to the wrong cell (field 19314fdc, the shell wall that
      // extrudes as its inner loop). The sidecar CUTS these out of the rebuilt
      // face; the edit tool uses them to tell apart two regions that share an
      // outer loop.
      //
      // Absent on documents written before this field existed. An entry of `[]`
      // reads the SAME as absent, not as "this region has no holes": the sidecar
      // iterates `hole_eids or []`, so both mean "no holes named here", and both
      // leave the outer loop rebuilding solid. `[]` is also what a text profile
      // records, because glyph regions arrive pre-formed from the font
      // tessellation and their holes carry no entity ids to name (the 'o' of a
      // sketch text). So an entry of `[]` is a claim about what was RECORDED,
      // never a claim that the profile is solid, and neither half may read it as
      // one. An empty GROUP inside a non-empty entry is different again and the
      // sidecar refuses the whole anchor on it (`if not grp: return None`).
      regionHoleEntities?: string[][][];
      // --- start and end conditions (issue #41, field report ffab4ece) --------
      // The SAME vocabulary press-pull uses, resolved by the same sidecar helper
      // (`_up_to_target`), so the two operations cannot drift apart on any of the
      // refusals it enforces.
      //
      // `upTo` names a face to stop at, `upToPlane` a datumPlane feature id or
      // "XY"/"XZ"/"YZ". Setting BOTH is invalid and the sidecar refuses it. With
      // either one set, `distance` is NOT READ — the target decides how far — so
      // a distance of 0 is legal here, unlike a plain extrude.
      //
      // A target is reproduced as the new end FACE, not approximated by a single
      // sweep to its centre distance: a target tilted to the sketch would
      // otherwise give a flat top, right along the centre line and silently
      // wrong everywhere else.
      upTo?: Selector;
      upToPlane?: string;
      // Shifts the landing ALONG THE EXTRUDE DIRECTION — positive past the
      // target, negative short of it. Only means something with a target; the
      // sidecar refuses it otherwise rather than reading the number and throwing
      // it away.
      upToOffset?: Num;
      // Lifts the profile off its sketch plane BEFORE the sweep, along the same
      // direction the sweep runs — the "start the extrude at an offset" half of
      // the pair. Independent of the end condition: with both set the solid spans
      // startOffset..target, not 0..target.
      startOffset?: Num;
      // Sloped walls, in DEGREES (issue #41's "nice to have"). Positive narrows
      // away from the sketch, negative widens — a draft angle for a moulded or
      // printed part. Only applies to a plain distance extrude: with an `upTo`
      // target the end face is the target plane, and a taper would fight it.
      //
      // The sidecar PROBES this in a throwaway process before building it. That
      // is not caution for its own sake: the same OCCT path has been measured
      // hanging for 600 s while holding the GIL, and returning silently corrupt
      // solids (volume 0.0 with IsValid() false, and negative volumes) that only
      // BRepCheck catches. A refused taper is reported, never quietly dropped.
      taper?: Num;
      // Boolean participants are decided at CREATION, MCAD-style: the bodies
      // hidden when the user made this extrude are stored here and excluded
      // from its join/cut forever after — later eye toggles are pure display
      // and can never rewrite geometry history. Absent = legacy feature: the
      // builder falls back to the document's LIVE visibility map (old files
      // keep their exact behavior until re-saved through load-stamping).
      hiddenBodies?: string[];
      // One body per CONNECTED lump instead of one body for the whole extrude:
      // four separated slices of a ring become four bodies you can colour and
      // move independently, which is what mainstream MCAD does. Connectivity is
      // the KERNEL's answer, so two selected areas that share an edge still come
      // back as ONE body.
      //
      // OPT-IN, and it has to stay that way. Body ids are POSITIONAL (`body1`,
      // `body2`, … from a counter), so turning one body into four renumbers
      // every body after it and silently re-aims any saved `body:"bodyN"`
      // selector on a fillet, shell or press/pull. Absent = legacy feature,
      // rebuilt exactly as before; the tool stamps it on NEW extrudes only, and
      // an edit preserves whatever the feature already had. Same discipline as
      // `hiddenBodies` above.
      separateBodies?: boolean;
    }
  | { id: string; type: "fillet"; edges: Selector | Selector[]; radius: Num }
  | { id: string; type: "chamfer"; edges: Selector | Selector[]; distance: Num }
  // Press/Pull one or more solid faces. `distance` is signed (the tool sets the
  // sign from the drag direction); `operation` is derived from the sign for the
  // timeline label. Planar faces extrude+boolean (boss/pocket); curved faces
  // offset the surface (e.g. resize a hole). With several faces, each is pushed by
  // the same `distance` along its own normal. `upTo` (a target face selector), when
  // set, extrudes each face up to that surface instead of by `distance`.
  //
  // `upToPlane` names a DATUM as that target instead: a datumPlane feature id, or
  // one of the base plane ids "XY"/"XZ"/"YZ". It is deliberately NOT a Selector —
  // Selector is the topology-fingerprint vocabulary and a datum has no topology to
  // fingerprint — so it follows the same by-id shape `sketch.planeId` and
  // `split.planeId` already use. Setting BOTH `upTo` and `upToPlane` is invalid:
  // the tool clears one when it sets the other and the sidecar REFUSES a feature
  // carrying both rather than silently picking one.
  //
  // `upToOffset` shifts where the extrude stops. It is measured ALONG THE EXTRUDE
  // DIRECTION (the source face normal), NOT along the target's normal: positive =
  // past the target, negative = stop short. It applies to a face target and a
  // plane target alike.
  | { id: string; type: "press-pull"; face: Selector | Selector[]; distance: Num; operation: "join" | "cut"; body?: string; upTo?: Selector; upToPlane?: string; upToOffset?: Num }
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
  // An imported body (STL/3MF/STEP/OBJ/GLB). The sewn/native solid is embedded as
  // a base64 BREP string so the document is self-contained and rebuilds
  // deterministically without the original file. `solid` is false for a
  // non-watertight mesh (a surface body — reference / section / sketch-over only).
  | {
      id: string;
      type: "import";
      format: "stl" | "3mf" | "step" | "obj" | "brep" | "glb";
      name: string;
      // Content hash of this body's geometry in the durable blob store, carried
      // inside the `.sindri` container. Replaced an inline base64 ASCII BREP:
      // on the 356 MiB reference assembly that field alone was 541.8 MiB, which
      // is why a large assembly could not be opened at all.
      geom?: string;
      // The pre-v5 inline payload. Still READ so every document saved before the
      // container format keeps opening; never written any more. Exactly one of
      // `geom` / `brep` is present in practice.
      brep?: string;
      source?: string;
      solid?: boolean;
      // The dominant material colour the source file carried ('#RRGGBB'), when it
      // had one — glTF only today. Provenance, not the live body colour: the body
      // is coloured by its palette SLOT (bodyColors), which this seeds via a
      // nearest-slot match at import. Kept so the match can be redone if the
      // palette changes. Omitted, never null, when the file carried no colour.
      color?: string;
      // explode:false keeps a multi-solid payload as ONE body (large imported
      // assemblies: divides body count by solids-per-import). Absent/true =
      // historical one-body-per-solid behavior.
      explode?: boolean;
      // The XCAF assembly tree, when the imported STEP carried one. Both are
      // absent for every other import and for every document saved before this
      // existed, which is what keeps those rebuilding byte-identically.
      //
      // `nodes` is the product tree in pre-order; `parent` indexes back into it
      // and is null at a root. A subassembly instanced twice appears as two
      // nodes, so the occurrences stay independently selectable.
      //
      // `parts` has ONE row per body, in body order: row i binds to top-level
      // child i of `brep`, which is a FLAT compound of world-placed leaves.
      // `faces` is a checksum on that ordinal binding — the sidecar refuses the
      // whole tree and falls back to unnamed bodies if it disagrees, because a
      // wrong tree still builds and would just label parts with each other's
      // names. Rows are objects so a later phase can add fields to them.
      nodes?: { name: string; parent: number | null; color?: string }[];
      parts?: { node: number; faces: number }[];
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
  // Offset Face: move the selected faces along their own normals, the body
  // staying closed (neighbouring faces stretch to follow). Unlike Press/Pull's
  // planar path this is a true surface offset, so it is restricted to flat and
  // cylindrical faces — OCCT's BRepOffset is not safe on anything else.
  | { id: string; type: "offsetFace"; faces: Selector | Selector[]; distance: Num; body?: string }
  // Thicken: give surface geometry a wall. `faces` absent = the whole body,
  // which is how a non-watertight mesh import (a surface body, `solid: false`)
  // becomes real material. `symmetric` grows it both ways about the surface.
  | { id: string; type: "thicken"; faces?: Selector | Selector[]; thickness: Num; symmetric?: boolean; operation?: "join" | "new"; body?: string }
  // Taper the selected faces by an angle about a neutral plane (pull axis).
  | { id: string; type: "draft"; faces: Selector | Selector[]; angle: Num; axis: Axis3 }
  // Text embossed (raised) or engraved (cut) directly on a solid face — the
  // click-a-face counterpart to the sketch `text` entity, which it shares a font
  // engine with, so both produce identical glyphs.
  //
  // `plane` is the glyph LAYOUT frame, captured from the picked face when the
  // tool ran; `u`/`v` place the text within it. The sidecar re-checks on every
  // rebuild that the face is still coplanar with it, so an upstream edit that
  // moves the face raises instead of leaving the glyphs floating.
  //
  // The selector field is named `face` on purpose: SELECTOR_FIELDS in
  // features/repickReference.ts already lists that name, so the shipped
  // "Re-pick face" repair covers this feature with no extra wiring.
  //
  // `pick` is the 3D point the user clicked. Unused while this is planar-only,
  // but it is what disambiguates WHICH projected face a glyph belongs to on a
  // curved or overhung body — neither nearest-hit nor face-normal sign is
  // correct there, so the point has to be stored at pick time or it is lost.
  | {
      id: string;
      type: "textOnFace";
      face: Selector;
      body?: string;
      pick: Vec3;
      plane: PlaneDef;
      text: string;
      height: Num;
      depth: Num;
      // "flat" is a third SHAPE, not a depth of zero: the glyphs are imprinted
      // into the face so each becomes its own B-rep face, flush with the
      // surface, and only `colorSlot` distinguishes them. `depth` and `bevel`
      // are kept on the feature so switching style and back loses nothing, but
      // the sidecar neither reads nor validates them on that path.
      operation: "emboss" | "engrave" | "flat";
      font?: string;
      style?: "regular" | "bold" | "italic" | "bolditalic";
      align?: "left" | "center" | "right";
      angle?: Num;
      boxWidth?: Num;
      u?: Num;
      v?: Num;
      /** Palette slot the GLYPHS print on, independent of the body's own slot.
       *  Absent means "inherit the body's". The sidecar records exactly which
       *  faces the text added — for an emboss or engrave, new AND off the text's
       *  plane (face ownership alone is last-modifier and would claim the host
       *  face too); for a flat text, the imprinted regions matched by their
       *  (area, centre) fingerprint, since those ARE in the plane. Either way it
       *  colours the letters and not the surface they sit on.
       *
       *  A flat text with no slot is invisible, so the panel picks one for you
       *  the moment that style is chosen. */
      colorSlot?: number;
      // Bevel on the letter rim, as a WIDTH in mm — never an angle. With an
      // angle the offset would be depth*tan(angle), so editing the separately
      // editable depth would silently walk the bevel across the size at which
      // the kernel stops coping.
      //
      // "auto" picks the operator that clears every glyph of the string in this
      // font, preferring chamfer for an emboss and fillet for an engrave.
      // Neither is hard-coded: measured per-font success spans 11%-89% and the
      // winner flips by family, and the choice is per GLYPH, because insisting
      // on one operator refuses strings that mixing completes.
      //
      // "taper" is a different shape entirely — sloping walls rather than a
      // blended rim — and is flat-faces-only. It is also the least reliable
      // path in the feature (45 of 62 glyphs succeed, and 2 return silently
      // corrupt geometry), so every result is validated and a bad one refuses.
      bevel?: Num;
      bevelStyle?: "auto" | "chamfer" | "fillet" | "taper";
    }
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
      // 0..1, reused per profile: under "facet" it is the flat-LAND fraction for
      // the periodic kinds, the wall width for the cellular ones, and the
      // terrace count for noise/image; under "round" it is the old power-curve
      // crispness.
      sharpness?: Num;
      // Surface profile. "facet" (DEFAULT) = hard surface: planar facets and
      // real creases, which is what actually survives a 3D print — a printer
      // rounds a sub-millimetre sinusoid into mush. "round" = the original
      // smooth fields.
      profile?: "facet" | "round";
      // mm the pattern fades to nothing over at a face boundary. 0 (default) =
      // a clean machined cut-off. The boundary ring itself stays undisplaced
      // either way, which is what keeps the mesh crack-free at the seam.
      boundaryInset?: Num;
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

// A machine-readable classification on an error or a diagnostic. Prose is for
// the user; this is what code branches on — the Re-pick affordance used to match
// the exact string "ambiguous nearest pick", so rewording a Python message
// silently disabled a TypeScript feature.
//
// The `(string & {})` member is load-bearing: it keeps autocomplete for the known
// codes while letting an UNRECOGNISED one type-check, so a newer sidecar emitting
// a code this build has never heard of degrades to "unclassified" instead of
// failing to compile. Adding a code is a pure addition; renaming one is breaking.
export type GeomErrorCode =
  | "ambiguousReference"
  | "referenceNotFound"
  | "cancelled"
  | "timedOut"
  | "stalled"
  | "kernelCrashed"
  | "engineUnavailable"
  | "replyTooLarge"
  | "bodyTooLarge"
  | "unknownOp"
  | "badRequest"
  | "expectFailed"
  | "budgetExhausted"
  | "matchImplausible"
  | (string & {});

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
  /** Machine-readable classification; prefer this over matching `reason`. */
  code?: GeomErrorCode;
  failed?: { mid: [number, number, number] }[]; // edgeOpFailed only: failed edges' midpoints
  // Ambiguous-reference repair (reason === "ambiguous nearest pick"): `at` is the
  // SELECTOR's own stored point — not the geometry that was found — which is what
  // identifies WHICH selector of a multi-selector feature to re-pick. `candidates`
  // are the tied entities, already human-readable, for the message shown to the user.
  at?: [number, number, number];
  candidates?: string[];
  /** Structured twin of `candidates`: each tied entity's real fingerprint, with
   *  the distance it was scored on. `candidates` is PROSE for a human and stays
   *  `string[]`; these are what a caller turns into a `{by:"match", fp}` selector
   *  to repair the reference without a viewport pick. Bounded to 3, same as
   *  `candidates` — an ambiguity band scales with the runner-up distance, so a
   *  badly stale selector can tie against a great many entities. */
  candidateFps?: { fp: EdgeFingerprint | FaceFingerprint; dist: number }[];
}

// Mesh wire arrays arrive either as plain JSON number arrays (text replies,
// the Rust in-process backend) or as typed-array views over a binary WS frame
// — every consumer only indexes / reads .length, valid on both members.
export type F32Wire = number[] | Float32Array;
export type U32Wire = number[] | Uint32Array;

/** One feature that failed while the rest of the timeline still built.
 *
 *  `message` may contain the literal `{body}` where a body's name belongs. The
 *  sidecar deliberately does NOT interpolate the name: it came out of the
 *  document, and on an imported assembly that means out of the STEP file, so it
 *  is untrusted text that must stay in a field of its own rather than dissolve
 *  into prose (sidecar/untrusted.py). Fill the slot with
 *  `featureErrorText(e, bodies)` — never by hand, and never by appending. */
export interface FeatureError {
  feature_id?: string;
  message: string;
  code?: GeomErrorCode;
  /** The sidecar's id for the body the failure is about. Safe to branch on. */
  body_id?: string;
  /** UNTRUSTED: that body's (or feature's) name as it stood when the build
   *  failed, already capped and control-stripped by the sidecar. Display only. */
  subject?: string;
}

/** One body's exact kernel mass properties, or a record of why it has none.
 *
 *  A discriminated union on `measured` so `b.volume` cannot be read without
 *  narrowing first. An unmeasurable body carries NO numeric fields at all rather
 *  than zeros — zero volume and absent volume mean different things, and the type
 *  enforces that distinction instead of letting `undefined` reach a formatter. */
export type BodyMassProperties =
  | {
      id: string;
      name?: string;
      measured: true;
      /** mm^3, exact (not from the display mesh) */
      volume: number;
      /** mm^2, exact */
      area: number;
      com: [number, number, number];
      /** null when the body has no publishable extent: no triangulation, or
       *  unbounded geometry (OCCT reports +/-1e100, which reads as a real
       *  number and would poison total.bbox). */
      bbox: { min: [number, number, number]; max: [number, number, number] } | null;
      counts: { solids: number; shells: number; faces: number; edges: number; vertices: number };
      /** present only when the request set `checks` */
      valid?: boolean;
      watertight?: boolean;
    }
  | { id: string; name?: string; measured: false; reason: string };

/** Reply to the `massProperties` op. `counting` and `bboxSource` pin conventions
 *  that change what the numbers mean: counts follow the addressable (build123d)
 *  convention rather than raw topology, and the box comes from the triangulation,
 *  so it is conservative — never tighter than exact. */
export interface MassPropertiesResult {
  units: "mm";
  counting: string;
  bboxSource: string;
  bodies: BodyMassProperties[];
  total: {
    /** how many bodies were MEASURED — not how many were asked about */
    bodies: number;
    volume: number;
    area: number;
    /** null when the total volume is zero (nothing to weight the mean by) */
    com: [number, number, number] | null;
    bbox: { min: [number, number, number]; max: [number, number, number] } | null;
    counts: Partial<Record<"solids" | "shells" | "faces" | "edges" | "vertices", number>>;
  };
  /** requested ids that matched no live body — reported, never silently dropped */
  unknown?: string[];
  warnings?: { message: string; feature_id?: string; code?: GeomErrorCode }[];
}

export interface RebuildResult {
  mesh: { positions: F32Wire; indices: U32Wire; faceIds: U32Wire; normals?: F32Wire };
  edges: { id: string; points: [number, number, number][]; body?: string }[];
  bbox: { min: Vec3; max: Vec3 };
  // per-body metadata: which faceId range each body occupies in the merged mesh
  // (lets the browser tree list bodies and picking map a face back to its body).
  // `etag` (when the backend supplies one) is a content fingerprint the render
  // layer diffs to decide whether a body needs rebuilding at all — absent means
  // "always rebuild" (e.g. the in-process Rust backend, which has no etag cache).
  bodies?: { id: string; name: string; faceStart: number; faceCount: number; faceOwners?: (string | null)[]; textureColorSlots?: (number | null)[]; etag?: string; nodeRef?: string }[];
  // selector-resolution diagnostics, when any selector resolved with low confidence.
  diagnostics?: ResolveDiag[];
  // set when features failed but the rest of the timeline still built — the
  // mesh above is everything EXCEPT the failed features' effects. featureError
  // is the LAST (most downstream) failure — the one closest to the user's
  // latest action; featureErrors lists them all, timeline order. The reply is
  // still ok:true so the model renders alongside the error banner.
  //
  // `message` may carry a `{body}` slot where a body's name belongs — the
  // sidecar does not interpolate document text into prose. `body_id` is the
  // sidecar's own id; `subject` is the UNTRUSTED name it stood for, capped and
  // control-stripped. Render with featureErrorText(), never by hand.
  featureError?: FeatureError;
  featureErrors?: FeatureError[];
  // projected-curve refresh entries from this rebuild (absent at steady state);
  // the store lands them via a derived, no-undo commit — see
  // DocumentStore.commitProjectionRefresh.
  projectionUpdates?: ProjectionUpdate[];
}

export type RebuildReply =
  | { ok: true; result: RebuildResult }
  | { ok: false; error: FeatureError };

export type ExportFormat = "step" | "stl" | "3mf" | "glb";

// Import: the format the user picks, and the sidecar's reply for an `import` op —
// the content hash of the stored geometry plus a little metadata for the new
// `import` feature.
export type ImportFormat = "stl" | "3mf" | "step" | "obj" | "brep" | "glb";
export type ImportReply =
  | { ok: true; geom: string; name: string; solid: boolean; faces: number; color?: string;
      // present only for a STEP that carried a real assembly tree; see the
      // `import` feature above for what they mean
      nodes?: { name: string; parent: number | null; color?: string }[];
      parts?: { node: number; faces: number }[] }
  // `cancelled` = the user stopped it. Distinct from a failure so the UI can
  // dismiss quietly instead of showing an error the user already knows about.
  | { ok: false; cancelled?: boolean; message: string };
