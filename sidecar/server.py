"""SindriCAD geometry sidecar — WebSocket loop + dispatch.

Protocol: one JSON request/response per message, matched by `id`.
  rebuild -> tessellated mesh (+ per-tri faceIds) + edge polylines + bbox
  export  -> writes a STEP/STL/3MF file at the given path

Heavy geometry (rebuild + tessellate) runs in a separate worker **process**, not
on the asyncio event loop. Two reasons:
  * responsiveness — the socket keeps serving (pings, other connections) while a
    rebuild runs, instead of blocking the loop on a GIL-holding OCCT call;
  * robustness — OCCT lives in another process, so a kernel crash (segfault on a
    bad boolean) can't take the server down; the pool just respawns the worker.
ONE worker (max_workers=1), for reasons that are about correctness, not CPU
saturation: features form a serial dependency chain (no second rebuild can
usefully overlap), crash isolation needs a disposable process, and we use the
'spawn' start method because fork + OCCT's threads can deadlock. Meshing still
fans out across all cores per op (occt_smp.configure), but the boolean hot path
is deliberately SERIAL per-op (builder._serial_bool — parallel BOP measured
~5x slower on many-small-tool fuses), so idle cores during a long rebuild are
expected, not a lost opportunity (audited 2026-07-25: parallel body chains /
speculative tessellation refuted — see .fable/parallelism-audit-2026-07-25.md).

Lifecycle: on Linux we ask the kernel to SIGTERM us if our parent (the Tauri
shell) dies (PR_SET_PDEATHSIG), so we never orphan. We print `LISTENING <port>`
on stdout once bound, which the Rust shell waits for before opening the webview.
"""

import asyncio
import contextvars
import ctypes
import hashlib
import hmac
import json
import multiprocessing as mp
import os
import re
import secrets
import signal
import struct
import sys
import threading
import time
import traceback
import urllib.parse
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import numpy as np

import websockets

# Aliased: `errors` is used as a LOCAL name for feature-error lists all over this
# file (`part, errors, bodies = rebuild(...)`), so importing the module under its
# own name would be shadowed at almost every call site.
import errors as errors_mod

import occt_smp
import sysmem

HOST = "127.0.0.1"
# Env-overridable so a test/benchmark instance can run beside the app's own
# sidecar without stealing its port.
PORT = int(os.environ.get("SINDRI_SIDECAR_PORT", "8765"))

# Exit status for "could not bind the port". A contract with the Rust shell:
# src-tauri/src/sidecar.rs `describe_exit` turns it into a message that names the
# port instead of the useless "exit code 1". Do not reuse this code for anything else.
EXIT_PORT_IN_USE = 3

# WebSocket auth: every connection must carry the per-launch shared secret.
# Rust sets SINDRI_SIDECAR_TOKEN when it spawns us; a manual `python server.py`
# (no env) mints one and prints `TOKEN <t>` on stdout so a prober can read it
# and append ?token=. There is NO open mode — the token is always required,
# which is what keeps a foreign local process or a DNS-rebinding web page from
# driving export / import / rebuild against us.
_TOKEN: str | None = None

# Origins the Tauri webview legitimately connects from (prod custom-protocol
# origin on Linux/Windows + the vite devUrl). A browser-originated WS always
# sends Origin; a foreign origin is rejected even with a valid token. An absent
# Origin (a non-browser client like a Python prober) is allowed — the token
# alone gates it.
ALLOWED_ORIGINS = {
    "tauri://localhost",       # Linux (WebKitGTK) + macOS (WKWebView)
    "http://tauri.localhost",  # Windows WebView2 (useHttpsScheme off — the default)
    "https://tauri.localhost", # Windows WebView2 with useHttpsScheme on
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}
# Headless/browser e2e harnesses run vite on a side port; let the launcher
# (which already controls the token) extend the allowlist explicitly.
ALLOWED_ORIGINS |= {o for o in os.environ.get("SINDRI_EXTRA_ORIGINS", "").split(",") if o}

# Per-peer-IP concurrent-connection cap. The sidecar is bound to 127.0.0.1, so
# every connection shares that address and this is effectively a global cap on
# open sockets — it stops a runaway/leaky client (or a token holder stuck in a
# reconnect loop) from exhausting file descriptors. The legit webview holds 1–2.
MAX_CONNS_PER_IP = 8
_ip_conns: dict[str, int] = {}

# A single geometry op (rebuild/tessellate/export) must finish within this many
# seconds. OCCT can spin forever or segfault on degenerate input (e.g. a face
# offset that collapses a hole); the timeout + worker recycling turns that into a
# clean, recoverable error instead of a frozen app.
JOB_TIMEOUT = 25.0
# DOC_TIMEOUT (120 s) USED TO LIVE HERE, for the document-scaled ops that replay
# the whole feature history: export, exportProject, interference,
# projectGeometry. It is gone — those four are supervised by PROGRESS now (see
# STALL_TIMEOUT below), which is what the roomier budget was really reaching for.
#
# A wall clock could not tell a long build from a wedged one, and its failure was
# self-perpetuating: the timeout recycled the worker, which cleared the
# incremental cache, so every retry started cold and hit the same wall.
#
# Safe to move ONLY because the silent phases in those jobs are short. Measured
# on a 3,000-body assembly: the ticking rebuild is 10.2 s while the silent write
# is 2.8 s for a 48 MB STEP, 0.7 s for STL, and 0.1 s for a project 3MF. If a
# future format grows a write phase that can run past STALL_TIMEOUT without
# ticking, it needs ticks or its own stall= — not a return to wall clock.
#
# The `import` op keeps its own size-derived wall-clock budget on purpose: OCP
# holds the GIL for the whole of ReadFile+Transfer, so nothing can tick inside it
# and there is no progress to supervise.

# Import phase labels and their share of the wall clock, measured on the 356 MiB
# reference STEP: read+convert 90.6 s, canonicalize 93.9 s, encode 7.3 s.
# Mirrors builder.IMPORT_PHASE_* codes.
_IMPORT_PHASES = (
    ("Reading file", 0.47),
    ("Simplifying faces", 0.49),
    ("Packaging", 0.04),
)

# Per-request cancel token, bound to the dispatch task's context (see
# _serialized). _run/_run_stall consult it so a killed worker is reported as a
# cancellation rather than a crash.
_CANCEL: contextvars.ContextVar = contextvars.ContextVar("sindri_cancel", default=None)


def _cancelled_result():
    """The result shape for a cancelled op. `ok:false` keeps older clients
    treating it as a (harmless) failure; the `cancelled` flag lets a current one
    tell 'you stopped it' apart from 'it broke'."""
    return {"cancelled": True,
            "error": {"message": "cancelled", "code": errors_mod.CANCELLED}}
# Rebuilds are supervised by PROGRESS, not wall clock: the worker bumps a shared
# heartbeat once per feature (and per tessellated body), and the supervisor kills
# only when no progress is made for STALL_TIMEOUT — a legitimately long resumed
# build is never executed for merely being long, while one wedged OCCT call still
# gets reaped. Disk checkpoints make the kill a ratchet, not a restart.
STALL_TIMEOUT = 60.0

# the worker-process pool; set in main(). Heavy ops are dispatched here.
_pool: ProcessPoolExecutor | None = None
_mp_ctx = None  # the 'spawn' context, kept so we can rebuild the pool after a crash
_HB = None  # shared heartbeat counter (multiprocessing.Value), set in main()
_HB_IDX = None  # feature index the worker last started (Value 'q'; -1 = meshing/none)
# Meshing progress, deliberately a SEPARATE channel from _HB_IDX rather than more
# overloading of its -1 sentinel. The payload phase ticks per body, which kept the
# stall watchdog happy but published feature=-1 every time, so the timeline showed
# "meshing…" pinned at 0% for the whole phase — measured 136 s of it on the
# reference assembly, the largest single feel defect on the open path. The counts
# were always known here; only the wire to carry them was missing.
# Both are -1 when no meshing is in flight.
_HB_MESH = None       # bodies meshed so far (Value 'q')
_HB_MESH_TOTAL = None  # bodies to mesh in this pass (Value 'q')

# --- pool bring-up health --------------------------------------------------
# A worker that dies DURING startup is a different failure from one that
# segfaults on a user's shape: the first is deterministic (a broken install),
# the second is specific to one operation. Both raise BrokenProcessPool with the
# same private `_broken` string, so they are told apart by the warm-up future —
# see _worker_came_up. Without this split we recycled a pool that could never
# start, forever, while telling the user their model crashed the kernel.
MAX_INIT_ATTEMPTS = 2  # the original bring-up plus one retry for a real transient

_INIT_ERR = None  # shared buffer; the worker writes its startup traceback here
_WORKER_ERR_BUF = None  # worker-side handle on that buffer (set in _worker_init)
_pool_gen = -1  # bumped per pool; the idempotency key for one bring-up attempt
_warm = None  # (generation, Future) for the CURRENT pool's warm-up
_failed_gens: set = set()  # generations whose worker never finished _worker_init
_reaped_gens: set = set()  # generations WE killed (timeout/stall) — not init failures
_ever_came_up = False  # a worker started successfully at least once this session
_env_broken = False  # latched: the worker cannot start on this machine

_INIT_FAIL_MSG = (
    "the geometry engine could not start on this computer — this is an "
    "installation or environment problem, not a problem with your model. "
    'Please use "Report a bug" with the engine log included: the log now '
    "carries the exact error."
)


# --- worker process (separate interpreter) ---------------------------------


def _worker_init(hb=None, hb_idx=None, err_buf=None, mesh=None, mesh_total=None):
    """Runs once when a worker process starts: die with the server (anti-orphan),
    pin OCCT to all cores, and warm the heavy imports so the first real rebuild
    isn't paying build123d's import cost. `hb` is the shared heartbeat counter;
    the rebuild loop bumps it per feature so the supervisor can distinguish a
    long build (fine) from a wedged one (reap). `hb_idx` carries WHICH feature
    is being built (-1 = tessellation), so the supervisor can stream progress
    frames to the frontend during a long build.

    `err_buf` is shared memory used to hand a STARTUP traceback back to the
    server. It is needed because CPython catches an initializer's exception in
    the CHILD, logs it to the child's stderr and returns — and on Windows the
    spawned worker does not inherit the Rust-owned stderr pipe, so that log goes
    nowhere. That is why field bug 8aa9ded7 arrived with no evidence at all.
    Shared memory crosses the boundary on every platform."""
    try:
        _die_with_parent()  # SIGTERM the worker if the server process dies
        # Publish the handles we were given as worker-side globals: _warmup and
        # anything else running in this process needs the error buffer, and the
        # parent's _HB/_HB_IDX are set in main(), which never runs in a spawned
        # worker (so these are None here without this).
        global _WORKER_ERR_BUF, _HB, _HB_IDX, _HB_MESH, _HB_MESH_TOTAL
        _WORKER_ERR_BUF, _HB, _HB_IDX = err_buf, hb, hb_idx
        _HB_MESH, _HB_MESH_TOTAL = mesh, mesh_total
        occt_smp.configure()
        # MUST precede `import builder`, which pulls in build123d. build123d
        # scans the system font folders at import time and one unreadable file
        # there takes the whole import down with it — four Windows field reports
        # across 0.1.82/0.1.85/0.1.100, all "the geometry engine could not
        # start". Guarding HERE rather than inside builder.py is deliberate:
        # _env_sig hashes builder.py's bytes into the mesh-cache key, so editing
        # it would cost every user a cold rebuild of every document. This is the
        # pool initializer, so no geometry job can run without passing through.
        import font_guard

        font_guard.ensure()
        import builder  # noqa: F401  (warm the import)
        import tessellate  # noqa: F401

        # Warm the OCCT font subsystem (~1.6 s cold on the first glyph build) at startup so
        # the user's first sketch-text/tessellateText isn't laggy.
        try:
            builder._text_faces({"text": "A", "height": 1}, lambda x: x)
        except Exception:
            pass

        # Bound the disk cache, once per worker start and off the request path.
        # Nothing pruned it before: evict() reclaims by refcounting blob keys over
        # checkpoint manifests, and no manifest ever references a mesh key, so
        # meshes/ grew without bound — measured at 3.2 GB. The budget is sized
        # from FREE DISK (see Store.cache_budget), because $XDG_CACHE_HOME is the
        # user's home partition on most laptops; SINDRI_CACHE_MAX_GB overrides.
        # Meshes are evicted first and checkpoints only as a last resort, so a
        # normal-sized document never loses a checkpoint to this.
        try:
            import geomstore
            geomstore.default_store().evict_to_budget()
        except Exception:
            pass  # advisory maintenance must never stop a worker coming up

        if hb is not None:
            def _tick(i):
                hb.value += 1  # single writer (this worker); no lock needed
                if hb_idx is not None:
                    hb_idx.value = i

            builder.on_feature_tick = _tick
    except BaseException:
        _publish_init_error(err_buf)
        # MUST re-raise: this is what breaks the pool. Swallowing it would leave
        # a worker with no `builder` accepting jobs, which fails per-operation
        # and looks exactly like the bug this whole path exists to end.
        raise


def _publish_init_error(err_buf):
    """Write the current exception into the shared buffer, EXCEPTION LINE FIRST.

    Both this buffer and the log tail a bug report carries keep the HEAD of what
    they are given, while a traceback's actual error is its LAST line — so the
    one line worth having is written first and the frames follow."""
    if err_buf is None:
        return
    try:
        summary = "".join(traceback.format_exception_only(*sys.exc_info()[:2])).strip()
        text = f"{summary}\n{traceback.format_exc()}"
        # Array('c') raises at exactly len(), so stop one short.
        err_buf.value = text.encode("utf-8", "replace")[: len(err_buf) - 1]
    except Exception:
        pass


def _warmup():
    """Submitted at pool creation to force the (lazy) worker to spawn and run
    _worker_init now, rather than on the user's first rebuild.

    It builds real geometry rather than returning a constant, because importing
    OCP is NOT the same test as OCP working: a wheel built for a newer
    instruction set, or a mismatched/delay-loaded TBB or TKernel, imports fine
    and then faults on the first kernel call. Classified as an op-crash, that
    told the user their sketch was degenerate and to try a different value —
    on an install where nothing would ever build. A box and one boolean cost a
    few ms on an already-cold path and put that failure in the init bucket,
    where it gets the environment diagnosis and the retry bound."""
    try:
        import builder  # noqa: F401
        from build123d import Box, Location

        solid = Box(1, 1, 1)
        cut = Box(0.5, 0.5, 2).moved(Location((0.25, 0.25, 0)))
        result = solid - cut
        if result.volume <= 0:
            raise RuntimeError("geometry self-test produced an empty solid")
    except BaseException:
        # Same channel as an initializer failure: this IS a bring-up failure,
        # it just happens one step later than the import.
        _publish_init_error(_WORKER_ERR_BUF)
        raise
    return True


# Worker-global per-body mesh cache, validated by SHAPE OBJECT IDENTITY **and**
# tolerance: the cached entry holds a reference to the exact shape object it was
# computed from (which also keeps id() stable), so `entry["shape"] is body["shape"]`
# is a sound "nothing changed" test — snapshots share shape refs and every mutating
# feature rebinds the body's shape to a new object. Tolerance must also match: the
# same shape re-tessellated at a coarser/finer tolerance is a different payload, and
# shape identity alone would wrongly serve the wrong-resolution mesh. A hit skips
# BRepMesh readback, edge polylines, AND faceOwners fingerprinting for that body
# (the fixed ~1.4 s/edit).
_MESH_CACHE = {}

# Textured-face triangle budgets. Viewport stays interactive while scrubbing
# depth/scale; export gets much more headroom (per-face cap + a document-wide
# hard cap + a printable-sweet-spot warning, both applied in _export_job /
# _export_project_job below).
VIEWPORT_DENSITY_CAP = 80_000
EXPORT_DENSITY_CAP_PER_FACE = 200_000
EXPORT_TRIANGLE_HARD_CAP = 10_000_000
EXPORT_TRIANGLE_WARN = 500_000

# Below this, a mesh's tessellate+build cost doesn't recoup a disk write. An
# interactive param drag re-tessellates every tick with a brand-new content key
# (guaranteed cache miss on write AND on the next tick's read) — writing every
# such tick to disk is pure churn for a payload that will almost never be read
# back. Mirrors the checkpoint-tip debounce in builder.py's rebuild_cached
# (trivial warm edits don't spam the store; anything that cost real time is
# worth the write).
_MESH_PERSIST_MIN_MS = 50.0

