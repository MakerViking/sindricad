// Phase 2 of localisation: the parts a translation alone does not fix.
//
// Phase 1 put every string through t(). That is necessary and not sufficient —
// a perfect Japanese catalogue still renders as tofu boxes on a Windows install
// without the Japanese language pack, or on a minimal Linux image, because the
// whole UI ran on `"Inter", system-ui, sans-serif` and not one of those three
// has a kana glyph. And a correct translation that is 40% longer than the
// English still gets cut in half by a box measured against the English.
//
// So this file pins two things:
//   1. Japanese CAN be drawn on a machine where nothing was installed — there
//      is a real font file, it is reachable offline, and the stack falls
//      through to the platform's own faces for what the subset lacks.
//   2. English is UNCHANGED. That is the load-bearing half. The subset's
//      unicode-range carries no Latin character, so an English UI never even
//      requests the file; and the boxes that were widened were widened with
//      minima and caps that a short English label cannot reach.
//
// styles.css is read as text (no jsdom, no layout engine here — same approach
// as chromeLegibility.test.ts), so what is checked is the RULE that produces
// the behaviour, plus the actual bytes of the font that ships.
import { describe, it, expect } from "vitest";
import css from "../styles.css?raw";
import { cubeLabelFont, fitLabelPx, LABEL_PX, LABEL_PX_MIN } from "../viewport/viewCube";
import viewCubeSrc from "../viewport/viewCube.ts?raw";

// The shipped binary, by relative path rather than by its public URL: this must
// fail if the file is absent, and a glob that matches nothing is how it says so.
const FONT_FILES = import.meta.glob("../../public/fonts/*.woff2", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The body of the first `selector { … }` block, or null. */
function rule(selector: string): string | null {
  const at = css.indexOf(selector + " {");
  if (at < 0) return null;
  return css.slice(at + selector.length, css.indexOf("}", at));
}

/** styles.css with every CSS comment removed. Needed by anything that looks
 *  for a declaration: the comments in this stylesheet quote the very
 *  declarations they warn against, and a scanner that reads them finds
 *  violations that are not there (and, worse, is then loosened until it
 *  stops seeing the real ones). */
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `selector { body }` block in the stylesheet, comments stripped.
 *  `[^{}]` in both halves means an at-rule wrapper (`@media … {`) is skipped
 *  over rather than swallowing the rules inside it. */
function blocks(): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of code.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1]!.replace(/\s+/g, " ").trim(), body: m[2]! });
  }
  return out;
}

/** `font` / `font-family` declarations, as [selector, property, value]. */
function fontDeclarations(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const { selector, body } of blocks()) {
    for (const decl of body.split(";")) {
      const m = /^\s*(font|font-family)\s*:\s*(.+)$/s.exec(decl);
      if (m) out.push([selector, m[1]!, m[2]!.replace(/\s+/g, " ").trim()]);
    }
  }
  return out;
}

/** A font-family value as a list of family names, quotes stripped. */
function families(value: string): string[] {
  return value.split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""));
}

/** A custom property's value from styles.css, whitespace-collapsed. Takes the
 *  LAST declaration, so a `:lang()` override wins the way the cascade would. */
function customProp(name: string, from: string = css): string | null {
  const re = new RegExp(`--${name}:\\s*([^;]+);`, "g");
  let last: string | null = null;
  for (const m of from.matchAll(re)) last = m[1]!.replace(/\s+/g, " ").trim();
  return last;
}

/** The one @font-face block in the stylesheet. Matched on the brace, not the
 *  bare at-rule name: the comments above it discuss `@font-face` by name. */
const fontFace = (() => {
  const at = css.indexOf("@font-face {");
  return at < 0 ? null : css.slice(at, css.indexOf("}", at));
})();

/** Parse a CSS `unicode-range` value into inclusive [lo, hi] pairs. */
function parseUnicodeRange(value: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const token of value.split(",")) {
    const m = /^U\+([0-9a-f]+)(?:-([0-9a-f]+))?$/i.exec(token.trim());
    if (!m) continue;
    const lo = parseInt(m[1]!, 16);
    out.push([lo, m[2] ? parseInt(m[2], 16) : lo]);
  }
  return out;
}

