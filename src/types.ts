// Shared API + document types. Source of truth for the TS side; mirrors the
// Python sidecar contract.

export type Params = Record<string, number>;
export type Num = number | string; // literal or parameter name

export type Selector =
  | { kind: "edge"; by: "axis"; axis: "X" | "Y" | "Z" }
  | { kind: "edge"; by: "nearest"; point: [number, number, number] }
  | { kind: "edge"; by: "all" }
  | { kind: "face"; by: "normal"; dir: [number, number, number] }
  | { kind: "face"; by: "nearest"; point: [number, number, number] };

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
  | { id: string; type: "sketch"; plane: PlaneSpec; entities: SketchEntity[]; constraints?: SketchConstraint[] }
  | {
      id: string;
      type: "extrude";
      sketch: string;
      distance: Num;
      operation: "new" | "join" | "cut";
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
  | { id: string; type: "press-pull"; face: Selector; distance: Num; operation: "join" | "cut" }
  | { id: string; type: "mirror"; plane: Plane3 }
  | { id: string; type: "revolve"; sketch: string; axis: Axis3; angle: Num }
  | { id: string; type: "loft"; sketches: string[] };

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
}

export interface RebuildResult {
  mesh: { positions: number[]; indices: number[]; faceIds: number[] };
  edges: { id: string; points: [number, number, number][] }[];
  bbox: { min: number[]; max: number[] };
}

export type RebuildReply =
  | { ok: true; result: RebuildResult }
  | { ok: false; error: { feature_id?: string; message: string } };

export type ExportFormat = "step" | "stl" | "3mf";
