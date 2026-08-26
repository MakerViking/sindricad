// The active tool's icon, riding just below-right of the pointer.
//
// Why it exists: in a sketch the only thing telling you which tool is armed is
// the ribbon highlight and the #prompt banner, both at the far edges of the
// screen while your eyes are on the geometry. Issue #17 asked for the icon to
// follow the pointer, which is where mainstream MCAD puts it — and the same
// blindness produced field report c9db7ec2 ("no way to select elements"), where
// a user could not tell a tool was still armed.
//
// It is decoration over the canvas and nothing else: pointer-events are off, so
// it can never eat a click, and it hides the moment the pointer is over anything
// that is not the canvas (a panel, the palette, a menu, a dialog) rather than
// floating on top of UI it has no business labelling.

import { icon, type IconName } from "./icons";
import { leavesOf, MODEL, SKETCH } from "./ribbon";

/** Below-right of the hotspot, the placement every other MCAD uses: the pointer
 *  itself claims up-left, and the point being picked sits AT the hotspot, so
 *  anything above or left of it covers the geometry you are aiming at. The exact
 *  numbers are a feel question and have not been seen running. */
const OFFSET_X = 16;
const OFFSET_Y = 18;

/**
 * action -> icon, taken from the ribbon's own tables so there is exactly one
 * mapping in the app. A second copy would drift the day someone redraws a tool.
 *
 * The alias pass exists because the two vocabularies do not quite line up:
 * SketchMode's tool is "fillet" where the ribbon's action is "fillet-sketch"
 * (likewise chamfer/mirror/move/copy/rotate/scale), since those names are taken
 * by the modeling ribbon. Stripping the suffix covers them without touching
 * either side's naming.
 */
const ICON_BY_ACTION: ReadonlyMap<string, IconName> = (() => {
  const m = new Map<string, IconName>();
  // SKETCH first: where both contexts define a name, the sketch tool is the one
  // that can reach this module today.
  for (const groups of [SKETCH, MODEL]) {
    for (const group of groups) {
      for (const item of group.items) {
        for (const leaf of leavesOf(item)) {
          if (!m.has(leaf.action)) m.set(leaf.action, leaf.iconName);
        }
      }
    }
  }
  for (const [action, name] of [...m]) {
    const bare = action.replace(/-sketch$/, "");
    if (!m.has(bare)) m.set(bare, name);
  }
  return m;
})();

export interface ToolCursor {
  /** The armed tool's action name, or null for none. Safe to call every frame —
   *  it re-renders only when the icon actually changes. */
  setTool(action: string | null): void;
  unmount(): void;
}

export function mountToolCursor(host: HTMLElement, canvas: HTMLElement): ToolCursor {
  const badge = document.createElement("div");
  badge.className = "tool-cursor";
  badge.setAttribute("aria-hidden", "true"); // decorative: the ribbon and the prompt banner say it in words
  host.appendChild(badge);

  let current: IconName | null = null;
  let overCanvas = false;
  // Until the first move we have no coordinates, and a badge parked at 0,0 in the
  // corner of the screen is worse than no badge.
  let placed = false;

  const sync = () => {
    badge.classList.toggle("hidden", !(current && overCanvas && placed));
  };
  sync(); // `hidden` has exactly one owner — never also baked into the class string above

  const onMove = (ev: PointerEvent) => {
    // Only over the canvas. Note this also covers the overlays INSIDE #viewport
    // (prompt, fps, sketch glyphs): they are pointer-events:none, so the hit test
    // falls through to the canvas and the badge stays up, which is what you want.
    // The palette and the view controls are not, so they read as "not canvas".
    overCanvas = ev.target === canvas;
    if (overCanvas) {
      placed = true;
      badge.style.transform = `translate(${ev.clientX + OFFSET_X}px, ${ev.clientY + OFFSET_Y}px)`;
    }
    sync();
  };
  const onLeave = () => {
    overCanvas = false;
    sync();
  };

  host.addEventListener("pointermove", onMove);
  // Non-bubbling, so this fires for the host itself: pointer out of the window.
  host.addEventListener("pointerleave", onLeave);

  return {
    setTool(action) {
      // "select" is NOT a tool for this purpose. It is the way out of every other
      // tool, its icon IS a pointer, and a pointer glyph trailing the pointer
      // would read as a rendering bug rather than as state.
      const next = action && action !== "select" ? (ICON_BY_ACTION.get(action) ?? null) : null;
      if (next !== current) {
        current = next;
        if (next) {
          badge.innerHTML = icon(next);
          // The markup is unreadable from a test (and from the DOM inspector);
          // this is what "which tool is showing" can actually be asserted on.
          badge.dataset.tool = next;
        } else {
          delete badge.dataset.tool;
        }
      }
      sync();
    },
    unmount() {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      // Optional call: the element stub the tests render against
      // (fakeDom.testkit.ts) implements append but not remove.
      badge.remove?.();
    },
  };
}
