// A custom navigation ViewCube drawn in the top-right corner of the viewport.
//
// Rendering: a SECOND THREE.Scene + OrthographicCamera, drawn AFTER the main
// render into a small scissored corner region (renderer.setViewport/setScissor).
// Each frame the cube's orientation is synced to the main camera so it always
// shows the current view direction.
//
// Interaction: pointer events on the main canvas, restricted to the corner box,
// are raycast against the cube's pickable parts (6 faces + 8 corners + 12 edges).
//   - LEFT click  -> animate the main camera to that part's view (honoring any
//                    per-side override the user has redefined).
//   - RIGHT click on a FACE -> a small context menu ("Set orientation from
//                    face…", "Reset") that enters a pick mode: the next left
//                    click on the model redefines what that cube side means.
//
// The cube is a pure UI affordance; it reads/writes overrides through callbacks
// supplied by the Viewport (which bridges to the document store).

import * as THREE from "three";
import type { StandardView } from "./cameras";
import type { ViewCubeSide, ViewOverride } from "../types";
import * as C from "./colors3d";
import { t } from "../i18n";

const SIZE = 120; // corner viewport, CSS px
const MARGIN = 14; // gap from the top-right edge
const HALF = 0.5; // half-extent of the unit cube

// the six face sides, with the world-space view direction (eye relative to
// target) and up that each represents by default. Z-up CAD: front looks along
// -Y, top looks down -Z, etc. Exported so the Viewport can reuse the per-side
// default normal/up when applying a side that has no override.
export const FACE_VIEWS: Record<
  ViewCubeSide,
  { view: StandardView; normal: THREE.Vector3; up: THREE.Vector3; label: string }
> = {
  front: { view: "front", normal: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1), label: t("viewport.cube.front") },
  back: { view: "back", normal: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1), label: t("viewport.cube.back") },
  right: { view: "right", normal: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1), label: t("viewport.cube.right") },
  left: { view: "left", normal: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 0, 1), label: t("viewport.cube.left") },
  top: { view: "top", normal: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), label: t("viewport.cube.top") },
  bottom: { view: "bottom", normal: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, -1, 0), label: t("viewport.cube.bottom") },
};

// The cube's own surfaces are local; the two HOVER colours are the shared
// selection accent, so hovering a cube face reads the same as selecting anything
// else in the viewport.
//
// The face plates are painted whole — background AND label — into their canvas
// texture, and the material carries NO tint. That is deliberate and it is the fix
// for field report 7bed5869 ("In dark mode the navigation cube is nearly
// impossible to see... text is unreadable, corner and edge controls are
// invisible"). A MeshBasicMaterial's `color` MULTIPLIES its map, and the label
// canvas was cleared to rgba(0,0,0,0) with `transparent: false` — so the alpha
// was discarded and every face rendered as texRGB × COLOR_FACE: solid black
// where the canvas was clear, and #cdd4de × #2b313c ≈ #222934 where the text
// was. Near-black text on black. Multiplying can only ever darken, so no choice
// of label colour could have rescued it; the tint had to go.
export const COLOR_FACE = 0x2b313c;
export const COLOR_FACE_HOVER = C.SELECT;
const COLOR_EDGE = 0x3a4250;
const COLOR_EDGE_HOVER = C.SELECT_HOT;
// The solid filler under the face plates. Was 0x161a20 — near-black, so the gaps
// between plates read as holes rather than as a cube.
export const COLOR_BODY = 0x39414f;
// The wireframe silhouette. Was 0x05070a: a black outline around a dark cube on a
// dark viewport draws nothing at all, which is half of "nearly impossible to see".
export const COLOR_OUTLINE = 0x6b7686;
/** Label ink on an unhovered face, and on a hovered (accent-filled) one. */
export const LABEL_INK = "#e8edf5";
export const LABEL_INK_HOVER = "#10141a";
/** Edge/corner nubs were opacity 0 until hovered — literally invisible, so
 *  there was nothing to tell a user they could be clicked. Quiet, but present. */