# Export-grade tessellation (the 0.1 viewport default is visibly faceted on a
# printed part). Export meshes get their own cache, keyed exactly like the
# viewport one in _body_payload: RAM shape-identity + texture spec, then a disk
# artifact under meshKey + export tolerance — so re-exporting an unchanged
# document skips re-tessellating every body at 0.02mm.
_EXPORT_TOL = 0.02
_EXPORT_ANG_TOL = 0.3
_EXPORT_MESH_CACHE = {}  # body id -> {"shape", "texture_key", "positions", "indices"}


def _export_mesh(b, tol=None):
    """Export-grade (positions, indices) for one live body, three-tier cached
    (RAM identity -> disk artifact -> compute + persist), mirroring
    _body_payload. Worker-side only."""
    import pickle

    from tessellate import tessellate
    from texture import resolve_body_textures
    from builder import progress_tick

    # Unlike the viewport twin, this ticks on EVERY tier including a RAM hit,
    # not just the compute path: export walks every body in one uninterrupted
    # loop, so the guarantee worth having is one tick per body regardless of
    # which tier served it. A mixed warm/cold export is the common case.
    progress_tick()
    tol = _EXPORT_TOL if tol is None else tol
    bid, sh = b["id"], b["shape"]
    if b.get("_textures"):
        from texture import CODE_VERSION as _tex_ver
        texture_key = "v%d:%s" % (_tex_ver, json.dumps(b.get("_textures"), sort_keys=True))
    else:
        texture_key = None
    ent = _EXPORT_MESH_CACHE.get(bid)
    # TOLERANCE IS PART OF THE KEY. Without it a coarser retry (a tolerance
    # backoff after a triangle-budget refusal) would be handed the mesh from the
    # finer attempt still sitting in this cache — the backoff would appear to
    # succeed while changing nothing, and the export would blow the same budget
    # a second time with no way to tell why.
    if (ent is not None and ent["shape"] is sh
            and ent["texture_key"] == texture_key and ent["tol"] == tol):
        return ent["positions"], ent["indices"]
    # This body was last meshed at a DIFFERENT tolerance. OCCT keeps the
    # triangulation on the shape and considers an existing finer mesh adequate
    # for a coarser request, so without dropping it first the new tolerance is
    # silently ignored — which is what would make a backoff a no-op even with
    # the cache keyed correctly.
    retolerance = ent is not None and ent["shape"] is sh and ent.get("tol") != tol

    mesh_key = None
    if b.get("meshKey"):
        mesh_key = "%s-export-t%s" % (b["meshKey"], tol)
        if texture_key:
            mesh_key += "-x%s" % hashlib.sha1(texture_key.encode()).hexdigest()[:16]
    mesh = None
    if mesh_key:
        try:
            import geomstore
            raw = geomstore.default_store().get_mesh(mesh_key)
            if raw is not None:
                mesh = pickle.loads(raw)  # trusted local cache, worker-only
        except Exception:
            mesh = None
    if mesh is None:
        t0 = time.monotonic()
        textures = resolve_body_textures(b) if b.get("_textures") else None
        pos, idx, _fids = tessellate(
            sh, tolerance=tol, angular_tolerance=_EXPORT_ANG_TOL,
            textures=textures, density_cap=EXPORT_DENSITY_CAP_PER_FACE,
            force_remesh=retolerance,
        )
        mesh = (pos, idx)
        if mesh_key and (time.monotonic() - t0) * 1000.0 >= _MESH_PERSIST_MIN_MS:
            try:
                import geomstore
                geomstore.default_store().put_mesh(mesh_key, pickle.dumps(mesh, 5))
            except Exception:
                pass
    # Cached as NUMPY, not as the boxed Python lists tessellate returns.
    # Routing untextured stl/3mf through here means every export now populates
    # this cache, and it is only pruned of DELETED bodies — live ones are held
    # for the worker's lifetime. Measured for a 2M-triangle document: 96 MB of
    # positions + 217 MB of indices as lists, against 24 + 24 MB as float64/int32.
    # Lossless (float64 is the width tessellate produced; int32 covers 2.1e9
    # vertices), 6.5x smaller, and it removes the conversion each consumer was
    # doing anyway — on the very worker the rest of this branch defends from OOM.
    positions = np.asarray(mesh[0], dtype=np.float64)
    indices = np.asarray(mesh[1], dtype=np.int32)
    _EXPORT_MESH_CACHE[bid] = {
        "shape": sh, "texture_key": texture_key, "tol": tol,
        "positions": positions, "indices": indices,
    }
    return positions, indices


# Filenames Windows refuses outright, in ANY case and with or without an
# extension: CON.step is as invalid as CON. A body legitimately named "Con" or
# "Aux" is not exotic in mechanical CAD ("auxiliary bracket"), and the failure
# is an opaque OS error at write time on one platform only.
_WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}

# Filesystems cap a name in BYTES, not characters: ext4 and APFS both stop at
# 255 bytes. `\w` is Unicode-aware, so a CJK or emoji body name survives
# sanitising and then blows the limit at about a third of the character count.
_MAX_NAME_BYTES = 200  # flat reserve for the extension and a dedup suffix


def _safe_part_filename(label, fallback):
    """A filesystem-safe stem for one exported body.

    Refuses nothing and raises nothing: every input yields SOME usable name, so
    an awkwardly-named body can never block an export of the others.
    """
    name = re.sub(r"[^\w.-]+", "_", str(label)).strip("_")
    if not name or set(name) <= {"."}:  # empty or dot-only → no dotfiles
        name = str(fallback)
    # Byte budget, trimmed on a CHARACTER boundary so the result stays valid
    # UTF-8 — truncating the bytes directly can split a multi-byte codepoint.
    while len(name.encode("utf-8")) > _MAX_NAME_BYTES and len(name) > 1:
        name = name[:-1]
    name = name.rstrip("_.") or str(fallback)
    if name.split(".")[0].lower() in _WINDOWS_RESERVED:
        name = f"{name}_"
    return name


def _budget_refusal(ntri):
    """The refusal message past the triangle hard cap, or None while under it.

    ONE mechanism, because this had drifted into three: two raising sites and one
    returning an error dict, with the WARN threshold duplicated beside two of
    them and missing from the third — which is how exportProject came to have no
    budget at all. A new export format now cannot be added without it.

    Deliberately NOT worded "textured": since untextured stl/3mf was routed
    through this path too, the old message told someone exporting a plain
    3,000-body assembly to reduce a texture scale they were not using.
    """
    if ntri <= EXPORT_TRIANGLE_HARD_CAP:
        return None
    return (f"export too dense ({ntri:,}+ triangles) — reduce texture scale or "
            f"depth, or export fewer bodies")


def _budget_warning(ntri):
    """The non-blocking 'very dense' warning, or None. Same single-source reason."""
    if ntri <= EXPORT_TRIANGLE_WARN:
        return None
    return f"export is very dense ({ntri:,} triangles)"


def _prune_export_cache(live):
    """Drop export-cache entries for deleted/consumed bodies — a stale entry
    pins its OCCT shape in RAM for the worker's lifetime."""
    ids = {b["id"] for b in live}
    for k in list(_EXPORT_MESH_CACHE):
        if k not in ids:
            del _EXPORT_MESH_CACHE[k]

# Wire default (also the literal fallback in the "rebuild"/"computeAll" handlers
# below) — the reference point our size-adaptive scaling is relative to.
_DEFAULT_TOLERANCE = 0.1

# The interactive viewport meshes with OCCT's RELATIVE deflection: the chord
# tolerance is a fraction of each feature's own size rather than a fixed
# millimetre figure, so a 1mm fillet gets a proportionally finer mesh than the
# 60mm face it sits on — which is exactly where faceting is visible.
#
# EXPORTS DELIBERATELY STAY ABSOLUTE (_EXPORT_TOL above): a 3MF/STL for printing
# needs a deterministic chord error in millimetres, not one that scales with the
# part. That's why `relative` is a per-call argument on tessellate() and not a
# module-level switch.
#
# 0.001 was picked by measuring the user's reported part (a 60mm ring, 5mm tall,
# 1mm fillet) plus a 6mm cube, a 400mm plate and a sphere:
#   * ring fillet surface deviation 0.152mm -> 0.080mm (-48%) for +22% triangles
#     (6532 -> 7992) and +5ms. At MATCHED cost, absolute is worse: 0.03mm
#     absolute gives 8472 triangles at 0.098mm — more triangles, coarser fillet.
#   * 400mm plate: the 60mm hole goes 0.096mm -> 0.053mm while triangles go
#     164 -> 216. Big parts get better AND stay cheap.
#   * 6mm cube (0.5mm fillets): 628 -> 7428 triangles, 2.5 -> 12.0ms, fillet
#     deviation 0.022mm -> 0.006mm. A 12x ratio, but a trivial absolute cost —
#     and that convergence is the POINT of relative deflection: triangle count
#     tracks feature complexity instead of part size.
#   * bare sphere is the worst case (4002 -> 10108 triangles, 17 -> 55ms); a
#     single all-curvature body is pathological and still well inside the
#     stall supervisor's budget.
_VIEWPORT_RELATIVE = True
_DEFAULT_RELATIVE_DEFLECTION = 0.002
# OCCT's ANGULAR deflection is what actually governs how faceted a fillet LOOKS:
# it caps the turn between adjacent facets. The old 0.5 rad (28.6 degrees) let
# the worst adjacent-facet angle on a 1mm fillet reach 47 degrees — visible
# banding across the fillet band no matter how fine the linear term got (the
# tessellation is anisotropic: plenty of divisions AROUND a ring, almost none
# ACROSS the fillet, and only the angular term adds those).
#
# Measured on a 60mm ring with a 1mm fillet, worst adjacent-facet angle /
# whole-shape triangles / mesh time:
#     lin 0.001 ang 0.50   47.38deg    7992 tris    7.9ms   <- old
#     lin 0.001 ang 0.20   45.96deg   20284 tris   22.8ms
#     lin 0.002 ang 0.18    5.14deg   10640 tris   11.0ms   <- chosen
#     lin 0.002 ang 0.15    4.29deg   14784 tris   16.7ms
#     lin 0.001 ang 0.10    2.86deg   33264 tris   47.9ms
# 0.18 sits just past a sharp quality cliff (0.20 -> 0.18 drops 46deg to 5deg)
# and buys a 9x smoother fillet for +33% triangles. Note the linear term must
# NOT be over-tightened: lin 0.001 + ang 0.18 measures 45.96deg, WORSE than
# lin 0.002 at the same angle — finer linear subdivision changes which
# criterion OCCT applies. Re-measure this table before touching either number.
_VIEWPORT_ANG_TOL = 0.18

# DOCUMENT-SIZE tolerance profile. A large assembly's rebuild reply has to fit
# the 128 MiB websocket frame cap (a security control — see MAX_FRAME), and at
# shipping quality it does not: measured on the 356 MiB reference assembly
# (3,071 bodies), 0.002/0.18 yields 9,943,003 triangles and a 263.3 MiB reply
# even after edge packing. 0.008/0.35 yields 3,809,240 and 121.1 MiB.
#
# The LINEAR term alone cannot do this — 4x coarser cut only 13% of the
# triangles, because the angular term is what binds. Re-measured on the same
# 60mm ring + 1mm fillet the block above uses, worst adjacent-facet angle:
#     lin 0.002 ang 0.18    5.14deg   10,640 tris   <- shipping
#     lin 0.004 ang 0.26    7.35deg    5,488 tris
#     lin 0.008 ang 0.35   10.04deg    2,880 tris   <- large-document tier
# Note the block above's 45.96deg row is lin 0.001, NOT 0.002; coarsening the
# ANGULAR term from 0.18 to 0.35 costs 5.14 -> 10.04deg, not the 47deg that
# table reads as implying. Still a real regression, so it applies only where it
# buys something: a document small enough to fit keeps full quality.
#
# Thresholds are anchored on the measured ~86 KiB/body of that assembly at
# shipping quality (128 MiB / 86 KiB ~= 1,500 bodies). Body count is a PROXY —
# bodies vary enormously in face count — so _rebuild_job also guards the encoded
# reply against the cap rather than trusting this to be right.
_VIEWPORT_SIZE_TIERS = (
    # (bodies at or above, linear scale on _DEFAULT_RELATIVE_DEFLECTION, angular)
    (2200, 4.0, 0.35),
    (1200, 2.0, 0.26),
)


def _viewport_profile(n_bodies):
    """(linear scale, angular tolerance) for a document of `n_bodies` bodies."""
    for threshold, scale, ang in _VIEWPORT_SIZE_TIERS:
        if n_bodies >= threshold:
            return scale, ang
    return 1.0, _VIEWPORT_ANG_TOL


def _effective_tolerance(shape, requested, size_scale=1.0):
    """Map the requested (interactive-viewport) wire tolerance to the value we
    actually hand BRepMesh, in the units the viewport's meshing mode expects.

    RELATIVE mode (_VIEWPORT_RELATIVE, the default): OCCT sizes the deflection
    per feature itself, so there is NO bbox term here — applying our own size
    scaling on top would double-count the very adaptivity we just delegated.

        effective = _DEFAULT_RELATIVE_DEFLECTION * (requested / DEFAULT_TOLERANCE)

    ABSOLUTE mode: scale the requested tolerance to this body's size, so a 500mm
    frame doesn't pay for a triangle budget tuned for a 5mm part and a 5mm part
    isn't left visibly faceted by a tolerance tuned for the frame.

        effective = clamp(diag / 2500, 0.05, 0.8) * (requested / DEFAULT_TOLERANCE)

    `diag` is the body's bounding-box diagonal (cheap OCCT bbox, no meshing).
    Dividing by 2500 makes a ~250mm-diagonal part (roughly the part the fixed
    0.1mm default was tuned for) land back on 0.1mm; the clamp keeps a 10mm
    bracket from going arbitrarily fine (0.05mm floor) and a multi-metre frame
    from going arbitrarily coarse (0.8mm ceiling).

    Either way the `requested / DEFAULT` factor keeps the wire contract intact: a
    client that asks for a smaller tolerance than the default still gets a
    proportionally finer mesh for every body. Deterministic — a pure function of
    (bbox, requested, size_scale) — so cache keys built from the result stay
    stable.

    `size_scale` is the document-size coarsening from _viewport_profile: 1.0 for
    a document that fits the frame cap at full quality, higher for one that does
    not. It multiplies the deflection in BOTH modes."""
    scale = (requested / _DEFAULT_TOLERANCE if _DEFAULT_TOLERANCE else 1.0) * size_scale
    if _VIEWPORT_RELATIVE:
        return _DEFAULT_RELATIVE_DEFLECTION * scale

    from tessellate import bbox

    bb = bbox(shape)
    dx = bb["max"][0] - bb["min"][0]
    dy = bb["max"][1] - bb["min"][1]
    dz = bb["max"][2] - bb["min"][2]
    diag = (dx * dx + dy * dy + dz * dz) ** 0.5
    base = min(max(diag / 2500.0, 0.05), 0.8)
    return base * scale


def _union_bbox(boxes):
    """Union of {"min":[x,y,z],"max":[...]} boxes, or None if there are none.

    This replaces a single bbox(merged_compound) call. That call was ONE OCCT
    walk over every solid with no way to tick inside it — measured 95.3 s on the
    356 MiB reference assembly against STALL_TIMEOUT = 60 s, so the supervisor
    reaped the worker before the rebuild could finish, every time. The union is
    exactly equivalent (`part` is the Compound of the same shapes) but is
    accumulated per body, where _body_payload's own progress tick covers it."""
    present = [bb for bb in boxes if bb is not None]
    if not present:
        return None
    return {
        "min": [min(bb["min"][i] for bb in present) for i in range(3)],
        "max": [max(bb["max"][i] for bb in present) for i in range(3)],
    }


def _set_mesh_progress(done, total):
    """Publish "meshed `done` of `total` bodies" to the supervisor, or (-1, -1)
    to say no meshing is in flight. Worker-side; a failure here must never break
    a rebuild, so every path is swallowed."""
    try:
        if _HB_MESH is not None:
            _HB_MESH.value = int(done)
        if _HB_MESH_TOTAL is not None:
            _HB_MESH_TOTAL.value = int(total)
    except Exception:
        pass


