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
OCCT itself meshes and booleans in PARALLEL across all cores (occt_smp.configure),
so one worker already saturates the CPU — hence a single worker (max_workers=1),
which also avoids oversubscribing the OCCT thread pool. We use the 'spawn' start
method so the worker is a clean interpreter (fork + OCCT's threads can deadlock).

Lifecycle: on Linux we ask the kernel to SIGTERM us if our parent (the Tauri
shell) dies (PR_SET_PDEATHSIG), so we never orphan. We print `LISTENING <port>`
on stdout once bound, which the Rust shell waits for before opening the webview.
"""

import asyncio
import ctypes
import hashlib
import hmac
import json
import multiprocessing as mp
import os
import secrets
import signal
import struct
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import numpy as np

import websockets

import occt_smp

HOST = "127.0.0.1"
# Env-overridable so a test/benchmark instance can run beside the app's own
# sidecar without stealing its port.
PORT = int(os.environ.get("SINDRI_SIDECAR_PORT", "8765"))

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
    "tauri://localhost",
    "https://tauri.localhost",
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
# Document-scaled ops (rebuild / export / interference re-run the whole feature
# history) get a roomier budget: a long document's COLD rebuild legitimately
# exceeds JOB_TIMEOUT (measured 26s at 125 features on the DDR model), and a
# timeout there is self-perpetuating — it recycles the worker, which clears the
# incremental cache, so every retry is cold again. 120s still catches runaways.
DOC_TIMEOUT = 120.0
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


# --- worker process (separate interpreter) ---------------------------------


def _worker_init(hb=None, hb_idx=None):
    """Runs once when a worker process starts: die with the server (anti-orphan),
    pin OCCT to all cores, and warm the heavy imports so the first real rebuild
    isn't paying build123d's import cost. `hb` is the shared heartbeat counter;
    the rebuild loop bumps it per feature so the supervisor can distinguish a
    long build (fine) from a wedged one (reap). `hb_idx` carries WHICH feature
    is being built (-1 = tessellation), so the supervisor can stream progress
    frames to the frontend during a long build."""
    _die_with_parent()  # SIGTERM the worker if the server process dies
    occt_smp.configure()
    import builder  # noqa: F401  (warm the import)
    import tessellate  # noqa: F401

    # Warm the OCCT font subsystem (~1.6 s cold on the first glyph build) at startup so
    # the user's first sketch-text/tessellateText isn't laggy.
    try:
        builder._text_faces({"text": "A", "height": 1}, lambda x: x)
    except Exception:
        pass

    if hb is not None:
        def _tick(i):
            hb.value += 1  # single writer (this worker); no lock needed
            if hb_idx is not None:
                hb_idx.value = i

        builder.on_feature_tick = _tick


def _warmup():
    """Trivial task submitted at startup to force the (lazy) worker to spawn and
    run _worker_init now, rather than on the user's first rebuild."""
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

# Wire default (also the literal fallback in the "rebuild"/"computeAll" handlers
# below) — the reference point our size-adaptive scaling is relative to.
_DEFAULT_TOLERANCE = 0.1


def _effective_tolerance(shape, requested):
    """Scale the requested (interactive-viewport) tolerance to this body's size,
    so a 500mm frame doesn't pay for a triangle budget tuned for a 5mm part and a
    5mm part isn't left visibly faceted by a tolerance tuned for the frame.

    effective = clamp(diag / 2500, 0.05, 0.8) * (requested / DEFAULT_TOLERANCE)

    `diag` is the body's bounding-box diagonal (cheap OCCT bbox, no meshing).
    Dividing by 2500 makes a ~250mm-diagonal part (roughly the part the fixed
    0.1mm default was tuned for) land back on 0.1mm; the clamp keeps a 10mm
    bracket from going arbitrarily fine (0.05mm floor) and a multi-metre frame
    from going arbitrarily coarse (0.8mm ceiling). The `requested / DEFAULT`
    factor keeps the wire contract intact: a client that asks for a smaller
    tolerance than the default still gets a proportionally finer mesh for every
    body, not just a fixed absolute value. Deterministic — pure function of
    (bbox, requested), so cache keys built from the result stay stable."""
    from tessellate import bbox

    bb = bbox(shape)
    dx = bb["max"][0] - bb["min"][0]
    dy = bb["max"][1] - bb["min"][1]
    dz = bb["max"][2] - bb["min"][2]
    diag = (dx * dx + dy * dy + dz * dz) ** 0.5
    base = min(max(diag / 2500.0, 0.05), 0.8)
    scale = requested / _DEFAULT_TOLERANCE if _DEFAULT_TOLERANCE else 1.0
    return base * scale


def _body_payload(b, tolerance):
    """Compute (or fetch) the full render payload for one body: positions/indices/
    faceIds (LOCAL ids, offset client-side), faceOwners, per-body edges. Three
    tiers: identity-cached in RAM -> disk mesh artifact (load path: never pays the
    Python readback loop) -> compute + persist.

    `tolerance` is the RAW requested (wire) tolerance; it's immediately rescaled
    to this body's size (see _effective_tolerance) and every cache key below —
    RAM identity cache AND the disk mesh_key — is keyed on that EFFECTIVE value,
    never the raw request. Two bodies of different sizes (or one body whose bbox
    changed) must not share a cache slot keyed by a tolerance neither was actually
    tessellated at.

    A body's mesh also depends on its "_textures" spec list, which the shape
    identity check CANNOT see (texture never mutates body["shape"] — see
    texture.py's module docstring). Both the RAM identity check and the disk
    mesh_key additionally key on a hash of that spec list, so scrubbing a
    texture-only parameter (depth/scale/…) can't serve a stale pre-edit mesh."""
    import pickle
    import uuid as _uuid

    from tessellate import tessellate, edge_polylines_by_body
    from builder import _face_fp, on_feature_tick
    from texture import resolve_body_textures

    bid, sh = b["id"], b.get("shape")
    requested = tolerance
    if b.get("_textures"):
        from texture import CODE_VERSION as _tex_ver
        # code version rides in the key: a texture-algorithm update must not
        # serve meshes displaced by the previous version from the disk cache
        texture_key = "v%d:%s" % (_tex_ver, json.dumps(b.get("_textures"), sort_keys=True))
    else:
        texture_key = None
    ent = _MESH_CACHE.get(bid)
    # RAM hit BEFORE the bbox: _effective_tolerance is a pure function of
    # (shape, requested), so identical shape identity + identical request imply
    # an identical effective tolerance — an unchanged body (the common case
    # during an interactive drag of some OTHER body) skips the OCCT bbox walk
    # entirely instead of paying it on every tick.
    if (
        ent is not None
        and ent["shape"] is sh
        and ent["requested"] == requested
        and ent.get("texture_key") == texture_key
    ):
        return ent
    if sh is not None:
        tolerance = _effective_tolerance(sh, tolerance)

    mesh_key = None
    mk = b.get("meshKey")
    if mk:
        mesh_key = "%s-t%s" % (mk, tolerance)
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
        pos, idx, fids = tessellate(sh, tolerance, textures=textures,
                                    density_cap=VIEWPORT_DENSITY_CAP, normals_out=norm_chunks)
        owners_map = b.get("owners") or {}
        face_owners = [owners_map.get(_face_fp(face)) for face in sh.faces()]
        edges = edge_polylines_by_body([b])
        for e in edges:
            e.pop("id", None)  # ids are assigned client-side after assembly
        payload = {
            "positions": pos, "indices": idx, "faceIds": fids,
            "faceOwners": face_owners, "edges": edges,
            "faceCount": (max(fids) + 1) if fids else 0,
        }
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
        if mesh_key and build_ms >= _MESH_PERSIST_MIN_MS:
            try:
                import geomstore
                geomstore.default_store().put_mesh(mesh_key, pickle.dumps(payload, 5))
            except Exception:
                pass
    ent = {"shape": sh, "requested": requested, "tolerance": tolerance,
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
    Returns the effective document, or None when a resync is needed."""
    if "document" in payload:
        _DOC_STATE["doc"] = payload["document"]
        _DOC_STATE["rev"] = payload.get("revision")
        return _DOC_STATE["doc"]
    if _DOC_STATE["doc"] is None or _DOC_STATE["rev"] != payload.get("baseRevision"):
        return None
    doc = _DOC_STATE["doc"]
    ops = payload.get("ops") or {}
    if "parameters" in ops:
        doc["parameters"] = ops["parameters"]
    if "bodyVisibility" in ops:
        doc["bodyVisibility"] = ops["bodyVisibility"]
    if "length" in ops:
        feats = doc.get("features", [])
        del feats[ops["length"]:]
        while len(feats) < ops["length"]:
            feats.append(None)  # placeholder — must be covered by "set" below
        doc["features"] = feats
    for i, f in ops.get("set", []):
        doc["features"][i] = f
    if any(f is None for f in doc.get("features", [])):
        _DOC_STATE["doc"] = None  # hole the ops didn't fill — force resync
        return None
    _DOC_STATE["rev"] = payload.get("revision")
    return doc


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
    known = known or {}
    t0 = time.monotonic()
    part, errors, bodies = rebuild_cached(document, diagnostics=diag)
    t_rebuild = time.monotonic() - t0
    if errors and part is None and not bodies:
        # nothing built at all — the document is unusable, surface as fatal
        e = errors[0]
        return {"error": {"message": e["message"], "feature_id": e.get("feature_id")}}
    if part is None:
        # no solid yet (e.g. only sketches exist) — not an error; the frontend
        # still renders sketch overlays.
        return {"protocol": 2, "bodies": [], "bbox": None}
    from tessellate import bbox

    live_ids = set()
    out = []
    t0 = time.monotonic()
    for b in bodies:
        if b.get("shape") is None:
            continue
        live_ids.add(b["id"])
        ent = _body_payload(b, tolerance)
        if known.get(b["id"]) == ent["etag"]:
            out.append({"id": b["id"], "name": b["name"], "etag": ent["etag"],
                        "unchanged": True})
        else:
            item = {"id": b["id"], "name": b["name"], "etag": ent["etag"]}
            item.update(ent["payload"])
            out.append(item)
    t_payload = time.monotonic() - t0
    for bid in list(_MESH_CACHE):
        if bid not in live_ids:
            del _MESH_CACHE[bid]  # body deleted/consumed — drop its cache
    # bbox of the merged part walks every solid — on a many-body document this
    # is its own long phase; tick around it so the stall watchdog sees progress.
    from builder import on_feature_tick as _tick_fn
    if _tick_fn is not None:
        try:
            _tick_fn(-1)
        except Exception:
            pass
    t0 = time.monotonic()
    doc_bbox = bbox(part)
    t_bbox = time.monotonic() - t0
    if _tick_fn is not None:
        try:
            _tick_fn(-1)
        except Exception:
            pass
    # Phase log for scale diagnosis (large assemblies): shows where a slow
    # build actually spends its time, and correlates with the stall watchdog.
    print(f"[rebuild] features={len(document.get('features', []))} "
          f"bodies={len(out)} rebuild={t_rebuild:.1f}s payloads={t_payload:.1f}s "
          f"bbox={t_bbox:.1f}s",
          flush=True)
    result = {"protocol": 2, "bodies": out, "bbox": doc_bbox}
    if diag:  # only attach when a selector resolved with low confidence
        result["diagnostics"] = diag
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


def _export_job(document, fmt, path, body=None, separate=False):
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
    from tessellate import tessellate
    from texture import resolve_body_textures
    import mesh_writers

    # rebuild_cached, not rebuild: export runs in the SAME long-lived worker as
    # edits, so a warm cache makes this ~0 s instead of a gratuitous full rebuild
    part, errors, bodies = rebuild_cached(document)
    live = [b for b in bodies if b.get("shape") is not None]
    # Export what BUILT, and warn about what didn't — never silently. Refusing
    # to export ANYTHING because one feature errored blocked the whole
    # import-repair→print loop (one stubborn face held nine good bodies
    # hostage). Only a document where nothing built at all is a hard error.
    if errors and part is None and not live:
        e = errors[0]
        return {"error": {"message": e["message"], "feature_id": e.get("feature_id")}}
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
        positions, mindices = [], []
        for b in target_bodies:
            textures = resolve_body_textures(b) if b.get("_textures") else None
            pos, idx, _fids = tessellate(
                b["shape"], tolerance=0.02, angular_tolerance=0.3,
                textures=textures, density_cap=EXPORT_DENSITY_CAP_PER_FACE,
            )
            vbase = len(positions) // 3
            positions.extend(pos)
            mindices.extend(i + vbase for i in idx)
        ntri = len(mindices) // 3
        if ntri > EXPORT_TRIANGLE_HARD_CAP:
            raise ValueError(
                f"textured export too dense ({ntri:,} triangles) — reduce texture scale or depth"
            )
        if ntri > EXPORT_TRIANGLE_WARN:
            warnings.append({"message": f"textured export is very dense ({ntri:,} triangles)"})
        if fmt == "stl":
            mesh_writers.write_stl(positions, mindices, p)
        elif fmt == "3mf":
            mesh_writers.write_plain_3mf(positions, mindices, p)
        else:
            raise ValueError(f"texture is not supported for {fmt} export")
        return p

    if separate:
        if not live:
            return {"error": {"message": "nothing to export — no bodies"}}
        # Prefer the user's sidebar rename (display-only override carried on the
        # document) over the positional default ("Body1"), so exported part files
        # are named the way the user named the bodies.
        names = document.get("bodyNames") or {}
        base, ext = os.path.splitext(path)
        written, used = [], set()
        for b in live:
            label = names.get(b["id"]) or b["name"]
            name = re.sub(r"[^\w.-]+", "_", str(label)).strip("_")
            if not name or set(name) <= {"."}:  # empty or dot-only → no dotfiles
                name = b["id"]
            cand, i = name, 2
            while cand in used:  # keep filenames unique if two bodies share a name
                cand, i = f"{name}_{i}", i + 1
            used.add(cand)
            p = f"{base}-{cand}{ext}"
            if b.get("_textures") and fmt in ("stl", "3mf"):
                _mesh_export([b], p)
            else:
                export(b["shape"], fmt, p)
            written.append(p)
        return _done({"path": path, "paths": written})

    if body:
        tgt = next((b for b in live if b["id"] == body), None)
        if tgt is None:
            return {"error": {"message": f"body '{body}' not found to export"}}
        if tgt.get("_textures") and fmt in ("stl", "3mf"):
            return _done({"path": _mesh_export([tgt], path)})
        return _done({"path": export(tgt["shape"], fmt, path)})

    if any_textured and fmt in ("stl", "3mf"):
        return _done({"path": _mesh_export(live, path)})
    return _done({"path": export(part, fmt, path)})


def _export_project_job(document, path, palette, body_colors, body_names, settings):
    """Worker: rebuild + write an Orca-project 3MF (one object per body, palette
    slot → extruder). Same export-what-built semantics as _export_job: failed
    features become warnings; only zero live bodies is a hard error."""
    from builder import rebuild_cached
    from project3mf import sanitize_inputs, write_project_3mf
    from tessellate import tessellate
    from texture import resolve_body_textures

    part, errors, bodies = rebuild_cached(document)
    live = [b for b in bodies if b.get("shape") is not None]
    if not live:
        if errors:
            e = errors[0]
            return {"error": {"message": e["message"], "feature_id": e.get("feature_id")}}
        return {"error": {"message": "nothing to export — no bodies built yet"}}

    palette, body_colors, body_names = sanitize_inputs(palette, body_colors, body_names)
    meshed = []
    for b in live:
        # Export-grade tolerance — the viewport default (0.1) is visibly faceted
        # on a printed part.
        textures = resolve_body_textures(b) if b.get("_textures") else None
        positions, indices, _face_ids = tessellate(
            b["shape"], tolerance=0.02, angular_tolerance=0.3,
            textures=textures, density_cap=EXPORT_DENSITY_CAP_PER_FACE,
        )
        if not indices:
            continue  # degenerate body with no triangulation — skip, like exports do
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


def _interference_job(document):
    """Worker: rebuild + pairwise interference check among live bodies. Returns
    {"pairs": [...]} — one entry per pair of solids that actually overlap (boolean
    intersection volume above a tiny epsilon), with the overlap volume + bbox so the
    frontend can report and zoom to each clash."""
    from builder import rebuild_cached, _bbox_overlap

    # rebuild_cached for the same reason as _export_job: same worker, warm cache
    part, errors, bodies = rebuild_cached(document)
    live = [b for b in bodies if b.get("shape") is not None]
    # like export: check the bodies that BUILT, warn about what didn't — one red
    # feature must not block clash-checking an otherwise-valid assembly
    if errors and not live:
        e = errors[0]
        return {"error": {"message": e["message"], "feature_id": e.get("feature_id")}}
    pairs = []
    for i in range(len(live)):
        for j in range(i + 1, len(live)):
            a, b = live[i], live[j]
            if not _bbox_overlap(a["shape"], b["shape"]):
                continue  # cheap AABB reject before the (crashable) boolean
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
        return {"error": {"message": str(ex)}}


def _list_fonts_job():
    """Worker: enumerate system font families (read-only)."""
    from builder import list_fonts

    try:
        return list_fonts()
    except Exception as ex:
        return {"error": {"message": str(ex)}}


def _tessellate_text_job(entity, path_entity):
    """Worker: per-glyph 2D outlines for a text entity (read-only preview)."""
    from builder import tessellate_text

    try:
        return tessellate_text(entity, path_entity)
    except Exception as ex:
        return {"error": {"message": str(ex)}}


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


def _err(req_id, message, feature_id=None):
    error = {"message": message or "internal error (no message)"}
    if feature_id is not None:
        error["feature_id"] = feature_id
    return json.dumps({"id": req_id, "ok": False, "error": error})


def _reply_for(req_id, res):
    """Turn a worker result dict into the wire reply (error vs ok)."""
    if "error" in res:
        return _err(req_id, res["error"]["message"], res["error"].get("feature_id"))
    return _ok(req_id, res)


# Binary mesh reply (opt-in via `"binary": true` on rebuild/computeAll requests).
# Wire layout, all integers little-endian:
#   [u32 header_len][header_len bytes UTF-8 JSON header][pad to 4][buf0][buf1]...
# The header is the normal {"id","ok","result"} envelope except each per-body
# mesh array (positions/normals -> f32, indices/faceIds -> u32) is replaced by
# {"$buf": i} referencing result.$buffers[i] = {"dtype","len"} (len = element
# count) in on-wire order; the client computes offsets sequentially. Both
# dtypes are 4 bytes/element, so after the single header pad every buffer is
# 4-aligned for free — INVARIANT: adding a wider dtype requires per-buffer
# padding. f32 is lossless vs today's end state (the client always builds
# Float32BufferAttributes). Everything else (stubs, edges, faceOwners, bbox,
# diagnostics) stays inline JSON in the header.
_WIRE_F32 = np.dtype("<f4")
_WIRE_U32 = np.dtype("<u4")


def _encode_binary_reply(req_id, res):
    """Encode a successful protocol-2 rebuild result as one binary frame.
    Raises on anything unexpected — _reply_bytes falls back to the JSON text
    reply, so an encode bug can never break a rebuild."""
    buffers = []
    buf_meta = []

    def take(vals, dtype, tag):
        arr = np.asarray(vals, dtype=dtype)
        buffers.append(arr.tobytes())
        buf_meta.append({"dtype": tag, "len": int(arr.size)})
        return {"$buf": len(buf_meta) - 1}

    bodies_out = []
    for b in res.get("bodies", []):
        if b.get("unchanged"):
            bodies_out.append(b)
            continue
        nb = dict(b)
        nb["positions"] = take(b["positions"], _WIRE_F32, "f32")
        if "normals" in b:
            nb["normals"] = take(b["normals"], _WIRE_F32, "f32")
        nb["indices"] = take(b["indices"], _WIRE_U32, "u32")
        nb["faceIds"] = take(b["faceIds"], _WIRE_U32, "u32")
        bodies_out.append(nb)

    header_obj = dict(res)
    header_obj["bodies"] = bodies_out
    header_obj["$buffers"] = buf_meta
    header = json.dumps({"id": req_id, "ok": True, "result": header_obj}).encode("utf-8")
    pad = (-len(header)) % 4
    parts = [struct.pack("<I", len(header)), header, b"\x00" * pad]
    parts.extend(buffers)
    return b"".join(parts)


def _reply_bytes(req_id, res, binary):
    """Dispatch a rebuild/computeAll result to its wire form: binary frame when
    the client opted in and the result is a successful mesh reply; the plain
    JSON text reply otherwise (errors, resync, opt-out, or encoder failure)."""
    if not binary or "error" in res or res.get("resync"):
        return _reply_for(req_id, res)
    try:
        return _encode_binary_reply(req_id, res)
    except Exception:
        return _reply_for(req_id, res)


def _new_pool():
    """Create a fresh single-worker pool and kick off its warm-up."""
    pool = ProcessPoolExecutor(
        max_workers=1, mp_context=_mp_ctx, initializer=_worker_init, initargs=(_HB, _HB_IDX)
    )
    try:
        pool.submit(_warmup)  # spawn + warm the worker now
    except Exception:
        pass
    return pool


def _kill_pool(pool):
    """Forcibly terminate a pool's worker process(es) — used to stop a worker that's
    spinning on a runaway OCCT call, since shutdown() alone would wait for it."""
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
    try:
        fut = loop.run_in_executor(_pool, fn, *args)
        return await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        _kill_pool(_pool)
        _pool = _new_pool()
        return {"error": {"message": "operation timed out — geometry too complex or degenerate"}}
    except BrokenProcessPool:
        _pool = _new_pool()
        return {"error": {"message": "the geometry kernel crashed on this operation"}}


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
    fut = loop.run_in_executor(_pool, fn, *args)
    last = _HB.value if _HB is not None else 0
    last_t = loop.time()
    while True:
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout=1.0)
        except asyncio.TimeoutError:
            if on_progress is not None:
                try:
                    await on_progress(int(_HB_IDX.value) if _HB_IDX is not None else -1)
                except Exception:
                    pass  # a dropped progress frame must never kill the build
            if _HB is not None:
                cur = _HB.value
                if cur != last:
                    last, last_t = cur, loop.time()
                    continue
            if loop.time() - last_t > stall:
                _kill_pool(_pool)
                _pool = _new_pool()
                fut.cancel()
                return {"error": {"message": (
                    "one operation stalled for over %d s — the geometry kernel was "
                    "restarted; progress up to the last checkpoint is kept"
                ) % int(stall)}}
        except BrokenProcessPool:
            _pool = _new_pool()
            return {"error": {"message": "the geometry kernel crashed on this operation"}}


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
        return False
    return True


def _mint_token() -> str:
    """Manual `python server.py` (no SINDRI_SIDECAR_TOKEN env): mint one and
    print it on stdout so a prober can read it and append ?token=… to its URL."""
    t = secrets.token_urlsafe(32)
    print(f"TOKEN {t}", flush=True)
    return t


async def handle(ws):
    peer = ws.remote_address[0] if ws.remote_address else None
    if peer is not None:
        if _ip_conns.get(peer, 0) >= MAX_CONNS_PER_IP:
            await ws.close(code=1008, reason="too many connections")
            return
        _ip_conns[peer] = _ip_conns.get(peer, 0) + 1
    try:
        if not _authorized(ws.request):
            await ws.close(code=1008, reason="unauthorized")
            return
        loop = asyncio.get_running_loop()
        async for raw in ws:
            try:
                req = json.loads(raw)
            except Exception as ex:
                await ws.send(_err(None, f"bad JSON: {ex}"))
                continue

            req_id = req.get("id")
            op = req.get("op")
            try:
                if op == "rebuild":
                    tol = req.get("tolerance", 0.1)
                    payload = {
                        k: req[k]
                        for k in ("document", "baseRevision", "revision", "ops")
                        if k in req
                    }

                    async def _building(idx, _rid=req_id):
                        # interim progress frame — the client routes status
                        # frames to its progress listeners and never resolves
                        # the pending call with one
                        await ws.send(json.dumps(
                            {"id": _rid, "status": "building", "feature": idx}
                        ))

                    res = await _run_stall(
                        loop, _rebuild_delta_job, payload, tol, req.get("known"),
                        on_progress=_building,
                    )
                    await ws.send(_reply_bytes(req_id, res, bool(req.get("binary"))))

                elif op == "computeAll":
                    tol = req.get("tolerance", 0.1)
                    payload = {"document": req["document"], "revision": req.get("revision")}

                    async def _building2(idx, _rid=req_id):
                        await ws.send(json.dumps(
                            {"id": _rid, "status": "building", "feature": idx}
                        ))

                    res = await _run_stall(loop, _compute_all_job, payload, tol,
                                           on_progress=_building2)
                    await ws.send(_reply_bytes(req_id, res, bool(req.get("binary"))))

                elif op == "export":
                    res = await _run(loop, _export_job, req["document"], req["format"], req["path"], req.get("body"), req.get("separate", False), timeout=DOC_TIMEOUT)
                    await ws.send(_reply_for(req_id, res))

                elif op == "exportProject":
                    # settings is written into the 3MF verbatim (project config for
                    # the slicer); cap its size like any untrusted request field.
                    settings = req.get("settings") or {}
                    if not isinstance(settings, dict) or len(json.dumps(settings)) > 262144:
                        await ws.send(_err(req_id, "exportProject: bad settings"))
                        continue
                    res = await _run(
                        loop, _export_project_job, req["document"], req["path"],
                        req.get("palette") or [], req.get("bodyColors") or {},
                        req.get("bodyNames") or {}, settings, timeout=DOC_TIMEOUT,
                    )
                    await ws.send(_reply_for(req_id, res))

                elif op == "interference":
                    res = await _run(loop, _interference_job, req["document"], timeout=DOC_TIMEOUT)
                    await ws.send(_reply_for(req_id, res))

                elif op == "import":
                    # a one-time import (mesh read + B-rep build) can run longer than a
                    # rebuild; give it a roomier budget than JOB_TIMEOUT.
                    res = await _run(loop, _import_job, req["path"], req["format"], timeout=90.0)
                    await ws.send(_reply_for(req_id, res))

                elif op == "listFonts":
                    res = await _run(loop, _list_fonts_job, timeout=JOB_TIMEOUT)
                    await ws.send(_reply_for(req_id, res))

                elif op == "tessellateText":
                    res = await _run(loop, _tessellate_text_job, req["entity"], req.get("pathEntity"), timeout=JOB_TIMEOUT)
                    await ws.send(_reply_for(req_id, res))

                elif op == "ping":
                    await ws.send(_ok(req_id, {"pong": True}))

                else:
                    await ws.send(_err(req_id, f"unknown op: {op}"))

            except Exception as ex:
                await ws.send(_err(req_id, str(ex) or type(ex).__name__))
    finally:
        if peer is not None:
            _ip_conns[peer] = _ip_conns.get(peer, 0) - 1
            if _ip_conns[peer] <= 0:
                _ip_conns.pop(peer, None)


async def main():
    global _pool, _mp_ctx, _TOKEN, _HB, _HB_IDX
    _die_with_parent()
    _TOKEN = os.environ.get("SINDRI_SIDECAR_TOKEN") or _mint_token()
    _mp_ctx = mp.get_context("spawn")
    _HB = _mp_ctx.Value("Q", 0)  # heartbeat: bumped by the worker per feature
    _HB_IDX = _mp_ctx.Value("q", -1)  # which feature is building (-1 = meshing)
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
        async with websockets.serve(handle, HOST, PORT, max_size=128 * 1024 * 1024,
                                    compression=None):
            # readiness signal the Rust shell waits for before connecting
            print(f"LISTENING {PORT}", flush=True)
            await asyncio.Future()  # run forever
    finally:
        _kill_pool(_pool)



if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
