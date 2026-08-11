// Viewport (Three.js) colours — one source of truth.
//
// Why this file exists: these values were previously scattered across 17 files,
// with `HANDLE_IDLE`/`HANDLE_HOT` copy-pasted identically into six tool modules
// and the idle-edge colour declared independently in three. A copied constant
// drifts silently — nothing fails, the viewport just stops agreeing with itself.
//
// Colours are `number` (0xRRGGBB) because that is what THREE.Color, materials
// and helpers take directly. Where a colour is deliberately shared with the CSS
// theme, the matching token is named in a comment and the `#rrggbb` form is
// exported alongside so the two can never be edited apart.

/** 0xRRGGBB → "#rrggbb", for the handful of places that paint into a canvas or
 *  an inline style rather than a Three.js material. */
export function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

// --- edges -----------------------------------------------------------------

/** Normal, unemphasised edge. */
export const EDGE_IDLE = 0x1b1f24;
/** Muted ember: an edge that is selectable right now (fillet/chamfer mode). */
export const EDGE_PICKABLE = 0xd98a4a;
/** Pale hot amber: the edge under the cursor. */
export const EDGE_HOVER = 0xffd089;

// --- selection -------------------------------------------------------------

/** Molten amber for SELECTED geometry. Matches the CSS `--accent` — the same
 *  brand colour means "this is the thing you picked" in chrome and in 3D. */
export const SELECT = 0xff7a3c;
/** Hover/active brighten. Matches CSS `--accent-hot`. */
export const SELECT_HOT = 0xff9a5c;

/** The edge a fillet/chamfer failed on. Highest paint precedence — hover and
 *  select must never overwrite it, or the "which edge is the problem" signal
 *  disappears the moment the user mouses over it. */
export const ERROR = 0xe23b3b;

// --- manipulator handles ---------------------------------------------------
// Shared by every drag handle (press/pull, offset face, offset plane, section,
// edge features, text on face) so they feel like one mechanism.

/** A handle at rest. */
export const HANDLE_IDLE = 0xffc83d;
/** A handle under the cursor or being dragged. */
export const HANDLE_HOT = 0xffe9a8;
/** A handle whose drag direction REMOVES material (cut / push in). */
export const HANDLE_CUT = 0xff6b5c;

// --- analysis / flags ------------------------------------------------------

/** Unsupported overhang in draft analysis. Matches CSS `--danger-action`, which
 *  the overhang legend uses, so the legend swatch and the model agree. */
export const OVERHANG = 0xe24a3b;
export const OVERHANG_CSS = hex(OVERHANG);
/** Solver conflict. Matches CSS `--flag-conflict`: the 2D dimension badge and
 *  the 3D curve turn the same colour for the same condition. */
export const CONFLICT = 0xff4444;
export const CONFLICT_CSS = hex(CONFLICT);
