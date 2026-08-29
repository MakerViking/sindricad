// Two pieces of chrome the user could not read, and one they could not find.
//
//  * GitHub issue #44 + in-app report 55654907 — "all menus have their menu items
//    right justified". Two users, two operating systems. `.menu-item` is
//    `display:flex; justify-content: space-between` and every row carries a
//    fixed-width `.menu-check` slot, so with 2 children (no shortcut) the label
//    went hard RIGHT and with 3 (shortcut) it was CENTRED. The label span had no
//    flex rule anywhere. Regressed when the check slot was added, and wrong in
//    every build since.
//
//  * f156e0a0 — "A lot of the small control arrows next to icons and other areas
//    of the screen are almost invisible - really need improving - not a lot of
//    point to having an on screen control if you can't see it :)". The carets
//    were on the weakest colour tier and inherited the icon set's 1.6 stroke in a
//    24-unit viewBox, which at 11px renders 0.73 CSS px.
//
// styles.css is read as text: there is no jsdom here and no layout engine, so
// what can be checked is the rule that produces the layout and the arithmetic of
// the colours. Both assertions name their own anchor first, so a rename fails
// loudly rather than passing with a hole in it.
import { describe, it, expect } from "vitest";
import css from "../styles.css?raw";
import menuSrc from "./menu.ts?raw";
import iconsSrc from "./icons.ts?raw";

/** The body of the first `selector { … }` block, or null. */
function rule(selector: string): string | null {
  const at = css.indexOf(selector + " {");
  if (at < 0) return null;
  return css.slice(at + selector.length, css.indexOf("}", at));
}

/** A `--name: #rrggbb` custom property from :root. */
function cssVar(name: string): [number, number, number] {
  const m = new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, "i").exec(css);
  if (!m) throw new Error(`no --${name} in styles.css`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// WCAG 1.4.11: non-text UI components and graphical objects need 3:1.
const NON_TEXT_MIN = 3;

describe("menu items read left-to-right", () => {
  it("the label span is classed, so CSS can reach it", () => {
    // The label used to be an unclassed <span>, which is why there was no rule
    // for it: `.menu-item > span` would also have hit the check slot and the
    // shortcut.
    expect(
      menuSrc,
      "the menu label span lost its class, so the .menu-label rule matches nothing and "
        + "space-between pushes the label right again (GitHub #44, report 55654907)",
    ).toMatch(/label\.className\s*=\s*["']menu-label["']/);
  });

  it("the label takes the free space instead of being distributed by space-between", () => {
    const r = rule(".menu-label");
    expect(r, "no .menu-label rule in styles.css — menu labels are unpositioned again").toBeTruthy();
    expect(r, ".menu-label does not grow, so space-between still distributes the row").toMatch(/flex:\s*1/);
    expect(r, ".menu-label is not left-aligned").toContain("text-align: left");
  });

  it("the conditions that made this a bug are still present, so the fix is load-bearing", () => {
    // If .menu-item stopped being space-between, or the check slot stopped being
    // a real child, the rule above would be belt-and-braces rather than the fix.
    // Either is fine — but this test should say so rather than quietly guarding
    // nothing.
    const item = rule(".menu-item");
    expect(item, "no .menu-item rule").toBeTruthy();
    expect(item, ".menu-item is no longer a flex row").toContain("display: flex");
    const check = rule(".menu-check");
    expect(check, "no .menu-check rule").toBeTruthy();
    expect(check, "the check slot is no longer a fixed-width child").toMatch(/width:\s*\d+px/);
    expect(menuSrc, "menu rows no longer always append a check slot").toContain('check.className = "menu-check"');
  });
});

describe("the small control arrows can be seen", () => {
  it("the icon set really is thin at these sizes (the premise)", () => {
    // 1.6 stroke units in a 24-unit viewBox, rendered at 11px, is 0.73 CSS px.
    // This is the measurement the .ribbon-split-arrow comment already records.
    expect(iconsSrc, "icons no longer declare stroke-width 1.6 — this premise is stale").toContain('stroke-width="1.6"');
    const effective = (1.6 * 11) / 24;
    expect(effective, "a caret's effective stroke is no longer sub-pixel").toBeLessThan(1);
  });

  for (const sel of [".tree-caret svg", ".ctx-caret svg", ".menu-check svg", ".ribbon-split-arrow svg"]) {
    it(`${sel} thickens its stroke for the size it is drawn at`, () => {
      const r = rule(sel);
      expect(r, `no ${sel} rule in styles.css — this test's anchor is stale`).toBeTruthy();
      const m = /stroke-width:\s*([\d.]+)/.exec(r!);
      expect(m, `${sel} inherits the 1.6 icon stroke, which is under a CSS pixel at this size`).toBeTruthy();
      expect(Number(m![1]), `${sel} stroke is still too thin to see`).toBeGreaterThanOrEqual(2);
    });
  }

  it("the tree caret is off the weakest colour tier", () => {
    const r = rule(".tree-caret");
    expect(r, "no .tree-caret rule").toBeTruthy();
    expect(
      r,
      ".tree-caret is back on --text-mute, the faintest tier in the theme — the folder "
        + "expanders are what the reporter could not see (field report f156e0a0)",
    ).not.toContain("var(--text-mute)");
  });

  it("the tiers these carets use clear the non-text contrast bar on a panel", () => {
    // The arithmetic, rather than the variable name: --text-dim on --panel.
    const onPanel = contrast(cssVar("text-dim"), cssVar("panel"));
    expect(
      onPanel,
      `--text-dim on --panel is ${onPanel.toFixed(2)}:1, below the 3:1 a non-text control needs`,
    ).toBeGreaterThanOrEqual(NON_TEXT_MIN);
  });

  it("records why --text-mute was not good enough", () => {
    // It PASSES 3:1 on paper, which is exactly why this was easy to leave alone.
    // A 0.73px stroke at that ratio is still unfindable, and the reporter found
    // it so. Kept as a note in executable form: if the tier is ever brightened
    // this test says so instead of silently guarding a stale claim.
    const muteOnPanel = contrast(cssVar("text-mute"), cssVar("panel"));
    expect(muteOnPanel, "--text-mute is no longer the marginal tier this fix moved away from")
      .toBeLessThan(contrast(cssVar("text-dim"), cssVar("panel")));
  });
});
