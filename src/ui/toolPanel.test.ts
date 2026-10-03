// The generic docked tool panel (ui/toolPanel.ts), on the element stub: the
// behaviour every tool that describes its rows gets for free, so each tool's
// own tests can assume it.
import { describe, expect, it, afterEach } from "vitest";
import { FakeEl, installFakeDocument } from "./fakeDom.testkit";
import { setUnit, setFieldParams } from "./units";

installFakeDocument();
const { ToolPanel } = await import("./toolPanel");

afterEach(() => {
  setUnit("mm");
  setFieldParams(() => ({}));
});

function mount() {
  const body = (globalThis.document as unknown as { body: FakeEl }).body;
  body.children.length = 0;
  const panel = new ToolPanel("probe");
  const seen: string[] = [];
  panel.show("Probe", [
    { kind: "number", id: "len", label: "Length" },
    { kind: "number", id: "ang", label: "Angle", field: "angle" },
    { kind: "choice", id: "side", label: "Side", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { kind: "pick", id: "target", label: "Target", clearTitle: "Clear" },
  ], {
    onNumber: (id, v, raw) => seen.push(`${id}=${v}|${raw}`),
    onChoice: (id, v) => seen.push(`${id}:${v}`),
    onPick: (id) => seen.push(`pick ${id}`),
    onClear: (id) => seen.push(`clear ${id}`),
    onOk: () => seen.push("ok"),
    onCancel: () => seen.push("cancel"),
  });
  const root = body.children[0]!;
  const rows = root.children;
  const input = (i: number) => rows[i]!.children[1]!;
  return { panel, seen, root, rows, input };
}

describe("ToolPanel", () => {
  it("reads a number row as an expression, in the display unit", () => {
    setUnit("in");
    setFieldParams(() => ({ wall: 2 }));
    const { seen, input } = mount();
    const len = input(1);
    len.value = "1/16";
    len.dispatch("input");
    len.value = "wall*2";
    len.dispatch("input");
    expect(seen).toEqual([`len=${25.4 / 16}|1/16`, "len=4|wall*2"]);
  });

  it("marks text it cannot read, reports it as null, and says so to OK", () => {
    const { panel, seen, input } = mount();
    const len = input(1);
    len.value = "3.14.15";
    len.dispatch("input");
    expect(seen).toEqual(["len=null|3.14.15"]);
    expect(len.classList.contains("invalid")).toBe(true);
    expect(panel.numberUnreadable("len")).toBe(true);
    panel.setNumber("len", 5);
    expect(panel.numberUnreadable("len"), "a value written by the tool is readable again").toBe(false);
  });

  it("does not rewrite an expression the tool echoes back with the same value", () => {
    setUnit("in");
    const { panel, input } = mount();
    const len = input(1);
    len.value = "1/16";
    len.dispatch("input");
    panel.setNumber("len", 25.4 / 16);
    expect(len.value, "the typed expression was replaced by its value mid-edit").toBe("1/16");
    panel.setNumber("len", 25.4);
    expect(len.value).toBe("1");
  });

  it("owns its inputs and buttons, and nothing else", () => {
    const { panel, input, root } = mount();
    const len = input(1) as unknown as EventTarget;
    expect(panel.owns(len)).toBe(true);
    expect(panel.owns(panel.cancelButton)).toBe(true);
    expect(panel.owns(new FakeEl("input") as unknown as EventTarget)).toBe(false);
    expect(panel.owns(null)).toBe(false);
    panel.hide();
    expect(panel.owns(len), "a hidden panel still claimed its old field").toBe(false);
    expect(root.children).toEqual([]);
  });

  it("a choice chip reports its value; the pick box activates, and its clear does not also activate", () => {
    const { panel, seen, rows } = mount();
    const chips = rows[3]!.children[1]!.children;
    chips[1]!.dispatch("click");
    panel.setChoice("side", "b");
    expect(chips.map((c) => c.classList.contains("on"))).toEqual([false, true]);

    const pick = rows[4]!;
    pick.dispatch("click");
    const clear = pick.children[1]!.children[1]!;
    let stopped = false;
    clear.dispatch("click", { stopPropagation: () => (stopped = true) });
    expect(seen).toEqual(["side:b", "pick target", "clear target"]);
    expect(stopped, "the clear click would also reach the box and re-activate it").toBe(true);
  });

  it("hides a row that does not apply, and makes a bound one read-only", () => {
    const { panel, rows, input } = mount();
    panel.setVisible("ang", false);
    expect(rows[2]!.style.display).toBe("none");
    panel.setReadOnly("len", "bound");
    expect(input(1).disabled).toBe(true);
    expect(input(1).title).toBe("bound");
  });
});
