// Tool-starter functions: the ~20 "start a modeling tool" entry points (Sketch,
// Extrude, Fillet, Chamfer, Split, Combine, Revolve, Loft, Sweep, Primitive,
// Shell, Draft, Pattern, Scale, Move, Press/Pull…) plus the interactive
// plane/face pickers they share. Each closes over the same large set of
// singletons/state owned by main.ts, passed in once via createFeatureStarters.
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { SketchOverlay } from "../sketch/overlay";
import type { SketchMode, SketchTool } from "../sketch/sketchMode";
import { SketchPlane } from "../sketch/plane";
import type { ExtrudeTool } from "./extrudeTool";
import type { EdgeFeatureTool } from "./edgeFeatureTool";
import type { PressPullTool } from "./pressPullTool";
import type { MoveTool } from "./moveTool";
import type { PlaneOffsetTool } from "./planeOffsetTool";
import { choose } from "../ui/choice";
import { setPrompt } from "../ui/prompt";
import type { Feature, PlaneDef, PlaneSpec, Selector } from "../types";

export interface FeatureStartersDeps {
  store: DocumentStore;
  viewport: Viewport;
  overlay: SketchOverlay;
  sketch: SketchMode;
  extrude: ExtrudeTool;
  edgeFeature: EdgeFeatureTool;
  pressPull: PressPullTool;
  moveTool: MoveTool;
  planeOffset: PlaneOffsetTool;
  canvas: HTMLCanvasElement;
  toolBusy: () => boolean;
  hasBody: () => boolean;
  setStatus: (text: string, cls: "" | "connected" | "error") => void;
  selectFeature: (id: string | null) => void;
  noteCommitted: (id: string | null) => void;
  isSketchConsumed: (id: string) => boolean;
  getSelectedFeature: () => string | null;
  setPlanePick: (v: boolean) => void;
}

