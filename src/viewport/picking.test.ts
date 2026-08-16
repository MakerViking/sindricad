// The occlusion tolerance for edge picking, and the edge-priority BAND.
//
// pickEdge ranks candidates by SCREEN distance, not depth, which is right when
// choosing between edges you can actually see. It also meant an edge on the FAR
// side of the body could take the click: the raycaster reports it, and it is
// often nearer the cursor in screen space than any visible edge. Edge materials
// are depthTest:true, so that edge is not even drawn where it was winning.
//
// The reported symptom (task #56) was that small faces lose most of their
// clickable pixels head-on and ALL of them at 60 degrees. Occluded edges are
// one half of that cause and are fixed above; the screen-space band is the
// other half, and it is what "the edge band on a small face" below pins.
//
// These tests pin the tolerance, because getting it wrong in either direction
// is silently bad: too tight and an edge lying ON the surface it bounds stops
// being pickable; too loose and the far side of a thin plate keeps winning.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { EDGE_NEAR_PX, Picker, edgeBandPx, faceScreenExtentPx, worldPerPixel } from "./picking";
import { buildBodyMesh } from "./render";
import type { ModelView } from "./render";
import type { RebuildResult } from "../types";

const HEIGHT_PX = 800;

describe("worldPerPixel", () => {
  it("scales with distance under perspective", () => {
    const c = new THREE.PerspectiveCamera(45, 1.6, 0.1, 10000);
    const near = worldPerPixel(c, 300, HEIGHT_PX);
    const far = worldPerPixel(c, 600, HEIGHT_PX);
    expect(far / near).toBeCloseTo(2, 6);
    // sanity: a 45 degree fov at 300mm over 800px is a few tenths of a mm
    expect(near).toBeGreaterThan(0.2);
    expect(near).toBeLessThan(0.4);
  });

  it("ignores distance under orthographic, where a pixel is a fixed size", () => {
    const o = new THREE.OrthographicCamera(-80, 80, 50, -50, -1000, 1000);
    expect(worldPerPixel(o, 300, HEIGHT_PX)).toBeCloseTo(worldPerPixel(o, 1200, HEIGHT_PX), 12);
    expect(worldPerPixel(o, 300, HEIGHT_PX)).toBeCloseTo(100 / HEIGHT_PX, 12);
  });

  it("follows ortho zoom, so zooming in tightens the tolerance too", () => {
    const o = new THREE.OrthographicCamera(-80, 80, 50, -50, -1000, 1000);
    const wide = worldPerPixel(o, 300, HEIGHT_PX);
    o.zoom = 4;
    expect(worldPerPixel(o, 300, HEIGHT_PX)).toBeCloseTo(wide / 4, 12);
  });

  it("returns 0 rather than dividing by a zero-height viewport", () => {
    const c = new THREE.PerspectiveCamera(45, 1.6, 0.1, 10000);
    expect(worldPerPixel(c, 300, 0)).toBe(0);
  });
});

describe("the occlusion cutoff pick() derives from it", () => {
  // pick() admits an edge at up to faceDistance + 2 * worldPerPixel
  const cutoff = (cam: THREE.Camera, faceDist: number) =>
    faceDist + 2 * worldPerPixel(cam, faceDist, HEIGHT_PX);

  it("keeps an edge lying on the face it bounds", () => {
    const c = new THREE.PerspectiveCamera(45, 1.6, 0.1, 10000);
    // same depth as the surface, give or take raycast/line-width slop
    expect(300.05).toBeLessThanOrEqual(cutoff(c, 300));
  });

  it("rejects the far edge of a THIN plate, which is the case that matters", () => {
    // A 2mm plate at 300mm. This is why the tolerance cannot be a percentage of
    // the view distance: 2mm is 0.67% of 300mm, so any sane percentage would
    // admit it — and thin plates are exactly where small faces live.
    const c = new THREE.PerspectiveCamera(45, 1.6, 0.1, 10000);
    expect(302).toBeGreaterThan(cutoff(c, 300));
  });

  it("rejects the far side of an ordinary body by a wide margin", () => {
    const c = new THREE.PerspectiveCamera(45, 1.6, 0.1, 10000);
    expect(400).toBeGreaterThan(cutoff(c, 300)); // 100mm cube
  });

  it("stays tight when zoomed right in, where world units are small", () => {
    const c = new THREE.PerspectiveCamera(45, 1.6, 0.1, 10000);
    // 5mm from a detail: a pixel is ~5um, so even 0.05mm behind is rejected
    expect(5.05).toBeGreaterThan(cutoff(c, 5));
    expect(5.00002).toBeLessThanOrEqual(cutoff(c, 5));
  });
});