export const NUB_IDLE_OPACITY = 0.35;
export const NUB_HOVER_OPACITY = 0.95;

// ---- face-plate label typography -------------------------------------------
//
// The plate was painted with a hardcoded `600 56px Inter, system-ui,
// sans-serif`. Nothing in that list has a Japanese glyph, so 上面 was drawn by
// whatever the engine happened to reach for, or as tofu boxes.
//
// The family list now comes from `--font-ui` in styles.css — one stack for the
// whole app, including the bundled Noto Sans JP subset — with the literal below
// as the fallback for the case where the stylesheet has not applied yet.
//
// Canvas is not layout, and that is the trap: naming a family in `ctx.font`
// neither starts a webfont download nor repaints when one arrives. These
// textures are painted once at construction, so without the document.fonts wait
// in the constructor the six plates would stay on the fallback face for the
// whole session even after the rest of the UI had switched to Noto.
const LABEL_WEIGHT = 600;
/** Nominal label size on the 256px plate. */
export const LABEL_PX = 56;
/** Shrink below LABEL_PX only past this fraction of the plate, and the plate
 *  itself is the budget rather than some margin inside it. Measured, because
 *  the tempting 0.9-ish margin would have moved English: the longest English
 *  label, BOTTOM, is 243px at 56px/600 in Noto Sans and 270px in DejaVu Sans
 *  against a 256px plate. So a label that fits today is left exactly as it is,
 *  and one that does not — a wide platform font, or a translated side name —
 *  is brought back onto the plate instead of being cut off at its edge. */
const LABEL_FIT = 1;
/** Never go below this: smaller than this is unreadable at cube size, and a
 *  label that must be condensed to fit is better than one that cannot be read. */
export const LABEL_PX_MIN = 26;
// i18n-ignore a CSS font-family list, not UI text — it mirrors --font-ui in styles.css
const LABEL_FAMILIES_FALLBACK =
  '"Inter", "Noto Sans JP", system-ui, "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Noto Sans CJK JP", sans-serif';

let labelFamiliesCache: string | null = null;
/** The `--font-ui` family list, whitespace-collapsed for the canvas shorthand. */
function labelFamilies(): string {
  if (labelFamiliesCache !== null) return labelFamiliesCache;
  let declared = "";
  try {
    declared = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").replace(/\s+/g, " ").trim();
  } catch {
    /* no document (tests) — the literal below is the same list */
  }
  labelFamiliesCache = declared || LABEL_FAMILIES_FALLBACK;
  return labelFamiliesCache;
}

/** A canvas 2D `font` shorthand for the face plates, at `px`. */
export function cubeLabelFont(px: number = LABEL_PX): string {
  return `${LABEL_WEIGHT} ${px}px ${labelFamilies()}`;
}

/** The largest size, from LABEL_PX down to LABEL_PX_MIN, whose measured width
 *  is inside `budget`. `measureAt` is the caller's canvas; separated from it so
 *  the fit rule can be exercised without a WebGL context.
 *
 *  Returns LABEL_PX unchanged whenever the label already fits, which is what
 *  keeps the English plates exactly as they were. */
export function fitLabelPx(measureAt: (px: number) => number, budget: number): number {
  let px = LABEL_PX;
  while (px > LABEL_PX_MIN && measureAt(px) > budget) px -= 2;
  return px;
}

type PartKind = "face" | "edge" | "corner";
interface Part {
  kind: PartKind;
  side?: ViewCubeSide; // faces only
  // the view direction (eye - target) this part orients the camera to
  dir: THREE.Vector3;
  up: THREE.Vector3;
  mesh: THREE.Mesh;
  baseColor: number;
  hoverColor: number;
}

