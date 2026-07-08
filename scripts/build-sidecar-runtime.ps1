# Windows equivalent of scripts/build-sidecar-runtime.sh: build a relocatable,
# self-contained Python runtime for the SindriCAD geometry sidecar and stage it for
# Tauri's bundle.resources. See the .sh for the full rationale (locked deps, novtk,
# copied-not-symlinked interpreter, packages in a sibling site-packages/ on PYTHONPATH).
#
# Output (default: src-tauri\sidecar-runtime\): python\ (interpreter),
# site-packages\ (deps), app\ (the sidecar *.py). Launch:
#   <runtime>\python\python.exe <runtime>\app\server.py   (cwd=<runtime>\app,
#   PYTHONPATH=<runtime>\site-packages)
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$out  = if ($args.Count -ge 1) { $args[0] } else { Join-Path $repo "src-tauri\sidecar-runtime" }
$side = Join-Path $repo "sidecar"

Write-Host "[runtime] building into $out (python 3.12, novtk, locked)"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null

# 1. python-build-standalone interpreter, copied in whole (on Windows python.exe sits
#    at the interpreter root; uv marks its managed pythons externally-managed, so we
#    install packages to a sibling dir via --target and keep the interpreter pristine).
uv python install 3.12
$pybin  = (uv python find 3.12).Trim()
$pyroot = Split-Path -Parent $pybin
New-Item -ItemType Directory -Force -Path (Join-Path $out "python") | Out-Null
Copy-Item -Recurse -Force (Join-Path $pyroot "*") (Join-Path $out "python")
$py = Join-Path $out "python\python.exe"

# 2. install the EXACT locked deps (matches the tested dev env) into a plain target dir.
$reqs = Join-Path $out "requirements.txt"
uv export --project $side --frozen --no-dev --no-emit-project --format requirements-txt -o $reqs
uv pip install --python $py --target (Join-Path $out "site-packages") -r $reqs

# 3. novtk is native to the locked stack; drop any vtk leftovers defensively.
Get-ChildItem -Path (Join-Path $out "site-packages") -Filter "vtk*" -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# 4. sidecar sources + precompile (read-only bundle: no .pyc writes at import time).
New-Item -ItemType Directory -Force -Path (Join-Path $out "app") | Out-Null
Copy-Item (Join-Path $side "*.py") (Join-Path $out "app")
& $py -m compileall -q (Join-Path $out "app")

Write-Host "[runtime] done: $out"
