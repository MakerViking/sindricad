"""Stall-watchdog heartbeat coverage for the three phases that used to run silent.

Run: uv run python test_heartbeat.py   (or .venv/bin/python test_heartbeat.py)

The supervisor reaps a worker whose shared heartbeat STOPS MOVING, not one that
merely takes a long time. Export meshing, the interference pair sweep and the
per-body checkpoint write never bumped it, so each was liable to be killed for
being slow rather than for being wedged — the one distinction the stall watchdog
exists to make. It is also a hard prerequisite for moving export onto
`_run_stall`: STALL_TIMEOUT is 60 s, so supervising progress without ticks
HALVES the budget instead of lifting it.

Every check asserts the counter advances by AT LEAST the live body count.
"Non-zero" passes vacuously here, because `rebuild_cached` already emits its own
per-feature ticks — which is why the sweep check subtracts a measured warm
rebuild baseline rather than assuming the two never overlap.
"""

import os
import shutil
import sys
import tempfile

os.environ.setdefault("SINDRI_DISK_CACHE", "0")  # the checkpoint test brings its own store
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import builder  # noqa: E402

PASS = "  ok"
N_BODIES = 4


class _Ticks:
    """Count heartbeat ticks published while the block runs, then put back
    whatever hook was installed before. The worker installs a real one at
    startup; a test must never leave its counter in its place."""

    def __enter__(self):
        self.n = 0
        self._prev = builder.on_feature_tick
        builder.on_feature_tick = self._count
        return self

    def _count(self, _index):
        self.n += 1

    def __exit__(self, *_exc):
        builder.on_feature_tick = self._prev
        return False


def _boxes(n, spacing=40.0, overlap=False):
    """`n` single-body boxes, disjoint unless `overlap`. Disjoint is the default
    on purpose: every pair is then rejected by the cheap bbox test, so the only
    ticks the interference sweep can publish are its per-row ones."""
    step = spacing if not overlap else 10.0
    feats = []
    for i in range(n):
        s, e = f"s{i}", f"e{i}"
        feats += [
            {"id": s, "type": "sketch", "plane": "XY",
             "entities": [{"type": "rectangle", "width": 20, "height": 20,
                           "x": i * step, "y": 0}]},
            {"id": e, "type": "extrude", "sketch": s, "distance": 10,
             "operation": "new"},
        ]
    return {"parameters": {}, "features": feats}


def _live_bodies(doc, want=N_BODIES):
    from builder import rebuild_cached

    _part, err, bodies = rebuild_cached(doc)
    assert not err, err
    live = [b for b in bodies if b.get("shape") is not None]
    assert len(live) == want, f"{len(live)} live bodies, want {want}"
    return live


def test_export_mesh_ticks_on_every_tier():
    """Export meshing ticks once per body whichever cache tier answers."""
    from server import _export_mesh

    live = _live_bodies(_boxes(N_BODIES))

    with _Ticks() as cold:
        for b in live:
            _export_mesh(b)
    assert cold.n >= len(live), \
        f"cold export ticked {cold.n}x for {len(live)} bodies"

    # The second pass is served entirely from the RAM identity cache, and must
    # still tick. Export walks every body in one uninterrupted loop, so the
    # guarantee worth having is one tick per body regardless of tier — a mixed
    # warm/cold export is the common case, not the exception.
    with _Ticks() as warm:
        for b in live:
            _export_mesh(b)
    assert warm.n >= len(live), \
        f"warm export ticked {warm.n}x for {len(live)} bodies"

    print(f"{PASS} export meshing: {cold.n} ticks cold, {warm.n} warm, "
          f"{len(live)} bodies")


def test_interference_sweep_ticks_per_row():
    """The pair sweep ticks per row, over and above the rebuild it starts with."""
    from builder import rebuild_cached
    from server import _interference_job

    doc = _boxes(N_BODIES)
    rebuild_cached(doc)  # warm, so the job's own rebuild takes the cheap path

    # What the internal rebuild_cached alone publishes for this exact document,
    # warm. Subtracting it is what stops the assertion below passing vacuously
    # on ticks the sweep did not emit.
    with _Ticks() as base:
        rebuild_cached(doc)

    with _Ticks() as sweep:
        res = _interference_job(doc)
    assert "error" not in res, res
    assert res["pairs"] == [], f"disjoint boxes must not clash: {res['pairs']}"

    gained = sweep.n - base.n
    assert gained >= N_BODIES, (
        f"sweep published {gained} ticks beyond the rebuild baseline "
        f"({sweep.n} - {base.n}), want at least {N_BODIES}"
    )
    print(f"{PASS} interference sweep: {gained} ticks beyond baseline "
          f"({sweep.n} - {base.n}) for {N_BODIES} bodies")