// --- The edge band on a small face (task #56) -------------------------------
//
// Field report: a small face on a tilted view cannot be selected at all. The
// configuration it was measured in is 45 degree fov, 1440x900, face at 300mm,
// which puts one screen pixel at ~0.276mm — so a 3mm face is ~10.9px across and
// a fixed 3px edge halo on all four borders eats most or all of it.
//
// The model below is analytic and deterministic on purpose: the clickable area
// of a w x h px face with a `band` px halo inside each border. It is a model of
// the pick, not the pick itself — it proves the BAND POLICY, and only the
// hand-test in the app proves the extent is measured against the right face.
const FOV = 45;
const VIEW_W = 1440;
const VIEW_H = 900;
const FACE_DIST = 300;

const bandCam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
/** mm -> screen px in the measured configuration (reuses the shipped helper
 *  rather than re-deriving tan(fov/2), so the test cannot drift from pick()). */
const px = (mm: number) => mm / worldPerPixel(bandCam, FACE_DIST, VIEW_H);

/** Fraction of a w x h px face that is further than `band` px from every border
 *  — i.e. the part of it that resolves as a FACE rather than as one of its
 *  bounding edges. */
const clickable = (w: number, h: number, band: number) =>
  Math.max(0, 1 - (2 * band) / w) * Math.max(0, 1 - (2 * band) / h);

/** A row of the field table: a square face of `mm` seen at `tiltDeg`, which
 *  foreshortens one screen dimension by cos(tilt). */
const row = (mm: number, tiltDeg: number) => {
  const w = px(mm);
  const h = px(mm) * Math.cos((tiltDeg * Math.PI) / 180);
  return {
    w,
    h,
    before: clickable(w, h, EDGE_NEAR_PX),
    after: clickable(w, h, edgeBandPx(Math.min(w, h))),
  };
};

