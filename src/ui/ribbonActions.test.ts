// Every ribbon action must reach a handler.
//
// `handleAction` in main.ts ends in a switch with NO `default:` case, so an
// action the ribbon can emit but nothing handles does nothing at all, forever,
// with no error. That is the same silent-no-op class that left 11 of the 12
// sketch constraint tools unable to answer a click (see constraintCoverage).
//
// All 84 actions are wired today — this is a guard against the 85th, not a
// report of a bug.
//
// It reads main.ts as TEXT rather than importing it, because importing main.ts
// boots the whole app (window, WebGL, the sidecar socket). The cost of that
// choice is that the test must know how dispatch is spelled, so it ALSO asserts
// that each dispatch mechanism it knows about is still present: if someone
// renames SKETCH_MODIFY, this fails loudly instead of quietly passing with a
// hole in it. A test that cannot detect its own staleness is worse than none.
import { describe, it, expect } from "vitest";
import { MODEL, SKETCH } from "./ribbon";
// `?raw` rather than fs: tsconfig's types are ["vite/client"] with no @types/node,
// and vite/client already declares this form.
import mainSrc from "../main.ts?raw";

/** every action string the ribbon can emit, from both contexts */
function ribbonActions(): string[] {
  const out: string[] = [];
  const walk = (items: any[]) => {
    for (const it of items ?? []) {
      if (typeof it?.action === "string") out.push(it.action);
      if (Array.isArray(it?.items)) walk(it.items);
      if (Array.isArray(it?.children)) walk(it.children);
    }
  };
  for (const g of [...(MODEL ?? []), ...(SKETCH ?? [])] as any[]) walk(g.items ?? []);
  return [...new Set(out)];
}

/** the names main.ts can route, across every dispatch mechanism it uses */
function handledActions(main: string): { handled: Set<string>; mechanisms: string[] } {
  const handled = new Set<string>();
  const mechanisms: string[] = [];

  const cases = [...main.matchAll(/case\s+"([^"]+)"/g)].map((m) => m[1]!);
  if (cases.length) mechanisms.push("switch/case");
  cases.forEach((c) => handled.add(c));

  const eqs = [...main.matchAll(/action === "([^"]+)"/g)].map((m) => m[1]!);
  if (eqs.length) mechanisms.push("action === literal");
  eqs.forEach((c) => handled.add(c));

  // set/record dispatch: `SKETCH_TOOLS.has(action)` and `SKETCH_MODIFY[action]`
  for (const name of ["SKETCH_TOOLS", "SKETCH_MODIFY"]) {
    const at = main.indexOf(`const ${name}`);
    expect(at, `${name} is gone from main.ts — this test no longer knows how actions are routed`).toBeGreaterThan(-1);
    const body = main.slice(at, main.indexOf("};", at) > -1 ? main.indexOf("};", at) : main.indexOf("]);", at));
    for (const m of body.matchAll(/"([^"]+)"/g)) handled.add(m[1]!);
    mechanisms.push(name);
  }
  return { handled, mechanisms };
}

describe("ribbon actions all reach a handler", () => {
  const main = mainSrc;
  const actions = ribbonActions();
  const { handled, mechanisms } = handledActions(main);

  it("knows how dispatch is spelled (fails if a mechanism was renamed)", () => {
    // guards the guard: if this drops, the assertion below starts passing for
    // the wrong reason
    expect(mechanisms).toContain("switch/case");
    expect(mechanisms).toContain("SKETCH_TOOLS");
    expect(mechanisms).toContain("SKETCH_MODIFY");
    expect(actions.length, "no ribbon actions found — the walker is broken").toBeGreaterThan(50);
  });

  it("routes every action the ribbon can emit", () => {
    const orphans = actions.filter((a) => !handled.has(a));
    expect(
      orphans,
      `these ribbon actions reach no handler, so clicking them does nothing: ${orphans.join(", ")}. `
        + "handleAction has no default: case, so an unwired action fails silently.",
    ).toEqual([]);
  });
});

// Reaching *a* handler is not the same as reaching the RIGHT one, and the
// difference is a field report. "Rect Pattern" and "Circular Pat." live in the
// SKETCH ribbon's PATTERN group and pattern sketch geometry; both were listed in
// SKETCH_TOOLS, so the guard above was satisfied — while a click outside a sketch
// fell into startSketch() and opened an interactive plane pick. The user had
// selected a body and expected it patterned:
//
//   "I am trying to use RECT PATT and it doesn't work. I click the item I want to
//    use. Then I click RECT PATT and it doesn't do anything." (a31a6213)
//
// It was not doing nothing — it was quietly waiting for a plane.
describe("the pattern buttons pattern what their name says", () => {
  const main = mainSrc;

  it("routes a pattern click OUTSIDE a sketch to the body pattern", () => {
    const at = main.indexOf("starters.startBodyPattern(");
    expect(
      at,
      "nothing routes patternRect/patternCircular to a body pattern, so clicking Rect Pattern "
        + "with a body selected opens a plane pick instead (field report a31a6213)",
    ).toBeGreaterThan(-1);
    const before = main.slice(Math.max(0, at - 400), at);
    expect(
      before,
      "the body-pattern route is not guarded on being outside a sketch — it would hijack the "
        + "sketch pattern tool while sketching",
    ).toContain("!sketch.active");
    for (const a of ["patternRect", "patternCircular"]) {
      expect(before, `${a} is not routed to the body pattern`).toContain(`"${a}"`);
    }
  });

  it("still reaches the SKETCH pattern tool while a sketch is open", () => {
    // The sketch tools are the other half: inside a sketch these must keep
    // setting the sketch tool, not append a body feature.
    const at = main.indexOf("const SKETCH_TOOLS");
    expect(at, "SKETCH_TOOLS is gone — this test's slice is stale").toBeGreaterThan(-1);
    const table = main.slice(at, main.indexOf("]", at));
    for (const a of ["patternRect", "patternCircular"]) {
      expect(table, `${a} was removed from SKETCH_TOOLS — the sketch pattern tool is now unreachable`).toContain(a);
    }
  });

  it("keeps the body Pattern entry point that already existed", () => {
    // Modify > Move > Pattern still asks rect-or-circular; the new path only
    // skips that question because the button already answered it.
    expect(main, "the generic Pattern action lost its handler").toContain("starters.startPattern()");
  });
});
