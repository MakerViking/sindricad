// Client cache for sidecar-tessellated glyph outlines. The sidecar owns all font
// work, so text preview outlines come from the `tessellateText` op — cached by a
// content key so identical text/font/style/… reuses the result and re-renders are
// instant. On a cache miss the op fires once and the overlay re-renders on arrival.

import type { GeometryBackend, TextFace } from "../geometry/client";
import type { ResolvedEntity } from "./snap";

type TextEntity = Extract<ResolvedEntity, { type: "text" }>;

const cache = new Map<string, TextFace[]>();
const pending = new Set<string>();
let backend: { geom: GeometryBackend; rerender: () => void } | null = null;

/** Wire the geometry backend + a "re-render everything" callback once at startup.
 *  warmText() uses these to fetch glyph outlines and repaint when they land. */
export function setTextBackend(geom: GeometryBackend, rerender: () => void): void {
  backend = { geom, rerender };
}

function keyOf(e: TextEntity): string {
  return JSON.stringify([
    e.text, e.font ?? "", e.height, e.style ?? "regular", e.align ?? "left",
    e.angle, e.pathRef ?? "", e.positionOnPath ?? "", e.boxWidth ?? "",
  ]);
}

/** Synchronous cache read for the renderer; undefined until the op returns. */
export function getCachedText(e: TextEntity): TextFace[] | undefined {
  return cache.get(keyOf(e));
}

/** System font families for the text tool's picker (via the wired backend). */
export function fetchFonts(): Promise<string[]> {
  return backend ? backend.geom.listFonts() : Promise.resolve([]);
}

/** Idempotently ensure every text entity's glyph outlines are cached: fire
 *  `tessellateText` for misses and re-render when results land. Safe to call on every
 *  paint — cached/in-flight entities are skipped, so the render loop converges.
 *  `entities` is the full resolved list so a text's `pathRef` sibling can be sent. */
export function warmText(entities: ResolvedEntity[]): void {
  if (!backend) return;
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const e of entities) {
    if (e.type !== "text") continue;
    const k = keyOf(e);
    if (cache.has(k) || pending.has(k)) continue;
    pending.add(k);
    const pathEntity = e.pathRef ? byId.get(e.pathRef) : undefined;
    backend.geom
      .tessellateText(e, pathEntity)
      .then((faces) => cache.set(k, faces))
      .catch(() => cache.set(k, []))
      .finally(() => {
        pending.delete(k);
        backend?.rerender();
      });
  }
}
