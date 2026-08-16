"""Cancel: can a user actually stop a long-running geometry op?

Before this there was no user-facing abort anywhere in server.py or client.ts.
That was survivable only because every op was bounded by a short timeout — but
Phase B raises the import cap, and a 356 MiB STEP read holds the worker for
100+ seconds. Without cancel, one mis-click freezes all geometry with no exit.

Two things have to be true, and neither is obvious from the code:

 1. A cancel sent WHILE a job runs must be HEARD. The old read loop awaited each
    op inline (`async for raw in ws: ... await _run(...)`), so a cancel frame sat
    unread in the socket buffer until the very job it was meant to stop had
    finished. This is the reason the request loop was restructured.

 2. The cancelled op must report CANCELLED, not "the geometry kernel crashed".
    A pool job cannot be interrupted, so cancel kills the worker — which is
    indistinguishable from a segfault unless the token says otherwise.

Run:  uv run python test_cancel.py
"""

import asyncio
import json
import time

import websockets

import server
from server import handle, HOST, PORT

server._TOKEN = "cancel-test-token"
URL = f"ws://{HOST}:{PORT}?token=cancel-test-token"

# A job that simply sleeps in the worker: it stands in for a 90-second STEP
# read without needing a 356 MiB file. Registered as a module-level function so
# ProcessPoolExecutor can pickle it.
#
# The sleep length rides INSIDE a real document. It used to be sent as the bare
# `"document": 30`, which server._malformed now refuses up front (a badRequest
# before any job starts) — so the long job never began, cancel found nothing
# running, and this file failed on `cancelled is False` with nothing wrong with
# cancel at all.
SLEEP_SECONDS = 30


def _sleep_doc(seconds):
    return {"features": [], "parameters": {}, "seconds": seconds}


def _sleep_job(document):
    seconds = document["seconds"]
    time.sleep(seconds)
    return {"slept": seconds}


_SERVER = None


class _Keep:
    """No-op async context: the tests each say `async with await _serve()`, but
    one server is bound for the whole run — rebinding per test races TIME_WAIT
    on 8765 and fails the second test for reasons having nothing to do with
    cancel."""

    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


async def _serve():
    global _SERVER
    if _SERVER is None:
        _SERVER = await websockets.serve(handle, HOST, PORT)
    return _Keep()


async def test_cancel_stops_a_running_job():
    """The headline: a cancel sent during a long op is heard, and the op comes
    back as cancelled — quickly, not after the full duration."""
    # route the "interference" op at a long sleep so we have something to cancel
    orig = server._interference_job
    server._interference_job = _sleep_job
    try:
        async with await _serve():
            async with websockets.connect(URL) as ws:
                t0 = time.monotonic()
                await ws.send(json.dumps({"id": "long", "op": "interference",
                                          "document": _sleep_doc(SLEEP_SECONDS)}))
                await asyncio.sleep(1.5)  # let it get into the worker

                # THE POINT: this must be read and acted on while `long` runs
                await ws.send(json.dumps({"id": "c1", "op": "cancel", "target": "long"}))

                replies = {}
                for _ in range(2):
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
                    replies[msg["id"]] = msg
                elapsed = time.monotonic() - t0

                assert replies["c1"]["ok"] is True, replies["c1"]
                assert replies["c1"]["result"]["cancelled"] is True, replies["c1"]

                long = replies["long"]
                assert long["ok"] is False, long
                assert long.get("cancelled") is True, (
                    "a cancelled op must say cancelled, not look like a crash: %r" % long
                )
                assert "crash" not in json.dumps(long).lower(), long
                assert elapsed < SLEEP_SECONDS - 5, (
                    "cancel did not actually stop the work: %.1fs elapsed of %ds"
                    % (elapsed, SLEEP_SECONDS)
                )
                print("  cancelled after %.1fs (job asked for %ds)" % (elapsed, SLEEP_SECONDS))
    finally:
        server._interference_job = orig


async def test_geometry_still_works_after_a_cancel():
    """Cancel kills the worker pool. The very next op must succeed — a cancel
    that leaves geometry dead is worse than no cancel."""
    orig = server._interference_job
    server._interference_job = _sleep_job
    try:
        async with await _serve():
            async with websockets.connect(URL) as ws:
                await ws.send(json.dumps({"id": "long", "op": "interference", "document": _sleep_doc(SLEEP_SECONDS)}))
                await asyncio.sleep(1.0)
                await ws.send(json.dumps({"id": "c", "op": "cancel"}))
                for _ in range(2):
                    await asyncio.wait_for(ws.recv(), timeout=15)

                await ws.send(json.dumps({"id": "p", "op": "ping"}))
                pong = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                assert pong["ok"] is True and pong["result"]["pong"] is True, pong
                print("  pool recovered after cancel")
    finally:
        server._interference_job = orig


async def test_cancel_with_no_job_running_is_harmless():
    async with await _serve():
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"id": "c", "op": "cancel"}))
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            assert msg["ok"] is True and msg["result"]["cancelled"] is False, msg
            print("  no-op cancel reports nothing stopped")


async def test_cancel_targeting_another_id_leaves_the_job_alone():
    """`target` names a specific request; a stale cancel for an op that already
    finished must not kill whatever is running now."""
    orig = server._interference_job
    server._interference_job = _sleep_job
    try:
        async with await _serve():
            async with websockets.connect(URL) as ws:
                await ws.send(json.dumps({"id": "current", "op": "interference", "document": _sleep_doc(3)}))
                await asyncio.sleep(1.0)
                await ws.send(json.dumps({"id": "c", "op": "cancel", "target": "some-older-op"}))

                replies = {}
                for _ in range(2):
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
                    replies[msg["id"]] = msg
                assert replies["c"]["result"]["cancelled"] is False, replies["c"]
                assert replies["current"]["ok"] is True, replies["current"]
                print("  a mistargeted cancel left the running job alone")
    finally:
        server._interference_job = orig


async def test_ordering_is_preserved_under_task_dispatch():
    """Heavy ops became tasks, but they must still run ONE AT A TIME and in
    order — the shared heartbeat counter and the rebuild cache both assume it."""
    async with await _serve():
        async with websockets.connect(URL) as ws:
            ids = [f"p{i}" for i in range(6)]
            for i in ids:
                await ws.send(json.dumps({"id": i, "op": "ping"}))
            got = [json.loads(await asyncio.wait_for(ws.recv(), timeout=10))["id"]
                   for _ in ids]
            assert got == ids, got
            print("  replies stayed in request order:", " ".join(got))


async def main():
    for fn in (
        test_cancel_stops_a_running_job,
        test_geometry_still_works_after_a_cancel,
        test_cancel_with_no_job_running_is_harmless,
        test_cancel_targeting_another_id_leaves_the_job_alone,
        test_ordering_is_preserved_under_task_dispatch,
    ):
        print(fn.__name__)
        await fn()
    if _SERVER is not None:
        _SERVER.close()
        await _SERVER.wait_closed()
    print("\nall cancel tests passed")


if __name__ == "__main__":
    asyncio.run(main())