def _body_payload(b, tolerance, profile):
    """Compute (or fetch) the full render payload for one body: positions/indices/
    faceIds (LOCAL ids, offset client-side), faceOwners, per-body edges. Three
    tiers: identity-cached in RAM -> disk mesh artifact (load path: never pays the
    Python readback loop) -> compute + persist.

    `tolerance` is the RAW requested (wire) tolerance; it's immediately mapped
    through _effective_tolerance to the value BRepMesh actually gets, and every
    cache key below — RAM identity cache AND the disk mesh_key — is keyed on that
    EFFECTIVE value, never the raw request. Two bodies of different sizes (or one
    body whose bbox changed) must not share a cache slot keyed by a tolerance
    neither was actually tessellated at.

    A body's mesh also depends on its "_textures" spec list, which the shape
    identity check CANNOT see (texture never mutates body["shape"] — see
    texture.py's module docstring). Both the RAM identity check and the disk
    mesh_key additionally key on a hash of that spec list, so scrubbing a
    texture-only parameter (depth/scale/…) can't serve a stale pre-edit mesh."""
    import pickle
    import uuid as _uuid

    from tessellate import tessellate, edge_polylines_by_body, mesh_bbox
    from builder import _face_fp, on_feature_tick
    from texture import resolve_body_textures

    bid, sh = b["id"], b.get("shape")
    requested = tolerance
    size_scale, ang_tol = profile
    if b.get("_textures"):
        from texture import CODE_VERSION as _tex_ver
        # code version rides in the key: a texture-algorithm update must not
        # serve meshes displaced by the previous version from the disk cache
        texture_key = "v%d:%s" % (_tex_ver, json.dumps(b.get("_textures"), sort_keys=True))
    else:
        texture_key = None
    ent = _MESH_CACHE.get(bid)
    # RAM hit BEFORE _effective_tolerance: it's a pure function of (shape,
    # requested), so identical shape identity + identical request imply an
    # identical effective tolerance — an unchanged body (the common case during
    # an interactive drag of some OTHER body) skips it (and, in absolute mode,
    # the OCCT bbox walk it does) instead of paying it on every tick.
    if (
        ent is not None
        and ent["shape"] is sh
        and ent["requested"] == requested
        and ent.get("profile") == profile
        and ent.get("texture_key") == texture_key
    ):
        return ent
    if sh is not None:
        tolerance = _effective_tolerance(sh, tolerance, size_scale)

    mesh_key = None
    mk = b.get("meshKey")
    if mk:
        # The mode marker ("r"/"a") and tessellate.CODE_VERSION both ride in the
        # key: a relative deflection and an absolute one are different units that
        # could otherwise collide on the same number, and a payload cached by an
        # older edge/mesh algorithm must never be served after this module
        # changes (the disk artifact carries the EDGE polylines too).
        from tessellate import CODE_VERSION as _tess_ver
        mesh_key = "%s-tv%d-%s%s-a%s" % (mk, _tess_ver,
                                         "r" if _VIEWPORT_RELATIVE else "a", tolerance,
                                         ang_tol)
        if texture_key:
            mesh_key += "-x%s" % hashlib.sha1(texture_key.encode()).hexdigest()[:16]
    payload = None
    if mesh_key:
        try:
            import geomstore
            rawp = geomstore.default_store().get_mesh(mesh_key)
            if rawp is not None:
                payload = pickle.loads(rawp)  # trusted local cache, worker-only
        except Exception:
            payload = None
    if payload is None:
        t0 = time.monotonic()
        textures = resolve_body_textures(b) if b.get("_textures") else None
        norm_chunks = [] if textures else None
        pos, idx, fids = tessellate(sh, tolerance, angular_tolerance=ang_tol,
                                    textures=textures,
                                    density_cap=VIEWPORT_DENSITY_CAP,
                                    normals_out=norm_chunks,
                                    relative=_VIEWPORT_RELATIVE)
        owners_map = b.get("owners") or {}
        face_owners = [owners_map.get(_face_fp(face)) for face in sh.faces()]
        # Two-tone inlay preview: dense per-face palette-slot array, same
        # sh.faces() enumeration the fid convention uses. Sparse-by-convention —
        # None (omitted key) when no texture on this body carries a colorSlot.
        tex_color_slots = None
        if textures:
            face_specs = {}
            for spec, faces in textures:
                for f in faces:
                    face_specs[_face_fp(f)] = spec  # later feature wins, like tessellate
            tex_color_slots = [(face_specs.get(_face_fp(face)) or {}).get("colorSlot")
                               for face in sh.faces()]
            if not any(s is not None for s in tex_color_slots):
                tex_color_slots = None
        edges = edge_polylines_by_body([b])
        for e in edges:
            e.pop("id", None)  # ids are assigned client-side after assembly
        payload = {
            "positions": pos, "indices": idx, "faceIds": fids,
            "faceOwners": face_owners, "edges": edges,
            "faceCount": (max(fids) + 1) if fids else 0,
            # Computed HERE, while the triangulation tessellate() just built is
            # still on the shape, and stored in the payload so the disk mesh
            # artifact carries it too — a cache hit must not fall back to the
            # loose poles-based box and make the camera jump between runs.
            "bbox": mesh_bbox(sh),
        }
        if tex_color_slots:
            payload["textureColorSlots"] = tex_color_slots
        if norm_chunks:
            # a textured body ships explicit normals: plain faces get the same
            # area-weighted accumulation the client would compute, textured
            # chunks the analytic displaced normals — coarse displacement then
            # SHADES smoothly instead of showing triangle-grain.
            from tessellate import vertex_normals
            norms = vertex_normals(pos, idx)
            for vbase, chunk in norm_chunks:
                norms[vbase * 3:vbase * 3 + len(chunk)] = chunk
            payload["normals"] = norms
        build_ms = (time.monotonic() - t0) * 1000.0
        # Persist when the build was expensive OR the document is large. The
        # flat 50 ms rule was written for an interactive drag of a small model,
        # where re-tessellating one changed body every tick under a brand-new
        # content key is pure write churn. It reads very differently at scale:
        # 85% of the 3,072 bodies in the reference assembly build in under
        # 50 ms, so NONE of them were ever cached and every cold-worker open
        # re-tessellated the whole model — most of a 32.9 s payload phase that
        # actual disk loading accounts for only ~5 s of. profile[0] != 1.0 is
        # already the ">1,200 bodies" signal _viewport_profile computed, and a
        # document that large is not being scrubbed tick-by-tick anyway.
        if mesh_key and (build_ms >= _MESH_PERSIST_MIN_MS or profile[0] != 1.0):
            try:
                import geomstore
                geomstore.default_store().put_mesh(mesh_key, pickle.dumps(payload, 5))
            except Exception:
                pass
    # The document bbox is the union of these (see the payload loop), so it is
    # covered by this function's progress tick and reuses the cache on an
    # unchanged body — walking the merged compound was neither.
    ent = {"shape": sh, "requested": requested, "tolerance": tolerance,
           "profile": profile, "bbox": payload.get("bbox"),
           "etag": _uuid.uuid4().hex, "payload": payload, "texture_key": texture_key}
    _MESH_CACHE[bid] = ent
    if on_feature_tick is not None:
        try:
            on_feature_tick(-1)  # tessellation progress counts as progress
        except Exception:
            pass
    return ent


# Worker-held document for the O(changed) wire protocol (design §5 Phase 4):
# the client sends {baseRevision, revision, ops} instead of the whole document;
# we apply ops to this held copy. Any mismatch (worker respawn, missed message)
# returns {"resync": true} and the client falls back to one full send. Holding
# the doc worker-side ALSO makes the per-edit pickle across the pool boundary
# O(changed) — at 10k features the full-doc stringify/parse/pickle tax is
# ~1 s/edit on the webview main thread AND the event loop.
_DOC_STATE = {"rev": None, "doc": None}


def _apply_doc_ops(payload):
    """Apply a client delta to the held document, or adopt a full document.
    Returns the effective document, or None when a resync is needed.

    TOTAL AND ATOMIC, both by measurement. A reviewer drove `{"ops": {"length":
    1, "set": [[0, 7]]}}` at this function after the `document` door was closed
    and it applied happily: the junk feature went into the held document, the
    revision moved on to the delta's, and the box that WAS at the base revision
    was gone — the next incremental rebuild could only answer "resync". The
    build then died in builder.py on `f.get("type")`, so the refusal reached the
    client as "'int' object has no attribute 'get'".
    _malformed refuses that shape up front now, but this function must not
    depend on being called behind it: every op is applied to a COPY, anything
    the copy cannot take returns None (which is the protocol's own resync
    recovery, not an exception), and _DOC_STATE is replaced in ONE step at the
    end. So a rejected delta leaves the held document and revision untouched.

    The index bound is the one check that CANNOT move up into _malformed: the
    document lives here in the worker, and the process that validates the
    request has no idea how long it is. An index past the end is a resync."""
    if "document" in payload:
        _DOC_STATE["doc"] = payload["document"]
        _DOC_STATE["rev"] = payload.get("revision")
        return _DOC_STATE["doc"]
    if _DOC_STATE["doc"] is None or _DOC_STATE["rev"] != payload.get("baseRevision"):
        return None
    doc = _DOC_STATE["doc"]
    ops = payload.get("ops") or {}
    if not isinstance(ops, dict):
        return None
    feats = list(doc.get("features") or [])
    if "length" in ops:
        n = ops["length"]
        if not isinstance(n, int) or isinstance(n, bool) or n < 0:
            return None
        del feats[n:]
        while len(feats) < n:
            feats.append(None)  # placeholder — must be covered by "set" below
    entries = ops.get("set") or []
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if not isinstance(entry, (list, tuple)) or len(entry) != 2:
            return None
        i, f = entry
        if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < len(feats):
            return None
        if not isinstance(f, dict):
            return None
        feats[i] = f
    if any(f is None for f in feats):
        return None  # hole the ops didn't fill — resync
    updated = dict(doc)
    updated["features"] = feats
    for key in ("parameters", "bodyVisibility"):
        if key in ops:
            if not isinstance(ops[key], dict):
                return None
            updated[key] = ops[key]
    _DOC_STATE["doc"] = updated
    _DOC_STATE["rev"] = payload.get("revision")
    return updated


def _rebuild_job(document, tolerance, known=None):
    """Worker: rebuild the document and tessellate. Returns a result dict; a
    feature failure comes back INSIDE the result as "featureError" (with the
    surviving geometry), or as {"error": {...}} only when nothing built at all.
    Args/return must stay picklable.

    Uses rebuild_cached (RAM prefix + durable disk checkpoints). The reply is
    protocol v2: PER-BODY payloads with etags. `known` maps body id -> etag the
    client already holds; a body whose payload is identity-cached under the same
    etag is answered with a stub ("unchanged") instead of its mesh — the client
    reassembles locally. Worker respawn empties the RAM caches, which simply
    downgrades every body to a full payload once."""
    from builder import rebuild_cached

    diag = []
    proj = []
    known = known or {}
    t0 = time.monotonic()
    part, errors, bodies = rebuild_cached(document, diagnostics=diag, projections=proj)
    t_rebuild = time.monotonic() - t0
    if errors and part is None and not bodies:
        # nothing built at all — the document is unusable, surface as fatal
        return _fatal_from(errors)
    if part is None:
        # no solid yet (e.g. only sketches exist) — not an error; the frontend
        # still renders sketch overlays. Projection refresh entries still ride
        # along (a sketchCurve source needs no body at all).
        result = {"protocol": 2, "bodies": [], "bbox": None}
        if proj:
            result["projectionUpdates"] = proj
        return result

    live_ids = set()
    out = []
    body_boxes = []
    t0 = time.monotonic()
    # One profile for the whole document: a big assembly is meshed coarser so its
    # reply fits the frame cap (see _VIEWPORT_SIZE_TIERS). Computed once, outside
    # the loop, so every body in one reply is meshed on the same terms.
    profile = _viewport_profile(len(bodies))
    if profile[0] != 1.0:
        print("[rebuild] %d bodies -> coarse viewport profile (x%.1f linear, ang %.2f)"
              % (len(bodies), profile[0], profile[1]), flush=True)
    # Announce the denominator BEFORE the loop so the very first progress frame
    # can already say "1 of 3071" rather than starting at an unknown total.
    n_to_mesh = sum(1 for b in bodies if b.get("shape") is not None)
    n_meshed = 0
    _set_mesh_progress(0, n_to_mesh)
    for b in bodies:
        if b.get("shape") is None:
            continue
        live_ids.add(b["id"])
        ent = _body_payload(b, tolerance, profile)
        n_meshed += 1
        _set_mesh_progress(n_meshed, n_to_mesh)
        body_boxes.append(ent.get("bbox"))
        # The assembly-tree node lives in the ENVELOPE, next to id/name/etag, and
        # is sent on BOTH branches. It must not go inside the mesh payload: that
        # is etag-cached, so the tree would freeze at whatever it was when the
        # geometry last changed. The stub branch matters most — on an assembly
        # rebuild almost every body is unchanged.
        node_ref = {"nodeRef": b["node_ref"]} if b.get("node_ref") else {}
        if known.get(b["id"]) == ent["etag"]:
            out.append({"id": b["id"], "name": b["name"], "etag": ent["etag"],
                        **node_ref, "unchanged": True})
        else:
            item = {"id": b["id"], "name": b["name"], "etag": ent["etag"], **node_ref}
            item.update(ent["payload"])
            out.append(item)
    t_payload = time.monotonic() - t0
    _set_mesh_progress(-1, -1)  # meshing done — stop claiming a denominator
    for bid in list(_MESH_CACHE):
        if bid not in live_ids:
            del _MESH_CACHE[bid]  # body deleted/consumed — drop its cache
    # The document bbox is the UNION of the per-body boxes accumulated above —
    # see _union_bbox for why this is no longer one walk over the merged part.
    # No bbox(part) fallback: it can only be reached when EVERY body's box
    # failed, where walking the merged compound of those same shapes would fail
    # too — after spending the untickable 95 s this change exists to remove.
    # `bbox: null` is already a legal reply (the no-bodies branch sends it).
    t0 = time.monotonic()
    doc_bbox = _union_bbox(body_boxes)
    t_bbox = time.monotonic() - t0
    # Phase log for scale diagnosis (large assemblies): shows where a slow
    # build actually spends its time, and correlates with the stall watchdog.
    print(f"[rebuild] features={len(document.get('features', []))} "
          f"bodies={len(out)} rebuild={t_rebuild:.1f}s payloads={t_payload:.1f}s "
          f"bbox={t_bbox:.1f}s",
          flush=True)
    result = {"protocol": 2, "bodies": out, "bbox": doc_bbox}
    if diag:  # only attach when a selector resolved with low confidence
        result["diagnostics"] = diag
    if proj:  # only attach when the projection refresh found real changes
        result["projectionUpdates"] = proj
    if errors:
        # Failing features must NOT blank the whole document: rebuild() records
        # them as no-ops and continues, so return the geometry that DID build
        # with the errors attached — the frontend shows the banner AND the model.
        # The banner gets the LAST (most downstream) error: with a permanently-
        # failing feature upstream, the user's newest action is what they need
        # to see, not the same old error masking it. All errors ride along in
        # "featureErrors" for richer UI later.
        result["featureError"] = {
            "message": errors[-1]["message"],
            "feature_id": errors[-1].get("feature_id"),
        }
        result["featureErrors"] = [
            {"message": e["message"], "feature_id": e.get("feature_id")} for e in errors
        ]
    return result


def _rebuild_delta_job(payload, tolerance, known=None):
    """Rebuild entry point for the delta wire protocol: adopt/patch the held
    document, or ask for a resync when we can't."""
    doc = _apply_doc_ops(payload)
    if doc is None:
        return {"resync": True}
    return _rebuild_job(doc, tolerance, known)


def _compute_all_job(payload, tolerance):
    """mainstream MCAD's 'Compute All' escape hatch: bypass and REBUILD every cache layer —
    RAM prefix snapshots, mesh cache, and this document's disk checkpoints and
    blobs (purged so a hypothetically poisoned blob can't survive put_blob's
    key-dedup skip). One full cold rebuild follows; all caches repopulate."""
    import builder

    document = _apply_doc_ops(payload)
    if document is None:
        return {"resync": True}
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    _MESH_CACHE.clear()
    try:
        import geomstore
        sigs = [builder._feature_sig(f) for f in document.get("features", [])]
        keys = builder._chain_keys_scoped(document, sigs)
        geomstore.default_store().purge(keys)
    except Exception:
        pass
    return _rebuild_job(document, tolerance)


