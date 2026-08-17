#!/usr/bin/env bash
# Stage `sindri-mcp` where the bundle config expects it.
#
# Tauri's externalBin wants `binaries/<name>-<target triple>`, and resolves it at
# BUNDLE time — so the binary has to exist before `tauri build` runs, and a wrong
# triple fails minutes into the job rather than immediately.
#
# CI does the same thing inline (.github/workflows/build.yml, "Stage sindri-mcp
# for bundling"). This script exists so a local `tauri build` can be reproduced
# without reading the workflow.
#
# Deliberately NOT wired into `tauri dev`: externalBin lives only in
# tauri.bundle.conf.json, so the dev config never looks for this file.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"

cargo build --release --bin sindri-mcp
triple=$(rustc -vV | sed -n 's/^host: //p')
if [ -z "$triple" ]; then
  echo "could not read the host triple from rustc -vV" >&2
  exit 1
fi

mkdir -p binaries
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) cp target/release/sindri-mcp.exe "binaries/sindri-mcp-${triple}.exe" ;;
  *)                    cp target/release/sindri-mcp     "binaries/sindri-mcp-${triple}" ;;
esac

ls -la binaries/
echo "staged for ${triple}"
