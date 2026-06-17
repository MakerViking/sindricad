"""Verxa geometry sidecar — WebSocket loop + dispatch.

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

import websockets

import occt_smp

HOST = "127.0.0.1"
PORT = 8765

# the worker-process pool; set in main(). Heavy ops are dispatched here.
_pool: ProcessPoolExecutor | None = None


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
    from tessellate import tessellate, edge_polylines, bbox

    part, errors = rebuild(document)
    if errors:
        e = errors[0]
        return {"error": {"message": e["message"], "feature_id": e.get("feature_id")}}
    if part is None:
        # no solid yet (e.g. only sketches exist) — not an error; the frontend
        # still renders sketch overlays.
        return {"mesh": {"positions": [], "indices": [], "faceIds": []}, "edges": [], "bbox": None}
    pos, idx, fids = tessellate(part, tolerance)
    return {
        "mesh": {"positions": pos, "indices": idx, "faceIds": fids},
        "edges": edge_polylines(part),
        "bbox": bbox(part),
    }


def _export_job(document, fmt, path):
    """Worker: rebuild + export to a file. Returns {"path"} or {"error"}."""
    from builder import rebuild
    from exporters import export

    part, errors = rebuild(document)
    if errors:
        e = errors[0]
        return {"error": {"message": e["message"], "feature_id": e.get("feature_id")}}
    return {"path": export(part, fmt, path)}


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
                res = await loop.run_in_executor(_pool, _rebuild_job, req["document"], tol)
                await ws.send(_reply_for(req_id, res))

            elif op == "export":
                res = await loop.run_in_executor(
                    _pool, _export_job, req["document"], req["format"], req["path"]
                )
                await ws.send(_reply_for(req_id, res))

            elif op == "ping":
                await ws.send(_ok(req_id, {"pong": True}))

            else:
                await ws.send(_err(req_id, f"unknown op: {op}"))

        except Exception as ex:
            await ws.send(_err(req_id, str(ex)))


async def main():
    global _pool
    _die_with_parent()
    ctx = mp.get_context("spawn")
    with ProcessPoolExecutor(max_workers=1, mp_context=ctx, initializer=_worker_init) as pool:
        _pool = pool
        loop = asyncio.get_running_loop()
        # spawn + warm the worker now so the first rebuild is fast (fire-and-forget)
        asyncio.ensure_future(loop.run_in_executor(pool, _warmup))
        async with websockets.serve(handle, HOST, PORT):
            # readiness signal the Rust shell waits for before connecting
            print(f"LISTENING {PORT}", flush=True)
            await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