def _export_job(document, fmt, path, body=None, separate=False,
                palette=None, body_colors=None):
    """Worker: rebuild + export. Default exports the merged part to `path`; `body`
    (a body id) exports just that body; `separate` writes EACH body to its own
    '<base>-<name>.<ext>'. Returns {"path"} (+ {"paths"} for separate) or {"error"}.

    Textured bodies can't go through build123d's BRep-native exporters.export()
    (texture is mesh-only, applied at tessellation time — see texture.py), so an
    STL/3MF target with a texture anywhere branches to tessellate()+mesh_writers
    at export grade instead; a document with NO textures takes the exact same
    export(...) calls as before, unchanged. STEP is BRep-only regardless —
    texture never reaches it, so a textured body exported as STEP gets a
    non-blocking warning instead of a silent drop."""
    import os
    import re
    from builder import rebuild_cached
    from exporters import export
    import mesh_writers

    # rebuild_cached, not rebuild: export runs in the SAME long-lived worker as
    # edits, so a warm cache makes this ~0 s instead of a gratuitous full rebuild
    part, errors, bodies = rebuild_cached(document)
    live = [b for b in bodies if b.get("shape") is not None]
    _prune_export_cache(live)
    # Export what BUILT, and warn about what didn't — never silently. Refusing
    # to export ANYTHING because one feature errored blocked the whole
    # import-repair→print loop (one stubborn face held nine good bodies
    # hostage). Only a document where nothing built at all is a hard error.
    if errors and part is None and not live:
        return _fatal_from(errors)
    if part is None and not live:
        return {"error": {"message": "nothing to export — no bodies built yet"}}
    warnings = [
        {"message": e["message"], "feature_id": e.get("feature_id")} for e in errors
    ]
    any_textured = any(b.get("_textures") for b in live)
    if fmt == "step" and any_textured:
        warnings.append({"message": "texture is not represented in STEP exports"})

    def _done(res):
        if warnings:
            res["warnings"] = warnings
        return res

    def _mesh_export(target_bodies, p):
        """Concatenate target_bodies into one merged, textured, export-grade mesh
        and write it via mesh_writers. Raises past the triangle hard cap — a
        document-wide safety net so a pathological scale/depth combo can't
        allocate an unbounded mesh."""
        pos_parts, idx_parts, vbase = [], [], 0
        ntri = 0
        for b in target_bodies:
            pos, idx = _export_mesh(b)
            # Checked HERE, per body, rather than on the concatenated total.
            # The cap exists to stop a pathological document allocating
            # unbounded memory, and a check that runs only after every body has
            # been meshed and concatenated has already allowed exactly that —
            # it could report the OOM it was meant to prevent. Bounded now to
            # the cap plus one body.
            ntri += len(idx) // 3
            refusal = _budget_refusal(ntri)
            if refusal:
                raise ValueError(refusal)
            pos_parts.append(np.asarray(pos, dtype=np.float64))
            idx_parts.append(np.asarray(idx, dtype=np.int64) + vbase)
            vbase += len(pos_parts[-1]) // 3
        # A one-element concatenate copies the whole array a second time, and the
        # separate/single-body paths always hit that case.
        positions = (pos_parts[0] if len(pos_parts) == 1
                     else np.concatenate(pos_parts) if pos_parts else np.empty(0))
        mindices = (idx_parts[0] if len(idx_parts) == 1
                    else np.concatenate(idx_parts) if idx_parts
                    else np.empty(0, dtype=np.int64))
        warn = _budget_warning(ntri)
        if warn:
            warnings.append({"message": warn})
        if fmt == "stl":
            mesh_writers.write_stl(positions, mindices, p)
        elif fmt == "3mf":
            mesh_writers.write_plain_3mf(positions, mindices, p)
        else:
            raise ValueError(f"texture is not supported for {fmt} export")
        return p

    def _glb_export(target_bodies, p):
        """GLB sibling of _mesh_export: same export-grade meshes, but bodies are
        kept SEPARATE (one glTF node/mesh/material each) instead of merged, so
        every body keeps its name and its palette colour in a viewer.

        Routed here for textured AND untextured bodies alike. Deliberately never
        goes through exporters.export(): that path serialises body["shape"], and
        texture displacement lives only in the mesh, so a textured body would
        export silently untextured."""
        from project3mf import _norm_color

        pal = palette or []
        slots = body_colors or {}
        entries, ntri = [], 0
        for b in target_bodies:
            pos, idx = _export_mesh(b)
            ntri += len(idx) // 3
            # Same reason as _mesh_export: bound the allocation as it happens.
            # GLB keeps bodies SEPARATE, so without this a 3,000-body assembly
            # holds every mesh at once before anything is checked.
            refusal = _budget_refusal(ntri)
            if refusal:
                raise ValueError(refusal)
            slot = slots.get(b["id"], 0)  # unassigned -> slot 0, as the 3MF path does
            entry = pal[slot] if isinstance(slot, int) and 0 <= slot < len(pal) else None
            entries.append({
                "name": b.get("name") or b["id"],
                "positions": pos,
                "indices": idx,
                "color": _norm_color(entry.get("color")) if entry else None,
            })
        warn = _budget_warning(ntri)
        if warn:
            warnings.append({"message": warn})
        return mesh_writers.write_glb(entries, p)

    def _write_one_body(b, p):
        """ONE body to `p`, via whichever writer the format needs.

        Shared by the separate-bodies and single-body paths, which became
        identical once untextured stl/3mf stopped taking the bypass: the
        `b.get("_textures")` test was the only thing that had distinguished them.
        The whole-document path stays separate — it genuinely differs (STEP tree,
        fused part)."""
        if fmt == "glb":
            return _glb_export([b], p)
        if fmt in ("stl", "3mf"):
            return _mesh_export([b], p)  # textured or not: caps, cache, tolerance
        return export(b["shape"], fmt, p)

    if separate:
        if not live:
            return {"error": {"message": "nothing to export — no bodies"}}
        # Prefer the user's sidebar rename (display-only override carried on the
        # document) over the positional default ("Body1"), so exported part files
        # are named the way the user named the bodies.
        names = document.get("bodyNames") or {}
        base, ext = os.path.splitext(path)
        # Into a DIRECTORY of our own, created with exist_ok=False.
        #
        # The save dialog asks the user to confirm overwriting `parts.step`, and
        # then that file is never written — N sibling files are. So the one file
        # they were asked about was the only one that could not be clobbered,
        # while `parts-Body1.step` and its siblings were silently overwritten
        # with no prompt at all. A fresh directory makes the collision
        # impossible AND keeps the N files together.
        outdir = base
        try:
            os.makedirs(outdir, exist_ok=False)
        except FileExistsError:
            return {"error": {"message": (
                f"{os.path.basename(outdir)} already exists — the separate-bodies "
                f"export writes a folder of that name. Choose another name, or "
                f"move the existing folder."
            )}}
        except OSError as e:
            return {"error": {"message": f"could not create {outdir}: {e}"}}
        written, used = [], set()
        for b in live:
            label = names.get(b["id"]) or b["name"]
            name = _safe_part_filename(label, b["id"])
            cand, i = name, 2
            while cand.lower() in used:  # case-insensitive: Windows and macOS
                cand, i = f"{name}_{i}", i + 1
            used.add(cand.lower())
            written.append(_write_one_body(b, os.path.join(outdir, f"{cand}{ext}")))
        return _done({"path": outdir, "paths": written})

    if body:
        tgt = next((b for b in live if b["id"] == body), None)
        if tgt is None:
            return {"error": {"message": f"body '{body}' not found to export"}}
        if fmt == "glb":
            return _done({"path": _glb_export([tgt], path)})
        return _done({"path": _write_one_body(tgt, path)})

    # GLB always goes per-body: it carries per-body colour, and routing it through
    # export() would drop texture displacement (see _glb_export).
    if fmt == "glb":
        return _done({"path": _glb_export(live, path)})
    # UNTEXTURED stl/3mf goes the same way as textured. It used to fall through to
    # exporters.export, which calls build123d's export_stl / Mesher directly and
    # so bypassed every cap, every cache and the export tolerance — the one path
    # where a pathological document could allocate without limit.
    #
    # Measured before switching, because it changes which tessellation runs: at
    # export grade a sphere, a cylinder and a filleted box all produce the
    # IDENTICAL triangle count to build123d's default, and a torus produces
    # 1.84x fewer. The deviation that buys is 0.02 mm, far below any printer's
    # resolution, and it is the same tolerance textured exports have always used.
    if fmt in ("stl", "3mf"):
        return _done({"path": _mesh_export(live, path)})
    # STEP carries structure: hand build123d a LABELLED tree instead of the fused
    # part, so product names — and an imported assembly's hierarchy, per-part
    # colours and per-occurrence placement — survive the export. build123d's
    # export_step already writes XCAF via STEPCAFControl_Writer, so this only has
    # to supply the tree. Whole-document exports only: `body=` and `separate=True`
    # each write a single body, which has no tree.
    if fmt == "step" and body is None and not separate:
        import export_tree

        tree = export_tree.build_export_tree(
            document, live, root_name=os.path.splitext(os.path.basename(path))[0] or "Model"
        )
        if tree is not None:
            return _done({"path": export(tree, fmt, path)})
    return _done({"path": export(part, fmt, path)})


def _export_project_job(document, path, palette, body_colors, body_names, settings):
    """Worker: rebuild + write an Orca-project 3MF (one object per body, palette
    slot → extruder). Same export-what-built semantics as _export_job: failed
    features become warnings; only zero live bodies is a hard error."""
    from builder import rebuild_cached
    from project3mf import sanitize_inputs, write_project_3mf

    part, errors, bodies = rebuild_cached(document)
    live = [b for b in bodies if b.get("shape") is not None]
    _prune_export_cache(live)
    if not live:
        if errors:
            return _fatal_from(errors)
        return {"error": {"message": "nothing to export — no bodies built yet"}}

    palette, body_colors, body_names = sanitize_inputs(palette, body_colors, body_names)
    meshed = []
    ntri = 0
    for b in live:
        # Export-grade tolerance — the viewport default (0.1) is visibly faceted
        # on a printed part. Cached across exports of an unchanged body.
        positions, indices = _export_mesh(b)
        if not len(indices):
            continue  # degenerate body with no triangulation — skip, like exports do
        # This path had NO budget at all, which made it the way round every cap
        # the plain export enforces. Checked per body, before the mesh is kept,
        # so the allocation is bounded to the cap plus one body.
        ntri += len(indices) // 3
        refusal = _budget_refusal(ntri)
        if refusal:
            return {"error": {"message": refusal}}
        meshed.append(
            {"id": b["id"], "name": b["name"], "positions": positions, "indices": indices}
        )
    if not meshed:
        return {"error": {"message": "nothing to export — no meshable bodies"}}

    res = {"path": write_project_3mf(meshed, path, palette, body_colors, body_names, settings)}
    if errors:
        res["warnings"] = [
            {"message": e["message"], "feature_id": e.get("feature_id")} for e in errors
        ]
    return res


def _migrate_geometry_job(items):
    """Worker: convert pre-v5 inline base64 ASCII BREP to blobs in the durable
    store, returning the content hash for each.

    IN THE WORKER, deliberately. This parses geometry that came out of a file the
    user opened, and `builder._brep_b64_to_shape` exists precisely so a crafted
    `.sindri` cannot aim a parser fuzz at OCCT — doing it in the parent would put
    that fuzz one segfault away from taking the whole sidecar down instead of a
    disposable worker.

    Per-item failures are reported, not raised: one unreadable legacy body must
    not block migrating the rest, and the document keeps its inline copy for
    anything that fails, so nothing is lost either way."""
    from builder import _brep_b64_to_shape, _shape_to_blob

    out, failed = [], []
    for it in items:
        try:
            out.append({"id": it["id"], "geom": _shape_to_blob(_brep_b64_to_shape(it["brep"]))})
        except Exception as e:  # noqa: BLE001
            failed.append({"id": it.get("id"), "message": str(e)})
    return {"items": out, "failed": failed}


def _query_job(document, items, prefix=False, strict=True):
    """Worker: resolve selectors / match predicates, returning storable refs."""
    from builder import query_geometry

    try:
        return query_geometry(document, items, prefix=prefix, strict=strict)
    except Exception as ex:
        return _error_from(ex, errors_mod.BAD_REQUEST)


def _mass_properties_job(document, body_ids, checks, prefix=False):
    """Worker: exact kernel mass properties for the document's live bodies.

    Caches by default. Withholding the cache write protects the human only when
    the document is a truncated PREFIX; on a whole document it just means every
    read-only op pays its own rebuild, measured at ~44 s each on the reference
    assembly with no benefit to the next one. `prefix=True` restores the
    protection for a caller that really did truncate.
    """
    from builder import rebuild_cached, mass_properties, progress_tick

    part, errors, bodies = rebuild_cached(document, readonly=prefix)
    live = [b for b in bodies if b.get("shape") is not None]
    # Same condition as _interference_job, and deliberately NOT "nothing is
    # measurable": those differ on the reference assembly's 8 empty compounds,
    # which build fine and simply have nothing to measure. One red feature must
    # not refuse to measure the rest of an otherwise-good document.
    if errors and not live:
        return _fatal_from(errors)

    wanted = live
    unknown = []
    if body_ids:
        by_id = {b["id"]: b for b in live}
        wanted = [by_id[i] for i in body_ids if i in by_id]
        # Report ids that matched nothing rather than dropping them: body ids are
        # regenerated per rebuild, so "you asked about a body that no longer
        # exists" is the single most likely mistake a caller makes here.
        unknown = [i for i in body_ids if i not in by_id]

    res = mass_properties(wanted, checks=checks, tick=progress_tick)
    res["units"] = "mm"
    # Pin the conventions ON THE DATA. Neither is guessable, and both change what
    # a number means: counts through build123d exclude degenerate edges (and match
    # what selectors can address), and the box comes from the triangulation, so it
    # is conservative rather than exact.
    res["counting"] = "build123d"
    res["bboxSource"] = "mesh"
    if unknown:
        res["unknown"] = unknown
    if errors:
        res["warnings"] = [
            {k: e[k] for k in ("message", "feature_id", "code") if k in e} for e in errors
        ]
    return res


def _interference_job(document):
    """Worker: rebuild + pairwise interference check among live bodies. Returns
    {"pairs": [...]} — one entry per pair of solids that actually overlap (boolean
    intersection volume above a tiny epsilon), with the overlap volume + bbox so the
    frontend can report and zoom to each clash."""
    from builder import rebuild_cached, _bbox_pair_overlap, bbox_of, progress_tick

    # rebuild_cached for the same reason as _export_job: same worker, warm cache
    part, errors, bodies = rebuild_cached(document)
    live = [b for b in bodies if b.get("shape") is not None]
    # like export: check the bodies that BUILT, warn about what didn't — one red
    # feature must not block clash-checking an otherwise-valid assembly
    if errors and not live:
        return _fatal_from(errors)
    # ONE bbox per body, not one per pair. The sweep is quadratic in pairs but
    # linear in distinct shapes, so computing the box inside the pair test did
    # 9,360,540 OCCT bounding-box walks at 3,060 bodies to learn 3,060 things.
    # Ticked per body: this precompute runs BEFORE the first row tick below, and
    # `bbox_of` is OCCT's exact AddOptimal_s — measured 95.5 s over the 3,072
    # bodies of the reference assembly, against a 60 s STALL_TIMEOUT. Unticked it
    # was reaped mid-precompute and the whole operation died with nothing logged.
    # It is still slow; the tick is what makes it finish and report progress. A
    # cheaper poles-based box was measured and REJECTED — see `bbox_of`.
    boxes = []
    for b in live:
        progress_tick()
        boxes.append(bbox_of(b["shape"]))
    pairs = []
    for i in range(len(live)):
        # Ticked in two places, both proportional to real work: once per row,
        # and again before each boolean. The bbox rejects are cheap enough to
        # sweep in bulk, but a single row of a dense assembly can spend minutes
        # in the booleans below, which is longer than the stall timeout.
        progress_tick()
        for j in range(i + 1, len(live)):
            a, b = live[i], live[j]
            if not _bbox_pair_overlap(boxes[i], boxes[j]):
                continue  # cheap AABB reject before the (crashable) boolean
            progress_tick()
            try:
                common = a["shape"] & b["shape"]
                vol = abs(getattr(common, "volume", 0.0) or 0.0)
            except Exception:
                continue  # tangent/degenerate intersection — treat as no clash
            if vol <= 1e-6:
                continue
            bb = common.bounding_box()
            pairs.append({
                "a": a["id"], "b": b["id"], "aName": a["name"], "bName": b["name"],
                "volume": vol,
                "bbox": {
                    "min": [bb.min.X, bb.min.Y, bb.min.Z],
                    "max": [bb.max.X, bb.max.Y, bb.max.Z],
                },
            })
    return {"pairs": pairs}


