// "Merge into one solid" is on every right-click menu that is a body's: the 3D
// view's body menu, the face menu (which IS the body's right-click in Faces
// selection mode) and the Browser row's, next to "Separate into bodies" (its
// opposite), and writes the merge through store.mergeSolids. The body menus
// act on the selection they were opened over, as Split, Move and Combine do,
// one merge per body; the face menu acts on its face's body alone, as its
// Split Body does.
//
// Drives the real createContextMenus with the menu renderer stubbed to hand
// back the items it was given, as contextMenusSplit.test.ts does.
import { describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import type { CtxItem } from "./menu";

const menus: CtxItem[][] = [];
vi.mock("./menu", () => ({ contextMenu: (_x: number, _y: number, items: CtxItem[]) => { menus.push(items); } }));
const { createContextMenus } = await import("./contextMenus");

function setup(busy = false, selection: string[] = ["body2"]) {
  const merged: string[][] = [];
  const separated: string[] = [];
  const statuses: string[] = [];
  const splits: unknown[] = [];
  const deps = {
    store: {
      document: { features: [] },
      buildState: { result: { bodies: [{ id: "body1", name: "Body1" }, { id: "body2", name: "Body2" }] } },
      canUndo: false,
      canRedo: false,
      colorPalette: [],
      bodyColorSlot: () => null,
      mergeSolids: (ids: readonly string[]) => { merged.push([...ids]); },
      separateBody: (id: string) => { separated.push(id); },
    },
    viewport: {
      getSelectedBodies: () => selection,
      setSelectedBodies: () => {},
      pickFacePlane: () => ({ origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] }),
      faceAnchor: () => ({ kind: "face", by: "nearest", point: [0, 0, 0] }),
      faceIdToBodyId: (faceId: number) => (faceId === 3 ? "body1" : null),
    },
    tree: { beginRename: () => {} },
    toolBusy: () => busy,
    setStatus: (text: string) => { statuses.push(text); },
    selectFeature: () => {},
    featureForFace: () => null,
    setLastAction: () => {},
    getLastAction: () => null,
    startSplit: (seed: unknown) => { splits.push(seed); },
  };
  return { m: createContextMenus(deps as never), merged, separated, statuses, splits };
}

const labels = (items: CtxItem[]) => items.map((i) => i.label);

describe("Merge into one solid in the body menus", () => {
  it("the 3D view's body menu has it right after Separate, and it merges THAT body", () => {
    const { m, merged } = setup();
    m.openBodyMenu(0, 0, "body2");
    const items = menus.at(-1)!;
    const at = labels(items).indexOf(t("context.mergeSolids"));
    expect(at, "no Merge into one solid in the body menu").toBeGreaterThan(-1);
    expect(items[at - 1]!.label, "it is not next to Separate into bodies").toBe(t("context.separateBody"));
    items[at]!.onClick!();
    expect(merged).toEqual([["body2"]]);
  });

  it("the Browser row's menu has it too, right after Separate", () => {
    const { m, merged } = setup();
    const items = m.bodyActions("body1");
    const at = labels(items).indexOf(t("context.mergeSolids"));
    expect(at, "no Merge into one solid on the Browser's body row").toBeGreaterThan(-1);
    expect(items[at - 1]!.label).toBe(t("context.separateBody"));
    items[at]!.onClick!();
    expect(merged).toEqual([["body1"]]);
  });

  it("the face menu has it too, after Separate, on the body the face belongs to", () => {
    // In Faces selection mode a right-click on a body opens the FACE menu, so
    // without these the 3D view had no way to Merge or Separate at all there.
    const { m, merged, separated } = setup();
    m.openFaceMenu(0, 0, { kind: "face", faceId: 3 } as never);
    const items = menus.at(-1)!;
    const at = labels(items).indexOf(t("context.mergeSolids"));
    expect(at, "no Merge into one solid in the face menu").toBeGreaterThan(-1);
    expect(items[at - 1]!.label, "it is not next to Separate into bodies").toBe(t("context.separateBody"));
    items[at]!.onClick!();
    items[at - 1]!.onClick!();
    expect(merged).toEqual([["body1"]]);
    expect(separated).toEqual(["body1"]);
  });

  it("the face menu leaves them out when the face belongs to no body", () => {
    const { m } = setup();
    m.openFaceMenu(0, 0, { kind: "face", faceId: 9 } as never);
    expect(labels(menus.at(-1)!)).not.toContain(t("context.mergeSolids"));
  });

  it("is refused in words while a tool is running, not run and not dropped silently", () => {
    // unlessBusy: the click runs when the item is chosen, and a keyboard
    // shortcut may have started a tool since the menu opened.
    const { m, merged, statuses } = setup(true);
    const item = m.bodyActions("body1").find((i) => i.label === t("context.mergeSolids"))!;
    item.onClick!();
    expect(merged, "a merge was written into the timeline under a running tool").toEqual([]);
    expect(statuses.length, "the refusal said nothing").toBe(1);
  });

  it("over a multi-selection, merges EACH selected body, as Split in the same menu acts on all of them", () => {
    const { m, merged, splits } = setup(false, ["body1", "body2"]);
    m.openBodyMenu(0, 0, "body2");
    const items = menus.at(-1)!;
    const each = t("context.mergeSolidsEach", { count: 2 });
    const item = items.find((i) => i.label === each);
    expect(item, "the label does not say it merges each body on its own").toBeDefined();
    expect(labels(items)).not.toContain(t("context.mergeSolids"));
    item!.onClick!();
    expect(merged, "it did not merge every selected body, in one call").toEqual([["body1", "body2"]]);
    // control: its neighbour Split Body acts on the same selection
    items.find((i) => i.label === t("context.splitBody"))!.onClick!();
    expect(splits).toEqual([{ bodies: ["body1", "body2"] }]);
  });

  it("the Browser row's does the same when its body is in the selection, and not when it is not", () => {
    const { m, merged } = setup(false, ["body1", "body2"]);
    m.bodyActions("body1").find((i) => i.label === t("context.mergeSolidsEach", { count: 2 }))!.onClick!();
    expect(merged).toEqual([["body1", "body2"]]);
    const { m: m2, merged: merged2 } = setup(false, ["body2", "body3"]);
    const items = m2.bodyActions("body1");
    expect(labels(items)).toContain(t("context.mergeSolids"));
    items.find((i) => i.label === t("context.mergeSolids"))!.onClick!();
    expect(merged2, "a row outside the selection merged the selection").toEqual([["body1"]]);
  });

  it("the face menu merges its face's body alone even when bodies are selected, as its Split does", () => {
    const { m, merged, splits } = setup(false, ["body1", "body2"]);
    m.openFaceMenu(0, 0, { kind: "face", faceId: 3 } as never);
    const items = menus.at(-1)!;
    items.find((i) => i.label === t("context.mergeSolids"))!.onClick!();
    items.find((i) => i.label === t("context.splitBody"))!.onClick!();
    expect(merged).toEqual([["body1"]]);
    expect(splits).toEqual([{ bodies: ["body1"] }]);
  });

  it("reads 'Merge each of the 2 bodies into one solid of its own' over two, never like Combine", () => {
    expect(t("context.mergeSolidsEach", { count: 2 })).toBe("Merge each of the 2 bodies into one solid of its own");
  });

  it("reads 'Merge into one solid'", () => {
    expect(t("context.mergeSolids")).toBe("Merge into one solid");
  });
});
