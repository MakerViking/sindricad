// The select tool must be REACHABLE from inside a sketch.
//
// Field report c9db7ec2 (0.1.148): "There doesn't seem to be any way to select
// elements (lines, rectangles, etc) in sketch mode, although there is a list of
// editable lengths in the right-hand sidebar." It was right. enter() armed a
// drawing tool, the sketch ribbon had no select button, nothing bound a key to
// it, and the right-click menu returns early unless the tool is ALREADY select —
// so Escape was the only way back, and it is the third branch of that chain
// (in-progress points, then selection, then tool), i.e. up to two presses from a
// user who has to guess the key in the first place.
//
// What this file can and cannot do, stated rather than implied: sketchMode.ts is
// e2e territory (vitest.config scopes it out of coverage, and there is no jsdom
// here), so the tool switch ITSELF is not exercised anywhere. What is pinned
// below is the DATA every route is built from — the ribbon table, the shortcut
// table, and the command registry derived from both. A future edit that deletes
// the button or the binding fails here instead of shipping.
import { describe, it, expect } from "vitest";
import { SKETCH, PINNED, leavesOf, type Item, type ToolItem } from "./ribbon";
import { resolveShortcut, keyHint, SHORTCUTS } from "../input/shortcuts";
import { allCommands } from "./commands";

/** the group label an action sits under, and whether it is a one-click item
 *  (a direct ToolItem) rather than a leaf of a split-button dropdown */
function findInSketch(action: string): { group: string; item: ToolItem; oneClick: boolean } | null {
  for (const g of SKETCH) {
    for (const it of g.items as Item[]) {
      const leaves = leavesOf(it);
      const hit = leaves.find((l) => l.action === action);
      if (hit) return { group: g.label, item: hit, oneClick: !("children" in it) };
    }
  }
  return null;
}

describe("the sketch select tool is reachable", () => {
  it("has a one-click entry in the sketch ribbon", () => {
    const found = findInSketch("select");
    expect(
      found,
      "no `select` entry in the SKETCH ribbon — a user in a drawing tool has no button to get back to picking entities (field report c9db7ec2)",
    ).not.toBeNull();
    // Buried in a split dropdown it would be behind a ▾ that shows a DIFFERENT
    // tool on its face, which is the same discoverability hole one level down.
    expect(found!.oneClick, "select is hidden inside a split-button dropdown").toBe(true);
  });

  it("sits in a group that never collapses into the overflow", () => {
    // The ribbon sheds low-priority groups into a "⋯ More" popup as the window
    // narrows. Select is the way OUT of a drawing tool, so it has to survive a
    // narrow window for the same reason Finish Sketch does.
    const found = findInSketch("select");
    expect(found).not.toBeNull();
    expect(
      PINNED.has(found!.group),
      `select lives in group ${found!.group}, which is not pinned — a narrow window can hide it in the overflow popup`,
    ).toBe(true);
  });

  it("is bound to a key in the sketch context", () => {
    expect(
      resolveShortcut("s", false, "sketch"),
      "no sketch-context key resolves to `select`",
    ).toBe("select");
    // the ribbon tooltip and the command palette both render this hint
    expect(keyHint("select")).toBe("S");
  });

  it("is bound only in the sketch context, so model-mode S still starts a sketch", () => {
    // Written against the table rather than resolveShortcut(): the model entry
    // `s -> sketch` is FIRST in SHORTCUTS, so a resolve check in model context
    // returns "sketch" no matter what this binding says — an assertion that
    // cannot fail. What can actually go wrong is this entry being written with
    // context "global" or "model", which makes S in model mode a select that
    // only reaches "Enter a sketch to select sketch geometry".
    const contexts = SHORTCUTS.filter((s) => s.action === "select").map((s) => s.context);
    expect(contexts, "the select binding is not sketch-scoped").toEqual(["sketch"]);
  });

  it("is searchable in the command palette", () => {
    const cmd = allCommands().find((c) => c.id === "select" && c.context === "sketch");
    expect(cmd, "select is not in the Ctrl+K command registry").toBeDefined();
    expect(cmd!.key).toBe("S");
  });
});