def _import_job(path, fmt):
    """Worker: read an external geometry file (STL/3MF/STEP/BREP) into an embeddable
    BREP payload. Returns the `import` feature fields or {"error"}."""
    from builder import import_geometry

    try:
        return import_geometry(path, fmt)
    except Exception as ex:
        return _error_from(ex)


def _list_fonts_job():
    """Worker: enumerate system font families (read-only)."""
    from builder import list_fonts

    try:
        return list_fonts()
    except Exception as ex:
        return _error_from(ex)


def _tessellate_text_job(entity, path_entity):
    """Worker: per-glyph 2D outlines for a text entity (read-only preview)."""
    from builder import tessellate_text

    try:
        return tessellate_text(entity, path_entity)
    except Exception as ex:
        return _error_from(ex)


def _project_geometry_job(document, plane, sources):
    """Worker: resolve + project geometry sources onto a sketch plane (read-only;
    per-source errors ride inside `results`, only a failed prefix rebuild or a
    bad plane spec is a whole-call error). `document` is the frontend-truncated
    timeline PREFIX — rebuild_cached gives its bodies from the warm cache."""
    from builder import project_geometry

    try:
        return project_geometry(document, plane, sources)
    except Exception as ex:
        return _error_from(ex)


# --- server process ---------------------------------------------------------


def _die_with_parent():
    """Exit when the parent (the Rust shell, or the server for a worker) dies, so we
    never orphan. Linux delivers SIGTERM via PR_SET_PDEATHSIG. macOS has no such
    mechanism, so a daemon thread polls getppid() and exits on reparenting (the parent
    dying makes our ppid change / become 1). Windows is covered by the Rust-side Job
    Object (KILL_ON_JOB_CLOSE), so no watchdog is needed there."""
    if sys.platform == "linux":
        try:
            PR_SET_PDEATHSIG = 1
            libc = ctypes.CDLL("libc.so.6", use_errno=True)
            libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0)
        except Exception:
            pass  # best-effort; the Rust side also kills us on exit
        return

    if sys.platform == "darwin":
        orig_ppid = os.getppid()

        def _watch():
            while True:
                time.sleep(1.0)
                try:
                    ppid = os.getppid()
                except Exception:
                    os._exit(0)
                if ppid != orig_ppid or ppid <= 1:
                    os._exit(0)  # parent gone (reparented to launchd) -> don't orphan

        threading.Thread(target=_watch, daemon=True).start()


def _ok(req_id, result):
    return json.dumps({"id": req_id, "ok": True, "result": result})


def _err(req_id, message, feature_id=None, code=None):
    error = {"message": message or "internal error (no message)"}
    if feature_id is not None:
        error["feature_id"] = feature_id
    if code:
        error["code"] = code
    return json.dumps({"id": req_id, "ok": False, "error": error})


def _fatal_from(errors):
    """The first feature error as a WHOLE-JOB failure dict.

    Four byte-identical copies of `e = errors[0]; return {"error": {...}}` used
    to spell this out field by field, which is exactly how `code` gets dropped on
    three paths while looking correct on the fourth. Copy the dict; do not
    re-enumerate its keys."""
    e = dict(errors[0])
    return {"error": {k: e[k] for k in ("message", "feature_id", "code") if k in e}}


def _error_from(ex, code=None):
    """A caught exception as a job-result error dict, preserving any code it
    carries. Job functions that end in a blanket `except Exception` are the last
    place a code can be lost before the wire — an ambiguousReference raised deep
    inside _project_source reaches the client through one of these."""
    return {"error": {"message": str(ex) or type(ex).__name__,
                      **({"code": c} if (c := errors_mod.code_of(ex, code)) else {})}}


def _reply_for(req_id, res):
    """Turn a worker result dict into the wire reply (error vs ok)."""
    if res.get("cancelled"):
        return json.dumps({
            "id": req_id, "ok": False, "cancelled": True,
            # `cancelled: true` is a shipped contract and stays; the code rides
            # BESIDE it so a caller can branch on one vocabulary for everything.
            "error": {"message": "cancelled", "code": errors_mod.CANCELLED},
        })
    if "error" in res:
        # NOTE: forward `code` by name. Anything this function does not name is
        # silently dropped, which is what made the field inert on its first
        # three attempts.
        return _err(req_id, res["error"]["message"], res["error"].get("feature_id"),
                    res["error"].get("code"))
    return _ok(req_id, res)


# The largest frame the websocket server will accept or emit. A security control
# (sidecar DoS surface), deliberately lowered from 512 MiB in the 2026-07-02
# hardening round — raise it only with that in mind. Enforced on the way IN by
# websockets.serve(max_size=...) and on the way OUT by _reply_bytes.
_MAX_FRAME = 128 * 1024 * 1024

# Binary mesh reply (opt-in via `"binary": true` on rebuild/computeAll requests).
# Wire layout, all integers little-endian:
#   [u32 header_len][header_len bytes UTF-8 JSON header][pad to 4][buf0][buf1]...
# The header is the normal {"id","ok","result"} envelope except each per-body
# mesh array (positions/normals -> f32, indices/faceIds -> u32) is replaced by
# {"$buf": i} referencing result.$buffers[i] = {"dtype","len"} (len = element
# count) in on-wire order; the client computes offsets sequentially. Both
# dtypes are 4 bytes/element, so after the single header pad every buffer is
# 4-aligned for free — INVARIANT: adding a wider dtype requires per-buffer
# padding. NOTE the unit of that invariant is ONE FRAME, and with `"chunked":
# true` a reply is several frames: each carries its own header, its own pad and
# its own $buffers table, so the guarantee holds per chunk, not per reply.
# f32 is lossless vs today's end state (the client always builds
# Float32BufferAttributes). A body's EDGE polylines are packed the same way
# (see _pack_edges) into {"$pts","$counts","body"}; everything else (stubs,
# faceOwners, bbox, diagnostics) stays inline JSON in the header.
_WIRE_F32 = np.dtype("<f4")
_WIRE_U32 = np.dtype("<u4")


def _pack_edges(edges, take, body):
    """Move one body's edge polylines out of the inline JSON header and into two
    binary buffers: all point triples flattened (f32) plus a per-edge POINT count
    (u32) the client walks to re-split them.

    Edge polylines are the largest single component of a large assembly's reply
    AND the one part tessellation tolerance cannot shrink — they sample at the
    fixed _EDGE_DEFLECTION, not at the viewport tolerance. Measured on the 356 MiB
    reference assembly: 97.1 MiB across 1,726,523 points, byte-identical at every
    point of a 5-step tolerance sweep, i.e. a hard floor under the 128 MiB frame
    cap that no adaptive-tolerance scheme can lift. As JSON text a point costs
    59 bytes against 12 as f32, so this is the cheapest large saving available and
    it costs no visual fidelity.

    `body` is the owning body id, taken from the envelope rather than re-derived
    from the polylines: every list reaching here comes from a SINGLE-body
    edge_polylines_by_body([b]) call, which stamps that same id on each edge."""
    counts, flat = [], []
    for e in edges or ():
        pts = e.get("points") or ()
        counts.append(len(pts))
        for p in pts:
            flat.extend(p)
    return {
        "$pts": take(flat, _WIRE_F32, "f32"),
        "$counts": take(counts, _WIRE_U32, "u32"),
        "body": body,
    }


class _ReplyTooLarge(Exception):
    """The encoded frame would exceed _MAX_FRAME. Carries the size so the caller
    can say how far over it was, and is raised BEFORE the buffers are joined so
    the doomed frame is never actually materialised."""

    def __init__(self, size):
        super().__init__(size)
        self.size = size


def _taker():
    """A `take` callable plus the buffer list and metadata it fills, scoped to
    ONE frame. Buffer indices are frame-local: the client resolves offsets by
    walking $buffers sequentially through the frame it just received, so a
    table spanning frames would have nothing to walk."""
    buffers = []
    buf_meta = []

    def take(vals, dtype, tag):
        arr = np.asarray(vals, dtype=dtype)
        # memoryview, not .tobytes(): join copies either way, so a bytes copy
        # here would put TWO full payloads in the parent at once — ~245 MiB at
        # the shipping tier. The array stays alive through the view.
        buffers.append(memoryview(arr).cast("B"))
        buf_meta.append({"dtype": tag, "len": int(arr.size)})
        return {"$buf": len(buf_meta) - 1}

    return take, buffers, buf_meta


def _pack_bodies(bodies, take):
    """Swap each full body's mesh arrays for {"$buf": i} refs; stubs pass through
    untouched. Shared by the single-frame encoder and the chunked one so a body's
    on-wire payload is identical either way — which is what lets the chunked
    round-trip test assert equality against the single-frame reply."""
    out = []
    for b in bodies:
        if b.get("unchanged"):
            out.append(b)
            continue
        nb = dict(b)
        nb["positions"] = take(b["positions"], _WIRE_F32, "f32")
        if "normals" in b:
            nb["normals"] = take(b["normals"], _WIRE_F32, "f32")
        nb["indices"] = take(b["indices"], _WIRE_U32, "u32")
        nb["faceIds"] = take(b["faceIds"], _WIRE_U32, "u32")
        nb["edges"] = _pack_edges(b.get("edges"), take, b.get("id"))
        out.append(nb)
    return out


def _frame_bytes(envelope, buffers):
    """Lay one frame out: [u32 header_len][JSON header][pad to 4][buffers...].

    Sizes the frame from its parts and refuses BEFORE joining: the join is a
    second full-size allocation, and on an over-cap frame every byte of it is
    discarded to send a short error string."""
    header = json.dumps(envelope).encode("utf-8")
    pad = (-len(header)) % 4
    parts = [struct.pack("<I", len(header)), header, b"\x00" * pad]
    parts.extend(buffers)
    total = sum(len(p) for p in parts)
    if total >= _MAX_FRAME:
        raise _ReplyTooLarge(total)
    return b"".join(parts)


def _encode_binary_reply(req_id, res):
    """Encode a successful protocol-2 rebuild result as one binary frame.
    Raises on anything unexpected — _reply_bytes falls back to the JSON text
    reply, so an encode bug can never break a rebuild."""
    take, buffers, buf_meta = _taker()
    header_obj = dict(res)
    header_obj["bodies"] = _pack_bodies(res.get("bodies", []), take)
    header_obj["$buffers"] = buf_meta
    return _frame_bytes({"id": req_id, "ok": True, "result": header_obj}, buffers)


def _too_large_error(req_id, size, n_bodies):
    """The reply exceeded the frame cap. websockets closes the connection with
    1009 "message too big" when a frame exceeds max_size, which reaches the user
    as the app dying mid-rebuild with no explanation — the failure mode of GH #4.
    _viewport_profile coarsens a large document's mesh to stay under the cap, but
    it keys off BODY COUNT, and bodies vary enormously in face count; this is the
    backstop for when that proxy is wrong."""
    print("[rebuild] reply %s over the %s frame cap (%d bodies)"
          % (sysmem.describe(size), sysmem.describe(_MAX_FRAME), n_bodies),
          file=sys.stderr, flush=True)
    return _err(
        req_id,
        "This model is too detailed to display: the rebuilt geometry came to "
        f"{sysmem.describe(size)} across {n_bodies:,} bodies, over the "
        f"{sysmem.describe(_MAX_FRAME)} limit. Hide some bodies or simplify "
        "the model.",
        code=errors_mod.REPLY_TOO_LARGE,
    )


def _reply_bytes(req_id, res, binary):
    """Dispatch a rebuild/computeAll result to its wire form: binary frame when
    the client opted in and the result is a successful mesh reply; the plain
    JSON text reply otherwise (errors, resync, opt-out, or encoder failure).

    Either form is refused if it would exceed the frame cap — see
    _too_large_error for why that must not reach websockets. Clients that also
    opt into `chunked` never reach here for a successful mesh reply; they go
    through _stream_binary_reply, which has no such cliff."""
    n_bodies = len(res.get("bodies") or ())
    if not binary or "error" in res or res.get("resync"):
        reply = _reply_for(req_id, res)
    else:
        try:
            reply = _encode_binary_reply(req_id, res)
        except _ReplyTooLarge as over:
            return _too_large_error(req_id, over.size, n_bodies)
        except Exception:
            reply = _reply_for(req_id, res)
    if len(reply) >= _MAX_FRAME:
        return _too_large_error(req_id, len(reply), n_bodies)
    return reply


# Target size for one chunk of a streamed reply. An eighth of _MAX_FRAME, so a
# single body far over target still has 8x of headroom before its chunk becomes
# unsendable, and the browser's largest single ArrayBuffer allocation drops from
# 128 MiB to ~16. Only a packing hint: _frame_bytes still enforces _MAX_FRAME
# per chunk, because _body_wire_size is an estimate.
_CHUNK_TARGET_BYTES = 16 * 1024 * 1024


def _wire_len(v):
    """len() of a mesh array field, 0 when absent.

    Deliberately NOT `len(x or ())`: today these are Python lists, but on a
    numpy array `or` evaluates __bool__ and raises "truth value of an array
    with more than one element is ambiguous". Handing numpy across the pool
    boundary is a named follow-up (it would cut the pickle ~8x), and this is
    the one place it would have blown up on arrival."""
    return 0 if v is None else len(v)


def _body_wire_size(b):
    """Estimate one body's encoded size, for packing decisions only."""
    if b.get("unchanged"):
        return 128  # a stub is a handful of short JSON fields
    n = (_wire_len(b.get("positions")) + _wire_len(b.get("indices"))
         + _wire_len(b.get("faceIds")) + _wire_len(b.get("normals")))
    for e in b.get("edges") or ():
        n += 3 * _wire_len(e.get("points")) + 1
    # 4 bytes per binary element, plus the inline JSON riding in the header —
    # faceOwners dominates that, at one short string or null per B-rep face.
    return 4 * n + 24 * _wire_len(b.get("faceOwners")) + 256


def _manifest_entry(b):
    """One manifest row. The manifest names every body of the reply in final
    order and ships in the head frame, so the client can plan every array
    offset and faceStart BEFORE any payload arrives — which is what makes chunk
    writes order-independent and byte-identical to the single-frame path.

    Sizes are present only for FULL bodies. For a stub the sidecar genuinely
    does not know them: the arrays live in the client's own bodyMesh cache,
    which is the entire point of a stub. The client resolves them from there,
    which it must do anyway to decide whether it can still back that etag."""
    e = {"id": b["id"], "name": b.get("name"), "etag": b.get("etag")}
    if b.get("nodeRef") is not None:
        e["nodeRef"] = b["nodeRef"]
    if b.get("unchanged"):
        e["unchanged"] = True
        return e
    e["faceCount"] = b.get("faceCount", 0)
    e["nVerts3"] = _wire_len(b.get("positions"))
    e["nIdx"] = _wire_len(b.get("indices"))
    e["nTris"] = _wire_len(b.get("faceIds"))
    e["nEdges"] = _wire_len(b.get("edges"))
    if "normals" in b:
        e["hasNormals"] = True
    return e


def _chunk_bodies(bodies, target):
    """Group bodies into chunks of roughly `target` bytes, IN ORDER.

    Order is load-bearing all the way to the screen: the client accumulates
    faceStart by manifest order, and partitionMesh/buildBodyMesh key face
    picking off those ranges. A body over target gets a chunk to itself rather
    than being split — the body is the indivisible unit here, which is what
    keeps every chunk independently decodable."""
    chunk, size = [], 0
    for b in bodies:
        n = _body_wire_size(b)
        if chunk and size + n > target:
            yield chunk
            chunk, size = [], 0
        chunk.append(b)
        size += n
    if chunk:
        yield chunk


