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


# Every _kill_pool / _new_pool call the supervisor made during the last
# _drive_run_stall, in order. "The caller got a stalled message" is NOT evidence
# the pool was recycled — field f3b9c287 returned that message with the wedged
# worker still holding the only slot.
_RECYCLES = []


def _drive_run_stall(job, stall, warm=None, stdout=None, new_pool=None):
    """Run server._run_stall(job) against a thread pool and a stub heartbeat.
    Returns (result, elapsed_seconds), and records every pool recycle the
    supervisor performed in the module-level `_RECYCLES`.

    `warm` stands in for the pool's warm-up future. Passing one is what
    exercises the queued-behind-the-warm-up branch; leaving it None keeps the
    older tests on the path they were written for.

    `stdout` replaces sys.stdout for the duration — the encoding-hostile stream
    of field f3b9c287 is a real input to this loop, not a detail of it.

    `new_pool` replaces the stubbed pool rebuild. Pass one that RAISES to
    exercise a recycle that fails halfway: _new_pool constructs a real
    ProcessPoolExecutor, which can fail (out of fds, no /dev/shm)."""
    import asyncio
    import time as _time
    from concurrent.futures import ThreadPoolExecutor

    import server

    saved = (server._pool, server._HB, server._HB_IDX, server._kill_pool,
             server._new_pool, server._env_broken, server._warm)
    saved_out = sys.stdout
    pool = ThreadPoolExecutor(max_workers=1)
    hb = _StubValue(0)
    _RECYCLES.clear()
    try:
        server._pool, server._HB, server._HB_IDX = pool, hb, _StubValue(-1)
        server._env_broken = False
        server._warm = None if warm is None else (server._pool_gen, warm)
        # Stubbed so a reap exercises the supervision decision without tearing
        # down a real process pool underneath the test — and recorded, so a test
        # can assert the recovery ACTUALLY ran rather than inferring it from the
        # message the caller got back.
        server._kill_pool = lambda _p: _RECYCLES.append("kill")
        server._new_pool = (
            (lambda: (_RECYCLES.append("new"), pool)[1]) if new_pool is None
            else new_pool
        )

        async def _go():
            t0 = _time.monotonic()
            res = await server._run_stall(asyncio.get_running_loop(), job, hb, stall=stall)
            return res, _time.monotonic() - t0

        if stdout is not None:
            sys.stdout = stdout
        return asyncio.run(_go())
    finally:
        sys.stdout = saved_out
        (server._pool, server._HB, server._HB_IDX, server._kill_pool,
         server._new_pool, server._env_broken, server._warm) = saved
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


def _silent_slow_job(hb):
    """Never ticks, and runs past the stall window — the shape of a job that is
    simply QUEUED rather than wedged."""
    import time as _time
    _time.sleep(2.5)
    return {"ok": True, "did": "queued work"}


# --- field 383e7bfd: a 60 s stall on a document with NOTHING in it ------------
# The supervisor's clock used to run while a job sat in the queue behind the
# pool's cold warm-up (max_workers=1), so on a slow machine the first rebuild
# was reaped without executing an instruction — and the reap recycled the pool,
# putting the retry behind another cold import. These two pin BOTH directions:
# queue time is not charged, and a job that has actually started still is.

def test_a_job_queued_behind_the_warmup_is_not_reaped():
    """A job that never ticks and outlives the stall window survives while the
    warm-up is still holding the worker. Without the guard this is reaped at 1 s
    and the caller is told the kernel stalled, on a document that may be empty."""
    from concurrent.futures import Future

    warm = Future()  # deliberately never resolved: the worker is still coming up
    res, elapsed = _drive_run_stall(_silent_slow_job, stall=1.0, warm=warm)
    assert res.get("did") == "queued work", f"a queued job was reaped: {res}"
    assert elapsed >= 2.5, f"returned too early ({elapsed:.2f}s) to prove anything"
    print(f"{PASS} a job queued behind the warm-up survived {elapsed:.1f}s under a 1.0s stall")


def test_a_wedged_job_is_still_reaped_once_the_worker_is_up():
    """The counter-check, and the one that matters: the guard must not disable
    the watchdog. With the warm-up finished, a job that ticks and then wedges is
    still reaped on the same budget as before."""
    from concurrent.futures import Future

    warm = Future()
    warm.set_result(True)  # the worker came up; nothing is queued ahead
    res, elapsed = _drive_run_stall(_stalling_job, stall=1.0, warm=warm)
    err = (res or {}).get("error") or {}
    assert "stalled for over" in str(err.get("message", "")), \
        f"a wedged job was NOT reaped — the watchdog is disabled: {res}"
    assert elapsed < 5.0, f"reaped far too late ({elapsed:.2f}s)"
    print(f"{PASS} a wedged job was still reaped after {elapsed:.1f}s once the worker was up")


