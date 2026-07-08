# Third-Party Notices

SindriCAD incorporates the following third-party components. This file satisfies the
attribution and source-availability requirements of their licenses. Full license texts
are bundled under `LICENSES/` in distributed builds.

No dependency is under the GPL or AGPL; nothing here requires SindriCAD's own source to
be published. The copyleft components below are **weak-copyleft (LGPL)** and are used in a
license-compatible way (dynamic linking / separate process), which permits distributing
SindriCAD under its own terms.

## Geometry kernel

- **Open CASCADE Technology (OCCT)** 7.9.3 — LGPL-2.1 **with the Open CASCADE Exception**.
  Source: https://github.com/Open-Cascade-SAS/OCCT (tag V7_9_3).
  Linked **dynamically** (system shared library); users may relink with a compatible
  modified OCCT. The Open CASCADE Exception additionally permits incorporating OCCT header
  material into the application.
- **opencascade-rs / opencascade-sys** (vendored fork, `third_party/opencascade-rs/`) —
  LGPL-2.1. Upstream: https://github.com/bschwind/opencascade-rs (fork patched for OCCT 7.9).
- **OCP** (OpenCASCADE Python bindings, used by the geometry sidecar) — LGPL-2.1.
  Source: https://github.com/CadQuery/OCP. Runs as a **separate process** (the sidecar),
  communicating over a local WebSocket — not linked into the application binary.

## 2D constraint solver

- **PlaneGCS** (from FreeCAD), via **@salusoft89/planegcs** — LGPL-2.0-or-later.
  Source: https://github.com/FreeCAD/FreeCAD (src/Mod/Sketcher/App/PlaneGCS) and
  https://github.com/Salusoft89/planegcs. Used as a WebAssembly module.

## Permissively licensed components

- **build123d** — Apache-2.0 — https://github.com/gumyr/build123d
- **cadquery-ocp** — Apache-2.0 — https://github.com/CadQuery/ocp-build-system
- **three.js** — MIT — https://github.com/mrdoob/three.js
- **camera-controls** — MIT — https://github.com/yomotsu/camera-controls
- **Tauri** and official plugins (`tauri`, `tauri-plugin-fs`, `tauri-plugin-dialog`,
  `@tauri-apps/*`) — MIT OR Apache-2.0 — https://github.com/tauri-apps/tauri
- **hidapi** (Rust crate) — MIT — https://github.com/ruabmbua/hidapi-rs
- **threemf** (Rust crate) — 0BSD — https://crates.io/crates/threemf
- **websockets** (Python) — BSD-3-Clause — https://github.com/python-websockets/websockets
- **serde / serde_json / glam / libc** — MIT OR Apache-2.0

## Written offer (LGPL source availability)

For the LGPL components above (OCCT, OCP, PlaneGCS), the corresponding source code is
available at the URLs listed. For any distributed binary build, the complete corresponding
source of these libraries is also available from the project for a period of at least three
(3) years upon request. SindriCAD links OCCT dynamically and runs OCP as a separate process,
so users may replace these libraries with compatible modified versions.
