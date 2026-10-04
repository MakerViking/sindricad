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
//
// It is drawn by the OS as part of the pointer where it can be: the icon is
// rasterised into a CSS cursor image on the canvas. A DOM element that chases
// the pointer trails it by the webview's whole input-to-screen pipeline, which
// is several frames on WebKitGTK under Wayland: the #17 reporter saw it trail
// the pointer "as if it were attached to the cursor with an elastic
// connection". The DOM badge is the fallback for an engine that cannot build or
// take the image.

import { icon, type IconName } from "./icons";
import { leavesOf, MODEL, SKETCH } from "./ribbon";

/** Below-right of the hotspot, the placement every other MCAD uses: the pointer
 *  itself claims up-left, and the point being picked sits AT the hotspot, so
 *  anything above or left of it covers the geometry you are aiming at. The exact
 *  numbers are a feel question and have not been seen running. */
const OFFSET_X = 16;
const OFFSET_Y = 18;

// The cursor image, in CSS px. Its chip copies the DOM badge (.tool-cursor: a
// 22 px square around a 15 px glyph) at the same offset from the hotspot, so the
// two renderings of the badge look alike.
const HOT = 9; // the hotspot, at the centre of the crosshair
const ARM = 8; // crosshair arm length from the hotspot
const GAP = 2; // left clear at the centre, so the point being picked stays visible
const CHIP = 22;
const GLYPH = 15;
const IMG_W = HOT + OFFSET_X + CHIP + 1;
const IMG_H = HOT + OFFSET_Y + CHIP + 1;

/** The chip's left edge and bottom edge, in CSS px right of and below the
 *  hotspot. Anything else a tool puts beside the pointer (a sketch tool's
 *  value box, SketchMode.dimAtCursor) goes below this, or the two overlap. */
export const CHIP_LEFT = OFFSET_X;
export const CHIP_BOTTOM = OFFSET_Y + CHIP;

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

/** Colours for the cursor image. All of them are read from the stylesheet (see
 *  rasteriseCursor), so none is spelled out here. */
interface CursorColours {
  line: string; // crosshair
  halo: string; // crosshair outline, for contrast on light geometry
  chip: string;
  edge: string;
  glyph: string;
  radius: number;
}

/** The pointer as one SVG: a crosshair at the hotspot, and the tool's icon on
 *  its chip below-right of it. Exported for the tests. */
export function cursorSvg(name: IconName, c: CursorColours): string {
  const m = HOT + 0.5; // on the pixel centre, so a 1 px line is crisp at 1x and 2x
  const arms = `M${m - ARM} ${m}H${m - GAP}M${m + GAP} ${m}H${m + ARM}M${m} ${m - ARM}V${m - GAP}M${m} ${m + GAP}V${m + ARM}`;
  const x = HOT + OFFSET_X, y = HOT + OFFSET_Y, pad = (CHIP - GLYPH) / 2;
  // i18n-ignore SVG markup for the cursor image, not UI text
  const glyph = icon(name).replace("<svg ", `<svg x="${x + pad}" y="${y + pad}" width="${GLYPH}" height="${GLYPH}" style="color:${c.glyph}" `);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${IMG_W}" height="${IMG_H}" viewBox="0 0 ${IMG_W} ${IMG_H}">` +
    `<path d="${arms}" fill="none" stroke-width="3" stroke-linecap="round" style="stroke:${c.halo}"/>` +
    `<path d="${arms}" fill="none" stroke-width="1" style="stroke:${c.line}"/>` +
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${CHIP - 1}" height="${CHIP - 1}" rx="${c.radius}" style="fill:${c.chip};stroke:${c.edge}"/>` +
    glyph +
    `</svg>`;
}

/** Turns a tool's icon into a CSS `cursor` value, or null when this engine
 *  cannot. Injected by the tests, which have no canvas to draw on. */
export type CursorRasteriser = (name: IconName, badge: HTMLElement) => Promise<string | null>;

/** WebKitGTK, the Linux webview. It takes a custom cursor's bitmap at its pixel
 *  size and its hotspot as written (WebCore's EventHandler::selectCursor has no
 *  cursor scale outside macOS), so on a HiDPI screen the 2x image of an
 *  image-set comes out at twice the size with the hotspot nowhere near the
 *  crosshair. The 1x image is the one that lands right there; the compositor
 *  scales it up. Chromium (WebView2) and macOS's WebKit scale both. */
const linuxWebKit = (ua: string) => ua.includes("Linux") && !ua.includes("Chrom");

/** The real rasteriser: the SVG above, drawn at 1x and 2x into PNGs, as an
 *  image-set so a HiDPI screen gets a sharp pointer (1x only on WebKitGTK, see
 *  linuxWebKit). PNG rather than the SVG itself because engines size, scale
 *  and hotspot an SVG cursor differently, and a bitmap is the one form every
 *  one of them takes as-is.
 *
 *  Null on any failure: no 2D canvas, an SVG the engine will not decode, a
 *  canvas the engine calls tainted, or a cursor syntax it rejects. The caller
 *  then keeps the DOM badge. */
