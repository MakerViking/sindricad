# Performance and stability

The immediate priority is faster editing with the existing OCCT engine and its
worker-process isolation. Owning SindriCAD's geometry engine remains a long-term
ambition. Performance work should supply reusable workloads, measurements and
correctness checks for that future engine as well as improving today's app.

## Checkpoint selection — 2026-09-16

`rebuild_cached` previously consulted disk only when no RAM prefix matched. On
undo/redo, a short matching RAM prefix could therefore force replay of an expensive
suffix even though disk already held the complete target history.

The worker now checks for **strictly deeper** disk checkpoints. Equal-depth RAM
state wins; failed disk validation leaves the RAM prefix available. The existing
projection cap still applies to disk candidates, even when a prior quiet projection
pass lets RAM resume deeper. Read-only prefix queries do not replace the editing
cache.

A restored prefix is also captured as a normal RAM snapshot after sketch replay.
Previously, a disk hit at the document tip ran no new features and consequently
produced no RAM snapshot. Repeating that same request would read the BREP again and
replace shape identities, defeating the mesh cache.

### Measurement

Run from the repository root:

```sh
sidecar/.venv/bin/python sidecar/tools/bench_cache_history.py --runs 3
```

The fixture is a 100-feature plate with 49 through holes. Changing the radius of
hole 31 invalidates 38 features. Each run uses a fresh temporary disk cache and
executes the real `_rebuild_job` plus binary encoder. Geometry checks run outside
the timers and require the analytic volume, a valid solid, all 55 faces, no feature
errors and a complete face-owner array.

Three-run medians on an AMD Ryzen 9 7900X (24 logical CPUs), Python 3.12.13,
build123d 0.11.1, OCP 7.9.3.1:

| Phase | Before, worker ms | After, worker ms |
| --- | ---: | ---: |
| Cold rebuild | 1,337.923 | 1,274.126 |
| Unchanged request | 0.302 | 0.255 |
| First radius edit | 849.851 | 797.586 |
| Undo | 717.282 | 63.704 |
| Unchanged after undo | 0.303 | 0.220 |
| Redo | 722.399 | 65.338 |
| Unchanged after redo | 0.286 | 0.288 |

Undo/redo improved about 11 times on this workload. The smaller differences in
cold and first-edit times are not attributed to the change. Binary encoding was
measured separately; it is not included in the table. These are worker measurements,
not input-to-screen latency: startup, process transport and browser rendering are
excluded. Three repetitions do not establish tail-latency guarantees or performance
across all models. The improvement requires a usable deeper checkpoint.

As with other builder changes, the existing source-hash invalidation makes old
checkpoints miss after updating. A document may rebuild once before the new
checkpoints can deliver this benefit.

Regression coverage in `test_checkpoint.py` verifies the selected history,
geometric equivalence, face ownership, error/repair diagnostics, read-only behavior,
warm shape identity, and fallback for missing/corrupt/mismatched checkpoints.
`test_refresh.py` covers an actual deeper checkpoint competing with a pending
projection correction.

Validation passed: the checkpoint, projection-refresh, read-only projection-cache,
geometry-store, body-binding, export-gate, heartbeat and full geometry smoke suites.
Python compilation and `git diff --check` also passed. The new checkpoint test was
first run against the original implementation and failed on unnecessary feature
replay before the fix.

## Browser verification — 2026-09-17

`e2e/cache_history_perf.cjs` drives the same plate through the actual document
store, websocket client, worker and viewport. It creates unique feature IDs per
run to prevent earlier runs supplying cold-history checkpoints. It checks volume,
validity, watertightness, face count and face-owner coverage after **every** phase;
mass-property queries are read-only and outside the timers. No user files are
opened or saved. Use a separate sidecar with temporary caches, not a working app's
sidecar.

Example isolated stack, each command group in its own terminal:

```sh
# Terminal 1, from sidecar/
sindri_perf_cache=$(mktemp -d /tmp/sindri-browser-perf.XXXXXX)
XDG_CACHE_HOME="$sindri_perf_cache/cache" \
SINDRI_BLOB_DIR="$sindri_perf_cache/blobs" \
SINDRI_DISK_CACHE=1 SINDRI_SIDECAR_PORT=8797 \
SINDRI_SIDECAR_TOKEN=sindri-local-perf-test \
SINDRI_EXTRA_ORIGINS=http://127.0.0.1:5197 .venv/bin/python server.py

# Terminal 2, from repository root
SINDRI_VITE_PORT=5197 VITE_SINDRI_WS=ws://127.0.0.1:8797 npm run dev -- --host 127.0.0.1

# Terminal 3, from repository root
SC_TOKEN=sindri-local-perf-test SC_URL=http://127.0.0.1:5197 \
node e2e/cache_history_perf.cjs
```

The example token is only for this disposable loopback test. Stop the two servers
afterward. `SC_RUNS` defaults to 3; `SC_CHROME` overrides `/usr/bin/chromium`;
`SC_SCREENSHOT` optionally captures the final model. Chromium uses a temporary
profile with the welcome overlay disabled and SwiftShader software rendering.

Three-run medians on the same host, after the checkpoint fix:

| Phase | Rebuild API ms | Store + synchronous UI settled ms | Through two animation frames ms |
| --- | ---: | ---: | ---: |
| Cold rebuild | 1,474.7 | 1,535.5 | 1,569.5 |
| Unchanged request | 2.9 | 17.0 | 180.9 |
| First radius edit | 961.2 | 982.9 | 1,020.2 |
| Undo | 116.0 | 151.3 | 354.9 |
| Unchanged after undo | 3.0 | 16.3 | 175.1 |
| Redo | 117.5 | 141.7 | 311.1 |
| Unchanged after redo | 2.5 | 15.5 | 175.3 |

The rebuild API timer includes worker handoff, geometry, transport, decoding,
assembly and progressive viewport callbacks. It is **not** a pure IPC timer.
Settled time starts at the store action and ends after synchronous build listeners;
it excludes physical input dispatch. The two-frame timer allows rendering but does
not establish physical screen presentation. Software-rendered frame costs cannot
be treated as desktop GPU performance. These browser numbers are an after-only
baseline, not a browser before/after speedup claim.

On this workload, unchanged requests complete in about 3 ms without a fixed
messaging delay. First edits still dominate and should be profiled next. This does
not establish transport cost for large assemblies or justify removing worker
isolation. No scheduling, debounce or rendering-quality changes were made.

All browser geometry checks passed and the final model was visually inspected.
The production frontend build passed (with bundler warnings); Vitest passed
151 files / 2,093 tests, with one skipped test. These supplement the sidecar suites
listed above, not replace them.

## Boolean validity checks — 2026-09-18

The first-edit profile on the same 100-feature plate attributed 603 ms of a
786 ms worker request to the 19 replayed cut booleans. Sketch handlers accounted
for 28 ms, provenance for 41 ms and the changed body's payload for 104 ms. The
categories overlap where one wraps another; they are attribution, not values to
add together.

Separate instrumentation inside the boolean path showed the 19 raw-result validity checks cost 152 ms and the
19 cleaned-result checks another 151 ms. The actual OCCT cuts cost 162 ms and
same-domain cleanup cost 26 ms. `_serial_bool` previously evaluated this rule:

```text
valid raw AND invalid cleanup -> keep raw; otherwise keep cleanup
```

A valid cleanup is selected regardless of raw validity. The implementation now
checks cleanup first and consults raw only when cleanup is invalid or its
analysis raises an exception. Its decision table and cleanup-analysis exception
fallback are regression-tested: a valid
raw result still rescues broken cleanup, while an already-invalid raw result
still keeps cleanup. Mesh settings, boolean settings and the validity standard
are unchanged.

