#!/bin/sh
# Repo hygiene: fail if files that belong to a developer's machine or to an AI
# agent's session have been committed. This is a PUBLIC repo, so "it's only
# clutter" still means publishing a username, a home-directory layout, or tooling
# config that has nothing to do with SindriCAD.
#
# .gitignore alone is not enough: it only stops NEW untracked matches, and says
# nothing about a path that is already tracked (which is how .claude/settings.json
# got in) or one added with `git add -f`. This checks what git ACTUALLY tracks.
#
# Runs in CI and locally:  sh scripts/check-repo-hygiene.sh
set -eu

fail=0
note() { printf '  %s\n' "$1"; fail=1; }

# --- paths that must never be tracked ---------------------------------------
# Agent/session artifacts and editor state. Add to this list rather than relying
# on people noticing in review.
forbidden='
.claude/
.fable/
.cursor/
.aider*
handoff.md
CLAUDE.md
AGENTS.md
.vscode/
.idea/
.DS_Store
evals/
norn/
'

echo "checking tracked paths…"
for pat in $forbidden; do
  hits=$(git ls-files -- "$pat" "**/$pat" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    note "tracked but should not be ($pat):"
    printf '%s\n' "$hits" | sed 's/^/    /'
  fi
done

# --- CAD models: the developer's own parts must never be published ------------
# A .sindri/.3mf/.stl/.step is a real part — geometry, dimensions, sometimes a
# customer's job. .gitignore covers new files in the paths it names, but says
# nothing about `git add -f` or a model that predates the rule, which is exactly
# why this checks what git ACTUALLY tracks.
#
# Allowed: the synthetic bench fixture the perf harness needs, the generated
# assembly-tree fixtures (boxes emitted by tools/gen_asm_fixtures.py — no real
# geometry, reproducible from source), and third_party sample models that ship
# with vendored code. Add to this list only for files that are genuinely
# synthetic or already public.
echo "checking for tracked CAD models…"
models=$(git ls-files -- '*.sindri' '*.3mf' '*.stl' '*.step' '*.stp' 2>/dev/null \
  | grep -vE '^(sidecar/tools/bench/textured_box\.sindri$|sidecar/fixtures/asm_[a-z_]+\.step$|third_party/)' || true)
if [ -n "$models" ]; then
  note "tracked CAD model — is this a real part in a public repo?:"
  printf '%s\n' "$models" | sed 's/^/    /'
fi

# --- developer-machine paths inside tracked files ----------------------------
# A hardcoded /home/<user>/... is either a privacy leak or a script that only
# works on one machine — packaging/setup-spacemouse.sh was both.
#
# Allowed: synthetic users in test fixtures (the path-redaction tests need a
# realistic-looking path to redact). Anything else must be made relative.
echo "checking for hardcoded home directories…"
homes=$(git grep -InE '/(home|Users)/[a-z][a-z0-9_-]+/' -- . \
  ':(exclude)third_party/**' ':(exclude)package-lock.json' 2>/dev/null \
  | grep -vE '/(home|Users)/(alice|bob|user|username|youruser|me|test)/' || true)
if [ -n "$homes" ]; then
  note "hardcoded developer home directory:"
  printf '%s\n' "$homes" | cut -c1-160 | sed 's/^/    /'
fi

# --- the project's former name ------------------------------------------------
# This script is excluded from its own scan: it necessarily contains the string
# it looks for, and git grep only sees TRACKED files — so the self-match appeared
# the moment the script was first committed, not while it was being written.
echo "checking for the former project name…"
old=$(git grep -In 'Verxa' -- . ':(exclude)third_party/**' \
  ':(exclude)scripts/check-repo-hygiene.sh' 2>/dev/null || true)
if [ -n "$old" ]; then
  note "former project name 'Verxa' (renamed to SindriCAD):"
  printf '%s\n' "$old" | sed 's/^/    /'
fi

# --- checksummed artifacts must not be line-ending translated -----------------
# Anything verified by hash has load-bearing BYTES, and git will happily hand a
# Windows checkout different ones: the runners set core.autocrlf=true, so every
# file git considers text arrives with CRLF. vendor/planegcs/planegcs.js went
# from 641b4f9c to f204b9ac that way, vendor-planegcs.mjs correctly refused to
# install an artifact that was not the one built and reviewed, and `npm ci`
# failed on windows-latest alone while Linux and macOS stayed green.
#
# Enumerated from SHA256SUMS.txt rather than from a list here, so an artifact
# added to the manifest without a .gitattributes rule fails on the day it lands
# instead of on the next Windows run.
echo "checking line-ending pins on checksummed artifacts…"
sums='vendor/planegcs/SHA256SUMS.txt'
if [ -f "$sums" ]; then
  while read -r _hash name; do
    [ -n "${name:-}" ] || continue
    path="vendor/planegcs/$name"
    git ls-files --error-unmatch -- "$path" >/dev/null 2>&1 || continue
    # `text` must be explicitly unset (-text) or the file marked binary; the
    # default (unspecified/auto) is what lets autocrlf rewrite it.
    attr=$(git check-attr text -- "$path" | sed 's/.*: //')
    if [ "$attr" != "unset" ]; then
      note "$path is checksummed but not pinned in .gitattributes (text: $attr)"
    fi
  done < "$sums"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "Repo hygiene FAILED. Untrack with:  git rm --cached <path>"
  echo "and add it to .gitignore. If a path is legitimate, allow it in this script."
  exit 1
fi
echo "repo hygiene OK"
