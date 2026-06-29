// Picking: raycast the mesh (faces) and the fat edge lines (edges), then turn a
// hit into a *selector descriptor* — never a raw index. Axis-aligned geometry
// becomes a robust axis/normal selector; otherwise a nearest-to-point selector.

import * as THREE from "three";
import type { Line2 } from "three/examples/jsm/lines/Line2.js";
import type { Selector } from "../types";
import type { ModelView } from "./render";

export interface EdgeHit {
  kind: "edge";
  line: Line2;
  selector: Selector;
}

export interface FaceHit {
  kind: "face";
  faceId: number;
  selector: Selector;
}

export type Hit = EdgeHit | FaceHit;

export class Picker {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private scratch = new THREE.Vector3();
  // screen-space distance (px) of the best edge hit from the last pickEdge() —
  // lets pick() prefer a face over an edge unless the cursor is on the edge line.
  private edgeScreenDist = Infinity;

  /** General selection: a face wins over an edge unless the cursor is right on
   *  the edge line (within EDGE_NEAR_PX). The dedicated edge tools call
   *  pickEdgeAt() directly and keep the generous EDGE_PICK_THRESHOLD radius. */
  pick(
    clientX: number,
    clientY: number,
    rect: DOMRect,
    camera: THREE.Camera,
    view: ModelView,
    resolution: THREE.Vector2,
  ): Hit | null {
    const edge = this.pickEdge(clientX, clientY, rect, camera, view, resolution);

    this.raycaster.setFromCamera(this.ndc, camera); // ndc set by pickEdge
    const fHits = this.raycaster.intersectObject(view.mesh, false);
    let face: FaceHit | null = null;
    if (fHits.length) {
      const hit = fHits[0];
      const faceId = view.faceIds[hit.faceIndex ?? 0] ?? 0;
      const point = hit.point.clone();
      const normal =
        hit.normal?.clone().transformDirection(view.mesh.matrixWorld) ??
        new THREE.Vector3(0, 0, 1);
      face = { kind: "face", faceId, selector: faceSelector(normal, point) };
    }

    // edge only when on the line (or there's no face under the cursor at all)
    if (edge && (this.edgeScreenDist <= EDGE_NEAR_PX || !face)) return edge;
    return face;
  }

  /** Edge-only pick. Returns a precise single-edge (by:nearest) selector — used
   *  by fillet/chamfer where you want exactly the edge you clicked, not its
   *  whole axis group. Also sets this.ndc for a follow-up face pick. */
  pickEdge(
    clientX: number,
    clientY: number,
    rect: DOMRect,
    camera: THREE.Camera,
    view: ModelView,
    resolution: THREE.Vector2,
  ): EdgeHit | null {
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);
    // Wide candidate threshold (three.js Line2 threshold is ~0.5× screen px, so
    // this is a forgiving grab radius). We then choose the edge nearest the
    // cursor IN SCREEN SPACE — the raycaster sorts by camera depth, which would
    // otherwise grab a front edge that's visually farther from the cursor.
    this.raycaster.params.Line2 = { threshold: EDGE_PICK_THRESHOLD };
    (this.raycaster as any).camera = camera;
    for (const e of view.edges) (e.material as any).resolution?.copy(resolution);
    const eHits = this.raycaster.intersectObjects(view.edges, false);
    if (!eHits.length) return null;

    let best = eHits[0];
    let bestD = Infinity;
    for (const h of eHits) {
      const p = (h as any).pointOnLine ?? h.point;
      this.scratch.copy(p).project(camera);
      const sx = (this.scratch.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (-this.scratch.y * 0.5 + 0.5) * rect.height + rect.top;
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d < bestD) { bestD = d; best = h; }
    }
    this.edgeScreenDist = bestD; // used by pick() to decide edge vs face

    const line = best.object as Line2;
    const pts = line.userData.points as [number, number, number][];
    const mid = pts[Math.floor(pts.length / 2)];
    return {
      kind: "edge",
      line,
      selector: { kind: "edge", by: "nearest", point: [mid[0], mid[1], mid[2]] },
    };
  }
}

// three.js Line2 raycast threshold is ~0.5× the on-screen pixel radius, so ~26
// gives a comfortable ~13px grab radius. Candidates are then narrowed by screen
// distance (see pickEdge), so a wide value stays precise.
const EDGE_PICK_THRESHOLD = 26;
// In general selection, only treat a click as an edge when the cursor is within
// this many screen px of the edge line; otherwise a face under the cursor wins
// (keeps thin faces selectable). Fillet/Chamfer (pickEdgeAt) ignore this.
const EDGE_NEAR_PX = 7;

function faceSelector(normal: THREE.Vector3, hit: THREE.Vector3): Selector {
  const n = normal.clone().normalize();
  const near = (v: number, t: number) => Math.abs(v - t) < 1e-3;
  const axisAligned =
    (near(Math.abs(n.x), 1) && near(n.y, 0) && near(n.z, 0)) ||
    (near(Math.abs(n.y), 1) && near(n.x, 0) && near(n.z, 0)) ||
    (near(Math.abs(n.z), 1) && near(n.x, 0) && near(n.y, 0));
  if (axisAligned) {
    return {
      kind: "face",
      by: "normal",
      dir: [round(n.x), round(n.y), round(n.z)],
    };
  }
  return { kind: "face", by: "nearest", point: [hit.x, hit.y, hit.z] };
}

const round = (v: number) => Math.round(v);
