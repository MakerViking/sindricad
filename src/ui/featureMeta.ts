// Display metadata for feature types (glyphs + labels), shared by the timeline,
// browser tree, and toolbar.
import type { FeatureType } from "../types";

export const FEATURE_META: Record<FeatureType, { glyph: string; label: string }> = {
  sketch: { glyph: "✎", label: "Sketch" },
  extrude: { glyph: "⬆", label: "Extrude" },
  fillet: { glyph: "◜", label: "Fillet" },
  chamfer: { glyph: "◣", label: "Chamfer" },
  "press-pull": { glyph: "⤒", label: "Press/Pull" },
  mirror: { glyph: "⇋", label: "Mirror" },
  revolve: { glyph: "↻", label: "Revolve" },
  loft: { glyph: "≋", label: "Loft" },
};