def _body_too_large_error(req_id, chunk, size):
    """One body's own payload exceeds the frame cap — the single case chunking
    cannot fix, because a body is the indivisible unit of a chunk. Distinct from
    _too_large_error because its advice has to be: this ONE body is the problem.
    Reachable in practice: _viewport_profile coarsens by body COUNT, so a
    one-body document holding a huge imported mesh gets no coarsening at all."""
    worst = max(chunk, key=_body_wire_size)
    label = worst.get("name") or worst.get("id") or "a body"
    print("[rebuild] body %r alone is %s, over the %s frame cap"
          % (label, sysmem.describe(size), sysmem.describe(_MAX_FRAME)),
          file=sys.stderr, flush=True)
    return _err(
        req_id,
        f"The body “{label}” is too detailed to display on its own: it "
        f"came to {sysmem.describe(size)}, over the "
        f"{sysmem.describe(_MAX_FRAME)} limit for a single body. Simplify or "
        "re-import that body at a lower resolution.",
        code=errors_mod.BODY_TOO_LARGE,
    )


def _cancelled_now():
    """Whether THIS task's request has been cancelled, read fresh each call.

    _serialized binds the token to the task context, so a long send loop can
    check between frames without threading the token through. Unlike the
    `cancelled` closures in _run/_run_stall (which capture the token once
    before submitting a pool job), this re-reads it, which is what a caller
    outside the submit path needs."""
    token = _CANCEL.get()
    return bool(token and token["cancelled"])


async def _stream_binary_reply(ws, req_id, res, cancelled=None):
    """Send a successful protocol-2 result as a STREAM of binary frames instead
    of one. Returns True once the head frame is away — from that point the reply
    is committed and the caller must not send anything else.

    Frame 0 (the head) carries every non-body field plus the manifest; frames
    1..N carry contiguous slices of `bodies`. Non-final frames carry
    `status: "chunk"` and no `ok`, so a client that does not understand them
    treats them as informational rather than as the reply — the same rule the
    `building` progress frame already relies on. The final frame carries
    `ok: true` and resolves the request.

    Two properties this depends on, neither of them local:
      * _serialized holds its lock across every send in _dispatch, so two
        streams can never interleave on the wire.
      * _run_stall has already returned before the first frame goes out, so no
        `building` frame can land mid-stream and the worker (which may be
        reaped or respawned at any time) is no longer involved at all.
    Raises _ReplyTooLarge from the head frame only, i.e. before anything is
    sent, so the caller can still fall back."""
    bodies = res.get("bodies") or []
    head = {k: v for k, v in res.items() if k != "bodies"}
    head["manifest"] = [_manifest_entry(b) for b in bodies]
    chunks = list(_chunk_bodies(bodies, _CHUNK_TARGET_BYTES))
    sid = secrets.token_hex(8)

    def envelope(seq, final, result):
        env = {"id": req_id, "stream": {"sid": sid, "seq": seq, "final": final}}
        if final:
            env["ok"] = True
        else:
            env["status"] = "chunk"
        env["result"] = result
        return env

    # Built (and cap-checked) before the first send, so a head that cannot be
    # framed leaves the caller free to answer some other way.
    head_frame = _frame_bytes(envelope(0, not chunks, head), [])
    await ws.send(head_frame)
    del head_frame

    for i, chunk in enumerate(chunks, start=1):
        if cancelled is not None and cancelled():
            # Shaped exactly like _reply_for's cancelled branch, so the client
            # needs no new handling. Without this a user who cancels still waits
            # out the whole reply, after the worker has already been killed.
            await ws.send(json.dumps({
                "id": req_id, "ok": False, "cancelled": True,
                # Same shape as _reply_for's. A cancel landing MID-STREAM is
                # exactly the large-assembly case where cancel matters most, so
                # this hand-built copy must carry the code too.
                "error": {"message": "cancelled", "code": errors_mod.CANCELLED},
            }))
            return True
        take, buffers, buf_meta = _taker()
        result = {"bodies": _pack_bodies(chunk, take), "$buffers": buf_meta}
        try:
            frame = _frame_bytes(envelope(i, i == len(chunks), result), buffers)
        except _ReplyTooLarge as over:
            await ws.send(_body_too_large_error(req_id, chunk, over.size))
            return True
        # One frame alive at a time: this is the whole memory argument for
        # streaming. Awaiting the send between chunks also gives websockets a
        # point to flush, which a single 128 MiB frame never offered.
        await ws.send(frame)
        del frame, buffers, buf_meta, result, take
    return True


async def _send_reply(ws, req_id, res, binary, chunked):
    """Send a rebuild/computeAll result, streamed across frames when the client
    opted into `chunked` and the result is a successful mesh reply.

    Streaming is used for EVERY such reply once opted in, not just large ones: a
    size-conditional path would first run on a user's oversized assembly and
    never in CI. A small reply is simply a head frame plus one chunk."""
    if chunked and binary and "error" not in res and not res.get("resync"):
        try:
            if await _stream_binary_reply(ws, req_id, res, _cancelled_now):
                return
        except _ReplyTooLarge as over:
            await ws.send(_too_large_error(req_id, over.size, len(res.get("bodies") or ())))
            return
        except Exception:
            traceback.print_exc()
            # Fall through to the single-frame path. If this failed while
            # building the head, nothing has been sent and the fallback is the
            # whole reply. If it failed mid-loop the head is already out, and
            # the fallback frame lands on top of a half-received stream — which
            # is safe, because a terminal reply SUPERSEDES a partial stream on
            # the client (see Geometry.dropStream): the caller gets one complete
            # answer either way, rather than a wedged request.
    await ws.send(_reply_bytes(req_id, res, binary))


def _new_pool():
    """Create a fresh single-worker pool and kick off its warm-up.

    Returns None once _env_broken has latched — see _pool_available(), which is
    what turns that back into a live pool if the failure was transient."""
    global _pool_gen, _warm
    if _env_broken:
        return None
    _pool_gen += 1
    gen = _pool_gen
    _warm = None
    if _INIT_ERR is not None:
        try:
            _INIT_ERR.value = b""  # drop the previous generation's traceback
        except Exception:
            pass
    pool = ProcessPoolExecutor(
        max_workers=1, mp_context=_mp_ctx,
        initializer=_worker_init,
        initargs=(_HB, _HB_IDX, _INIT_ERR, _HB_MESH, _HB_MESH_TOTAL),
    )
    try:
        # Submitted at creation to force the lazy spawn — and KEPT, because this
        # future is the only public signal separating an init failure from a
        # mid-op crash (see _worker_came_up).
        fut = pool.submit(_warmup)
    except Exception:
        # Was `except Exception: pass`, so pool creation could never report a
        # problem. Do NOT return None here: a spawn that failed on a momentary
        # ENOMEM is exactly the transient the retry budget is for, and the
        # executor will try again lazily on the next submit.
        _note_init_failure(gen)
        return pool
    _warm = (gen, fut)
    _watch_warmup(fut, gen)
    return pool


def _worker_came_up(gen=None) -> bool:
    """Did the pool's worker finish _worker_init and execute a task?

    concurrent.futures gives us nothing else to go on: an initializer exception
    and a mid-op segfault raise the SAME BrokenProcessPool carrying the SAME
    private `_broken` string, and CPython swallows the initializer's exception
    inside the child. But the warm-up is submitted at pool creation and the
    single worker runs FIFO, so it always completes BEFORE any user job:

        resolved            -> the worker initialised and ran a task
        raised / not done   -> it never got that far  => environment failure

    `gen` is required for correctness, not hygiene: up to MAX_CONNS_PER_IP
    connections can have work in flight, and one worker death breaks EVERY
    in-flight future. Without keying on the generation, the second op to notice
    would read the REPLACEMENT pool's still-pending warm-up, conclude the
    environment is broken, and latch a healthy install."""
    w = _warm
    if w is None:
        return False
    wgen, fut = w
    if gen is not None and gen != wgen:
        return False
    if not fut.done() or fut.cancelled():
        return False
    return fut.exception() is None


def _init_traceback() -> str:
    if _INIT_ERR is None:
        return ""
    try:
        return _INIT_ERR.value.decode("utf-8", "replace")
    except Exception:
        return ""


def _note_init_failure(gen):
    """Record ONE failed bring-up (idempotent per generation) and print the
    worker's real traceback to stderr, which the Rust shell mirrors into
    sidecar.log — the file a bug report uploads."""
    global _env_broken
    if gen in _failed_gens or gen in _reaped_gens:
        return
    _failed_gens.add(gen)
    tb = _init_traceback()
    print(
        "[init] geometry worker failed to start (attempt %d/%d): %s"
        % (len(_failed_gens), MAX_INIT_ATTEMPTS,
           tb or "<no Python traceback — the worker died before it could report "
                 "one; a native library failed to load>"),
        file=sys.stderr, flush=True,
    )
    # An install that demonstrably worked earlier in this session is not an
    # environment failure, whatever just happened — so a post-reap respawn that
    # fails to come up must never brick the session.
    if len(_failed_gens) >= MAX_INIT_ATTEMPTS and not _ever_came_up:
        _env_broken = True
        print("[init] giving up: the geometry worker will not be restarted "
              "again this session.", file=sys.stderr, flush=True)


def _watch_warmup(fut, gen):
    """Report a bring-up outcome as soon as it is known — at LAUNCH, not on the
    user's first rebuild. `gen` is captured so a late watcher cannot attribute
    its failure to a pool that has since been replaced."""
    global _ever_came_up

    async def _w():
        global _ever_came_up
        try:
            await asyncio.wrap_future(fut)
        except Exception:
            # A pool WE killed (job timeout / stall reap) also resolves its
            # pending warm-up with BrokenProcessPool, which is indistinguishable
            # from a failed bring-up. Counting those would let a slow cold start
            # on a healthy machine latch "your install is broken" — and would
            # stop the disk-checkpoint ratchet converging. _note_init_failure
            # skips reaped generations.
            _note_init_failure(gen)
        else:
            _ever_came_up = True
            _failed_gens.clear()  # only CONSECUTIVE failures count

    try:
        asyncio.get_running_loop().create_task(_w())
    except RuntimeError:
        pass  # no loop yet (pool built before serve starts); the op path re-checks


def _pool_available():
    """Ensure there is a pool to submit to, rebuilding if a previous attempt
    left us without one. Returns an error dict when geometry is unavailable.

    `_pool is None` must stay RECOVERABLE: today's code kept the executor object
    on a failed spawn, so the next operation simply retried. Making None
    terminal would let one transient failure disable geometry for the whole
    session with the retry budget unspent."""
    global _pool
    if _env_broken:
        return {"error": {"message": _INIT_FAIL_MSG, "code": errors_mod.ENGINE_UNAVAILABLE}}
    if _pool is None:
        _pool = _new_pool()
    if _pool is None:
        return {"error": {"message": _INIT_FAIL_MSG, "code": errors_mod.ENGINE_UNAVAILABLE}}
    return None


def _on_broken(gen):
    """Turn a BrokenProcessPool into the right reply, and rebuild the pool.

    This is the split the whole change exists for: a worker that never started
    is a broken installation and must say so, while a worker that died mid-op is
    the pre-existing per-operation crash and keeps its message (and its feature
    naming, via _crash_feature)."""
    global _pool
    if _worker_came_up(gen):
        _pool = _new_pool()
        return {"error": {"message": "the geometry kernel crashed on this operation"}}
    if gen != _pool_gen:
        # A peer already handled this generation and rebuilt; don't count it
        # twice or report an environment failure we haven't established.
        return {"error": {"message": "the geometry kernel crashed on this operation"}}
    _note_init_failure(gen)
    _pool = _new_pool()
    return {"error": {"message": _INIT_FAIL_MSG, "code": errors_mod.ENGINE_UNAVAILABLE}}


def _kill_pool(pool):
    """Forcibly terminate a pool's worker process(es) — used to stop a worker that's
    spinning on a runaway OCCT call, since shutdown() alone would wait for it."""
    _reaped_gens.add(_pool_gen)  # a deliberate kill is not a failed bring-up
    try:
        for p in list(getattr(pool, "_processes", {}).values()):
            try:
                p.kill()
            except Exception:
                pass
    finally:
        try:
            pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass


async def _run(loop, fn, *args, timeout=JOB_TIMEOUT):
    """Run a heavy job in the worker pool with a hard timeout. On timeout (runaway
    OCCT) or a worker crash (segfault), recycle the pool and return a clean error
    dict so the socket stays alive and the app keeps working."""
    global _pool
    err = _pool_available()
    if err is not None:
        return err
    gen = _pool_gen  # captured BEFORE submit: a peer may recycle while we wait
    token = _CANCEL.get()
    cancelled = lambda: bool(token and token["cancelled"])
    try:
        fut = loop.run_in_executor(_pool, fn, *args)
        res = await asyncio.wait_for(fut, timeout=timeout)
        # a cancel that lands in the last moments still reports cancelled: the
        # caller has already moved on and must not be handed a surprise result
        return _cancelled_result() if cancelled() else res
    except asyncio.TimeoutError:
        if cancelled():
            return _cancelled_result()  # the pool was killed BY the cancel
        _kill_pool(_pool)
        _pool = _new_pool()
        return {"error": {"message": "operation timed out — geometry too complex or degenerate"}}
    except BrokenProcessPool:
        if cancelled():
            return _cancelled_result()
        return _on_broken(gen)


_EXPORT_SEC_PER_BODY = 0.09  # 4x the measured 22.6 ms/body — see _export_stall_budget


def _export_stall_budget(document):
    """Wall-clock reap budget for an export, in seconds.

    `_run_stall` normally supervises by PROGRESS, which is the right design — but
    the export WRITE (build123d's export_step/export_stl, or Mesher.write) is a
    single atomic OCCT call that holds the GIL, so nothing inside it can bump the
    heartbeat. Supervision therefore degrades to a wall clock here, exactly as it
    already does for `import` below, and for the same reason.

    Left on the default STALL_TIMEOUT this was not a slow path but a BROKEN one:
    the 3,071-body reference assembly writes 1,031.8 MB of STEP in 69.4 s, and
    the 60 s default reaped it at 60.1 s — reporting "the geometry kernel was
    restarted" for a kernel that was working fine, and leaving NO file at the
    path the user chose. `_export_job` ticks once per body while `rebuild_cached`
    runs and then goes silent for the whole write, so the rebuild half never
    protected it.

    Scaled on the document's body count, which is what the write actually costs
    per unit: _EXPORT_SEC_PER_BODY is 4x the measured 22.6 ms/body, floored at the
    old default so a small export keeps its tight guard. Generous at the top is
    safe because Cancel stays live throughout — the frontend wraps export in
    `runBusy`, and the supervisor's 1 s poll honours the cancel token
    independently of the GIL-holding worker."""
    # an import feature carries one `parts` entry per body it explodes to; any
    # other feature contributes at most a body or two
    feats = (document or {}).get("features") or ()
    n = sum(len(f.get("parts") or ()) or 1 for f in feats if isinstance(f, dict))
    return max(STALL_TIMEOUT, _EXPORT_SEC_PER_BODY * n)


def _building_frame(ws, rid):
    """An `on_progress` callback that emits one interim "building" frame.

    The client routes status frames to its progress listeners and never resolves
    the pending call with one. `meshed`/`meshTotal` carry the payload phase's
    real denominator so the timeline can say "meshing 812/3071" instead of
    sitting at 0%. Shared by `rebuild` and `computeAll`, which want the identical
    frame."""
    async def _send(idx, meshed=-1, mesh_total=-1):
        await ws.send(json.dumps(
            {"id": rid, "status": "building", "feature": idx,
             "meshed": meshed, "meshTotal": mesh_total}
        ))

    return _send


def _job_entry(fn, *args):
    """Run a supervised job, announcing in the heartbeat that it has STARTED.

    Field 383e7bfd: "one operation stalled for over 60 s" on a document with
    NOTHING in it — no bodies, no sketches. Two faults compounded to produce it.

    The supervisor's clock used to start at SUBMIT (`last_t` was set right after
    run_in_executor). The pool is max_workers=1 and _warmup is submitted at pool
    creation, so the first job after a pool comes up QUEUES behind a cold
    build123d/OCP import and spent its whole budget without executing a single
    instruction. A job that has not started cannot have stalled. Worse, the reap
    recycles the pool, which submits a fresh warm-up, so the retry queues behind
    another cold import: a spiral rather than a one-off.

    The second fault is why an EMPTY document is the shape that surfaced it. The
    heartbeat's only writer is `builder.on_feature_tick`, which fires per feature
    and per tessellated body — a zero-feature rebuild never ticked at all, so
    nothing could reset the clock and STALL_TIMEOUT degenerated into a plain wall
    clock over queue plus execution.

    One tick here fixes both: _run_stall resets its clock whenever the counter
    moves, so the budget measures EXECUTION stall, and an empty document gets the
    one tick it could never otherwise produce. It deliberately does NOT touch
    _HB_IDX — no feature is in progress yet, and -1 already means "none".

    This does not lengthen the budget. A job that starts and then wedges still
    stops ticking and is still reaped after STALL_TIMEOUT; only the clock's
    origin moves, from when the job was queued to when it began."""
    if _HB is not None:
        _HB.value += 1
    return fn(*args)


