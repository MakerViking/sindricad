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
  private boundKey: (e: KeyboardEvent) => void;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
    private geometry: GeometryBackend,
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
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
    window.addEventListener("keydown", this.boundKey, true);
    this.store.beginEditPreview(featureId);
    void this.openPanel({
      text: f.text,
      height: Number(f.height),
      depth: Number(f.depth),
      operation: f.operation,
      angle: Number(f.angle ?? 0),
      align: f.align ?? "left",
      style: f.style ?? "regular",
      bevel: Number(f.bevel ?? 0),
      bevelStyle: (f.bevelStyle ?? "auto") as TextOnFaceValues["bevelStyle"],
      ...(f.font ? { font: f.font } : {}),
      ...(f.boxWidth ? { boxWidth: Number(f.boxWidth) } : {}),
    });
    return true;
  }

  private onMove(e: PointerEvent) {
    if (this.phase !== "pick") return;
    const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = faceId != null ? "text" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || this.phase !== "pick") return;
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
    this.plane = plane;
    this.pick = [hit.anchor.x, hit.anchor.y, hit.anchor.z];
    this.featureId = this.store.nextId();
    this.viewport.clearHover();
    this.viewport.domElement.style.cursor = "default";

    // place the text where the click landed, in the plane's own frame
    const O = new THREE.Vector3(...plane.origin);
    const U = new THREE.Vector3(...plane.xdir);
    const N = new THREE.Vector3(...plane.normal);
    const V = new THREE.Vector3().crossVectors(N, U);
    const d = hit.anchor.clone().sub(O);
    this.u = Math.round(d.dot(U) * 1000) / 1000;
    this.v = Math.round(d.dot(V) * 1000) / 1000;

    this.phase = "edit";
    void this.openPanel({ text: "", height: 6, depth: 0.6, operation: "emboss", align: "center", bevel: 0, bevelStyle: "auto" });
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
      u: this.u,
      v: this.v,
      ...(v.bevel > 0 ? { bevel: v.bevel, bevelStyle: v.bevelStyle } : {}),
      ...(v.font ? { font: v.font } : {}),
      ...(v.boxWidth ? { boxWidth: v.boxWidth } : {}),
      ...(this.bodyId ? { body: this.bodyId } : {}),
    };
  }

  private schedulePreview(v: TextOnFaceValues) {
    this.values = v;
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

  /** The outline is a STAND-IN for a solid that hasn't been computed yet, so it
   *  retires the moment the real one arrives — otherwise every committed-looking
   *  preview carries a second, redundant wireframe of itself. Changing any value
   *  brings it straight back, because the solid on screen is then stale. */
  private watchForSolid() {
    this.unsubBuild?.();
    this.unsubBuild = this.store.onBuild((s) => {
      if (s.building || !s.result || !this.solidPending) return;
      this.solidPending = false;
      this.clearOutlines();
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