describe("the edge band on a small face (task #56)", () => {
  it("makes a 3mm face head-on go from a fifth clickable to over a third", () => {
    const r = row(3, 0);
    expect(r.w).toBeCloseTo(10.86, 2);
    expect(r.h).toBeCloseTo(10.86, 2);
    expect(r.before).toBeCloseTo(0.2, 3);
    expect(r.after).toBeCloseTo(0.36, 3);
  });

  it("makes a 3mm face at 60 degrees clickable AT ALL — the field report", () => {
    const r = row(3, 60);
    expect(r.w).toBeCloseTo(10.86, 2);
    expect(r.h).toBeCloseTo(5.43, 2);
    // 11 x 5 px with a 3px halo on all four borders: not one pixel of it is a
    // face. This is the reported bug, reproduced as a number.
    expect(r.before).toBe(0);
    expect(r.after).toBeCloseTo(0.48, 3);
  });

  it("helps a 6mm face at 60 degrees too — its SHORT side is what matters", () => {
    // 22 x 11 px. The long side is well past the cap; the band still shrinks,
    // because the policy reads the SMALLER dimension. A "faces wider than 22px
    // are unchanged" reading of the cap would be wrong here.
    const r = row(6, 60);
    expect(r.w).toBeCloseTo(21.73, 2);
    expect(r.h).toBeCloseTo(10.86, 2);
    expect(r.before).toBeCloseTo(0.324, 3);
    expect(r.after).toBeCloseTo(0.48, 3);
  });

  it("leaves an ordinary face bit-identical — the safety property", () => {
    // 87 x 43 px: both dimensions clear EDGE_NEAR_PX / 0.2 = 15px, so the cap
    // holds the band at 3px and this pick is the same pick as before the
    // change. toBe on the raw float, not toBeCloseTo: "unchanged" means equal.
    const r = row(24, 60);
    expect(r.after).toBe(r.before);
    expect(edgeBandPx(Math.min(r.w, r.h))).toBe(EDGE_NEAR_PX);
  });

  it("FAILS if the band ever reverts to a constant", () => {
    // The pair is the point: a constant band satisfies the second and cannot
    // satisfy the first. This is the test that has to go red if edgeBandPx is
    // replaced by `return EDGE_NEAR_PX`.
    expect(edgeBandPx(px(3) * Math.cos(Math.PI / 3))).toBeLessThan(EDGE_NEAR_PX);
    expect(edgeBandPx(px(24) * Math.cos(Math.PI / 3))).toBe(EDGE_NEAR_PX);
  });

  it("never grows as the face shrinks", () => {
    let prev = 0;
    for (let e = 0; e <= 40; e += 0.25) {
      const b = edgeBandPx(e);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });

  it("keeps a floor, so a tiny face's edges stay selectable", () => {
    // A 1mm face at 300mm is under 4px. Scaling all the way down would leave it
    // no edge halo at all and its bounding edges would become unpickable in
    // general selection — the opposite complaint.
    expect(edgeBandPx(px(1))).toBe(0.75);
    expect(edgeBandPx(0)).toBe(0.75);
  });

  it("engages the cap exactly at 15px of minimum screen extent", () => {
    expect(edgeBandPx(14.9)).toBeLessThan(EDGE_NEAR_PX);
    expect(edgeBandPx(15)).toBe(EDGE_NEAR_PX);
    expect(edgeBandPx(Infinity)).toBe(EDGE_NEAR_PX);
  });
});

// --- Measuring the face's screen extent -------------------------------------
//
// These cover the ways the measurement can go WRONG rather than its arithmetic.
// Every bail-out must return Infinity, because Infinity is what makes
// edgeBandPx give EDGE_NEAR_PX, i.e. exactly today's behaviour — an implicit
// contract worth asserting rather than only documenting.
const FACE_ID = 7;

/** One `mm` square in the XY plane at world z = `z`, as the minimum a
 *  faceScreenExtentPx call needs: an indexed geometry plus its faceId -> local
 *  triangle map, exactly as buildBodyMesh produces. */
function quadBody(mm: number, z: number) {
  const h = mm / 2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-h, -h, z, h, -h, z, h, h, z, -h, h, z], 3),
  );
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(geo);
  mesh.updateMatrixWorld();
  return { mesh, faceTriangles: new Map<number, number[]>([[FACE_ID, [0, 1]]]) };
}

const VIEW = { width: VIEW_W, height: VIEW_H };

