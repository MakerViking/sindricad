// The pseudo-locale (code `qps-ploc`, the Windows convention for a
// pseudo-localised build). It is generated from English at load time, never
// stored, and exists to expose two failure modes that no real translation can:
//
//   1. A string that never went through t() shows up WITHOUT brackets.
//   2. A layout that clips shows up because every string is ~35% longer, which
//      is about what German costs over English.
//
// The accented letters are chosen to stay legible so a tester can still read
// the UI, and `{param}` placeholders are left untouched so interpolation keeps
// working under the pseudo-locale exactly as it does under a real one.

const ACCENTS: Record<string, string> = {
  a: "à", b: "ƀ", c: "ç", d: "đ", e: "è", f: "ƒ", g: "ĝ", h: "ĥ", i: "ì", j: "ĵ",
  k: "ķ", l: "ļ", m: "ɱ", n: "ñ", o: "ò", p: "þ", q: "q", r: "ŕ", s: "š", t: "ţ",
  u: "ù", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "À", B: "Ɓ", C: "Ç", D: "Đ", E: "È", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Ì", J: "Ĵ",
  K: "Ķ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ò", P: "Þ", Q: "Q", R: "Ŕ", S: "Š", T: "Ţ",
  U: "Ù", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

/** How much longer than the English a pseudo string is, as a fraction. */
export const PSEUDO_GROWTH = 0.35;

/** Accent every letter outside `{placeholders}`, pad to +35%, wrap in brackets. */
export function pseudoize(s: string): string {
  let out = "";
  let inParam = false;
  for (const ch of s) {
    if (ch === "{") inParam = true;
    else if (ch === "}") inParam = false;
    out += inParam ? ch : (ACCENTS[ch] ?? ch);
  }
  // Pad with a visible filler so the growth is measurable in a screenshot, but
  // not with letters, so nothing reads as a real word. Length counts code
  // points, not the placeholder text, which is not what a translation grows.
  const visible = s.replace(/\{[^}]*\}/g, "").length;
  const extra = Math.ceil(visible * PSEUDO_GROWTH);
  return `[${out}${extra > 0 ? " " + "~".repeat(extra) : ""}]`;
}
