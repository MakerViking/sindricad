// Double-clicking a feature must DO something, or say why it doesn't.
//
// Field report c8531ceb (0.1.144): "Create Cylinder over Primites Menue is ok,
// but editing has no effect." The triage was half wrong and half worse than
// reported. `editFeature` switches on the feature type; six types have arms
// (sketch, fillet, chamfer, extrude, texture, textOnFace) and each falls back to
// a setStatus when its interactive tool declines. The `default:` arm — where 24
// of the 30 types land, cylinder among them — was a bare `break;`. The inspector
// WAS already showing "Radius mm" / "Height mm", so the gesture had worked; it
// just never said so, and double-click was indistinguishable from single click.
// For the 8 types with no numeric fields at all the panel rendered nothing.
//
// This reads main.ts as TEXT rather than importing it, because importing main.ts
// boots the whole app (window, WebGL, the sidecar socket) — same reason as
// ribbonActions.test.ts. The cost of that choice is a test that can go stale, so
// it asserts its own anchors first: if `editFeature` or its switch is renamed,
// this fails loudly instead of quietly passing with a hole in it.
//
// What it CANNOT cover, stated rather than implied: main.ts's wiring is only
// ever seen as source here, so these assertions pin the EXPRESSION, never the
// mere presence of an identifier — a reference to `isInspectorEditable` next to
// an unconditional tooltip string satisfied the old check. The timeline chip is
// NOT in that category any more: a source regex on `node.title = featureTooltip(…)`
// pins the shape of the call and nothing else, so hard-coding the last argument
// restored the round-1 lie on every chip with the suite green. The chip is now
// rendered for real against the element stub and its title read back. What the
// inspector renders (caret placement, the fieldless empty state) is exercised
// the same way in inspectorPanel.test.ts.
import { describe, it, expect } from "vitest";
import { FakeEl, installFakeDocument, byClass } from "./fakeDom.testkit";
import { isInspectorEditable, editHint } from "./inspector";
import { featureTooltip, Timeline } from "./timeline";
import { FEATURE_META } from "./featureMeta";
import type { DocumentStore } from "../document/store";
import type { CadDocument, FeatureType } from "../types";
// `?raw` rather than fs: tsconfig's types are ["vite/client"] with no @types/node,
// and vite/client already declares this form.
import mainSrc from "../main.ts?raw";
import timelineSrc from "./timeline.ts?raw";

installFakeDocument();

/** The `{...}` block starting at `openAt`, brace-matched. */
function balancedBlock(src: string, openAt: number): string {
  let depth = 0;
  for (let i = openAt; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(openAt, i + 1);
  }
  throw new Error("unbalanced braces from index " + openAt);
}

/** The body of editFeature's `switch (f.type)`, as source text. */
function editSwitchBody(main: string): string {
  const fnAt = main.indexOf("function editFeature(");
  expect(fnAt, "no `function editFeature(` in main.ts — this test no longer knows where the edit gesture lands").toBeGreaterThan(-1);
  const switchAt = main.indexOf("switch (f.type)", fnAt);
  expect(switchAt, "editFeature no longer dispatches on `switch (f.type)` — this test's slice is stale").toBeGreaterThan(-1);
  return balancedBlock(main, main.indexOf("{", switchAt));
}

/** The body of a `const name = () => { … }` helper in main.ts, as source text.
 *  Every switch arm hands over to one of these, so an assertion about what the
 *  arm DOES has to resolve one level deeper than the call. */
function arrowHelperBody(main: string, name: string): string {
  const at = main.indexOf(`const ${name} = () => {`);
  expect(at, `no \`const ${name} = () => {\` helper in main.ts — this test's slice is stale`).toBeGreaterThan(-1);
  return balancedBlock(main, main.indexOf("{", at));
}

/** What an arm calls to speak: `setStatus(` inline, or the single no-arg helper
 *  it delegates to. Returns the source text that must contain the message. */
function armSpeech(main: string, arm: string): string {
  if (arm.includes("setStatus(")) return arm;
  const callee = /\b([A-Za-z_$][\w$]*)\(\);/.exec(arm)?.[1];
  expect(callee, "the arm neither calls setStatus nor delegates to a helper — it says nothing").toBeTruthy();
  return arrowHelperBody(main, callee!);
}

const TYPES = Object.keys(FEATURE_META) as FeatureType[];

/** Render a REAL Timeline into the element stub (fakeDom.testkit) and hand back
 *  its chips, so an assertion can read `node.title` — the string the user
 *  actually hovers — instead of the shape of the call that produced it. The
 *  timeline only renders on a store event or on select(), so select(null) is
 *  the public way to ask for one. */
