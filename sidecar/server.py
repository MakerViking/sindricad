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
import hmac
import json
import multiprocessing as mp
import os
import secrets
import signal
import sys
import urllib.parse
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import websockets

import occt_smp

HOST = "127.0.0.1"
PORT = 8765

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


# Worker-global per-body mesh cache, validated by SHAPE OBJECT IDENTITY: the
# cached entry holds a reference to the exact shape object it was computed from
# (which also keeps id() stable), so `entry["shape"] is body["shape"]` is a sound
# "nothing changed" test — snapshots share shape refs and every mutating feature
# rebinds the body's shape to a new object. A hit skips BRepMesh readback, edge
# polylines, AND faceOwners fingerprinting for that body (the fixed ~1.4 s/edit).
_MESH_CACHE = {}


def _body_payload(b, tolerance):
    """Compute (or fetch) the full render payload for one body: positions/indices/
    faceIds (LOCAL ids, offset client-side), faceOwners, per-body edges. Three
    tiers: identity-cached in RAM -> disk mesh artifact (load path: never pays the
    Python readback loop) -> compute + persist."""
    import pickle
    import uuid as _uuid

    from tessellate import tessellate, edge_polylines_by_body
    from builder import _face_fp, on_feature_tick

    bid, sh = b["id"], b.get("shape")
    ent = _MESH_CACHE.get(bid)
    if ent is not None and ent["shape"] is sh:
        return ent

    mesh_key = None
    mk = b.get("meshKey")
    if mk:
        mesh_key = "%s-t%s" % (mk, tolerance)
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
        pos, idx, fids = tessellate(sh, tolerance)
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
        if mesh_key:
            try:
                import geomstore
                geomstore.default_store().put_mesh(mesh_key, pickle.dumps(payload, 5))
            except Exception:
                pass
    ent = {"shape": sh, "etag": _uuid.uuid4().hex, "payload": payload}
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
    part, errors, bodies = rebuild_cached(document, diagnostics=diag)
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
    for bid in list(_MESH_CACHE):
        if bid not in live_ids:
            del _MESH_CACHE[bid]  # body deleted/consumed — drop its cache
    result = {"protocol": 2, "bodies": out, "bbox": bbox(part)}
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
    '<base>-<name>.<ext>'. Returns {"path"} (+ {"paths"} for separate) or {"error"}."""
    import os
    import re
    from builder import rebuild_cached
    from exporters import export

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

    def _done(res):
        if warnings:
            res["warnings"] = warnings
        return res

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
            export(b["shape"], fmt, p)
            written.append(p)
        return _done({"path": path, "paths": written})

    if body:
        tgt = next((b for b in live if b["id"] == body), None)
        if tgt is None:
            return {"error": {"message": f"body '{body}' not found to export"}}
        return _done({"path": export(tgt["shape"], fmt, path)})

    return _done({"path": export(part, fmt, path)})


def _export_project_job(document, path, palette, body_colors, body_names, settings):
    """Worker: rebuild + write an Orca-project 3MF (one object per body, palette
    slot → extruder). Same export-what-built semantics as _export_job: failed
    features become warnings; only zero live bodies is a hard error."""
    from builder import rebuild_cached
    from project3mf import sanitize_inputs, write_project_3mf
    from tessellate import tessellate

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
        positions, indices, _face_ids = tessellate(
            b["shape"], tolerance=0.02, angular_tolerance=0.3
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


# --- server process ---------------------------------------------------------


def _die_with_parent():
    """Linux: receive SIGTERM when the parent process dies (anti-orphan)."""
    if sys.platform != "linux":
        return
    try:
        PR_SET_PDEATHSIG = 1
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0)
    except Exception:
        pass  # best-effort; the Rust side also kills us on exit


def _ok(req_id, result):
    return json.dumps({"id": req_id, "ok": True, "result": result})


def _err(req_id, message, feature_id=None):
    error = {"message": message}
    if feature_id is not None:
        error["feature_id"] = feature_id
    return json.dumps({"id": req_id, "ok": False, "error": error})


def _reply_for(req_id, res):
    """Turn a worker result dict into the wire reply (error vs ok)."""
    if "error" in res:
        return _err(req_id, res["error"]["message"], res["error"].get("feature_id"))
    return _ok(req_id, res)


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
                    await ws.send(_reply_for(req_id, res))

                elif op == "computeAll":
                    tol = req.get("tolerance", 0.1)
                    payload = {"document": req["document"], "revision": req.get("revision")}

                    async def _building2(idx, _rid=req_id):
                        await ws.send(json.dumps(
                            {"id": _rid, "status": "building", "feature": idx}
                        ))

                    res = await _run_stall(loop, _compute_all_job, payload, tol,
                                           on_progress=_building2)
                    await ws.send(_reply_for(req_id, res))

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

                elif op == "ping":
                    await ws.send(_ok(req_id, {"pong": True}))

                else:
                    await ws.send(_err(req_id, f"unknown op: {op}"))

            except Exception as ex:
                await ws.send(_err(req_id, str(ex)))
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
        async with websockets.serve(handle, HOST, PORT, max_size=128 * 1024 * 1024):
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
