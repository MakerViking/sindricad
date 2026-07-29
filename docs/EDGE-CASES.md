# Edge-case sweep — geometry sidecar

Findings from a systematic sweep of degenerate and boundary-condition documents
driven straight at `builder.rebuild()`, 2026-07-29. **Every defect below is fixed
unless marked OPEN.**

**Harness:** `sidecar/tools/sweep_cases.py` (case definitions) +
`sidecar/tools/sweep_run.py` (runner). Each case runs in its OWN SUBPROCESS,
because the failure mode that matters most — an OCCT segfault — kills the
interpreter and would otherwise end the sweep at the first crash. Exit 139 is
recorded as a result, not an accident.

```
cd sidecar && python3 tools/sweep_run.py . 90      # results -> /tmp/sweep-results.json
```

44 cases. Before: 22 built / 22 errored. After: 19 built / 25 errored — the three
that moved were **silent failures that now speak up**. No segfaults, no timeouts.

Scope caveat: this drives the sidecar directly. It does not exercise the
frontend, so sketch solving (planegcs), region detection, selector minting and
every UI gesture are OUT of scope here and remain covered only by vitest and by
hand.

---

## 1. A zero-radius circle reported "wires not planar" — FIXED

Root cause of a field bug seen on 2026-07-29, where a ring sketch failed with
`Cannot build face(s): wires not planar` and the geometry looked perfectly flat.

| circle radius | before |
|---|---|
| exactly `0` | `Cannot build face(s): wires not planar` |
| `1e-9` | builds a solid |
| `0.0001` | builds a solid |

A zero-radius circle degenerates to a point, so build123d's `make_face` fails its
coplanarity probe (`build123d/topology/utils.py:229`) and reports the only thing
it checked — planarity. The wire is not non-planar; it is not a wire. Reproduced
with a normal outer circle plus a zero-radius inner one: a ring whose inner circle
had collapsed, which is what the user actually hit.

**Fix:** `_build_sketch` rejects degenerate primitives by name before the face
builder runs — *"a circle in this sketch has a radius of 0 — give it a radius
greater than 0, or delete it"*. Zero-size rectangles too.

**OPEN:** `r=1e-9` still builds a solid. That is below OCCT's linear tolerance
(1e-7 m) and the resulting geometry is not trustworthy. Left alone deliberately —
picking a minimum-feature threshold is a product decision, not a bug fix.

## 2. Raw OCCT exception class names reached the user — FIXED

Nine operations surfaced an internal exception type as the whole explanation.
`Standard_DomainError` tells a user nothing about a box with zero height.

| case | before | now |
|---|---|---|
| box, zero/negative dim | `box failed (Standard_DomainError)` | `Box: height must be greater than 0 (got 0)` |
| cylinder, negative radius | `cylinder failed (Standard_ConstructionError)` | `Cylinder: radius must be greater than 0 (got -5)` |
| shell, zero thickness | `shell failed (RuntimeError)` | `Shell: thickness must not be 0` |
| shell, wall ≥ body | `shell failed (RuntimeError)` | `Shell failed with a wall of 30mm — usually thicker than the body's narrowest span` |
| extrude, zero distance | `extrude failed (Standard_ConstructionError)` | `Extrude: distance must not be 0` |
| scale, factor 0 | `scale failed (Standard_ConstructionError)` | `Scale: factor must not be 0 — it would collapse the body to a point` |
| revolve, profile crosses axis | `revolve failed (StdFail_NotDone)` | `Revolve failed — the profile probably crosses the axis of revolution (Z)` |
| draft, ≥90° | `draft failed (Standard_ConstructionError)` | `Draft: angle must be between -90 and 90 degrees (got 90)` |
| fillet/chamfer, size ≤ 0 | `Failed creating a fillet with radius of 0, try a smaller value` | `Fillet: size must be greater than 0 (got 0)` |

The fillet case was the worst of these: OCCT advised "try a smaller value" for a
radius of `0` and `-3`.

Where the failure genuinely depends on geometry rather than the input (shell wall
too thick, revolve profile crossing the axis) the OCCT exception type is kept in
brackets at the end, so the message helps a user without hiding evidence.

## 3. A self-subtracting `combine` left a zero-volume phantom body — FIXED

`combine` with `operation: "cut"` over two identical coincident boxes returned
**one body of volume 0.0 and no error**. The browser tree gained a body that is
not there, and nothing said the operation had annihilated its own input.

