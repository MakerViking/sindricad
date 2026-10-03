// Client cache for sidecar-tessellated glyph outlines. The sidecar owns all font
// work, so text preview outlines come from the `tessellateText` op — cached by a
// content key so identical text/font/style/anchor reuses the result and re-renders
// are instant. On a cache miss the op fires and the overlay re-renders on arrival.
//
// AT MOST ONE REQUEST PER TEXT ENTITY IS IN FLIGHT. The typing preview is a new
// entity on every keystroke, and this used to send every one of them. The sidecar
// answers one request at a time, in order, and each costs time in proportion to
// the WHOLE string (about 4 ms a character inside a box), so a card typed at a
// normal pace queued work faster than it could be done: a 175-character card in a
// rectangle showed nothing while typing and appeared 72 s after Add, and Finish
// Sketch waited behind the same queue. Now a keystroke that lands while its text
// is still being drawn is not sent; when the reply comes back, the repaint it
// triggers asks for whatever the text says by then. Keystrokes in between are
// skipped, never queued.
//
// THE LAST OUTCOME STAYS ON SCREEN until the next one lands, so a text being typed
// never blinks out between replies. Only at the same anchor, or when moving it is
// all that changed (a drag): the sidecar places a free text by translating it to
// its anchor, so the last outline moved by the same amount is the exact answer.
// Anything else shows nothing rather than an old outline in the wrong place.
//
// A FAILURE IS KEPT, NOT SWALLOWED. A font with no glyph for one character (an
// emoji on a birthday card) refuses the whole string, and that refusal used to be
// cached as "no outlines": the text vanished and nothing said why until Finish
// Sketch. `textFailure` hands the reason to whoever can show it, and
// `textPlaceholder` gives the text a frame in its place, so there is something
// to see, click, drag and double-click to fix. A failure that carries no verdict
// on the text itself (the connection dropped, the engine was down) is asked
// again after RETRY_MS; any other is kept for that exact text, and changing the
// text or the font asks again.

import type { GeometryBackend, TextFace } from "../geometry/client";
import type { GeomErrorCode } from "../types";
import { featureErrorText } from "../geometry/featureErrorText";
import { t } from "../i18n";
import * as THREE from "three";
import type { ResolvedEntity } from "./snap";

type TextEntity = Extract<ResolvedEntity, { type: "text" }>;

/** Why a text has no outlines: the sidecar's message, and its code when it gave one. */
export interface TextFailure {
  message: string;
  code?: GeomErrorCode;
}

/** How long a failure that says nothing about the text waits before it is asked again. */
const RETRY_MS = 5000;

const cache = new Map<string, TextFace[]>();
const failures = new Map<string, { failure: TextFailure; retryAt: number }>();
const pending = new Set<string>();
/** Entity ids with a request in flight: the one-per-entity limit. */
const busy = new Set<string>();
/** Bumped by forgetText, so a reply for what an id used to be is not shown as
 *  what it is now. */
const generation = new Map<string, number>();
/** Outlines, or why there are none. */
type Outcome = { faces: TextFace[] } | { failure: TextFailure };
/** Per entity id, its newest outcome and where: the last one drawn, or the last
 *  one to land, whichever came later. Landing counts because while the text is
 *  typed faster than it is drawn, every reply is for a string already typed past
 *  and none is ever the current one; counting only those would freeze the
 *  preview at the last outline that kept up (measured: 67 of 175 glyphs).
 *  `shape` is everything but the anchor (see shapeOf); `moved` remembers the
 *  last translated copy, so a drag frame drawn twice is translated once. */
interface Shown {
  x: number;
  y: number;
  shape: string;
  outcome: Outcome;
  moved?: { x: number; y: number; outcome: Outcome };
}
const shown = new Map<string, Shown>();
let backend: { geom: GeometryBackend; rerender: () => void } | null = null;

/** Wire the geometry backend + a "re-render everything" callback once at startup.
 *  warmText() uses these to fetch glyph outlines and repaint when they land. */
export function setTextBackend(geom: GeometryBackend, rerender: () => void): void {
  backend = { geom, rerender };
}

