// Every Split entry of the canvas right-click menus records "split" as the last
// action, so the empty-canvas menu's "Repeat Split Body" repeats it. The body
// and face entries did; the construction-plane entry did not, so after a split
// started from a plane, Repeat offered whatever came before.
//
// Drives the real createContextMenus with the menu renderer stubbed to hand
// back the items it was given.
import { describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import type { CtxItem } from "./menu";

const menus: CtxItem[][] = [];
vi.mock("./menu", () => ({ contextMenu: (_x: number, _y: number, items: CtxItem[]) => { menus.push(items); } }));
const { createContextMenus } = await import("./contextMenus");

function setup() {
  const last: string[] = [];
  const started: unknown[] = [];
  const deps = {
    store: {
      document: { features: [{ id: "d1", type: "datumPlane", plane: "XY" }] },
      buildState: { result: { bodies: [{ id: "body1", name: "Body1" }] } },
      canUndo: false,
      canRedo: false,
      colorPalette: [],
      bodyColorSlot: () => null,
    },
    viewport: {
      getSelectedBodies: () => ["body1"],
      setSelectedBodies: () => {},
      pickFacePlane: () => ({ origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] }),
      faceAnchor: () => ({ kind: "face", by: "nearest", point: [0, 0, 0] }),
      faceIdToBodyId: () => "body1",
    },
    toolBusy: () => false,
    selectFeature: () => {},
    featureForFace: () => null,
    setLastAction: (a: string) => { last.push(a); },
    getLastAction: () => last.at(-1) ?? null,
    startSplit: (seed: unknown) => { started.push({ seed, last: last.at(-1) }); },
  };
  const m = createContextMenus(deps as never);
  const splitEntry = (label: string) => {
    const item = menus.at(-1)!.find((i) => i.label === label);
    expect(item, `no "${label}" in the menu`).toBeTruthy();
    item!.onClick!();
  };
  return { m, started, splitEntry };
}

describe("Split entries in the canvas menus", () => {
  it("the construction plane's entry records 'split' before it starts, like the body and face entries", () => {
    const { m, started, splitEntry } = setup();
    m.openDatumMenu(0, 0, "d1");
    splitEntry(t("context.splitWithPlane"));
    m.openBodyMenu(0, 0, "body1");
    splitEntry(t("context.splitBody"));
    m.openFaceMenu(0, 0, { kind: "face", faceId: 3 } as never);
    splitEntry(t("context.splitBody"));
    expect(started).toEqual([
      { seed: { planeId: "d1" }, last: "split" },
      { seed: { bodies: ["body1"] }, last: "split" },
      { seed: { bodies: ["body1"] }, last: "split" },
    ]);
  });
});
