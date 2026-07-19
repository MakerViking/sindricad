<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/sindricad-lockup-dark.svg">
    <img src="assets/brand/sindricad-lockup.svg" alt="SindriCAD" width="480">
  </picture>
</p>

Parametric CAD for Linux, built for 3D printing.

SindriCAD is a history-based solid modeler. You sketch, extrude, fillet, and pattern
your way to a part, and every step stays editable in a feature tree. It is not a mesh
editor, and it is not a geometry kernel of its own. It drives
[build123d](https://github.com/gumyr/build123d) on top of OpenCASCADE for the actual
geometry, and puts a real modeling UI and a print workflow on top.

It runs natively on Linux, where good parametric CAD has always been thin on the
ground, and it is built for 3D printing: color a multi-material model, export it as a
ready-to-slice OrcaSlicer project set up for the Snapmaker U1, and send the sliced
G-code to the printer over the LAN.

> Named for Sindri, the dwarven smith of Norse myth.

**Status: beta, in ongoing development.** SindriCAD already builds real printed parts,
but the feature set is still filling out and rough edges remain. Expect frequent
releases, report what breaks, and keep backups of documents you care about.

## What it does

- **Sketching** with lines, arcs, circles, splines, rectangles, slots, and polygons,
  plus associative patterns (bolt circles, grids, honeycomb) and a PlaneGCS constraint
  solver. Dimensions are entered on the canvas: type a value, press Tab to lock it,
  Enter to commit.
- **Features**: Extrude (new body, join, cut, intersect, per region), Revolve, Loft,
  Sweep, Press/Pull (multi-face, and extrude up to a target surface), Fillet, Chamfer,
  Shell, Draft, Scale, Mirror, and patterns.
- **Direct editing**: Move with a live ghost preview, Split, Combine, Delete Face with
  automatic healing, and a cleanup pass for messy imported geometry.
- **Import** STEP, STL, 3MF, and OBJ, with facet cleanup and STEP canonicalization, so
  imported parts come back as editable faces instead of a triangle soup.
- **References that survive edits**: geometry is picked by queryable descriptors (an
  axis, a face normal, the nearest point), never by a topology index. Change an
  upstream parameter and a downstream fillet still lands on the right edge.
- **A print pipeline** for the Snapmaker U1 (see below).

Press `?` in the app for the full keyboard shortcut list.

## Snapmaker U1 print pipeline

SindriCAD carries print prep for the Snapmaker U1 multi-material printer from model to
machine, so a colored parametric part reaches a print without a manual export dance.

- **Multi-material and multi-color 3MF**: assign palette colors to bodies and export an
  OrcaSlicer project 3MF with per-object extruder (tool) mapping for the U1's tool
  changer (`sidecar/project3mf.py`).
- **Slicer handoff**: "Open in OrcaSlicer" binds the U1 preset with your tuned process
  and filament, so you land ready to slice.
- **Direct device layer**: a Rust Moonraker client (`src-tauri/src/printer.rs`) uploads
  G-code to the printer over the LAN with a filament-mapping dialog, reads the palette
  back from the printer, and monitors the running print.

U1 support will keep growing: I add features as I come up with them and have time
for them.

## Architecture

```
┌─ Tauri shell (Rust) ──────────────────────────────────────┐
│  • native window, file dialogs                             │
│  • spawns and supervises the Python geometry sidecar       │
│  • kills the sidecar on app exit (process-group + PDEATHSIG)│
│                                                            │
│  ┌─ Frontend (TypeScript, in the webview) ──────────────┐  │
│  │  • Three.js viewport (orbit/pan/zoom, ViewCube,      │  │
│  │    picking, Z-up)                                    │  │
│  │  • UI: browser tree, timeline, parameters, toolbar   │  │
│  │  • owns the DOCUMENT (feature tree + parameters)     │  │
│  └──────────────────┬───────────────────────────────────┘  │
└─────────────────────┼──────────────────────────────────────┘
                      │  JSON over localhost WebSocket (ws://127.0.0.1:8765)
                      ▼
┌─ Geometry sidecar (Python + build123d + OCCT) ────────────┐
│  • rebuild(document) -> mesh + per-triangle faceIds + edges │
│  • export(document, format, path) -> STEP / STL / 3MF       │
│  • selector resolution (topological-naming mitigation)     │
└────────────────────────────────────────────────────────────┘
```

Design decisions worth knowing up front:

- **Geometry lives only in Python** on the shipping path. Rust never touches it there.
  There is an experimental opt-in Rust geometry path on OpenCASCADE, gated behind
  `VITE_GEOM=rust`, but a 2026 feasibility study found a Rust kernel could not beat
  OCCT on robustness or speed, so the Python build123d sidecar stays the default and
  the source of truth.
- **Full rebuild on every change.** The frontend sends the whole document, the sidecar
  rebuilds from scratch and returns a fresh mesh. There is no server-side state.
- **The parametric engine is the build123d tree, re-run.** Nothing more exotic.
- **Selectors, not indices.** Geometry is referenced by queryable descriptors so
  references survive edits that renumber the underlying topology.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full invariant list and the
rebuild pipeline, and [docs/PROTOCOL.md](docs/PROTOCOL.md) for the sidecar's wire
protocol.

## Document format

A `.sindri` file is JSON: a parameter table and an ordered list of features.

```jsonc
{
  "parameters": { "width": 40, "height": 20, "thickness": 5 },
  "features": [
    { "id": "f1", "type": "sketch", "plane": "XY",
      "entities": [{ "type": "rectangle", "width": "width", "height": "height" }] },
    { "id": "f2", "type": "extrude", "sketch": "f1", "distance": "thickness", "operation": "new" },
    { "id": "f3", "type": "fillet", "edges": { "kind": "edge", "by": "axis", "axis": "Z" }, "radius": 2 }
  ]
}
```

Any numeric field is either a literal (`5`) or the name of a parameter (`"width"`).

## Install

Beta installers for Windows, Linux, and macOS live on the
[latest beta release](https://github.com/MakerViking/sindricad/releases/tag/beta),
rebuilt automatically from every green `main` build. No GitHub account needed.
Everything is bundled, including Python and the geometry engine; nothing else to
install. The builds are unsigned for now.

### Windows

1. Download `SindriCAD_0.1.0_x64-setup.exe` (or the `.msi`) from the
   [latest beta](https://github.com/MakerViking/sindricad/releases/tag/beta).
2. The build is unsigned, so SmartScreen will warn "Windows protected your PC". Click
   "More info", then "Run anyway".

SindriCAD needs Microsoft Edge WebView2, which Windows 10 and 11 already ship; the
setup exe fetches it automatically if it is missing.

### Linux

Grab the `.AppImage` (`chmod +x`, runs on any distro), or the `.deb` / `.rpm`
(`sudo dpkg -i SindriCAD_0.1.0_amd64.deb`, or `sudo rpm -i` the `.rpm`).

### macOS

The `.dmg` is unsigned: right-click the app, choose Open, then confirm. Apple code
signing is planned.

## Build and run

Prerequisites: Node, a Rust toolchain, Python 3.12, [uv](https://docs.astral.sh/uv/),
and WebKitGTK. See [docs/PACKAGING.md](docs/PACKAGING.md) for per-OS package names and
known-good versions. A system OpenCASCADE install is **not** needed for the default
build: the geometry sidecar ships its own OCCT inside its Python wheels. OCCT is only
needed for the opt-in `rust-geom` Cargo feature (see
[docs/PACKAGING.md](docs/PACKAGING.md)).

```bash
# 1. geometry sidecar (Python 3.12 via uv, locked versions from uv.lock)
cd sidecar
uv sync
uv run python test_smoke.py    # backend sanity (rebuild/export/error naming)
uv run python test_ws.py       # WebSocket transport sanity

# 2. the app, from the repo root. Tauri starts Vite and the sidecar for you.
npm install
npm run tauri dev
```

For frontend-only iteration you can run the two halves separately:

```bash
cd sidecar && uv run python server.py     # ws://127.0.0.1:8765
npm run dev                               # http://localhost:5173
```

> Note: a standalone `python server.py` started in the background does **not** auto-die
> when its shell exits (only the Tauri-managed sidecar does). Kill it by hand or it will
> hold port 8765.

## Project layout

```
sidecar/      build123d geometry service (builder, geom_select, tessellate, exporters, server)
src/          frontend: viewport/, ui/, document/, geometry/, input/, io/, print/
src-tauri/    Rust shell: lib.rs (entry), sidecar.rs (lifecycle), printer.rs (U1 device layer)
```

## License

SindriCAD is licensed under the GNU Affero General Public License v3.0
(`AGPL-3.0-only`), see [LICENSE](LICENSE). AGPL's network copyleft means any fork, or
any modified version offered over a network, has to publish its source under the same
terms.

Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md), which includes a
short contributor agreement so the project can stay open under the AGPL while the
maintainer can also offer commercial terms to those who need them. Third-party
components and their licenses are listed in [NOTICE.md](NOTICE.md).

## Support

SindriCAD is free and open source. If it earns a place in your workflow, you can back
development on [Patreon (MuninWorks)](https://www.patreon.com/MuninWorks). Patronage
covers the servers, domains, and tooling behind this and my other projects.
