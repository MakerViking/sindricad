#!/usr/bin/env node
// Merge locales/fragments/*.json into locales/en.json (deep merge; a conflict on
// the same key with different text is an error). Used while the catalogue is
// being extracted by several people at once; fragments are deleted after.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "locales");
const frag = join(dir, "fragments");
if (!existsSync(frag)) process.exit(0);
const en = JSON.parse(readFileSync(join(dir, "en.json"), "utf8"));
let conflicts = 0;
// A plural set is an object whose keys are ALL CLDR categories. Testing only
// for a string `other` misreads an ordinary group that happens to contain a key
// named `other`, and silently drops its siblings. See src/i18n/index.ts.
const PLURAL_KEYS = new Set(["zero", "one", "two", "few", "many", "other"]);
const isPlural = (v) =>
  !!v && typeof v === "object" && Object.keys(v).length > 0 &&
  Object.entries(v).every(([k, x]) => PLURAL_KEYS.has(k) && typeof x === "string") &&
  typeof v.other === "string";

function merge(into, from, path, src) {
  for (const [k, v] of Object.entries(from)) {
    const p = path ? `${path}.${k}` : k;
    const isLeaf = typeof v === "string" || isPlural(v);
    if (isLeaf) {
      if (into[k] !== undefined && JSON.stringify(into[k]) !== JSON.stringify(v)) {
        console.log(`CONFLICT ${p} (${src}): ${JSON.stringify(into[k])} vs ${JSON.stringify(v)}`);
        conflicts++;
      } else into[k] = v;
    } else {
      if (into[k] !== undefined && (typeof into[k] !== "object" || typeof into[k].other === "string")) {
        console.log(`CONFLICT ${p} (${src}): leaf vs branch`);
        conflicts++;
        continue;
      }
      into[k] ??= {};
      merge(into[k], v, p, src);
    }
  }
}
for (const f of readdirSync(frag).filter((n) => n.endsWith(".json")).sort()) {
  merge(en, JSON.parse(readFileSync(join(frag, f), "utf8")), "", f);
}
function sortKeys(o) {
  if (!o || typeof o !== "object" || typeof o.other === "string") return o;
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]));
}
writeFileSync(join(dir, "en.json"), JSON.stringify(sortKeys(en), null, 2) + "\n");
console.log(conflicts ? `${conflicts} conflicts` : "merged");
process.exit(conflicts ? 1 : 0);
