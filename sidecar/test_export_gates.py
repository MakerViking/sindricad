"""Export gates: tolerance keying, triangle budgets, the interference sweep, and
separate-body filenames.

Run: uv run python test_export_gates.py

Each of these was a way around a limit that the plain export path enforces —
a cache that ignored tolerance, a budget checked after the allocation it was
meant to bound, a quadratic bbox walk, and a set of filenames that could
silently overwrite each other.
"""

import os
import shutil
import sys
import tempfile

os.environ.setdefault("SINDRI_DISK_CACHE", "0")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import builder  # noqa: E402
import server  # noqa: E402

PASS = "  ok"


def _box_doc(n=1, size=20, gap=40):
    feats = []
    for i in range(n):
        feats.append({"id": f"b{i}", "type": "box", "length": size,
                      "width": size, "height": size})
        if i:
            feats.append({"id": f"m{i}", "type": "move", "dx": i * gap})
    return {"parameters": {}, "features": feats}


def _live(doc):
    _p, err, bodies = builder.rebuild_cached(doc)
    assert not err, err
    return [b for b in bodies if b.get("shape") is not None]


# --- 3.1 tolerance belongs in the cache key ----------------------------------


def test_the_export_cache_keys_on_tolerance():
    """A retry at a different tolerance must RECOMPUTE, not be served the mesh
    the previous attempt built.

    Without tolerance in the key a tolerance BACKOFF (the natural response to a
    triangle-budget refusal) is a silent no-op: it returns the existing mesh, so
    the retry looks like it worked while changing nothing, and blows the same
    budget again with nothing to explain why.

    Asserted by counting tessellations rather than by comparing triangle counts.
    For many shapes the ANGULAR tolerance dominates — a sphere meshes identically
    at 0.02 and at 1.0 — so equal output would not have meant a cache hit."""
    import tessellate as _tess

    server._EXPORT_MESH_CACHE.clear()
    b = _live({"parameters": {}, "features": [
        {"id": "s", "type": "sphere", "radius": 20}]})[0]

    calls = []
    real = _tess.tessellate
    _tess.tessellate = lambda *a, **k: (calls.append(k.get("tolerance")), real(*a, **k))[1]
    try:
        server._export_mesh(b)                 # cold
        assert len(calls) == 1, calls
        server._export_mesh(b)                 # same tolerance -> cache hit
        assert len(calls) == 1, f"recomputed at an unchanged tolerance: {calls}"
        fine = server._export_mesh(b, tol=0.001)   # different -> must recompute
        assert len(calls) == 2, f"served a stale mesh at a new tolerance: {calls}"
        assert calls[1] == 0.001, calls
    finally:
        _tess.tessellate = real

    # And the tolerance genuinely round-trips: back at export grade the mesh is
    # coarse again. This is the half the plan did not anticipate — OCCT stores
    # the triangulation ON THE SHAPE and treats an existing finer mesh as good
    # enough for a coarser request, so before this the 0.02 call came back with
    # the 201,198-triangle mesh from the 0.001 call. A backoff would have been a
    # no-op with the cache key fixed and everything else correct.
    back = server._export_mesh(b)
    assert len(back[1]) // 3 < len(fine[1]) // 3, (
        f"asked for 0.02 after 0.001 and got {len(back[1]) // 3} triangles — "
        "OCCT reused the finer triangulation"
    )
    print(f"{PASS} export tolerance round-trips: {len(back[1]) // 3} tris at 0.02, "
          f"{len(fine[1]) // 3} at 0.001, back to {len(back[1]) // 3}")


# --- 3.3 / 3.4 the budget is checked before the allocation --------------------


def test_the_triangle_budget_is_checked_per_body_not_after_everything():
    """The cap exists to stop an unbounded allocation. Checked only on the
    concatenated total, it has already allowed exactly that before it fires."""
    server._EXPORT_MESH_CACHE.clear()
    live = _live(_box_doc(4))
    seen = []
    real = server._export_mesh
    # A cap low enough that body 2 crosses it. If the check runs after the loop,
    # all four get meshed first.
    server._export_mesh = lambda b, tol=None: (seen.append(b["id"]), real(b, tol))[1]
    old_cap = server.EXPORT_TRIANGLE_HARD_CAP
    server.EXPORT_TRIANGLE_HARD_CAP = 20  # a box is 12 triangles
    try:
        with tempfile.TemporaryDirectory() as d:
            try:
                server._export_job({"parameters": {}, "features": _box_doc(4)["features"]},
                                   "stl", os.path.join(d, "out.stl"))
                assert False, "expected a density refusal"
            except ValueError as ex:
                assert "too dense" in str(ex), ex
        assert len(seen) < 4, (
            f"meshed all {len(seen)} bodies before refusing — the budget ran "
            "after the allocation it exists to bound"
        )
    finally:
        server._export_mesh = real
        server.EXPORT_TRIANGLE_HARD_CAP = old_cap
    print(f"{PASS} budget refused after {len(seen)} of 4 bodies, not all 4")


def test_export_project_has_a_budget_at_all():
    """This path had none, which made it the way around every cap."""
    server._EXPORT_MESH_CACHE.clear()
    old_cap = server.EXPORT_TRIANGLE_HARD_CAP
    server.EXPORT_TRIANGLE_HARD_CAP = 20
    try:
        with tempfile.TemporaryDirectory() as d:
            res = server._export_project_job(
                _box_doc(4), os.path.join(d, "p.3mf"), [], {}, {}, {})
        assert "error" in res, f"project export ignored the budget: {res}"
        assert "too dense" in res["error"]["message"], res
    finally:
        server.EXPORT_TRIANGLE_HARD_CAP = old_cap
    print(f"{PASS} exportProject refuses past the triangle budget")