async def _run_stall(loop, fn, *args, stall=STALL_TIMEOUT, on_progress=None):
    """Run a rebuild-class job supervised by PROGRESS instead of wall clock: kill
    the worker only when the shared heartbeat hasn't moved for `stall` seconds.
    A 10k-feature cold build can legitimately run for minutes and is never
    reaped while it makes progress; a single wedged OCCT call stops ticking and
    gets reaped, and the disk checkpoints turn that into a ratchet (the retry
    resumes from the last checkpoint, so it converges to a reported error on
    the one bad feature instead of a death spiral). `on_progress` (async, takes
    the current feature index) is fired roughly once a second while the job
    runs — the rebuild path streams it to the frontend as building frames."""
    global _pool
    err = _pool_available()
    if err is not None:
        return err
    # Submit is INSIDE the try below via gen capture: a pool that is already
    # broken raised BrokenProcessPool straight out of run_in_executor, past
    # _crash_feature and into handle()'s catch-all, shipping raw CPython text.
    gen = _pool_gen
    token = _CANCEL.get()
    cancelled = lambda: bool(token and token["cancelled"])
    try:
        fut = loop.run_in_executor(_pool, _job_entry, fn, *args)
    except BrokenProcessPool:
        if cancelled():
            return _cancelled_result()
        return _on_broken(gen)
    last = _HB.value if _HB is not None else 0
    last_t = loop.time()
    # The pool's warm-up, if this job was submitted before it finished. With
    # max_workers=1 a job submitted while _warmup still holds the worker cannot
    # start, and time it spends WAITING must not be charged to its stall budget —
    # see _job_entry for the field report this comes from.
    warm = _warm[1] if _warm is not None and _warm[0] == gen else None
    while True:
        try:
            res = await asyncio.wait_for(asyncio.shield(fut), timeout=1.0)
            return _cancelled_result() if cancelled() else res
        except asyncio.TimeoutError:
            # cancel kills the pool, which usually surfaces as BrokenProcessPool
            # below — but the 1s poll can land first, so check here too
            if cancelled():
                fut.cancel()
                return _cancelled_result()
            if on_progress is not None:
                try:
                    await on_progress(
                        int(_HB_IDX.value) if _HB_IDX is not None else -1,
                        int(_HB_MESH.value) if _HB_MESH is not None else -1,
                        int(_HB_MESH_TOTAL.value) if _HB_MESH_TOTAL is not None else -1,
                    )
                except Exception:
                    pass  # a dropped progress frame must never kill the build
            if _HB is not None:
                cur = _HB.value
                if cur != last:
                    last, last_t = cur, loop.time()
                    continue
            # Still queued behind the worker's cold start: hold the clock at now
            # rather than reaping a job that has not run an instruction. A broken
            # bring-up is NOT silently waited on forever — it resolves this future
            # with BrokenProcessPool, which the handler below already owns.
            if warm is not None and not warm.done():
                last_t = loop.time()
                continue
            if loop.time() - last_t > stall:
                # Say so in the log. This watchdog previously recycled the pool
                # and returned its message to the UI without printing a thing,
                # so a 0.1.111 field report of exactly this stall arrived with a
                # 179-byte log holding only "LISTENING 8765" — the one event
                # worth diagnosing left no trace anywhere. The heartbeat index is
                # the feature the worker was on, and it is all that survives.
                idx = int(_HB_IDX.value) if _HB_IDX is not None else -1
                print(
                    f"STALL: no worker heartbeat for {int(stall)}s while running "
                    f"{getattr(fn, '__name__', fn)!r} (feature index {idx}) — "
                    "recycling the worker pool",
                    flush=True,
                )
                _kill_pool(_pool)
                _pool = _new_pool()
                fut.cancel()
                return {"error": {"message": (
                    "one operation stalled for over %d s — the geometry kernel was "
                    "restarted; progress up to the last checkpoint is kept"
                ) % int(stall), "code": errors_mod.STALLED}}
        except BrokenProcessPool:
            if cancelled():
                return _cancelled_result()  # the pool was killed BY the cancel
            # Read the heartbeat BEFORE recycling: it holds the index of the
            # feature the worker was building when it died, which is the only
            # clue that survives a segfault (the worker leaves no traceback).
            # Without it the app showed a bare ": the geometry kernel crashed",
            # naming nothing — see _crash_feature().
            idx = int(_HB_IDX.value) if _HB_IDX is not None else -1
            res = _on_broken(gen)
            # feature_index only means anything for a real op crash; on an
            # environment failure there is no culprit feature to name, and
            # _crash_feature would rewrite the message into "your shape is
            # degenerate" — the exact misattribution this change removes.
            if res.get("error", {}).get("message") != _INIT_FAIL_MSG:
                res["error"]["feature_index"] = idx
            return res


def _crash_feature(res, document):
    """Name the feature a crashed/stalled worker died on.

    OCCT segfaults inside native code, so there is no exception and no
    traceback to attribute — only the heartbeat index the worker last published.
    Map it back to a real feature id so the error names the culprit and the
    timeline can chip it, instead of reporting a nameless kernel crash.
    """
    if (res or {}).get("cancelled"):
        return res  # a cancel is not a crash; don't attribute it to a feature
    err = (res or {}).get("error")
    if not isinstance(err, dict):
        return res
    idx = err.pop("feature_index", -1)
    feats = ((document or {}).get("features") or [])
    if not (isinstance(idx, int) and 0 <= idx < len(feats)):
        return res
    f = feats[idx] or {}
    fid, ftype = f.get("id"), (f.get("name") or f.get("type") or "feature")
    if fid:
        err["feature_id"] = fid
    err["message"] = (
        f"{ftype} crashed the geometry kernel — this shape is degenerate for OCCT "
        "(often a cut that runs exactly tangent to a fillet); try a slightly "
        "different value"
    )
    # ALSO write it to stderr, which is mirrored into <app_data>/sidecar.log —
    # the file the bug reporter uploads. A segfaulted worker leaves no traceback,
    # so without this line a field report contains no evidence the kernel died at
    # all; the only record was a toast the user has probably dismissed.
    print(
        f"[crash] worker died building feature {fid} ({ftype}) at index {idx}: "
        f"{json.dumps(f, default=str)[:800]}",
        file=sys.stderr, flush=True,
    )
    return res


def _authorized(request) -> bool:
    """True iff the request carries the per-launch shared secret (and, when a
    browser supplies an Origin, a Tauri one). The token stops local processes
    and DNS-rebinding pages; the origin check stops a page that somehow learned
    the token."""
    if not _TOKEN:
        return False
    q = urllib.parse.urlparse(request.path).query
    tok = urllib.parse.parse_qs(q).get("token", [""])[0]
    if not hmac.compare_digest(tok, _TOKEN):  # constant-time compare
        return False
    origin = request.headers.get("Origin", "")
    if origin and origin not in ALLOWED_ORIGINS:
        # Loud on stderr (mirrored to sidecar.log): a silent origin rejection
        # looked like a healthy-but-unreachable sidecar for three field reports
        # straight — the Windows webview origin was missing from the allowlist.
        print(f"[auth] rejected WS handshake from origin {origin!r} "
              f"(allowed: {sorted(ALLOWED_ORIGINS)})", file=sys.stderr, flush=True)
        return False
    return True


def _mint_token() -> str:
    """Manual `python server.py` (no SINDRI_SIDECAR_TOKEN env): mint one and
    print it on stdout so a prober can read it and append ?token=… to its URL."""
    t = secrets.token_urlsafe(32)
    print(f"TOKEN {t}", flush=True)
    return t


# The shape each op's payload must have before ANY work starts. Keyed by op and
# kept adjacent to _dispatch on purpose, so the two are read together — a field
# quietly dropped from a row here is the one drift nothing else catches.
#
# WHY: every branch of _dispatch below indexes its payload directly (req["document"],
# req["path"], …) and _serialized's catch-all turns whatever that raises into
# `_err(req_id, str(ex))`. So nothing hangs and nothing dies — but a malformed
# request came back as `ok:false` with NO code and a raw CPython internal in the
# message: "'int' object has no attribute 'get'", "'document'", "stat: path
# should be string, bytes, os.PathLike or integer". 33 of 56 malformed shapes
# answered that way. Prose is fine for a human reading a toast and useless to
# anything that has to branch, which is exactly what errors.BAD_REQUEST exists
# for — massProperties and query already used it, the other twelve did not.
#
# Each row is (field, accepted types, required). `rebuild`'s document MUST stay
# OPTIONAL: the normal client path sends {baseRevision, revision, ops} with no
# document at all (client.ts rebuild()), and requiring it would break every
# incremental rebuild in the app. Those three fields need rows of their OWN for
# the same reason — a reviewer measured that closing the `document` door alone
# left the delta door wide open, and the delta is the door the app uses on every
# incremental rebuild. See _malformed_ops.
_REQUIRED_FIELDS = {
    "rebuild": (
        ("document", dict, False),
        ("ops", dict, False),
        ("baseRevision", int, False),
        ("revision", int, False),
    ),
    "computeAll": (("document", dict, True), ("revision", int, False)),
    "export": (("document", dict, True), ("format", str, True), ("path", str, True)),
    "exportProject": (("document", dict, True), ("path", str, True)),
    "massProperties": (("document", dict, True),),
    "query": (("document", dict, True),),
    "interference": (("document", dict, True),),
    # PlaneSpec is Plane3 | PlaneDef (types.ts), so a bare "XY" is legal here
    "projectGeometry": (("document", dict, True), ("plane", (dict, str), True)),
    "import": (("path", str, True), ("format", str, True)),
    "migrateGeometry": (("items", list, False),),
    "tessellateText": (("entity", dict, True),),
    "listFonts": (),
    "ping": (),
    "cancel": (),
}


def _malformed_ops(op, ops):
    """Prose describing why this delta `ops` cannot be served, or None.

    Split out of _malformed because the delta is what the app actually sends on
    EVERY incremental rebuild — client.ts falls back to a whole document only
    when the delta would be bigger — and because a reviewer measured this door
    still open after the `document` one was closed. `{"length": 1, "set": [[0,
    7]]}` passed every check there was, was written into the worker's held
    document, and took the revision with it: the good document at the good
    revision was gone, and the refusal came back UNCODED as "'int' object has no
    attribute 'get'" from builder.py.

    The ops vocabulary is client.ts's RebuildDeltaPayload: {length, set,
    parameters?, bodyVisibility?}, where `set` is a list of [index, Feature]
    pairs. Unknown keys are deliberately not rejected — the server ignores them,
    and refusing them would make an older sidecar refuse a newer client."""
    if "length" in ops:
        n = ops["length"]
        if not isinstance(n, int) or isinstance(n, bool) or n < 0:
            return f"{op}: ops.length must be a non-negative integer"
    for key in ("parameters", "bodyVisibility"):
        if key in ops and not isinstance(ops[key], dict):
            return f"{op}: ops.{key} must be an object"
    if "set" in ops:
        entries = ops["set"]
        if not isinstance(entries, list):
            return f"{op}: ops.set must be a list"
        declared = ops.get("length")
        for k, entry in enumerate(entries):
            if not isinstance(entry, (list, tuple)) or len(entry) != 2:
                return f"{op}: ops.set[{k}] must be [index, feature]"
            i, f = entry
            if not isinstance(i, int) or isinstance(i, bool) or i < 0:
                return f"{op}: ops.set[{k}][0] must be a non-negative integer"
            # The only bound checkable HERE is the length the client itself
            # declared: the document being patched lives in the worker process,
            # so an index past its real end is caught in _apply_doc_ops and
            # answered with a resync.
            if isinstance(declared, int) and not isinstance(declared, bool) and i >= declared:
                return f"{op}: ops.set[{k}][0] is past ops.length"
            # Every feature reader in builder.py starts with `f.get("type")`,
            # which is exactly how a non-object here became CPython prose.
            if not isinstance(f, dict):
                return f"{op}: ops.set[{k}][1] must be an object"
    return None


def _malformed(op, req):
    """Prose describing why this payload cannot be served, or None if it can.

    An op with no row is left alone: an unknown op still falls through to the
    unknownOp answer at the bottom of _dispatch, which is the capability probe."""
    spec = _REQUIRED_FIELDS.get(op)
    if spec is None:
        return None
    for field, types, required in spec:
        if field not in req:
            if required:
                return f"{op}: missing {field}"
            continue
        value = req[field]
        # ABSENT and PRESENT-BUT-NULL are different, and conflating them is what
        # let `{"op":"rebuild","document":null}` through: this function skipped
        # it as "not supplied", but _dispatch builds its payload with
        # `if k in req`, so the null reached _apply_doc_ops and overwrote the
        # retained delta document with None — the same wipe-the-state-from-a-
        # malformed-request class the features guard below exists to close.
        # Both notions of "present" must agree, so null is refused here.
        if value is None:
            return f"{op}: {field} must not be null"
        if not isinstance(value, types):
            names = getattr(types, "__name__", None) or "/".join(t.__name__ for t in types)
            return f"{op}: {field} must be {names}"
        # A NUL can never be part of a filename or a format id, and it does not
        # fail politely: os.stat raises ValueError("embedded null character"),
        # which is NOT the OSError the import path catches, so it escaped to the
        # catch-all and reached the client as raw CPython prose.
        if isinstance(value, str) and "\x00" in value:
            return f"{op}: {field} must not contain a null character"
        # Every list field on the wire today (query/migrateGeometry `items`) is a
        # list of OBJECTS, and every reader starts with `.get(...)` on the
        # element. A list of scalars therefore dies exactly the way a document
        # full of scalars did.
        if isinstance(value, list):
            bad = next((i for i, e in enumerate(value) if not isinstance(e, dict)), None)
            if bad is not None:
                return f"{op}: {field}[{bad}] must be an object"
        if field == "document":
            # A document whose `features` is not a list used to be ACCEPTED into
            # the retained delta state (_apply_doc_ops stores payload["document"]
            # unconditionally), so the next rebuild sent WITHOUT a document —
            # the normal delta path — replayed the poison and failed the same
            # way. Refusing up front keeps a rejected document out of that state.
            #
            # The ELEMENTS are checked too, not just the outer list: a
            # `{"features": [7]}` is a list, passed the first version of this
            # guard, and then poisoned the delta state identically — every
            # feature reader in builder.py starts with `f.get("type")`.
            if "features" in value:
                feats = value["features"]
                if not isinstance(feats, list):
                    return f"{op}: document.features must be a list"
                bad = next((i for i, f in enumerate(feats) if not isinstance(f, dict)), None)
                if bad is not None:
                    return f"{op}: document.features[{bad}] must be an object"
            if "parameters" in value:
                if not isinstance(value["parameters"], dict):
                    return f"{op}: document.parameters must be an object"
        if field == "ops":
            bad = _malformed_ops(op, value)
            if bad is not None:
                return bad
    return None


