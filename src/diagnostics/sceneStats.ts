// A snapshot of what the viewport is actually working with, collected AT REPORT
// TIME and prepended to a bug report's breadcrumbs.
//
// This exists because "the frame rate drops when I apply a pattern" took a whole
// evening to pin down, and every question along the way was one the app could
// have answered itself: how many triangles is it drawing, how big is the canvas,
// what pixel ratio, what did the renderer report, what was the frame rate. None
// of it was in the report, so all of it had to be re-measured by hand.
//
// Deliberately cheap and total-only. It reads counters the viewport already
// keeps; it must never traverse geometry, because a report is filed when things
// are already going badly.

import type { ModelView } from "../viewport/render";

export interface SceneStatsSource {
  model: ModelView | null;
  canvas: HTMLCanvasElement;
  pixelRatio: number;
  /** Most recent frame time in ms, or null when the viewport is idle. */
  frameMs: number | null;
}

/** One line per fact, short enough to survive the 300-char breadcrumb cap. */
export function sceneStats(s: SceneStatsSource): string[] {
  const out: string[] = [];
  const gpu = (window as { __gpu?: string }).__gpu;
  if (gpu) out.push(`[gpu] ${gpu}`);

  const w = s.canvas.clientWidth, h = s.canvas.clientHeight;
  const mp = ((w * h * s.pixelRatio * s.pixelRatio) / 1e6).toFixed(1);
  out.push(`[view] ${w}x${h} css @ dpr ${s.pixelRatio} = ${mp}M fragments`);

  if (s.model) {
    let tris = 0, verts = 0, edges = 0;
    for (const b of s.model.bodies) {
      const g = b.mesh.geometry;
      const pos = g.getAttribute("position");
      verts += pos ? pos.count : 0;
      tris += (g.getIndex()?.count ?? (pos?.count ?? 0)) / 3;
      edges += b.edges.length;
    }
    // verts/tri near 3 means the mesh carries no vertex sharing at all, which is
    // what a faceted texture produces — worth seeing next to a slow frame rate.
    const ratio = tris ? (verts / tris).toFixed(2) : "0";
    out.push(`[mesh] ${s.model.bodies.length} bodies · ${Math.round(tris)} tris · ${verts} verts `
      + `(${ratio}/tri) · ${edges} edges`);
  } else {
    out.push("[mesh] no model built");
  }

  out.push(s.frameMs != null
    ? `[frame] ${s.frameMs.toFixed(1)}ms (${Math.round(1000 / s.frameMs)} fps) at report time`
    : "[frame] viewport idle at report time");
  return out;
}
