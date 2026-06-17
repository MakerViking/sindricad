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
  | { type: "spline"; id?: string; points: { x: Num; y: Num }[]; construction?: boolean };

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
  | { type: "diameter"; circle: string; value: number };

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
      // world centroid of the chosen profile region (sidecar picks that face)
      region?: [number, number, number];
    }
  | { id: string; type: "fillet"; edges: Selector | Selector[]; radius: Num }
  | { id: string; type: "chamfer"; edges: Selector | Selector[]; distance: Num }
  | { id: string; type: "mirror"; plane: Plane3 }
  | { id: string; type: "revolve"; sketch: string; axis: Axis3; angle: Num }
  | { id: string; type: "loft"; sketches: string[] };

export type FeatureType = Feature["type"];

export interface CadDocument {
  parameters: Params;
  features: Feature[];
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
