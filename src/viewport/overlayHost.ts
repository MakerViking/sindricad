// Where an overlay positioned by projecting world points onto the canvas has to
// mount. #viewport-overlay (index.html) is clipped to the viewport, so a label
// whose anchor leaves the canvas is cut off at the edge instead of painting —
// and hit-testing — over the browser tree, the inspector or the ribbon.

let warnedNoHost = false;

/** The clipping layer inside #viewport. Falls back to <body> when there is no
 *  page around us (unit runs against the DOM stub), which is what these layers
 *  did before the clip existed: a component must stay constructible off-page.
 *  That fallback IS the reported bug, though — body-level labels float over the
 *  panels — so it says so once rather than degrading in silence. */
export function overlayHost(): HTMLElement {
  const host = document.getElementById("viewport-overlay");
  if (host) return host;
  if (!warnedNoHost) {
    warnedNoHost = true;
    console.warn(
      "#viewport-overlay is missing: projected overlays fall back to <body>, " +
        "where they are neither clipped to the viewport nor positioned in its coordinates.",
    );
  }
  return document.body;
}

/** NDC (x,y in -1..1, y pointing up) to pixels measured from the rect's own
 *  top-left corner. This is all the arithmetic wrapped around THREE's own
 *  `.project()`, and the reason a label can be told apart from one that has
 *  left the canvas: an NDC coordinate outside -1..1 lands outside
 *  [0, width] / [0, height]. */
export function ndcToRect(
  v: { x: number; y: number },
  rect: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: (v.x * 0.5 + 0.5) * rect.width,
    y: (-v.y * 0.5 + 0.5) * rect.height,
  };
}

/** Has a Viewport.projectToOverlay point left the canvas? A label anchored
 *  there must not be drawn: the clip would only cut it in half, and half a
 *  badge still takes the click that belonged to the panel underneath. A
 *  non-finite projection (a degenerate camera) counts as off-canvas too. */
export function outsideRect(p: { x: number; y: number; width: number; height: number }): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return true;
  return p.x < 0 || p.y < 0 || p.x > p.width || p.y > p.height;
}

/** Where to draw the one label that must stay on screen after its anchor has
 *  left the canvas: the badge holding an open value editor. Culling it would
 *  drop the caret mid-keystroke, and leaving it at the projected point parks it
 *  outside the clip — still focused, still committing on Enter, invisible. So
 *  pin it to the nearest edge, inset by half its own size so the whole badge is
 *  inside the clip rather than trimmed to a sliver. A badge that cannot fit is
 *  centred on that axis: there is no inset that would hold it. */
export function clampIntoRect(
  p: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  const pin = (v: number, extent: number, half: number) => {
    const middle = extent / 2;
    if (!Number.isFinite(v)) return middle;
    const lo = Math.min(half, middle);
    const hi = Math.max(extent - half, middle);
    return Math.min(Math.max(v, lo), hi);
  };
  return {
    x: pin(p.x, p.width, size.width / 2),
    y: pin(p.y, p.height, size.height / 2),
  };
}