`_do_combine` already guarded the mirror-image case (a Cut that removes *nothing*)
but not a Cut that removes *everything*. It now raises
*"Combine (Cut) would remove the whole target body — the tools cover all of it."*

## 4. Silent successes

Fixed, because the feature reported success having done nothing:

- **`revolve` with `angle: 0`** → `Revolve: angle must not be 0 — nothing would be swept`
- **`patternRect`/`patternCircular` with `count: 0`** → `Pattern: countX must be greater than 0 (got 0)`

**OPEN, deliberately.** These are judgement calls, listed so the decision is
conscious rather than accidental:

- **`split` by a plane that misses the body** — silently no-ops. Matches how
  mainstream MCAD behaves; arguably fine.
- **Self-intersecting sketch profile** (figure-eight) — extrudes without comment.
  Detecting this cheaply is not obvious, and OCCT produces *a* result.
- **`revolve` with `angle: 720`** — accepts a self-overlapping sweep.
- **`scale` with a negative factor** — mirrors through the origin. Probably
  intended; noted in case it is not.

## 5. The press/pull segfault is input-specific, not general — MITIGATED

The `f7` crash in the user's `test4.sindri` (cut of −1.001mm or deeper on a
filleted face, exactly at a 1.0mm material boundary) did NOT generalise: synthetic
through-cuts and cuts landing on a fillet tangency all built cleanly. The trigger
is a narrower tangency condition than "cut through a fillet", so a general
pre-flight guard cannot be written from what is known today.

What works is the existing worker-pool isolation in `server.py` — the worker dies,
`BrokenProcessPool` recycles the pool, the server survives — plus naming the
feature that died and writing it to the log (below).

---

## Logging and observability

Working:

- **`<app_data>/sidecar.log`** — every sidecar stdout/stderr line, mirrored and
  truncated per launch, with a self-identifying header (version, OS, arch). Since
  `rebuild()` prints a full traceback for any non-`ValueError`, field failures
  carry their traceback.
- **The bug reporter** (🐞) sends the last 100 kB of that log to
  `POST {BASE}/api/desktop/bug-report`, with user paths redacted in Rust first.
  Signed-out reports go anonymously. The current document is attached ONLY if the
  user ticks the box (off by default).
- **Worker-crash attribution** — an OCCT segfault leaves no traceback, so the
  crash branch reads the `_HB_IDX` heartbeat (the index of the feature the worker
  was building) and names that feature. Previously the app showed
  `: the geometry kernel crashed on this operation`, naming nothing.
- **Upstream-failure attribution** — a failed sketch yields *"the sketch this
  extrude depends on (f1) did not build"* instead of `extrude failed (KeyError)`,
  which pointed at the wrong feature. Same for revolve.

### FIXED: sticky breadcrumbs were truncated away before upload

`breadcrumbs.ts` keeps "sticky facts" (the HID device inventory) OUTSIDE the
20-slot ring so a startup capture survives later activity — but
`tinkeratlas.rs` then did `.rev().take(20).rev()`, keeping the LAST 20. Sticky
facts are PREPENDED, so they were dropped as soon as the session got busy: the
mechanism was defeated one layer down, costing the privacy exposure of collecting
the inventory while delivering none of its diagnostic value.

Now `trim_breadcrumbs()` keeps every sticky fact (bounded at 24) plus the last 20
ordinary crumbs. The discriminator is `crumb()`'s `"HH:MM:SS "` prefix, which
sticky facts never carry — a **contract documented in both files**. Three Rust
tests pin it, including that a sticky fact survives 60 subsequent crumbs.

### FIXED: a worker crash never reached the log

Crash attribution went only into the WebSocket reply, so `sidecar.log` — the file
the bug reporter actually uploads — held no record that a worker had segfaulted.
The evidence lived solely in a toast the user had probably dismissed. It is now
printed to stderr as `[crash] worker died building feature <id> (<type>) at index
<n>: <feature json>`, so the failing input travels with the report.

### OPEN: no OCCT-level diagnostics

A segfault inside `OCP...so` leaves nothing of its own. Today's crash was only
identifiable via `coredumpctl` on the developer's machine (`SIGSEGV`,
`SEGV_MAPERR`, faulting frames in `OCP.cpython-312-x86_64-linux-gnu.so`). No field
report will carry that. The `[crash]` line above now records the feature and its
parameters, which is the actionable half; the native stack is not recoverable
without shipping a crash handler.