# --- field f3b9c287: a stall whose own DIAGNOSTIC raised -----------------------
# 0.1.171, Japanese Windows. We spawn the sidecar with piped stdio, so CPython
# gave sys.stdout the ANSI code page (cp932, errors='strict') — and the reaper's
# log line contains an em dash. The print raised UnicodeEncodeError from ABOVE
# the pool recycle, so the recycle never ran: with max_workers=1 the wedged
# worker held the only slot and every later geometry op blocked forever. The
# user saw the codec error where the import result should have been.

def _cp932_stdout():
    """A stdout that cannot encode the reaper's message — the field condition.

    Deliberately NOT the process's real stdout: server.py relaxes that one to
    backslashreplace at import (layer two). This stands in for the streams that
    layer cannot reach, and pins the property that matters independently of it —
    recovery survives a diagnostic that raises, whatever the reason."""
    import io
    return io.TextIOWrapper(io.BytesIO(), encoding="cp932", errors="strict",
                            write_through=True)


def test_a_diagnostic_that_raises_cannot_skip_the_pool_recycle():
    """The severe half of f3b9c287. A wedged job on an unencodable stdout must
    still recycle the pool exactly once, and must not propagate the codec error
    to the caller in place of the stall message."""
    out = _cp932_stdout()
    res, elapsed = _drive_run_stall(_stalling_job, stall=1.0, stdout=out)

    msg = str(((res or {}).get("error") or {}).get("message", ""))
    assert "stalled for over" in msg, \
        f"the codec error replaced the stall result: {res}"
    assert "codec" not in msg and "cp932" not in msg, \
        f"a stdout encoding leaked into the user-facing message: {msg}"
    assert _RECYCLES == ["kill", "new"], (
        "the wedged worker was NOT replaced (recycles: %r) — with max_workers=1 "
        "that is a dead geometry engine for the rest of the session" % (_RECYCLES,)
    )
    assert elapsed < 5.0, f"reaped far too late ({elapsed:.2f}s)"
    print(f"{PASS} a stall whose diagnostic raised still recycled the pool "
          f"({'+'.join(_RECYCLES)}) in {elapsed:.1f}s")


def test_the_reaper_logs_when_its_stdout_can_take_it():
    """The counter-check: making the print unable to fail must not make it
    silent. A 0.1.111 report of this exact stall arrived with a log holding only
    "LISTENING 8765" — swallowing the line would put us back there."""
    import io
    out = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", write_through=True)
    _drive_run_stall(_stalling_job, stall=1.0, stdout=out)
    logged = out.buffer.getvalue().decode("utf-8")
    assert "STALL:" in logged, f"the reaper logged nothing: {logged!r}"
    assert "recycling the worker pool" in logged, f"got {logged!r}"
    print(f"{PASS} the reaper still logs: {logged.strip().splitlines()[0][:60]}…")


def test_the_stall_line_survives_a_failed_pool_rebuild():
    """The other end of the ordering. Recovery-first is right, but it made the
    line conditional on the WHOLE recycle returning normally: _kill_pool is
    raise-proof, _new_pool builds a real ProcessPoolExecutor and is not (out of
    fds, no /dev/shm). If it throws, the caller gets that traceback — and without
    a `finally` the stall it was reacting to is nowhere in the log, which is the
    179-byte-log failure of 0.1.111 all over again."""
    import io

    def _new_pool_fails():
        _RECYCLES.append("new-raised")
        raise OSError("[Errno 24] Too many open files")

    out = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", write_through=True)
    raised = None
    try:
        _drive_run_stall(_stalling_job, stall=1.0, stdout=out,
                         new_pool=_new_pool_fails)
    except OSError as exc:
        raised = exc
    logged = out.buffer.getvalue().decode("utf-8")

    assert raised is not None, "precondition: the failing rebuild must propagate"
    assert "STALL:" in logged, \
        f"a failed pool rebuild swallowed the stall diagnostic: {logged!r}"
    assert "_stalling_job" in logged, f"got {logged!r}"
    # ...and the kill still ran, exactly once, BEFORE the rebuild attempt.
    assert _RECYCLES == ["kill", "new-raised"], _RECYCLES
    print(f"{PASS} rebuild raised {raised!r} and the stall was still logged")