# --- 3.5 one bbox per body, not one per pair ---------------------------------


def test_the_interference_sweep_computes_each_bbox_once():
    """O(n^2) in pairs, O(n) in shapes. Computing the box inside the pair test
    did 9,360,540 OCCT walks at 3,060 bodies to learn 3,060 things.

    Each walk is expensive (95.5 s over the reference assembly's 3,072 bodies), so
    the count is what keeps the sweep survivable — the precompute also ticks per
    body now, because unticked it was reaped at STALL_TIMEOUT."""
    doc = _box_doc(8)
    builder.rebuild_cached(doc)  # warm
    calls = []
    real = builder.bbox_of
    builder.bbox_of = lambda sh: (calls.append(1), real(sh))[1]
    try:
        res = server._interference_job(doc)
    finally:
        builder.bbox_of = real
    assert "error" not in res, res
    n = 8
    assert len(calls) == n, f"{len(calls)} bbox walks for {n} bodies"
    # The naive version would have done one per pair, per side.
    assert len(calls) < n * (n - 1), "still quadratic"
    print(f"{PASS} interference: {len(calls)} bbox walks for {n} bodies "
          f"(pairwise would be {n * (n - 1)})")


def test_the_sweep_still_finds_real_clashes():
    """Precomputing must not change the answer."""
    doc = {"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": 20, "width": 20, "height": 20},
        {"id": "b2", "type": "box", "length": 20, "width": 20, "height": 20},
        {"id": "mv", "type": "move", "dx": 10}]}
    res = server._interference_job(doc)
    assert "error" not in res, res
    assert len(res["pairs"]) == 1, res["pairs"]
    assert abs(res["pairs"][0]["volume"] - 4000) < 1, res["pairs"][0]
    print(f"{PASS} sweep still reports the clash (vol {res['pairs'][0]['volume']:.0f})")


# --- 3.6 filenames and the silent clobber ------------------------------------


def test_windows_reserved_names_are_defused():
    """CON.step is as invalid as CON on Windows, and "Con" is a plausible body
    name in mechanical CAD. The failure is an opaque OS error at write time, on
    one platform only."""
    for bad in ("CON", "con", "Aux", "NUL", "com1", "LPT9"):
        got = server._safe_part_filename(bad, "body1")
        assert got.split(".")[0].lower() not in server._WINDOWS_RESERVED, f"{bad} -> {got}"
    assert server._safe_part_filename("Console", "b") == "Console", "over-eager"
    print(f"{PASS} reserved device names are defused, 'Console' is left alone")


def test_names_are_budgeted_in_BYTES_and_stay_valid_utf8():
    """`\\w` is Unicode-aware, so a CJK name survives sanitising and then blows a
    255-BYTE filesystem limit at a third of the character count."""
    long_cjk = "部品" * 200            # 400 chars, 1200 bytes
    got = server._safe_part_filename(long_cjk, "body1")
    assert len(got.encode("utf-8")) <= server._MAX_NAME_BYTES, len(got.encode("utf-8"))
    got.encode("utf-8").decode("utf-8")  # must not have split a codepoint
    assert got, "trimmed to nothing"
    print(f"{PASS} a 1200-byte name trims to {len(got.encode('utf-8'))} bytes, still UTF-8")


def test_awkward_names_always_yield_something_usable():
    for label in ("", "...", "///", "___", None, 42):
        got = server._safe_part_filename(label, "body7")
        assert got and got not in (".", ".."), f"{label!r} -> {got!r}"
    print(f"{PASS} every awkward label still yields a usable filename")


def test_separate_export_writes_a_directory_and_refuses_to_clobber():
    """The save dialog confirms overwriting `parts.step`, which is never
    written — N siblings are. So the only file the user was asked about was the
    one file that could not be clobbered."""
    server._EXPORT_MESH_CACHE.clear()
    doc = _box_doc(3)
    d = tempfile.mkdtemp(prefix="sindri-sep-")
    try:
        target = os.path.join(d, "parts.step")
        res = server._export_job(doc, "step", target, separate=True)
        assert "error" not in res, res
        outdir = os.path.join(d, "parts")
        assert os.path.isdir(outdir), f"no directory at {outdir}"
        assert len(res["paths"]) == 3, res["paths"]
        for p in res["paths"]:
            assert os.path.dirname(p) == outdir, p
            assert os.path.getsize(p) > 0, p

        # A second export to the same name must REFUSE rather than overwrite.
        again = server._export_job(doc, "step", target, separate=True)
        assert "error" in again, "silently clobbered an existing export"
        assert "already exists" in again["error"]["message"], again
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print(f"{PASS} separate export writes a folder, and refuses to overwrite one")


if __name__ == "__main__":
    print("export gates")
    test_the_export_cache_keys_on_tolerance()
    test_the_triangle_budget_is_checked_per_body_not_after_everything()
    test_export_project_has_a_budget_at_all()
    test_the_interference_sweep_computes_each_bbox_once()
    test_the_sweep_still_finds_real_clashes()
    test_windows_reserved_names_are_defused()
    test_names_are_budgeted_in_BYTES_and_stay_valid_utf8()
    test_awkward_names_always_yield_something_usable()
    test_separate_export_writes_a_directory_and_refuses_to_clobber()
    print("all export-gate tests passed")