export async function rasteriseCursor(name: IconName, badge: HTMLElement): Promise<string | null> {
  try {
    const own = getComputedStyle(badge);
    const root = getComputedStyle(document.documentElement);
    const svg = cursorSvg(name, {
      line: root.getPropertyValue("--text").trim(),
      halo: own.backgroundColor,
      chip: own.backgroundColor,
      edge: own.borderTopColor,
      glyph: own.color,
      radius: parseFloat(own.borderTopLeftRadius) || 0,
    });
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; // i18n-ignore a data URL
    await img.decode();
    const png = (scale: number): string => {
      const c = document.createElement("canvas");
      c.width = IMG_W * scale;
      c.height = IMG_H * scale;
      const g = c.getContext("2d");
      if (!g) throw new Error("no 2d context");
      g.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/png");
    };
    const one = png(1);
    const plain = `url("${one}") ${HOT} ${HOT}, crosshair`;
    if (linuxWebKit(navigator.userAgent)) return CSS.supports("cursor", plain) ? plain : null;
    const two = png(2);
    // `image-set` is the standard spelling; older engines take only the
    // prefixed one inside `cursor`. A plain 1x image is the last resort.
    for (const fn of ["image-set", "-webkit-image-set"]) {
      const value = `${fn}(url("${one}") 1x, url("${two}") 2x) ${HOT} ${HOT}, crosshair`;
      if (CSS.supports("cursor", value)) return value;
    }
    return CSS.supports("cursor", plain) ? plain : null;
  } catch {
    return null;
  }
}

export interface ToolCursor {
  /** The armed tool's action name, or null for none. Safe to call every frame —
   *  it re-renders only when the icon actually changes. */
  setTool(action: string | null): void;
  unmount(): void;
}

export function mountToolCursor(
  host: HTMLElement,
  canvas: HTMLElement,
  rasterise: CursorRasteriser = rasteriseCursor,
): ToolCursor {
  const badge = document.createElement("div");
  badge.className = "tool-cursor";
  badge.setAttribute("aria-hidden", "true"); // decorative: the ribbon and the prompt banner say it in words
  host.appendChild(badge);

  let current: IconName | null = null;
  let overCanvas = false;
  // Until the first move we have no coordinates, and a badge parked at 0,0 in the
  // corner of the screen is worse than no badge.
  let placed = false;
  // icon -> its CSS cursor, once rasterised; null = this engine cannot have one
  const cursors = new Map<IconName, string | null>();
  const rasterising = new Set<IconName>();
  // the canvas `cursor` this module set, as the engine stored it; null = none
  let written: string | null = null;

  const sync = () => {
    badge.classList.toggle("hidden", !(current && overCanvas && placed && written === null));
  };
  sync(); // `hidden` has exactly one owner — never also baked into the class string above

  /** Put the current tool's cursor image on the canvas, or take ours off. The
   *  first use of each icon rasterises it, and the DOM badge stands in until
   *  that lands. */
  const applyCursor = () => {
    const css = current ? cursors.get(current) : null;
    if (current && css === undefined && !rasterising.has(current)) {
      const name = current;
      rasterising.add(name);
      void rasterise(name, badge)
        .catch(() => null)
        .then((value) => {
          rasterising.delete(name);
          cursors.set(name, value);
          if (current !== name) return;
          applyCursor();
          sync();
        });
    }
    if (typeof css === "string") {
      canvas.style.cursor = css;
      // Read back rather than assumed: an engine that cannot parse the value
      // keeps the old one, and then the DOM badge has to stay up, and the
      // value is not worth offering again (see reclaim).
      written = canvas.style.cursor?.includes("url(") ? canvas.style.cursor : null;
      if (written === null && current) cursors.set(current, null);
      return;
    }
    // Only ever take back our own value: the modeling tools set grab/pointer
    // cursors on this same canvas.
    if (written !== null && canvas.style.cursor === written) canvas.style.cursor = "";
    written = null;
  };

  /** Other code writes this canvas's cursor too, and says nothing when it does:
   *  in a sketch the ViewCube sets "pointer" over its corner and "" when the
   *  pointer leaves it (the modeling tools write theirs on the same canvas). So
   *  every move over the canvas checks the value is still ours. An empty one is
   *  free to take back. Anything else is someone's cursor, and it wins: the DOM
   *  badge stands in for ours, as it always did. Without this, a ViewCube visit
   *  left the canvas with no image and no badge until the next tool change. */
  const reclaim = () => {
    if (!current || typeof cursors.get(current) !== "string") return;
    const now = canvas.style.cursor ?? "";
    if (now === written) return;
    if (now === "") applyCursor();
    else written = null;
  };

  const onMove = (ev: PointerEvent) => {
    // Only over the canvas. Note this also covers the overlays INSIDE #viewport
    // (prompt, fps, sketch glyphs): they are pointer-events:none, so the hit test
    // falls through to the canvas and the badge stays up, which is what you want.
    // The palette and the view controls are not, so they read as "not canvas".
    overCanvas = ev.target === canvas;
    if (overCanvas) {
      placed = true;
      badge.style.transform = `translate(${ev.clientX + OFFSET_X}px, ${ev.clientY + OFFSET_Y}px)`;
      reclaim();
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
        applyCursor();
      }
      sync();
    },
    unmount() {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      current = null;
      applyCursor();
      // Optional call: the element stub the tests render against
      // (fakeDom.testkit.ts) implements append but not remove.
      badge.remove?.();
    },
  };
}