export interface ViewCubeHooks {
  /** apply a face side's view (honoring overrides) — left-click a face. */
  applySide(side: ViewCubeSide): void;
  /** apply an arbitrary diagonal view direction (corners/edges). */
  applyDir(dir: THREE.Vector3, up: THREE.Vector3): void;
  /** current overrides (for marking redefined sides). */
  getOverrides(): Partial<Record<ViewCubeSide, ViewOverride>>;
  /** begin "redefine this side from a model face" pick mode. */
  beginSetOverride(side: ViewCubeSide): void;
  /** clear a side's override (back to default orientation). */
  resetOverride(side: ViewCubeSide): void;
}

export class ViewCube {
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private group = new THREE.Group(); // the cube; its quaternion = inverse main-camera orientation
  private parts: Part[] = [];
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private hovered: Part | null = null;
  private menu: HTMLDivElement | null = null;
  private faceTextures = new Map<ViewCubeSide, { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture }>();

  constructor(
    private canvas: HTMLCanvasElement,
    private renderer: THREE.WebGLRenderer,
    private hooks: ViewCubeHooks,
  ) {
    // orthographic so the cube doesn't distort; framed a touch larger than the
    // cube's corner-to-corner extent (√3·HALF ≈ 0.87) for padding.
    const r = 1.15;
    this.camera = new THREE.OrthographicCamera(-r, r, r, -r, 0.01, 100);
    this.camera.position.set(0, 0, 6); // looks down -Z at the group (screen space)
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(2, 3, 4);
    this.scene.add(dir);

    this.scene.add(this.group);
    this.buildCube();
    this.installPointer();
    void this.repaintWhenLabelFontLoads();
  }

  /** Paint the six plates again once the label font is actually available.
   *
   *  `buildCube` paints them during construction, and at that moment a webfont
   *  named in `ctx.font` is typically not loaded yet — canvas silently uses the
   *  next family that is, and unlike layout it never comes back to fix it. So
   *  the plates would keep the fallback face for the session. Asking
   *  `document.fonts` for the exact string we draw with, for the exact text we
   *  draw, is what triggers the fetch AND tells us when to repaint.
   *
   *  For an English UI this is a no-op that resolves immediately: the Latin
   *  families in the stack are all local, and the bundled subset's
   *  `unicode-range` carries no Latin character, so there is nothing to fetch. */
  private async repaintWhenLabelFontLoads(): Promise<void> {
    const fonts = document.fonts as FontFaceSet | undefined;
    if (!fonts?.load) return;
    const text = (Object.keys(FACE_VIEWS) as ViewCubeSide[]).map((s) => FACE_VIEWS[s].label).join("");
    try {
      await fonts.load(cubeLabelFont(), text);
    } catch {
      // A malformed shorthand rejects rather than throwing synchronously. The
      // plates already carry a readable fallback, so there is nothing to do but
      // keep it — never let this take the viewport down.
      return;
    }
    this.refreshOverrideMarks();
  }

  // ---- geometry -----------------------------------------------------------

