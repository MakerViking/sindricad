// The question a rebuild asks when one step goes past the sidecar's stall
// limit: wait for it, or stop it.
//
// Field report 6ddd01dc: a Mirror that fuses a body carrying 14 Text features
// with its mirror image is ONE boolean, 36 s on a Ryzen 7900X and over 60 s on
// the reporter's 2012 CPU. The sidecar restarted the engine at 60 s on every
// retry, so the model never built again and the status bar said only "⚠ : the
// geometry engine stopped responding". From the sidecar's side a slow step and
// a stuck one look the same (one native call holds the interpreter either way),
// so the person who can see the model decides. Past the limit the sidecar keeps
// waiting while the app is connected and reports how long; this shows that as a
// toast with Stop, which is the Cancel the timeline already offers.

import type { RebuildState } from "../document/store";
import { featureNameOf, type SketchedFeature } from "../geometry/featureErrorText";
import { t } from "../i18n";
import type { ToastOptions } from "./toast";

/** The toast text for a step that has been quiet for `seconds`. */
export function stallNoticeText(
  stalled: NonNullable<RebuildState["stalled"]>,
  features: readonly SketchedFeature[],
): string {
  const minutes = Math.max(1, Math.floor(stalled.seconds / 60));
  const feature = featureNameOf(features, stalled.featureId ?? undefined);
  return feature
    ? t("engine.stalledAsk", { feature, count: minutes })
    : t("engine.stalledAskUnnamed", { count: minutes });
}

/** Shows the question once per stalled step and takes it down the moment the
 *  build moves on, finishes or is stopped: a toast still asking about a step
 *  that is done would be a lie on screen. */
export class StallNotice {
  private dismiss: (() => void) | null = null;
  private shownFor: string | null = null;

  constructor(
    private show: (message: string, opts: ToastOptions) => () => void,
    private stop: () => void,
  ) {}

  update(s: Pick<RebuildState, "building" | "stalled">, features: readonly SketchedFeature[]): void {
    const st = s.building ? s.stalled : null;
    if (!st) {
      this.clear();
      return;
    }
    // One toast per stalled step: the frame repeats every second, and a
    // second step stalling later in the same build deserves its own question.
    const key = st.featureId ?? "?";
    if (this.dismiss && this.shownFor === key) return;
    this.clear();
    this.shownFor = key;
    this.dismiss = this.show(stallNoticeText(st, features), {
      kind: "warning",
      timeout: 0,
      action: { label: t("common.stop"), onClick: () => this.stop() },
    });
  }

  private clear(): void {
    this.dismiss?.();
    this.dismiss = null;
    this.shownFor = null;
  }
}