export function createFeatureStarters(deps: FeatureStartersDeps) {
  const {
    store,
    viewport,
    overlay,
    sketch,
    extrude,
    edgeFeature,
    pressPull,
    moveTool,
    planeOffset,
    canvas,
    toolBusy,
    hasBody,
    setStatus,
    selectFeature,
    noteCommitted,
    isSketchConsumed,
    getSelectedFeature,
    setPlanePick,
  } = deps;

  // Interactive Fillet / Chamfer: pick an edge (or use a Ctrl-click pre-selection),
  // then drag an arrow to scrub the radius/distance with a live sidecar preview.
  const startFillet = () => {
    if (toolBusy()) return;
    edgeFeature.start("fillet", (id) => { noteCommitted(id); if (id) selectFeature(id); });
  };
  const startChamfer = () => {
    if (toolBusy()) return;
    edgeFeature.start("chamfer", (id) => { noteCommitted(id); if (id) selectFeature(id); });
  };
  // Interactive Press/Pull: pick a solid face, then drag an arrow along its normal
  // to add/cut material (planar) or offset a curved face — with a live preview.
  const startPressPull = () => {
    if (toolBusy()) return;
    pressPull.start((id) => { noteCommitted(id); if (id) selectFeature(id); });
  };

  function pickPlaneInteractive(promptText: string, onPick: (spec: PlaneSpec) => void) {
    if (toolBusy()) return;
    setPlanePick(true);
    viewport.showAllPlanes(true);
    viewport.suspendPicking = true;
    setPrompt(promptText);
    const onMove = (e: PointerEvent) => {
      // a face of the body takes priority over the base-plane quads behind it;
      // highlight whichever the click would select so the target is obvious.
      const face = viewport.pickFacePlane(e.clientX, e.clientY);
      if (face) {
        viewport.hoverFaceAt(e.clientX, e.clientY); // highlight a selectable body face
        viewport.hoverPlane(null);
      } else {
        viewport.clearHover();
        viewport.hoverPlane(viewport.pickPlane(e.clientX, e.clientY));
      }
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // a face of the body takes priority over the base-plane quads behind it
      const spec = viewport.pickFacePlane(e.clientX, e.clientY) ?? viewport.pickPlane(e.clientX, e.clientY);
      if (!spec) return;
      // consume this click fully and run on the NEXT frame, so it can't bleed
      // into the sketch's own first-corner placement.
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
      requestAnimationFrame(() => onPick(spec));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    const cleanup = () => {
      setPlanePick(false);
      viewport.showAllPlanes(false);
      viewport.suspendPicking = false;
      viewport.clearHover();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      setPrompt(null);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
  }

  function startSketch(tool?: SketchTool) {
    pickPlaneInteractive("Select a plane or a planar face of a body to sketch on", (spec) => {
      sketch.enter(spec, store);
      if (tool) sketch.setTool(tool);
    });
  }

  // Offset Plane: pick a plane/face, then drag an arrow (or type) to set the offset,
  // with a live ghost of the resulting plane; commit sketches on the offset plane.
  function offsetPlane() {
    pickPlaneInteractive("Select a plane or face to offset from", (spec) => {
      planeOffset.start(new SketchPlane(spec), (def) => {
        if (def) sketch.enter(def, store);
      });
    });
  }

  // Datum Plane: pick a plane/face, position it (offset), then save a persistent
  // datum plane feature — it lands in the timeline + Planes folder and can be
  // reused as a sketch / split reference. We store the SOURCE plane + a scalar
  // offset (not a baked plane) so the offset stays editable in the inspector.
  function createDatumPlane() {
    pickPlaneInteractive("Select a plane or face for the datum plane", (spec) => {
      const src = new SketchPlane(spec);
      planeOffset.start(src, (def) => {
        if (!def) return;
        const id = store.nextId();
        store.addFeature({ id, type: "datumPlane", plane: spec, offset: offsetAlong(def, src) } as Feature);
        selectFeature(id);
      });
    });
  }

  // Right-click → "Offset plane from face": same as Datum Plane but the source is
  // the right-clicked face (no separate pick step).
  function offsetPlaneFromFace(face: PlaneDef) {
    if (toolBusy()) return;
    const src = new SketchPlane(face);
    planeOffset.start(src, (def) => {
      if (!def) return;
      const id = store.nextId();
      store.addFeature({ id, type: "datumPlane", plane: face, offset: offsetAlong(def, src) } as Feature);
      selectFeature(id);
    });
  }

  // signed distance of an offset-tool result from its source plane, along the
  // source normal (mm) — the editable `offset` we store on the datum.
  function offsetAlong(def: PlaneDef, src: SketchPlane): number {
    return (
      (def.origin[0] - src.origin.x) * src.n.x +
      (def.origin[1] - src.origin.y) * src.n.y +
      (def.origin[2] - src.origin.z) * src.n.z
    );
  }

  // Split Body: choose which side(s) to keep, then pick + position a cutting plane.
  // Reuses the plane picker + offset gizmo so the cut lands exactly where you want.
  async function startSplit() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Split: create or import a body first", "");
      return;
    }
    // "select that plane and cut": a selected construction plane cuts ALL visible
    // bodies by id (startCutByPlane handles the keep-side prompt).
    const selId = getSelectedFeature();
    const sel = selId ? store.document.features.find((f) => f.id === selId) : null;
    if (sel?.type === "datumPlane") return void startCutByPlane(sel.id);

    const keep = await choose<"both" | "top" | "bottom">("Split Body — keep which side?", [
      { value: "both", label: "Both", hint: "two bodies" },
      { value: "top", label: "Top", hint: "+normal side" },
      { value: "bottom", label: "Bottom", hint: "−normal side" },
    ]);
    if (!keep) return;
    const bodies = store.buildState.result?.bodies ?? [];
    let body: string | undefined;
    if (bodies.length > 1) {
      const picked = await chooseBody("Which body to split?", bodies);
      if (!picked) return;
      body = picked;
    }
    pickPlaneInteractive("Select a plane or face to cut by", (spec) => {
      planeOffset.start(new SketchPlane(spec), (def) => {
        if (def) store.addFeature({ id: store.nextId(), type: "split", plane: def, keep, body, groupSides: true } as Feature);
      });
    });
  }

  // Cut ALL visible bodies by a construction plane (right-click a plane → Cut, or
  // select a plane + Split Body). Reuses the split feature with `planeId` + the list
  // of currently-visible body ids.
  async function startCutByPlane(planeId: string) {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Cut: create or import a body first", "");
      return;
    }
    const keep = await choose<"both" | "top" | "bottom">("Cut — keep which side?", [
      { value: "both", label: "Both", hint: "two bodies" },
      { value: "top", label: "Top", hint: "+normal side" },
      { value: "bottom", label: "Bottom", hint: "−normal side" },
    ]);
    if (!keep) return;
    const ids = (store.buildState.result?.bodies ?? [])
      .filter((b) => store.isBodyVisible(b.id))
      .map((b) => b.id);
    store.addFeature({ id: store.nextId(), type: "split", planeId, keep, bodies: ids, groupSides: true } as Feature);
  }

  // Combine: boolean-join/cut/intersect bodies. With exactly two bodies the first
  // is the (kept) target and the second the tool; with more, you pick the target
  // and the tool body so cut/intersect direction is unambiguous.
  async function startCombine() {
    if (toolBusy()) return;
    const bodies = store.buildState.result?.bodies ?? [];
    if (bodies.length < 2) {
      setStatus("Combine: needs at least two bodies — model or import another", "");
      return;
    }
    const op = await choose<"join" | "cut" | "intersect">("Combine bodies", [
      { value: "join", label: "Join", hint: "union" },
      { value: "cut", label: "Cut", hint: "subtract" },
      { value: "intersect", label: "Intersect", hint: "overlap" },
    ]);
    if (!op) return;

    // If the user already multi-selected bodies (Ctrl+click in the tree/viewport),
    // combine those directly: the first is the kept target, the rest are tools —
    // no dialogs. Otherwise fall back to picking a target (when ambiguous) and a
    // multi-select checklist of tool bodies.
    const pre = viewport.getSelectedBodies().filter((id) => bodies.some((b) => b.id === id));
    let target: string;
    let tools: string[];
    if (pre.length >= 2) {
      const first = pre[0];
      if (first === undefined) return;
      target = first;
      tools = pre.slice(1);
    } else {
      // ONE selected body (e.g. right-click → "Combine with…") is the kept target;
      // with none, pick a target when ambiguous. Tools come from the checklist.
      const t0 = pre[0] ?? bodies[0]?.id;
      if (t0 === undefined) return;
      target = t0;
      if (!pre.length && bodies.length > 2) {
        const t = await chooseBody("Target body (kept)", bodies);
        if (!t) return;
        target = t;
      }
      const candidates = bodies.filter((b) => b.id !== target);
      if (candidates.length > 1) {
        const { chooseMulti } = await import("../ui/choice");
        const picked = await chooseMulti<string>(
          "Tool bodies (combined into the target)",
          candidates.map((b) => ({ value: b.id, label: store.bodyName(b.id) ?? b.name })),
          { min: 1, confirmLabel: "Combine" },
        );
        if (!picked) return;
        tools = picked;
      } else {
        tools = candidates.map((b) => b.id);
      }
    }
    viewport.setSelectedBodies([]); // consumed tools would dangle; clear the selection
    store.addFeature({ id: store.nextId(), type: "combine", operation: op, target, tools } as Feature);
  }

  /** Pick one body by name from the rebuild's body list (returns its id). Labels use
   *  the sidebar rename override (store.bodyName) so the picker matches the browser
   *  tree — otherwise a renamed "Bracket" shows as the default "Body1" here. */
  function chooseBody(title: string, bodies: { id: string; name: string }[]): Promise<string | null> {
    return choose<string>(title, bodies.map((b) => ({ value: b.id, label: store.bodyName(b.id) ?? b.name })));
  }

  // Simplify Mesh: merge near-coplanar facets of the active (imported) body into
  // fewer, larger faces. Tune the angular tolerance in the inspector (higher =
  // fewer faces, but coarsens curved regions).
  function startSimplifyMesh() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Simplify Mesh: import or create a body first", "");
      return;
    }
    store.addFeature({ id: store.nextId(), type: "simplifyMesh", tolerance: 1 } as Feature);
  }

  // Clean Up: repair boolean rot on all bodies at this point in the timeline —
  // unify glued/overlapping solids, then collapse facet debris (slivers +
  // near-coplanar staircases). Booleans on ragged imports re-manufacture debris,
  // so run it again after a heavy Press/Pull / Combine session to keep Delete
  // Face and downstream booleans reliable. Best-effort in the sidecar: a body it
  // can't confidently clean passes through unchanged.
  function startCleanUp() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Clean Up: import or create a body first", "");
      return;
    }
    store.addFeature({ id: store.nextId(), type: "cleanUp" } as Feature);
    setStatus("Clean Up added — bodies unified + debris collapsed from here on", "");
  }

  // Scale: resize the active body about the origin (handy for fixing the units of
  // an import). Default factor 1 — set it in the inspector.
  function startScale() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Scale: create or import a body first", "");
      return;
    }
    store.addFeature({ id: store.nextId(), type: "scale", factor: 1 } as Feature);
  }

  // Move: translate / rotate the active body. Defaults to no-op — set the offsets
  // and angles in the inspector.
  function startMove() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Move: create or import a body first", "");
      return;
    }
    const bodies = store.buildState.result?.bodies ?? [];
    let ids = viewport.getSelectedBodies();
    if (!ids.length && bodies.length) {
      const lastBody = bodies[bodies.length - 1];
      if (lastBody) ids = [lastBody.id]; // none selected → active body
    }
    if (!ids.length) {
      setStatus("Move: select a body first (Select: Bodies)", "");
      return;
    }
    moveTool.start(ids, (id) => { noteCommitted(id); if (id) selectFeature(id); });
  }

  // Mirror: choose the symmetry plane (the backend honors XY/XZ/YZ; the old tool
  // was hard-coded to YZ). Mirrors the active body and unions the reflection.
  async function startMirror() {
    if (toolBusy()) return;
    const hasSolid = hasBody();
    if (!hasSolid) {
      setStatus("Mirror: create a body first", "");
      return;
    }
    const plane = await choose<"XY" | "XZ" | "YZ">("Mirror across plane", [
      { value: "XY", label: "XY" },
      { value: "XZ", label: "XZ" },
      { value: "YZ", label: "YZ" },
    ]);
    if (!plane) return;
    store.addFeature({ id: store.nextId(), type: "mirror", plane } as Feature);
  }

  // Revolve/Loft boolean into the active body (New/Join/Cut) the same way extrude
  // does, instead of the old silent overwrite of the active body's shape — so ask
  // upfront, same as the extrude op modal, just without the no-op-guess sorting.
  async function chooseSolidOperation(title: string): Promise<"new" | "join" | "cut" | null> {
    return choose<"new" | "join" | "cut">(title, [
      { value: "new", label: "New Body", hint: "separate" },
      { value: "join", label: "Join", hint: "merge" },
      { value: "cut", label: "Cut", hint: "remove" },
    ]);
  }

  // Revolve: spin a sketch profile around the X/Y/Z axis (defaults to a full 360°;
  // edit the angle in the inspector for a partial revolve). Uses the selected
  // profile area, or the only one if the sketch has just a single profile.
  async function startRevolve() {
    if (toolBusy()) return;
    const regions = overlay.selectedRegions();
    const wr = regions[0] ?? (overlay.regions.length === 1 ? overlay.regions[0] : null);
    if (!wr) {
      setStatus("Revolve: select a sketch profile to revolve first", "");
      return;
    }
    const axis = await choose<"X" | "Y" | "Z">("Revolve around axis", [
      { value: "X", label: "X axis" },
      { value: "Y", label: "Y axis" },
      { value: "Z", label: "Z axis" },
    ]);
    if (!axis) return;
    const operation = await chooseSolidOperation("Revolve — operation");
    if (!operation) return;
    store.addFeature({ id: store.nextId(), type: "revolve", sketch: wr.sketchId, axis, angle: 360, operation } as Feature);
  }

  // Loft: blend through two or more free (un-consumed) sketch profiles, in timeline
  // order. Sketches already used by another feature are excluded.
  async function startLoft() {
    if (toolBusy()) return;
    const free = store.document.features.filter(
      (f) => f.type === "sketch" && !isSketchConsumed(f.id),
    );
    if (free.length < 2) {
      setStatus("Loft: needs at least two un-consumed sketch profiles", "");
      return;
    }
    const operation = await chooseSolidOperation("Loft — operation");
    if (!operation) return;
    store.addFeature({ id: store.nextId(), type: "loft", sketches: free.map((f) => f.id), operation } as Feature);
  }

  // Sweep: select a closed profile region, then pick a second (open) sketch as the
  // path. The profile should sit at the start of the path, roughly perpendicular.
  async function startSweep() {
    if (toolBusy()) return;
    const regions = overlay.selectedRegions();
    const wr = regions[0] ?? (overlay.regions.length === 1 ? overlay.regions[0] : null);
    if (!wr) {
      setStatus("Sweep: select a profile sketch region first", "");
      return;
    }
    const all = store.document.features.filter((f) => f.type === "sketch");
    const candidates = all.filter((f) => f.id !== wr.sketchId);
    if (candidates.length === 0) {
      setStatus("Sweep: add a second sketch with an open curve for the path", "");
      return;
    }
    const label = (id: string) => `Sketch ${all.findIndex((f) => f.id === id) + 1}`;
    const c0 = candidates[0];
    if (!c0) return;
    let pathId = c0.id;
    if (candidates.length > 1) {
      const picked = await choose<string>("Pick the path sketch", candidates.map((f) => ({ value: f.id, label: label(f.id) })));
      if (!picked) return;
      pathId = picked;
    }
    store.addFeature({ id: store.nextId(), type: "sweep", profile: wr.sketchId, path: pathId, operation: "new" } as Feature);
  }

  // Primitive: drop a Box / Cylinder / Sphere body at the origin (edit its size in
  // the inspector). Useful as a starting block or as a boolean tool body.
  async function startPrimitive() {
    if (toolBusy()) return;
    const shape = await choose<"box" | "cylinder" | "sphere">("Create primitive", [
      { value: "box", label: "Box", hint: "l×w×h" },
      { value: "cylinder", label: "Cylinder", hint: "r, h" },
      { value: "sphere", label: "Sphere", hint: "r" },
    ]);
    if (!shape) return;
    const id = store.nextId();
    if (shape === "box") store.addFeature({ id, type: "box", length: 20, width: 20, height: 20 } as Feature);
    else if (shape === "cylinder") store.addFeature({ id, type: "cylinder", radius: 10, height: 20 } as Feature);
    else store.addFeature({ id, type: "sphere", radius: 10 } as Feature);
  }

  // One-shot face picker: highlight the face under the cursor, return its selector
  // on click (Esc cancels). Reused by Shell (open face) and Draft (taper face).
  function pickFaceInteractive(promptText: string, onPick: (sel: Selector) => void) {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Create or import a body first", "");
      return;
    }
    setPlanePick(true);
    viewport.suspendPicking = true;
    setPrompt(promptText);
    const onMove = (e: PointerEvent) => void viewport.hoverFaceAt(e.clientX, e.clientY);
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const hit = viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cleanup();
      requestAnimationFrame(() => onPick(hit.selector));
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    const cleanup = () => {
      setPlanePick(false);
      viewport.suspendPicking = false;
      viewport.clearHover();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      setPrompt(null);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
  }

  // Shell: pick a face to open, hollow the body to a 2mm wall (edit thickness in
  // the inspector).
  function startShell() {
    pickFaceInteractive("Select a face to open for the shell · Esc to cancel", (faces) => {
      store.addFeature({ id: store.nextId(), type: "shell", thickness: 2, faces } as Feature);
    });
  }

  // Draft: pick a face to taper by 5° about the body's base (pull +Z; edit the
  // angle in the inspector).
  function startDraft() {
    pickFaceInteractive("Select a face to draft · Esc to cancel", (faces) => {
      store.addFeature({ id: store.nextId(), type: "draft", faces, angle: 5, axis: "Z" } as Feature);
    });
  }

  // Pattern: replicate the active body — rectangular grid or circular array. Edit
  // counts / spacing / angle in the inspector.
  async function startPattern() {
    if (toolBusy()) return;
    if (!hasBody()) {
      setStatus("Pattern: create or import a body first", "");
      return;
    }
    const kind = await choose<"rect" | "circular">("Pattern type", [
      { value: "rect", label: "Rectangular", hint: "grid" },
      { value: "circular", label: "Circular", hint: "around axis" },
    ]);
    if (!kind) return;
    const id = store.nextId();
    if (kind === "rect") {
      store.addFeature({ id, type: "patternRect", countX: 3, countY: 1, spacingX: 30, spacingY: 30 } as Feature);
    } else {
      store.addFeature({ id, type: "patternCircular", count: 4, angle: 360, axis: "Z" } as Feature);
    }
  }

  function startExtrude() {
    if (toolBusy()) return;
    // A SELECTED FACE wins: extrude-a-face = Press/Pull it (drag out to join, in to
    // cut). This takes priority over region extrude so a visible sketch never hijacks
    // "extrude this face" (was: a shown sketch forced region-extrude, so face cut did
    // nothing).
    if (viewport.selectedFacesForPressPull()) {
      pressPull.start((id) => { noteCommitted(id); if (id) selectFeature(id); });
      return;
    }
    if (overlay.regions.length === 0) {
      setStatus("Extrude: select a face, or create a sketch with a closed profile first", "");
      return;
    }
    extrude.start((id) => { noteCommitted(id); if (id) selectFeature(id); });
  }

  return {
    startFillet,
    startChamfer,
    startPressPull,
    startSketch,
    offsetPlane,
    createDatumPlane,
    offsetPlaneFromFace,
    startSplit,
    startCutByPlane,
    startCombine,
    startSimplifyMesh,
    startCleanUp,
    startScale,
    startMove,
    startMirror,
    startRevolve,
    startLoft,
    startSweep,
    startPrimitive,
    startShell,
    startDraft,
    startPattern,
    startExtrude,
  };
}

export type FeatureStarters = ReturnType<typeof createFeatureStarters>;
