#!/usr/bin/env node
// Locale catalogue check. Exit 1 on a key that exists in a translation but not
// in English (a typo, or a key that was renamed); warn on keys a translation is
// missing (the English fallback covers them) and on entries identical to the
// English (some are legitimately identical — "OK", "mm").
//
//   node scripts/i18n-check.mjs            report
//   node scripts/i18n-check.mjs --strict   also fail on missing keys
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const dir = join(process.cwd(), "locales");
const strict = process.argv.includes("--strict");

// A plural set is an object whose keys are ALL CLDR categories. Testing only
// for a string `other` misreads an ordinary group that happens to contain a key
// named `other`, and silently drops its siblings. See src/i18n/index.ts.
const PLURAL_KEYS = new Set(["zero", "one", "two", "few", "many", "other"]);
const isPlural = (v) =>
  !!v && typeof v === "object" && Object.keys(v).length > 0 &&
  Object.entries(v).every(([k, x]) => PLURAL_KEYS.has(k) && typeof x === "string") &&
  typeof v.other === "string";

function flatten(obj, prefix = "", into = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") into.set(key, v);
    else if (isPlural(v)) into.set(key, JSON.stringify(v));
    else if (v && typeof v === "object") flatten(v, key, into);
    else throw new Error(`${key}: unsupported value ${JSON.stringify(v)}`);
  }
  return into;
}

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

function loadEn() {
  // While the catalogue is being extracted in parallel, locales/fragments/*.json
  // are merged over en.json at runtime; check against the same union.
  const base = JSON.parse(readFileSync(join(dir, "en.json"), "utf8"));
  const fragDir = join(dir, "fragments");
  let frags = [];
  try {
    frags = readdirSync(fragDir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    /* no fragments — the normal, post-merge state */
  }
  const merge = (into, from) => {
    for (const [k, v] of Object.entries(from)) {
      const leaf = typeof v === "string" || (v && typeof v === "object" && typeof v.other === "string");
      if (leaf || typeof into[k] !== "object") into[k] = v;
      else merge(into[k], v);
    }
    return into;
  };
  for (const f of frags) merge(base, JSON.parse(readFileSync(join(fragDir, f), "utf8")));
  return { flat: flatten(base), fragments: frags };
}

const { flat: en, fragments } = loadEn();

// Every key the SOURCE asks for must exist. A key that does not is invisible to
// every other check here — the string is inside a t() call, so the lint is happy
// — and the user is shown the raw key. This is the one failure mode that
// reaches a release looking like working code.
function referencedKeys() {
  const out = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".testkit.ts")) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/\b(?:t|tEn|hasKey)\(\s*"([^"$]+)"|\b(?:setText|setTitle)\([^,]+,\s*"([^"$]+)"/g)) {
          const key = m[1] ?? m[2];
          if (key && !out.has(key)) out.set(key, `${relative(process.cwd(), p)}`);
        }
      }
    }
  };
  walk(join(process.cwd(), "src"));
  return out;
}

const referenced = referencedKeys();
const unknown = [...referenced].filter(([k]) => !en.has(k));
if (unknown.length) {
  console.log(`FAIL ${unknown.length} keys used in the source but missing from the catalogue:`);
  for (const [k, where] of unknown.slice(0, 40)) console.log(`  ${k}  (${where})`);
  if (unknown.length > 40) console.log(`  … and ${unknown.length - 40} more`);
}
const unusedNote = [...en.keys()].filter((k) => !referenced.has(k));

let failed = unknown.length > 0;
let warnings = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "en.json").sort()) {
  const code = f.replace(/\.json$/, "");
  const cat = flatten(JSON.parse(readFileSync(join(dir, f), "utf8")));
  const extra = [...cat.keys()].filter((k) => !en.has(k));
  const missing = [...en.keys()].filter((k) => !cat.has(k));
  const same = [...cat].filter(([k, v]) => en.get(k) === v).map(([k]) => k);
  const badParams = [...cat].filter(([k, v]) => en.has(k) && placeholders(v) !== placeholders(en.get(k))).map(([k]) => k);
  console.log(`${code}: ${cat.size} entries, ${missing.length} missing, ${extra.length} extra, ${same.length} identical to English, ${badParams.length} placeholder mismatches`);
  for (const k of extra) console.log(`  FAIL extra key (not in en.json): ${k}`);
  for (const k of badParams) console.log(`  FAIL placeholders differ from English: ${k}`);
  if (extra.length || badParams.length) failed = true;
  if (missing.length) {
    warnings += missing.length;
    for (const k of missing.slice(0, 20)) console.log(`  ${strict ? "FAIL" : "warn"} missing: ${k}`);
    if (missing.length > 20) console.log(`  … and ${missing.length - 20} more`);
    if (strict) failed = true;
  }
  for (const k of same.slice(0, 10)) console.log(`  warn identical to English: ${k}`);
  if (same.length > 10) console.log(`  … and ${same.length - 10} more identical`);
}
console.log(
  `en: ${en.size} entries${fragments.length ? ` (incl. ${fragments.length} fragments)` : ""}, ` +
    `${referenced.size} referenced by the source, ${unusedNote.length} not referenced`,
);
process.exit(failed ? 1 : 0);