/** Everything that decides a text's outlines except where it is anchored. */
function shapeOf(e: TextEntity): string {
  return JSON.stringify([
    e.text, e.font ?? "", e.height, e.style ?? "regular", e.align ?? "left",
    e.angle, e.pathRef ?? "", e.positionOnPath ?? "", e.boxWidth ?? "",
  ]);
}

// x and y are in the key because the sidecar returns the outlines already placed
// at the anchor: without them a copy, a mirror or a second identical text drew
// on top of the first one.
function keyOf(e: TextEntity): string {
  return `${shapeOf(e)}@${e.x},${e.y}`;
}

function translatedFaces(faces: TextFace[], dx: number, dy: number): TextFace[] {
  const move = (loop: [number, number][]): [number, number][] => loop.map(([x, y]) => [x + dx, y + dy]);
  return faces.map((f) => ({ outer: move(f.outer), holes: f.holes.map(move) }));
}

/** The outcome to show for `e`: its own when one has landed, otherwise the
 *  entity's newest one (see `shown`) while its own is on the way: as it is at the
 *  same anchor, moved with it when the anchor is all that changed. */
function outcome(e: TextEntity): Outcome | undefined {
  const k = keyOf(e);
  const faces = cache.get(k);
  const failure = failures.get(k)?.failure;
  const own: Outcome | undefined = faces ? { faces } : failure ? { failure } : undefined;
  if (own) {
    shown.set(e.id, { x: e.x, y: e.y, shape: shapeOf(e), outcome: own });
    return own;
  }
  const last = shown.get(e.id);
  if (!last) return undefined;
  if (last.x === e.x && last.y === e.y) return last.outcome;
  // A text on a path is placed by the path, so its anchor says nothing about where
  // it is drawn; and a moved text whose string or font changed too is not the same
  // outline moved.
  if (e.pathRef || last.shape !== shapeOf(e)) return undefined;
  // A font that cannot draw the text cannot draw it anywhere else either.
  if ("failure" in last.outcome) return last.outcome;
  if (last.moved?.x !== e.x || last.moved.y !== e.y) {
    const faces = translatedFaces(last.outcome.faces, e.x - last.x, e.y - last.y);
    last.moved = { x: e.x, y: e.y, outcome: { faces } };
  }
  return last.moved.outcome;
}

/** Forget what was last shown for entity `id`. The typing preview reuses one id
 *  for every text placed, so a new one would otherwise start out showing the
 *  last one's outline, or a reply for it still on the way. */
export function forgetText(id: string): void {
  shown.delete(id);
  busy.delete(id);
  generation.set(id, (generation.get(id) ?? 0) + 1);
}

/** Synchronous read for the renderer: the outlines to draw for `e`, or undefined
 *  when there are none yet or none at all (`textFailure` says which). */
export function getCachedText(e: TextEntity): TextFace[] | undefined {
  const o = outcome(e);
  return o && "faces" in o ? o.faces : undefined;
}

/** Why `e` has no outlines, or undefined when it has them or they are on the way. */
export function textFailure(e: TextEntity): TextFailure | undefined {
  const o = outcome(e);
  return o && "failure" in o ? o.failure : undefined;
}

/** The sentence to show for a failure. The font refusals are whole sentences that
 *  name the characters and a font that has them, so they stand as they are; the
 *  rest are fragments ("geometry engine connection lost") and get framed. A
 *  failure that is not about the text says it will be tried again, since editing
 *  the text or picking another font would not help. */
export function textFailureText(f: TextFailure): string {
  const said = featureErrorText(f, undefined);
  if (f.code === "fontMissingGlyphs" || f.code === "fontUnusable") return said;
  const reason = said.replace(/[.\s]+$/, "");
  return aboutTheText(f) ? t("sketch.text.notDrawn", { reason }) : t("sketch.text.notDrawnRetry", { reason });
}

/** Average glyph advance as a fraction of the text height. Measured: "Hei Åse"
 *  at 10 mm is 36.3 mm wide in the default font, 0.52 a character. */
const ADVANCE = 0.55;
/** Line pitch as a fraction of the text height. */
const LINE_PITCH = 1.2;

