// A sketch's right-click carries "Copy sketch to plane…" and "Move sketch
// plane…" on BOTH surfaces that show a sketch: its Browser row and its
// Timeline chip. Any other feature's chip does not.
//
// Renders the real Timeline and BrowserTree against the element stub
// (fakeDom.testkit), right-clicks the rendered row/chip, and reads the items
// the menu was opened with, the menu engine being stubbed to record them. The
// items come from the real createContextMenus, the same object main.ts hands
// both surfaces. (main.ts's two assignment lines themselves are covered by the
// headless drive, not here: importing main.ts boots the whole app.)
import { describe, it, expect, vi } from "vitest";
import { FakeEl, installFakeDocument, byClass } from "./fakeDom.testkit";
import type { CtxItem } from "./menu";
import type { DocumentStore } from "../document/store";
import type { CadDocument, RebuildResult } from "../types";

installFakeDocument();
const opened: CtxItem[][] = [];
vi.mock("./menu", () => ({ contextMenu: (_x: number, _y: number, items: CtxItem[]) => { opened.push(items); } }));
const { Timeline } = await import("./timeline");
const { BrowserTree } = await import("./browserTree");
const { createContextMenus } = await import("./contextMenus");
const { t } = await import("../i18n");

const FEATURES = [
  { id: "s1", type: "sketch", plane: "XY", entities: [] },
  { id: "x1", type: "extrude", sketch: "s1", distance: 5, operation: "new" },
];

function setup() {
  const chosen: string[] = [];
  const store = {
    document: { features: FEATURES, parameters: {}, paramDefs: {} } as unknown as CadDocument,
    buildState: { building: false, result: { diagnostics: [], featureErrors: [], mesh: { positions: [] } } as unknown as RebuildResult },
    busyState: { active: false, label: "", pct: null },
    rollbackIndex: FEATURES.length,
    isSuppressed: () => false,
    colorPalette: [],
    bodyColorSlot: () => undefined,
    onDocChange: () => () => {},
    onBuild: () => () => {},
    onBusy: () => () => {},
  } as unknown as DocumentStore;
  const menus = createContextMenus({
    store,
    toolBusy: () => false,
    setStatus: () => {},
    copySketchToPlane: (id: string) => chosen.push(`copy ${id}`),
    moveSketchPlane: (id: string) => chosen.push(`move ${id}`),
  } as never);
  return { store, menus, chosen };
}

const rightClick = (el: FakeEl): CtxItem[] => {
  const n = opened.length;
  el.dispatch("contextmenu", { preventDefault() {}, clientX: 0, clientY: 0 });
  expect(opened.length, "the right-click opened no menu").toBe(n + 1);
  return opened.at(-1)!;
};
const labels = (items: CtxItem[]) => items.map((i) => i.label);
const COPY = t("context.copySketchToPlane");
const MOVE = t("context.moveSketchPlane");

describe("a sketch's right-click menu", () => {
  it("on its Timeline chip offers Copy and Move, wired to that sketch; an extrude's chip does not", () => {
    const { store, menus, chosen } = setup();
    const root = new FakeEl("div");
    const timeline = new Timeline(root as unknown as HTMLElement, store);
    timeline.featureMenu = (id) => menus.featureActions(id);
    timeline.select(null);
    const [sketchChip, extrudeChip] = byClass(root, "timeline-node");
    expect(sketchChip && extrudeChip, "the timeline rendered no chips").toBeTruthy();

    const items = rightClick(sketchChip!);
    expect(labels(items)).toContain(COPY);
    expect(labels(items)).toContain(MOVE);
    items.find((i) => i.label === COPY)!.onClick!();
    items.find((i) => i.label === MOVE)!.onClick!();
    expect(chosen).toEqual(["copy s1", "move s1"]);

    const other = labels(rightClick(extrudeChip!));
    expect(other).not.toContain(COPY);
    expect(other).not.toContain(MOVE);
  });

  it("on its Browser row offers Copy and Move ahead of Edit", () => {
    const { store, menus, chosen } = setup();
    const root = new FakeEl("div");
    const tree = new BrowserTree(root as unknown as HTMLElement, store);
    tree.sketchMenu = (id) => menus.sketchActions(id);
    tree.onEditSketch = () => {};
    tree.select(null);
    // The rows are Origin's three planes, then the one sketch: the stub
    // parses no markup, so the row is found by position, not by its label.
    const rows = byClass(root, "feature-row tree-child");
    expect(rows, "the Browser rendered the wrong rows").toHaveLength(4);
    const items = rightClick(rows[3]!);
    expect(labels(items).slice(0, 3)).toEqual([COPY, MOVE, t("common.edit")]);
    items[0]!.onClick!();
    items[1]!.onClick!();
    expect(chosen).toEqual(["copy s1", "move s1"]);
  });
});
