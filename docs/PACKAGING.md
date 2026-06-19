# Packaging SindriCAD

SindriCAD is a [Tauri 2](https://v2.tauri.app) desktop app:

- **Frontend** — TypeScript + Vite, built with `npm run build` (Node 22) into `dist/`.
- **Backend** — Rust (`src-tauri/`), which links the **system OpenCASCADE (OCCT)**
  through a vendored `opencascade-rs` fork (`third_party/opencascade-rs`).
- **Geometry sidecar** — a Python ([build123d](https://build123d.readthedocs.io))
  process spawned at startup in the default mode. See
  ["The Python sidecar problem"](#the-python-sidecar-problem) — this is the main
  blocker to a real distributable today.

CI scaffold: [`.github/workflows/build.yml`](../.github/workflows/build.yml).

---

## The OCCT version constraint (read this first)

The Rust geometry path links the **system** OCCT (the fork is configured
`default-features = false`, i.e. system-link, **not** the from-source `builtin`
build). Two things pin the version:

1. The fork's build script (`third_party/opencascade-rs/crates/opencascade-sys/build.rs`)
   gates on `major == 7 && minor >= 8` and **panics** otherwise.
2. The fork's C++ cxx-bridge sources were **patched for the OCCT 7.9.x API**
   (the upstream targets 7.8 and does not compile against 7.9.3 — `TopoDS`
   class→namespace changes, etc.). So even an OCCT that *passes* the numeric gate
   (e.g. 7.8) may **fail to compile** the bridge. In practice you want **7.9.x**.

| Platform | OCCT source | Version | Matches 7.9 binding? |
|----------|-------------|---------|----------------------|
| Linux (Arch) | `opencascade` pacman pkg | 7.9.3 | ✅ verified locally |
| Linux (Ubuntu apt) | `libocct-*-dev` | **7.6** | ❌ too old — fails gate *and* API. CI builds from source instead. |
| macOS | Homebrew `opencascade` | 7.9.3 | ✅ exact (unverified in CI) |
| Windows | vcpkg `opencascade` | 7.9.0 | ⚠️ passes gate; patch-level diff vs 7.9.3 (unverified) |

Two environment variables drive the build everywhere:

- `DEP_OCCT_ROOT` — install prefix passed to cmake's `find_package(OpenCASCADE)`.
- `CMAKE_POLICY_VERSION_MINIMUM=3.5` — OCCT's exported CMake config and the fork's
  helper `CMakeLists` declare an old minimum that **CMake 4 rejects** without this.

---

## Per-OS build instructions

### Linux

**Arch (known-good, matches local dev):**

```sh
sudo pacman -S --needed opencascade webkit2gtk-4.1 base-devel cmake
cd src-tauri
DEP_OCCT_ROOT=/usr CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo build      # debug
# Full bundle:
cd .. && DEP_OCCT_ROOT=/usr CMAKE_POLICY_VERSION_MINIMUM=3.5 npm run tauri build
```

**Ubuntu / Debian:** apt OCCT (7.6 on 24.04) is **too old**. Either build OCCT
7.9.3 from source (what CI does — see the workflow's "Build OCCT from source"
step) and point `DEP_OCCT_ROOT` at the install prefix, or use a PPA/conda that
provides 7.9.x. Tauri's webkit deps on Ubuntu:

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libfuse2
```

Bundles produced: `.AppImage` and `.deb` (and `.rpm` if `rpmbuild` is present)
under `src-tauri/target/release/bundle/`.

### macOS

```sh
brew install opencascade        # 7.9.3
export DEP_OCCT_ROOT="$(brew --prefix opencascade)"
export CMAKE_POLICY_VERSION_MINIMUM=3.5
npm ci && npm run tauri build
```

`brew --prefix opencascade` resolves the arch-correct keg (`/opt/homebrew/...`
on Apple Silicon, `/usr/local/...` on Intel). Bundles: `.app` and `.dmg`.

### Windows

```powershell
vcpkg install opencascade:x64-windows          # 7.9.0
$env:DEP_OCCT_ROOT = "$env:VCPKG_INSTALLATION_ROOT\installed\x64-windows"
$env:CMAKE_POLICY_VERSION_MINIMUM = "3.5"
npm ci ; npm run tauri build
```

`find_package(OpenCASCADE)` looks under `$DEP_OCCT_ROOT` for
`share/opencascade/OpenCASCADEConfig.cmake`. The OCCT DLLs live in
`...\x64-windows\bin` and must be on `PATH` at runtime (and bundled — see risks).
Bundles: `.msi` (WiX) and/or `.exe` (NSIS). **This leg is the least certain; see
[UNTESTED / RISKS](#untested--risks).**

---

## The Python sidecar problem

In its **default** mode the Rust shell spawns a Python build123d process at
startup (`src-tauri/src/sidecar.rs`) and the frontend talks to it over a
localhost WebSocket. Today that spawn:

- looks for a **dev virtualenv** at `sidecar/.venv/bin/python`, and
- falls back to a bare `python` on `PATH`.

Neither exists on an end-user machine, so **the bundles produced by this
workflow are NOT self-contained / distributable as-is.** A real package must do
one of:

1. **Freeze the sidecar per-OS** (e.g. [PyInstaller](https://pyinstaller.org))
   into a standalone executable, register it as a Tauri
   [sidecar binary](https://v2.tauri.app/develop/sidecar/) (`externalBin` +
   `<name>-<target-triple>` naming), and have `sidecar.rs` launch the bundled
   binary instead of the dev venv. build123d pulls in OCCT + numpy + scipy, so
   the frozen artifact is large and must be built on each OS.
2. **Finish the Rust geometry port** so the app no longer needs Python. There is
   already an in-progress native path (`src-tauri/src/geom.rs`, gated by
   `VITE_GEOM=rust`) that ports `sidecar/builder.py` + `tessellate.py` onto the
   OCCT fork. Once it reaches parity, the sidecar (and this whole problem) can be
   dropped. **This is the intended end state** — cross-reference the port plan.

Until one of those lands, treat CI output as build-verification artifacts, not
shippable installers.

---

## Code signing & notarization

### macOS (required for distribution outside the App Store)

Unsigned/un-notarized `.app`/`.dmg` are blocked by Gatekeeper on other machines.
Steps (see [Tauri macOS signing docs](https://v2.tauri.app/distribute/sign/macos/)):

1. Apple Developer Program membership + a **Developer ID Application** certificate.
2. Export the cert as `.p12`; in CI provide it via secrets and configure
   `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
   and a keychain step.
3. Notarize with an app-specific password or API key: `APPLE_ID`,
   `APPLE_PASSWORD`, `APPLE_TEAM_ID` (tauri-action / `tauri build` will notarize
   and staple when these are set).

> **Not doable in CI here without secrets.** No Apple Developer cert is
> configured in this repo, so the macOS leg produces **unsigned** bundles only.

### Windows (optional)

Signing avoids SmartScreen warnings but is not required to run. Needs an
Authenticode certificate (OV/EV). See
[Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/). Not
configured here.

### Linux

AppImage/.deb are not code-signed in the Apple/Windows sense; nothing to do.

---

## UNTESTED / RISKS

**Verified:**
- ✅ Linux build with **system OCCT 7.9.3** on Arch
  (`DEP_OCCT_ROOT=/usr CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo build`).
- ✅ `build.yml` and `tauri.conf.json` are well-formed (YAML/JSON parse-checked).

**Unverified / risky (in rough order of concern):**

1. **Windows MSVC + OCCT + cxx bridge — biggest unknown.** The fork's bridge has
   only ever been compiled with the Arch/Linux toolchain. Whether it compiles
   under MSVC against vcpkg's OCCT **7.9.0** (vs the 7.9.3 it was patched for) is
   untested. Also unverified: that `find_package(OpenCASCADE)` resolves from the
   vcpkg `installed/x64-windows` tree, and that OCCT DLLs get **bundled** so the
   app runs on a clean machine (Tauri WiX/NSIS will not pick up vcpkg DLLs
   automatically — they likely need `bundle.resources` / `externalBin` entries).
2. **OCCT version mismatch class of bug.** The binding was hand-patched for
   7.9.3. macOS Homebrew is 7.9.3 (safest), Windows vcpkg is 7.9.0, and the
   Linux from-source step pins 7.9.3. Any runner drifting to a different
   7.9.x — or a future 8.0 — can reintroduce the same API breakage we already
   patched for 7.9 (`TopoDS` namespace changes, etc.). **Do not** rely on
   `apt`/distro OCCT (Ubuntu = 7.6: fails outright).
3. **OCCT-from-source CMake flags (Linux).** The `-DBUILD_MODULE_*` set in the
   workflow is a minimal guess (modeling kernel + data exchange + visualization,
   no Draw/TK). If a toolkit the fork links is disabled, linking fails and the
   flags need adjustment. Also slow (~10-20 min cold; mitigated by cache).
4. **macOS leg unrun.** Command sequence is from docs; `brew --prefix
   opencascade` path handling and arch (arm64 runner) are untested here.
5. **Python sidecar not bundled** (see above) — every produced bundle is
   non-functional for an end user until the sidecar is frozen or the Rust path
   ships. CI artifacts are build proof, not installers.
6. **No code signing** on any platform (no secrets configured) — macOS bundles
   will be Gatekeeper-blocked on other machines.
