// No first-party source may reach a dynamic-code sink.
//
// This is the invariant that lets SindriCAD's Content-Security-Policy drop
// 'unsafe-eval'. The only thing in the shipped bundle that needs it today is
// planegcs: it is an emscripten/embind module, and embind builds every invoker
// by handing a SOURCE STRING to the Function constructor. 'wasm-unsafe-eval'
// permits WebAssembly COMPILATION only, not the Function constructor — so the
// solver died in every PACKAGED build and never in `tauri dev` (vite serves
// with no CSP). Three Windows reporters (ffff5144 / 9042ea56 / cdf4c0f7) and
// one Linux reporter were sent to update a webview runtime that was never the
// problem; one reinstalled WebView2 for nothing. src/sketch/solver.test.ts
// carries the full story.
//
// planegcs is being fixed at the source (emscripten `-s DYNAMIC_EXECUTION=0`).
// Nothing enforced that OUR code stays clean, and the obvious place to lose it
// is src/params: parse.ts is a hand-written tokenizer + recursive-descent
// parser and eval.ts a tree-walking interpreter over a closed FUNCTIONS table,
// written that way precisely so a user-typed expression like "2*width+1" is
// never handed to a JS compiler. `new Function(expr)` is a shorter, faster and
// far worse implementation of the same feature — and a .sindri file is a
// document that arrives from the internet. It would also silently re-require
// 'unsafe-eval', undoing the vendoring work for a reason nobody would connect
// to the CSP months later.
//
// The file list comes from a GLOB, never a hand-copied list, so a module added
// tomorrow is covered the moment it exists. Nothing is excluded by name.
//
// Two limits, stated rather than hidden:
//  - vite's `import.meta.glob` always drops the IMPORTING file, so this file is
//    the one thing the scan cannot see. The sink samples are still spelled in
//    pieces ("new " + "Function(") so that copying this list into a file that
//    IS scanned does not produce a self-inflicted failure.
//  - it is a text scan. It sees the spellings below, not
//    `({}).constructor.constructor("…")` or a sink assembled at runtime. It
//    stops the accident, not a determined author.
import { describe, it, expect } from "vitest";

