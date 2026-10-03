// The sketch ribbon's "Project" keeps its name (other CAD tools call it that)
// and gains a second tooltip line that says what it does (Doug 22a). Mounts
// the real Ribbon and reads the button's tooltip, the text the user hovers.
import { describe, it, expect, vi } from "vitest";
import { FakeEl, installFakeDocument } from "./fakeDom.testkit";
import { Ribbon } from "./ribbon";
import { t } from "../i18n";

installFakeDocument();
vi.stubGlobal("ResizeObserver", class { observe() {} });

function buttons(el: FakeEl, action: string, out: FakeEl[] = []): FakeEl[] {
  if (el.dataset.action === action) out.push(el);
  for (const c of el.children) buttons(c, action, out);
  return out;
}

describe("the Project button", () => {
  it("keeps its name and explains itself on a second tooltip line", () => {
    const root = new FakeEl("div");
    const r = new Ribbon(root as unknown as HTMLElement);
    (r as unknown as { sketch: { el: Record<string, unknown> } }).sketch.el.querySelectorAll = () => [];
    const [btn] = buttons(root, "project");
    expect(btn, "no Project button in the ribbon").toBeTruthy();
    const [first, second] = btn!.title.split("\n");
    expect(first).toBe(t("ribbon.toolWithKey", { label: t("tool.project"), key: "P" }));
    expect(second).toBe(t("ribbon.hint.project"));
  });
});
