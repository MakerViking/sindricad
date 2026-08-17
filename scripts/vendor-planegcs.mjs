// Install the vendored planegcs glue + wasm over the npm package's copy.
//
// WHY THIS EXISTS: the published 1.1.7 glue needs 'unsafe-eval' in the CSP,
// because embind hands source text to the Function constructor. The vendored
// build is the same commit with `-s DYNAMIC_EXECUTION=0`, which removes that
// sink. See vendor/planegcs/PROVENANCE.md for what is and is not established.
//
// A COPY, rather than a vite alias, deliberately. Everything has to agree about
// which glue is loaded: vite's dev server, the production bundle, `tauri build`,
// and the vitest suites - and the suites mock the `?url` wasm import to a path
// inside node_modules (src/sketch/sketchSolve.test.ts, constraintSequences.test.ts).
// An alias would have had to be repeated in each of those places, and the one
// that got forgotten would quietly certify the unpatched artifact while the app
// shipped the patched one.
//
// It runs from `postinstall`, so `npm ci` on a fresh clone and in CI lands the
// same pair a developer has locally.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "vendor", "planegcs");
const dest = join(root, "node_modules", "@salusoft89", "planegcs", "dist", "planegcs_dist");

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

// The checksums the vendored files are EXPECTED to have, read from the file that
// ships beside them. Verifying before the copy is the point: a corrupted or
// swapped-out artifact must fail loudly here rather than become the solver.
const expected = new Map(
  readFileSync(join(src, "SHA256SUMS.txt"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, name] = line.trim().split(/\s+/);
      return [name, hash];
    }),
);

if (!existsSync(dest)) {
  // Not an error: `npm ci` runs postinstall after the tree exists, but someone
  // may run this script directly in a checkout with no node_modules.
  console.log("[planegcs] package not installed yet, skipping vendored copy");
  process.exit(0);
}

for (const name of ["planegcs.js", "planegcs.wasm"]) {
  const from = join(src, name);
  const want = expected.get(name);
  if (!want) {
    console.error(`[planegcs] ${name} has no entry in vendor/planegcs/SHA256SUMS.txt`);
    process.exit(1);
  }
  const got = sha256(from);
  if (got !== want) {
    console.error(
      `[planegcs] REFUSING to install ${name}: checksum mismatch\n` +
        `  expected ${want}\n  actual   ${got}\n` +
        `  The vendored artifact is not the one that was built and reviewed.\n` +
        `  Rebuild it with the planegcs-glue workflow rather than editing the sums.`,
    );
    process.exit(1);
  }
  copyFileSync(from, join(dest, name));
}

console.log("[planegcs] vendored glue installed (DYNAMIC_EXECUTION=0, no 'unsafe-eval' needed)");