// `?raw` rather than fs: tsconfig's types are ["vite/client"] with no
// @types/node, and vite/client already declares this form (same reason as
// src/ui/ribbonActions.test.ts).
const SOURCES = import.meta.glob("../**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** A spelling of "compile this string as JavaScript". */
interface Sink {
  name: string;
  re: RegExp;
  /** proof the pattern still matches the thing it names (positive control) */
  sample: string;
}

// Split spellings ("new " + "Function(") keep this file from matching itself,
// so the glob above can stay exclusion-free.
const F = "Function";
const EV = "ev" + "al";

const SINKS: Sink[] = [
  { name: "new Function(...)", re: /\bnew\s+Function\s*\(/, sample: `const f = new ${F}("return 1");` },
  // covers the constructor called without `new`, which behaves identically
  { name: "Function(...) as a call", re: /\bFunction\s*\(/, sample: `const f = ${F}("a", "return a");` },
  // embind's own spelling: the constructor reached through .apply
  { name: "Function.apply/call/bind", re: /\bFunction\s*\.\s*(?:apply|call|bind)\s*\(/, sample: `${F}.apply(null, parts);` },
  { name: "eval(...)", re: /(?<![.\w$])eval\s*\(/, sample: `${EV}(src);` },
  { name: "indirect (0, eval)", re: /\(\s*0\s*,\s*eval\s*\)/, sample: `const g = (0, ${EV})(src);` },
  { name: "global.eval(...)", re: /\b(?:window|globalThis|self|global)\s*\.\s*eval\s*\(/, sample: `window.${EV}(src);` },
  { name: "eval via property lookup", re: /\[\s*["']eval["']\s*\]/, sample: `globalThis["${EV}"](src);` },
  // the string forms of the timers are the third eval in disguise
  { name: "setTimeout/setInterval with a string", re: /\b(?:setTimeout|setInterval)\s*\(\s*["'`]/, sample: `setTimeout("tick()", 10);` },
];

/** Things that LOOK like a sink and are not — a scanner that flags these is
 *  unusable and will be deleted by the first person it blocks. */
const NOT_SINKS = [
  "return evalNode(n, values);", // src/params/eval.ts, every line of it
  "const v = parser.evaluate(expr);",
  "await retrieval(id);", // contains the letters e-v-a-l
  "script-src 'self' 'wasm-unsafe-eval'", // the policy string itself
];

/** `path:line` for every sink found, with the offending line. */
function findSinks(files: Record<string, string>): string[] {
  const hits: string[] = [];
  for (const [path, src] of Object.entries(files)) {
    src.split("\n").forEach((line, i) => {
      for (const s of SINKS) {
        if (s.re.test(line)) hits.push(`${path}:${i + 1}  [${s.name}]  ${line.trim().slice(0, 100)}`);
      }
    });
  }
  return hits.sort();
}

describe("the sink scanner itself", () => {
  // Guards the guard. Every assertion below is worthless if the glob quietly
  // resolves to nothing, or if a pattern stops matching the sink it names.
  it("found the source tree", () => {
    const files = Object.keys(SOURCES);
    expect(files.length, "the glob matched (almost) nothing — it is broken, not the tree").toBeGreaterThan(100);
    // named anchors from three different corners, so a glob that quietly
    // narrowed to one directory fails here instead of passing on a subset
    for (const anchor of ["/main.ts", "/params/parse.ts", "/sketch/solver.ts", "/viewport/viewport.ts"]) {
      expect(files.some((f) => f.endsWith(anchor)), `the glob does not reach ${anchor} — its coverage is not what it looks like`).toBe(true);
    }
  });

  it("still matches every sink it claims to catch", () => {
    // asserted against the pattern directly: several sinks legitimately match
    // more than one pattern (`new Function(` matches two), so counting hits
    // would test the overlap rather than the pattern
    for (const s of SINKS) expect(s.re.test(s.sample), `pattern for ${s.name} no longer matches its own sample`).toBe(true);
  });

  it("does not flag ordinary code that merely reads like a sink", () => {
    expect(findSinks({ "sample.ts": NOT_SINKS.join("\n") })).toEqual([]);
  });
});

describe("no dynamic-code sink in first-party source", () => {
  // The named constraint: these two are the expression engine, and they are
  // hand-written on purpose. Enumerated from the glob so a rename shows up as a
  // failure here rather than as a guard that silently covers nothing.
  const PARAM_ENGINE = Object.fromEntries(
    Object.entries(SOURCES).filter(([p]) => /\/params\/(?:parse|eval)\.ts$/.test(p)),
  );

  it("knows where the expression engine lives", () => {
    expect(
      Object.keys(PARAM_ENGINE).sort().map((p) => p.replace(/^.*\/params\//, "params/")),
      "src/params/parse.ts and src/params/eval.ts were renamed or moved — this guard is now pointing at nothing",
    ).toEqual(["params/eval.ts", "params/parse.ts"]);
  });

  it("keeps the expression engine hand-written", () => {
    expect(
      findSinks(PARAM_ENGINE),
      "the parameters engine grew a dynamic-code sink. It parses expressions typed into a "
        + "document that can arrive from anywhere, and it is the reason the CSP can drop "
        + "'unsafe-eval'. Keep the hand-written tokenizer/interpreter.",
    ).toEqual([]);
  });

  it("keeps the whole of src/ free of them", () => {
    expect(
      findSinks(SOURCES),
      "a dynamic-code sink appeared in src/. It will throw in every PACKAGED build the moment "
        + "'unsafe-eval' leaves the CSP (src-tauri/tauri.conf.json) — and NOT in `tauri dev`, "
        + "which serves without a CSP, so it will look fine right up until a user opens it. "
        + "If this is a comment quoting the sink rather than calling it, reword the comment.",
    ).toEqual([]);
  });
});
