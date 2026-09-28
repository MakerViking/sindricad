// The Split Body panel's state, as plain data and pure functions.
//
// Everything the panel DECIDES lives here, so it can be tested without a DOM,
// a viewport or a sidecar: which field takes the next click, what a
// preselection fills, what a pick does to each field, what feature OK writes,
// whether the plane can possibly cut the targets, and where the preview
// section of the plane lies. splitTool.ts only wires these to the canvas, the
// Browser and the panel.
//
// Why a panel and not the dialogs it replaces (plan B1): the old flow asked
// "keep which side?", then offered a list of every body by name, then a plane.
// On an imported assembly that list had 340 near-identical names, and a
// selected datum plane silently switched the whole command to "cut every
// visible body" (featureStarters.ts before this change). Two fields you fill by
// clicking the model, with the active one lit, remove both traps.

import type { Plane3, PlaneDef, Selector } from "../types";

export type SplitKeep = "both" | "top" | "bottom";

/** What the plane is anchored to. `face` follows the face on rebuild the way a
 *  face-anchored datum does; `fixed` is the baked plane an older split carried
 *  (it only appears when such a split is re-opened, and stays as it was unless
 *  the user picks something else). */
export type SplitToolRef =
  | { kind: "face"; plane: PlaneDef; face: Selector }
  | { kind: "datum"; id: string }
  | { kind: "origin"; plane: Plane3 }
  | { kind: "fixed"; plane: PlaneDef };

export type SplitField = "body" | "tool";

export interface SplitState {
  /** explicit targets, in pick order */
  bodies: string[];
  /** "All visible bodies (N)": the list is read when OK is pressed */
  allVisible: boolean;
  tool: SplitToolRef | null;
  /** The field a plain canvas click fills. Null once both are filled: then a
   *  plain click in the model changes nothing, and re-picking one starts by
   *  clicking its field. Left armed, a press that missed the offset arrow (a
   *  3 px shaft drawn over the middle of the body) landed on the body's face
   *  and silently re-aimed the cut, keeping the offset: an XY cut at +12 mm on
   *  a 20 mm body became the top face's plane +12, clear of the body. */
  active: SplitField | null;
  /** mm along the plane normal, applied on top of the tool's plane */
  offset: number;
  keep: SplitKeep;
}

/** What an entry point already knows: the Browser row a body menu was opened
 *  on, or the datum a plane menu was opened on. */
export interface SplitSeed {
  bodies?: string[];
  planeId?: string;
}

/** The first field still empty, or null when both are filled. */
export function firstEmptyField(s: Pick<SplitState, "bodies" | "allVisible" | "tool">): SplitField | null {
  if (!s.allVisible && s.bodies.length === 0) return "body";
  if (!s.tool) return "tool";
  return null;
}

export function hasTargets(s: Pick<SplitState, "bodies" | "allVisible">): boolean {
  return s.allVisible || s.bodies.length > 0;
}

/** The state the panel opens with.
 *
 *  Preselection, in the order the plan fixes (B1): selected bodies fill Body; a
 *  selected datum plane, or ONE selected flat face, fills Tool. A seed from a
 *  right-click menu wins over the ambient selection for its own field, because
 *  it names the row or plane the user just clicked. Ids the last build does not
 *  know are dropped rather than written into a feature that would then point at
 *  nothing. The first empty field is the active one; with both filled, none is
 *  (see `active`). */
export function initialSplitState(input: {
  seed?: SplitSeed | undefined;
  selectedBodies: readonly string[];
  liveBodies: readonly string[];
  selectedDatum: string | null;
  selectedFace: { plane: PlaneDef; face: Selector } | null;
}): SplitState {
  const live = new Set(input.liveBodies);
  const bodies = (input.seed?.bodies ?? input.selectedBodies).filter((id, i, all) => live.has(id) && all.indexOf(id) === i);
  const planeId = input.seed?.planeId ?? input.selectedDatum;
  const tool: SplitToolRef | null = planeId
    ? { kind: "datum", id: planeId }
    : input.selectedFace
      ? { kind: "face", plane: input.selectedFace.plane, face: input.selectedFace.face }
      : null;
  const s = { bodies, allVisible: false, tool };
  return { ...s, active: firstEmptyField(s), offset: 0, keep: "both" };
}

/** A body clicked in the canvas or the Browser.
 *
 *  A plain click REPLACES the targets and moves on to the tool if that is still
 *  empty. Ctrl toggles one body and leaves the active field where it was,
 *  WHICHEVER field that is: Ctrl-click means "this body too" everywhere (a
 *  Browser row always did), and a click on Body that moved on to Tool must not
 *  turn the next Ctrl-click into a splitting-plane pick on that body's face
 *  (the verify run: the Ctrl-click replaced the plane instead of adding the
 *  body). Emptied by a Ctrl-click, Body is active again. Either way an explicit
 *  pick ends "All visible": the user just said which body they mean. */