async def _dispatch(ws, loop, req, req_id, op):
    """Run one request and send its reply. Split out of handle() so the read
    loop can stay responsive while this is running — see handle().

    INVARIANT, relied on by the chunked reply path: _serialized holds its lock
    across the whole of this function, INCLUDING every `await ws.send(...)`. A
    streamed reply is several frames that must reach the client contiguously,
    so moving a send outside that lock — or letting two heavy ops run
    concurrently — would splice two documents' bodies together."""
    # Trust boundary: refuse a malformed payload BEFORE any job is scheduled,
    # the same reason exportProject's settings guard and massProperties' bodies
    # guard sit ahead of their work.
    bad = _malformed(op, req)
    if bad is not None:
        await ws.send(_err(req_id, bad, code=errors_mod.BAD_REQUEST))
        return
    if op == "rebuild":
        tol = req.get("tolerance", 0.1)
        payload = {
            k: req[k]
            for k in ("document", "baseRevision", "revision", "ops")
            if k in req
        }

        res = await _run_stall(
            loop, _rebuild_delta_job, payload, tol, req.get("known"),
            on_progress=_building_frame(ws, req_id),
        )
        res = _crash_feature(res, req.get("document"))
        await _send_reply(ws, req_id, res, bool(req.get("binary")), bool(req.get("chunked")))

    elif op == "computeAll":
        tol = req.get("tolerance", 0.1)
        payload = {"document": req["document"], "revision": req.get("revision")}
        res = await _run_stall(loop, _compute_all_job, payload, tol,
                               on_progress=_building_frame(ws, req_id))
        res = _crash_feature(res, req.get("document"))
        await _send_reply(ws, req_id, res, bool(req.get("binary")), bool(req.get("chunked")))

    elif op == "export":
        res = await _run_stall(loop, _export_job, req["document"], req["format"], req["path"], req.get("body"), req.get("separate", False), req.get("palette") or [], req.get("bodyColors") or {}, stall=_export_stall_budget(req["document"]))
        await ws.send(_reply_for(req_id, res))

    elif op == "exportProject":
        # settings is written into the 3MF verbatim (project config for
        # the slicer); cap its size like any untrusted request field.
        settings = req.get("settings") or {}
        if not isinstance(settings, dict) or len(json.dumps(settings)) > 262144:
            await ws.send(_err(req_id, "exportProject: bad settings",
                                code=errors_mod.BAD_REQUEST))
            return
        res = await _run_stall(
            loop, _export_project_job, req["document"], req["path"],
            req.get("palette") or [], req.get("bodyColors") or {},
            req.get("bodyNames") or {}, settings,
            stall=_export_stall_budget(req["document"]),
        )
        await ws.send(_reply_for(req_id, res))

    elif op == "massProperties":
        # Validate BEFORE the job, like exportProject's settings guard: this is a
        # trust boundary, and a rebuild is far too expensive to spend on input
        # that was never going to be usable.
        ids = req.get("bodies")
        if ids is not None and (
            not isinstance(ids, list)
            or len(ids) > 20000
            or not all(isinstance(i, str) and len(i) <= 128 for i in ids)
        ):
            await ws.send(_err(req_id, "massProperties: bad bodies",
                               code=errors_mod.BAD_REQUEST))
            return
        # A whole-document measure with checks on runs for minutes on a large
        # assembly while holding the dispatch lock. Without a progress frame that
        # is total silence, which reads as a hang.
        async def _measuring(idx, *_m, _rid=req_id):
            try:
                await ws.send(json.dumps({
                    "id": _rid, "status": "measuring", "feature": idx,
                }))
            except Exception:
                pass  # a dropped progress frame must never fail the work

        res = await _run_stall(loop, _mass_properties_job, req["document"], ids,
                               bool(req.get("checks")), bool(req.get("prefix")),
                               on_progress=_measuring)
        await ws.send(_reply_for(req_id, res))

    elif op == "query":
        # Trust boundary, refused BEFORE any rebuild — the same reasoning as
        # massProperties: a rebuild is far too expensive to spend on input that
        # was never going to be usable.
        items = req.get("items")
        if not isinstance(items, list) or len(items) > 64 or not all(
            isinstance(it, dict) for it in items
        ):
            await ws.send(_err(req_id, "query: bad items", code=errors_mod.BAD_REQUEST))
            return
        res = await _run_stall(loop, _query_job, req["document"], items,
                               bool(req.get("prefix")),
                               # strict is ON unless the caller opts out: the
                               # lazy reading of a reply must be the correct one.
                               req.get("strict", True) is not False)
        await ws.send(_reply_for(req_id, res))

    elif op == "interference":
        res = await _run_stall(loop, _interference_job, req["document"])
        await ws.send(_reply_for(req_id, res))

    elif op == "import":
        # A one-time import (file read + B-rep build) runs far longer than a
        # rebuild. Two things matter here:
        #
        # 1. The budget is SIZE-DERIVED, never a constant. A 356 MiB STEP
        #    measured 193 s end to end (90.6 s read, 93.9 s canonicalize), so a
        #    flat 90 s reaps a legitimate import. max() keeps it from ever being
        #    SHORTER than the old deadline for the files that already worked.
        # 2. It goes through _run_stall for on_progress, but with an EXPLICIT
        #    stall=. The default STALL_TIMEOUT is 60 s and OCP holds the GIL for
        #    the whole read, so nothing can bump the heartbeat — left at the
        #    default this would reap a working import 30 s EARLIER than the old
        #    flat 90 s. The stall reaper cannot observe liveness through an
        #    atomic OCCT call, so here `stall` is simply the wall clock.
        try:
            _sz = os.path.getsize(req["path"]) / (1024 * 1024)
        except OSError:
            _sz = 0.0
        budget = max(90.0, 60.0 + 1.5 * _sz)
        # The REAPER budget above is deliberately generous, so it is the wrong
        # denominator for a progress bar — using it made a 15.7 s import crawl to
        # 6% and then jump to done. `eta` is a separate, deliberately tighter
        # ESTIMATE: ~0.5 s/MiB, measured at 0.41 s/MiB on a 38 MiB file and
        # 0.54 s/MiB on the 356 MiB reference. Under-estimating is the safe
        # direction — the bar reaches its phase cap and waits, which reads as
        # "nearly there" rather than "stuck at 6%".
        eta = max(3.0, 0.5 * _sz)

        # The progress origin has to be PER PHASE, not per request. `_t0` used to
        # be bound once as a default argument, so `frac` measured total elapsed
        # time: by the time a later phase started, frac was already pinned at its
        # 0.95 cap and the bar jumped straight to that phase's ceiling instead of
        # creeping through it. Publishing phases on the mesh path without fixing
        # this would have moved the STL freeze from 44% to 93% — which reads
        # worse, because 93% looks nearly done. The same discontinuity was
        # visible on the STEP path.
        _ph = {"i": -1, "t": loop.time()}

        async def _importing(code, *_mesh, _rid=req_id, _b=eta):
            # *_mesh swallows the meshing counters _run_stall passes positionally
            # (an import does not mesh). Without it they would bind to _rid/_b
            # and corrupt every import frame.
            i = code if 0 <= code < len(_IMPORT_PHASES) else 0
            if i != _ph["i"]:
                _ph["i"], _ph["t"] = i, loop.time()
            base = sum(w for _, w in _IMPORT_PHASES[:i])
            label, w = _IMPORT_PHASES[i]
            # Nothing is observable INSIDE a phase (the GIL is held), so creep on
            # time elapsed SINCE THIS PHASE BEGAN and never let it reach the next
            # phase's floor. The denominator stays the whole-import estimate
            # rather than this phase's share: dividing by `_b * w` makes a phase
            # that overruns its share hit the 0.95 cap early and then sit there
            # (measured: a 12 s phase against a 4.9 s share plateaus at 93% for
            # 7 s), which is the frozen-bar complaint again. Under-shooting keeps
            # it moving.
            frac = min(0.95, max(0.0, (loop.time() - _ph["t"]) / _b))
            await ws.send(json.dumps({
                "id": _rid, "status": "importing",
                "phase": i, "label": label,
                "pct": int(100 * min(0.99, base + w * frac)),
            }))

        res = await _run_stall(
            loop, _import_job, req["path"], req["format"],
            stall=budget, on_progress=_importing,
        )
        await ws.send(_reply_for(req_id, res))

    elif op == "listFonts":
        res = await _run(loop, _list_fonts_job, timeout=JOB_TIMEOUT)
        await ws.send(_reply_for(req_id, res))

    elif op == "tessellateText":
        res = await _run(loop, _tessellate_text_job, req["entity"], req.get("pathEntity"), timeout=JOB_TIMEOUT)
        await ws.send(_reply_for(req_id, res))

    elif op == "projectGeometry":
        # Usually a warm prefix-cache hit, but a cold start replays the whole
        # prefix like export/interference do — and that replay ticks, so a long
        # one is no longer mistaken for a hang.
        res = await _run_stall(
            loop, _project_geometry_job, req["document"], req["plane"],
            req.get("sources") or [],
        )
        await ws.send(_reply_for(req_id, res))

    elif op == "migrateGeometry":
        # One-way v4 -> v5: the document still carries inline base64, so nothing
        # is lost if this never runs. JOB_TIMEOUT and a WALL CLOCK, not stall
        # supervision: this decodes a bounded list of already-embedded blobs, it
        # does not rebuild, so it has no heartbeat to supervise.
        res = await _run(loop, _migrate_geometry_job, req.get("items") or [], timeout=JOB_TIMEOUT)
        await ws.send(_reply_for(req_id, res))

    elif op == "ping":
        await ws.send(_ok(req_id, {"pong": True}))

    else:
        await ws.send(_err(req_id, f"unknown op: {op}", code=errors_mod.UNKNOWN_OP))


async def _serialized(ws, loop, req, req_id, op, lock, running):
    """One heavy op, serialized against its peers, with a cancel token bound to
    this task's context so _run/_run_stall can see it."""
    try:
        async with lock:
            token = {"cancelled": False}
            _CANCEL.set(token)
            running["id"] = req_id
            running["token"] = token
            try:
                await _dispatch(ws, loop, req, req_id, op)
            finally:
                running["id"] = None
                running["token"] = None
    except asyncio.CancelledError:
        raise
    except Exception as ex:
        try:
            # Preserve a code the exception already carries. This catch-all is
            # the LAST place one can be lost, and it was losing them: a job that
            # raises rather than returning an error dict (exporters' unknown
            # format, builder's unsupported import format — both raise a coded
            # GeomError) came out the other side as uncoded prose, which made
            # coding those raise sites inert. Same rule as _error_from, which
            # covers the jobs that catch instead of raising.
            await ws.send(_err(req_id, str(ex) or type(ex).__name__,
                               code=errors_mod.code_of(ex)))
        except Exception:
            pass


def _cancel_running(running, target=None):
    """Stop the job in flight. A ProcessPoolExecutor job cannot be interrupted
    any other way, so this kills the worker exactly as the timeout path does and
    hands back a fresh pool. The token tells _run/_run_stall that the resulting
    BrokenProcessPool is a CANCEL, not a crash — otherwise a user pressing
    Cancel would be told the geometry kernel crashed.

    `target` (a request id) cancels only that request; None cancels whatever is
    running. Returns whether anything was actually stopped."""
    global _pool
    token = running.get("token")
    if token is None:
        return False
    if target is not None and running.get("id") != target:
        return False
    token["cancelled"] = True
    pool = _pool
    if pool is not None:
        _kill_pool(pool)
        _pool = _new_pool()
    return True


async def handle(ws):
    peer = ws.remote_address[0] if ws.remote_address else None
    if peer is not None:
        if _ip_conns.get(peer, 0) >= MAX_CONNS_PER_IP:
            await ws.close(code=1008, reason="too many connections")
            return
        _ip_conns[peer] = _ip_conns.get(peer, 0) + 1
    # Bound BEFORE the try: the finally below iterates `tasks`, and the
    # unauthorized path returns before any assignment inside the try. Leaving
    # these to be assigned later made that finally raise UnboundLocalError
    # *before* the _ip_conns decrement, so every rejected connection burned a
    # slot permanently — MAX_CONNS_PER_IP bad tokens and the sidecar refuses
    # everyone, including the real webview, until it is restarted.
    lock = asyncio.Lock()
    running: dict = {"id": None, "token": None}
    tasks: set = set()
    try:
        if not _authorized(ws.request):
            await ws.close(code=1008, reason="unauthorized")
            return
        loop = asyncio.get_running_loop()
        # Heavy ops stay STRICTLY serialized (the shared heartbeat counter and
        # the rebuild cache both assume one job at a time) — the lock preserves
        # that, while dispatching as tasks keeps the read loop free.
        async for raw in ws:
            try:
                req = json.loads(raw)
            except Exception as ex:
                await ws.send(_err(None, f"bad JSON: {ex}"))
                continue
            # Valid JSON is not necessarily a REQUEST. `req.get("id")` below
            # raises AttributeError on a list/string/number/null frame, outside
            # any try, which tore the whole connection down with a bare 1011 and
            # no reply — taking every other in-flight request on that socket with
            # it. Measured: `[1,2,3]` closed the socket; the process survived,
            # the conversation did not.
            if not isinstance(req, dict):
                await ws.send(_err(None, "request must be a JSON object",
                                   code=errors_mod.BAD_REQUEST))
                continue

            req_id = req.get("id")
            op = req.get("op")
            if True:
                # Control ops answer on the READ path so they are never queued
                # behind a running job. That is the whole point: an import can
                # hold the worker for 100+ seconds, and cancel has to be heard
                # DURING it, not after.
                if op == "cancel":
                    hit = _cancel_running(running, req.get("target"))
                    await ws.send(_ok(req_id, {"cancelled": hit}))
                    continue

                task = asyncio.create_task(
                    _serialized(ws, loop, req, req_id, op, lock, running)
                )
                tasks.add(task)
                task.add_done_callback(tasks.discard)
    finally:
        for t in list(tasks):
            t.cancel()
        if peer is not None:
            _ip_conns[peer] = _ip_conns.get(peer, 0) - 1
            if _ip_conns[peer] <= 0:
                _ip_conns.pop(peer, None)


async def main():
    global _pool, _mp_ctx, _TOKEN, _HB, _HB_IDX, _INIT_ERR, _HB_MESH, _HB_MESH_TOTAL
    _die_with_parent()
    _TOKEN = os.environ.get("SINDRI_SIDECAR_TOKEN") or _mint_token()
    _mp_ctx = mp.get_context("spawn")
    _HB = _mp_ctx.Value("Q", 0)  # heartbeat: bumped by the worker per feature
    _HB_IDX = _mp_ctx.Value("q", -1)  # which feature is building (-1 = meshing)
    # meshing progress; -1/-1 means "not meshing" (see the _HB_MESH comment above)
    _HB_MESH = _mp_ctx.Value("q", -1)
    _HB_MESH_TOTAL = _mp_ctx.Value("q", -1)
    # lock=False deliberately: a locked Array could deadlock the parent's read if
    # _kill_pool SIGKILLs a worker mid-write. One writer (the dying worker), one
    # reader (us, after it is dead) — the same reasoning as _HB's single-writer
    # comment. A raw c_char array still supports .value.
    _INIT_ERR = _mp_ctx.Array("c", 16384, lock=False)
    _pool = _new_pool()
    try:
        # Raise the per-message cap well above the 1 MiB default: a rebuild ships
        # the WHOLE document, and a document with an imported mesh embeds that
        # body as a (potentially multi-MB) BREP string — at the default limit the
        # server would slam the connection shut on the first real import, which
        # the frontend sees as a permanent "connecting to sidecar". 128 MiB is
        # plenty for a multi-body doc of imported meshes (each capped at 64 MiB
        # decoded by builder.py) while bounding a single message's memory cost.
        # compression=None: the socket is 127.0.0.1-only, so permessage-deflate
        # (the websockets default) buys no bandwidth and costs real CPU both
        # sides — measured 84ms to deflate one 5MB mesh reply.
        bound = False
        try:
            async with websockets.serve(handle, HOST, PORT, max_size=_MAX_FRAME,
                                        compression=None):
                bound = True
                # readiness signal the Rust shell waits for before connecting
                print(f"LISTENING {PORT}", flush=True)
                await asyncio.Future()  # run forever
        except OSError as e:
            if bound:
                raise  # already serving; this is not a bind failure, do not mislabel it
            # Almost always "address already in use": a second copy of the app, a
            # sidecar orphaned by a previous run, or an unrelated program sitting on
            # the port. Whatever the cause, the user needs the PORT named — the Rust
            # shell used to report only "exit code 1", which told a field reporter
            # nothing (bug 2c0cd78a). errno is deliberately not matched: EADDRINUSE
            # is 98 on Linux and 10048 on Windows, and every bind failure means the
            # same thing here.
            # The FATAL line is repeated verbatim by the Rust shell into a toast, so
            # it stays short and readable; the raw OSError (which restates the address
            # twice) goes on the following line, for sidecar.log only.
            print(f"FATAL: cannot open port {PORT} on {HOST}", file=sys.stderr, flush=True)
            print(f"  bind failed: {e}", file=sys.stderr, flush=True)
            sys.exit(EXIT_PORT_IN_USE)
    finally:
        _kill_pool(_pool)



if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
