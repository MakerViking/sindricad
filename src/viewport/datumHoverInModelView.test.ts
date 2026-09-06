// A construction/offset plane has to react to the cursor in the ORDINARY model
// view, not only while an "extrude up to" pick is armed.
//
// Field report 50b719a3: "Offset/datum planes give no hover feedback in the
// normal viewport, unlike the origin planes." The plane was already clickable —
// handleClick raycasts the quads when the picker misses, and right-click opens
// the plane menu — but the quad sat at its idle 0.12 wherever the cursor went,
// because the hoveredDatum channel added in 0.1.211 had exactly two callers,
// both inside the press/pull and extrude "pick a target" branches. Viewport's
// own per-frame hover never touched it.
//
// WHAT THIS OBSERVES: `hoveredDatum` and the quad's real material.opacity after
// running the REAL handleHover/queueHover off the prototype — the effect on
// screen, not that some method was called. A real Viewport needs a WebGL
// context, so the methods run against a stand-in `this` (the pattern
// regionPickRepaint.test.ts and datumHighlight.test.ts use); rayFrom,
// pickDatumAt, hoverDatum and paintDatums are the real bodies, so the raycast
// against the quad is a real raycast.

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { Viewport } from "./viewport";

const IDLE = 0.12;
const HOVERED = 0.24;
const SELECTED = 0.32;

/** Screen centre — over the quad. */
const OVER = { clientX: 400, clientY: 300, buttons: 0 } as unknown as PointerEvent;
/** Top-left corner — the 80 mm quad does not reach there at this framing. */
const OFF = { clientX: 10, clientY: 10, buttons: 0 } as unknown as PointerEvent;

type Hit = { kind: "face"; faceId: number } | { kind: "edge"; edge: unknown } | null;

function probe(opts: {
  /** the reporter's document has no solid, so setModel is never called */
  model?: boolean;
  hit?: Hit;
  region?: boolean;
  mode?: "faces" | "bodies";
  /** body under the cursor in bodies mode (bodyIdAt is stubbed: the real one
   *  needs a full ModelView) */
  bodyId?: string | null;
  suspendPicking?: boolean;
} = {}) {
  const vp = Object.create(Viewport.prototype) as any;

  // A camera looking down -Z from z=200 at the origin, and one datum quad in
  // the XY plane at z=58 — feature f2 of the reporter's document.
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 2000);
  camera.position.set(0, 0, 200);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const quads = ["f2", "f3"].map((id, i) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: IDLE, side: THREE.DoubleSide }),
    );
    m.position.set(0, 0, 58 - i * 20); // f3 sits behind f2, out of the ray's way sideways
    if (i === 1) m.position.setX(400); // ...and far off to the side, so only f2 is under the cursor
    m.userData.datumId = id;
    m.updateMatrixWorld(true);
    return m;
  });

  vp.canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
  };
  vp.ndc = new THREE.Vector2();
  vp.sharedRaycaster = new THREE.Raycaster();
  vp.rig = { active: camera };
  vp.datumQuads = quads;
  vp.selectedDatum = null;
  vp.hoveredDatum = null;
  vp.needsRender = false;
  vp.lingerFrames = 0;
  vp.suspendPicking = opts.suspendPicking ?? false;
  vp.streaming = false;
  vp.setOverrideSide = null;
  vp.selectionMode = opts.mode ?? "faces";
  vp.model = opts.model ? ({} as never) : null;
  vp.highlighter = opts.model
    ? ({ clearHover() {}, hoverEdge() {}, hoverFace() {} } as never)
    : null;
  vp.picker = { pick: () => opts.hit ?? null };
  vp.bodyIdAt = () => opts.bodyId ?? null;
  let region = opts.region ?? false;
  vp.regionHoverAt = () => region;
  vp.regionPickAt = () => region;
  const bodiesSelected: string[] = [];
  const pickedDatums: string[] = [];
  if (opts.model) {
    vp.highlighter.selectOnlyBody = (id: string) => { bodiesSelected.length = 0; bodiesSelected.push(id); };
    vp.highlighter.toggleSelectBody = (id: string) => bodiesSelected.push(id);
    vp.highlighter.clearBodySelection = () => { bodiesSelected.length = 0; };
  }
  vp.onPickDatum = (id: string) => pickedDatums.push(id);

  return {
    hover: (e: PointerEvent) => vp.handleHover(e),
    click: (e: PointerEvent) => vp.handleClick(e),
    /** a sketch is un-hidden, so its profile is now under the same pixel */
    showRegion: () => { region = true; },
    queueHover: (e: PointerEvent) => vp.queueHover(e),
    select: (id: string | null) => vp.highlightDatum(id),
    hovered: () => vp.hoveredDatum as string | null,
    picked: () => pickedDatums,
    bodies: () => bodiesSelected,
    opacity: (id: string) =>
      (quads.find((q) => q.userData.datumId === id)!.material as THREE.MeshBasicMaterial).opacity,
    drew: () => vp.needsRender === true || vp.lingerFrames > 0,
  };
}

