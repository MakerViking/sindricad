#!/usr/bin/env node
// Hardcoded-string check: string literals in src/ (tests excluded) that look
// like UI prose and are not inside a t() call. Heuristic by design: it wants
// two real words, or one capitalised word, and it drops import paths, URLs,
// CSS/SVG fragments, identifiers, wire ids and everything on the allow-list.
//
// Escape hatches, in order of preference:
//   - the literal is data, not UI text: name it so the heuristic skips it, or
//   - `// i18n-ignore <reason>` on the line or the two above it, or
//   - `// i18n-ignore-start <reason>` … `// i18n-ignore-end` around a run of
//     them (a diagnostic payload assembled as one array), or
//   - `// i18n-ignore-file <reason>` at the top of a file that has no UI text.
//
// Exit 1 when anything is reported; CI runs this.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");
const STR_RE = /"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/gs;
const CSSISH = /(^\s*[.#[]|::|--[a-z]|\bcalc\(|\brgba?\(|\bvar\(|<svg|<path|<circle|<rect|<line |<polygon|<polyline|viewBox|stroke-|d="M|^\s*<\/?[a-z]+[^>]*>\s*$)/;
// Never UI text: units, formats, shortcut names, product names, wire values.
const ALLOW = new Set([
  "mm", "cm", "in", "deg", "°", "STEP", "STL", "3MF", "OBJ", "GLB", "SindriCAD", "TinkerAtlas", "OrcaSlicer",
  "Snapmaker U1", "Ctrl", "Shift", "Alt", "Cmd", "Esc", "Enter", "Del", "Tab", "Space", "Home", "End",
]);
// An i18n key, e.g. menu.file.save — or a key PREFIX a template completes,
// e.g. `bug.category.${c}`, which reduces to "bug.category." here.
const KEYISH = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)*\.?$/;
const MODULE_PATH = /^[a-z@][\w@/.-]*\.(js|ts|mjs|cjs|css|json|svg|png|glsl)$|^three\//;
const MIME = /^[a-z]+\/[a-z0-9.+-]+$/;
const SHADER = /\b(varying|uniform|attribute|gl_\w+|void main|vec[234]|precision)\b/;
const WIRE = /^[a-z][a-zA-Z0-9]*([:_-][a-zA-Z0-9]+)+$/; // sidecar:died, press-pull, show_all
// "Ctrl+S", "Shift+", and hint lists like "Ctrl+Z / Ctrl+Y" or "Home / F6".
const SHORTCUT = /^((Ctrl|Shift|Alt|Cmd|Meta)\+)+[A-Za-z0-9?]*$|^[A-Za-z0-9+]+( \/ [A-Za-z0-9+]+)+$/;

// Context rules: what the LINE does with the string decides, where the string's
// own shape cannot. A class list, a CSS selector and a canvas font are all
// indistinguishable from prose to a word counter.
const NOT_UI_CONTEXT = [
  /\bclassName\s*=|\bclassList\.(add|remove|toggle|contains)\(|\bclass=/,
  /\bquerySelector(All)?\(|\.closest\(|\.matches\(|getElementById\(/,
  /\.font\s*=|\bfontFamily\b/,
  /\bsetAttribute\(\s*"(class|style|d|viewBox|sandbox|type|role)"/,
  /\b(console\.(log|warn|error|debug|info)|crumb|stickyFact|new Error|throw new \w*Error)\(/,
  /\bimport\(|\bfrom\s+"/,
];

const LOOKS_LIKE_CODE = /^\s*(const|let|var|function|return|if|for|while|import|export|class)\b/m;

function prose(s) {
  const t = s.trim();
  if (t.length < 3) return false;
  // A backtick inside a regex character class (see ui/escape.ts) opens a
  // "template literal" that runs to the next backtick and swallows real code.
  if (t.includes("\n") && (LOOKS_LIKE_CODE.test(t) || /=>|\.\.\.|\.\w+\(/.test(t))) return false;
  if (ALLOW.has(t)) return false;
  if (KEYISH.test(t) || WIRE.test(t) || SHORTCUT.test(t)) return false;
  if (MODULE_PATH.test(t) || MIME.test(t) || SHADER.test(t)) return false;
  if (/^(\.\/|\.\.\/|\/|https?:|@|#|%|\$\{)/.test(t)) return false;
  if (CSSISH.test(t)) return false;
  if (/^[\d\s.,;:+\-*/()%°×·…–—]+$/.test(t)) return false; // numbers / punctuation only
  if (/^[a-z0-9_$]+$/i.test(t) && !/^[A-Z][a-z]{3,}$/.test(t)) return false; // identifiers
  if (/^[a-z0-9_-]+(\s[a-z0-9_-]+)*$/.test(t) && !/\s/.test(t)) return false; // kebab tokens
  const words = t.match(/[A-Za-z][a-z]{2,}/g) ?? [];
  const capital = /^[A-Z][a-z]{2,}/.test(t);
  return words.length >= 2 || (capital && words.length >= 1 && !/^[A-Z][a-zA-Z0-9]*$/.test(t));
}

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".testkit.ts")) yield p;
  }
}

/** True when `pos` sits inside the argument list of a t(…) / tEn(…) / setText(…) / setTitle(…) call. */
function insideT(src, pos) {
  // Walk back over balanced parens to the call site of the nearest open paren.
  let depth = 0;
  for (let i = pos - 1; i >= 0 && i > pos - 400; i--) {
    const c = src[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) {
        const head = src.slice(Math.max(0, i - 12), i);
        return /(^|[^\w.])(t|tEn|hasKey|setText|setTitle)$/.test(head) || /\.(t)$/.test(head);
      }
      depth--;
    }
  }
  return false;
}

let total = 0;
const perFile = new Map();
for (const file of walk(ROOT)) {
  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n");
  if (/\/\/\s*i18n-ignore-file\b/.test(raw)) continue;
  // Line numbers inside an ignored block, 1-based.
  const blocked = new Set();
  let open = 0;
  lines.forEach((l, i) => {
    if (/\/\/\s*i18n-ignore-start\b/.test(l)) open = i + 1;
    else if (/\/\/\s*i18n-ignore-end\b/.test(l)) open = 0;
    else if (open) blocked.add(i + 1);
  });
  // Blank out comments (block and line) so their prose doesn't count, keeping
  // every offset so line numbers still match. A `//` counts as a comment only
  // at line start or after whitespace, which leaves "https://" alone.
  const blank = (m) => m.replace(/[^\n]/g, " ");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|\s)\/\/.*$/gm, (m, lead) => lead + blank(m.slice(lead.length)));
  for (const m of src.matchAll(STR_RE)) {
    const raw0 = m[1] ?? m[2] ?? m[3] ?? "";
    // A template's `${…}` holes are code, not text: whatever is in them was
    // already judged on its own (a t() call inside one is how a markup builder
    // is SUPPOSED to look). Judge the static text around them.
    const holes = raw0.replace(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "\u0000");
    // In markup, only the text BETWEEN tags is user-facing; class names,
    // attribute values and style declarations are not. Attribute values that
    // are user-facing (title=, placeholder=, aria-label=) are set through
    // setTitle/esc(t(…)) in the holes, so they are covered above.
    const parts = /<[a-zA-Z/!]/.test(holes)
      ? holes.replace(/<[^>]*>/g, "\u0000").split("\u0000")
      : holes.split("\u0000");
    const s = parts.find((p) => prose(p)) ?? "";
    if (!s) continue;
    const lineNo = src.slice(0, m.index).split("\n").length;
    const line = lines[lineNo - 1] ?? "";
    // `// i18n-ignore <reason>` on the string's line, or on either of the two
    // lines above it — a statement that wraps puts the string well below the
    // comment that explains it, and a trailing comment on a long line is worse
    // to read than a leading one.
    const near = [line, lines[lineNo - 2] ?? "", lines[lineNo - 3] ?? ""].join("\n");
    if (blocked.has(lineNo) || /i18n-ignore/.test(near)) continue;
    // The context rules read the same window: a console.warn(…) or a
    // querySelector(…) whose argument wrapped onto its own line still has its
    // call on the line above.
    if (NOT_UI_CONTEXT.some((re) => re.test(near))) continue;
    if (/^\s*(console\.(log|warn|error|debug|info)|throw new Error|crumb\(|stickyFact\(|Error\()/.test(line.trim())) continue;
    if (/console\.(log|warn|error|debug|info)\(|throw new (Error|TypeError|RangeError)\(|crumb\(|stickyFact\(|new Error\(/.test(line)) continue;
    if (insideT(src, m.index)) continue;
    total++;
    const rel = relative(process.cwd(), file);
    if (!perFile.has(rel)) perFile.set(rel, []);
    perFile.get(rel).push(`${lineNo}: ${JSON.stringify(s.slice(0, 70))}`);
  }
}
for (const [f, hits] of [...perFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${f} (${hits.length})`);
  for (const h of hits.slice(0, process.argv.includes("--all") ? Infinity : 8)) console.log(`   ${h}`);
  if (!process.argv.includes("--all") && hits.length > 8) console.log(`   … ${hits.length - 8} more (--all to list)`);
}
console.log(total ? `\n${total} possible hardcoded UI strings in ${perFile.size} files` : "no hardcoded UI strings found");
process.exit(total ? 1 : 0);
