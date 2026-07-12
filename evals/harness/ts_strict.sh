#!/usr/bin/env bash
# ts-strict-ratchet harness.
#
# Runs the repo TypeScript compiler under two extra strictness flags
# (noUncheckedIndexedAccess, exactOptionalPropertyTypes) and reports the
# number of type errors as a single machine-readable metric line.
#
# Contract (do not change without telling the loop driver):
#   stdout, default mode: EXACTLY one line -> errors=<N>
#   exit 0 whether or not type errors exist -- the COUNT is the metric.
#   exit non-zero ONLY on infrastructure failure (tsc could not run at all).
#
# Usage:
#   evals/harness/ts_strict.sh [REPO_ROOT] [--breakdown]
#     REPO_ROOT   optional path to the repo root (default: this script's ../..)
#     --breakdown also print, to stdout after the errors= line:
#                   - a per-error-code count table (sorted desc)
#                   - the top-20 offending files (sorted desc)
#                 (used to pick fix batches; not part of the metric contract)

set -u

# --- parse args: optional positional REPO_ROOT, optional --breakdown flag ---
BREAKDOWN=0
REPO_ROOT=""
for arg in "$@"; do
  case "$arg" in
    --breakdown) BREAKDOWN=1 ;;
    *)
      if [ -n "$REPO_ROOT" ]; then
        echo "ts_strict.sh: unexpected argument: $arg" >&2
        exit 2
      fi
      REPO_ROOT="$arg"
      ;;
  esac
done

# --- resolve repo root (default: script dir's ../..) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
else
  REPO_ROOT="$(cd "$REPO_ROOT" && pwd)" || {
    echo "ts_strict.sh: repo root not found: $REPO_ROOT" >&2
    exit 2
  }
fi

CONFIG="$REPO_ROOT/evals/harness/tsconfig.strict.json"
if [ ! -f "$CONFIG" ]; then
  echo "ts_strict.sh: strict tsconfig missing: $CONFIG" >&2
  exit 2
fi

cd "$REPO_ROOT" || { echo "ts_strict.sh: cannot cd to $REPO_ROOT" >&2; exit 2; }

# --- run tsc, capture combined output and exit code ---
OUT="$(npx --no-install tsc -p evals/harness/tsconfig.strict.json --noEmit --pretty false 2>&1)"
TSC_RC=$?

# Count the metric: lines that report a TS error.
N="$(printf '%s\n' "$OUT" | grep -c 'error TS')"

# Infrastructure failure: tsc failed to run AND produced no error lines
# (e.g. tsc/npx not installed, crash, OOM). A normal type-error run exits
# non-zero but DOES emit 'error TS' lines, which is expected, not a failure.
if [ "$TSC_RC" -ne 0 ] && [ "$N" -eq 0 ]; then
  echo "ts_strict.sh: tsc failed to run (rc=$TSC_RC, no error lines emitted)" >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi

# --- the metric ---
echo "errors=$N"

# --- optional breakdown (diagnostic, not part of the contract) ---
if [ "$BREAKDOWN" -eq 1 ]; then
  echo "--- error codes (count desc) ---"
  printf '%s\n' "$OUT" \
    | grep -oE 'error TS[0-9]+' \
    | sort | uniq -c | sort -rn \
    | awk '{printf "%6d  %s\n", $1, $3}'

  echo "--- top 20 files (count desc) ---"
  printf '%s\n' "$OUT" \
    | grep 'error TS' \
    | sed -E 's/\(([0-9]+),[0-9]+\): error TS.*$//' \
    | grep -v '^$' \
    | sort | uniq -c | sort -rn \
    | head -20 \
    | awk '{printf "%6d  %s\n", $1, $2}'
fi

exit 0