def test_server_relaxes_its_own_stdio_error_handler():
    """Layer two: IMPORTING server must leave stdout unable to raise on an
    unencodable character. The spawn env sets PYTHONUTF8=1
    (src-tauri/src/sidecar.rs), but that does not cover a hand-started
    `python server.py`, a user with PYTHONIOENCODING set, or the spawn workers,
    which re-import this module and never run main().

    A SUBPROCESS, not an in-process call. The previous version of this test
    invoked `server._never_let_a_diagnostic_raise()` itself, so it proved the
    function works, never that anything CALLS it: with the module-level call
    commented out this test stayed green while `PYTHONIOENCODING=cp932 python -c
    'import server; print("a"*81 + "—")'` raised the field bug again, verbatim.
    Importing under the field's own env is the only thing that observes the
    effect."""
    import io
    import subprocess

    here = os.path.dirname(os.path.abspath(__file__))
    env = dict(os.environ)
    # cp932 with errors=strict is what CPython gave the field's Japanese Windows
    # box: the Rust shell pipes our stdio, a pipe is not a console, so stdout got
    # the ANSI code page. PYTHONUTF8 is dropped rather than left alone precisely
    # because this layer has to hold WITHOUT the spawn env's help.
    env["PYTHONIOENCODING"] = "cp932"
    env.pop("PYTHONUTF8", None)
    env["PYTHONPATH"] = here + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-c",
         # index 81 is the field report's exact position for the em dash
         'import sys, server; print(sys.stdout.errors); print("a" * 81 + "\\u2014")'],
        cwd=here, env=env, capture_output=True, timeout=180,
    )
    out = proc.stdout.decode("ascii", "replace")
    assert proc.returncode == 0, (
        "importing server left stdout able to raise:\n"
        + proc.stderr.decode("utf-8", "replace")[-600:])
    assert out.splitlines()[:1] == ["backslashreplace"], \
        f"stdout errors handler after `import server`: {out.splitlines()[:1]}"
    assert "\\u2014" in out, f"the em dash was not escaped: {out!r}"

    # ...and the guard must survive a stream that has no reconfigure at all
    # (StringIO under a test runner, a closed pipe): a hardening step must never
    # be the thing that fails startup. That half stays in-process — there is no
    # way to hand a subprocess a StringIO for its real stdout.
    import server

    saved = sys.stdout
    try:
        sys.stdout = io.StringIO()
        server._never_let_a_diagnostic_raise()
    finally:
        sys.stdout = saved
    print(f"{PASS} `import server` leaves stdout on backslashreplace, safely")


# --- field f3b9c287, part three: WHY the import stalled ------------------------
# Fixing the codec error and the skipped recycle only changes what the user is
# TOLD. Their STL still has to import. Measured here, importing a 124,668-
# triangle plate: 135.9 s in Mesher().read(), 23.2 s in _maybe_unify, 116.7 s in
# _refacet_clean — against a byte-derived budget of 90 s. It was reaped at 91 s
# while making real progress. Two halves to that: the parts with loops must tick
# from INSIDE them, and the parts that are one blocking OCCT call must be
# budgeted for honestly.

def test_refacet_ticks_from_inside_its_loops():
    """The lesson this project already paid for: a progress tick AROUND a long
    loop proves nothing — the gap the watchdog sees is INSIDE it. _refacet_clean
    is the longest stretch on the mesh-import path that HAS loops (it published
    nothing at all before), so this pins that every tick site is loop-nested. A
    later edit that hoists one out would restore the reap."""
    import ast

    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "builder.py")).read()
    fn = next(n for n in ast.walk(ast.parse(src))
              if isinstance(n, ast.FunctionDef) and n.name == "_refacet_clean")

    def _tick_calls(node):
        # The body of the `_tick_every` helper is the DEFINITION of a tick, not
        # a site where one is published — counting it would say the function
        # ticks somewhere it does not.
        helper = [f for f in ast.walk(node)
                  if isinstance(f, ast.FunctionDef) and f.name == "_tick_every"]
        skip = {id(c) for h in helper for c in ast.walk(h)}
        return [c for c in ast.walk(node)
                if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
                and c.func.id in ("progress_tick", "_tick_every")
                and id(c) not in skip]

    inside = []
    for loop in [n for n in ast.walk(fn) if isinstance(n, (ast.For, ast.While))]:
        inside += [c.func.id for c in _tick_calls(loop)]
    total = len(_tick_calls(fn))
    assert len(inside) >= 3, (
        "_refacet_clean publishes from only %d loop bodies — the watchdog reaps "
        "on the gap INSIDE a loop, not around it" % len(inside))
    # The two exceptions are deliberate and named: single blocking OCCT calls
    # (sew.Perform / ShapeFix_Shape.Perform) with nothing to tick inside, where a
    # tick BETWEEN them is the only honest signal there is.
    assert total - len(inside) <= 3, (
        "%d tick sites sit outside every loop; only the sew/ShapeFix pair should"
        % (total - len(inside)))
    print(f"{PASS} _refacet_clean ticks from {len(inside)} loop-nested sites "
          f"({total} total)")


