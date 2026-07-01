// Expand a sketch pattern DEFINITION into its derived entities (the copies). Kept
// deliberately tiny and mirrored 1:1 by the Python port in builder.py (_expand_pattern)
// so the frontend preview and the sidecar build agree. Derived ids are
// "<pattern.id>#<n>" — render/build-only, never targeted by constraints.

import type { Num, Params, SketchPattern } from "../types";
import type { ResolvedEntity } from "./snap";
import { resolveNum } from "./resolve";

function translated(e: ResolvedEntity, dx: number, dy: number, id: string): ResolvedEntity {
  const c = e.construction ? { construction: true as const } : {};
  switch (e.type) {
    case "line":
      return { type: "line", id, x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy, ...c };
    case "rectangle":
      return { type: "rectangle", id, width: e.width, height: e.height, x: e.x + dx, y: e.y + dy, ...c };
    case "circle":
      return { type: "circle", id, radius: e.radius, x: e.x + dx, y: e.y + dy, ...c };
    case "arc":
      return { type: "arc", id, x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy, mx: e.mx + dx, my: e.my + dy, ...c };
    case "spline":
      return { type: "spline", id, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })), ...c };
    case "point":
      return { type: "point", id, x: e.x + dx, y: e.y + dy, ...c };
  }
}

function rotPt(x: number, y: number, cx: number, cy: number, ang: number): [number, number] {
  const co = Math.cos(ang), si = Math.sin(ang);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * co - dy * si, cy + dx * si + dy * co];
}

/** Rotate an entity about (cx,cy) by `ang` radians. A rectangle can't carry
 *  rotation (it's axis-aligned), so it becomes a 4-line loop. */
function rotated(e: ResolvedEntity, cx: number, cy: number, ang: number, id: string): ResolvedEntity[] {
  const c = e.construction ? { construction: true as const } : {};
  const R = (x: number, y: number) => rotPt(x, y, cx, cy, ang);
  switch (e.type) {
    case "circle": {
      const [x, y] = R(e.x, e.y);
      return [{ type: "circle", id, radius: e.radius, x, y, ...c }];
    }
    case "point": {
      const [x, y] = R(e.x, e.y);
      return [{ type: "point", id, x, y, ...c }];
    }
    case "line": {
      const [x1, y1] = R(e.x1, e.y1), [x2, y2] = R(e.x2, e.y2);
      return [{ type: "line", id, x1, y1, x2, y2, ...c }];
    }
    case "arc": {
      const [x1, y1] = R(e.x1, e.y1), [x2, y2] = R(e.x2, e.y2), [mx, my] = R(e.mx, e.my);
      return [{ type: "arc", id, x1, y1, x2, y2, mx, my, ...c }];
    }
    case "spline":
      return [{ type: "spline", id, points: e.points.map((p) => { const [x, y] = R(p.x, p.y); return { x, y }; }), ...c }];
    case "rectangle": {
      const hw = e.width / 2, hh = e.height / 2;
      const corners = ([[e.x - hw, e.y - hh], [e.x + hw, e.y - hh], [e.x + hw, e.y + hh], [e.x - hw, e.y + hh]] as [number, number][])
        .map(([x, y]) => R(x, y));
      return corners.map((c0, i) => {
        const c1 = corners[(i + 1) % 4];
        return { type: "line", id: `${id}.${i}`, x1: c0[0], y1: c0[1], x2: c1[0], y2: c1[1], ...c } as ResolvedEntity;
      });
    }
  }
}