describe("datum plane hover in the plain model view (50b719a3)", () => {
  it("lights the plane under the cursor with no solid in the document at all", () => {
    // the reporter's document: one XY sketch, one offset plane, no body
    const p = probe({ model: false });

    p.hover(OVER);

    expect(p.hovered()).toBe("f2");
    expect(p.opacity("f2")).toBe(HOVERED);
    expect(p.opacity("f3")).toBe(IDLE);
    expect(p.drew(), "the new brightness was never asked to be drawn").toBe(true);
  });

  it("lights it with a solid present but nothing under the cursor", () => {
    const p = probe({ model: true, hit: null });

    p.hover(OVER);

    expect(p.hovered()).toBe("f2");
    expect(p.opacity("f2")).toBe(HOVERED);
  });

  it("a body face under the cursor wins over the plane behind it", () => {
    const p = probe({ model: true, hit: { kind: "face", faceId: 7 } });

    p.hover(OVER);

    expect(p.hovered()).toBe(null);
    expect(p.opacity("f2")).toBe(IDLE);
  });

  it("an edge under the cursor wins too", () => {
    const p = probe({ model: true, hit: { kind: "edge", edge: {} } });

    p.hover(OVER);

    expect(p.hovered()).toBe(null);
  });

  it("a sketch profile under the cursor wins over the plane behind it", () => {
    const p = probe({ model: true, region: true });

    p.hover(OVER);

    expect(p.hovered()).toBe(null);
    expect(p.opacity("f2")).toBe(IDLE);
  });

  it("a plane already lit goes back to idle when a sketch profile covers it", () => {
    const p = probe({ model: true });
    p.hover(OVER);
    expect(p.hovered()).toBe("f2");

    p.showRegion();
    p.hover(OVER);

    expect(p.hovered()).toBe(null);
    expect(p.opacity("f2")).toBe(IDLE);
  });

  it("moving off the quad returns it to idle and leaves a SELECTED plane bright", () => {
    const p = probe({ model: false });
    p.select("f3");
    p.hover(OVER);
    expect(p.opacity("f2")).toBe(HOVERED);

    p.hover(OFF);

    expect(p.hovered()).toBe(null);
    expect(p.opacity("f2")).toBe(IDLE);
    expect(p.opacity("f3")).toBe(SELECTED);
  });

  it("works in Bodies selection mode when no body is under the cursor", () => {
    // a click there selects the plane (handleClick's datum fallback), so the
    // highlight must not be missing in this mode either
    const p = probe({ model: true, mode: "bodies", bodyId: null });

    p.hover(OVER);

    expect(p.hovered()).toBe("f2");
  });

  it("does not light a plane a body is standing in front of, in Bodies mode", () => {
    const p = probe({ model: true, mode: "bodies", bodyId: "b1" });

    p.hover(OVER);

    expect(p.hovered()).toBe(null);
  });

  it("a held button clears the highlight instead of dragging it through an orbit", () => {
    const p = probe({ model: false });
    p.hover(OVER);
    expect(p.hovered()).toBe("f2");

    p.queueHover({ clientX: 400, clientY: 300, buttons: 1 } as unknown as PointerEvent);

    expect(p.hovered()).toBe(null);
    expect(p.opacity("f2")).toBe(IDLE);
  });

  it("leaves the channel alone while a tool owns it (suspendPicking)", () => {
    // press/pull and extrude drive hoveredDatum themselves during an "up to"
    // pick; the viewport must not fight them
    const p = probe({ model: false, suspendPicking: true });

    p.hover(OVER);

    expect(p.hovered()).toBe(null);
  });
});

describe("the click has to agree with the new highlight", () => {
  it("Bodies mode: a click on the lit plane selects it", () => {
    const p = probe({ model: true, mode: "bodies", bodyId: null });
    p.hover(OVER);
    expect(p.hovered()).toBe("f2");

    p.click(OVER);

    expect(p.picked()).toEqual(["f2"]);
  });

  it("Bodies mode: a body under the cursor still selects the body, not the plane", () => {
    const p = probe({ model: true, mode: "bodies", bodyId: "b1" });

    p.click(OVER);

    expect(p.picked()).toEqual([]);
    expect(p.bodies()).toEqual(["b1"]);
  });

  it("Faces mode: unchanged — the plane is still selectable on a miss", () => {
    const p = probe({ model: true, hit: null });

    p.click(OVER);

    expect(p.picked()).toEqual(["f2"]);
  });
});