def test_a_liveness_tick_leaves_the_running_phase_named():
    """Ticking from inside _refacet_clean must not cost the diagnostic its name.

    The ticks are published through the SAME channel that says WHAT is running,
    and they used to publish -1 ("no feature"), so the first one erased the
    import phase: `_import_phase(1)` said "Simplifying faces", the first tick
    turned it into -1, and nothing on the mesh path ever set it back — so the
    stall line these ticks exist to make useful said "(feature index -1)" and the
    crash reply's feature_index named nothing either.

    Driven through server._heartbeat_hook, the REAL hook the worker installs, so
    this observes the index left behind rather than that a callback was called.
    """
    from build123d import Box, Pos

    import server

    hb, hb_idx = _StubValue(0), _StubValue(-1)
    prev = builder.on_feature_tick
    builder.on_feature_tick = server._heartbeat_hook(hb, hb_idx)
    try:
        builder._import_phase(builder.IMPORT_PHASE_CANONICALIZE)
        assert hb_idx.value == builder.IMPORT_PHASE_CANONICALIZE, \
            "precondition: the phase must be published before the long stretch"
        before = hb.value

        # the staircase body from test_smoke's refacet coverage: two boxes fused
        # 0.05 mm out of line, which is the one small fixture that reaches EVERY
        # tick site (region grow, sew, ShapeFix, component walk, validate)
        part = Box(20, 20, 10) + Pos(0.05, 0, 9.95) * Box(20, 20, 10)
        cleaned = builder._refacet_clean(part)
        assert cleaned is not part, \
            "precondition: the fixture must take the full path, not the early out"

        assert hb.value > before, "no liveness reached the heartbeat at all"
        assert hb_idx.value == builder.IMPORT_PHASE_CANONICALIZE, (
            "a liveness tick overwrote the running phase with %d — the stall line "
            "and the crash reply now name nothing" % hb_idx.value)

        # The counter-check: -1 still MEANS "no feature is building". Making the
        # liveness tick preserve the index must not take that away, or the
        # timeline would claim a feature is building while the payload meshes.
        builder.progress_tick()
        assert hb_idx.value == -1, \
            f"the meshing tick stopped clearing the index (got {hb_idx.value})"
    finally:
        builder.on_feature_tick = prev
    print(f"{PASS} {hb.value - before} liveness ticks through _refacet_clean, "
          f"phase still named")


def test_the_stall_line_names_the_phase_it_reaped():
    """The same claim at the altitude the user sees it: the line in the log.

    A 0.1.111 field report of a stall arrived with a log holding only
    "LISTENING 8765"; the line exists now, and it has to carry the one thing that
    survives the kill. A worker that publishes a phase, ticks for liveness and
    then wedges must be reported AS THAT PHASE."""
    import io

    import server

    def _phase_then_wedge(hb):
        import time as _time
        # the real hook over the supervisor's own stub Values, so the job
        # publishes exactly the way a worker does
        prev = builder.on_feature_tick
        builder.on_feature_tick = server._heartbeat_hook(hb, server._HB_IDX)
        try:
            builder._import_phase(builder.IMPORT_PHASE_CANONICALIZE)
            for _ in range(3):
                _time.sleep(0.1)
                builder.progress_tick(keep_index=True)
            _time.sleep(6.0)  # wedged
        finally:
            builder.on_feature_tick = prev
        return {"ok": True, "did": "should never be returned"}

    out = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", write_through=True)
    res, _elapsed = _drive_run_stall(_phase_then_wedge, stall=1.0, stdout=out)
    logged = out.buffer.getvalue().decode("utf-8")
    assert res["error"]["code"] == "stalled", res
    assert "feature index -1" not in logged, \
        f"the reaper lost the phase it was reaping: {logged.strip()!r}"
    assert "feature index %d" % builder.IMPORT_PHASE_CANONICALIZE in logged, \
        f"got {logged.strip()!r}"
    print(f"{PASS} {logged.strip().splitlines()[0][:90]}…")


def _fake_binary_stl(ntri):
    """A binary STL header declaring `ntri` triangles, with the body zero-filled.
    The size identity (84 + 50n) is what makes it a VALID binary STL to every
    reader, and it is exactly what the estimate reads — no geometry needed."""
    import struct
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".stl")
    with os.fdopen(fd, "wb") as fh:
        fh.write(b"\0" * 80 + struct.pack("<I", ntri))
        fh.truncate(84 + 50 * ntri)  # sparse: no 6 MB actually written
    return path