export function pickBody(s: SplitState, id: string, additive: boolean): SplitState {
  if (additive) {
    const base = s.allVisible ? [] : s.bodies;
    const bodies = base.includes(id) ? base.filter((b) => b !== id) : [...base, id];
    return { ...s, bodies, allVisible: false, active: bodies.length ? s.active : "body" };
  }
  return { ...s, bodies: [id], allVisible: false, active: s.tool ? null : "tool" };
}

/** A plane or flat face picked as the splitting tool. Moves to Body when that
 *  is still empty, otherwise disarms (see `active`). The offset is kept: it is
 *  a distance from whatever plane is chosen. */
export function pickTool(s: SplitState, tool: SplitToolRef): SplitState {
  return { ...s, tool, active: hasTargets(s) ? null : "body" };
}

export function setAllVisible(s: SplitState, on: boolean): SplitState {
  const next = { ...s, allVisible: on };
  return { ...next, active: firstEmptyField(next) };
}

export function clearField(s: SplitState, field: SplitField): SplitState {
  return field === "body"
    ? { ...s, bodies: [], allVisible: false, active: "body" }
    : { ...s, tool: null, active: "tool" };
}

export function activate(s: SplitState, field: SplitField): SplitState {
  return { ...s, active: field };
}

/** The split feature a document holds, as the panel writes and reads it. */
export interface SplitFeatureShape {
  id: string;
  type: "split";
  keep: SplitKeep;
  groupSides?: boolean;
  body?: string;
  bodies?: string[];
  /** "All visible bodies (N)" was the choice: `bodies` is the visible ids as
   *  they stood at OK. The sidecar keeps a body such a split misses quiet (a
   *  plane through an assembly misses most of it), and names one an explicit
   *  pick misses. Absent on explicit picks, never written false. */
  allVisible?: true;
  plane?: Plane3 | PlaneDef;
  planeId?: string;
  face?: Selector;
  offset?: number | string;
}

export type BuildResult =
  | { feature: SplitFeatureShape }
  | { missing: "body" | "tool" };

/** The feature OK writes: exactly the contract in types.ts.
 *
 *  - one explicit body is `body`; several, or "All visible", is `bodies` (the
 *    visible ids as they stand at OK, which is what "Cut all bodies" wrote);
 *  - "All visible" also writes `allVisible: true`, and ONLY it does: that is
 *    how the sidecar tells a cut the user aimed at every body (a missed body is
 *    expected, and stays quiet) from bodies the user picked one by one (a
 *    missed one is named, amber chip and toast);
 *  - a face tool writes the face's plane AND the face selector, so the cut
 *    follows the face on rebuild; a datum writes `planeId`; an origin plane its
 *    name;
 *  - `offset` is always written, as a number, so a saved split says where it
 *    cuts without anyone knowing the default;
 *  - `groupSides` is written exactly as given: true for every new split (one
 *    body per separate piece, Q2), and on an edit whatever the split already
 *    had, absent included. Body ids are positional, and an old split without
 *    it must keep producing the same number of bodies. */
export function buildSplitFeature(
  s: SplitState,
  ctx: { id: string; visibleBodies: readonly string[]; groupSides: boolean | undefined },
): BuildResult {
  const targets = s.allVisible ? [...ctx.visibleBodies] : [...s.bodies];
  if (!targets.length) return { missing: "body" };
  if (!s.tool) return { missing: "tool" };
  const f: SplitFeatureShape = { id: ctx.id, type: "split", keep: s.keep };
  if (ctx.groupSides !== undefined) f.groupSides = ctx.groupSides;
  if (s.allVisible || targets.length > 1) f.bodies = targets;
  else f.body = targets[0]!;
  if (s.allVisible) f.allVisible = true;
  switch (s.tool.kind) {
    case "face":
      f.plane = s.tool.plane;
      f.face = s.tool.face;
      break;
    case "datum":
      f.planeId = s.tool.id;
      break;
    case "origin":
    case "fixed":
      f.plane = s.tool.plane;
      break;
  }
  f.offset = s.offset;
  return { feature: f };
}

/** Re-open a saved split. Null when the offset is a parameter expression: the
 *  panel's field holds a number, and an expression belongs to the inspector,
 *  exactly as fillet/texture decline for the same reason. A split with neither
 *  `body` nor `bodies` (an older one that cut "the active body") opens with
 *  Body empty; the tool fills it from the rolled-back model.
 *
 *  `resolvedFace` is where the last build found a face-anchored split's face
 *  (RebuildResult.planes, before the offset). The cut follows the face, so the
 *  preview, the arrow and the offset have to start from there: `f.plane` is
 *  only where the face was when it was picked, and dragging from it wrote an
 *  offset measured from a plane the sidecar no longer uses. */
