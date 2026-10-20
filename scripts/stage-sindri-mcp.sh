#!/usr/bin/env bash
# Stage `sindri-mcp` where the bundle config expects it.
#
# Tauri's externalBin wants `binaries/<name>-<target triple>`, resolved at BUNDLE
# time — so the binary has to exist before `tauri build` runs, and a wrong triple
# fails minutes into the job rather than immediately.
#
# The shim is its OWN crate (src-tauri/sindri-mcp), not a second binary of the
# app package. That is load-bearing on Windows: while it was a `[[bin]]` of
# `sindricad`, Tauri's bundler emitted a component for it AND externalBin emitted
# another, and WiX refused the MSI with ICE30 — "installed by two different
# components". Building it from its own directory is what keeps `tauri build`
# from ever seeing it.
#
# CI does the same thing inline (.github/workflows/build.yml, "Stage sindri-mcp
# for bundling"). This script exists so a local `tauri build` can be reproduced
# without reading the workflow.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"

cargo build --release --manifest-path sindri-mcp/Cargo.toml
triple=$(rustc -vV | sed -n 's/^host: //p')
if [ -z "$triple" ]; then
  echo "could not read the host triple from rustc -vV" >&2
  exit 1
fi

mkdir -p binaries
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    cp sindri-mcp/target/release/sindri-mcp.exe "binaries/sindri-mcp-${triple}.exe" ;;
  *)
    cp sindri-mcp/target/release/sindri-mcp "binaries/sindri-mcp-${triple}" ;;
esac

ls -la binaries/
echo "staged for ${triple}"
