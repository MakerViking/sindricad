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
{ "id": "<matching id>", "ok": false,
  "error": { "message": "...", "feature_id": "..." /* optional */,
             "code": "ambiguousReference" /* optional */ } }
```

`rebuild` and `computeAll` additionally stream **non-terminal progress frames** with no
`ok` field - see "Progress frames" below; a client must not resolve a pending call on
one of those.

### Error codes

`code` is an optional machine-readable classification beside the prose. Prefer it over
matching on `message`, which is free to be reworded. It appears on the error object, on
`featureError`/`featureErrors` entries (a feature can fail inside an `ok: true` rebuild),
and on `ResolveDiag` entries.

| code | meaning |
|---|---|
| `ambiguousReference` | a selector matched several candidates and refused to guess |
| `referenceNotFound` | a selector matched nothing |
| `cancelled` | the user cancelled; rides beside the `cancelled: true` sibling |
| `timedOut` | a hard wall-clock job timeout |
| `stalled` | no worker heartbeat; the kernel was restarted |
| `kernelCrashed` | the geometry worker died |
| `engineUnavailable` | the worker pool could not be started |
| `replyTooLarge` / `bodyTooLarge` | the whole reply, or one body, exceeded the frame cap |
| `unknownOp` | no such op — this is the capability-probe answer |
| `badRequest` | malformed or oversized input, refused before any work |

**Treat an unrecognised code as unclassified, never as an error.** The set only grows, and
a newer sidecar may emit one this client has not heard of. Codes are added freely; renaming
or removing one is a breaking change.

Not every failure carries a code. An absent `code` means "unclassified", not "fine".

**A trap on the chunked path:** `featureError`, `featureErrors` and `diagnostics` ride in
frame 0 of a chunked reply, which carries `"status": "chunk"` and **no `ok` field** — so a
code can arrive on a frame that is neither a success nor a failure.

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
    "diagnostics": [ /* selector resolutions worth reporting; see below */ ],
    "featureError": { "message": "...", "feature_id": "..." },   // optional
    "featureErrors": [ { "message": "...", "feature_id": "..." }, ... ]  // optional
  }
  ```
  `featureError`/`featureErrors` are present only when one or more features failed and
  were recorded as no-ops; the geometry that *did* build is still returned (a failing
  feature never blanks the whole model). `featureError` is the most-downstream failure,
  for a single-line banner; `featureErrors` carries all of them.

  `diagnostics` is omitted when empty, but when present it is **complete for the whole
  document** — an incrementally-resumed rebuild replays the diagnostics of its cached
  prefix rather than reporting only the features it re-ran. Clients may rely on that:
  the "Re-pick face" repair is offered only when the build carries an `ambiguous
  nearest pick` entry, so a partial array would silently withdraw a repair path on
  exactly the documents that need it. (Before 0.1.70 the array *was* partial — a
  resumed build re-reported every error with zero diagnostics.)
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

### `massProperties`

Exact kernel mass properties per body plus a document total. **Not the same numbers the
viewport can derive:** the display tessellation is exact on planar bodies and under-reports
every curved one — measured at −0.97% on a cylinder and −1.43% on a sphere.

```jsonc
{ "op": "massProperties", "id": "...",
  "document": { /* CadDocument */ },
  "bodies": ["body1"],   // optional; omitted = every live body
  "checks": true,        // optional, default false
  "prefix": true }       // optional, default false — see below
```

Reply:
```jsonc
{ "units": "mm", "counting": "build123d", "bboxSource": "mesh",
  "bodies": [
    { "id": "body1", "name": "Sphere", "measured": true,
      "volume": 4188.79, "area": 1256.64, "com": [0,0,0],
      "bbox": { "min": [x,y,z], "max": [x,y,z] },
      "counts": { "solids":1, "shells":1, "faces":1, "edges":1, "vertices":2 },
      "valid": true, "watertight": true },        // ONLY when checks:true
    { "id": "body4", "measured": false, "reason": "no solid" }
  ],
  "total": { "bodies": 1, "volume": 0, "area": 0, "com": null, "bbox": null, "counts": {} },
  "unknown": ["bodyNope"],   // requested ids that matched nothing — reported, not fatal
  "warnings": [ { "message": "...", "feature_id": "...", "code": "..." } ] }
```

