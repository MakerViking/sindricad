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


if __name__ == "__main__":
    print("heartbeat ticks (stall watchdog)")
    test_export_mesh_ticks_on_every_tier()
    test_interference_sweep_ticks_per_row()
    test_interference_sweep_ticks_around_each_boolean()
    test_checkpoint_write_ticks_per_body()
    test_tick_hook_is_restored()
    test_progress_tick_survives_a_broken_hook()
    print("all heartbeat tests passed")
