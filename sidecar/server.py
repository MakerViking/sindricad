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

# the worker-process pool; set in main(). Heavy ops are dispatched here.
_pool: ProcessPoolExecutor | None = None
_mp_ctx = None  # the 'spawn' context, kept so we can rebuild the pool after a crash


# --- worker process (separate interpreter) ---------------------------------


def _worker_init():
    """Runs once when a worker process starts: die with the server (anti-orphan),
    pin OCCT to all cores, and warm the heavy imports so the first real rebuild
    isn't paying build123d's import cost."""
    _die_with_parent()  # SIGTERM the worker if the server process dies
    occt_smp.configure()
    import builder  # noqa: F401  (warm the import)
    import tessellate  # noqa: F401


def _warmup():
    """Trivial task submitted at startup to force the (lazy) worker to spawn and
    run _worker_init now, rather than on the user's first rebuild."""
    return True


def _rebuild_job(document, tolerance):
    """Worker: rebuild the document and tessellate. Returns a result dict, or
    {"error": {...}} on a feature failure. Args/return must stay picklable.

    Uses rebuild_cached: this worker is long-lived (max_workers=1), so an in-process
    per-feature snapshot cache lets an edit re-run only from the first changed feature
    instead of the whole history. A worker respawn (timeout/crash) clears the cache."""
    from builder import rebuild_cached
    from tessellate import tessellate_bodies, edge_polylines_by_body, bbox

    diag = []
    part, errors, bodies = rebuild_cached(document, diagnostics=diag)
    if errors:
        e = errors[0]
        return {"error": {"message": e["message"], "feature_id": e.get("feature_id")}}
    if part is None:
        # no solid yet (e.g. only sketches exist) — not an error; the frontend
        # still renders sketch overlays.
        return {"mesh": {"positions": [], "indices": [], "faceIds": []}, "edges": [], "bbox": None, "bodies": []}
    pos, idx, fids, meta = tessellate_bodies(bodies, tolerance)
    result = {
        "mesh": {"positions": pos, "indices": idx, "faceIds": fids},
        "edges": edge_polylines_by_body(bodies),
        "bbox": bbox(part),
        "bodies": meta,
    }
    if diag:  # only attach when a selector resolved with low confidence
        result["diagnostics"] = diag
    return result


def _export_job(document, fmt, path, body=None, separate=False):
    """Worker: rebuild + export. Default exports the merged part to `path`; `body`
    (a body id) exports just that body; `separate` writes EACH body to its own
    '<base>-<name>.<ext>'. Returns {"path"} (+ {"paths"} for separate) or {"error"}."""
    import os
    import re
    from builder import rebuild
    from exporters import export

    part, errors, bodies = rebuild(document)
    if errors:
        e = errors[0]
        return {"error": {"message": e["message"], "feature_id": e.get("feature_id")}}
    live = [b for b in bodies if b.get("shape") is not None]

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
            name = re.sub(r"[^\w.-]+", "_", str(label)).strip("_") or b["id"]
            cand, i = name, 2
            while cand in used:  # keep filenames unique if two bodies share a name
                cand, i = f"{name}_{i}", i + 1
            used.add(cand)
            p = f"{base}-{cand}{ext}"
            export(b["shape"], fmt, p)
            written.append(p)
        return {"path": path, "paths": written}

    if body:
        tgt = next((b for b in live if b["id"] == body), None)
        if tgt is None:
            return {"error": {"message": f"body '{body}' not found to export"}}
        return {"path": export(tgt["shape"], fmt, path)}

    return {"path": export(part, fmt, path)}


def _interference_job(document):
    """Worker: rebuild + pairwise interference check among live bodies. Returns
    {"pairs": [...]} — one entry per pair of solids that actually overlap (boolean
    intersection volume above a tiny epsilon), with the overlap volume + bbox so the
    frontend can report and zoom to each clash."""
    from builder import rebuild, _bbox_overlap

    part, errors, bodies = rebuild(document)
    if errors:
        e = errors[0]
        return {"error": {"message": e["message"], "feature_id": e.get("feature_id")}}
    live = [b for b in bodies if b.get("shape") is not None]
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
    pool = ProcessPoolExecutor(max_workers=1, mp_context=_mp_ctx, initializer=_worker_init)
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
                    res = await _run(loop, _rebuild_job, req["document"], tol)
                    await ws.send(_reply_for(req_id, res))

                elif op == "export":
                    res = await _run(loop, _export_job, req["document"], req["format"], req["path"], req.get("body"), req.get("separate", False))
                    await ws.send(_reply_for(req_id, res))

                elif op == "interference":
                    res = await _run(loop, _interference_job, req["document"])
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
    global _pool, _mp_ctx, _TOKEN
    _die_with_parent()
    _TOKEN = os.environ.get("SINDRI_SIDECAR_TOKEN") or _mint_token()
    _mp_ctx = mp.get_context("spawn")
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
