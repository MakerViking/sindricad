// Single source of truth for "what dimensions does a sketch entity have, where
// is each one's label/value, how do you read & write it, and how is it drawn as
// a MCAD-style dimension (extension lines + dimension line + arrowheads)."
// Drives the in-canvas dimension labels (SketchDimensions), the inspector, and
// SketchMode.editDimension — one place for all per-entity dimension knowledge.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { circumcenter } from "./arc";
import { rectCorners } from "./region";

export type DimField = "width" | "height" | "diameter" | "length";
type V = THREE.Vector2;
const v = (x: number, y: number) => new THREE.Vector2(x, y);

export interface EntityDim {
  field: DimField;
  label: string; // "Width" / "Height" / "Diameter" / "Length"
  labelPos: V; // where the value text sits (on the dimension line)
  valueMm: number;
  write: (mm: number) => void; // mutate the entity in place
  lines: [V, V][]; // extension lines + dimension line + arrowheads (2D)
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** arrowhead (a small "V") at `tip`, opening back along `dir` */
function arrow(tip: V, dir: V, size: number): [V, V][] {
  const back = tip.clone().sub(dir.clone().multiplyScalar(size));
  const perp = v(-dir.y, dir.x).multiplyScalar(size * 0.45);
  return [
    [tip.clone(), back.clone().add(perp)],
    [tip.clone(), back.clone().sub(perp)],
  ];
}

/** a linear dimension measuring a..b, offset perpendicular by `offDir`*off */
function linear(a: V, b: V, offDir: V, value: number): { labelPos: V; lines: [V, V][] } {
  const off = clamp(value * 0.16, 3, 12);
  const da = a.clone().add(offDir.clone().multiplyScalar(off));
  const db = b.clone().add(offDir.clone().multiplyScalar(off));
  const dir = db.clone().sub(da).normalize();
  const aSize = clamp(value * 0.08, 1.4, 4);
  const lines: [V, V][] = [
    [a.clone(), da.clone()], // extension lines
    [b.clone(), db.clone()],
    [da.clone(), db.clone()], // dimension line
    ...arrow(da, dir.clone().negate(), aSize),
    ...arrow(db, dir, aSize),
  ];
  return { labelPos: da.clone().add(db).multiplyScalar(0.5), lines };
}

export function entityDims(e: ResolvedEntity): EntityDim[] {
  if (e.type === "rectangle") {
    const hw = e.width / 2;
    const hh = e.height / 2;
    const w = linear(v(e.x - hw, e.y - hh), v(e.x + hw, e.y - hh), v(0, -1), e.width);
    const h = linear(v(e.x - hw, e.y - hh), v(e.x - hw, e.y + hh), v(-1, 0), e.height);
    return [
      { field: "width", label: "Width", valueMm: e.width, labelPos: w.labelPos, lines: w.lines, write: (mm) => { e.width = mm; } },
      { field: "height", label: "Height", valueMm: e.height, labelPos: h.labelPos, lines: h.lines, write: (mm) => { e.height = mm; } },
    ];
  }
  if (e.type === "circle") {
    // diameter line across the circle, arrowheads at the rim
    const a = v(e.x - e.radius, e.y);
    const b = v(e.x + e.radius, e.y);
    const aSize = clamp(e.radius * 0.16, 1.4, 4);
    const lines: [V, V][] = [
      [a.clone(), b.clone()],
      ...arrow(a, v(-1, 0), aSize),
      ...arrow(b, v(1, 0), aSize),
    ];
    return [
      {
        field: "diameter",
        label: "Diameter",
        valueMm: e.radius * 2,
        labelPos: v(e.x, e.y + clamp(e.radius * 0.25, 2, 6)),
        lines,
        write: (mm) => { e.radius = mm / 2; },
      },
    ];
  }
  if (e.type === "arc") return []; // radius dim editing comes with the solver
  if (e.type === "spline") return []; // splines are defined by their fit points
  if (e.type === "point") return []; // a point carries no dimension
  if (e.type === "text") return []; // text has no editable linear dimension
  // line: dimension parallel to it, offset to the left normal
  const a = v(e.x1, e.y1);
  const b = v(e.x2, e.y2);
  const len = a.distanceTo(b);
  const dir = b.clone().sub(a).normalize();
  const l = linear(a, b, v(-dir.y, dir.x), len);
  return [
    {
      field: "length",
      label: "Length",
      valueMm: len,
      labelPos: l.labelPos,
      lines: l.lines,
      write: (mm) => {
        const cur = Math.hypot(e.x2 - e.x1, e.y2 - e.y1) || 1;
        e.x2 = e.x1 + ((e.x2 - e.x1) / cur) * mm;
        e.y2 = e.y1 + ((e.y2 - e.y1) / cur) * mm;
      },
    },
  ];
}

/** every dimension's annotation segments for a set of entities (skips construction) */
export function dimensionSegments(ents: ResolvedEntity[]): [V, V][] {
  const out: [V, V][] = [];
  for (const e of ents) {
    if (e.construction) continue;
    for (const d of entityDims(e)) out.push(...d.lines);
  }
  return out;
}

// --- constraint-based dimensions (p2pDistance / p2lDistance) -----------------

/** resolve a dimension pick (entity + p index, see the SketchConstraint docs)
 *  to its current 2D position */
function refPoint(e: ResolvedEntity, p: number): V | null {
  if (e.type === "line") return p === 0 ? v(e.x1, e.y1) : v(e.x2, e.y2);
  if (e.type === "arc") {
    if (p === 2) {
      const cc = circumcenter({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, { x: e.mx, y: e.my });
      return cc ? v(cc.x, cc.y) : null;
    }
    return p === 0 ? v(e.x1, e.y1) : v(e.x2, e.y2);
  }
  if (e.type === "circle" || e.type === "point") return v(e.x, e.y);
  if (e.type === "rectangle") {
    const c = rectCorners(e.x, e.y, e.width, e.height)[p];
    return c ? v(c.x, c.y) : null;
  }
  if (e.type === "spline") {
    const q = p === 0 ? e.points[0] : e.points[e.points.length - 1];
    return q ? v(q.x, q.y) : null;
  }
  return null;
}

export interface ConstraintDim {
  cIndex: number; // index into the constraints array (write target)
  labelPos: V;
  valueMm: number; // the driving value
  lines: [V, V][];
}

/** annotation + label geometry for the distance constraints (the driving dims
 *  the dimension tool places between two points, or a point and a line) */
export function constraintDims(ents: ResolvedEntity[], constraints: SketchConstraint[]): ConstraintDim[] {
  const byId = new Map(ents.map((e) => [e.id, e]));
  const out: ConstraintDim[] = [];
  constraints.forEach((c, i) => {
    if (c.type === "p2pDistance") {
      const e1 = byId.get(c.e1), e2 = byId.get(c.e2);
      const a = e1 ? refPoint(e1, c.p1) : null;
      const b = e2 ? refPoint(e2, c.p2) : null;
      if (!a || !b || a.distanceTo(b) < 1e-6) return;
      const dir = b.clone().sub(a).normalize();
      const lin = linear(a, b, v(-dir.y, dir.x), a.distanceTo(b));
      out.push({ cIndex: i, labelPos: lin.labelPos, valueMm: c.value, lines: lin.lines });
    } else if (c.type === "p2lDistance") {
      const pe = byId.get(c.e), le = byId.get(c.line);
      const a = pe ? refPoint(pe, c.p) : null;
      if (!a || !le || le.type !== "line") return;
      const dx = le.x2 - le.x1, dy = le.y2 - le.y1;
      const l2 = dx * dx + dy * dy || 1;
      const t = ((a.x - le.x1) * dx + (a.y - le.y1) * dy) / l2;
      const f = v(le.x1 + t * dx, le.y1 + t * dy); // foot of the perpendicular
      if (a.distanceTo(f) < 1e-6) return;
      const dir = f.clone().sub(a).normalize();
      const lin = linear(a, f, v(-dir.y, dir.x), a.distanceTo(f));
      out.push({ cIndex: i, labelPos: lin.labelPos, valueMm: c.value, lines: lin.lines });
    }
  });
  return out;
}
