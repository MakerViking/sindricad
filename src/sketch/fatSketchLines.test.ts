// Sketch CURVES are drawn thick enough to tell apart from dimension annotations.
//
// GH #17: "Lines are currently too thin and blend in visually with dimension
// lines. A thickness of 2-3px would solve this."
//
// This could not be done by setting `linewidth` on the old material: WebGL
// ignores LineBasicMaterial.linewidth in every browser, so the lines rendered at
// 1px whatever the number said. The fix is Line2, the same technique the 3D
// model edges already use (viewport/edgeLines.ts).
//
// THE TRAP, and the reason this file exists. A Line2 is a Mesh, not a Line, and
// a LineGeometry has no `position` attribute — it packs instanceStart /
// instanceEnd. Every picker that walked `isLine` + getAttribute("position")
// would have quietly stopped finding sketch curves: no error, no visual clue,
// the Project tool just never picks a sketch curve again. So the world points
// ride on userData and the picker reads those.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { curveObjects, SketchOverlay, setSketchLineResolution } from "./overlay";
import { SketchPlane } from "./plane";
import type { ResolvedEntity } from "./snap";
import type { CadDocument } from "../types";

const plane = new SketchPlane("XY");
const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 }) as ResolvedEntity;

/** every descendant that carries stashed curve points */
function withPts(o: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  o.traverse((c) => { if ((c.userData as { pts?: unknown }).pts) out.push(c); });
  return out;
}

describe("sketch curves are fat lines", () => {
  it("draws a curve with a real width, not a 1px LineBasicMaterial", () => {
    const [obj] = curveObjects([line("l", 0, 0, 10, 0)], plane, 0x5b9bff);
    expect(obj).toBeTruthy();
    const fat = withPts(obj!)[0];
    expect(fat, "no fat curve was produced").toBeTruthy();
    const mat = (fat as THREE.Mesh).material as { linewidth?: number };
    // the reporter asked for 2-3px; the point is that it is >1 and honoured
    expect(mat.linewidth).toBeGreaterThan(1);
    expect(mat.linewidth).toBeLessThanOrEqual(3);
  });

  it("carries its world points, because the geometry no longer exposes them", () => {
    // LineGeometry has no `position` attribute. If this stops holding, every
    // geometry-walking picker silently stops seeing sketch curves.
    const [obj] = curveObjects([line("l", 0, 0, 10, 0)], plane, 0x5b9bff);
    const pts = (withPts(obj!)[0]!.userData as { pts: THREE.Vector3[] }).pts;
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(pts[0]!.x).toBeCloseTo(0);
    expect(pts[pts.length - 1]!.x).toBeCloseTo(10);
  });

  it("is still PICKABLE by the Project tool's curve hit-test", () => {
    // The behavioural half: committedCurveAt must find a fat curve. This is the
    // assertion that fails if the userData path is removed.
    setSketchLineResolution(800, 600);
    const overlay = new SketchOverlay();
    const doc = {
      parameters: {},
      features: [{
        id: "s1", type: "sketch", plane: "XY",
        entities: [{ type: "line", id: "l1", x1: 0, y1: 0, x2: 100, y2: 0 }],
      }],
    } as unknown as CadDocument;
    overlay.update(doc);

    // a trivial world->screen: x maps to screen x, y to screen y
    const project = (w: THREE.Vector3) => ({ x: w.x, y: w.y });
    // right on the line
    expect(overlay.committedCurveAt(50, 0, project)).toEqual({ sketchId: "s1", entityId: "l1" });
    // and far away from it
    expect(overlay.committedCurveAt(50, 400, project)).toBeNull();
  });
});

describe("spline control points are visible", () => {
  it("draws a handle for EVERY control point, not just the two ends", () => {
    // GH #17: "the spline control points/circles are numerically too small ...
    // causing unwanted bumps". pickPoint already offers every control point as a
    // drag handle, so the interior ones were draggable and INVISIBLE — you
    // cannot aim carefully at a handle you cannot see, so you grab whichever one
    // the cursor is nearest. Same shape as the rectangle-corner bug this
    // codebase already fixed for this very issue.
    const spline = {
      type: "spline", id: "sp",
      points: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 20, y: -5 }, { x: 30, y: 0 }],
    } as unknown as ResolvedEntity;
    // curveObjects returns each handle as its OWN array entry, not as a child of
    // the curve — so scan them all, not just the first.
    const objs = curveObjects([spline], plane, 0x5b9bff, false, 1.5);
    expect(objs.length).toBeGreaterThan(1);

    // endpoint dots are square outlines drawn AT each control point; count the
    // distinct handle centres rather than object types
    const centres = new Set<string>();
    for (const o of objs) o.traverse((c) => {
      const g = (c as THREE.Line).geometry as THREE.BufferGeometry | undefined;
      const pos = g?.getAttribute?.("position");
      if (!pos || (c.userData as { pts?: unknown }).pts) return;
      // BBOX centre, not the average: endpointDot draws a CLOSED square whose
      // first corner is repeated, so the mean is skewed by r/5 and matches
      // nothing. The box centre is exact.
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        minX = Math.min(minX, pos.getX(i)); maxX = Math.max(maxX, pos.getX(i));
        minY = Math.min(minY, pos.getY(i)); maxY = Math.max(maxY, pos.getY(i));
      }
      centres.add(`${((minX + maxX) / 2).toFixed(1)},${((minY + maxY) / 2).toFixed(1)}`);
    });
    for (const p of [[0, 0], [10, 20], [20, -5], [30, 0]]) {
      expect(centres.has(`${p[0]!.toFixed(1)},${p[1]!.toFixed(1)}`),
        `no handle drawn at control point (${p[0]}, ${p[1]})`).toBe(true);
    }
  });
});
