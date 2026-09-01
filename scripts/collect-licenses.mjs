#!/usr/bin/env node
// Assemble src-tauri/LICENSES/ — the license texts that ship inside the app.
//
// WHY THIS EXISTS: NOTICE.md told the world "Full license texts are bundled under
// LICENSES/ in distributed builds" and nothing did that. There was no LICENSES
// directory, nothing created one, and tauri.bundle.conf.json listed no such resource.
// So every build shipped without the texts that LGPL-2.1 §6 and LGPL-2.0 require to
// accompany a distribution — while a public compliance file said otherwise.
//
// Node rather than bash because CI bundles on three platforms and the Windows leg has
// no bash step; scripts/vendor-planegcs.mjs already sets that precedent. No new
// dependency: everything here is node:fs and node:path.
//
// # It is a GATE, not just a copier
//
// The bug being fixed was a promise with nothing enforcing it. So REQUIRED lists the
// components whose texts are legally load-bearing, and a missing one exits non-zero
// rather than producing a quietly incomplete directory. A dependency that stops
// shipping its LICENSE, or a rename in site-packages, fails the build instead of
// silently reintroducing exactly this bug.
//
// # Where each text comes from
//
// Preferred order is always: take it from the artefact that actually ships. A text
// copied out of node_modules or the built sidecar runtime cannot drift from what went
// out. licenses/ is the fallback for the two texts no dependency provides at all —
// see licenses/README.md.
//
// Usage:  node scripts/collect-licenses.mjs [--out DIR] [--check]
//   --check  verify and report without writing (for a CI gate on its own)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const outIndex = args.indexOf("--out");
const OUT =
  outIndex >= 0 && args[outIndex + 1]
    ? path.resolve(args[outIndex + 1])
    : path.join(REPO, "src-tauri", "LICENSES");

const SITE = path.join(REPO, "src-tauri", "sidecar-runtime", "site-packages");
const NODE_MODULES = path.join(REPO, "node_modules");

/**
 * Components whose text MUST be present, and why each one is load-bearing.
 *
 * Everything else found is copied too — this is the list that fails a build, not the
 * list of what ships. Copyleft first, because those are the ones with a §6-style
 * "accompany the distribution" clause; the permissive ones below still require their
 * notice to travel with a redistribution.
 */
const REQUIRED = [
  "OCCT-LGPL-2.1", // LGPL-2.1: OCCT object code inside the cadquery-ocp wheel
  "OCCT-exception-1.0", // the additional permission that makes that usable
  "opencascade-rs", // LGPL-2.1, vendored under third_party/
  "planegcs", // LGPL-2.0-or-later, FreeCAD's solver as WASM
  "certifi", // MPL-2.0, file-level copyleft
  "build123d", // Apache-2.0, and the source of the Apache text below
  "three", // MIT
  "SindriCAD", // our own AGPL-3.0, which a distribution must carry
  "NOTICE", // the document that says what all of the above are
];

const collected = new Map(); // name -> { from, bytes }
const problems = [];

/** Record one text under `name`, from `file`. First writer wins. */
function take(name, file) {
  if (collected.has(name)) return;
  try {
    const bytes = fs.readFileSync(file);
    if (!bytes.length) {
      problems.push(`${name}: ${file} is empty`);
      return;
    }
    collected.set(name, { from: path.relative(REPO, file), bytes });
  } catch (why) {
    problems.push(`${name}: could not read ${file} (${why.code || why.message})`);
  }
}

/** The first LICENSE-ish file directly inside `dir`, or null. */
function licenseIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const named = entries
    .filter((e) => e.isFile() && /^(licen[cs]e|copying|notice)/i.test(e.name))
    .map((e) => e.name)
    .sort();
  return named.length ? path.join(dir, named[0]) : null;
}

// --- our own, and the document that explains the rest ----------------------

take("SindriCAD", path.join(REPO, "LICENSE"));
take("NOTICE", path.join(REPO, "NOTICE.md"));

