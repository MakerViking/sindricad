// Interactive Text on Face: click a solid face, type, and the text is embossed
// (raised) or engraved (cut) into it. The click-a-face counterpart to the sketch
// Text tool — both drive the same sidecar font engine, so the glyphs match.
//
// Phase machine follows PressPullTool: suspendPicking while active, capture-phase
// listeners, and a MISS in the pick phase returns WITHOUT consuming the event so
// the click still orbits the camera.
//
// Preview is sidecar-driven (real B-rep — text on a face can't be faked
// client-side) and DEBOUNCED, following TextureTool. store.setPreview() calls
// scheduleRebuild(true), i.e. immediately, and a full emboss rebuild measured
// ~223 ms on a one-body document before the WebSocket round trip — so previewing
// on every keystroke would make typing unusable.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { GeometryBackend } from "../geometry/client";
import type { Feature, PlaneDef, Selector } from "../types";
import { setPrompt } from "../ui/prompt";
import { fetchFonts } from "../sketch/textCache";
import { TextOnFacePanel, type TextOnFaceValues } from "./textOnFacePanel";
import { HANDLE_IDLE as OUTLINE_COLOR } from "../viewport/colors3d";

type Phase = "pick" | "edit";

/** Re-frame a picked face plane so text READS horizontally on it.
 *
 *  `viewport.pickFacePlane` builds its xdir from world UP whenever the face is
 *  not roughly horizontal (viewport.ts:1347: `ref = |n.z| < 0.9 ? Z : X`), so on
 *  any wall the frame's x-axis points up the wall — and text, which runs along
 *  x, comes out vertical. Field-reported: "it always starts vertical".
 *
 *  Fixed HERE rather than in pickFacePlane because that helper is shared with
 *  "Sketch on this face" and "Offset plane from face"; re-orienting it would
 *  silently rotate the frame every new sketch on a wall is built in. The plane
 *  is stored per-feature, so a text-only convention changes nothing else.
 *
 *  It also makes the placement offsets mean something a person can predict: u
 *  runs horizontally, v runs up. A frame where "u" moved the text vertically
 *  would make the numeric fields worse than useless.
 */
export function textFrame(plane: PlaneDef): PlaneDef {
  const n = new THREE.Vector3(...plane.normal).normalize();
  const up = new THREE.Vector3(0, 0, 1);
  // A horizontal face has no "up" to align to — keep world X, which is what the
  // picker already chooses for it, so top faces are unaffected.
  if (Math.abs(n.dot(up)) > 0.9) return plane;
  const x = new THREE.Vector3().crossVectors(up, n).normalize();
  if (!Number.isFinite(x.x) || x.lengthSq() < 1e-12) return plane; // degenerate: leave it alone
  return { ...plane, xdir: [x.x, x.y, x.z] };
}

/** The nearest snap candidate within `tol`, else the point itself.
 *
 *  Split out because it is the one part of the drag with a real bug surface —
 *  a `<` where `<=` belongs, or "first within tolerance" instead of "nearest",
 *  both feel like the snap sticking to the wrong target — and the rest of the
 *  gesture needs a viewport and a pointer to exercise at all.
 *
 *  Ties go to the EARLIER candidate, which is why the caller lists the true
 *  centroid first: on a rectangular face the centroid and the centre of the
 *  extent coincide, and the centroid is the more meaningful of the two. */
export function snapTo(
  at: { u: number; v: number },
  candidates: { u: number; v: number }[],
  tol: number,
): { u: number; v: number } {
  let best = tol;
  let out = at;
  for (const c of candidates) {
    const d = Math.hypot(c.u - at.u, c.v - at.v);
    if (d < best) { best = d; out = c; }
  }
  return out;
}

// Typing drives the cheap 2D outline; the real solid follows once typing pauses.
// Measured on a one-body document: `tessellateText` 20.7 ms against 223 ms for a
// full emboss rebuild — and that 223 ms is a FLOOR, excluding the WebSocket round
// trip, the chunked payload and the three.js upload, on a document containing a
// single box. Previewing the solid on every keystroke is not viable.
const OUTLINE_DEBOUNCE_MS = 40;
const SOLID_DEBOUNCE_MS = 400;


export class TextOnFaceTool {
  active = false;
  private phase: Phase = "pick";
  private panel = new TextOnFacePanel();
  private fonts: string[] = [];

