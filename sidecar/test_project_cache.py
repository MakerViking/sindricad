"""Projection must not poison the rebuild cache (sidecar/builder.py).

Run: uv run python test_project_cache.py

`projectGeometry` builds a TRUNCATED timeline prefix while the human's own
editing session continues against the full document. `_CACHE` is module state
keyed on the last document built, so before `readonly=True` a single pick left
the cache describing only the prefix — and the human's next rebuild of their
UNCHANGED document resumed from the cut point instead of the tip. Measured over
a real socket on a 46-feature document: 0.121 s -> 3.173 s.

Two mechanisms, and a test that only covers one of them would pass while the
other still cost seconds:
  1. `feature_sigs` truncated to the prefix, bounding the next prefix-match loop.
  2. `proj_quiet` written False (an aux caller passes no `projections=`), which
     falsifies the quiet-proof and pulls the NEXT build's resume all the way down
     to `proj_cap` — the EARLIEST projected sketch in the timeline, not the cut
     point. On one measured document that was resume 5 rather than 19, and it
     accounted for essentially the whole penalty on its own.

The poisoning also happened when the pick FAILED, because the cache write is
upstream of any per-source outcome — so that case is asserted too.
"""

import os
import time

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

import builder  # noqa: E402

PASS = "  ok"


def _doc(n=12):
    """n disjoint boxes = 2n features, each non-trivial enough to time."""
    feats = []
    for i in range(n):
        feats += [
            {"id": f"s{i}", "type": "sketch", "plane": "XY",
             "entities": [{"type": "rectangle", "width": 10, "height": 10, "x": i * 14, "y": 0}]},
            {"id": f"e{i}", "type": "extrude", "sketch": f"s{i}", "distance": 5,
             "operation": "new"},
        ]
    return {"parameters": {}, "features": feats}


def _reset():
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}


def test_a_readonly_prefix_build_leaves_the_cache_at_the_tip():
    doc = _doc()
    prefix = {"parameters": {}, "features": doc["features"][:8]}
    n = len(doc["features"])

    _reset()
    builder.rebuild_cached(doc)
    assert len(builder._CACHE["feature_sigs"]) == n

    builder.rebuild_cached(prefix, readonly=True)
    assert len(builder._CACHE["feature_sigs"]) == n, (
        f"a readonly prefix build truncated the cache to "
        f"{len(builder._CACHE['feature_sigs'])} of {n}")
    assert builder._CACHE["snaps"], "readonly must not drop the tail snapshots"
    print(PASS, f"a readonly prefix build leaves feature_sigs at the tip ({n})")


def test_readonly_does_not_touch_proj_quiet():
    """The subtle half. `proj_quiet` must be left EXACTLY as the last real build
    wrote it — asserting `is False` would pass vacuously, since an aux caller
    passing no `projections=` writes False anyway. Set it True first, then prove
    a readonly build cannot clear it."""
    doc = _doc()
    prefix = {"parameters": {}, "features": doc["features"][:8]}

    _reset()
    builder.rebuild_cached(doc, projections=[])  # a real build with a quiet proof
    assert builder._CACHE.get("proj_quiet") is True, "setup: expected a quiet proof"

    builder.rebuild_cached(prefix, readonly=True)
    assert builder._CACHE.get("proj_quiet") is True, (
        "a readonly build cleared proj_quiet — the next rebuild will be capped at "
        "the earliest projected sketch, not the cut point")
    print(PASS, "a readonly build leaves proj_quiet untouched")


def test_the_next_rebuild_is_free_after_a_pick():
    doc = _doc()
    prefix = {"parameters": {}, "features": doc["features"][:8]}

    def timed(fn):
        t = time.perf_counter()
        fn()
        return time.perf_counter() - t

    _reset()
    builder.rebuild_cached(doc)
    control = min(timed(lambda: builder.rebuild_cached(doc)) for _ in range(3))

    builder.rebuild_cached(prefix, readonly=True)
    after = timed(lambda: builder.rebuild_cached(doc))

    # generous: the control is ~0 and the poisoned path replays 16 features.
    assert after <= max(control * 4, control + 0.05), (
        f"rebuild after a readonly pick cost {after:.4f}s vs a {control:.4f}s control "
        "— the cache was poisoned")

    # ...and prove the test can fail: the same pick WITHOUT readonly must truncate.
    builder.rebuild_cached(prefix)
    assert len(builder._CACHE["feature_sigs"]) == 8, (
        "control arm: a non-readonly prefix build should still truncate the cache "
        "(if this fails, the test no longer discriminates)")
    print(PASS, f"rebuild after a pick stays warm ({after:.4f}s vs {control:.4f}s control)")


def test_a_failed_pick_does_not_poison_either():
    """The cache write is upstream of any per-source outcome, so a pick that
    refuses (an ambiguous by:"nearest") poisoned the cache too — measured at
    2.463 s. project_geometry passes readonly on the CALL, not on success."""
    doc = _doc()
    n = len(doc["features"])
    _reset()
    builder.rebuild_cached(doc)

    try:
        builder.project_geometry(
            {"parameters": {}, "features": doc["features"][:8]},
            "XY",
            [{"kind": "bodyEdge", "body": "nope", "sel": {"kind": "edge", "by": "all"}}],
        )
    except Exception:
        pass  # the pick's own outcome is not what this test is about

    assert len(builder._CACHE["feature_sigs"]) == n, (
        f"a failed projection truncated the cache to "
        f"{len(builder._CACHE['feature_sigs'])} of {n}")
    print(PASS, "a projection that refuses still leaves the cache at the tip")


def test_readonly_still_reads_the_disk_tier():
    """readonly suppresses WRITES only. The disk resume is gated on `store`, not
    on `persist`, so it must survive — otherwise every pick after a document open
    becomes a cold full replay."""
    import inspect

    src = inspect.getsource(builder.rebuild_cached)
    assert "persist = None" in src and "and not readonly" in src, \
        "readonly should suppress writes by withholding `persist`"
    assert "_restore_from_disk" in src, "the disk read path must still be reachable"
    # the disk read must NOT be gated on readonly
    for line in src.splitlines():
        if "_restore_from_disk" in line:
            assert "readonly" not in line, f"disk READ gated on readonly: {line.strip()}"
    print(PASS, "readonly withholds `persist` (writes) without gating the disk read")


def main():
    print("Projection cache-poisoning tests")
    test_a_readonly_prefix_build_leaves_the_cache_at_the_tip()
    test_readonly_does_not_touch_proj_quiet()
    test_the_next_rebuild_is_free_after_a_pick()
    test_a_failed_pick_does_not_poison_either()
    test_readonly_still_reads_the_disk_tier()
    print("ALL PASS")


if __name__ == "__main__":
    main()
