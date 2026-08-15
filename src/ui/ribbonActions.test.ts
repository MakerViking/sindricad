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
