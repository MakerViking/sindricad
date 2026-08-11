// Display metadata for feature types (icon + label).
// `label` is read by the timeline, inspector, params dialog, context menus and the
// rebuild-failure toasts; `iconName` is drawn by the timeline. Both resolve through
// the shared icon set in ./icons, so a feature looks the same everywhere it appears.
import type { FeatureType } from "../types";
import type { IconName } from "./icons";

export const FEATURE_META: Record<FeatureType, { iconName: IconName; label: string }> = {
  sketch: { iconName: "sketch", label: "Sketch" },
  extrude: { iconName: "extrude", label: "Extrude" },
  fillet: { iconName: "fillet", label: "Fillet" },
  chamfer: { iconName: "chamfer", label: "Chamfer" },
  "press-pull": { iconName: "presspull", label: "Press/Pull" },
  deleteFace: { iconName: "deleteFace", label: "Delete Face" },
  mirror: { iconName: "mirror", label: "Mirror" },
  revolve: { iconName: "revolve", label: "Revolve" },
  loft: { iconName: "loft", label: "Loft" },
  sweep: { iconName: "sweep", label: "Sweep" },
  datumPlane: { iconName: "datumPlane", label: "Datum Plane" },
  import: { iconName: "import", label: "Import" },
  split: { iconName: "split", label: "Split Body" },
  combine: { iconName: "combine", label: "Combine" },
  box: { iconName: "box", label: "Box" },
  cylinder: { iconName: "cylinder", label: "Cylinder" },
  sphere: { iconName: "sphere", label: "Sphere" },
  shell: { iconName: "shell", label: "Shell" },
  offsetFace: { iconName: "offsetFace", label: "Offset Face" },
  thicken: { iconName: "thicken", label: "Thicken" },
  draft: { iconName: "draft", label: "Draft" },
  patternRect: { iconName: "patternRect", label: "Rect Pattern" },
  patternCircular: { iconName: "patternCircular", label: "Circular Pattern" },
  simplifyMesh: { iconName: "simplifyMesh", label: "Simplify Mesh" },
  cleanUp: { iconName: "cleanUp", label: "Clean Up" },
  scale: { iconName: "scale", label: "Scale" },
  move: { iconName: "move", label: "Move" },
  removeBody: { iconName: "removeBody", label: "Remove Body" },
  texture: { iconName: "texture", label: "Texture" },
  textOnFace: { iconName: "textOnFace", label: "Text on Face" },
};