describe("a Japanese UI has a font to draw with", () => {
  it("ships a real woff2, not a placeholder", () => {
    const paths = Object.keys(FONT_FILES);
    expect(
      paths,
      "no .woff2 under public/fonts — the @font-face below names a file that is not in the repo. "
        + "Japanese then falls back to whatever the platform has, which on a bare Windows or Linux "
        + "install is nothing. See public/fonts/README.md for how to rebuild it.",
    ).not.toHaveLength(0);
    for (const [path, bytes] of Object.entries(FONT_FILES)) {
      // 'wOF2' is the woff2 signature. A stub, an LFS pointer, a saved error
      // page or a plain-text IOU all fail here — which is the point: half-done
      // is fine, faked is not.
      expect(bytes.slice(0, 4), `${path} does not start with the woff2 signature`).toBe("wOF2");
      expect(bytes.length, `${path} is too small to be a CJK subset`).toBeGreaterThan(50_000);
    }
  });

  it("loads it from disk, never from a CDN", () => {
    expect(fontFace, "no @font-face in styles.css").toBeTruthy();
    const src = /src:\s*([^;]+);/.exec(fontFace!)?.[1] ?? "";
    expect(src, "the @font-face has no src").toContain("format(\"woff2\")");
    expect(
      src,
      "the font is fetched over the network. The packaged webview's CSP is `font-src 'self' data:` "
        + "and connect-src is pinned to localhost, so this would simply not load — and a desktop CAD "
        + "app has to open a file with the network off.",
    ).not.toMatch(/https?:/);
    const url = /url\(["']?([^"')]+)/.exec(src)?.[1] ?? "";
    expect(url, "the @font-face src does not point into the public/ font directory").toMatch(/^\/fonts\//);
    const file = url.replace(/^\/fonts\//, "");
    expect(
      Object.keys(FONT_FILES).some((p) => p.endsWith("/" + file)),
      `@font-face asks for ${url}, which is not one of ${Object.keys(FONT_FILES).join(", ")}`,
    ).toBe(true);
  });

  it("declares the weight as a range, so the variable font is not stuck on Thin", () => {
    // The trap that makes this worth a test: NotoSansJP[wght].ttf has wght 100
    // as its DEFAULT instance. `font-weight: 400` in the @font-face pins the
    // axis and every Japanese label renders hairline — while English, which
    // never touches this face, looks perfect. Nobody testing in English sees it.
    const weight = /font-weight:\s*([^;]+);/.exec(fontFace!)?.[1]?.trim() ?? "";
    const m = /^(\d+)\s+(\d+)$/.exec(weight);
    expect(m, `@font-face font-weight is "${weight}", not a range like "100 900"`).toBeTruthy();
    const [lo, hi] = [Number(m![1]), Number(m![2])];
    // every weight the UI actually asks for has to be inside it
    const used = [...css.matchAll(/font-weight:\s*(\d{3})\b/g)]
      .map((x) => Number(x[1]))
      .filter((w) => w !== lo && w !== hi);
    expect(used.length, "no numeric font-weights found in styles.css — this check's premise is stale")
      .toBeGreaterThan(0);
    for (const w of new Set(used)) {
      expect(w, `styles.css asks for font-weight ${w}, outside the face's ${lo}–${hi}`)
        .toBeGreaterThanOrEqual(lo);
      expect(w, `styles.css asks for font-weight ${w}, outside the face's ${lo}–${hi}`)
        .toBeLessThanOrEqual(hi);
    }
  });
});

describe("bundling the font cannot change English", () => {
  const ranges = parseUnicodeRange(/unicode-range:\s*([^;]+);/.exec(fontFace ?? "")?.[1] ?? "");
  const covers = (cp: number) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

  it("declares a unicode-range at all", () => {
    // Without one the face applies to EVERY character: the 692 KiB file would be
    // downloaded on an English UI it has no glyph for, and font-display: swap
    // would flash the whole chrome. The range is what makes this free.
    expect(ranges.length, "the @font-face has no parseable unicode-range").toBeGreaterThan(0);
  });

  for (const [name, cp] of [["A", 0x41], ["z", 0x7a], ["0", 0x30], ["space", 0x20], ["–", 0x2013]] as const) {
    it(`excludes ${name}, so an English UI never requests the file`, () => {
      expect(covers(cp), `unicode-range covers U+${cp.toString(16).toUpperCase()} (${name})`).toBe(false);
    });
  }

  for (const [name, cp] of [
    ["あ hiragana", 0x3042],
    ["ア katakana", 0x30a2],
    ["日 kanji", 0x65e5],
    ["。 ideographic full stop", 0x3002],
    ["「 corner bracket", 0x300c],
    ["１ fullwidth digit", 0xff11],
  ] as const) {
    it(`covers ${name}`, () => {
      expect(covers(cp), `unicode-range does not cover U+${cp.toString(16).toUpperCase()} (${name})`).toBe(true);
    });
  }

  it("keeps the Latin families ahead of the Japanese ones in the UI stack", () => {
    const stack = customProp("font-ui");
    expect(stack, "no --font-ui in styles.css").toBeTruthy();
    const at = (family: string) => stack!.indexOf(family);
    expect(at("Inter"), "--font-ui no longer leads with Inter — English rendering has moved")
      .toBeGreaterThanOrEqual(0);
    expect(
      at("Inter"),
      "a Japanese family now precedes Inter in --font-ui. Latin characters would be drawn from it "
        + "wherever it has a glyph, which is a visual change to the English UI.",
    ).toBeLessThan(at("Noto Sans JP"));
  });

  it("the body actually uses the stack", () => {
    const body = rule("html,\nbody") ?? rule("html, body");
    expect(body, "no html/body rule in styles.css — this test's anchor is stale").toBeTruthy();
    expect(body, "html/body does not use var(--font-ui), so --font-ui is decorative")
      .toContain("var(--font-ui)");
  });

  it("and NO rule anywhere takes font-family back off it", () => {
    // The body rule is necessary and nowhere near sufficient: font-family
    // inherits, so any descendant that names its own families cuts the whole
    // subtree off from the bundled font. `.tool-panel` did exactly that with
    // `font: 12px/1.4 system-ui, sans-serif` — the SHORTHAND resets family —
    // and took five panels' worth of Japanese down with it, invisibly, because
    // every one of them looks perfect in English.
    //
    // So this is a whole-stylesheet sweep rather than a selector spot-check:
    // a declaration may only inherit, or name one of the variables.
    const decls = fontDeclarations();
    expect(decls.length, "no font declarations found at all — this scanner has stopped working")
      .toBeGreaterThan(5);
    const offenders = decls.filter(([selector, , value]) => {
      if (selector.includes("@font-face")) return false; // declares the face, does not use it
      if (value === "inherit") return false;
      return !/var\(--font-(ui|mono)\)/.test(value);
    });
    expect(
      offenders.map(([s, p, v]) => `${s} { ${p}: ${v} }`),
      "these rules pin their own font families, so var(--font-ui)/var(--font-mono) — and with them "
        + "Noto Sans JP and every platform CJK face — do not reach their text. Set font-size and "
        + "line-height separately and let the family inherit (or name the variable); never use the "
        + "`font:` shorthand for anything but `inherit`.",
    ).toEqual([]);
  });

  it("the tool panels keep their 12px text while inheriting the family", () => {
    // The fix for the above must not shrink or grow the panels: the shorthand
    // set 12px/1.4, so both have to survive it as separate declarations.
    const r = rule(".tool-panel")?.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(r, "no .tool-panel rule — this test's anchor is stale").toBeTruthy();
    expect(r, ".tool-panel sizes its text with the `font:` shorthand again, which resets font-family")
      .not.toMatch(/(^|[\s;]) *font:\s*(?!inherit)/);
    expect(r, ".tool-panel's 12px text size was lost with the shorthand").toMatch(/font-size:\s*12px/);
    expect(r, ".tool-panel's 1.4 line-height was lost with the shorthand").toMatch(/line-height:\s*1\.4/);
  });

  it("falls through to the platform's own Japanese faces for what the subset lacks", () => {
    // The subset is jōyō + kana. A rare kanji in a body name, or hanzi, or
    // hangul, has to land somewhere legible rather than on `sans-serif`.
    const stack = customProp("font-ui")!;
    for (const family of ["Hiragino Sans", "Yu Gothic UI", "Meiryo", "Noto Sans CJK JP"]) {
      expect(stack, `--font-ui no longer names ${family}`).toContain(family);
    }
    expect(stack.indexOf("Noto Sans CJK JP"), "the generic sans-serif is not last in --font-ui")
      .toBeLessThan(stack.indexOf("sans-serif", stack.indexOf("Noto Sans CJK JP")));
  });

  it("the monospace surfaces get the same fallback without losing their mono face", () => {
    const mono = customProp("font-mono");
    expect(mono, "no --font-mono in styles.css").toBeTruthy();
    expect(mono!.indexOf("ui-monospace"), "--font-mono no longer leads with ui-monospace — Latin in the "
      + "body lists and diagnostics would stop being monospaced").toBe(0);
    expect(mono, "--font-mono has no Japanese fallback, so a Japanese body name is tofu in a body list")
      .toContain("Noto Sans JP");
  });

  it("keeps the monospace GENERIC ahead of the proportional CJK faces", () => {
    // Order, not membership — this is the bug the membership check missed.
    // Every CJK family in the stack is proportional, and `ui-monospace` does
    // NOT resolve in WebKitGTK 4.1 (the packaged Linux app's engine): it
    // measures identically to sans-serif. With a CJK family ahead of the
    // generic, the first family that actually resolves is Noto Sans CJK JP, so
    // the no-WebGL2 screen's copyable commands, its diagnostics block and the
    // file list in listModal render proportional — in ENGLISH, on the primary
    // Linux target. Fallback is per character, so the generic first costs
    // Japanese nothing: `monospace` has no kana, and a kana walks on.
    const list = families(customProp("font-mono")!);
    const generic = list.indexOf("monospace");
    expect(generic, "--font-mono has no `monospace` generic at all; if no named face resolves there is "
      + "nothing to fall through to").toBeGreaterThanOrEqual(0);
    for (const cjk of ["Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Noto Sans CJK JP"]) {
      const at = list.indexOf(cjk);
      if (at < 0) continue; // membership is the previous test's business
      expect(
        generic,
        `--font-mono puts ${cjk} (a PROPORTIONAL face) ahead of the monospace generic. On any engine `
          + `where ui-monospace does not resolve, that is the face Latin text gets.`,
      ).toBeLessThan(at);
    }
  });
});

describe("longer text does not get cut off", () => {
  it("an inspector field label wraps instead of ellipsising", () => {
    // This label is the ONLY thing naming the input beside it, in a 1fr track
    // of a 252px panel. "Distance" fits; "テーパー角度" and "Abstand bis Fläche"
    // do not, and an ellipsis leaves the user typing into an unnamed box.
    const r = rule(".param-row label");
    expect(r, "no .param-row label rule — this test's anchor is stale").toBeTruthy();
    expect(r, ".param-row label truncates again; the field loses its name").not.toContain("text-overflow: ellipsis");
    expect(r, ".param-row label is nowrap again, so it cannot use the second line").not.toContain("white-space: nowrap");
  });

  it("the ribbon label's two-line cap is computed from the same line-height it sets", () => {
    // A cap written as a literal and a line-height written as a token drift the
    // moment one moves: the second line gets sliced through the middle. Both
    // must name --lh-label.
    const r = rule(".ribbon-btn span");
    expect(r, "no .ribbon-btn span rule").toBeTruthy();
    expect(r, ".ribbon-btn span hardcodes its line-height again").toMatch(/line-height:\s*var\(--lh-label\)/);
    expect(r, ".ribbon-btn span's max-height no longer derives from --lh-label, so the two can disagree")
      .toMatch(/max-height:\s*calc\([^)]*--lh-label/);
  });

  it("CJK gets the taller line box, and only CJK", () => {
    // Raising it globally would move every English ribbon label by a pixel.
    // The knob is per-language, hung off <html lang> (applyDocumentLang writes it).
    const latin = /--lh-label:\s*([\d.]+)/.exec(css)?.[1];
    expect(latin, "no --lh-label in styles.css").toBeTruthy();
    expect(Number(latin), "the Latin --lh-label moved; English ribbon labels have shifted").toBe(1.15);
    const langBlock = /:root:lang\(ja\)[\s\S]{0,120}?\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const cjk = /--lh-label:\s*([\d.]+)/.exec(langBlock)?.[1];
    expect(cjk, "no :root:lang(ja) override of --lh-label — a CJK glyph box is taller than a Latin one "
      + "at the same size, so 1.15 clips the top of one line and the bottom of the next").toBeTruthy();
    expect(Number(cjk), "the CJK --lh-label is not tall enough for a CJK glyph box").toBeGreaterThanOrEqual(1.25);
  });

  it("the one text-bearing box in the timeline can grow", () => {
    const r = rule(".timeline-empty");
    expect(r, "no .timeline-empty rule").toBeTruthy();
    expect(r, ".timeline-empty has a fixed height again, so a longer empty-state sentence is clipped")
      .not.toMatch(/[^-]height:\s*\d+px/);
    expect(r, ".timeline-empty lost its minimum height").toMatch(/min-height:\s*\d+px/);
  });

  it("the settings label columns can outgrow their English width", () => {
    // .sm-row already records this failing once in English ("Cross-axis filter"
    // wrapped to two lines and made its row half again as tall). A translation
    // walks straight back into it; minmax floors at the English width, so
    // nothing moves until the label is genuinely wider.
    for (const sel of [".sm-row", ".sm-axis-row", ".sm-map-row"]) {
      const r = rule(sel);
      expect(r, `no ${sel} rule`).toBeTruthy();
      expect(r, `${sel}'s label track is a fixed width again; a longer label spills across the control`)
        .toMatch(/grid-template-columns:\s*minmax\(\d+px, auto\)/);
    }
  });
});

describe("the view cube's labels", () => {
  it("are drawn with a stack that has a Japanese face in it", () => {
    // The plate used to be painted with a hardcoded `600 56px Inter, system-ui,
    // sans-serif` — three families, no kana between them. In a node test there
    // is no document, so this exercises the fallback path, which is the one that
    // has to be right on its own.
    const font = cubeLabelFont();
    expect(font, "cubeLabelFont() does not produce a weight+size shorthand").toMatch(/^\d+ \d+px /);
    expect(font, "the cube's label font names no Japanese family — 上面 is tofu on the cube while the "
      + "rest of the UI reads fine").toContain("Noto Sans JP");
  });

  it("uses the same stack as the rest of the chrome", () => {
    // Two copies of a font stack drift. The runtime reads --font-ui; the literal
    // in viewCube.ts is only the pre-stylesheet fallback, and it has to agree.
    const declared = customProp("font-ui")!;
    const families = cubeLabelFont().replace(/^\d+ \d+px /, "");
    expect(families, "viewCube's fallback family list has drifted from --font-ui in styles.css")
      .toBe(declared);
  });

  it("waits for the font before it trusts what it painted", () => {
    // Canvas is not layout: naming a family in ctx.font neither starts a webfont
    // download nor repaints when one arrives, and these textures are painted
    // once at construction. Without this the six plates keep the fallback face
    // for the whole session even after the rest of the UI has switched.
    expect(viewCubeSrc, "the view cube no longer waits on document.fonts, so its plates are painted "
      + "before the bundled font can be available and never repainted").toContain("document.fonts");
    const after = viewCubeSrc.slice(viewCubeSrc.indexOf("fonts.load("));
    expect(
      after.slice(0, 600),
      "nothing repaints the plates in the same breath as awaiting the font — the call has drifted away "
        + "from the await, or is gone",
    ).toContain("refreshOverrideMarks()");
  });

  it("leaves an English label at full size, and pulls a longer one back onto the plate", () => {
    // The plate canvas is 256px. Widths below are MEASURED advance sums at
    // 56px/600: BOTTOM is 243.3px in Noto Sans and 270.0px in DejaVu Sans —
    // which is the reason the fit budget is the whole plate and not a margin
    // inside it. A 0.94 budget (240.6px) would have shrunk BOTTOM on both, a
    // visible change to an English UI that this phase must not make.
    const PLATE = 256;
    // width of a string that measures `emWidth` ems, at size `px`
    const scaled = (ems: number) => (px: number) => ems * px;

    // BOTTOM in Noto Sans: 243.3px at 56px = 4.344em. Fits — must not move.
    expect(fitLabelPx(scaled(243.3 / 56), PLATE), "an English label that fits the plate was shrunk anyway")
      .toBe(LABEL_PX);
    // BOTTOM in DejaVu Sans: 270.0px at 56px. Does NOT fit, and is being cut off
    // at the plate edge today — shrinking it is the fix, not a regression.
    const dejavu = fitLabelPx(scaled(270 / 56), PLATE);
    expect(dejavu, "a label wider than the plate was left at full size, so it stays clipped")
      .toBeLessThan(LABEL_PX);
    expect((270 / 56) * dejavu, "the shrunk label still does not fit the plate").toBeLessThanOrEqual(PLATE);

    // A four-character Japanese side name. CJK glyphs are one full em each, so
    // this is 4em — 224px at 56px, inside the plate: it does not need shrinking,
    // which is the point of bundling a font rather than widening every box.
    expect(fitLabelPx(scaled(4), PLATE), "a four-character Japanese label should fit the plate as-is")
      .toBe(LABEL_PX);
    // Seven characters (底面から見た図) does not, and must come down.
    const seven = fitLabelPx(scaled(7), PLATE);
    expect(7 * seven, "a seven-character label still overflows the plate").toBeLessThanOrEqual(PLATE);
    expect(seven, "the fit loop went below the readability floor").toBeGreaterThanOrEqual(LABEL_PX_MIN);
  });

  it("stops at a readable size instead of shrinking to nothing", () => {
    // A pathological label (a whole sentence painted onto a 256px plate) hits
    // the floor and is then condensed by fillText's maxWidth. Unreadable-small
    // is worse than condensed.
    expect(fitLabelPx(() => 10_000, 256)).toBe(LABEL_PX_MIN);
  });
});
