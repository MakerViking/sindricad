#!/bin/sh
# Static pre-flight for dropping 'unsafe-eval' from SindriCAD's CSP.
#
# The 2D constraint solver (planegcs) is an emscripten/embind module, and embind
# builds every invoker by handing a SOURCE STRING to the Function constructor.
# 'wasm-unsafe-eval' permits WebAssembly COMPILATION only — it does NOT permit
# that constructor. So tightening script-src while the STOCK glue is bundled
# ships a build whose solver cannot start: no constraints, no dimensions, no
# point dragging, and a red toast on the first constraint. It cannot be caught
# in `tauri dev`, which serves from vite with no CSP at all.
#
# This script checks the one combination that is always wrong (tightened policy
# + unpatched glue) and prints the state of everything else. It CANNOT prove the
# solver starts — only a packaged run can. See docs/CSP-SOLVER-VERIFICATION.md.
#
# Usage:  npm run build && sh scripts/check-csp-solver.sh
set -eu

conf=src-tauri/tauri.conf.json
glue=node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.js

# Published @salusoft89/planegcs 1.1.7, built WITHOUT -s DYNAMIC_EXECUTION=0.
# 28493 bytes; the patched rebuild measured 27526.
UPSTREAM_UNPATCHED=5d5fe10097d757e7b4df2ee65f3804e3b32f9a09459b50634afe9a3bbc6b174d

fail=0
note() { printf 'FAIL  %s\n' "$1"; fail=1; }

script_src() { # $1 = "csp" | "devCsp"
  grep "\"$1\":" "$conf" | sed -n 's/.*script-src \([^;]*\);.*/\1/p'
}

# --- 1. the policy ------------------------------------------------------------
csp=$(script_src csp)
dev=$(script_src devCsp)
echo "policy (src-tauri/tauri.conf.json)"
echo "     csp script-src: $csp"
echo "  devCsp script-src: $dev"
[ -n "$csp" ] || note "could not read app.security.csp — has the config moved?"
# csp and devCsp drifting apart is how a tightening gets applied to the half
# nobody ships, or to the half nobody runs. src/security/csp.test.ts asserts
# this too; repeated here so the check works without node.
[ "$csp" = "$dev" ] || note "csp and devCsp disagree on script-src"

tightened=no
case "$csp" in *"'unsafe-eval'"*) ;; *) tightened=yes ;; esac
echo "  'unsafe-eval' removed: $tightened"

# --- 2. the glue that is actually installed -----------------------------------
echo
echo "planegcs glue ($glue)"
if [ ! -f "$glue" ]; then
  echo "  not installed (run npm ci) — skipping"
elif ! command -v sha256sum >/dev/null 2>&1; then
  # macOS ships `shasum -a 256` instead; not worth branching until this runs
  # somewhere other than Linux + CI
  echo "  no sha256sum on PATH — skipping the checksum ($(wc -c < "$glue") bytes)"
else
  sum=$(sha256sum "$glue" | cut -d' ' -f1)
  echo "  sha256: $sum"
  echo "  bytes:  $(wc -c < "$glue")"
  if [ "$sum" = "$UPSTREAM_UNPATCHED" ]; then
    echo "  => stock upstream 1.1.7: CONTAINS the Function-constructor sink"
  else
    echo "  => not the published 1.1.7 bytes. If this is the vendored"
    echo "     DYNAMIC_EXECUTION=0 rebuild, check its checksum against the"
    echo "     reproduce notes shipped beside it."
  fi
fi

# --- 3. what the bundle actually ships ----------------------------------------
# The decisive artifact: whichever glue vite bundled is what a packaged build
# runs. `var a=Function` is embind's `new_` helper after closure minification —
# a grep for "new Function(" finds NOTHING here and is not evidence of absence.
#
# POLARITY MATTERS HERE, and an earlier version of this script had it backwards.
# Finding the string proves the sink IS present. NOT finding it proves only that
# this one string was not found: vite re-minifies, and a renamed local would make
# the grep miss a sink that is still there. Reporting that as "patched glue
# bundled" is a false all-clear on the single question that decides whether a
# packaged build ships a working solver — so absence is INCONCLUSIVE, and
# inconclusive + a tightened CSP is a FAILURE, not an OK.
echo
echo "built bundle (dist/)"
if [ ! -d dist ]; then
  echo "  not built — run 'npm run build' first (this check is inconclusive without it)"
  if [ "$tightened" = yes ]; then
    note "the CSP is tightened and there is no bundle to check. Build and re-run:
      shipping on this evidence would be a guess."
  fi
else
  hits=$(grep -l 'var a=Function' dist/assets/*.js 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "  Function-constructor sink PRESENT in: $hits"
    if [ "$tightened" = yes ]; then
      note "the CSP forbids the Function constructor and the bundle still needs it —
      this build ships a dead constraint solver. Vendor the patched glue, or put
      'unsafe-eval' back."
    fi
  else
    echo "  that sink spelling not found — INCONCLUSIVE, not a pass"
    echo "  (proves only that one minified spelling is absent, not that the glue is patched)"
    if [ "$tightened" = yes ]; then
      note "the CSP is tightened and the bundled glue could not be POSITIVELY identified
      as the patched build. Confirm by checksum against the artifact from the
      planegcs-glue workflow, then run the packaged-build check in
      docs/CSP-SOLVER-VERIFICATION.md. Do not ship on a missing grep."
    fi
  fi
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "PRE-FLIGHT FAILED — see docs/CSP-SOLVER-VERIFICATION.md"
  exit 1
fi
echo "pre-flight OK (static only — this does NOT prove the solver starts;"
echo "run docs/CSP-SOLVER-VERIFICATION.md against a PACKAGED build)"
