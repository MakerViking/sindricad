// A running tool sees a Browser row click FIRST (BrowserTree.pickHook).
//
// During Split Body an origin-plane row is the splitting tool, not "start a
// sketch here", a datum row is the tool, not a selection, and a body row fills
// the Body field. Without the hook the rows do what they always did. The real
// BrowserTree, not the tool's own hook in isolation: splitTool.test.ts calls
// the hook directly and would stay green if the tree stopped consulting it.
// (The rows are built from markup the element stub cannot parse, so the click
// is entered at the method each row's click handler calls.)
import { describe, expect, it } from "vitest";
import { FakeEl, installFakeDocument } from "./fakeDom.testkit";
import { BrowserTree, type TreePick } from "./browserTree";
import type { DocumentStore } from "../document/store";

installFakeDocument();

function tree() {
  const store = { onDocChange: () => () => {}, onBuild: () => () => {} } as unknown as DocumentStore;
  const t = new BrowserTree(new FakeEl("div") as unknown as HTMLElement, store);
  const calls: string[] = [];
  t.onSketchOnPlane = (p) => calls.push(`sketch ${p}`);
  t.onSelect = (id) => calls.push(`select ${id}`);
  t.onSelectBody = (id, add) => calls.push(`selectBody ${id} ${add}`);
  return { t, calls };
}

describe("Browser rows under a running tool", () => {
  it("offers every row to the tool first, and does nothing else when it takes the click", () => {
    const { t, calls } = tree();
    const picks: TreePick[] = [];
    t.pickHook = (p) => {
      picks.push(p);
      return true;
    };
    t.clickOriginRow("XY");
    t.clickDatumRow("f7");
    t.clickBodyRow("body2", false);
    t.clickBodyRow("body3", true);
    expect(picks).toEqual([
      { kind: "origin", plane: "XY" },
      { kind: "datum", id: "f7" },
      { kind: "body", id: "body2", additive: false },
      { kind: "body", id: "body3", additive: true },
    ]);
    expect(calls, "a row the tool took ALSO started a sketch or changed the selection").toEqual([]);
  });

  it("with no tool (or one that declines), the rows do what they always did", () => {
    const { t, calls } = tree();
    t.clickOriginRow("XZ");
    t.pickHook = () => false;
    t.clickDatumRow("f7");
    t.clickBodyRow("body2", true);
    expect(calls).toEqual(["sketch XZ", "select f7", "selectBody body2 true"]);
  });
});
