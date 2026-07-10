# Sidecar wire protocol

The frontend and the Python geometry sidecar (`sidecar/server.py`) talk JSON over one
persistent WebSocket, `ws://127.0.0.1:8765`. It is a request/response protocol: every
request carries a client-generated `id`; every terminal reply echoes that `id`. There is
one connection per app instance; concurrent calls are matched by `id`, not by ordering.

This document describes the wire shapes as implemented in `sidecar/server.py` (the
dispatch in `handle()`) and consumed in `src/geometry/client.ts`. If the two ever
disagree, the code is the source of truth - update this file to match it, not the other
way around.

## Connecting

The URL carries the per-launch shared secret as a query parameter:

```
ws://127.0.0.1:8765/?token=<SINDRI_SIDECAR_TOKEN>
```

The Rust shell mints `SINDRI_SIDECAR_TOKEN` per launch and hands it to the frontend via
the `sidecar_token` Tauri command; the frontend fetches it once in `Geometry.init()`
before opening the socket. A connection missing or misquoting the token, or one whose
`Origin` header isn't the Tauri webview / dev server, is closed with WebSocket close
code 1008. There is no unauthenticated mode.

## Request envelope

```jsonc
{ "id": "<client-generated string, e.g. a UUID>", "op": "<op name>", /* op-specific fields */ }
```

## Reply envelope

A **terminal** reply always has the same top-level shape:

```jsonc
// success
{ "id": "<matching id>", "ok": true, "result": { /* op-specific */ } }
// failure
{ "id": "<matching id>", "ok": false, "error": { "message": "...", "feature_id": "..." /* optional */ } }
```

`rebuild` and `computeAll` additionally stream **non-terminal progress frames** with no
`ok` field - see "Progress frames" below; a client must not resolve a pending call on
one of those.

## Ops

### `rebuild`

Rebuilds the document and returns tessellated geometry. Supports two request shapes:

**Full send** (first call, or after a resync):
```jsonc
{ "op": "rebuild", "id": "...", "document": { /* CadDocument */ }, "revision": 1,
  "tolerance": 0.1, "known": { "<bodyId>": "<etag>", ... } }
```

**Delta send** (the sidecar worker already holds a document from a prior full send):
```jsonc
{ "op": "rebuild", "id": "...", "baseRevision": 1, "revision": 2,
  "ops": {
    "length": 5,               // truncate/pad the held feature list to this length
    "set": [[2, { /* feature */ }], ...],  // [index, feature] pairs that changed
    "parameters": { /* optional, only when changed */ },
    "bodyVisibility": { /* optional, only when changed */ }
  },
  "tolerance": 0.1, "known": { "<bodyId>": "<etag>", ... } }
```

`tolerance` defaults to `0.1` server-side if omitted. `known` maps body id -> the etag
of the mesh payload the client already holds, for the per-body cache described below.

Reply `result` is one of:

- **Resync needed** - the worker doesn't hold a document at `baseRevision` (first
  connection, worker respawn, or a missed message): `{ "resync": true }`. The client
  must retry with a full send.
- **Nothing built yet** (e.g. only sketches, no solid): `{ "protocol": 2, "bodies": [], "bbox": null }`.
- **Built** (protocol v2, per-body payloads - see below):
  ```jsonc
  {
    "protocol": 2,
    "bodies": [ /* one entry per live body, full payload or "unchanged" stub */ ],
    "bbox": { "min": [x,y,z], "max": [x,y,z] },
    "diagnostics": [ /* optional: low-confidence selector resolutions */ ],
    "featureError": { "message": "...", "feature_id": "..." },   // optional
    "featureErrors": [ { "message": "...", "feature_id": "..." }, ... ]  // optional
  }
  ```
  `featureError`/`featureErrors` are present only when one or more features failed and
  were recorded as no-ops; the geometry that *did* build is still returned (a failing
  feature never blanks the whole model). `featureError` is the most-downstream failure,
  for a single-line banner; `featureErrors` carries all of them.
- **Fatal** - nothing built at all: `{ "error": { "message": "...", "feature_id": "..." } }`.
- **Stalled worker** - one operation ran past the stall timeout (60 s of no build
  progress): the sidecar kills and respawns the geometry worker and returns
  `{ "error": { "message": "one operation stalled for over N s - the geometry kernel was restarted; progress up to the last checkpoint is kept" } }`.
- **Crashed worker**: `{ "error": { "message": "the geometry kernel crashed on this operation" } }`.

#### Per-body payload (protocol v2)

Each entry in `bodies` is either an **unchanged stub**:
```jsonc
{ "id": "b1", "name": "Body1", "etag": "3f9a...", "unchanged": true }
```
or a **full payload**, when the client's `known` etag for that body is stale or absent:
```jsonc
{
  "id": "b1", "name": "Body1", "etag": "3f9a...",
  "positions": [ /* flat float array, xyz per vertex */ ],
  "indices": [ /* flat triangle index array */ ],
  "faceIds": [ /* per-triangle face id, local to this body */ ],
  "faceOwners": [ /* per-face owner id or null, for feature highlighting */ ],
  "edges": [ { "points": [...], "body": "b1" }, ... ],
  "faceCount": 12
}
```
The client (`Geometry.assemble()` in `src/geometry/client.ts`) keeps the last full
payload per body id and merges stubs + full payloads into one flat mesh (vertex/index/
faceId offsets rebased per body), reproducing the pre-v2 single-mesh `RebuildReply`
shape for the rest of the app. If a stub's etag doesn't match anything the client is
holding (e.g. state lost across a worker respawn), `assemble()` returns `null` and the
client resyncs with one full request.

