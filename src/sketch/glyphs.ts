// Constraint glyphs: a small on-canvas badge per GEOMETRIC constraint, showing
// its type and letting the user see/delete relationships (Fusion's "Show
// Constraints"). Dimensional constraints (distance/diameter/p2p/p2l/radius/angle)
// are NOT glyphed here — they already render as editable dimension badges.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { refPoint } from "./entityDims";

const V = (x: number, y: number) => new THREE.Vector2(x, y);

export interface ConstraintGlyph {
  cIndex: number; // index into the constraints array (delete target)
  label: string; // short symbol shown in the badge
  pos: THREE.Vector2; // 2D sketch-plane position
}

/** The solver's diagnosis of a constraint, or null if clean. Conflict (can't be
 *  satisfied) takes precedence over over-defined (redundant/removable). This is
 *  the single source of that precedence — glyph and dimension badges both use it,
 *  so their red/amber can't drift apart. */
export type ConstraintDiagnosis = "conflict" | "over";
export function diagnosisOf(i: number, conflict: Set<number>, over: Set<number>): ConstraintDiagnosis | null {
  return conflict.has(i) ? "conflict" : over.has(i) ? "over" : null;
}

/** representative point of an entity for glyph placement */
function entCenter(e: ResolvedEntity): THREE.Vector2 {
  switch (e.type) {
    case "line": return V((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2);
    case "arc": return V(e.mx, e.my);
    case "circle": case "point": case "rectangle": case "text": return V(e.x, e.y);
    case "polygon": return V(e.x, e.y);
    case "slot": return V((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2);
    case "spline": { const p = e.points[Math.floor(e.points.length / 2)] ?? e.points[0]; return p ? V(p.x, p.y) : V(0, 0); }
    case "projected": {
      const cv = e.curve;
      if (cv.kind === "line") return V((cv.x1 + cv.x2) / 2, (cv.y1 + cv.y2) / 2);
      if (cv.kind === "circle") return V(cv.x, cv.y);
      if (cv.kind === "arc") return V(cv.mx, cv.my);
      const p = cv.pts[Math.floor(cv.pts.length / 2)] ?? cv.pts[0];
      return p ? V(p[0], p[1]) : V(0, 0);
    }
  }
}

export function constraintGlyphs(ents: ResolvedEntity[], constraints: SketchConstraint[]): ConstraintGlyph[] {
  const byId = new Map(ents.map((e) => [e.id, e]));
  const out: ConstraintGlyph[] = [];
  const center = (id: string): THREE.Vector2 | null => { const e = byId.get(id); return e ? entCenter(e) : null; };
  const refPos = (id: string, p: number): THREE.Vector2 | null => {
    const e = byId.get(id);
    return e ? refPoint(e, p) : null;
  };
  const mid2 = (a: THREE.Vector2 | null, b: THREE.Vector2 | null) => (a && b ? a.clone().add(b).multiplyScalar(0.5) : null);
  const push = (i: number, label: string, pos: THREE.Vector2 | null) => { if (pos) out.push({ cIndex: i, label, pos }); };

  constraints.forEach((c, i) => {
    switch (c.type) {
      case "horizontal": push(i, "H", center(c.line)); break;
      case "vertical": push(i, "V", center(c.line)); break;
      case "parallel": push(i, "∥", center(c.l1)); break;
      case "perpendicular": push(i, "⊥", center(c.l1)); break;
      case "collinear": push(i, "—", mid2(center(c.l1), center(c.l2))); break;
      case "equal": push(i, "=", center(c.l1)); break;
      case "equalRadius": push(i, "=", center(c.a)); break;
      case "tangent": push(i, "T", mid2(center(c.line), center(c.circle))); break;
      case "tangent2": push(i, "T", mid2(center(c.a), center(c.b))); break;
      case "coincident": push(i, "⊙", refPos(c.e1, c.p1)); break;
      case "concentric": push(i, "◎", center(c.c1)); break;
      case "midpoint": push(i, "M", center(c.line)); break;
      case "symmetric": push(i, "⋈", center(c.line)); break;
      case "fix": push(i, "⚓", refPos(c.e, c.p)); break;
      // distance/diameter/p2pDistance/p2lDistance/radius/angle render as dimensions
      default: break;
    }
  });
  return out;
}
