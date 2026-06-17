# Verxa

A Fusion-360-style **parametric solid modeler** for Linux. Verxa is not a
geometry kernel — it's a Fusion-style front-end that drives
[**build123d**](https://github.com/gumyr/build123d) (Python, on the OpenCASCADE
kernel). build123d does extrude, fillet, chamfer, loft, revolve, mirror as
one-liners and exports STEP/STL/3MF natively; Verxa owns the UI, the feature
tree, and the plumbing.

> Codename **Verxa** — an antonym pun on Fusion.

## Architecture

```
┌─ Tauri shell (Rust) ──────────────────────────────────────┐
│  • native window, file dialogs                             │
│  • spawns + supervises the Python geometry sidecar         │
│  • kills the sidecar on app exit (process-group + PDEATHSIG)│
│                                                            │
│  ┌─ Frontend (TypeScript, in the webview) ──────────────┐  │
│  │  • Three.js viewport (orbit/pan/zoom, ViewCube,      │  │
│  │    picking, Z-up)                                    │  │
│  │  • UI: browser tree, timeline, parameters, toolbar,  │  │
│  │    Fusion keymap                                     │  │
│  │  • owns the DOCUMENT (feature tree + parameters)     │  │
│  └──────────────────┬───────────────────────────────────┘  │
└─────────────────────┼──────────────────────────────────────┘
                      │  JSON over localhost WebSocket (ws://127.0.0.1:8765)
                      ▼
┌─ Geometry sidecar (Python + build123d + OCCT) ────────────┐
│  • rebuild(document) → mesh + per-tri faceIds + edges      │
│  • export(document, format, path) → STEP / STL / 3MF       │
│  • selector resolution (topological-naming mitigation)     │
└────────────────────────────────────────────────────────────┘
```

**Key decisions**
- Geometry lives **only** in Python; Rust never touches it.
- **Full rebuild every change** — the frontend sends the whole document, the
  sidecar rebuilds from scratch and returns a fresh mesh. No server-side state.
- The parametric engine **is** re-running the build123d tree.
- Geometry is referenced by **queryable selectors** (axis / normal /
  nearest-point), never by index — so references survive upstream edits that
  renumber topology.

## Status — M1 spine + selector picking (working)

- ✅ Python sidecar: rebuild → tessellated mesh (per-triangle face ids) + edge
  polylines + bbox; STEP/STL/3MF export; per-feature error reporting.
- ✅ Three.js viewport: Z-up, `camera-controls` Fusion nav, ortho/persp toggle,
  fit-to-view, standard views, ViewCube, infinite grid, fat edge lines,
  edge/face picking → selector descriptors, per-face hover/select highlight.
- ✅ Tauri v2 shell: spawns/supervises/reaps the sidecar (verified no orphans).
- ✅ Document model: parameters + features, undo/redo, debounced rebuild,
  timeline with red error flags (Fusion-style), browser tree, inspector.
- ✅ **Fusion-style modeling workflow**:
  - **Create Sketch** → pick a plane → camera squares normal to it, model
    ghosts, sketch grid appears, a modal **SKETCH** toolbar + green **Finish
    Sketch** show.
  - **Interactive drawing** — Line (chains), Rectangle (2-point), Circle
    (center-diameter) with rubber-band preview, snapping to
    grid/endpoints/midpoints/centers, and **on-canvas dimension input** (gold
    W/H/⌀/L/∠ boxes: type → Tab locks → Enter commits; unlocked fields track the
    cursor).
  - **Auto profile detection** — closed regions shade translucent blue.
  - **Extrude (E)** — select a profile, set depth by moving the cursor along an
    arrow manipulator with a **live `ExtrudeGeometry` preview** + numeric box;
    **operation auto-selects** (New Body / Join / Cut; negative depth = cut,
    preview turns red); commit builds it authoritatively in build123d, picking
    the region by interior point.
- ✅ fillet/chamfer/mirror; save/load JSON; STEP/STL/3MF export.
- ✅ Selector survival: a hole-rim fillet (nearest-point selector) survives a
  `width` change that moves/renumbers the outer geometry.

### Deferred (next milestones)
- A real 2D constraint solver (`@salusoft89/planegcs` WASM, or `python-solvespace`
  in the sidecar) — today's sketcher is direct-manipulation with snapping +
  driving dimensions, no auto-constraint solve.
- Sketch-on-face (offset/derived planes); Press/Pull (Q) face drag; double-click
  timeline → re-edit feature with its manipulator (sketch re-edit is wired).
- Revolve/Loft UI; dedicated `hole` feature; marking/radial menu.
- Production packaging (PyInstaller `--onedir` or a relocatable `uv` env);
  incremental rebuild/caching if needed.

## Document format (the save file)

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
Any numeric field is a literal (`5`) or a parameter name (`"width"`).

## Dev quickstart

```bash
# 1. geometry sidecar (Python 3.12 venv via uv — OCP wheels lag newest CPython)
cd sidecar
uv venv --python 3.12 && uv pip install build123d websockets
uv run python test_smoke.py    # backend sanity (rebuild/export/error-naming)
uv run python test_ws.py       # WebSocket transport sanity

# 2. the app (from the repo root) — Tauri starts vite AND the sidecar for you
npm install
npm run tauri dev
```

For frontend-only iteration you can run the two halves separately:
```bash
cd sidecar && uv run python server.py     # ws://127.0.0.1:8765
npm run dev                               # http://localhost:5173
```
> Note: a standalone `python server.py` started in the background does **not**
> auto-die when its shell exits (only the Tauri-managed sidecar does). Kill it
> by hand or it will hold port 8765.

## Layout

```
sidecar/      build123d geometry service (builder, geom_select, tessellate, exporters, server)
src/          frontend — viewport/, ui/, document/, geometry/, input/, io/
src-tauri/    Rust shell — lib.rs (entry), sidecar.rs (lifecycle)
```
