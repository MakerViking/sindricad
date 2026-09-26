// The word a freshly opened document owes the user when most of it is hidden.
//
// Body visibility is saved with the document, so a file can open looking empty
// or nearly so: someone isolated one part of an assembly, saved, and the next
// open shows that one part or nothing at all. The only trace was the eye icons
// in the Browser, which is not where anyone looks when the view is blank. One
// toast per load, with the way back on it.

import { t } from "../i18n";

export interface HiddenBodiesCue {
  kind: "warning" | "info";
  message: string;
}

/** What to say about hidden bodies right after a document loads, or null when
 *  nothing needs saying. Counted against the bodies the build actually
 *  produced (`bodyIds`), not against whatever the saved visibility map names:
 *  a map entry for a body that no longer exists hides nothing.
 *
 *  Every body hidden is a warning (the view is empty). More than half is an
 *  info note with the numbers. Half or fewer is ordinary work: say nothing. */
export function hiddenBodiesCue(
  bodyIds: readonly string[],
  isVisible: (id: string) => boolean,
): HiddenBodiesCue | null {
  const total = bodyIds.length;
  const hidden = bodyIds.filter((id) => !isVisible(id)).length;
  if (total === 0 || hidden * 2 <= total) return null;
  if (hidden === total) {
    return { kind: "warning", message: t("viewport.hiddenBodies.all", { count: total }) };
  }
  return { kind: "info", message: t("viewport.hiddenBodies.most", { count: hidden, total }) };
}
