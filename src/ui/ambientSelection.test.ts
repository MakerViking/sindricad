// Two field bugs whose common shape is a promise the UI made and did not keep.
//
// 1. 18abd1bb (0.1.184) + c8531ceb (0.1.144): a primitive's dimensions could not
//    be edited from the side panel. The inspector was never the problem — it
//    renders Length/Width/Height and commits them correctly (inspectorPanel.test
//    covers that, and the real DocumentStore carries the edit through to the
//    rebuilt document). What was missing was any way to GET there: a primitive
//    shows up in the browser tree only as a body row, and clicking a body row
//    set the viewport selection and nothing else.
//
// 2. 58ea6926 (0.1.171) + b2ac3ceb (0.1.181): the prompt said "Esc to clear" on
//    a body selected from the browser tree, and Escape did nothing. The handler
//    was gated on `viewport.selecting === "bodies"`, but the tree calls
//    setSelectedBodies in ANY mode — so in the default Faces mode the body went
//    orange and stayed orange. Both reporters noticed the highlight only cleared
//    when they moved the mouse back over the geometry.
//
// The Escape half is main.ts wiring, so it is pinned as source text in the style
// of featureEditReachable.test.ts — it asserts its own anchor first so a rename
// fails loudly instead of passing with a hole in it. The provenance half is real
// behaviour against the exported function.
import { describe, it, expect } from "vitest";
import { soleFeatureForBody } from "../document/bodyMaker";
import mainSrc from "../main.ts?raw";

/** The `{...}` block starting at `openAt`, brace-matched. */
function balancedBlock(src: string, openAt: number): string {
  let depth = 0;
  for (let i = openAt; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(openAt, i + 1);
  }
  throw new Error("unbalanced braces from index " + openAt);
}

/** The body of the keydown listener that handles Escape for ambient selection. */
function escapeHandler(): string {
  const marker = "// Esc clears the ambient selection";
  const at = mainSrc.indexOf(marker);
  expect(
    at,
    "no ambient-selection Escape handler in main.ts — either it was renamed or "
      + "removed, and this test can no longer tell whether Escape clears a body selection",
  ).toBeGreaterThan(-1);
  const listenerAt = mainSrc.indexOf("window.addEventListener(\"keydown\"", at);
  expect(listenerAt, "the marker comment is no longer followed by a keydown listener").toBeGreaterThan(-1);
  return balancedBlock(mainSrc, mainSrc.indexOf("{", mainSrc.indexOf("=>", listenerAt)));
}

describe("Esc clears a body selection however the body was selected", () => {
  it("does not gate on the viewport's selection mode", () => {
    // This is the whole bug. `tree.onSelectBody` -> `viewport.setSelectedBodies`
    // runs in Faces mode too, so an Escape handler that first checks
    // `viewport.selecting === "bodies"` refuses exactly the case both users hit.
    const body = escapeHandler();
    expect(
      body,
      "the Escape handler checks `viewport.selecting` again — a body selected from the "
        + "browser tree while in Faces mode goes orange, the prompt promises \"Esc to clear\", "
        + "and Escape does nothing (field reports 58ea6926, b2ac3ceb)",
    ).not.toContain("viewport.selecting");
    expect(body, "the handler no longer clears the body selection at all").toContain("setSelectedBodies([])");
  });

  it("still refuses to fire while a tool or a sketch owns Escape", () => {
    // Escape cancels the active tool first; clearing an ambient selection out
    // from under a running extrude would be a different bug.
    const body = escapeHandler();
    expect(body, "the handler no longer defers to an active tool").toContain("toolBusy()");
    expect(body, "the handler no longer defers to the sketch editor").toContain("sketch.active");
  });

  it("clears the face/edge selection the prompt makes the same promise about", () => {
    // onSelectionChange says "N edges selected — Fillet or Chamfer to apply ·
    // Esc to clear" and there was NO handler for it at all: the identical
    // broken promise, one selection kind over.
    const body = escapeHandler();
    expect(
      body,
      "nothing clears the edge/face selection, though onSelectionChange promises \"Esc to clear\"",
    ).toContain("clearSelection()");
  });
});

describe("selecting a body opens the feature that made it", () => {
  const box = { id: "body1", faceOwners: ["f1", "f1", "f1", "f1", "f1", "f1"] };
  const filleted = { id: "body2", faceOwners: ["f1", "f1", "f2", "f1", "f2", "f1"] };

  it("names the maker of a primitive, whose faces all trace to one feature", () => {
    expect(soleFeatureForBody([box], "body1")).toBe("f1");
  });

  it("refuses a body more than one feature touched", () => {
    // faceOwners is the LAST modifier per face. Opening "f1" here would name a
    // feature the user did not click and whose values are not what they see.
    expect(soleFeatureForBody([filleted], "body2")).toBeNull();
  });

  it("is null rather than throwing on the states a build can arrive in", () => {
    expect(soleFeatureForBody(undefined, "body1")).toBeNull();
    expect(soleFeatureForBody([], "body1")).toBeNull();
    expect(soleFeatureForBody([box], "nosuchbody")).toBeNull();
    expect(soleFeatureForBody([{ id: "b", faceOwners: [] }], "b")).toBeNull();
    expect(soleFeatureForBody([{ id: "b" }], "b")).toBeNull();
    // an unattributed first face is not a maker, even if the rest agree
    expect(soleFeatureForBody([{ id: "b", faceOwners: [null, "f1"] }], "b")).toBeNull();
  });

  it("is wired into the body-selection handler, for ONE body only", () => {
    // Behavioural cover stops at the module boundary — main.ts is only ever
    // read as source here — so pin the two things that make the fix reach the
    // user: that the handler calls it, and that it opens the INSPECTOR rather
    // than moving the whole selection (which would take the browser tree's
    // highlight off the body row the user just clicked).
    const at = mainSrc.indexOf("viewport.onBodySelectionChange");
    expect(at, "no onBodySelectionChange handler in main.ts — this test's slice is stale").toBeGreaterThan(-1);
    const handler = balancedBlock(mainSrc, mainSrc.indexOf("{", mainSrc.indexOf("=>", at)));
    expect(
      handler,
      "the body-selection handler no longer resolves the body's maker, so a primitive's "
        + "dimensions are unreachable from the browser tree again (field report 18abd1bb)",
    ).toContain("soleFeatureForBody(");
    expect(handler, "the maker is resolved but never opened in the inspector").toMatch(/inspector\.select\(\s*maker/);
    expect(
      handler,
      "the handler no longer restricts itself to a single selected body — with several "
        + "selected there is no one feature to show",
    ).toMatch(/sel\.length === 1/);
    expect(
      handler,
      "the handler moved the whole selection instead of just the inspector; the browser "
        + "tree would stop highlighting the body row the user clicked",
    ).not.toMatch(/selectFeature\(\s*maker/);
  });
});