Five-run worker medians before and after this change:

| Phase | Before, ms | After, ms | Change |
| --- | ---: | ---: | ---: |
| Cold rebuild | 1,319.795 | 1,060.752 | -19.6% |
| First radius edit | 811.941 | 668.864 | -17.6% |
| Undo | 63.969 | 65.455 | noise |
| Redo | 64.577 | 64.443 | noise |

Every timed phase still checks analytic volume, solid validity, 55 faces and
complete face ownership. The saved-document golden corpus passed 13/13 after the
change. This is a win for successful booleans; it does not make the OCCT boolean
itself faster, and documents dominated by imports, blends or meshing should not
be expected to improve by these percentages.

Run the attribution mode with:

```sh
sidecar/.venv/bin/python sidecar/tools/bench_cache_history.py --runs 3 --profile
```

The profiler is opt-in and its nested categories overlap. Use uninstrumented
runs for before/after timing comparisons.

### Saved models and browser verification

Fresh-process, disk-cache-disabled A/B runs compared the old raw-first rule
with the new cleanup-first rule on saved documents. These measure geometry
rebuild only, excluding import, meshing and browser rendering:

| Document | Runs per variant | Before median, ms | After median, ms | Change |
| --- | ---: | ---: | ---: | ---: |
| Basket.sindri | 5 | 2,088.720 | 1,983.153 | -5.1% |
| src-tauri/1.sindri | 3 | 4,267.504 | 3,600.386 | -15.6% |
| src-tauri/test2.sindri | 5 | 355.549 | 339.658 | -4.5% |

Each document retained matching body and face counts, reported per-body volumes,
solid validity and feature errors. `1.sindri` still has its three existing
feature errors; this is not a claim that all documents rebuild without errors.
Its before samples also included a 6,129 ms outlier. These small samples establish
gains on these models, not a general speedup for all CAD work.

The three-run live-browser check on the plate passed all geometry assertions,
with no page errors, and the final model was visually inspected. Current medians
with software SwiftShader rendering were:

| Phase | Rebuild API, ms | Settled model, ms | Two animation frames, ms |
| --- | ---: | ---: | ---: |
| Cold rebuild | 1,280.3 | 1,316.4 | 1,341.4 |
| First radius edit | 829.5 | 854.0 | 888.7 |
| Undo | 122.1 | 152.1 | 367.4 |
| Redo | 118.0 | 149.1 | 319.4 |

The previous browser baseline above was collected separately, not as a matched
A/B run. Use the worker comparison for the measured percentage improvement;
software-rendered frame timing is not a hardware-GPU latency guarantee.

Validation for this change: focused cleanup-guard behavioral and integration
tests, the full sidecar smoke suite, the existing 13-document golden corpus,
and the live-browser geometry checks all passed. The earlier frontend test/build
results above belong to the checkpoint change; no frontend code changed here.

## Next measurements

1. Measure input-to-screen median and slow-case latency on brackets, long single-body
   histories, multi-body models, imported assemblies and textured parts. Separate
   cold open, early edits, late edits, undo/redo and interrupted-worker recovery.
2. Attribute slow requests to queueing, feature execution, selector/provenance work,
   disk restore, tessellation, edge extraction, encoding, transport and rendering.
   Do not infer those costs from the implementation language.
3. Improve the largest measured avoidable cost in small steps. Preserve shape
   validity, tolerances, downstream selections, diagnostics and export behavior.
   Measure memory as well as time; retain full-rebuild and crash-recovery paths.
4. Evaluate Rust/OCCT on matched operations and kernel versions if native execution
   targets a demonstrated bottleneck. Evaluate custom geometry algorithms against
   the same workloads when there is a concrete case for them.

These passes change cache selection, reuse and validity-check ordering. They do not change OCCT algorithms,
mesh quality, timeouts or the geometry worker's process isolation.
