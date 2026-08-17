"""REPRODUCTION for field report 383e7bfd: "one operation stalled for over 60 s"
on a document with NOTHING in it.

Hypothesis under test: the stall watchdog's clock starts at SUBMIT, not at
execution start (server.py, _run_stall: `last_t = loop.time()` immediately after
run_in_executor). The pool is max_workers=1 and _warmup is submitted at pool
creation, so the first user job QUEUES BEHIND the warm-up and burns its entire
stall budget without ever running or ticking the heartbeat.

If that is right, then on any machine where worker init + warm-up (a cold
build123d/OCP import) exceeds the budget, the first rebuild is reaped even
though the document is empty and nothing is wrong.

This reproduces it deterministically by shrinking the budget instead of slowing
the machine: same mechanism, same code path, no timing luck. Control included.

Run:  sidecar/.venv/bin/python repro_stall.py
"""

import asyncio
import time

import server
from server import _rebuild_job, _run_stall

EMPTY = {"parameters": {}, "features": []}


async def fresh_pool(warm):
    """A pool in a known state. `warm=True` waits for the warm-up to finish, so
    the job under test has the worker to itself; `warm=False` submits the job
    while the warm-up is still ahead of it in the queue.

    Waiting explicitly matters: a stalled run calls _kill_pool + _new_pool, so a
    'warm' run that merely follows a cold one is COLD AGAIN. That contaminated
    the first version of this experiment and made both columns look identical.
    """
    try:
        server._kill_pool(server._pool)
    except Exception:
        pass
    server._pool = server._new_pool()
    if warm and server._warm is not None:
        try:
            await asyncio.wrap_future(server._warm[1])
        except Exception:
            pass


async def main():
    loop = asyncio.get_running_loop()

    print("  budget | cold pool (warm-up queued ahead) | warm pool (warm-up awaited first)")
    print("  -------|----------------------------------|---------------------------------")
    proof = []
    for budget in (0.5, 1.0, 1.5, 2.0, 4.0):
        await fresh_pool(warm=False)
        t0 = time.time()
        cold = await _run_stall(loop, _rebuild_job, EMPTY, 0.1, None, stall=budget)
        cold_dt = time.time() - t0
        cold_stalled = "stalled for over" in str(((cold or {}).get("error") or {}).get("message", ""))

        await fresh_pool(warm=True)
        t0 = time.time()
        warm = await _run_stall(loop, _rebuild_job, EMPTY, 0.1, None, stall=budget)
        warm_dt = time.time() - t0
        warm_err = (warm or {}).get("error") or {}
        warm_stalled = "stalled for over" in str(warm_err.get("message", ""))
        warm_ok = not warm_stalled and not warm_err

        print(f"  {budget:5.1f}s | {'STALLED' if cold_stalled else 'ok':>8} in {cold_dt:5.1f}s"
              f"              | {'STALLED' if warm_stalled else ('ok' if warm_ok else 'ERR'):>8} in {warm_dt:5.1f}s")
        if cold_stalled and warm_ok:
            proof.append(budget)

    print()
    if proof:
        print(f"CONFIRMED at budget(s) {proof}: the SAME job on the SAME empty document is")
        print("reaped when it queues behind the warm-up and succeeds when the worker is")
        print("already up. The stall budget is being spent on QUEUE TIME, not on the")
        print("operation — which is why an empty document can report a 60s stall.")
    else:
        print("NOT REPRODUCED at any budget tried. Queue time being charged to the job's")
        print("stall budget is NOT supported by this run — look elsewhere for 383e7bfd.")


if __name__ == "__main__":
    asyncio.run(main())
