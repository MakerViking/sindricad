// Display metadata for feature types (icon + label).
// `label` is read by the timeline, inspector, params dialog, context menus and the
// rebuild-failure toasts; `iconName` is drawn by the timeline. Both resolve through
// the shared icon set in ./icons, so a feature looks the same everywhere it appears.
import type { FeatureType } from "../types";
import type { IconName } from "./icons";
import { t } from "../i18n";

export const FEATURE_META: Record<FeatureType, { iconName: IconName; label: string }> = {
  sketch: { iconName: "sketch", label: t("tool.sketch") },
  extrude: { iconName: "extrude", label: t("tool.extrude") },
  fillet: { iconName: "fillet", label: t("tool.fillet") },
  chamfer: { iconName: "chamfer", label: t("tool.chamfer") },
  "press-pull": { iconName: "presspull", label: t("tool.presspull") },
  deleteFace: { iconName: "deleteFace", label: t("tool.deleteFace") },
  mirror: { iconName: "mirror", label: t("tool.mirror") },
  revolve: { iconName: "revolve", label: t("tool.revolve") },
  loft: { iconName: "loft", label: t("tool.loft") },
  sweep: { iconName: "sweep", label: t("tool.sweep") },
  datumPlane: { iconName: "datumPlane", label: t("tool.datumPlane") },
  import: { iconName: "import", label: t("tool.import") },
  split: { iconName: "split", label: t("tool.split") },
  combine: { iconName: "combine", label: t("tool.combine") },
  box: { iconName: "box", label: t("tool.box") },
  cylinder: { iconName: "cylinder", label: t("tool.cylinder") },
  sphere: { iconName: "sphere", label: t("tool.sphere") },
  shell: { iconName: "shell", label: t("tool.shell") },
  offsetFace: { iconName: "offsetFace", label: t("tool.offsetFace") },
  thicken: { iconName: "thicken", label: t("tool.thicken") },
  draft: { iconName: "draft", label: t("tool.draft") },
  patternRect: { iconName: "patternRect", label: t("tool.patternRect") },
  patternCircular: { iconName: "patternCircular", label: t("tool.patternCircular") },
  simplifyMesh: { iconName: "simplifyMesh", label: t("tool.simplifyMesh") },
  cleanUp: { iconName: "cleanUp", label: t("tool.cleanUp") },
  scale: { iconName: "scale", label: t("tool.scale") },
  move: { iconName: "move", label: t("tool.move") },
  removeBody: { iconName: "removeBody", label: t("tool.removeBody") },
  texture: { iconName: "texture", label: t("tool.texture") },
  textOnFace: { iconName: "textOnFace", label: t("tool.textOnFace") },
};