export function expandPattern(
  pat: SketchPattern,
  byId: Map<string, ResolvedEntity>,
  params: Params,
): ResolvedEntity[] {
  const N = (x: Num) => resolveNum(x, params);
  const out: ResolvedEntity[] = [];
  let n = 0;
  const did = () => `${pat.id}#${n++}`;

  if (pat.type === "patternRect") {
    const cx = Math.max(1, Math.round(N(pat.countX))), cy = Math.max(1, Math.round(N(pat.countY)));
    const sx = N(pat.spacingX), sy = N(pat.spacingY);
    const srcs = pat.sources.map((id) => byId.get(id)).filter(Boolean) as ResolvedEntity[];
    for (let i = 0; i < cx; i++)
      for (let j = 0; j < cy; j++) {
        if (i === 0 && j === 0) continue; // the original stays as the real entity
        for (const s of srcs) out.push(translated(s, i * sx, j * sy, did()));
      }
  } else if (pat.type === "patternCircular") {
    const count = Math.max(1, Math.round(N(pat.count)));
    const total = N(pat.angle);
    const full = total !== 0 && Math.abs(Math.abs(total) - 360) < 1e-6;
    const step = ((full ? total / count : total / Math.max(1, count - 1)) * Math.PI) / 180;
    const cx = N(pat.cx), cy = N(pat.cy);
    const srcs = pat.sources.map((id) => byId.get(id)).filter(Boolean) as ResolvedEntity[];
    for (let k = 1; k < count; k++) for (const s of srcs) out.push(...rotated(s, cx, cy, k * step, did()));
  } else if (pat.type === "boltCircle") {
    const count = Math.max(1, Math.round(N(pat.count)));
    const r = N(pat.bcd) / 2, rad = N(pat.diameter) / 2, cx = N(pat.cx), cy = N(pat.cy);
    for (let k = 0; k < count; k++) {
      const a = (k / count) * 2 * Math.PI;
      out.push({ type: "circle", id: did(), radius: rad, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  } else if (pat.type === "gridHoles") {
    const cx0 = Math.max(1, Math.round(N(pat.countX))), cy0 = Math.max(1, Math.round(N(pat.countY)));
    const sx = N(pat.spacingX), sy = N(pat.spacingY), rad = N(pat.diameter) / 2, cx = N(pat.cx), cy = N(pat.cy);
    for (let i = 0; i < cx0; i++)
      for (let j = 0; j < cy0; j++)
        out.push({ type: "circle", id: did(), radius: rad, x: cx + (i - (cx0 - 1) / 2) * sx, y: cy + (j - (cy0 - 1) / 2) * sy });
  } else if (pat.type === "hexHoles") {
    const rings = Math.max(0, Math.round(N(pat.rings)));
    const s = N(pat.spacing), rad = N(pat.diameter) / 2, cx = N(pat.cx), cy = N(pat.cy);
    const h = (s * Math.sqrt(3)) / 2;
    for (let q = -rings; q <= rings; q++)
      for (let r = Math.max(-rings, -q - rings); r <= Math.min(rings, -q + rings); r++)
        out.push({ type: "circle", id: did(), radius: rad, x: cx + s * (q + r / 2), y: cy + h * r });
  } else if (pat.type === "honeycomb") {
    const rings = Math.max(0, Math.round(N(pat.rings)));
    const s = N(pat.spacing), R = N(pat.diameter) / 2, cx = N(pat.cx), cy = N(pat.cy);
    const h = (s * Math.sqrt(3)) / 2;
    for (let q = -rings; q <= rings; q++)
      for (let r = Math.max(-rings, -q - rings); r <= Math.min(rings, -q + rings); r++)
        out.push(...hexagonLines(cx + s * (q + r / 2), cy + h * r, R, did()));
  }
  return out;
}

/** A regular (pointy-top) hexagon as 6 line entities — orientation aligns with the
 *  hex lattice so the cells read as a honeycomb. */
function hexagonLines(cx: number, cy: number, R: number, id: string): ResolvedEntity[] {
  const v: [number, number][] = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3; // 30°, 90°, … (pointy-top)
    v.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  return v.map((p, k) => {
    const q = v[(k + 1) % 6];
    return { type: "line", id: `${id}.${k}`, x1: p[0], y1: p[1], x2: q[0], y2: q[1] } as ResolvedEntity;
  });
}