export function stateFromFeature(f: SplitFeatureShape, resolvedFace?: PlaneDef): SplitState | null {
  if (f.offset !== undefined && typeof f.offset !== "number") return null;
  const bodies = f.bodies ? [...f.bodies] : f.body ? [f.body] : [];
  // An "All visible" split re-opens as one. So does an OLD split with `bodies`:
  // before the panel the only thing that wrote `bodies` was "Cut all bodies".
  // Re-opened as that many explicit picks, any edit OK'd would have written
  // them as picks, and every body the plane misses would then be named as a
  // warning (a plane through an assembly misses most of it).
  const allVisible = f.allVisible === true || (isLegacySplit(f) && !!f.bodies?.length);
  let tool: SplitToolRef | null = null;
  // The sidecar's precedence (builder._split_plane): `face` first, then
  // `planeId`, then `plane`. The panel never writes a face beside a planeId, but
  // a document can carry both, and re-opening it as the datum would drop the
  // face on OK and move a cut the user did not touch.
  if (f.face && f.plane && typeof f.plane !== "string") tool = { kind: "face", plane: resolvedFace ?? f.plane, face: f.face };
  else if (f.planeId) tool = { kind: "datum", id: f.planeId };
  else if (typeof f.plane === "string") tool = { kind: "origin", plane: f.plane };
  else if (f.plane) tool = { kind: "fixed", plane: f.plane };
  const s = { bodies, allVisible, tool };
  return { ...s, active: firstEmptyField(s), offset: f.offset ?? 0, keep: f.keep };
}

/** A split saved before this panel: it carries neither `offset` (the panel
 *  always writes one) nor `face`, and the sidecar rebuilds it through the old
 *  whole-body computation (builder._split_is_legacy), whose piece ORDER decides
 *  which piece sits behind every later positional body id. Anything that writes
 *  one of those keys onto it makes it a panel split, which cuts part by part. */
export function isLegacySplit(f: { offset?: unknown; face?: unknown }): boolean {
  return f.offset === undefined && !f.face;
}

/** The feature an edit writes back.
 *
 *  A split saved before this panel carries neither `offset` nor `face`, and the
 *  sidecar rebuilds exactly those the old way (isLegacySplit): the old
 *  computation decides which piece sits behind which positional body id. So an
 *  old split OK'd with nothing that matters changed (same bodies, plane and
 *  keep, offset 0) is written back EXACTLY as it was; writing `offset: 0` onto
 *  it would re-order its pieces under every later feature that names one. A
 *  real change gives a panel split, which cuts part by part.
 *
 *  `convert` is the exception: the old way FAILED on this split, or cut damaged
 *  parts and lost material (splitLegacyFailed, splitLegacyVolume). Those
 *  messages say "edit the split and press OK to cut it part by part", so OK
 *  does exactly that, changed or not.
 *
 *  `autoBody` is the body the panel filled in for an old split that named none
 *  (it cut "the active body"): leaving it that way is not a change.
 *
 *  Nor is an old "Cut all bodies" left on All visible, which is how it
 *  re-opens (stateFromFeature). All visible lists the bodies visible when OK
 *  is pressed, so a body hidden or shown since the split was made would read
 *  as a new target list, and an untouched OK stopped cutting the hidden one. */
export function editedSplit(orig: SplitFeatureShape, next: SplitFeatureShape, autoBody: string | null, convert = false): SplitFeatureShape {
  if (convert || !isLegacySplit(orig)) return next;
  if (next.face || (next.offset ?? 0) !== 0) return next;
  const targets = (f: SplitFeatureShape, auto: string | null) =>
    JSON.stringify(f.bodies ?? (f.body ? [f.body] : auto ? [auto] : []));
  const stillCutAll = !!orig.bodies?.length && next.allVisible === true;
  const sameTargets = stillCutAll || targets(orig, autoBody) === targets(next, null);
  const plane = (f: SplitFeatureShape) => f.planeId ?? JSON.stringify(f.plane ?? null);
  const same = orig.keep === next.keep && sameTargets && plane(orig) === plane(next);
  return same ? orig : next;
}

/** Which surface under the cursor a Tool click takes, from the two ray hit
 *  distances. The NEAREST wins, as it does for any pick; a datum wins a tie,
 *  because a datum plane lying ON a face is the case Thomas hit (a datum
 *  anchored to a face of Skjermdeksel at z=0), and there the face click and the
 *  datum click name the same plane but only the datum is the thing he made to
 *  cut with. `tol` is in world mm along the ray. */