  private featureId = "";
  private editingId: string | null = null;
  private face: Selector | null = null;
  private bodyId: string | null = null;
  private plane: PlaneDef | null = null;
  private pick: [number, number, number] = [0, 0, 0];
  private u = 0;
  private v = 0;
  private dragging = false;
  private snapUV: { u: number; v: number }[] = [];
  private snapTol = 0;
  private values: TextOnFaceValues | null = null;
  private previewTimer = 0;
  private outlineTimer = 0;
  private outlines: THREE.Group | null = null;
  private outlineMat: THREE.LineBasicMaterial | null = null;
  private outlineGen = 0; // drops replies that land after a newer keystroke
  private solidPending = false; // a solid preview is in flight for the current values
  private unsubBuild: (() => void) | null = null;

  private onDone: ((id: string | null) => void) | null = null;
  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
    private geometry: GeometryBackend,
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundUp = () => { this.dragging = false; };
    this.boundKey = (e) => this.onKey(e);
  }

  start(onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.editingId = null;
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp, true);
    window.addEventListener("keydown", this.boundKey, true);
    // warm the font list while the user is still choosing a face
    if (!this.fonts.length) void fetchFonts().then((f) => (this.fonts = f)).catch(() => {});
    setPrompt("Click the face to put text on · Esc to cancel");
  }

  /** Re-open an existing textOnFace for editing. Returns false when any numeric
   *  field is parameter-driven — the inspector owns those (house pattern). */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "textOnFace") return false;
    for (const k of ["height", "depth", "angle", "boxWidth", "u", "v", "bevel"] as const) {
      const val = (f as Record<string, unknown>)[k];
      if (typeof val === "string" || this.store.isParamBound({ kind: "feature", feature: featureId, field: k }))
        return false;
    }
    if (this.active) return false;
    this.active = true;
    this.phase = "edit";
    this.onDone = onDone;
    this.editingId = featureId;
    this.featureId = featureId;
    this.face = f.face;
    this.bodyId = f.body ?? null;
    this.plane = f.plane;
    this.pick = f.pick;
    this.u = Number(f.u ?? 0);
    this.v = Number(f.v ?? 0);
    this.viewport.suspendPicking = true;
    // The edit path used to bind the keyboard only, so a re-opened text could
    // not be dragged — the placement gesture would exist for a NEW text and
    // silently not for an existing one.
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown, true);
    el.addEventListener("pointerup", this.boundUp, true);
    window.addEventListener("keydown", this.boundKey, true);
    this.store.beginEditPreview(featureId);
    void this.openPanel({
      text: f.text,
      height: Number(f.height),
      depth: Number(f.depth),
      operation: f.operation,
      angle: Number(f.angle ?? 0),
      align: f.align ?? "left",
      u: Number(f.u ?? 0),
      v: Number(f.v ?? 0),
      style: f.style ?? "regular",
      bevel: Number(f.bevel ?? 0),
      bevelStyle: (f.bevelStyle ?? "auto") as TextOnFaceValues["bevelStyle"],
      ...(f.font ? { font: f.font } : {}),
      ...(f.boxWidth ? { boxWidth: Number(f.boxWidth) } : {}),
    });
    return true;
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "edit") {
      if (this.dragging) this.dragTo(e);
      return;
    }
    const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = faceId != null ? "text" : "default";
  }

  /** Where a screen point lands on the text's own plane, in (u, v) millimetres.
   *
   *  Intersects the mathematical PLANE rather than the body mesh, so a drag that
   *  wanders past the edge of the face still tracks the cursor instead of
   *  sticking at the last triangle it hit. */
  private uvAt(clientX: number, clientY: number): { u: number; v: number } | null {
    if (!this.plane) return null;
    const O = new THREE.Vector3(...this.plane.origin);
    const N = new THREE.Vector3(...this.plane.normal).normalize();
    const U = new THREE.Vector3(...this.plane.xdir).normalize();
    const V = new THREE.Vector3().crossVectors(N, U);
    const ray = this.viewport.rayFrom(clientX, clientY).ray;
    const denom = N.dot(ray.direction);
    if (Math.abs(denom) < 1e-9) return null; // looking along the face: no answer
    const t = N.dot(O.clone().sub(ray.origin)) / denom;
    if (t <= 0) return null; // the plane is behind the camera
    const p = ray.origin.clone().addScaledVector(ray.direction, t).sub(O);
    return { u: p.dot(U), v: p.dot(V) };
  }

  /** Snap targets for the face under the cursor: its centroid, and the centre,
   *  edge midpoints and corners of its extent in the text frame.
   *
   *  Computed from the DISPLAY triangles, so they are as exact as the
   *  tessellation — which is the right precision for a placement gesture, and
   *  the numeric fields are there for when it is not. The bbox is taken in the
   *  text's own (u, v) frame rather than in world axes, so "middle of this face"
   *  means the same thing on a wall as on a top face. */
  private buildSnaps(clientX: number, clientY: number) {
    this.snapUV = [];
    if (!this.plane) return;
    const faceId = this.viewport.hoverFaceAt(clientX, clientY);
    if (faceId == null) return;
    const O = new THREE.Vector3(...this.plane.origin);
    const N = new THREE.Vector3(...this.plane.normal).normalize();
    const U = new THREE.Vector3(...this.plane.xdir).normalize();
    const V = new THREE.Vector3().crossVectors(N, U);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    let seen = false;
    for (const tri of this.viewport.faceTriangles(faceId)) {
      for (const w of [tri.a, tri.b, tri.c]) {
        const d = w.clone().sub(O);
        const u = d.dot(U), v = d.dot(V);
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
        seen = true;
      }
    }
    if (!seen) return;
    const midU = (minU + maxU) / 2;
    const midV = (minV + maxV) / 2;
    const c = this.viewport.measureFace(faceId).centroid.clone().sub(O);
    this.snapUV = [
      { u: c.dot(U), v: c.dot(V) },                     // true centroid
      { u: midU, v: midV },                             // centre of the extent
      { u: midU, v: minV }, { u: midU, v: maxV },       // edge midpoints
      { u: minU, v: midV }, { u: maxU, v: midV },
      { u: minU, v: minV }, { u: maxU, v: minV },       // corners
      { u: minU, v: maxV }, { u: maxU, v: maxV },
    ];
    // Tolerance as a FRACTION of the face, not a fixed millimetre or pixel
    // figure: a 4 mm boss and a 400 mm panel both want "near enough the middle"
    // to mean the same gesture, and a pixel figure would change what snaps as
    // the user zooms.
    this.snapTol = Math.max(maxU - minU, maxV - minV) * 0.04;
  }

  private dragTo(e: PointerEvent) {
    const at = this.uvAt(e.clientX, e.clientY);
    if (!at) return;
    const { u, v } = snapTo(at, this.snapUV, this.snapTol);
    this.u = Math.round(u * 1000) / 1000;
    this.v = Math.round(v * 1000) / 1000;
    this.panel.setPlacement(this.u, this.v);
    if (this.values) {
      this.values = { ...this.values, u: this.u, v: this.v };
      this.schedulePreview(this.values);
    }
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "edit") {
      // Drag anywhere on the body to slide the text across its face. A miss
      // returns WITHOUT consuming the event, so a click on empty space still
      // orbits the camera — the same rule the pick phase follows.
      if (this.viewport.hoverFaceAt(e.clientX, e.clientY) == null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.buildSnaps(e.clientX, e.clientY);
      this.dragging = true;
      this.dragTo(e);
      return;
    }
    const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
    if (!hit) return; // missed the body — let the click orbit
    const plane = this.viewport.pickFacePlane(e.clientX, e.clientY);
    if (!plane) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    // The selector must carry the body it was picked from. by:"nearest" always
    // returns SOME winner, so without this the text silently lands on whichever
    // body happened to be created last.
    this.bodyId = hit.bodyId;
    this.face = hit.bodyId ? { ...hit.selector, body: hit.bodyId } : hit.selector;
    this.plane = textFrame(plane);
    this.pick = [hit.anchor.x, hit.anchor.y, hit.anchor.z];
    this.featureId = this.store.nextId();
    this.viewport.clearHover();
    this.viewport.domElement.style.cursor = "default";

    // place the text where the click landed, in the plane's own frame — the
    // REFRAMED one, or u/v would be measured against axes the feature does not
    // carry and the text would land somewhere else entirely.
    const O = new THREE.Vector3(...this.plane.origin);
    const U = new THREE.Vector3(...this.plane.xdir);
    const N = new THREE.Vector3(...this.plane.normal);
    const V = new THREE.Vector3().crossVectors(N, U);
    const d = hit.anchor.clone().sub(O);
    this.u = Math.round(d.dot(U) * 1000) / 1000;
    this.v = Math.round(d.dot(V) * 1000) / 1000;

    this.phase = "edit";
    void this.openPanel({
      text: "", height: 6, depth: 0.6, operation: "emboss", align: "center",
      bevel: 0, bevelStyle: "auto", u: this.u, v: this.v,
    });
  }

  private async openPanel(initial: Partial<TextOnFaceValues>) {
    if (!this.fonts.length) {
      try {
        this.fonts = await fetchFonts();
      } catch {
        this.fonts = [];
      }
    }
    if (!this.active) return; // cancelled while the fonts were loading
    setPrompt("Type the text · Ctrl+Enter to apply · Esc to cancel");
    this.watchForSolid();
    this.panel.show(
      { editing: this.editingId != null, fonts: this.fonts, initial },
      {
        onChange: (v) => this.schedulePreview(v),
        onCommit: (v) => this.commit(v),
        onCancel: () => this.cancel(),
      },
    );
    // Draw the outline straight away rather than waiting for the first change.
    // On the EDIT path nothing else ever fires one — the panel opens with the
    // saved values and `onChange` only runs when something is touched — so
    // re-opening a text to nudge its placement showed no outline at all, which
    // is the state it was reported in. On the create path the text is still
    // empty here and schedulePreview returns early, so this costs nothing.
    const v0 = this.panel.values;
    if (v0) this.schedulePreview(v0);
  }

  private buildFeature(v: TextOnFaceValues): Feature {
    return {
      id: this.featureId,
      type: "textOnFace",
      face: this.face!,
      pick: this.pick,
      plane: this.plane!,
      text: v.text,
      height: v.height,
      depth: v.depth,
      operation: v.operation,
      style: v.style,
      align: v.align,
      angle: v.angle,
      // The PANEL's values, not the click-time ones: these are editable now, and
      // reading them from `this` would quietly discard every typed offset.
      u: v.u,
      v: v.v,
      ...(v.bevel > 0 ? { bevel: v.bevel, bevelStyle: v.bevelStyle } : {}),
      ...(v.font ? { font: v.font } : {}),
      ...(v.boxWidth ? { boxWidth: v.boxWidth } : {}),
      ...(this.bodyId ? { body: this.bodyId } : {}),
    };
  }

  private schedulePreview(v: TextOnFaceValues) {
    this.values = v;
    // Keep the tool's placement in step with the panel's. The outline is built
    // from `this.u`/`this.v` while the committed feature is built from the
    // panel's values, so without this a typed offset moved the text and left the
    // outline where it was — the preview and the result disagreeing about where
    // the text is, which is worse than having no preview.
    this.u = v.u;
    this.v = v.v;
    window.clearTimeout(this.outlineTimer);
    window.clearTimeout(this.previewTimer);
    // blank text has no geometry and the sidecar rightly refuses it — don't
    // paint the timeline red while someone is still typing the first letter
    if (!v.text.trim()) {
      this.clearOutlines();
      return;
    }
    this.outlineTimer = window.setTimeout(() => void this.refreshOutlines(v), OUTLINE_DEBOUNCE_MS);
    this.previewTimer = window.setTimeout(() => {
      if (!this.active || !this.values) return;
      const f = this.buildFeature(this.values);
      this.solidPending = true;
      if (this.editingId) this.store.setEditPreview(f);
      else this.store.setPreview(f);
    }, SOLID_DEBOUNCE_MS);
  }

  /** The outline used to retire the moment the solid arrived, on the reasoning
   *  that it was a stand-in and keeping it meant a redundant second wireframe.
   *  That reasoning was about TYPING, where the solid says everything the outline
   *  did. It does not hold for PLACEMENT: while you drag the text or type an
   *  offset, the outline is the only thing that tracks at gesture speed — the
   *  solid is 400ms behind at best and a rebuild behind at worst — and a 0.6mm
   *  emboss on a 40mm face is nearly invisible at a glance anyway. Reported as
   *  "I can't see the preview outline of the text".
   *
   *  It now lives as long as the panel does; clearOutlines happens on
   *  commit/cancel. `solidPending` still tracks the round trip, it just no longer
   *  takes the outline down with it. */
  private watchForSolid() {
    this.unsubBuild?.();
    this.unsubBuild = this.store.onBuild((s) => {
      if (s.building || !s.result || !this.solidPending) return;
      this.solidPending = false;
    });
  }

  /** The sketch-text entity this feature is equivalent to — the same shape the
   *  sidecar's `_text_entity_of` builds, so the outline the user types against
   *  comes out of the very same font engine as the solid they commit. */
  private textEntity(v: TextOnFaceValues) {
    return {
      type: "text", text: v.text, height: v.height, style: v.style,
      align: v.align, angle: v.angle, x: this.u, y: this.v,
      ...(v.font ? { font: v.font } : {}),
      ...(v.boxWidth ? { boxWidth: v.boxWidth } : {}),
    };
  }

  private async refreshOutlines(v: TextOnFaceValues) {
    if (!this.active || !this.plane) return;
    const gen = ++this.outlineGen;
    let faces;
    try {
      faces = await this.geometry.tessellateText(this.textEntity(v));
    } catch {
      return; // a failed outline must never disturb what is already on screen
    }
    if (!this.active || gen !== this.outlineGen || !this.plane) return; // superseded
    this.clearOutlines();

    const O = new THREE.Vector3(...this.plane.origin);
    const U = new THREE.Vector3(...this.plane.xdir);
    const N = new THREE.Vector3(...this.plane.normal);
    const V = new THREE.Vector3().crossVectors(N, U);
    // Lift the outline a hair off the surface so it doesn't z-fight the face it
    // is drawn on. On a CURVED face this is the tangent plane at the pick, so
    // the outline drifts slightly from where the glyphs will actually land —
    // acceptable for a typing preview, and the real solid follows behind it.
    const lift = N.clone().multiplyScalar(0.01);
    const to3d = ([x, y]: [number, number]) =>
      O.clone().addScaledVector(U, x).addScaledVector(V, y).add(lift);

    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: OUTLINE_COLOR, depthTest: false });
    for (const face of faces) {
      for (const loop of [face.outer, ...face.holes]) {
        if (loop.length < 2) continue;
        const g = new THREE.BufferGeometry().setFromPoints(loop.map(to3d));
        const line = new THREE.Line(g, mat);
        line.renderOrder = 999; // sits on top of the body it is drawn against
        group.add(line);
      }
    }
    this.outlines = group;
    this.outlineMat = mat;
    this.viewport.scene.scene.add(group);
    // The viewport renders ON DEMAND. Typing fires no pointer events, so
    // without this the outline lands in the scene and is not drawn until the
    // next mouse move — the exact bug the sketch text tool hit.
    this.viewport.requestRender();
  }

  private clearOutlines() {
    if (!this.outlines) return;
    this.viewport.scene.scene.remove(this.outlines);
    for (const child of this.outlines.children) (child as THREE.Line).geometry.dispose();
    this.outlineMat?.dispose(); // one material shared by every contour
    this.outlines = null;
    this.outlineMat = null;
    this.viewport.requestRender();
  }

  private commit(v: TextOnFaceValues) {
    if (!v.text.trim()) {
      // the panel deliberately stays up so this is recoverable
      setPrompt("Type some text first · Esc to cancel");
      return;
    }
    window.clearTimeout(this.previewTimer);
    window.clearTimeout(this.outlineTimer);
    this.outlineGen++;
    this.clearOutlines();
    const feature = this.buildFeature(v);
    if (this.editingId) {
      this.store.endEditPreview(false);
      this.store.replaceFeature(this.editingId, feature);
    } else {
      this.store.setPreview(null);
      this.store.addFeature(feature);
    }
    const id = feature.id;
    this.cleanup();
    this.onDone?.(id);
  }

  private onKey(e: KeyboardEvent) {
    // Esc lives on the TOOL, not the panel: the tool is alive from before the
    // panel exists (the face pick) until cleanup, and it owns the rollback.
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.cancel();
  }

  cancel() {
    if (!this.active) return;
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    window.clearTimeout(this.previewTimer);
    window.clearTimeout(this.outlineTimer);
    this.outlineGen++; // strand any tessellateText reply still in flight
    this.clearOutlines();
    this.unsubBuild?.();
    this.unsubBuild = null;
    this.solidPending = false;
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown, true);
    el.removeEventListener("pointerup", this.boundUp, true);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    this.viewport.clearHover();
    this.panel.hide();
    if (this.editingId) this.store.endEditPreview(true);
    else this.store.setPreview(null);
    this.viewport.suspendPicking = false;
    setPrompt(null);
    this.active = false;
    this.phase = "pick";
    this.editingId = null;
    this.values = null;
    this.face = null;
    this.plane = null;
    this.bodyId = null;
  }
}