Things that are **not guessable** and that change what the numbers mean:

- **An unmeasurable body carries no numeric fields at all**, not zeros. `reason` is one of
  `feature failed`, `empty`, `no solid`, `open shell`. Absent and zero are different answers.
- `open shell` means the body IS a solid by topology but no shell of it closes, so there is
  no volume to integrate. It is reported rather than measured because the alternative was a
  fabricated `volume: 0.0` with a centre of mass outside the body's own bounding box — the
  volume integration skips non-closed shells, leaving the centre at its untouched reference
  point, the origin. Common on imported STEP; such a body's surface **area** is real but is
  not reported, because a partially-numeric record is worse than an honest refusal.
- `total.bodies` counts only the bodies that were **measured**, so it can be lower than
  the number asked about.
- `total.com` is **null** when the total volume is zero — there is nothing to weight the
  mean by. It is a volume-weighted mean, not an average of the per-body centres.
- A per-body `bbox` is **null** when the body has no publishable extent: no triangulation,
  or unbounded geometry. Such bodies are left out of the `total.bbox` union rather than
  dragging it to OCCT's 1e100.
- `counting: "build123d"` — counts follow what a **selector can address**, which excludes
  degenerate edges. A sphere is 1 face and 1 edge here; raw topology would say 3 edges.
- `bboxSource: "mesh"` — the box comes from the triangulation, so it is **conservative:
  never tighter than exact**, and it agrees with the rebuild's own bbox. It falls back to
  a looser box on a body with no triangulation in the current worker.
- `checks` also buys `watertight`, which is a computed answer (every face in a shell, no
  free edges), not the stored closed-flag — that flag goes stale on imported STEP.

A failed feature does not refuse the call: only a document where **nothing built at all**
is a hard error. Everything that did build is measured, and the failures appear in
`warnings`.

### `prefix` — on `massProperties` and `query`

Both ops rebuild the document to answer, and by default they leave that rebuild **cached**,
so the next call against the same model is nearly free. Set `"prefix": true` when the
`document` you are sending is a **truncated timeline** rather than the whole thing — say,
measuring the model as it stood at feature 12.

Caching a truncated document is what makes the *next* full rebuild slow: the cache would
then describe only the prefix, and a rebuild of the unchanged whole document resumes from
the cut point instead of the tip.

**Only you know which you are holding** — the sidecar receives a feature list either way and
cannot tell a prefix from a complete model. Getting this wrong is not corrupting; it costs
one slower rebuild.

Measured on a 3,066-body assembly: two consecutive queries with a cold cache took 45.2 s and
44.2 s (the first did not help the second). After the cache was warm, the same query took
0.31 s and then 0.10 s. **Note this does not speed up `massProperties` itself** — its ~86 s
is the measurement work, not the rebuild, and caching cannot touch that.

### `query`

Which faces or edges match a description. Returns references that can be **stored**: each
carries a `by:"match"` selector the caller can persist verbatim and re-resolve later.

```jsonc
{ "op": "query", "id": "...", "document": { /* CadDocument */ },
  "items": [ {
    "id": "q1",
    "kind": "face",                 // REQUIRED: "face" | "edge"
    "body": "body1",                // optional when the document has one body
    "sel": { /* Selector | Selector[] */ },   // optional: resolve first
    "where": { "surface": "plane", "area": { "min": 50, "max": 400 },
               "normal": { "dir": [0,0,1], "tol": 0.02 },
               "radius": { "min": 2, "max": 6 },
               "within": { "min": [-10,-10,0], "max": [10,10,20] },
               "createdBy": "f7" },
    // EDGE keys instead: curve | length | dir | radius | within
    "limit": 200, "expect": 4 } ],
  "prefix": false }               // optional — see `prefix` under massProperties
```