  private buildCube() {
    // six faces — thin plates inset slightly so edges/corners sit proud and the
    // outline reads cleanly. Each face carries a canvas-texture label.
    for (const side of Object.keys(FACE_VIEWS) as ViewCubeSide[]) {
      const f = FACE_VIEWS[side];
      const tex = this.makeLabelTexture(side);
      const geo = new THREE.PlaneGeometry(0.78, 0.78);
      // No tint: the plate's canvas already holds its final colours (see the
      // COLOR_FACE comment — a tint here multiplies the map and can only darken).
      const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff, transparent: false });
      const mesh = new THREE.Mesh(geo, mat);
      // orient the plate so its +Z points along the face normal, at the surface
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.normal);
      mesh.position.copy(f.normal).multiplyScalar(HALF + 0.001);
      this.group.add(mesh);
      this.parts.push({
        kind: "face",
        side,
        dir: f.normal.clone(),
        up: f.up.clone(),
        mesh,
        baseColor: COLOR_FACE,
        hoverColor: COLOR_FACE_HOVER,
      });
    }

    // a solid filler cube under the plates so the body looks solid + occludes
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.97, 0.97, 0.97),
      new THREE.MeshBasicMaterial({ color: COLOR_BODY }),
    );
    this.group.add(body);

    // edges (12) and corners (8): small clickable nubs for diagonal views.
    for (const dir of edgeDirs()) {
      this.addNub("edge", dir, 0.16, COLOR_EDGE, COLOR_EDGE_HOVER);
    }
    for (const dir of cornerDirs()) {
      this.addNub("corner", dir, 0.18, COLOR_EDGE, COLOR_EDGE_HOVER);
    }

    // crisp wireframe outline around the cube
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: COLOR_OUTLINE }),
    );
    this.group.add(outline);
  }

  private addNub(kind: "edge" | "corner", dir: THREE.Vector3, s: number, base: number, hover: number) {
    const geo = new THREE.BoxGeometry(s, s, s);
    const mat = new THREE.MeshBasicMaterial({ color: base, transparent: true, opacity: NUB_IDLE_OPACITY });
    const mesh = new THREE.Mesh(geo, mat);
    // place at the cube surface in the direction's components (±HALF per nonzero axis)
    mesh.position.set(
      Math.sign(dir.x) * HALF,
      Math.sign(dir.y) * HALF,
      Math.sign(dir.z) * HALF,
    );
    this.group.add(mesh);
    const up = dir.z !== 0 && dir.x === 0 && dir.y === 0
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);
    this.parts.push({
      kind,
      dir: dir.clone().normalize(),
      up,
      mesh,
      baseColor: base,
      hoverColor: hover,
    });
  }

  private makeLabelTexture(side: ViewCubeSide): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    this.faceTextures.set(side, { canvas, texture: tex });
    this.paintLabel(side, false);
    return tex;
  }

  private paintLabel(side: ViewCubeSide, redefined: boolean, hovered = false) {
    const entry = this.faceTextures.get(side);
    if (!entry) return;
    const { canvas, texture } = entry;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width;
    // Fill the plate opaquely: the material no longer tints the map, so what is
    // painted here is exactly what the user sees. Hover swaps the fill for the
    // selection accent (and the ink for something readable on it) rather than
    // multiplying a colour over the top, which could only darken.
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = hovered ? C.hex(COLOR_FACE_HOVER) : C.hex(COLOR_FACE);
    ctx.fillRect(0, 0, W, W);
    ctx.fillStyle = hovered ? LABEL_INK_HOVER : LABEL_INK;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label = FACE_VIEWS[side].label;
    // Step the size down rather than let a label leave the plate. A label that
    // already fits the 256px canvas never shrinks, so nothing that renders
    // correctly today moves; see LABEL_FIT for the measurement.
    const budget = W * LABEL_FIT;
    const px = fitLabelPx((p) => {
      ctx.font = cubeLabelFont(p);
      return ctx.measureText(label).width;
    }, budget);
    ctx.font = cubeLabelFont(px);
    // …and a last-resort condense at the floor, so even a label that no size in
    // that range can fit stays on the plate rather than running past its edge.
    ctx.fillText(label, W / 2, W / 2, budget);
    if (redefined) {
      // small accent dot marking a user-redefined side
      ctx.beginPath();
      ctx.fillStyle = hovered ? LABEL_INK_HOVER : C.hex(C.SELECT);
      ctx.arc(W / 2, W * 0.78, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    texture.needsUpdate = true;
  }

  /** Repaint one face from the CURRENT hover + override state. */
  private repaintFace(side: ViewCubeSide, hovered: boolean) {
    this.paintLabel(side, !!this.hooks.getOverrides()[side], hovered);
  }

  /** refresh the "redefined" markers on faces (call when overrides change). */
  refreshOverrideMarks() {
    const ov = this.hooks.getOverrides();
    for (const side of Object.keys(FACE_VIEWS) as ViewCubeSide[]) {
      this.paintLabel(side, !!ov[side]);
    }
  }

  // ---- per-frame render ----------------------------------------------------

  /** Sync cube orientation to the main camera and draw it into the corner. */
  render(mainCamera: THREE.Camera) {
    // the cube should mirror the camera's orientation: rotate the cube by the
    // INVERSE of the camera's world rotation so "looking from +Y" shows the BACK
    // face, etc. Equivalent: cube.quaternion = inverse(camera.quaternion).
    this.group.quaternion.copy(mainCamera.quaternion).invert();

    const rect = this.canvas.getBoundingClientRect();
    // NOTE: renderer.setViewport/setScissor take CSS pixels and apply the
    // renderer's pixelRatio internally — so we must NOT pre-multiply by it here.
    // (Doing so applied pixelRatio twice, leaving a dpr²-sized viewport set for
    // the next main render → the whole model rendered offset/oversized on any
    // HiDPI / fractional-scaled display. Invisible at dpr=1.)
    const x = rect.width - SIZE - MARGIN;
    const y = rect.height - SIZE - MARGIN; // WebGL viewport origin is bottom-left

    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setViewport(x, y, SIZE, SIZE);
    this.renderer.setScissor(x, y, SIZE, SIZE);
    this.renderer.setScissorTest(true);
    this.renderer.clearDepth(); // draw the cube over the main scene
    this.renderer.render(this.scene, this.camera);
    this.renderer.setScissorTest(false);
    this.renderer.autoClear = prevAutoClear;
    // restore the full viewport for the next main render (CSS px; pixelRatio
    // is applied by setViewport itself).
    this.renderer.setViewport(0, 0, rect.width, rect.height);
  }

  // ---- pointer interaction -------------------------------------------------

  /** Is (clientX,clientY) inside the cube's corner box? Used by the Viewport to
   *  decide whether a click belongs to the cube or the model. */
  hitsRegion(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const left = rect.right - SIZE - MARGIN;
    const top = rect.top + MARGIN;
    return (
      clientX >= left && clientX <= left + SIZE && clientY >= top && clientY <= top + SIZE
    );
  }

  private installPointer() {
    // hover highlight (only when over the corner box)
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.hitsRegion(e.clientX, e.clientY)) {
        this.setHover(null);
        return;
      }
      this.setHover(this.pick(e.clientX, e.clientY));
    });
    this.canvas.addEventListener("pointerleave", () => this.setHover(null));
    // left click handled by the Viewport (it routes via onLeftClick) so it can
    // also suppress model picking; right-click context menu is owned here.
    this.canvas.addEventListener("contextmenu", (e) => {
      if (!this.hitsRegion(e.clientX, e.clientY)) return;
      const part = this.pick(e.clientX, e.clientY);
      if (part?.kind === "face" && part.side) {
        e.preventDefault();
        this.openMenu(e.clientX, e.clientY, part.side);
      }
    });
  }

  /** Called by the Viewport on a left-click that landed in the cube region.
   *  Returns true if the cube consumed it (so the model picker should skip). */
  handleLeftClick(clientX: number, clientY: number): boolean {
    if (!this.hitsRegion(clientX, clientY)) return false;
    const part = this.pick(clientX, clientY);
    if (!part) return false;
    if (part.kind === "face" && part.side) this.hooks.applySide(part.side);
    else this.hooks.applyDir(part.dir, part.up);
    return true;
  }

  private pick(clientX: number, clientY: number): Part | null {
    const rect = this.canvas.getBoundingClientRect();
    const left = rect.right - SIZE - MARGIN;
    const top = rect.top + MARGIN;
    // NDC within the corner box
    this.ndc.set(
      ((clientX - left) / SIZE) * 2 - 1,
      -((clientY - top) / SIZE) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const meshes = this.parts.map((p) => p.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    const hit = hits[0];
    if (!hit) return null;
    const mesh = hit.object;
    return this.parts.find((p) => p.mesh === mesh) ?? null;
  }

  private setHover(part: Part | null) {
    if (part === this.hovered) return;
    if (this.hovered) {
      const m = this.hovered.mesh.material as THREE.MeshBasicMaterial;
      if (this.hovered.kind === "face" && this.hovered.side) {
        // faces repaint their canvas; tinting the material would darken it
        this.repaintFace(this.hovered.side, false);
      } else {
        m.color.setHex(this.hovered.baseColor);
        m.opacity = NUB_IDLE_OPACITY;
      }
    }
    this.hovered = part;
    if (part) {
      const m = part.mesh.material as THREE.MeshBasicMaterial;
      if (part.kind === "face" && part.side) {
        this.repaintFace(part.side, true);
      } else {
        m.color.setHex(part.hoverColor);
        m.opacity = NUB_HOVER_OPACITY;
      }
      this.canvas.style.cursor = "pointer";
    } else {
      this.canvas.style.cursor = "";
    }
  }

  // ---- right-click context menu -------------------------------------------

  private openMenu(clientX: number, clientY: number, side: ViewCubeSide) {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "menu-popup viewcube-menu";
    menu.style.position = "fixed";
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    menu.style.minWidth = "200px";

    const has = !!this.hooks.getOverrides()[side];
    const items: Array<{ label: string; onClick: () => void; disabled?: boolean }> = [
      {
        label: t("viewport.cube.setFromFace", { side: FACE_VIEWS[side].label }),
        onClick: () => this.hooks.beginSetOverride(side),
      },
      {
        label: t("viewport.cube.resetDefault"),
        disabled: !has,
        onClick: () => {
          this.hooks.resetOverride(side);
          this.refreshOverrideMarks();
        },
      },
    ];
    for (const it of items) {
      const btn = document.createElement("button");
      btn.className = "menu-item";
      if (it.disabled) btn.toggleAttribute("disabled", true);
      const label = document.createElement("span");
      label.textContent = it.label;
      btn.appendChild(label);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeMenu();
        if (!it.disabled) it.onClick();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    // Keep it in the window. This popup is `position: fixed` at the raw
    // right-click coordinate and the cube lives in the TOP-RIGHT corner, so
    // nothing else bounds its right edge — with the viewport running to the
    // window edge it hung ~116px outside, unreachable. Flip it to the left of
    // the click instead, the same nudge contextMenu() does. offsetWidth, not
    // getBoundingClientRect: the pop-in keyframe starts at scale(.98), and a
    // rect read mid-animation measures 2% small.
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    if (clientX + mw > window.innerWidth) menu.style.left = `${Math.max(4, clientX - mw)}px`;
    if (clientY + mh > window.innerHeight) menu.style.top = `${Math.max(4, clientY - mh)}px`;
    this.menu = menu;
    // dismiss on the next outside pointerdown / Escape
    const onDown = (e: PointerEvent) => {
      if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closeMenu();
    };
    setTimeout(() => {
      document.addEventListener("pointerdown", onDown, { once: false });
      document.addEventListener("keydown", onKey);
      (menu as any)._cleanup = () => {
        document.removeEventListener("pointerdown", onDown);
        document.removeEventListener("keydown", onKey);
      };
    }, 0);
  }

  private closeMenu() {
    if (!this.menu) return;
    (this.menu as any)._cleanup?.();
    this.menu.remove();
    this.menu = null;
  }
}

// the 12 edge midpoint directions (two nonzero ±1 components)
function edgeDirs(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const ax = [-1, 1];
  for (const a of ax) for (const b of ax) {
    out.push(new THREE.Vector3(a, b, 0));
    out.push(new THREE.Vector3(a, 0, b));
    out.push(new THREE.Vector3(0, a, b));
  }
  return out;
}

// the 8 corner directions (all three components ±1)
function cornerDirs(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    out.push(new THREE.Vector3(x, y, z));
  }
  return out;
}