/** A frame where a text that draws nothing sits, roughly as big as the text would
 *  be, or undefined when it draws (or has not answered yet). A text the font
 *  refuses has no glyphs, and glyphs are all the sketch could see, click, drag or
 *  double-click on: it was invisible and could not be reached to fix, even though
 *  the message said to edit it. The frame is laid out the way the sidecar lays
 *  out the text: centred on the anchor vertically, aligned on it horizontally,
 *  wrapped to its box, rotated about the anchor. Returned closed, in sketch
 *  coordinates. */
export function textPlaceholder(e: TextEntity): THREE.Vector2[] | undefined {
  const o = outcome(e);
  const empty = o && "faces" in o && o.faces.length === 0 && e.text.trim() !== "";
  if (!o || !("failure" in o || empty)) return undefined;
  const h = e.height > 0 ? e.height : 10;
  const widthOf = (line: string) => Math.max(1, [...line].length) * h * ADVANCE;
  const lines = e.text.split("\n");
  const box = e.boxWidth && e.boxWidth > 0 ? e.boxWidth : 0;
  const w = box || Math.max(...lines.map(widthOf));
  const rows = box ? lines.reduce((n, l) => n + Math.max(1, Math.ceil(widthOf(l) / box)), 0) : lines.length;
  const tall = h * (1 + (rows - 1) * LINE_PITCH);
  const align = e.align ?? "left";
  const x0 = align === "center" ? -w / 2 : align === "right" ? -w : 0;
  const a = (e.angle * Math.PI) / 180;
  const c = Math.cos(a), sn = Math.sin(a);
  const corners: [number, number][] = [[x0, -tall / 2], [x0 + w, -tall / 2], [x0 + w, tall / 2], [x0, tall / 2], [x0, -tall / 2]];
  return corners.map(([u, v]) => new THREE.Vector2(e.x + u * c - v * sn, e.y + u * sn + v * c));
}

/** System font families for the text tool's picker (via the wired backend). */
export function fetchFonts(): Promise<string[]> {
  return backend ? backend.geom.listFonts() : Promise.resolve([]);
}

/** A failure that says nothing about the text: the request never got an answer. */
function noVerdict(code: GeomErrorCode | undefined): boolean {
  return code === undefined || code === "engineUnavailable" || code === "cancelled";
}

/** Is this failure about the text itself (the font, the string), rather than the
 *  engine being unreachable? The app already reports a lost engine on its own. */
export function aboutTheText(f: TextFailure): boolean {
  return !noVerdict(f.code);
}

/** Record a failure for key `k`. */
function fail(k: string, failure: TextFailure): TextFailure {
  const retryAt = noVerdict(failure.code) ? Date.now() + RETRY_MS : Infinity;
  failures.set(k, { failure, retryAt });
  return failure;
}

/** Idempotently ensure every text entity's glyph outlines are cached: fire
 *  `tessellateText` for misses and re-render when results land. Safe to call on every
 *  paint — cached/in-flight entities are skipped, so the render loop converges.
 *  `entities` is the full resolved list so a text's `pathRef` sibling can be sent. */
export function warmText(entities: ResolvedEntity[]): void {
  if (!backend) return;
  const geom = backend.geom;
  const byId = new Map(entities.map((e) => [e.id, e]));
  const now = Date.now();
  for (const e of entities) {
    if (e.type !== "text") continue;
    const k = keyOf(e);
    if (cache.has(k) || pending.has(k) || busy.has(e.id)) continue;
    if (now < (failures.get(k)?.retryAt ?? 0)) continue;
    pending.add(k);
    busy.add(e.id);
    const gen = generation.get(e.id) ?? 0;
    const current = () => (generation.get(e.id) ?? 0) === gen;
    const pathEntity = e.pathRef ? byId.get(e.pathRef) : undefined;
    geom
      .tessellateText(e, pathEntity)
      .then((r): Outcome => {
        if (r.error) return { failure: fail(k, r.error) };
        cache.set(k, r.faces);
        failures.delete(k);
        return { faces: r.faces };
      })
      .catch((err: unknown): Outcome => ({ failure: fail(k, { message: err instanceof Error ? err.message : String(err) }) }))
      .then((landed) => {
        if (current()) shown.set(e.id, { x: e.x, y: e.y, shape: shapeOf(e), outcome: landed });
      })
      .finally(() => {
        pending.delete(k);
        if (current()) busy.delete(e.id);
        backend?.rerender();
      });
  }
}