Reply:
```jsonc
{ "results": [
  { "index": 0, "id": "q1", "ok": true, "count": 6,
    "entities": [ { "body": "body1",
                    "sel": { "kind": "face", "by": "match", "fp": { /* ... */ } },
                    "createdBy": "f7" } ],
    "diagnostics": [] },
  { "index": 1, "id": "q2", "ok": false, "code": "expectFailed",
    "error": "expected exactly 4 faces, matched 6", "count": 6, "entities": [] }
] } }
```

- **`count` is the TRUE pre-limit total.** `count > entities.length` is itself the
  truncation signal; there is no separate flag.
- **`strict` (default TRUE) judges what a `by:"match"` selector resolved to.** That
  selector is a nearest-neighbour search that always returns its best candidate, so
  without this it cannot fail — a fingerprint for a 394 mm² face sent with the wrong body
  came back as a 14 mm² face 30 mm away, `ok:true`, `expect:1` satisfied. An implausible
  answer is now refused with `code:"matchImplausible"` and a `candidateFps` entry showing
  what it would have returned. Send `"strict": false` for the old behaviour.
- **Every result carries `match`**, on success too, so the judgement is legible either
  way: `{judged: true, dist, posRel, sizeRatio, classMismatch?, tied?, implausible?}`.
  `{judged: false}` means no identity was claimed — a `where`-only item, or
  `by:"normal"|"axis"|"all"`, which return a SET with an honest `count` and have no single
  entity to be wrong about. Under `strict: false` an implausible answer still reports
  `implausible`; it just is not acted on.
- The invariants are **scale-relative**, not a threshold on match cost: a wrong surface
  class, a centroid more than **2× the part's own bbox diagonal** away, a size differing by
  **10× on a match that ALSO moved**, or a tie that nothing disambiguated. The size rule is
  a conjunction on purpose — area is a squared quantity, so 10× area is only 3.16× linear
  (a rib going 2 mm → 7 mm), and judging size alone refused ordinary in-place resizes that
  had resolved perfectly. Cost is deliberately not used: over the frozen selector corpus,
  refusing above the resolver's `ACCEPT_MAX` would reject **79.4% of correct resolutions**,
  and the known-bad cases score *below* the median correct one.
- **`by:"ofFace"` and `by:"tangentChain"` are judged too**, on their INNER reference (the
  face whose edges are wanted, the seed edge of the chain), and report `match.via`. Without
  that, rewriting `by:"match"` as `by:"ofFace"` turned the gate off.
- **Known limits of the judgement, stated so you do not over-trust it:** it compares the
  fingerprint you sent against the one that came back, so it cannot see that a *better*
  candidate existed. A self-contradictory fingerprint — a centroid belonging to one face
  with the normal of another — resolves to a third face and passes with a clean `match`.
  `by:"nearest"` is not judged at all. And on a tie, `candidateFps` carries only the winner;
  the losing candidates are not enumerable at this layer.
- `where` keys combine as **AND**. `sel` is applied **before** `where`.
- **`normal` matches PLANAR faces only.** A single direction is meaningless on a curved
  face — a cylinder lying on its side reports "up" at one point of its surface, which is
  why a part whose text sits on a barrel cannot be found by any direction query at all.
- **`normal` tolerance: use `deg`.** `{"dir": [0,0,1], "deg": 5}` is a half-angle, which is
  what a caller almost always means. The older `{"tol": ...}` is a **cosine deviation**
  (`1 - dot`), not an angle: `deg 5` is `tol 0.0038`. Because `1 - dot` never exceeds 2, a
  degree-shaped `tol: 5` used to accept the ANTIPODAL face — "facing up" and "facing down"
  returned the same set. A `tol` above 1.0 is now refused with `badRequest` for that reason.
  Give one or the other, never both. Omitting both uses the resolver's tuned `ANG_TOL`
  (0.02, ~11.5°).
