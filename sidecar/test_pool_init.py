"""Worker-pool bring-up: telling a broken INSTALL from a crash on one shape.

Field bug 8aa9ded7 ("no bodies made", Windows 0.1.82) was a worker that could
never start. Both BrokenProcessPool handlers recycled unconditionally and said
"the geometry kernel crashed on this operation", so the replacement pool failed
identically, forever, while the user was told their model was at fault — and
the real import error was invisible, because CPython logs an initializer's
exception to the CHILD's stderr, which Windows does not inherit.

Run:  uv run python test_pool_init.py
"""

import asyncio
import multiprocessing as mp
import sys
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import server


# --- initializers for the real-pool cases. Module level so 'spawn' can pickle
# them by reference (the child imports THIS module and looks them up).

def _init_that_raises(err_buf=None):
    try:
        raise ImportError("DLL load failed while importing OCP: not found")
    except BaseException:
        server._publish_init_error(err_buf)
        raise


def _init_ok(err_buf=None):
    return None


def _probe():
    """Trivial task: force the lazy spawn without paying for build123d."""
    return True


def _die():
    """Simulate a segfault: leave no traceback, break the pool."""
    import os
    os._exit(1)


def _reset():
    server._pool = None
    server._pool_gen = -1
    server._warm = None
    server._failed_gens = set()
    server._reaped_gens = set()
    server._ever_came_up = False
    server._env_broken = False


def _pool_with(initializer, err_buf=None):
    """Build a pool the way _new_pool does, but with a chosen initializer."""
    server._pool_gen += 1
    gen = server._pool_gen
    pool = ProcessPoolExecutor(
        max_workers=1, mp_context=server._mp_ctx,
        initializer=initializer, initargs=(err_buf,),
    )
    fut = pool.submit(_probe)
    server._warm = (gen, fut)
    server._pool = pool
    return gen, pool, fut


# --------------------------------------------------------------------------


def test_worker_init_publishes_its_traceback_exception_line_first():
    """The buffer and the log both keep the HEAD, while a traceback's error is
    its LAST line — so the summary has to be written first or it is the one
    thing that gets cut."""
    buf = server._mp_ctx.Array("c", 16384, lock=False)
    try:
        raise ImportError("DLL load failed while importing OCP")
    except BaseException:
        server._publish_init_error(buf)
    text = buf.value.decode()
    assert text.startswith("ImportError: DLL load failed while importing OCP"), text[:120]
    assert "Traceback (most recent call last):" in text
    print("ok  traceback published, exception line first")


def test_publish_truncates_to_the_buffer():
    small = server._mp_ctx.Array("c", 64, lock=False)
    try:
        raise RuntimeError("x" * 5000)
    except BaseException:
        server._publish_init_error(small)
    assert len(small.value) <= 63, len(small.value)
    print("ok  oversized traceback does not overflow the buffer")


def test_an_init_failure_is_not_reported_as_an_operation_crash():
    _reset()
    buf = server._mp_ctx.Array("c", 16384, lock=False)
    gen, pool, fut = _pool_with(_init_that_raises, buf)
    try:
        fut.result(timeout=30)
        assert False, "the warm-up should have failed"
    except BrokenProcessPool:
        pass
    server._INIT_ERR = buf
    assert not server._worker_came_up(gen), "a worker that never started must not classify as up"
    res = server._on_broken(gen)
    msg = res["error"]["message"]
    assert msg == server._INIT_FAIL_MSG, msg
    assert "not a problem with your model" in msg
    print("ok  init failure says installation problem, not 'your model crashed it'")


def test_two_consecutive_init_failures_stop_the_recycle_loop():
    _reset()
    server._INIT_ERR = server._mp_ctx.Array("c", 4096, lock=False)
    for _ in range(server.MAX_INIT_ATTEMPTS):
        server._note_init_failure(server._pool_gen)
        server._pool_gen += 1
    assert server._env_broken, "should have latched after MAX_INIT_ATTEMPTS"
    assert server._new_pool() is None, "a latched session must stop spawning"
    err = server._pool_available()
    assert err is not None and err["error"]["message"] == server._INIT_FAIL_MSG
    print("ok  the pool stops being rebuilt once the environment is established broken")