def test_interference_sweep_ticks_around_each_boolean():
    """A pair that survives the bbox reject ticks again before its boolean, which
    is the expensive and crash-prone call the row tick alone would not cover."""
    from builder import rebuild_cached
    from server import _interference_job

    doc = _boxes(N_BODIES, overlap=True)
    rebuild_cached(doc)
    with _Ticks() as base:
        rebuild_cached(doc)
    with _Ticks() as sweep:
        res = _interference_job(doc)
    assert "error" not in res, res
    assert res["pairs"], "overlapping boxes should clash — no boolean ran"

    gained = sweep.n - base.n
    assert gained >= N_BODIES + len(res["pairs"]), (
        f"{gained} ticks for {N_BODIES} rows + {len(res['pairs'])} booleans"
    )
    print(f"{PASS} interference booleans: {gained} ticks for {N_BODIES} rows "
          f"+ {len(res['pairs'])} clashing pairs")


def test_checkpoint_write_ticks_per_body():
    """The per-body checkpoint write ticks per body, and actually writes."""
    import geomstore
    from builder import _save_checkpoint

    live = _live_bodies(_boxes(N_BODIES))
    root = tempfile.mkdtemp(prefix="sindri-hb-")
    store = None
    try:
        store = geomstore.Store(root)
        key = "chain-key-0"
        persist = {"store": store, "keys": [key], "mod": {}, "acc_ms": 0.0}
        with _Ticks() as t:
            _save_checkpoint(persist, 0, live, [], [], 0)
        assert t.n >= len(live), \
            f"checkpoint write ticked {t.n}x for {len(live)} bodies"

        # _save_checkpoint swallows every exception, so a store that failed on
        # its first call would leave the assertion above passing over a loop
        # that did nothing but tick. Prove the write landed.
        cp = store.find_checkpoint([key])
        assert cp is not None, \
            "checkpoint never landed — the tick count above proves nothing"
        assert len(cp["manifest"]) == len(live), cp["manifest"]
        print(f"{PASS} checkpoint write: {t.n} ticks for {len(live)} bodies "
              f"(checkpoint landed, {len(cp['manifest'])} entries)")
    finally:
        if store is not None:
            try:
                store.db.close()
            except Exception:
                pass
        shutil.rmtree(root, ignore_errors=True)


def test_tick_hook_is_restored():
    """The counter must not outlive the block that installed it."""
    before = builder.on_feature_tick
    with _Ticks():
        assert builder.on_feature_tick is not before
    assert builder.on_feature_tick is before, "tick hook leaked out of the block"
    print(f"{PASS} tick hook restored after use")


def test_progress_tick_survives_a_broken_hook():
    """A progress frame must never be able to fail the work it reports on."""
    from builder import progress_tick

    prev = builder.on_feature_tick
    try:
        def _explode(_i):
            raise RuntimeError("hook is broken")

        builder.on_feature_tick = _explode
        progress_tick()  # must not raise
        builder.on_feature_tick = None
        progress_tick()  # must not raise with no hook installed at all
    finally:
        builder.on_feature_tick = prev
    print(f"{PASS} progress_tick swallows a broken hook and a missing one")


# --- stall supervision (Wave 1.2) --------------------------------------------
#
# export / exportProject / interference / projectGeometry moved off a 120 s wall
# clock onto _run_stall. The contract that move depends on is exactly two
# things, so both are asserted here against the real _run_stall with a stubbed
# pool: work that keeps ticking is NEVER reaped for merely being long, and work
# that goes silent IS reaped at ~stall with a message that says "stalled".
#
# A stub pool rather than the real one on purpose: this is a test of the
# supervision loop, not of process mechanics, and a thread pool lets the job
# bump the heartbeat the supervisor is reading.


class _StubValue:
    def __init__(self, v=0):
        self.value = v