- **Combine `normal` with `area` on any part carrying text or texture.** Those features
  produce hundreds of tiny faces, and a bare direction query drowns in them. Measured on a
  real 158-face part: asking for upward planar faces returned **13, of which 11 were
  0.33–0.36 mm² glyph faces**. Adding `"area": {"min": 1.0}` cut it to 3, significant face
  first. This is not a defect in the predicate — it is what a model with text on it
  genuinely looks like. Note the 1661 mm² face in that example is the part's **cavity
  floor**, not its lettering: this filter makes a flooded part readable, it does not find
  text. (That part's text is on a cylinder, so no `normal` query reaches it.)
- **Two faces can legitimately share a direction.** On a hollowed part the outer rim and the
  inner cavity floor both face up, and no direction predicate separates them — a real limit,
  not a bug. Separate them by `area`, by `within` on the centroid, or by `createdBy` — but
  note `createdBy` is the LAST MODIFIER, so on a part edited after shelling the inner face
  belongs to that later feature, not to the shell.
- Edge `dir` is **sign-normalised**: `[0,0,1]` and `[0,0,-1]` select the same edges. It
  takes a bare vector and has no tolerance of its own.
- `createdBy` is **faces only** (refused for edges), and is **last-modifier, not creator** —
  any re-keyed face is attributed to the feature that last touched it.
- **Unknown predicate values are refused**, not answered with zero. `surface` and `curve`
  have closed alphabets (see above); `surface: "Plane"` is a `badRequest`, because
  `ok:true, count:0` would read as "no such face exists".
- **`diagnostics` is only as good as what the resolver chose to record**, and it is empty in
  two very different situations: a confident resolution, and a resolution nothing thought to
  question. For `by:"match"` in particular an empty `diagnostics` is NOT a guarantee that
  the right entity was found — that selector always returns its best candidate. A lossy
  match is passed through WITH its diagnostic rather than refused: this op is read-only
  inspection, so "this reference went ambiguous, show me the candidates" is a supported use.
  When a resolution IS refused, the diagnostics still ride along, carrying `candidateFps`
  to re-pick from.
- **One bad item never fails the call.** Indices stay aligned with the request.
- **`expect` takes an integer or an object.** `expect: 6` asserts the count.
  `expect: {count: 1, area: {min: 390, max: 410}}` asserts the count AND requires every
  returned entity to satisfy the remaining keys, which are ordinary `where` predicates.
  Prefer the object form for an identity claim: `expect: 1` against a `by:"match"` is a
  **tautology**, because that selector always resolves exactly one — it asserts cardinality
  and is silent about which entity you got. A miss returns `ok:false` with
  `code:"expectFailed"` and still reports what it found.
- Bounded: at most 64 items, `limit` at most 5000, and a **total of 5000 entities across
  the whole request** — per-item limits multiply, and this op replies on a path with no
  outbound frame-size guard. There is also a wall-clock budget; items that run past it
  return `code:"budgetExhausted"` with their partial results.

### `projectGeometry`

Projects 3D sources (body edges, face boundaries, cross-sketch curves, whole-body
silhouettes) onto a sketch plane. `document` is the frontend-truncated timeline **prefix**
for that sketch.

```jsonc
{ "op": "projectGeometry", "id": "...", "document": {...}, "plane": {...},
  "sources": [ /* ProjectedSource */ ] }
```

Reply: `{ "results": [ { "source_index": 0, "ok": true,
                         "curves": [ { "fp": {...}, "curve": {...} } ] } ] }`.
Per-source containment; resolution is **strict** (a missing body, a zero-edge or
low-confidence match is a per-source error, because this authors a persistent reference).
Read-only: it never disturbs the rebuild cache.

### `listFonts`

`{ "op": "listFonts", "id": "..." }` → `{ "families": ["DejaVu Sans", ...] }`. The sidecar
owns fonts so that preview outlines match the extruded solid exactly.

### `tessellateText`

Per-glyph 2D outlines for a sketch text entity, for preview.

```jsonc
{ "op": "tessellateText", "id": "...", "entity": {...}, "pathEntity": {...} }
```
Reply: `{ "faces": [ { "outer": [[x,y], ...], "holes": [[[x,y], ...]] } ] }`.

### `migrateGeometry`

One-way v4 → v5: turns a pre-container document's inline base64 BREP into blobs in the
durable store.

```jsonc
{ "op": "migrateGeometry", "id": "...", "items": [ { "id": "im", "brep": "..." } ] }
```
Reply: `{ "items": [ { "id": "im", "geom": "<content hash>" } ], "failed": [...] }`.
**Best-effort by design** — the document keeps its inline copy, so a failure costs nothing.

### `cancel`

`{ "op": "cancel", "id": "...", "target": "<request id>" }`. Answered on the read path, so
it is never queued behind the job it is cancelling.

Two replies are involved, and they are easy to confuse:

- **The cancel call itself** replies `ok: true` with
  `{ "cancelled": <bool> }` — whether it actually found a running job with that id. `false`
  is not an error; it usually means the job had already finished.
- **The cancelled op** replies `ok: false` with **both** `"cancelled": true` and
  `code: "cancelled"`. The boolean is a shipped contract and stays; the code rides beside it
  so a caller can branch on one vocabulary for everything.

**Cancelling kills the geometry worker**, and with it the rebuild cache and every memo. It
is the right thing for a long job the user genuinely wants stopped, and the wrong thing for
a cheap one — prefer dropping an unwanted reply over cancelling it.

### `ping`

Liveness check with no side effects: `{ "op": "ping", "id": "..." }` -> `{ "pong": true }`.

### Unknown op

Any other `op` value replies
`{ "error": { "message": "unknown op: <op>", "code": "unknownOp" } }`. This is the
capability probe: a client can ask for an op it is not sure the sidecar has and branch on
`unknownOp` rather than on message text.

## Selector fingerprints

`by:"match"` selectors carry a geometric fingerprint. `query` and `projectGeometry` author
them; a caller **stores them verbatim** and hands them back unchanged. They are not a
stable schema to reconstruct field by field — drop a field and the reference silently gets
weaker rather than failing.

**Edge:** `mid` (midpoint at curve parameter 0.5), `dir` (unit tangent, **sign-normalised**,
since edges are unoriented), `length`, `curve`, and for circles `radius`, `center`,
`radius_rank`, `radius_group`.

**`radius_rank` / `radius_group` are the load-bearing pair.** They give a circle's position
within the set of circles sharing its centre — rank in ascending-radius order, and how many
share that centre. They are what makes a concentric reference survive a **scale change**: a
tube's outer rim stays the outer rim. Without them the match falls back to absolute radius
and, on a resized model, resolves to the *inner* rim instead — a wrong reference written
into the document with no error anywhere. Never drop them when passing a fingerprint on.

**Face:** `centroid`, `normal` (unit, oriented), `area`, `surface`, and `radius` where the
surface has one.

## Progress frames

During a `rebuild` or `computeAll`, the sidecar sends interim frames on the same
connection, reusing the request's `id` but with **no `ok` field**:

```jsonc
{ "id": "<same id as the request>", "status": "building", "feature": 3 }
```

`feature` is the index of the feature currently being built, or `-1` while
tessellating. `meshed` / `meshTotal` carry the payload phase's per-body denominator
(both `-1` outside it), so a client can say "meshing 812/3071" rather than sitting at
0% for the whole phase. These fire roughly once a second during a long rebuild. An
`import` streams the same way with `status: "importing"` and `phase` / `label` / `pct`.

A client must route **any** frame carrying a `status` string to its progress listeners
and never treat one as the terminal reply - the real `{ "ok": ... }` reply always
follows once the rebuild finishes (or the worker is judged stalled/crashed, per the
`rebuild` error cases above). Guarding on `status === "building"` alone is a trap: an
unrecognised status then falls through to the pending-request map and resolves the
caller with a frame carrying no `ok`, so the caller reports failure while the sidecar
happily keeps working.

## Binary mesh frames (`"binary": true`)

`rebuild` and `computeAll` accept `"binary": true`, which moves the per-body mesh arrays
out of the JSON header and into raw little-endian buffers appended to the same frame:

```
[u32 LE header_len][header_len bytes UTF-8 JSON header][pad to 4][buf0][buf1]...
```

The header is the normal `{"id","ok","result"}` envelope, except each mesh array
(`positions`/`normals` → f32, `indices`/`faceIds` → u32) is replaced by `{"$buf": i}`
referencing `result.$buffers[i] = {"dtype","len"}` (`len` is an **element** count) in
on-wire order; the client walks `$buffers` to compute offsets sequentially. A body's
edge polylines are packed the same way into `{"$pts","$counts","body"}`, where `$counts`
holds each edge's **point** count. Everything else - stubs, `faceOwners`, `bbox`,
`diagnostics` - stays inline JSON in the header.

Both dtypes are 4 bytes/element, so after the single header pad every buffer is
4-aligned for free. **INVARIANT: adding a wider dtype requires per-buffer padding.**

## Chunked replies (`"chunked": true`)

A successful `rebuild`/`computeAll` mesh reply can exceed any single frame the socket
will carry (`_MAX_FRAME`, 128 MiB - a DoS control, mirrored in `client.ts` as
`MAX_MESSAGE_BYTES`). `"chunked": true` (which also requires `"binary": true`) splits
the reply across several frames instead, so document size stops being a hard limit.

Each chunk is a **self-contained binary frame** in exactly the layout above - its own
header, its own pad, its own `$buffers` table. Buffer indices are therefore **frame-local**
and each chunk decodes independently. The framing rides in one extra envelope field:

```jsonc
{ "id": "<request id>",
  "stream": { "sid": "<per-reply id>", "seq": 0, "final": false },
  "status": "chunk",          // NON-final frames only
  "ok": true,                 // the FINAL frame only
  "result": { /* ... */ } }
```

- **`seq: 0` (the head)** carries every non-body field (`protocol`, `bbox`,
  `diagnostics`, `projectionUpdates`, `featureError(s)`) plus a **`manifest`**: one entry
  per body of the reply, in final order, as `{id, name, etag, nodeRef?, unchanged?}` plus
  `{faceCount, nVerts3, nIdx, nTris, nEdges, hasNormals?}` **for full bodies only**.
  Sizes are absent on stubs by design - the sidecar does not have them, because those
  arrays live in the client's own per-body cache. The head carries no `bodies`.
- **`seq: 1..N`** each carry a contiguous slice of `bodies` (plus its `$buffers`), in
  manifest order. Order is load-bearing: the client accumulates each body's global
  `faceStart` by it, and face picking keys off those ranges.
- The **final** frame carries `ok: true` and `stream.final: true` and no `status`; it is
  what resolves the request.

A client must treat the stream as complete only when `final` is set, `seq` arrived dense
from 0, and the accumulated body count equals the manifest length. The count check is
load-bearing rather than defensive: `assemble()` prunes its per-body cache to the ids it
was handed, so silently accepting a short stream would evict the missing body and corrupt
the *next* rebuild's `known` map too.

Two invariants a client may rely on, neither of them local to the sending code:

- **Streams never interleave.** `_serialized` holds its lock across the whole of
  `_dispatch`, including every send.
- **No `building` frame lands mid-stream**, even though it shares the request `id`: the
  worker has already returned before the first chunk goes out.

Chunking is **binary-only**. There is deliberately no JSON-text chunk form: a text frame
carrying `status` is routed to progress listeners and dropped.

Negotiation is per request, exactly like `binary`. An older sidecar ignores the unknown
flag and answers with one frame; an older client never sets it and gets one frame. So
neither side can emit a stream the other cannot read. When the flag *is* set, every
successful mesh reply is streamed - not just large ones - so the multi-frame path is
exercised constantly rather than for the first time on a user's oversized assembly.

Two cases still end a reply with a terminal **text** error, which supersedes any partial
stream: a cancel arriving between chunks (`{"ok": false, "cancelled": true, ...}`), and a
**single body** whose own payload exceeds the frame cap - the one case chunking cannot
fix, since a body is the indivisible unit of a chunk. That error names the offending body.

## Bad input

Malformed JSON on the socket gets `{ "id": null, "ok": false, "error": { "message": "bad JSON: ..." } }`
(no request `id` to echo). Any exception raised while handling a request is caught and
turned into `{ "id": "...", "ok": false, "error": { "message": "<exception text>" } }`
rather than dropping the connection.
