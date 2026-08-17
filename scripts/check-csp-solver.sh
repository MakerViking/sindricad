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

# --- 3. is the glue that will be bundled the VENDORED one? ---------------------
# POSITIVE identification, by checksum. An earlier version of this check greped
# the built bundle for one hardcoded minified spelling of the sink and treated
# ABSENCE as proof the patched glue was in place. That polarity is unsafe: vite
# re-minifies, so a renamed local makes the grep miss a sink that is still
# there, and the script would green-light tightening the CSP on a build that
# ships a dead solver. What can be positively identified is the artifact vite
# will bundle - node_modules' copy - against the checksums shipped beside the
# vendored one.
echo
echo "installed glue vs vendored"
# $glue and $sum are section 2's, deliberately reused: one path literal and one
# sha256sum of one artifact. Section 2 already guarded that sha256sum exists, so
# `$sum` is empty when it does not, which this branch has to respect.
vendored_sums="vendor/planegcs/SHA256SUMS.txt"
if [ ! -f "$vendored_sums" ]; then
  echo "  no vendored artifact in the tree"
  if [ "$tightened" = yes ]; then
    note "the CSP is tightened and there is no vendored glue to install, so the
      stock artifact is what gets bundled and the solver will not start."
  fi
elif [ ! -f "$glue" ]; then
  echo "  package not installed (run npm ci)"
elif [ -z "${sum:-}" ]; then
  echo "  no sha256sum on PATH — cannot identify the installed glue"
else
  want=$(grep " planegcs.js\$" "$vendored_sums" | cut -d' ' -f1)
  if [ "$want" = "$sum" ]; then
    echo "  installed glue IS the vendored build"
    if grep -q 'var a=Function' "$glue"; then
      note "the vendored glue still contains embind's Function-constructor helper.
      It was built without -s DYNAMIC_EXECUTION=0, or the wrong file was vendored."
    else
      echo "  and it carries no Function-constructor sink"
    fi
  else
    echo "  installed glue is NOT the vendored build"
    if [ "$tightened" = yes ]; then
      note "the CSP is tightened but node_modules holds a different glue than the
      vendored one. Run 'node scripts/vendor-planegcs.mjs' (npm's postinstall
      does this) and rebuild."
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