def _drive_run_stall(job, stall):
    """Run server._run_stall(job) against a thread pool and a stub heartbeat.
    Returns (result, elapsed_seconds)."""
    import asyncio
    import time as _time
    from concurrent.futures import ThreadPoolExecutor

    import server

    saved = (server._pool, server._HB, server._HB_IDX, server._kill_pool,
             server._new_pool, server._env_broken)
    pool = ThreadPoolExecutor(max_workers=1)
    hb = _StubValue(0)
    try:
        server._pool, server._HB, server._HB_IDX = pool, hb, _StubValue(-1)
        server._env_broken = False
        # Stubbed so a reap exercises the supervision decision without tearing
        # down a real process pool underneath the test.
        server._kill_pool = lambda _p: None
        server._new_pool = lambda: pool

        async def _go():
            t0 = _time.monotonic()
            res = await server._run_stall(asyncio.get_running_loop(), job, hb, stall=stall)
            return res, _time.monotonic() - t0

        return asyncio.run(_go())
    finally:
        (server._pool, server._HB, server._HB_IDX, server._kill_pool,
         server._new_pool, server._env_broken) = saved
        pool.shutdown(wait=False)


def _ticking_job(hb):
    """Runs well past the stall window, but keeps publishing progress."""
    import time as _time
    for _ in range(30):
        _time.sleep(0.1)
        hb.value += 1
    return {"ok": True, "did": "long work"}


def _stalling_job(hb):
    """Publishes progress, then wedges — the shape of one stuck OCCT call."""
    import time as _time
    for _ in range(3):
        _time.sleep(0.1)
        hb.value += 1
    _time.sleep(6.0)
    return {"ok": True, "did": "should never be returned"}


def test_long_but_ticking_work_is_never_reaped():
    """3 s of work under a 1 s stall completes, because it keeps ticking.
    Under the old 120 s wall clock the equivalent case was export at 180 s."""
    res, elapsed = _drive_run_stall(_ticking_job, stall=1.0)
    assert res.get("did") == "long work", f"ticking work was reaped: {res}"
    assert elapsed >= 3.0, f"job returned too early ({elapsed:.2f}s) to prove anything"
    print(f"{PASS} ticking work ran {elapsed:.1f}s under a 1.0s stall and completed")


def test_silent_work_is_reaped_with_a_stalled_message():
    """Ticks, then goes quiet: reaped at ~stall, not at the job's full length."""
    res, elapsed = _drive_run_stall(_stalling_job, stall=1.0)
    msg = (res.get("error") or {}).get("message", "")
    assert "stalled" in msg, f"expected a stalled message, got {res}"
    assert elapsed < 4.0, f"reaped at {elapsed:.2f}s — should be ~1s, not the job's 6s"
    assert res.get("did") is None, "a reaped job must not return its result"
    print(f"{PASS} silent work reaped at {elapsed:.1f}s: {msg[:58]}…")


def test_the_document_ops_no_longer_use_a_wall_clock():
    """The four document-scaled ops are dispatched through _run_stall, and
    DOC_TIMEOUT is gone. Pins the wiring 1.2 is: a later edit that quietly puts
    one back on _run(timeout=...) would restore the exact failure this removed,
    where a long build and a wedged one are indistinguishable."""
    import re

    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py")).read()
    assert "DOC_TIMEOUT = " not in src, "DOC_TIMEOUT is back"
    for op, job in (("export", "_export_job"), ("exportProject", "_export_project_job"),
                    ("interference", "_interference_job"),
                    ("projectGeometry", "_project_geometry_job")):
        m = re.search(r"_run(_stall)?\(\s*\n?\s*loop,\s*" + job + r"\b", src)
        assert m, f"{op}: no dispatch found for {job}"
        assert m.group(1) == "_stall", f"{op} ({job}) is on a wall clock again"
    print(f"{PASS} export/exportProject/interference/projectGeometry all on _run_stall")


if __name__ == "__main__":
    print("heartbeat ticks (stall watchdog)")
    test_export_mesh_ticks_on_every_tier()
    test_interference_sweep_ticks_per_row()
    test_interference_sweep_ticks_around_each_boolean()
    test_checkpoint_write_ticks_per_body()
    test_tick_hook_is_restored()
    test_progress_tick_survives_a_broken_hook()
    test_long_but_ticking_work_is_never_reaped()
    test_silent_work_is_reaped_with_a_stalled_message()
    test_the_document_ops_no_longer_use_a_wall_clock()
    print("all heartbeat tests passed")
