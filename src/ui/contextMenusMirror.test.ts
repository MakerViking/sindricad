// GH #64: right-click a construction plane, "Mirror across this plane" starts
// Mirror with that plane, beside "Split bodies with this plane…".
//
// Drives the real createContextMenus with the menu renderer stubbed to hand
// back the items it was given.
import { describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import type { CtxItem } from "./menu";

const menus: CtxItem[][] = [];
vi.mock("./menu", () => ({ contextMenu: (_x: number, _y: number, items: CtxItem[]) => { menus.push(items); } }));
const { createContextMenus } = await import("./contextMenus");

function setup(busy = false) {
  const mirrored: (string | undefined)[] = [];
  const status: string[] = [];
  const deps = {
    store: { document: { features: [{ id: "d1", type: "datumPlane", plane: "XY" }] } },
    toolBusy: () => busy,
    setStatus: (s: string) => { status.push(s); },
    selectFeature: () => {},
    setLastAction: () => {},
    startMirror: (planeId?: string) => { mirrored.push(planeId); },
  };
  const m = createContextMenus(deps as never);
  m.openDatumMenu(0, 0, "d1");
  const labels = menus.at(-1)!.map((i) => i.label);
  const click = () => menus.at(-1)!.find((i) => i.label === t("context.mirrorAcrossPlane"))!.onClick!();
  return { labels, click, mirrored, status };
}

describe("Mirror across this plane", () => {
  it("sits right after Split on a construction plane's menu and starts Mirror with that plane", () => {
    const { labels, click, mirrored } = setup();
    const split = labels.indexOf(t("context.splitWithPlane"));
    expect(labels[split + 1]).toBe(t("context.mirrorAcrossPlane"));
    click();
    expect(mirrored).toEqual(["d1"]);
  });

  it("says another tool is running instead of starting a second one", () => {
    const { click, mirrored, status } = setup(true);
    click();
    expect(mirrored).toEqual([]);
    expect(status.length).toBe(1);
  });
});
