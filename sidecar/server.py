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
import json
import multiprocessing as mp
import signal
import sys
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import websockets

import occt_smp

HOST = "127.0.0.1"
PORT = 8765

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
    {"error": {...}} on a feature failure. Args/return must stay picklable."""
    from builder import rebuild
    from tessellate import tessellate_bodies, edge_polylines_by_body, bbox

    part, errors, bodies = rebuild(document)
    if errors:
        e = errors[0]
        return {"error": {"message": e["message"], "feature_id": e.get("feature_id")}}
    if part is None:
        # no solid yet (e.g. only sketches exist) — not an error; the frontend
        # still renders sketch overlays.
        return {"mesh": {"positions": [], "indices": [], "faceIds": []}, "edges": [], "bbox": None, "bodies": []}
    pos, idx, fids, meta = tessellate_bodies(bodies, tolerance)
    return {
        "mesh": {"positions": pos, "indices": idx, "faceIds": fids},
        "edges": edge_polylines_by_body(bodies),
        "bbox": bbox(part),
        "bodies": meta,
    }


def _export_job(document, fmt, path):
    """Worker: rebuild + export to a file. Returns {"path"} or {"error"}."""
    from builder import rebuild
    from exporters import export

    part, errors, _bodies = rebuild(document)
    if errors:
        e = errors[0]
        return {"error": {"message": e["message"], "feature_id": e.get("feature_id")}}
    return {"path": export(part, fmt, path)}


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


async def handle(ws):
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
                res = await _run(loop, _export_job, req["document"], req["format"], req["path"])
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


async def main():
    global _pool, _mp_ctx
    _die_with_parent()
    _mp_ctx = mp.get_context("spawn")
    _pool = _new_pool()
    try:
        # Raise the per-message cap well above the 1 MiB default: a rebuild ships
        # the WHOLE document, and a document with an imported mesh embeds that
        # body as a (potentially multi-MB) BREP string — at the default limit the
        # server would slam the connection shut on the first real import, which
        # the frontend sees as a permanent "connecting to sidecar".
        async with websockets.serve(handle, HOST, PORT, max_size=512 * 1024 * 1024):
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