def test_a_pool_we_reaped_is_not_counted_as_a_failed_bring_up():
    """A stall/timeout reap resolves a PENDING warm-up with BrokenProcessPool,
    which is indistinguishable from a failed bring-up. Counting those would let
    a slow cold start latch 'your install is broken' on a healthy machine and
    stop the disk-checkpoint ratchet converging."""
    _reset()
    server._INIT_ERR = server._mp_ctx.Array("c", 4096, lock=False)
    gen, pool, fut = _pool_with(_init_ok)
    server._kill_pool(pool)          # what the reapers do
    server._note_init_failure(gen)   # what the warm-up watcher would then report
    assert gen not in server._failed_gens, "a deliberate kill must not count"
    assert not server._env_broken
    print("ok  a reaped generation is not a failed bring-up")


def test_an_install_that_worked_this_session_never_latches():
    _reset()
    server._INIT_ERR = server._mp_ctx.Array("c", 4096, lock=False)
    server._ever_came_up = True
    for _ in range(server.MAX_INIT_ATTEMPTS + 2):
        server._note_init_failure(server._pool_gen)
        server._pool_gen += 1
    assert not server._env_broken, "a worker came up earlier; this is transient, not environmental"
    print("ok  a session that once had a working worker is never declared broken")


def test_a_missing_pool_is_retryable_not_terminal():
    """One transient spawn failure must not disable geometry for the session
    with the retry budget unspent — the old code survived this because it kept
    the executor object and the next op retried the lazy spawn."""
    _reset()
    server._INIT_ERR = server._mp_ctx.Array("c", 4096, lock=False)
    server._pool = None
    err = server._pool_available()
    assert err is None, f"should have rebuilt the pool, got {err}"
    assert server._pool is not None
    server._kill_pool(server._pool)
    print("ok  _pool is None rebuilds instead of bricking the session")


def test_an_operation_crash_still_names_the_feature():
    """The regression guard: a worker that DID come up and then died must keep
    the per-operation message and its feature attribution."""
    _reset()
    server._INIT_ERR = server._mp_ctx.Array("c", 4096, lock=False)
    gen, pool, fut = _pool_with(_init_ok)
    fut.result(timeout=30)                 # the worker came up
    assert server._worker_came_up(gen)
    try:
        pool.submit(_die).result(timeout=30)
    except BrokenProcessPool:
        pass
    res = server._on_broken(gen)
    msg = res["error"]["message"]
    assert msg == "the geometry kernel crashed on this operation", msg
    assert not server._env_broken, "one op crash must never latch"
    print("ok  a real op crash keeps its message and does not latch")


def test_a_stale_generation_does_not_latch_a_healthy_install():
    """Up to MAX_CONNS_PER_IP ops can be in flight, and one worker death breaks
    EVERY in-flight future. Without keying on the generation, the second op to
    notice reads the REPLACEMENT pool's pending warm-up and declares the
    environment broken."""
    _reset()
    server._INIT_ERR = server._mp_ctx.Array("c", 4096, lock=False)
    gen, pool, fut = _pool_with(_init_ok)
    fut.result(timeout=30)
    stale_gen = gen
    server._pool_gen += 1                 # a peer already recycled
    server._warm = (server._pool_gen, pool.submit(_probe))
    res = server._on_broken(stale_gen)
    assert res["error"]["message"] == "the geometry kernel crashed on this operation"
    assert not server._env_broken
    assert stale_gen not in server._failed_gens
    server._kill_pool(pool)
    print("ok  a concurrent op observing a stale generation does not latch")


def test_the_warmup_exercises_geometry_not_just_the_import():
    """A wheel built for a newer instruction set, or a mismatched TBB/TKernel,
    imports fine and faults on the first kernel call. Classified as an op crash
    that told the user their sketch was degenerate."""
    import inspect
    src = inspect.getsource(server._warmup)
    assert "Box(" in src, "the warm-up must build real geometry"
    assert ".volume" in src, "and assert the result is a real solid"
    assert server._warmup() is True
    print("ok  the warm-up builds and checks real geometry")


if __name__ == "__main__":
    server._mp_ctx = mp.get_context("spawn")
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
    print(f"\n{len(tests)} passed")