export function chooseToolHit(faceDist: number | null, datumDist: number | null, tol: number): "face" | "datum" | null {
  if (datumDist !== null && (faceDist === null || datumDist <= faceDist + tol)) return "datum";
  if (faceDist !== null) return "face";
  return null;
}

export type V3 = readonly [number, number, number];
export interface Box {
  min: V3;
  max: V3;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function corners(b: Box): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

/** True when every corner of `box` lies strictly on one side of the plane, by
 *  more than `tol`: then no body inside the box can be cut, and OK can say so
 *  before a rebuild does. A plane ON a face of the box is NOT a miss (Q1: a
 *  plane lying on a face separates the parts either side, and says so). */
export function planeMissesBox(origin: V3, normal: V3, box: Box, tol: number): boolean {
  let above = 0;
  let below = 0;
  for (const c of corners(box)) {
    const d = dot(sub(c, origin), normal);
    if (d > tol) above++;
    else if (d < -tol) below++;
    else return false;
  }
  return above === 0 || below === 0;
}

/** The polygon where the plane crosses `box`, ordered around its centre, for
 *  the preview: the plane is drawn clipped to the targets rather than as a
 *  fixed 60 mm quad (plan B4/B5). Empty when the plane misses the box. */
export function planeBoxSection(origin: V3, normal: V3, box: Box): [number, number, number][] {
  const c = corners(box);
  // the 12 edges of the box, as index pairs into `c` (x-major, then y, then z)
  const edges: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7], // along z
    [0, 2], [1, 3], [4, 6], [5, 7], // along y
    [0, 4], [1, 5], [2, 6], [3, 7], // along x
  ];
  const d = c.map((p) => dot(sub(p, origin), normal));
  const pts: [number, number, number][] = [];
  const push = (p: [number, number, number]) => {
    if (!pts.some((q) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) + Math.abs(q[2] - p[2]) < 1e-9)) pts.push(p);
  };
  for (const [i, j] of edges) {
    const di = d[i]!;
    const dj = d[j]!;
    const a = c[i]!;
    const b = c[j]!;
    if (di === 0) push(a);
    if (dj === 0) push(b);
    if ((di < 0 && dj > 0) || (di > 0 && dj < 0)) {
      const tt = di / (di - dj);
      push([a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt, a[2] + (b[2] - a[2]) * tt]);
    }
  }
  if (pts.length < 3) return [];
  const mean = (k: 0 | 1 | 2) => pts.reduce((acc, p) => acc + p[k], 0) / pts.length;
  const centre: V3 = [mean(0), mean(1), mean(2)];
  // an in-plane frame to sort by angle
  const n = normal;
  const ref: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const r = dot(ref, n);
  const u: [number, number, number] = [ref[0] - n[0] * r, ref[1] - n[1] * r, ref[2] - n[2] * r];
  const ul = Math.hypot(...u) || 1;
  const uu: V3 = [u[0] / ul, u[1] / ul, u[2] / ul];
  const vv: V3 = [n[1] * uu[2] - n[2] * uu[1], n[2] * uu[0] - n[0] * uu[2], n[0] * uu[1] - n[1] * uu[0]];
  return pts
    .map((p) => ({ p, a: Math.atan2(dot(sub(p, centre), vv), dot(sub(p, centre), uu)) }))
    .sort((x, y) => x.a - y.a)
    .map((x) => x.p);
}

/** A body as a build reports it: its id and the etag its geometry has. */
export interface BodyStamp {
  id: string;
  etag?: string | undefined;
}

/** The bodies to select once the split has built: every target the split
 *  CHANGED (its etag moved) plus every body the rebuild added. A target the
 *  plane missed is left exactly as it was, and is not a piece: "All visible"
 *  on the 340-body field file selected all 583 bodies, the 193 it missed
 *  included, and the next Move or Export acted on the whole assembly. Only
 *  meaningful when the split was appended at the END of the timeline: body ids
 *  are positional, so a split inserted earlier renumbers every later body and
 *  "new since before" would select strangers. The caller checks that. */
export function resultingPieces(targets: readonly string[], before: readonly BodyStamp[], after: readonly BodyStamp[]): string[] {
  const had = new Map(before.map((b) => [b.id, b.etag]));
  const now = new Map(after.map((b) => [b.id, b.etag]));
  const cut = targets.filter((id) => now.has(id) && (now.get(id) === undefined || now.get(id) !== had.get(id)));
  const added = after.map((b) => b.id).filter((id) => !had.has(id));
  return [...cut, ...added.filter((id) => !cut.includes(id))];
}