def _fake_meshes(ntri):
    """One fixture per mesh ENCODING, each holding exactly `ntri` triangles.

    The content is repeated boilerplate rather than real geometry: nothing here
    parses these, they are only counted, and repetition is what keeps a 60k-
    triangle fixture a single write() instead of a loop. Every encoding is
    deliberately at its COMPACT end (single-digit coordinates), because that is
    the end a bytes-per-triangle guess under-counts — which is the direction
    that reaps a healthy import.

    Returns [(label, path, fmt, ntri)]."""
    import json as _json
    import struct
    import tempfile
    import zipfile

    d = tempfile.mkdtemp(prefix="sindri-mesh-enc-")
    out = []

    def _w(name, data, mode="wb"):
        p = os.path.join(d, name)
        with open(p, mode) as fh:
            fh.write(data)
        return p

    facet = (b"facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\n"
             b"vertex 0 1 0\nendloop\nendfacet\n")
    out.append(("ascii STL, compact floats",
                _w("compact.stl", b"solid x\n" + facet * ntri + b"endsolid x\n"),
                "stl", ntri))
    out.append(("OBJ, triangle faces",
                _w("tri.obj", b"v 0 0 0\n" * (ntri * 3) + b"f 1 2 3\n" * ntri),
                "obj", ntri))
    # Blender's default export is QUADS: half as many `f` lines as triangles,
    # so a face-line count (which is what builder._peek_triangle_count does) is
    # exactly 0.5x here and the budget it buys is 0.25x.
    nquad = ntri // 2
    out.append(("OBJ, quad faces (fanned)",
                _w("quad.obj", b"v 0 0 0\n" * (nquad * 4) + b"f 1 2 3 4\n" * nquad),
                "obj", nquad * 2))
    model = (b'<?xml version="1.0"?><model><resources><object id="1"><mesh>'
             b"<vertices/><triangles>"
             + b'<triangle v1="0" v2="1" v3="2"/>' * ntri
             + b"</triangles></mesh></object></resources></model>")
    p3 = os.path.join(d, "m.3mf")
    with zipfile.ZipFile(p3, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("3D/3dmodel.model", model)
    out.append(("3MF", p3, "3mf", ntri))
    # A GLB's triangle count lives in its accessors, and the file itself can be
    # a few hundred bytes however dense the mesh is — which is why sizing it
    # from BYTES is hopeless rather than merely inaccurate.
    doc = _json.dumps({
        "asset": {"version": "2.0"},
        "accessors": [{"count": ntri * 3, "componentType": 5125, "type": "SCALAR"}],
        "meshes": [{"primitives": [{"indices": 0, "attributes": {"POSITION": 0}}]}],
        "nodes": [{"mesh": 0}],
        "scenes": [{"nodes": [0]}],
    }).encode("utf-8")
    doc += b" " * (-len(doc) % 4)  # glTF requires 4-byte chunk alignment
    glb = (b"glTF" + struct.pack("<II", 2, 12 + 8 + len(doc))
           + struct.pack("<I", len(doc)) + b"JSON" + doc)
    out.append(("GLB", _w("m.glb", glb), "glb", ntri))
    out.append(("binary STL", _fake_binary_stl(ntri), "stl", ntri))
    return d, out


def test_the_triangle_count_is_exact_for_every_mesh_encoding():
    """The budget must not depend on which exporter wrote the file.

    Before this, only a binary STL was counted; every other format was
    `size / bytes_per_triangle` against a table fitted to ONE exporter each
    ({stl: 250, 3mf: 75, obj: 55, glb: 40}). Measured on this machine at 50,188
    triangles from one plate: a `%g` ASCII STL is 131.2 B/tri (estimate 0.53x
    truth), a `%g` OBJ 39.6 against 55 (0.72x), an OCCT-written ASCII STL 289.0
    (1.16x). An estimate of 0.53x buys 0.28x of the budget, so the field
    report's own format one encoding over was still reaped.

    Asserted as the EFFECT — the budget each encoding is handed — and not only
    as the count, because the count is a means and the deadline is the thing
    that kills an import. `ntri` is above the floor on purpose: at a few hundred
    triangles every encoding returns the 90 s floor and the check passes
    vacuously."""
    import server

    ntri = 60_000
    honest = server._mesh_import_budget(ntri)
    assert honest > server._MESH_BUDGET_FLOOR, (
        "fixture is too small to be a witness: %d triangles is still on the "
        "%.0fs floor, where every encoding agrees" % (ntri, honest))
    d, fixtures = _fake_meshes(ntri)
    try:
        worst = 1e9
        for label, path, fmt, truth in fixtures:
            got = server._mesh_triangle_estimate(path, fmt)
            # +1 tolerance: "<triangle" also matches 3MF's own <triangles>
            # container element. Over by one, never under.
            assert truth <= got <= truth + 1, (
                "%s: counted %d triangles, not %d (%.2fx) — %.1f B/tri"
                % (label, got, truth, got / truth,
                   os.path.getsize(path) / truth))
            budget = server._mesh_import_budget(got)
            # Pinned BOTH ways: >= the honest budget is what stops a reap, and
            # <= the budget one triangle up is what stops "just multiply
            # everything by ten" passing as a fix. Together they say the
            # deadline does not depend on which exporter wrote the file.
            assert budget >= server._mesh_import_budget(truth), (
                "%s: handed a %.0fs deadline for a read that honestly needs "
                "%.0fs" % (label, budget, server._mesh_import_budget(truth)))
            assert budget <= server._mesh_import_budget(truth + 1), (
                "%s: %.0fs is more than the honest %.0fs — the watchdog is "
                "being softened, not fixed"
                % (label, budget, server._mesh_import_budget(truth)))
            worst = min(worst, budget / honest)
        print(f"{PASS} all {len(fixtures)} encodings counted exactly at "
              f"{ntri:,} tri; tightest budget {worst:.2f}x the honest one")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_an_uncountable_mesh_errs_LONG_rather_than_short():
    """What is left when the exact count cannot be had — and which way it leans.

    Two ways out of the count: the scan window runs out (a huge ASCII STL, a
    3MF whose .model is past MAX_IMPORT_SCAN_BYTES) or the file isn't shaped the
    way the format says. Both land on _MESH_BYTES_PER_TRI, and those constants
    are now the LOWEST plausible rate per format rather than the typical one, so
    the fallback over-counts. That direction is chosen: over-counting only makes
    a wedged worker sit longer (bounded by the clamp), under-counting destroys a
    working import with no recourse.

    The scan window is shrunk rather than a 64 MiB file written — the behaviour
    under test is what happens when the scan gives up, not the size at which it
    does."""
    import zipfile

    import server

    ntri = 60_000
    d, fixtures = _fake_meshes(ntri)
    real = server.MAX_IMPORT_SCAN_BYTES
    try:
        server.MAX_IMPORT_SCAN_BYTES = 4096  # every text fixture is past this
        for label, path, fmt, truth in fixtures:
            if fmt == "glb" or label == "binary STL":
                continue  # neither is scanned: both count from a header
            got = server._mesh_triangle_estimate(path, fmt)
            assert got >= truth, (
                "%s: the scan gave up and the fallback under-counted (%d vs %d) "
                "— a short deadline reaps a working import" % (label, got, truth))
    finally:
        server.MAX_IMPORT_SCAN_BYTES = real
        shutil.rmtree(d, ignore_errors=True)

    # ...and erring long cannot switch the watchdog off: a zip-bombed 3MF
    # declaring 80 MiB of XML is past the scan window, so it takes the byte
    # fallback, and the clamp still holds it to the cap's deadline.
    import tempfile
    fd, bomb = tempfile.mkstemp(suffix=".3mf")
    os.close(fd)
    try:
        with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("3D/3dmodel.model", b"\0" * (80 * 1024 * 1024))
        n = server._mesh_triangle_estimate(bomb, "3mf")
        at_cap = server._mesh_import_budget(server.MAX_IMPORT_TRIANGLES)
        assert n > server.MAX_IMPORT_TRIANGLES, n
        assert server._mesh_import_budget(n) == at_cap, \
            "a hostile 3MF bought more than the cap's deadline"
        print(f"{PASS} an uncountable mesh over-counts (never under), and a "
              f"zip-bombed 3MF still lands on the {at_cap:.0f}s cap deadline")
    finally:
        os.unlink(bomb)


# Mesh-import cost, RE-MEASURED on THIS machine (AMD Ryzen 9 7900X, 24 threads,
# 2026-08-21) over a plate of 196-340 through-holes exported to 3MF at five
# densities, two full passes, with occt_smp.configure() called first exactly as
# the worker does. Harness: time every builder.on_feature_tick, run
# builder.import_geometry(), report the gaps.
#
# TWO numbers per density, because they are not the same quantity:
#
#   gap    the LONGEST stretch of the import with no heartbeat tick in it. This
#          is what the watchdog actually measures — _run_stall resets its clock
#          on every change of _HB (server.py, "if cur != last") and every
#          builder tick bumps _HB (_heartbeat_hook) — so this is the number the
#          budget has to clear, and it is what an honest budget is sized from.
#   total  the whole import, entry to return. The budget does not have to clear
#          this; it is asserted against anyway, because a guard that only holds
#          while the ticks hold is a guard resting on another guard, and a
#          mesh import ticks 533-1169 times where it used to tick zero.
#
#      ntri        gap s          total s
#     50,188    11.6 / 11.7     43.8 / 43.4
#     73,708    20.2 / 18.7     83.2 / 81.0
#     83,900    22.8 / 22.6     95.4 / 94.0
#    123,704    46.8 / 45.7    164.9 / 162.1
#    145,532    62.4 / 62.5    210.2 / 209.8
#
# Repeats agree within 3%. The ENCODING was then varied at two of those
# densities, same triangles, same plate — and it does move the cost, though far
# less than the count does:
#
#    123,704   ascii STL 45.1 / 161.3    3MF 46.8 / 164.9
#              OBJ       55.5 / 188.6    GLB 63.5 / 206.9
#                                 binary STL 63.7 / 214.4
#     50,188   ascii STL 11.2 /  42.6    3MF 11.6 /  43.8
#              OBJ       11.2 /  42.8    GLB 11.3 /  43.3
#                                 binary STL 11.6 /  43.4
#
# so the spread across encodings is 1.0x at 50k and 1.33x at 124k, all of it in
# the shared sew + unify + refacet path rather than the parse. The figures the
# table below holds are the WORST seen at each density across every pass AND
# every encoding — 123,704 therefore carries binary STL's 63.7 / 214.4, not
# 3MF's. 73,708 / 83,900 / 145,532 were measured as 3MF only, so if they carry
# the same 1.33x they are optimistic by that much; the margins are wide enough
# to say so out loud rather than pad the numbers.
#
# WHY THE PREVIOUS TABLE WAS REPLACED: it recorded ONE number per density and
# called it "the read", on the premise that a mesh import was "one blocking
# lib3mf call, no loop to tick inside". That premise is no longer true —
# _import_phase publishes and _refacet_clean ticks from inside its loops (see
# test_refacet_ticks_from_inside_its_loops) — so the single number it held was
# neither of the two above, and the ratio computed from it was not the
# watchdog's margin. Its 124,668 -> 169.8 s entry matches the 3MF TOTAL measured
# here at 123,704 (164.9 s) almost exactly; its 50,188 -> 19.4 s matches
# neither column.
#
# WHAT THIS TABLE IS: a regression guard on _MESH_READ_DIV, _MESH_BUDGET_HEADROOM
# and _MESH_BUDGET_FLOOR. Nothing in this suite times a real import, and nothing
# here should be cited as proof that field f3b9c287 is closed — it is a
# machine-speed measurement with a date on it, and a slower box or a slower
# lib3mf moves the reads while leaving the suite green. What it can catch is
# someone tightening the constants past what this machine measured.
_MEASURED_IMPORT = {
    50_188: (11.7, 43.8),
    73_708: (20.2, 83.2),
    83_900: (22.8, 95.4),
    123_704: (63.7, 214.4),
    145_532: (62.5, 210.2),
}
_MEASURED_TOTAL = {n: t for n, (_g, t) in _MEASURED_IMPORT.items()}


def test_a_mesh_import_is_budgeted_by_triangles_not_bytes():
    """The reaped import, in numbers. A 123,704-triangle binary STL is 5.90 MiB,
    so the byte formula gave it 90 s for an import measured at 214.4 s total
    here, with a 63.7 s silent stretch inside it."""
    import server

    ntri = 123_704
    gap, total = _MEASURED_IMPORT[ntri]
    path = _fake_binary_stl(ntri)
    try:
        assert server._mesh_triangle_estimate(path, "stl") == ntri, \
            "a binary STL's count is in its header — it must be exact, not estimated"
        n = server._mesh_triangle_estimate(path, "stl")
        budget = server._mesh_import_budget(n)
        old = max(90.0, 60.0 + 1.5 * (os.path.getsize(path) / (1024 * 1024)))
        assert old < total, \
            f"precondition: the old budget was under the import ({old:.0f}s)"
        assert budget > 2 * total, \
            f"budget {budget:.0f}s leaves no room over the measured import"

        # A format with no mesh in it must fall through to the byte budget
        # rather than being handed a triangle count of nowhere.
        assert server._mesh_triangle_estimate(path, "step") == 0
        assert server._mesh_triangle_estimate("/no/such/file.stl", "stl") == 0
        print(f"{PASS} {ntri:,} tri: budget {budget:.0f}s vs the old {old:.0f}s "
              f"(measured {total:.0f}s total, {gap:.0f}s silent)")
    finally:
        os.unlink(path)


def test_the_budget_clears_every_import_measured_across_the_range():
    """The whole accepted range, not one point, and against BOTH quantities.

    `gap` is the honest comparison: it is the longest tick-free stretch, which
    is the only thing _run_stall can reap on. `total` is the pessimistic one —
    what the deadline would have to cover if the ~1,000 ticks a mesh import now
    publishes were ever lost — and 2x is asserted against THAT, so the guard
    does not quietly depend on the tick coverage a different test owns.

    Asserted on the helper's RETURN VALUE. The version of this check that
    matched a source substring could not survive the retune it was guarding.

    This proves the constants still clear what this machine measured on
    2026-08-21. It does not prove an import cannot be reaped: nothing here times
    a real read, so a slower box, a slower lib3mf or a mesh whose SHAPE costs
    more at the same triangle count moves the reads with the suite still
    green. That is what the headroom in _mesh_import_budget is for, and why the
    margins are printed rather than merely checked."""
    import server

    worst_total, worst_gap = 0.0, 0.0
    for ntri, (gap, total) in sorted(_MEASURED_IMPORT.items()):
        budget = server._mesh_import_budget(ntri)
        assert budget >= 2 * total, (
            "%d tri: budget %.0fs against a %.0fs measured import — under 2x, so "
            "a slower machine loses it" % (ntri, budget, total))
        worst_total = max(worst_total, total / budget)
        worst_gap = max(worst_gap, gap / budget)
    # ...and the range does not stop at the largest fixture: the cap is what a
    # user's file is actually allowed to reach.
    at_cap = server._mesh_import_budget(server.MAX_IMPORT_TRIANGLES)
    assert at_cap > 2 * max(_MEASURED_TOTAL.values()), \
        f"the budget at the cap ({at_cap:.0f}s) is under 2x the slowest import seen"
    assert at_cap == max(server._mesh_import_budget(n)
                         for n in (100_000, 149_999, server.MAX_IMPORT_TRIANGLES)), \
        "the budget must be monotone in the triangle count"
    print(f"{PASS} every measured import clears 2x total "
          f"(tightest {1 / worst_total:.1f}x) and {1 / worst_gap:.0f}x its silent "
          f"stretch; {at_cap:.0f}s at the {server.MAX_IMPORT_TRIANGLES:,} cap "
          f"= how long a WEDGED worker sits")


def test_the_import_budget_cannot_be_talked_into_infinity():
    """`_ntri` comes from a file that may be hostile: a 3MF whose .model
    declares a gigabyte of uncompressed XML would otherwise buy an unbounded
    stall budget, i.e. switch the watchdog off. The clamp is what stops that, and
    it must not clip a legitimate MAX_IMPORT_TRIANGLES import.

    By VALUE, not by source substring. The previous version of this asserted the
    formula's exact text, which meant any retune — including the one this test
    exists to keep honest — failed it for a non-behavioural reason."""
    import server

    assert server.MAX_IMPORT_TRIANGLES == builder.MAX_IMPORT_TRIANGLES, (
        "server mirrors the cap rather than importing builder; the two have "
        "drifted (%d vs %d)"
        % (server.MAX_IMPORT_TRIANGLES, builder.MAX_IMPORT_TRIANGLES))
    assert server.MAX_IMPORT_SCAN_BYTES == builder.MAX_IMPORT_SCAN_BYTES, (
        "server mirrors the scan window too — the two have drifted "
        "(%d vs %d)"
        % (server.MAX_IMPORT_SCAN_BYTES, builder.MAX_IMPORT_SCAN_BYTES))

    at_cap = server._mesh_import_budget(server.MAX_IMPORT_TRIANGLES)
    # A declared count past the cap buys NOTHING: the worker refuses that file
    # before it reads a byte, so the budget for it is the cap's budget.
    for absurd in (server.MAX_IMPORT_TRIANGLES + 1, 14_000_000, 2 ** 62):
        assert server._mesh_import_budget(absurd) == at_cap, \
            f"{absurd:,} declared triangles bought a longer stall budget"
    # A legitimate large import is not clipped: the cap's budget must still be
    # the honest deadline for a 150k-triangle read, not a shorter round number.
    assert at_cap > 2 * max(_MEASURED_TOTAL.values()), \
        f"the clamp now clips a legitimate {server.MAX_IMPORT_TRIANGLES:,}-tri import"
    # ...and nothing pathological gets a budget of zero at the bottom.
    for silly in (0, -1, 1):
        assert server._mesh_import_budget(silly) == 90.0, silly
    print(f"{PASS} budget at the {server.MAX_IMPORT_TRIANGLES:,} cap "
          f"{at_cap:.0f}s, and a hostile count buys no more")


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
    test_a_job_queued_behind_the_warmup_is_not_reaped()
    test_a_wedged_job_is_still_reaped_once_the_worker_is_up()
    test_a_diagnostic_that_raises_cannot_skip_the_pool_recycle()
    test_the_reaper_logs_when_its_stdout_can_take_it()
    test_the_stall_line_survives_a_failed_pool_rebuild()
    test_server_relaxes_its_own_stdio_error_handler()
    test_refacet_ticks_from_inside_its_loops()
    test_a_liveness_tick_leaves_the_running_phase_named()
    test_the_stall_line_names_the_phase_it_reaped()
    test_a_mesh_import_is_budgeted_by_triangles_not_bytes()
    test_the_triangle_count_is_exact_for_every_mesh_encoding()
    test_an_uncountable_mesh_errs_LONG_rather_than_short()
    test_the_budget_clears_every_import_measured_across_the_range()
    test_the_import_budget_cannot_be_talked_into_infinity()
    test_the_document_ops_no_longer_use_a_wall_clock()
    print("all heartbeat tests passed")
