"""An export closes a hole the kernel left a few hundredths of a micron wide.

Field report 995a4717: where two surfaces met tangentially, OCCT left an edge
4.3e-5 mm long. One face's triangulation used it and its neighbour's did not,
so the mesh had a hole that size: 3 one-sided edges, which the 3MF (written to
6 significant digits) carried as four copies of one point. PrusaSlicer counts
those. `collapse_micro_edges` merges the ends of any mesh edge shorter than
1e-4 mm, and only those: two vertices that are merely close stay apart.

The mesh below is that defect on a tetrahedron: its bottom face is split at a
point 4e-5 mm along one edge that the neighbouring face does not have.

Run:  uv run python test_micro_edge_export.py
"""

import zipfile
import re
from collections import Counter

import numpy as np

import server
from tessellate import collapse_micro_edges, open_edge_count, weld_vertices

PASS = "✓"


def _tetra_with_a_micro_split(at=(0.0, 0.0, 0.0), split=4e-5):
    p, y, x, w = (np.array(v, dtype=float) + at for v in
                  ((0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)))
    q = p + np.array([split, 0, 0])  # on edge p-y, which only the bottom has
    P = np.array([p, y, x, w, q])
    T = np.array([[0, 2, 4], [4, 2, 1],   # bottom, split at q
                  [0, 1, 3],              # front: still spans p-y in one edge
                  [0, 3, 2],
                  [1, 2, 3]])
    return P.reshape(-1), T.reshape(-1)


def test_a_micro_split_is_closed():
    P, T = _tetra_with_a_micro_split()
    P, T, _ = weld_vertices(P, T)
    assert open_edge_count(T) == 3, "the fixture must have the report's 3 one-sided edges"
    P2, T2, _ = collapse_micro_edges(P, T)
    assert open_edge_count(T2) == 0, f"{open_edge_count(T2)} one-sided edges left"
    assert len(T2) // 3 == 4, "the collapsed sliver must go, the four real faces stay"
    assert np.allclose(P2.reshape(-1, 3)[:4], P.reshape(-1, 3)[:4]), "real corners moved"
    print(f"{PASS} a 4e-5 mm split closes: 3 one-sided edges -> 0, 4 triangles")


def test_a_short_edge_that_is_meant_is_kept():
    P, T = _tetra_with_a_micro_split(split=0.01)  # a real 10 micron feature
    P, T, _ = weld_vertices(P, T)
    P2, T2, _ = collapse_micro_edges(P, T)
    assert len(T2) == len(T) and open_edge_count(T2) == 3
    print(f"{PASS} a 0.01 mm edge is left alone")


def test_two_shells_that_only_touch_are_not_merged():
    """Vertices that are merely close are never merged, only ends of an edge."""
    P1, T1 = _tetra_with_a_micro_split(split=0.5)
    P2, T2 = _tetra_with_a_micro_split(at=(-1, 0, 0), split=0.5)  # touches at (0,0,0)
    P = np.concatenate([P1, P2])
    T = np.concatenate([T1, T2 + len(P1) // 3])
    Pc, Tc, _ = collapse_micro_edges(P, T)
    assert np.array_equal(Tc, T), "two touching shells were merged"
    print(f"{PASS} two shells touching at a point stay two shells")


def _box_doc():
    return {"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 10, "height": 10}]},
        {"id": "x1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new"}]}


def _one_sided(path):
    x = zipfile.ZipFile(path).read("3D/3dmodel.model").decode()
    ts = [tuple(map(int, m)) for m in re.findall(r'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"', x)]
    u = Counter(frozenset((a, b)) for t in ts for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])))
    return sum(1 for n in u.values() if n == 1)


def test_both_3mf_exports_close_it(tmp="/tmp"):
    """Through the export jobs, with the body's mesh swapped for the fixture."""
    real = server._export_mesh
    P, T = _tetra_with_a_micro_split()
    server._export_mesh = lambda b, tol=None: (P.copy(), T.copy(), np.zeros(len(T) // 3, dtype=int))
    try:
        plain = f"{tmp}/micro_plain.3mf"
        res = server._export_job(_box_doc(), "3mf", plain, None, False, [], {})
        assert "path" in res, res
        assert not any("unmatched" in w["message"] for w in res.get("warnings", [])), res
        assert _one_sided(plain) == 0
        proj = f"{tmp}/micro_project.3mf"
        res = server._export_project_job(_box_doc(), proj, [], {}, {}, {})
        assert "error" not in res, res
        assert not any("unmatched" in w["message"] for w in res.get("warnings", [])), res
        assert _one_sided(proj) == 0
    finally:
        server._export_mesh = real
    print(f"{PASS} the plain and the project 3MF exports both come out closed")


if __name__ == "__main__":
    test_a_micro_split_is_closed()
    test_a_short_edge_that_is_meant_is_kept()
    test_two_shells_that_only_touch_are_not_merged()
    test_both_3mf_exports_close_it()
    print("\nall micro-edge export tests passed")