describe("faceScreenExtentPx", () => {
  it("measures a 3mm face at 300mm as ~11px, which is the whole bug", () => {
    const cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
    cam.position.set(0, 0, FACE_DIST);
    cam.updateMatrixWorld();
    expect(faceScreenExtentPx(quadBody(3, 0), FACE_ID, cam, VIEW)).toBeCloseTo(px(3), 2);
  });

  it("returns the SHORT side of a face, not its long one", () => {
    const cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
    cam.position.set(0, 0, FACE_DIST);
    cam.updateMatrixWorld();
    // 3mm tall, 24mm wide: on a 1440x900 view the pixels are square, so the
    // short side must come back even though the long one is way past the cap.
    const h = 1.5;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-12, -h, 0, 12, -h, 0, 12, h, 0, -12, h, 0], 3),
    );
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(geo);
    mesh.updateMatrixWorld();
    const body = { mesh, faceTriangles: new Map<number, number[]>([[FACE_ID, [0, 1]]]) };
    expect(faceScreenExtentPx(body, FACE_ID, cam, VIEW)).toBeCloseTo(px(3), 2);
  });

  it("refuses a face STRADDLING the camera, which reads as a zero-px sliver", () => {
    // The case that motivates the guard, and the one that bites: you are zoomed
    // in far enough that a big face passes the near plane. The vertices behind
    // it divide by a NEGATIVE w, so they land mirrored — here exactly on top of
    // the front ones, collapsing the face's height to 0px. Unguarded that reads
    // as the smallest face imaginable and hands it the 0.75px floor band, which
    // is the opposite of what a screen-filling face should get.
    const cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      // spans z = -100 (in front) to z = +100 (behind the camera)
      new THREE.Float32BufferAttribute([-1.5, -1.5, -100, 1.5, -1.5, -100, 1.5, 1.5, 100, -1.5, 1.5, 100], 3),
    );
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(geo);
    mesh.updateMatrixWorld();
    const body = { mesh, faceTriangles: new Map<number, number[]>([[FACE_ID, [0, 1]]]) };
    const extent = faceScreenExtentPx(body, FACE_ID, cam, VIEW);
    expect(extent).toBe(Infinity);
    // the sentinel must survive into the band — that is what actually matters
    expect(edgeBandPx(extent)).toBe(EDGE_NEAR_PX);
  });

  it("refuses a face ENTIRELY behind the camera, which reads as ~3px", () => {
    // Same poison, cheaper to see: 3mm at 1000mm behind divides by w = -1000 and
    // comes back as a plausible-looking 3px face. It is small enough to slip
    // past the big-face early exit, so only the guard catches it.
    const cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld();
    const extent = faceScreenExtentPx(quadBody(3, 1000), FACE_ID, cam, VIEW);
    expect(extent).toBe(Infinity);
    expect(edgeBandPx(extent)).toBe(EDGE_NEAR_PX);
  });

  it("does NOT trip that guard under an ORTHOGRAPHIC camera", () => {
    // cameras.ts builds its ortho camera with near = -10000, so geometry at
    // POSITIVE view-space z is legitimately visible there. Writing the guard
    // the obvious way — `v.z >= 0`, "behind the camera" — would return the
    // sentinel for roughly half of every ortho pick and silently revert this
    // fix in that projection. Same frustum numbers as cameras.ts.
    const cam = new THREE.OrthographicCamera(-80, 80, 50, -50, -10000, 10000);
    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld();
    const extent = faceScreenExtentPx(quadBody(1.5, 100), FACE_ID, cam, VIEW);
    expect(Number.isFinite(extent)).toBe(true);
    // 1.5mm across a 160mm-wide / 100mm-tall frustum on a 1440x900 view = 13.5px
    expect(extent).toBeCloseTo(13.5, 4);
    expect(edgeBandPx(extent)).toBeLessThan(EDGE_NEAR_PX);
  });

  it("returns the sentinel for an unknown faceId or a missing body", () => {
    const cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
    cam.position.set(0, 0, FACE_DIST);
    cam.updateMatrixWorld();
    expect(faceScreenExtentPx(quadBody(3, 0), 999, cam, VIEW)).toBe(Infinity);
    expect(faceScreenExtentPx(undefined, FACE_ID, cam, VIEW)).toBe(Infinity);
  });

  it("early-exits a big face to the sentinel rather than walking it", () => {
    // Both dimensions past the cap pin the band at EDGE_NEAR_PX whatever the
    // remaining triangles do, so the walk stops. The observable is that the
    // answer is the sentinel, not the (also large) true extent.
    const cam = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
    cam.position.set(0, 0, FACE_DIST);
    cam.updateMatrixWorld();
    const extent = faceScreenExtentPx(quadBody(24, 0), FACE_ID, cam, VIEW);
    expect(extent).toBe(Infinity);
    expect(edgeBandPx(extent)).toBe(EDGE_NEAR_PX);
  });
});

// --- A DENSELY tessellated face -------------------------------------------
//
// Review found the first cut of the walk cap breaking the very safety property
// this change is sold on. It read the FIRST 256 triangles of a face, and
// triangle order out of a UV-grid tessellator — or out of OCCT's BRepMesh — is
// spatially coherent, so those 256 are a couple of ROWS. A 100mm face at 300mm
// is 362 x 362 px, nowhere near small, and it measured 9.05px at an 80x80 grid
// and 2.29px at 158x158: a 1.81px and a 0.75px band instead of 3px, and its
// bounding edges stopped winning picks.
//
// This is not a corner: render.ts records 50,074 triangles on ONE hex-textured
// face, and textureTool applies to a FACE selector, so one faceId owns them all.
// Texture is the project's flagship feature.
//
// The pair below is what makes this a real oracle rather than a bail-out check:
// the big dense face must read as the sentinel, AND the dense thin fillet band
// must still read as 5px. "Return the sentinel whenever the walk is truncated"
// was the other proposed fix and it satisfies the first while abandoning the
// second, which is the whole point of the change.

