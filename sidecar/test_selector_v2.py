"""Selector v2 resolver tests (sidecar/geom_select.py).

Run: uv run python test_selector_v2.py

Builds known build123d solids and checks that the fingerprint `match` form picks ONE
specific entity where the legacy `axis`/`normal` forms would grab the whole parallel
set, that concentric circles are disambiguated by radius/center, that the multi-edge
de-dup keeps concentric edges, and that a poor match still resolves best-effort while
recording a diagnostic.
"""

from build123d import Box, Cylinder

from geom_select import (
    resolve_edges,
    resolve_faces,
    _edge_curve,
    _edge_mid,
    _edge_dir,
    _edge_radius,
    _edge_center,
    _face_centroid,
    _face_normal,
)

PASS = "  ok"


def _approx(a, b, tol=1e-3):
    return abs(a - b) <= tol


def edge_fp(e):
    """Build an EdgeFingerprint dict from a real edge (same helpers the resolver uses)."""
    m, d = _edge_mid(e), _edge_dir(e)
    fp = {"mid": [m.X, m.Y, m.Z], "dir": [d.X, d.Y, d.Z], "length": e.length, "curve": _edge_curve(e)}
    if _edge_curve(e) == "circle":
        r, c = _edge_radius(e), _edge_center(e)
        if r is not None:
            fp["radius"] = r
        if c is not None:
            fp["center"] = [c.X, c.Y, c.Z]
    return fp


def face_fp(f):
    c, n = _face_centroid(f), _face_normal(f)
    return {"centroid": [c.X, c.Y, c.Z], "normal": [n.X, n.Y, n.Z], "area": f.area}


def top_face(part):
    return max(part.faces(), key=lambda f: _face_centroid(f).Z)


def test_match_picks_one_edge_where_axis_grabs_all():
    box = Box(20, 20, 10)
    # the 4 edges parallel to X: legacy axis selector returns ALL of them.
    x_edges = resolve_edges(box, {"kind": "edge", "by": "axis", "axis": "X"})
    assert len(x_edges) == 4, f"axis X should grab all 4 X-edges, got {len(x_edges)}"

    # pick the top-front X edge (y=+10, z=+5) and match it specifically.
    target = next(
        e for e in box.edges()
        if _edge_curve(e) == "line"
        and abs(_edge_dir(e).X) > 0.99
        and _approx(_edge_mid(e).Y, 10) and _approx(_edge_mid(e).Z, 5)
    )
    got = resolve_edges(box, {"kind": "edge", "by": "match", "fp": edge_fp(target)})
    assert len(got) == 1, f"match should pick exactly 1 edge, got {len(got)}"
    m = _edge_mid(got[0])
    assert _approx(m.Y, 10) and _approx(m.Z, 5), f"match picked the wrong X edge: mid={m}"
    print(PASS, "match picks ONE edge (axis would grab 4)")


def test_offace_returns_face_edges():
    box = Box(20, 20, 10)
    tf = top_face(box)
    got = resolve_edges(box, {"kind": "edge", "by": "ofFace", "face": face_fp(tf)})
    assert len(got) == 4, f"ofFace(top) should be 4 edges, got {len(got)}"
    assert all(_approx(_edge_mid(e).Z, 5) for e in got), "ofFace edges must lie on the top face"
    print(PASS, "ofFace returns the 4 edges of the top face")


def test_concentric_disambiguated_and_dedup():
    tube = Cylinder(10, 10) - Cylinder(5, 10)  # a pipe: concentric top circles r=10 and r=5
    top_circles = [
        e for e in tube.edges() if _edge_curve(e) == "circle" and _approx(_edge_mid(e).Z, 5, 0.05)
    ]
    assert len(top_circles) == 2, f"expected 2 concentric top circles, got {len(top_circles)}"
    outer = max(top_circles, key=lambda e: _edge_radius(e))
    inner = min(top_circles, key=lambda e: _edge_radius(e))

    # match must pick the RIGHT circle by radius/center (same midpoint family, same center).
    got_outer = resolve_edges(tube, {"kind": "edge", "by": "match", "fp": edge_fp(outer)})
    got_inner = resolve_edges(tube, {"kind": "edge", "by": "match", "fp": edge_fp(inner)})
    assert _approx(_edge_radius(got_outer[0]), 10, 0.05), "match should pick the r=10 circle"
    assert _approx(_edge_radius(got_inner[0]), 5, 0.05), "match should pick the r=5 circle"

    # a LIST of both selectors must keep BOTH (the old center-only de-dup dropped one).
    both = resolve_edges(
        tube,
        [
            {"kind": "edge", "by": "match", "fp": edge_fp(outer)},
            {"kind": "edge", "by": "match", "fp": edge_fp(inner)},
        ],
    )
    radii = sorted(round(_edge_radius(e), 1) for e in both)
    assert radii == [5.0, 10.0], f"concentric de-dup dropped an edge: radii={radii}"
    print(PASS, "concentric circles disambiguated by radius + kept through de-dup")


def test_face_match_picks_top():
    box = Box(20, 20, 10)
    tf = top_face(box)
    got = resolve_faces(box, {"kind": "face", "by": "match", "fp": face_fp(tf)})
    assert len(got) == 1 and _approx(_face_centroid(got[0]).Z, 5), "face match should pick the top face"
    # legacy normal selector would return ALL +Z faces (here only 1, but via the all-path).
    print(PASS, "face match picks the top face")


def test_tangentchain_on_box_is_single_edge():
    box = Box(20, 20, 10)
    seed = next(e for e in box.edges() if _edge_curve(e) == "line")
    got = resolve_edges(box, {"kind": "edge", "by": "tangentChain", "seed": edge_fp(seed)})
    # box edges meet at 90°, so the tangent chain is just the seed.
    assert len(got) == 1, f"box tangentChain should be 1 edge (no tangent neighbors), got {len(got)}"
    print(PASS, "tangentChain on a box edge = the seed alone")


def test_bad_match_is_best_effort_with_diagnostic():
    box = Box(20, 20, 10)
    diag = []
    # a fingerprint far from any real edge: best-effort returns the closest, flags lossy.
    bad = {"mid": [100, 100, 100], "dir": [1, 0, 0], "length": 999, "curve": "line"}
    got = resolve_edges(box, {"kind": "edge", "by": "match", "fp": bad}, diag=diag, feature_id="f9")
    assert len(got) == 1, "best-effort match still returns a candidate"
    assert diag and diag[0]["lossy"] and diag[0]["feature_id"] == "f9", f"expected a lossy diag, got {diag}"
    print(PASS, "poor match resolves best-effort and records a diagnostic")


def main():
    print("Selector v2 resolver tests")
    test_match_picks_one_edge_where_axis_grabs_all()
    test_offace_returns_face_edges()
    test_concentric_disambiguated_and_dedup()
    test_face_match_picks_top()
    test_tangentchain_on_box_is_single_edge()
    test_bad_match_is_best_effort_with_diagnostic()
    print("ALL PASS")


if __name__ == "__main__":
    main()
