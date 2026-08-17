// Interactive Extrude (MCAD-style): select one or more profile AREAS, then set
// the distance by moving the cursor along the profile normal (live solid preview +
// arrow manipulator + numeric box). Areas can be pre-selected in the sketch or
// picked here: plain click picks one and starts the depth drag, Ctrl-click adds
// more (Enter to confirm the set). A ring (annulus) area previews/extrudes as a
// tube; selecting several areas unions them. Operation auto-selects: New Body when
// nothing exists, otherwise Cut when the profile pushes into an existing body and
// Join when it pulls away (both overridable in the commit dialog).

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { RegionRef, SketchOverlay, WorldRegion } from "../sketch/overlay";
import type { DocumentStore } from "../document/store";
import type { Feature } from "../types";
import { pointInRegion } from "../sketch/region";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { axisDragDistance } from "./manipulator";
import { choose } from "../ui/choice";

type Phase = "pick" | "drag";
type Op = "new" | "join" | "cut" | "intersect";

/** One area of the feature being edited that the tool could not resolve, held
 *  exactly as the document has it so commit can put it back untouched. */
type CarriedRegion = {
  region: [number, number, number];
  entityIds: string[];
  holeEntityIds: string[][];
};

export class ExtrudeTool {
  active = false;
  private phase: Phase = "pick";
  private selected: WorldRegion[] = [];
  private distance = 10;
  private preview: THREE.Group | null = null;
  private previewMat: THREE.MeshStandardMaterial | null = null;
  private previewKey = ""; // depth+sign+selection of the built preview geometry
  private arrow: THREE.ArrowHelper | null = null;
  private dim = new DimInput();
  private hitScratch = new THREE.Vector3();
  private onDone: ((id: string | null) => void) | null = null;

  // --- edit mode (re-opening a committed extrude) ---
  private editId: string | null = null; // committed feature id being edited
  private editOp: Op | null = null; // saved operation (pre-sorted first in the modal)
  private editHiddenBodies: string[] | undefined; // participants captured at creation — KEPT
  /** Areas of the feature being edited that this tool could NOT resolve, held
   *  exactly as the document has them and written straight back on commit. See
   *  startEdit: without this, editing the depth of a feature whose sketch has
   *  partly changed DELETES the areas the tool could not draw. */
  private editCarried: CarriedRegion[] = [];
  /** while editing, this sketch is forced visible so its regions exist
   *  (consumed sketches hide by default) — main.ts's isSketchVisible honors it. */
  forcedSketchId: string | null = null;

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;

