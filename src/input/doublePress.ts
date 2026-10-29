// Double-click recognition for handlers registered on `pointerdown`.
//
// Two browser facts, both measured against /usr/bin/chromium (the engine class
// the app ships on):
//
//  - `PointerEvent.detail` is 0 on pointerdown — `mousedown` carries 1 then 2,
//    pointerdown never does. So an `e.detail >= 2` gate inside a pointerdown
//    handler is dead code.
//  - Once a pointerdown handler DETACHES the element it fired on, Chromium
//    fires neither `click` nor `dblclick` — not on the element, not on its
//    container, not on the body. Anything that rebuilds its own UI from
//    pointerdown therefore cannot wait for `dblclick`.
//
// What is left is the press's own time and position.

/** The OS double-click window is typically 500 ms; a little tighter than that,
 *  with the same 4 px slop the drag thresholds use, so two deliberate separate
 *  clicks stay two separate clicks. */
export const DOUBLE_PRESS_MS = 400;
export const DOUBLE_PRESS_PX = 4;

/** The previous primary press: when, and where on screen. */
export type PressRecord = { t: number; x: number; y: number } | null;

/** Feed EVERY primary press through this, including ones the caller goes on to
 *  ignore — skipping presses drifts the pairing onto the wrong two. `double` is
 *  true when this press is the second of a pair; the returned `next` is then
 *  null, so a third press opens a fresh pair instead of reading as another
 *  double. Kept as a pure step rather than a closure so a class can hold the
 *  record in an ordinary field. */
export function stepDoublePress(
  prev: PressRecord | undefined,
  e: { clientX: number; clientY: number; timeStamp?: number },
): { next: PressRecord; double: boolean } {
  // The event's own time, not the time the handler got to run: a main thread
  // busy for half a second (a rebuild, a slow machine) delivers two presses
  // 200 ms apart as if they were 500 ms apart, and the double-press is lost.
  const now = { t: e.timeStamp && e.timeStamp > 0 ? e.timeStamp : performance.now(), x: e.clientX, y: e.clientY };
  if (!prev) return { next: now, double: false };
  const dx = now.x - prev.x, dy = now.y - prev.y;
  const near = dx * dx + dy * dy <= DOUBLE_PRESS_PX ** 2;
  const soon = now.t - prev.t <= DOUBLE_PRESS_MS;
  return near && soon ? { next: null, double: true } : { next: now, double: false };
}