function renderChips(
  features: { id: string; type: string }[],
  failing: { id: string; message: string } | null = null,
): FakeEl[] {
  const root = new FakeEl("div");
  const store = {
    document: { features, parameters: {}, paramDefs: {} } as unknown as CadDocument,
    buildState: {
      building: false,
      errorFeatureId: failing?.id,
      errorMessage: failing?.message,
    },
    busyState: { active: false, label: "", pct: null },
    rollbackIndex: features.length,
    isSuppressed: () => false,
    onDocChange: () => () => {},
    onBuild: () => () => {},
    onBusy: () => () => {},
  } as unknown as DocumentStore;
  const timeline = new Timeline(root as unknown as HTMLElement, store);
  timeline.select(null);
  return byClass(root, "timeline-node");
}

describe("editing a feature always reaches an editor or an explanation", () => {
  it("knows where the edit dispatch lives (fails if it was renamed)", () => {
    // guards the guard: if these anchors drop, the assertions below start
    // passing for the wrong reason
    const body = editSwitchBody(mainSrc);
    expect(body.startsWith("{")).toBe(true);
    expect(body, "the switch body looks empty — the slice is wrong").toContain("case \"sketch\"");
    expect(TYPES.length, "FEATURE_META is empty — the source-free tests below would be vacuous").toBeGreaterThan(20);
  });

  it("the default arm speaks — the 24 types with no arm must not fall through silently", () => {
    const body = editSwitchBody(mainSrc);
    const defaultAt = body.indexOf("default:");
    expect(defaultAt, "editFeature's switch has no `default:` — an unhandled type now falls off the end entirely").toBeGreaterThan(-1);
    const arm = body.slice(defaultAt);
    expect(
      armSpeech(mainSrc, arm),
      "editFeature's `default:` arm says nothing, so double-clicking a cylinder (and 23 other types) "
        + "is indistinguishable from a single click — field report c8531ceb.",
    ).toContain("setStatus(");
  });

  it("has a message for every feature type, editable or not", () => {
    // Source-free, so it survives any refactor of the arm above: this is what
    // stops a 31st feature type shipping with an empty or unlabelled message.
    for (const t of TYPES) {
      expect(typeof isInspectorEditable(t), `isInspectorEditable(${t}) is not a boolean`).toBe("boolean");
      expect(FEATURE_META[t].label.length, `${t} has an empty label`).toBeGreaterThan(0);
      const hint = editHint(t);
      expect(hint.length, `editHint(${t}) is empty`).toBeGreaterThan(0);
      expect(hint, `editHint(${t}) does not name the feature`).toContain(FEATURE_META[t].label);
    }
  });

  it("the message and the timeline tooltip key on the SAME predicate", () => {
    // (a) behavioural: the hint's two shapes fork exactly on isInspectorEditable
    for (const t of TYPES) {
      const promisesAnEditor = editHint(t).includes("Edit ");
      expect(
        promisesAnEditor,
        `editHint(${t}) promises an editor that isInspectorEditable(${t}) says is not there`,
      ).toBe(isInspectorEditable(t));
    }
    // (b) behavioural, the tooltip side: the chip's hover text makes the
    // double-click promise for exactly the types that can keep it. Source-free
    // — reading the file for the word "isInspectorEditable" passed happily with
    // the title reverted to an unconditional "double-click to edit".
    for (const t of TYPES) {
      const tip = featureTooltip(0, FEATURE_META[t].label, undefined, isInspectorEditable(t));
      expect(
        tip.includes("double-click to edit"),
        `the ${t} chip's tooltip disagrees with isInspectorEditable(${t})`,
      ).toBe(isInspectorEditable(t));
      expect(tip, `the ${t} chip's tooltip drops the right-click affordance`).toContain("right-click for more");
      expect(tip, `the ${t} chip's tooltip does not name the feature`).toContain(FEATURE_META[t].label);
    }
    expect(featureTooltip(2, "Loft", "boom", true), "a build error must stay in the tooltip").toContain("boom");
    // (c) both call sites read that one predicate rather than re-deriving it —
    // a second copy of "which types are editable" is how the tooltip and the
    // status message drift apart.
    expect(
      mainSrc,
      "main.ts no longer routes the default arm through editHint — the message can now disagree with the tooltip",
    ).toContain("editHint(");
    expect(
      timelineSrc,
      "the timeline chip no longer builds its title with featureTooltip, so the hover text "
        + "can promise \"double-click to edit\" on rows that have nothing to edit",
    ).toMatch(/node\.title\s*=\s*featureTooltip\(/);
  });

  it("the RENDERED chip promises double-click only where there is an editor", () => {
    // The EFFECT, not the call. Everything above this either exercises
    // featureTooltip in isolation with a correct argument passed in, or pins
    // the SHAPE of `node.title = featureTooltip(…)` with a regex — so
    // hard-coding that last argument to `true` at the call site restores the
    // round-1 affordance lie on every chip with the whole suite green (round-2
    // review). This builds a real Timeline against the element stub and reads
    // the hover text back off the chip.
    const editable = TYPES.filter((t) => isInspectorEditable(t));
    const fieldless = TYPES.filter((t) => !isInspectorEditable(t));
    expect(editable.length, "no editable types — the loop below could not catch a hard-coded false").toBeGreaterThan(0);
    expect(fieldless.length, "no fieldless types — the loop below could not catch a hard-coded true").toBeGreaterThan(0);

    const chips = renderChips(TYPES.map((t, i) => ({ id: `f${i}`, type: t })));
    expect(chips.length, "the timeline rendered no chips at all — the stub or the store shim is wrong").toBe(TYPES.length);
    for (const [i, t] of TYPES.entries()) {
      const title = chips[i]!.title;
      expect(title, `the rendered ${t} chip's tooltip does not name the feature`).toContain(FEATURE_META[t].label);
      expect(
        title.includes("double-click to edit"),
        isInspectorEditable(t)
          ? `the rendered ${t} chip hides the double-click affordance on a feature that HAS an editor`
          : `the rendered ${t} chip promises "double-click to edit" and there is nothing to edit — field report c8531ceb`,
      ).toBe(isInspectorEditable(t));
      expect(title, `the rendered ${t} chip drops the right-click affordance`).toContain("right-click for more");
    }
  });

  it("a failing chip carries its build error into the hover text", () => {
    const [chip] = renderChips([{ id: "f0", type: "loft" }], { id: "f0", message: "boom" });
    expect(chip, "no chip rendered").toBeTruthy();
    expect(chip!.title, "the build error never reaches the chip the user hovers").toContain("boom");
  });

  it("the chip's right-click menu offers Edit only where the tooltip does", () => {
    // The tooltip stopped saying "double-click to edit" on a loft, so the user
    // right-clicks instead — and the menu said "Edit", which lands in
    // editFeature's default arm and answers "Loft has no editable values".
    // Same broken promise, one gesture over. contextMenus.ts makes the same
    // fork for the viewport's face menu.
    expect(
      timelineSrc,
      "the timeline's context menu labels its edit entry unconditionally again — right-clicking "
        + "a loft offers \"Edit\" and then refuses to edit it",
    ).toMatch(/label:\s*editable\s*\?\s*"Edit"\s*:\s*"Select"/);
  });

  it("a tool that declines hands over to the inspector exactly like the default arm", () => {
    // A parameter-bound fillet fails edgeFeatureTool.startEdit's isParamBound
    // check. That arm used to fire a generic "Edit the value in the inspector"
    // with no feature name and no caret — strictly worse affordance than the
    // cylinder in the default arm, for the same gesture.
    const body = editSwitchBody(mainSrc);
    expect(
      body,
      "an arm still hard-codes the old unnamed hint instead of editHint(f.type)",
    ).not.toContain("Edit the value in the inspector");
    const declines = [...body.matchAll(/startEdit\([^)]*\)\)\s*([A-Za-z_$][\w$]*)\(\)/g)].map((m) => m[1]!);
    expect(declines.length, "no `if (!<tool>.startEdit(...)) <fallback>()` arms found — the slice is stale").toBeGreaterThanOrEqual(4);
    const defaultArm = body.slice(body.indexOf("default:"));
    for (const fn of declines) {
      expect(
        defaultArm,
        `a declining tool falls back to ${fn}(), which is not what the default arm does`,
      ).toContain(`${fn}()`);
    }
    // and that shared fallback both names the feature and puts the caret in it
    const fallback = arrowHelperBody(mainSrc, declines[0]!);
    expect(fallback, "the fallback says nothing").toContain("setStatus(");
    expect(fallback, "the fallback does not name the feature (editHint)").toContain("editHint(f.type)");
    expect(fallback, "the fallback does not put the caret in the inspector").toMatch(/inspector\.select\(id,\s*true\)/);
  });

  it("promises double-click only where something can be edited", () => {
    // The 8 types with neither numeric fields nor an interactive tool
    // (deleteFace, mirror, loft, sweep, import, split, combine, removeBody).
    const fieldless = TYPES.filter((t) => !isInspectorEditable(t));
    expect(fieldless.length, "no fieldless types found — the predicate is broken").toBeGreaterThan(0);
    for (const t of fieldless) {
      expect(editHint(t), `${t} is not editable but its hint invites an edit`).toContain("no editable values");
    }
  });
});