// --- texts no dependency ships (see licenses/README.md) --------------------

for (const file of fs.existsSync(path.join(REPO, "licenses"))
  ? fs.readdirSync(path.join(REPO, "licenses"))
  : []) {
  if (file.toLowerCase() === "readme.md") continue;
  take(path.basename(file, path.extname(file)), path.join(REPO, "licenses", file));
}

// --- vendored Rust ---------------------------------------------------------

const vendored = licenseIn(path.join(REPO, "third_party", "opencascade-rs"));
if (vendored) take("opencascade-rs", vendored);

// --- npm: every declared dependency, not a hand-kept list ------------------
//
// Read from package.json so a new dependency is picked up without anyone
// remembering to add it here. devDependencies are excluded: they are build tooling
// and do not reach a user's machine.

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
for (const dep of Object.keys(pkg.dependencies || {})) {
  const dir = path.join(NODE_MODULES, ...dep.split("/"));
  const file = licenseIn(dir);
  if (file) take(dep.replace(/^@/, "").replace(/\//g, "-"), file);
  else problems.push(`npm ${dep}: no license file in ${path.relative(REPO, dir)}`);
}

// --- Python: whatever the built sidecar runtime actually contains ----------
//
// Driven off the built tree rather than off uv.lock, because the tree is what ships.
// A wheel that carries no license file is reported rather than skipped: that is how
// cadquery-ocp-novtk's missing OCCT text was found in the first place.

if (fs.existsSync(SITE)) {
  for (const entry of fs.readdirSync(SITE)) {
    if (!entry.endsWith(".dist-info")) continue;
    const distInfo = path.join(SITE, entry);
    const project = entry.replace(/-[^-]*\.dist-info$/, "");
    // PEP 639 puts them under licenses/; older wheels put them alongside METADATA.
    const file = licenseIn(path.join(distInfo, "licenses")) || licenseIn(distInfo);
    if (file) take(`python-${project}`, file);
    else problems.push(`python ${project}: wheel ships no license file`);
  }
} else {
  problems.push(
    `sidecar runtime not built at ${path.relative(REPO, SITE)} — run scripts/build-sidecar-runtime.sh first`,
  );
}

// --- the gate --------------------------------------------------------------
//
// A required name matches if any collected key contains it, so `planegcs` is satisfied
// by `salusoft89-planegcs` and `certifi` by `python-certifi` without this list having
// to track packaging names it does not control.

const names = [...collected.keys()];
const missing = REQUIRED.filter(
  (want) => !names.some((got) => got.toLowerCase().includes(want.toLowerCase())),
);

for (const line of problems) console.warn(`[licenses] note: ${line}`);

if (missing.length) {
  console.error(
    `\n[licenses] FAILED — ${missing.length} required text(s) missing: ${missing.join(", ")}\n` +
      `[licenses] NOTICE.md promises these ship. Do not weaken the promise; find the text.\n`,
  );
  process.exit(1);
}

if (checkOnly) {
  console.log(`[licenses] ok — ${collected.size} texts resolve, ${problems.length} note(s)`);
  process.exit(0);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const index = [
  "# License texts bundled with this build",
  "",
  "Generated by scripts/collect-licenses.mjs. See NOTICE.md for what each component is,",
  "which license it is under, and where its source can be obtained.",
  "",
];

for (const [name, { from, bytes }] of [...collected].sort(([a], [b]) => a.localeCompare(b))) {
  fs.writeFileSync(path.join(OUT, `${name}.txt`), bytes);
  index.push(`- ${name}.txt — from ${from}`);
}

fs.writeFileSync(path.join(OUT, "README.md"), index.join("\n") + "\n");

console.log(
  `[licenses] wrote ${collected.size} texts to ${path.relative(REPO, OUT)}` +
    (problems.length ? ` (${problems.length} note(s) above)` : ""),
);