### `computeAll`

MCAD-style "Compute All": bypasses every cache layer (the sidecar's RAM prefix cache,
mesh cache, and disk checkpoints/blobs) before doing one cold full rebuild. Always a
full send, never a delta:

```jsonc
{ "op": "computeAll", "id": "...", "document": { /* CadDocument */ }, "revision": 2, "tolerance": 0.1 }
```

Reply shape is identical to `rebuild`'s built/fatal cases above (protocol v2, no
resync case since this is always a full send). Streams the same progress frames.

### `export`

Rebuilds (from the warm in-worker cache, not a cold rebuild) and writes one file.

```jsonc
{ "op": "export", "id": "...", "document": { /* CadDocument */ }, "format": "step" | "stl" | "3mf",
  "path": "/abs/path/out.step", "body": "<bodyId>", "separate": false }
```

`body` (export just one body) and `separate` (write every body to its own
`<base>-<name>.<ext>`) are optional. Reply:

```jsonc
{ "path": "/abs/path/out.step" }                 // default / single-body
{ "path": "...", "paths": ["...", "..."] }       // separate
{ "path": "...", "warnings": [{ "message": "...", "feature_id": "..." }] }  // some features failed but others built
```

Export is "export what built": a feature failure never blocks exporting the bodies that
did build; only zero live bodies is a hard `{ "error": {...} }`.

### `exportProject`

Rebuilds and writes an OrcaSlicer-format project 3MF (one object per body, palette slot
-> extruder mapping), via `sidecar/project3mf.py`.

```jsonc
{ "op": "exportProject", "id": "...", "document": { /* CadDocument */ },
  "path": "/abs/path/out.3mf",
  "palette": [ { "name": "...", "color": "#rrggbb", "material": "..." } ],
  "bodyColors": { "<bodyId>": 0 },
  "bodyNames": { "<bodyId>": "Bracket" },
  "settings": { /* written into the 3MF verbatim, capped at 256 KiB JSON */ } }
```

`palette`/`bodyColors`/`bodyNames`/`settings` are all optional (default to empty).
`settings` failing the size/type check replies `{ "error": { "message": "exportProject: bad settings" } }`
before any rebuild runs. Otherwise the reply matches `export`'s shape (`path` +
optional `warnings`).

### `interference`

Pairwise interference (clash) check among the document's live bodies.

```jsonc
{ "op": "interference", "id": "...", "document": { /* CadDocument */ } }
```

Reply:
```jsonc
{ "pairs": [
  { "a": "<bodyId>", "b": "<bodyId>", "aName": "...", "bName": "...",
    "volume": 12.34, "bbox": { "min": [x,y,z], "max": [x,y,z] } }
] }
```
One entry per pair whose boolean intersection volume exceeds a small epsilon. A cheap
bounding-box reject skips most pairs before the (crashable) boolean intersection runs.

### `import`

Reads an external geometry file (STL / 3MF / STEP / BREP) into an embeddable BREP
payload for an `import` feature. Path-based - the sidecar reads the file directly, the
frontend never ships file bytes over the socket.

```jsonc
{ "op": "import", "id": "...", "path": "/abs/path/in.step", "format": "step" }
```

Reply: `{ "brep": "...", "name": "...", "solid": true, "faces": [...] }` (the exact
fields the frontend embeds as an `import` feature), or `{ "error": { "message": "..." } }`.
Given a longer budget than a normal rebuild (mesh read + B-rep build can run longer).

### `ping`

Liveness check with no side effects: `{ "op": "ping", "id": "..." }` -> `{ "pong": true }`.

### Unknown op

Any other `op` value replies `{ "error": { "message": "unknown op: <op>" } }`.

## Progress frames

During a `rebuild` or `computeAll`, the sidecar sends interim frames on the same
connection, reusing the request's `id` but with **no `ok` field**:

```jsonc
{ "id": "<same id as the request>", "status": "building", "feature": 3 }
```

`feature` is the index of the feature currently being built, or `-1` while
tessellating. These fire roughly once a second during a long rebuild. A client must
route `status === "building"` frames to progress listeners and never treat one as the
terminal reply - the real `{ "ok": ... }` reply always follows once the rebuild
finishes (or the worker is judged stalled/crashed, per the `rebuild` error cases above).

## Bad input

Malformed JSON on the socket gets `{ "id": null, "ok": false, "error": { "message": "bad JSON: ..." } }`
(no request `id` to echo). Any exception raised while handling a request is caught and
turned into `{ "id": "...", "ok": false, "error": { "message": "<exception text>" } }`
rather than dropping the connection.