/** A `mmW` x `mmH` face in the XY plane tessellated into an nx by ny grid,
 *  emitted ROW-MAJOR — the ordering that produced the bug. faceTriangles holds
 *  local triangle indices, the convention buildBodyMesh produces (render.ts). */
function gridBody(mmW: number, mmH: number, nx: number, ny: number) {
  const pos: number[] = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) pos.push(-mmW / 2 + (i * mmW) / nx, -mmH / 2 + (j * mmH) / ny, 0);
  const vid = (i: number, j: number) => j * (nx + 1) + i;
  const idx: number[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      idx.push(vid(i, j), vid(i + 1, j), vid(i + 1, j + 1));
      idx.push(vid(i, j), vid(i + 1, j + 1), vid(i, j + 1));
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo);
  mesh.updateMatrixWorld();
  return {
    mesh,
    faceTriangles: new Map<number, number[]>([
      [FACE_ID, Array.from({ length: idx.length / 3 }, (_, t) => t)],
    ]),
  };
}

/** screen px -> mm in the measured configuration (the inverse of px()). */
const worldMm = (screenPx: number) => screenPx * worldPerPixel(bandCam, FACE_DIST, VIEW_H);

const faceCam = () => {
  const c = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 10000);
  c.position.set(0, 0, FACE_DIST);
  c.updateMatrixWorld();
  return c;
};

describe("faceScreenExtentPx on a densely tessellated face", () => {
  it("reads a BIG face as big however finely it is tessellated", () => {
    // The reviewer's exact case. 100mm at 300mm is 362 x 362 px; 158x158 is
    // 49,928 triangles, i.e. the hex-texture density render.ts measured.
    const cam = faceCam();
    for (const n of [40, 80, 158, 200]) {
      const extent = faceScreenExtentPx(gridBody(100, 100, n, n), FACE_ID, cam, VIEW);
      expect(extent, `${n}x${n} grid`).toBe(Infinity);
      expect(edgeBandPx(extent), `${n}x${n} grid`).toBe(EDGE_NEAR_PX);
    }
  });

  it("still reads a dense THIN face as thin — not a blanket bail-out", () => {
    // A fillet band, 5 x 900 px, tessellated 2,000 cells down its length. It
    // can never satisfy the early exit, so this is the case the cap exists for.
    // Returning the sentinel on truncation would pass the test above and lose
    // this one.
    const cam = faceCam();
    for (const ny of [1, 200, 2000]) {
      const extent = faceScreenExtentPx(gridBody(worldMm(5), worldMm(900), 1, ny), FACE_ID, cam, VIEW);
      expect(extent, `1x${ny} band`).toBeCloseTo(5, 5);
      expect(edgeBandPx(extent), `1x${ny} band`).toBeCloseTo(1, 5);
    }
  });

  it("does not ALIAS against the grid it is sampling", () => {
    // Sampling every k-th triangle is not enough. On a grid whose row is R
    // triangles, a k that is a multiple of R walks one COLUMN of the face and
    // re-creates the same under-measurement in the other axis. Each of these
    // is 2,048 triangles, so a uniform 2048/256 = 8 stride lands on one column
    // of the 4x256 grid: measured 10px, band 2px, on a 40 x 400 px face. The
    // shipped sequence is irrational-stepped, which cannot be periodic with R.
    const cam = faceCam();
    for (const [nx, ny] of [[4, 256], [8, 128], [2, 512], [16, 64]] as [number, number][]) {
      const extent = faceScreenExtentPx(gridBody(worldMm(40), worldMm(400), nx, ny), FACE_ID, cam, VIEW);
      expect(extent, `${nx}x${ny} grid`).toBe(Infinity);
    }
  });
});

