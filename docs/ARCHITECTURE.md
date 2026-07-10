# Architecture

SindriCAD is three processes cooperating over one connection: a Tauri (Rust) shell, a
TypeScript frontend running in that shell's webview, and a Python geometry sidecar.

```
┌─ Tauri shell (Rust) ───────────────────────────────────────────┐
│  • native window, file dialogs, printer/slicer network calls    │
│  • spawns and supervises the Python geometry sidecar             │
│  • kills the sidecar on app exit (process-group + PDEATHSIG /     │
│    Job Object on Windows)                                         │
│                                                                   │
│  ┌─ Frontend (TypeScript, in the webview) ──────────────────┐   │
│  │  • Three.js viewport (orbit/pan/zoom, ViewCube, picking,  │   │
│  │    Z-up)                                                  │   │
│  │  • UI: browser tree, timeline, parameters, toolbar        │   │
│  │  • owns the DOCUMENT (feature tree + parameters)          │   │
│  └───────────────────┬────────────────────────────────────────┘   │
└──────────────────────┼────────────────────────────────────────────┘
                       │  JSON over a localhost WebSocket
                       │  (ws://127.0.0.1:8765, see PROTOCOL.md)
                       ▼
┌─ Geometry sidecar (Python + build123d + OCCT) ─────────────────┐
│  • rebuild(document) -> mesh + per-triangle faceIds + edges       │
│  • export(document, format, path) -> STEP / STL / 3MF              │
│  • selector resolution (topological-naming mitigation)             │
└──────────────────────────────────────────────────────────────────┘
```

SindriCAD owns the document, the feature tree, the UI, and the print pipeline.
[build123d](https://github.com/gumyr/build123d) on top of OpenCASCADE owns the geometry
kernel itself; SindriCAD does not reimplement one.

## Hard invariants

These hold across the whole codebase. A change that would break one needs a plan and a
reason, not a quick patch.

1. **Geometry lives only in Python** on the shipping path. Rust never touches geometry
   there. There is an experimental, off-by-default Rust/OCCT path (`--features
   rust-geom` / `VITE_GEOM=rust`) kept as a spike; the Python build123d sidecar is the
   default and the source of truth.
2. **Stateless full rebuild.** The frontend's logical model is "send the document, get
   back a mesh" - the sidecar rebuilds the build123d tree from scratch on every change.
   A failing feature is recorded as a no-op and the rebuild continues past it, rather
   than aborting the whole document. (The wire protocol layers a delta encoding and a
   per-body cache on top of this for performance; see PROTOCOL.md - the semantics stay
   stateless from the frontend's point of view.)
3. **Selectors, not topology indices.** Geometry the frontend references (an edge for a
   fillet, a face for a pattern) is picked by a queryable descriptor - an axis, a face
   normal, the nearest point - never by a raw topology index. Indices renumber when
   upstream geometry changes; descriptors are re-resolved against the rebuilt shape, so
   a downstream feature keeps landing on the right edge.
4. **The sidecar port and token are fixed.** `127.0.0.1:8765` plus a per-launch
   `SINDRI_SIDECAR_TOKEN` shared secret, hardcoded on both sides and in the CSP. The
   webview's Content-Security-Policy `connect-src` is deliberately narrow (localhost and
   that one WebSocket) and must never be widened to admit an arbitrary URL.
5. **Display-only state stays in frontend side-maps.** Visibility, display names, and
   palette/body colors are UI state, not model state - they live in `DocumentStore`
   side-maps, not in the `document` sent to the sidecar, and are threaded explicitly
   through the calls that need them (e.g. `exportProject`).
6. **Pattern expansion and region detection are mirrored TS <-> Python.** Both sides
   independently expand associative patterns and detect split regions for direct
   editing; a change to one algorithm without the matching change to the other silently
   diverges preview from build.
7. **`src/input/shortcuts.ts` is the single source of truth for keyboard shortcuts.**
   The keymap dispatcher, the command palette, and the `?` shortcut HUD all read from
   this one table so they can't disagree about what a key does.

## The rebuild pipeline

1. The frontend sends the document (or, once a baseline is established, just the
   changed features) over the WebSocket.
2. The sidecar replays the build123d feature tree from scratch - sketch, extrude,
   fillet, pattern, and so on, in timeline order - inside a long-lived worker process.
3. If a feature fails (a fillet with no matching edge, a boolean that would be a
   no-op), that failure is recorded and the feature is treated as a no-op. The rebuild
   **continues** with the remaining features rather than discarding the whole document.
4. The result is tessellated per body and sent back as a mesh (positions, indices,
   per-triangle face ids) plus edge polylines, with any feature errors attached so the
   frontend can show a banner without losing the geometry that did build.
5. The frontend never accumulates its own geometry state across edits - the same
   `document` always rebuilds to the same result, deterministically.

See [PROTOCOL.md](PROTOCOL.md) for the exact wire shapes, including the delta-send and
per-body etag mechanisms that make this fast without changing the statelessness above.

## Bundled runtime layout (shipped builds)

The default build links no system OpenCASCADE. Geometry ships as a Python sidecar built
from `sidecar/uv.lock`, whose `cadquery-ocp-novtk` wheels carry their own compiled OCCT -
no system package is needed on the machine the app runs on. See
[PACKAGING.md](PACKAGING.md) for the build details; the shape of what gets shipped is:

```
sidecar-runtime/
  python/         a copied (not symlinked) python-build-standalone interpreter
                  (bin/python3.12 on Unix, python.exe on Windows)
  site-packages/  the locked dependency set, installed via `uv pip install --target`
                  so the interpreter tree stays untouched; loaded via PYTHONPATH
  app/            the sidecar's own *.py files (server.py, builder.py, ...)
```

The Rust shell launches the interpreter with `cwd` set to `app/` and `PYTHONPATH`
pointing at `site-packages/`. In development, the same shell instead resolves the
`sidecar/.venv` created by `uv sync`. The runtime is rebuilt from `sidecar/uv.lock`
whenever that lockfile changes - the versions inside must match what the sidecar code
is tested against.

The experimental Rust/OCCT geometry path (`geom.rs`, gated behind the `rust-geom`
Cargo feature) links a system-installed OCCT instead, and is not part of any shipped
build.
