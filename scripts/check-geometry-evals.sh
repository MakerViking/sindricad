#!/usr/bin/env bash
# check-geometry-evals.sh — CI gate for the sidecar's geometry eval harnesses.
#
# WHY THIS EXISTS: the evals under sidecar/tools/ are MEASUREMENT oracles. They
# print a number and exit 0 whether that number is good or catastrophic
# (eval_selector_survival is a hash-locked Norn oracle — its exit contract is
# "0 = measurement completed", and changing that would break the sealed arc).
# So nothing was gating them, and nothing ran them: between 2026-07-12 and
# 2026-07-28 the golden-document baselines went 15 commits stale and real-server
# op coverage decayed 28/28 -> 23/34 with no signal. This script supplies the
# thresholds, leaving every oracle's own contract untouched.
#
# Run from the repo root:  sh scripts/check-geometry-evals.sh
set -eu

cd "$(dirname "$0")/.."/sidecar
PY="${PY:-uv run python}"

# Coverage RATCHET, not a target: real-server op coverage may never drop below
# what it is today. It is currently 32 of 32 — every unit in the universe is
# covered by an EXPLICIT check that asserts a precomputed numeric geometric
# invariant against a real spawned server.
#
# VERIFIED REACHABLE ON A CLEAN CHECKOUT: with corpus credit disabled entirely,
# coverage still reads 32/32, so not one counted unit depends on a fixture
# document. That check is not optional ceremony — this floor was once set to 23
# from a machine where two ops were credited only by a corpus document whose
# import source lived in the developer's home directory, and every other
# checkout scored 21. Re-run that way before raising this number again.
#
# Four ops are excluded in e2e_coverage.py rather than counted, because no
# numeric geometric invariant exists for them and the only way to make them
# count would be to weaken the credit gate: cancel (a race — test_cancel.py),
# listFonts and tessellateText (font-dependent, so a hardcoded constant would be
# unreachable in CI by construction — test_text.py), and cleanUp, which is
# best-effort-no-op by design and is the one ACKNOWLEDGED remaining gap.
#
# Raise this number when you cover more; never lower it to make a build pass.
COVERAGE_FLOOR=32

# The fillet/chamfer corpus was driven to zero failures by the Norn loop
# (149/500 -> 0/500, holdout-verified). Any regression is a real one.
FILLET_MAX_FAILURES=0

# v2 selector survival at the sealed tuning. 0.9909 was the arc's result; the
# floor sits just under it so float noise can't flap the build.
SELECTOR_MIN_RATE=0.990

fail=0
note() { printf '\n=== %s ===\n' "$1"; }

note "fillet/chamfer corpus"
out=$($PY tools/eval_fillet_corpus.py 2>/dev/null | tail -40)
echo "$out" | tail -3
failed=$(echo "$out" | sed -n 's/.*failed=\([0-9]*\)\/[0-9]*.*/\1/p' | tail -1)
if [ -z "$failed" ]; then
  echo "FAIL: could not parse a failure count from eval_fillet_corpus"; fail=1
elif [ "$failed" -gt "$FILLET_MAX_FAILURES" ]; then
  echo "FAIL: $failed fillet failures (max $FILLET_MAX_FAILURES)"; fail=1
else
  echo "ok: $failed failures"
fi

note "selector survival"
out=$($PY tools/eval_selector_survival.py --config selector_tuning.json \
        --corpus tools/corpus/corpus_selectors.json 2>/dev/null | tail -1)
echo "$out"
# The oracle's contract: exactly ONE JSON line, last line of stdout.
# $PY is a COMMAND WITH ARGS ("uv run python"), so it must stay unquoted here.
# It was once "${PY%% *}" — the first word — which ran `uv -c '<script>'`; that is
# not a valid uv invocation, and with stderr dropped it failed mute and set fail=1.
# The threshold was never evaluated; the gate only ever pinned the build red.
if ! echo "$out" | $PY -c "
import json,sys
d=json.loads(sys.stdin.read())
ok = d['v2_rate'] >= $SELECTOR_MIN_RATE and d['invalid_count'] == 0 and d['tests_pass'] == 1
print(('ok: v2_rate=%.6f' % d['v2_rate']) if ok else
      ('FAIL: v2_rate=%.6f invalid=%s tests_pass=%s' % (d['v2_rate'], d['invalid_count'], d['tests_pass'])))
sys.exit(0 if ok else 1)
" 2>/dev/null; then
  fail=1
fi

note "real-server op coverage"
out=$($PY tools/e2e_coverage.py 2>/dev/null | tail -3)
echo "$out"
covered=$(echo "$out" | sed -n 's/^covered \([0-9]*\)\/[0-9]*.*/\1/p' | tail -1)
if [ -z "$covered" ]; then
  echo "FAIL: could not parse a coverage count from e2e_coverage"; fail=1
elif [ "$covered" -lt "$COVERAGE_FLOOR" ]; then
  echo "FAIL: coverage dropped to $covered (floor $COVERAGE_FLOOR)"; fail=1
else
  echo "ok: $covered covered (floor $COVERAGE_FLOOR)"
fi

# NOT WIRED YET: tools/golden_corpus.py --check.
# It self-gates (exit 1 on drift) and is the strongest detector here, but its
# baselines are currently stale — 12 of 13 documents differ, and one of those
# diffs is a REAL geometry change in 644ffc2 (1.sindri body2 +4.73% volume,
# z-extent -25 -> -24, from routing _do_combine through _serial_bool). Adding
# it now would just pin CI red. It goes in as part of re-blessing golden.json,
# which needs a human decision on whether the new geometry is correct.

printf '\n'
if [ "$fail" -ne 0 ]; then echo "geometry evals FAILED"; exit 1; fi
echo "geometry evals OK"
