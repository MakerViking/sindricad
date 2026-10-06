// Display metadata for feature types (icon + label).
// `label` is read by the timeline, inspector, params dialog, context menus and the
// rebuild-failure toasts; `iconName` is drawn by the timeline. Both resolve through
// the shared icon set in ./icons, so a feature looks the same everywhere it appears.
import type { ExtrudeStart, Feature, FeatureType } from "../types";
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
  separate: { iconName: "separate", label: t("tool.separate") },
  mergeSolids: { iconName: "mergeSolids", label: t("tool.mergeSolids") },
  texture: { iconName: "texture", label: t("tool.texture") },
  textOnFace: { iconName: "textOnFace", label: t("tool.textOnFace") },
  thread: { iconName: "thread", label: t("tool.thread") },
};

/** What to call a plane an extrude is aimed at: an origin plane by its axes, a
 *  construction plane by its name (a rename wins) or its place among the
 *  planes, and the raw id only if nothing in the document matches, since a
 *  deleted datum must never make a render throw. Shared by the inspector's
 *  Up-to row and the Extrude panel, so the two name it alike. */
export function planeLabel(features: readonly Feature[], id: string): string {
  if (id === "XY" || id === "XZ" || id === "YZ") return t("inspector.upTo.originPlane", { id });
  const datums = features.filter((f) => f.type === "datumPlane");
  const i = datums.findIndex((f) => f.id === id);
  if (i < 0) return id;
  return (datums[i] as { name?: string }).name || t("common.planeName", { n: i + 1 });
}

/** What an extrude starts from or runs up to when that is an OBJECT (GH #41),
 *  in a word or two: a plane by planeLabel's name, anything else by its kind.
 *  Shared by the inspector's rows and the Extrude panel's boxes, like
 *  planeLabel, so the two name it alike. */
export function refLabel(ref: ExtrudeStart, features: readonly Feature[]): string {
  switch (ref.kind) {
    case "plane":
      return planeLabel(features, ref.plane);
    case "face":
      return t("inspector.upTo.pickedFace");
    case "sketchPoint":
      return t("inspector.ref.sketchPoint");
    case "sketchLine":
      return t("inspector.ref.sketchLine");
    case "edge":
      return t("inspector.ref.edge");
    case "vertex":
      return t("inspector.ref.vertex");
  }
}