  constructor(
    private viewport: Viewport,
    private overlay: SketchOverlay,
    private store: DocumentStore,
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
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown);
    window.addEventListener("keydown", this.boundKey, true);
    // honour any areas pre-selected in the sketch
    this.selected = this.overlay.selectedRegions();
    if (this.selected.length) {
      this.beginDrag();
    } else {
      setPrompt("Select a profile to extrude · Ctrl-click adds areas · Enter to confirm");
    }
  }

  /** Re-open a committed extrude for editing: the model rolls back to just
   *  before it, its sketch is forced visible, the saved profile areas are
   *  pre-selected, and the saved distance seeds (and locks) the input — retype
   *  or Ctrl-click areas, then commit to REPLACE the feature in place (same id,
   *  one undo step). Returns false when the distance is a parameter expression
   *  (the inspector's job). */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f || f.type !== "extrude") return false;
    if (typeof f.distance !== "number" || this.store.isParamBound({ kind: "feature", feature: f.id, field: "distance" }))
      return false; // parameter-driven distance — inspector's job

    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.editId = featureId;
    this.editOp = f.operation;
    this.editHiddenBodies = f.hiddenBodies;
    this.distance = f.distance;
    this.forcedSketchId = f.sketch;

    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown);
    window.addEventListener("keydown", this.boundKey, true);

    // roll the model back so the pre-extrude state is what previews/op-guesses
    // see (exactly what the tool saw at creation), then rebuild the overlay so
    // the now-forced-visible sketch contributes regions to select from.
    this.store.beginEditPreview(featureId);
    this.overlay.update(this.store.document);
    const saved: [number, number, number][] = (
      f.regions ?? (f.region ? [f.region] : [])
    ) as [number, number, number][];
    // Resolve each area by the ENTITIES it was picked on, not by its stored
    // point. The point does not move with the geometry (field a20cca53), and on
    // a holed profile a stale point lands inside the HOLE — containment
    // succeeds, the hole's own cell comes back selected, and committing any
    // edit (a bare depth change is enough) writes that hole over the feature.
    // That is field 19314fdc's other half: the sidecar builds the wall while the
    // edit tool reopens on the hole. Documents with no ids keep the point path
    // exactly, which is what the sidecar does too (`if not eids ... return None`).
    const ents = f.regionEntities;
    let unresolved: RegionRef[] = [];
    if (ents?.length) {
      const answer = this.overlay.selectRegionsByEntities(
        f.sketch,
        saved.map((p, i) => ({
          entityIds: ents[i] ?? [],
          // `undefined` (not `[]`) when this document never recorded them: every
          // file written between 0.1.123 and the release that added the field
          // names outer loops only, and "unknown holes" must not read as "no
          // holes" — see regionsByEntities.
          holeEntityIds: f.regionHoleEntities?.[i],
          point: p,
        })),
      );
      unresolved = answer.unresolved;
      // The regions the IDS resolved, not what the overlay lights up. Reading
      // the selection back instead round-trips this answer through a world
      // point, and `selectedRegions` re-resolves a point against every coplanar
      // sketch — so a neighbouring sketch's region joined the feature and
      // commit wrote it (route B: 18000 mm³ of wall became 50000 mm³, and the
      // feature's `sketch` field was rewritten to the neighbour, on nothing but
      // a depth change). Identity established by ids is kept as identity.
      this.selected = answer.resolved;
    } else {
      this.overlay.selectRegionsByPoints(saved);
      this.selected = this.editSelection();
    }
    if (this.selected.length) {
      // An area the tool cannot show is still an area of the FEATURE. Writing
      // back only what is selected would delete it on a bare depth change — one
      // ordinary gesture, no confirmation, geometry gone, which is the same
      // class of silent corruption this whole fix exists to remove. So the
      // references that did not resolve are carried through commit byte for
      // byte: this tool has no opinion about an area it could not find, and the
      // sidecar's own resolution rule is not this one (it accepts references
      // this refuses, and falls back to the stored point otherwise), so the
      // build is unaffected either way. They are dropped only when the user
      // changes the area set, because that gesture re-states the set — see
      // onDown.
      this.editCarried = unresolved.flatMap((ref) =>
        // a reference with no point names nothing and points nowhere, so there
        // is nothing to preserve; every reference built above has one.
        ref.point
          ? [{
              region: ref.point,
              entityIds: ref.entityIds,
              // absent hole ids carry as `[]`, which is what the sidecar already
              // makes of absent (`for grp in (hole_eids or [])`), so this records
              // no claim the document did not already make.
              holeEntityIds: ref.holeEntityIds ?? [],
            }]
          : [],
      );
      this.beginDrag();
      if (unresolved.length) {
        // beginDrag sets its own prompt, so this replaces it. An area whose ids
        // no longer name a cell is NOT quietly re-resolved from its point: the
        // sketch really did change, and a wrong area committed in silence is the
        // whole defect. Say which, and say what happens to it.
        setPrompt(
          `Editing extrude: ${unresolved.length} of ${saved.length} areas no longer match the sketch ` +
            "and are kept unchanged · changing the area set drops them · " +
            "type a value + Enter · click to commit · Esc to cancel",
        );
      }
    } else {
      // Nothing resolved, so there is no depth edit to protect and nothing is
      // carried (`editCarried` is left empty, as cleanup leaves it): the user
      // states the areas again from the pick phase, and what they pick is the
      // feature's new area set. Carrying references into a set the user is
      // building by hand would silently ADD areas instead of preserving them.
      const one = saved.length === 1;
      setPrompt(
        `Editing extrude: its ${one ? "area was" : `${saved.length} areas were`} not found ` +
          `(sketch changed?) · what you pick replaces ${one ? "it" : "them"} · ` +
          "select a profile · Esc to cancel",
      );
    }
    return true;
  }

  /** The overlay's selection, cut down to the sketch this edit belongs to.
   *
   *  A feature names ONE sketch (`Feature.sketch`), so an area from another one
   *  cannot be part of it — but `selectedRegions` matches by world point and
   *  accepts any region within ~1e-3 mm of the plane, so a second sketch drawn
   *  on the SAME plane hands back its regions too. Committing those wrote a
   *  foreign sketch's area into the feature AND retargeted `sketch` to it, on a
   *  reopen and a click. Outside edit mode this changes nothing (the pick phase
   *  is the user stating the set from scratch). */
  private editSelection(): WorldRegion[] {
    const sel = this.overlay.selectedRegions();
    const own = this.forcedSketchId;
    if (!this.editId || own === null) return sel;
    return sel.filter((wr) => wr.sketchId === own);
  }

  /** True when this click is on another sketch's area while editing — refused
   *  out loud, because silently ignoring it is the affordance bug and silently
   *  taking it is the geometry bug. */
  private refusesForeignRegion(r: WorldRegion): boolean {
    if (!this.editId || this.forcedSketchId === null) return false;
    if (r.sketchId === this.forcedSketchId) return false;
    setPrompt(
      "That area belongs to a different sketch · an extrude uses one sketch, so this edit " +
        "can only use its own · Esc, then extrude the other sketch separately",
    );
    return true;
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const r = this.regionUnder(e.clientX, e.clientY);
      this.overlay.setHoverRegion(r);
      this.viewport.domElement.style.cursor = r ? "pointer" : "default";
      return;
    }
    if (!this.selected.length) return;
    const first = this.selected[0];
    if (!first) return;
    const plane = first.plane;
    const anchor = this.anchor();
    if (!this.dim.isUserDriven("distance")) {
      const d = axisDragDistance(this.viewport, e.clientX, e.clientY, anchor, plane.n);
      this.distance = d;
      this.dim.updateFromCursor({ distance: Math.abs(d) });
    } else {
      const v = this.dim.getValue("distance");
      if (v != null) this.distance = v; // the field is the truth: typed sign wins
    }
    this.positionDim(anchor);
    this.updatePreview();
  }

  /** Park the depth input at a STABLE spot near the profile — anchored to the
   *  selection center (which doesn't move while you drag depth), offset off the
   *  geometry and clamped inside the viewport. Following the cursor made the box
   *  (and its buttons) impossible to click. */
  private positionDim(anchor: THREE.Vector3 = this.anchor()) {
    const s = this.viewport.projectToScreen(anchor);
    const rect = this.viewport.domElement.getBoundingClientRect();
    const boxW = 160, boxH = 46, m = 12;
    const fx = Math.max(rect.left + m, Math.min(s.x + 28, rect.right - boxW - m));
    const fy = Math.max(rect.top + m, Math.min(s.y + 28, rect.bottom - boxH - m));
    this.dim.position(fx - 16, fy - 16); // dim.position adds a +16 cursor offset
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const r = this.regionUnder(e.clientX, e.clientY);
      if (!r) return;
      if (this.refusesForeignRegion(r)) return;
      e.preventDefault();
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      this.overlay.toggleRegionSelection(r, additive);
      this.selected = this.editSelection();
      // plain click picks one area and goes straight to depth; Ctrl-click keeps
      // accumulating (Enter confirms the set)
      if (!additive && this.selected.length) this.beginDrag();
    } else {
      e.preventDefault();
      // A modifier-held click means "change the area set", not "commit". Edit mode
      // is otherwise a trap: startEdit restores the saved areas and goes straight
      // to drag, so beginDrag's "Ctrl-click areas to add/remove" prompt had no
      // reachable handler and every attempt to drop an area committed instead.
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        const r = this.regionUnder(e.clientX, e.clientY);
        if (!r) return; // modifier on empty space: do nothing rather than commit
        if (this.refusesForeignRegion(r)) return;
        this.overlay.toggleRegionSelection(r, true);
        this.selected = this.editSelection();
        // The user is now stating the area set by hand, so the unmatched areas
        // startEdit was holding on their behalf stop applying — keeping them
        // would ADD an area to whatever is picked here. This is the one place
        // the edit can lose an area, and it says so instead of doing it quietly.
        const dropped = this.editCarried.length;
        this.editCarried = [];
        if (!this.selected.length) {
          // emptied: updatePreview early-returns without disposing, so the old
          // preview would hang in the scene. Drop it and go back to picking.
          this.phase = "pick";
          this.disposePreviewGeom();
          this.previewKey = "";
          // Hide the depth box too. Leaving it up was a trap: its Enter/✓
          // callback still points at commit(), whose first guard bails to
          // cancel() on an empty selection — so typing Enter after removing the
          // last area silently threw the whole extrude away, while the prompt
          // said "select a profile". onKey defers to the input while it has
          // focus, so nothing else intercepted it. (GitHub issue #14.)
          this.dim.hide();
          setPrompt(
            (dropped ? `${dropped} unmatched ${dropped === 1 ? "area is" : "areas are"} no longer kept · ` : "") +
              "Select a profile to extrude · Ctrl-click adds areas · Enter to confirm",
          );
          return;
        }
        this.updatePreview();
        if (dropped) {
          setPrompt(
            `Editing extrude: ${dropped} unmatched ${dropped === 1 ? "area is" : "areas are"} ` +
              "no longer kept, pick again if the feature still needs " +
              `${dropped === 1 ? "it" : "them"} · Ctrl-click areas to add/remove · ` +
              "type a value + Enter · click to commit · Esc to cancel",
          );
        }
        return;
      }
      void this.commit();
    }
  }

  private onKey(e: KeyboardEvent) {
    if (this.dim.isActive && e.target instanceof HTMLInputElement) {
      if (e.key === "Escape") this.cancel();
      return;
    }
    if (e.key === "Escape") this.cancel();
    else if (e.key === "Enter" && this.phase === "pick" && this.selected.length) this.beginDrag();
  }

  private beginDrag() {
    this.phase = "drag";
    this.overlay.setHoverRegion(null);
    this.dim.show([{ name: "distance", label: "D" }], () => void this.commit(), () => this.cancel());
    if (this.editId) {
      // seed the SIGNED saved distance and lock the field (userDriven): extrude's
      // onMove free-tracks the cursor and would clobber the seed on the first
      // move otherwise. Cursor-scrub is deliberately off in edit mode — retype
      // or commit. (Seeding the abs value would silently drop a cut's sign the
      // moment getValue is read back — the DimInput abs-display trap.)
      this.dim.seed("distance", this.distance);
      setPrompt(
        "Editing extrude: Ctrl-click areas to add/remove · type a value + Enter · " +
          "click to commit · Esc to cancel (later features are hidden while editing)",
      );
    } else {
      this.distance = 10;
      // Advertise the area toggle here too. The pick-phase prompt says
      // "Ctrl-click adds areas", but a plain click jumps straight to drag, so a
      // user who picked one of several profiles landed here and was told only
      // how to set depth — the reporter of issue #14 concluded the other closed
      // sections simply could not be selected. The handler existed; nothing
      // said so.
      setPrompt(
        "Move to set depth · Ctrl-click areas to add/remove · type a value + Enter · " +
          "negative = cut · click to commit · Esc to cancel",
      );
    }
    this.positionDim();
    this.updatePreview();
  }

  // --- geometry helpers ---
  /** the front-most region whose material (loop minus holes) contains the cursor */
  private regionUnder(cx: number, cy: number): WorldRegion | null {
    const ray = this.viewport.rayFrom(cx, cy).ray;
    let best: WorldRegion | null = null;
    let bestDist = Infinity;
    for (const wr of this.overlay.regions) {
      if (!ray.intersectPlane(wr.plane.plane, this.hitScratch)) continue;
      const p2d = wr.plane.to2D(this.hitScratch);
      if (!pointInRegion(p2d, wr.region)) continue;
      const d = ray.origin.distanceToSquared(this.hitScratch);
      if (d < bestDist) {
        bestDist = d;
        best = wr;
      }
    }
    return best;
  }

  /** average of the selected areas' interior points — the arrow anchor */
  private anchor(): THREE.Vector3 {
    const a = new THREE.Vector3();
    for (const wr of this.selected) a.add(wr.interior3D);
    return a.divideScalar(this.selected.length || 1);
  }

  private updatePreview() {
    if (!this.selected.length) return;
    const sign = this.distance >= 0 ? 1 : -1;
    const depth = Math.abs(this.distance);
    const cut = sign < 0;

    const ids = this.selected
      .map((s) => `${s.sketchId}:${s.interior3D.x.toFixed(2)},${s.interior3D.y.toFixed(2)}`)
      .join("|");
    const key = `${depth.toFixed(3)}:${sign}:${ids}`;
    if (key !== this.previewKey) {
      this.previewKey = key;
      this.disposePreviewGeom();
      if (!this.previewMat) {
        this.previewMat = new THREE.MeshStandardMaterial({
          transparent: true,
          opacity: 0.5,
          metalness: 0.1,
          roughness: 0.6,
        });
      }
      this.preview = new THREE.Group();
      for (const wr of this.selected) {
        const shape = new THREE.Shape(wr.region.loop.map((p) => p.clone()));
        for (const h of wr.region.holes) {
          shape.holes.push(new THREE.Path(h.map((p) => p.clone())));
        }
        const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
        geo.applyMatrix4(wr.plane.basisMatrix(sign)); // local +Z -> plane normal (flipped on cut)
        this.preview.add(new THREE.Mesh(geo, this.previewMat));
      }
      this.viewport.addToScene(this.preview);
    }
    this.previewMat?.color.set(cut ? 0xff5c5c : 0x5b9bff);

    // arrow manipulator along the (shared) normal, anchored at the selection center
    const first = this.selected[0];
    if (!first) return;
    const plane = first.plane;
    const anchor = this.anchor();
    const dir = plane.n.clone().multiplyScalar(sign);
    if (!this.arrow) {
      this.arrow = new THREE.ArrowHelper(dir, anchor, depth || 1, 0xffd24a, 6, 3);
      this.viewport.addToScene(this.arrow);
    } else {
      this.arrow.position.copy(anchor);
      this.arrow.setDirection(dir);
      this.arrow.setLength(Math.max(depth, 1), 6, 3);
    }
  }

  // Default operation: New Body when the doc has no solid yet, else Cut/Join by
  // whether the extrude direction pushes INTO existing material or away from it
  // (a face pushed inward reads as Cut, pulled outward as Join — MCAD parity).
  // This replaced a pure drag-SIGN guess, which defaulted "push a face through the
  // model" to Join and silently no-op'd (the union was already inside the body).
  private entersSolid(): boolean {
    if (!this.selected.length) return false;
    const sign = this.distance >= 0 ? 1 : -1;
    let inside = 0;
    for (const wr of this.selected) {
      // step the area's interior a hair along the extrude direction, off its face
      const p = wr.interior3D.clone().addScaledVector(wr.plane.n, sign * 0.05);
      if (this.viewport.pointInSolid(p)) inside++;
    }
    return inside * 2 > this.selected.length; // majority of selected areas
  }

  private currentOperation(): Op {
    const hasSolid = (this.store.buildState.result?.mesh.positions.length ?? 0) > 0;
    if (!hasSolid) return "new";
    return this.entersSolid() ? "cut" : "join";
  }

  private committing = false;
  private async commit() {
    if (this.committing) return;
    if (!this.selected.length) return this.cancel();
    const v = this.dim.getValue("distance");
    // GATE on isUserDriven: while dragging, the field displays |distance| —
    // reading it back unconditionally strips the drag's sign and sends the
    // extrude the wrong way ("Cut removed nothing" on cut-toward-body).
    // Typed values (userDriven) carry their own sign and win.
    if (v != null && this.dim.isUserDriven("distance")) this.distance = v;
    if (Math.abs(this.distance) < 1e-3) return; // ignore zero
    let op = this.currentOperation();
    // when a body already exists, let the user state the operation (MCAD-style):
    // New Body avoids any boolean (and the kernel crash on hard geometry).
    const hasSolid = (this.store.buildState.result?.mesh.positions.length ?? 0) > 0;
    if (hasSolid) {
      this.committing = true;
      // in edit mode the SAVED operation is the presumptive choice; otherwise
      // the direction-derived guess is.
      let guess = this.editId ? (this.editOp ?? op) : op;
      // All-glyph profile (sketch text): a flush emboss on a body direction-
      // guesses "join", but joined text can never print in its own color — bias
      // the default to New Body so the two-tone path is one Enter away. Cut
      // (engraving) guesses stay untouched.
      const isTextProfile = this.selected.every((wr) => wr.entityId !== undefined);
      if (!this.editId && isTextProfile && guess === "join") guess = "new";
      // op === "cut" ⇔ the extrude direction enters solid (currentOperation).
      // Flag whichever op would then do nothing, so the choice is informed.
      const into = op === "cut";
      const opts: { value: Op; label: string; hint: string }[] = [
        { value: "join", label: "Join", hint: into ? "⚠ likely no effect (profile is inside)" : "merge" },
        { value: "cut", label: "Cut", hint: into ? "remove" : "⚠ nothing to cut here" },
        { value: "new", label: "New Body", hint: isTextProfile ? "separate — assign its own print color" : "separate" },
        { value: "intersect", label: "Intersect", hint: "keep overlap" },
      ];
      opts.sort((a, b) => (a.value === guess ? -1 : b.value === guess ? 1 : 0)); // default first
      const chosen = await choose<Op>("Extrude — operation", opts);
      this.committing = false;
      if (!chosen) {
        // modal dismissed — the tool is STILL ALIVE; say so instead of leaving
        // the user staring at an unchanged screen ("nothing happened")
        setPrompt("Extrude not committed — Enter/✓ to choose an operation · Esc to cancel");
        return;
      }
      op = chosen;
    } else if (this.editId && this.editOp) {
      // rolled-back model has no solid (this WAS the first solid) — keep the
      // saved operation rather than silently rewriting it to "new".
      op = this.editOp;
    }
    const first = this.selected[0];
    if (!first) return;
    const hiddenBodies = this.editId ? this.editHiddenBodies : this.store.hiddenBodyIds();
    const feature: Feature = {
      id: this.editId ?? this.store.nextId(),
      type: "extrude",
      // `first` is safe to read the sketch off ONLY because the selection is
      // fenced to one sketch: `selectRegionsByEntities` resolves within the
      // feature's own sketch and `editSelection` filters the rest to it. Before
      // that fence, a coplanar neighbour that sorted earlier in the timeline
      // became `first` and re-targeted the whole feature's `sketch` — silently,
      // on a depth change. Fence and field move together; do not derive this
      // from a selection that is not fenced.
      sketch: first.sketchId,
      distance: Math.round(this.distance * 1000) / 1000,
      operation: op,
      regions: [
        ...this.selected.map(
          (wr) => [wr.interior3D.x, wr.interior3D.y, wr.interior3D.z] as [number, number, number],
        ),
        ...this.editCarried.map((c) => c.region),
      ],
      // The entities that bound each area, recorded so the reference survives the
      // user moving the geometry it was picked on. `regions` alone is a world
      // point, and a point does not move with the circle it was inside — it ends
      // up in whatever profile now covers it (field report a20cca53).
      //
      // `editCarried` is appended to all three arrays, in step: those are the
      // areas of the feature being edited that this tool could not resolve, and
      // they go back untouched. Writing only `selected` would delete them, so a
      // depth change on a feature whose sketch has partly moved would quietly
      // shrink the solid. Order across areas carries no meaning (they union), so
      // appending is safe.
      regionEntities: [
        ...this.selected.map((wr) => wr.region.entityIds),
        ...this.editCarried.map((c) => c.entityIds),
      ],
      // the holes' own bounding entities, so the sidecar can rebuild the face
      // WITH its holes. Without these it rebuilds a SOLID face whose centre sits
      // inside the hole and resolves to the wrong cell (field 19314fdc).
      regionHoleEntities: [
        ...this.selected.map((wr) => wr.region.holeEntityIds ?? []),
        ...this.editCarried.map((c) => c.holeEntityIds),
      ],
      // capture the participants NOW: bodies hidden at creation stay excluded
      // from this boolean forever; later eye toggles are pure display. When
      // EDITING, the ORIGINAL capture is kept — re-capturing here would let
      // display toggles rewrite committed boolean history.
      ...(hiddenBodies !== undefined ? { hiddenBodies } : {}),
    };
    const id = feature.id;
    if (this.editId) {
      this.store.endEditPreview(false); // replaceFeature triggers the rebuild
      this.store.replaceFeature(this.editId, feature);
    } else {
      this.store.addFeature(feature);
    }
    this.overlay.clearRegionSelection();
    this.cleanup();
    this.onDone?.(id);
  }

  cancel() {
    if (this.editId) {
      this.store.endEditPreview();
      this.overlay.clearRegionSelection();
    }
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    this.dim.hide();
    this.disposePreviewGeom();
    this.previewMat?.dispose();
    this.previewMat = null;
    this.previewKey = "";
    if (this.arrow) {
      this.viewport.removeFromScene(this.arrow);
      this.arrow.dispose();
      this.arrow = null;
    }
    this.overlay.setHoverRegion(null);
    this.viewport.suspendPicking = false;
    this.active = false;
    this.selected = [];
    this.editCarried = [];
    if (this.editId !== null || this.forcedSketchId !== null) {
      this.editId = null;
      this.editOp = null;
      this.editHiddenBodies = undefined;
      this.forcedSketchId = null;
      this.overlay.update(this.store.document); // re-hide the consumed sketch
    }
    setPrompt(null);
  }

  /** remove + dispose the preview group's geometries (the material is reused) */
  private disposePreviewGeom() {
    if (!this.preview) return;
    this.viewport.removeFromScene(this.preview);
    for (const child of this.preview.children) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    this.preview = null;
  }
}