// --- The gate in pick() itself ---------------------------------------------
//
// Everything above tests the band POLICY. Review then reverted pick()'s gate to
// the pre-change constant and the whole 702-test suite stayed green, plus tsc —
// the deliverable ("must FAIL if the band reverts to a constant") held for the
// helper and not for the code that ships. These drive a real Picker over a real
// buildBodyMesh/BodyEdges ModelView, so they fail on that revert.
//
// The trio is the point. Small-face-at-2px alone would pass a band of zero;
// on-the-line-at-0.5px alone would pass the old constant; big-face-at-2px is
// the safety property measured through the actual pick rather than argued.

const RECT = {
  left: 0, top: 0, width: VIEW_W, height: VIEW_H,
  right: VIEW_W, bottom: VIEW_H, x: 0, y: 0, toJSON: () => ({}),
} as DOMRect;

/** One rectangular body `wPx` x `hPx` on screen, centred, with its four border
 *  edges — built through buildBodyMesh so the faceTriangles convention and the
 *  BodyEdges pick table come from the producers, not from a hand-rolled copy. */
function rectView(wPx: number, hPx: number): ModelView {
  const hw = worldMm(wPx) / 2;
  const hh = worldMm(hPx) / 2;
  const meta = { id: "b0", name: "b0", faceStart: 0, faceCount: 1 };
  const edges: RebuildResult["edges"] = [
    { id: "L", points: [[-hw, -hh, 0], [-hw, hh, 0]], body: "b0" },
    { id: "R", points: [[hw, -hh, 0], [hw, hh, 0]], body: "b0" },
    { id: "B", points: [[-hw, -hh, 0], [hw, -hh, 0]], body: "b0" },
    { id: "T", points: [[-hw, hh, 0], [hw, hh, 0]], body: "b0" },
  ];
  const result = {
    mesh: {
      positions: [-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, hh, 0],
      indices: [0, 1, 2, 0, 2, 3],
      faceIds: [0, 0],
    },
    edges,
    bbox: { min: [-hw, -hh, 0], max: [hw, hh, 0] },
    bodies: [meta],
  } as RebuildResult;
  const body = buildBodyMesh(result, meta, edges, new THREE.Vector2(VIEW_W, VIEW_H), undefined);
  return { bodies: [body], edges: body.edges.refs, orphanEdges: null, box: new THREE.Box3() };
}

/** Click `offsetPx` inside the LEFT border of a face `wPx` wide, vertically
 *  centred so the top/bottom edges are far away and the left edge is the only
 *  candidate at that distance. */
function pickInsideLeftBorder(view: ModelView, wPx: number, offsetPx: number) {
  const cam = faceCam();
  return new Picker().pick(VIEW_W / 2 - wPx / 2 + offsetPx, VIEW_H / 2, RECT, cam, view);
}

describe("pick() gates on the measured band, not on EDGE_NEAR_PX", () => {
  // 5 x 100 px: the short side is what the policy reads, so the band is 1px.
  const small = () => rectView(5, 100);
  // 200 x 200 px: both sides clear 15px, so the band is EDGE_NEAR_PX.
  const big = () => rectView(200, 200);

  it("gives a SMALL face a pixel the old 3px band would have taken", () => {
    // 2px inside the border of a 5px-wide face. Band is 1px, so this is a face
    // now and was an edge before — the field report, through the real pick.
    expect(pickInsideLeftBorder(small(), 5, 2)?.kind).toBe("face");
  });

  it("still gives the EDGE a click that is on the line", () => {
    // 0.5px from the border is inside even the 1px band. Without this the pair
    // above is satisfied by a band of zero, which would make a small face's
    // edges unselectable — the opposite complaint MIN_EDGE_BAND_PX exists for.
    expect(pickInsideLeftBorder(small(), 5, 0.5)?.kind).toBe("edge");
  });

  it("leaves an ORDINARY face's edge winning at that same 2px", () => {
    // The safety property, measured rather than argued: at 200 x 200 px the cap
    // holds the band at 3px, so 2px from the border is still the edge's.
    expect(pickInsideLeftBorder(big(), 200, 2)?.kind).toBe("edge");
    expect(pickInsideLeftBorder(big(), 200, 6)?.kind).toBe("face");
  });
});
