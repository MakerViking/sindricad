"""Body-silhouette projection (step 7) — _project_silhouette's HLR outline
(V + OutLineV union, exact lines/circles, seam-on-generator immunity, sewn-edge
strays excluded), the projectGeometry silhouette source, extrudability of the
projected outline, and the group-level refresh correspondence (cached match →
nearest-curve → positional → stale).

Run:  uv run python test_silhouette.py   (or .venv/bin/python test_silhouette.py)
"""

import copy
import math

from build123d import Cylinder, Rot, Sphere

from builder import (
    _curve_close,
    _plane_of,
    _project_silhouette,
    project_geometry,
    rebuild,
)

PASS = "  ok"

# side view of a cylinder standing on XY: frame x = world x, frame y = world z
SIDE = {"origin": [0, -15, 0], "normal": [0, -1, 0], "xdir": [1, 0, 0]}
WRONG = {"kind": "line", "x1": -99.0, "y1": -99.0, "x2": -98.0, "y2": -99.0}


def _cyl_features(r=10):
    return [
        {"id": "f1", "type": "sketch", "plane": "XY",
         "entities": [{"id": "c1", "type": "circle", "radius": r, "x": 0, "y": 0}]},
        {"id": "f2", "type": "extrude", "sketch": "f1", "distance": 30, "operation": "new"},
    ]


def _classify(curves):
    lines = [c for c in curves if c["kind"] == "line"]
    others = [c for c in curves if c["kind"] != "line"]
    return lines, others


def _line_span(c):
    return tuple(sorted([(c["x1"], c["y1"]), (c["x2"], c["y2"])]))


def test_cylinder_side_outline():
    """cylinder(r=10, h=30) onto the side plane → the closed 20x30 rectangle
    outline: 2 EXACT lines at x=±10 spanning y 0..30 + 2 edge-on rim curves
    joining (±10, 0) and (±10, 30). The default seam sits at +X, ON the +x
    silhouette generator (the seam pitfall) — both lines must still appear."""
    r = project_geometry({"parameters": {}, "features": _cyl_features()}, SIDE,
                         [{"kind": "silhouette", "body": "body1"}])["results"][0]
    assert r["ok"], r
    curves = [e["curve"] for e in r["curves"]]
    assert all("fp" not in e for e in r["curves"]), "whole-body source carries no fps"
    lines, rims = _classify(curves)
    assert len(lines) == 2, f"expected the 2 exact silhouette lines, got {curves}"
    spans = {_line_span(c) for c in lines}
    assert spans == {((-10.0, 0.0), (-10.0, 30.0)), ((10.0, 0.0), (10.0, 30.0))}, spans
    assert len(rims) == 2, f"expected 2 edge-on rim curves, got {rims}"
    for c in rims:
        assert c["kind"] == "poly", c
        ys = {p[1] for p in c["pts"]}
        assert ys in ({0.0}, {30.0}), f"rim must lie flat at y=0 or y=30: {ys}"
        xs = [p[0] for p in c["pts"]]
        assert abs(min(xs) + 10) < 1e-6 and abs(max(xs) - 10) < 1e-6, (min(xs), max(xs))
    print(PASS, "cylinder side outline: 2 exact lines at x=±10 + 2 flat rim polys")
    return curves


def test_seam_off_generator_same_outline(reference):
    """Rotating the cylinder 30° about Z moves the seam OFF the silhouette
    generator (it becomes a plain sewn edge): the outline shape is unchanged —
    still exactly 2 lines at x=±10 + 2 rim curves. Proves the V+OutLineV union
    is immune to which bucket the seam-coincident generator lands in."""
    curves = _project_silhouette(Rot(0, 0, 30) * Cylinder(10, 30), _plane_of(SIDE))
    assert len(curves) == 4, curves
    lines, rims = _classify(curves)
    assert len(lines) == 2 and len(rims) == 2, curves
    xs = {(_line_span(c)[0][0], _line_span(c)[1][0]) for c in lines}
    assert xs == {(-10.0, -10.0), (10.0, 10.0)}, xs
    print(PASS, "seam off the generator: same 2-lines + 2-rims outline")
    _ = reference


def test_projected_outline_extrudes():
    """Persist the 4 silhouette curves as projected entities in a side-plane
    sketch and extrude: the 20x30 outline region builds a 3000 mm³ slab next to
    the cylinder (regions/extrude machinery consumes silhouette curves like any
    ProjectedCurve)."""
    r = project_geometry({"parameters": {}, "features": _cyl_features()}, SIDE,
                         [{"kind": "silhouette", "body": "body1"}])["results"][0]
    ents = [
        {"id": f"p{i}", "type": "projected",
         "source": {"kind": "silhouette", "body": "body1", "group": "p0"},
         "curve": e["curve"]}
        for i, e in enumerate(r["curves"])
    ]
    doc = {"parameters": {}, "features": _cyl_features() + [
        {"id": "f3", "type": "sketch", "plane": SIDE, "entities": ents},
        {"id": "f4", "type": "extrude", "sketch": "f3", "distance": 5, "operation": "new"},
    ]}
    part, err, bodies = rebuild(doc)
    assert not err, err
    assert len(bodies) == 2, f"cylinder + extruded outline slab: {len(bodies)} bodies"
    want = math.pi * 100 * 30 + 20 * 30 * 5
    assert abs(part.volume - want) < 5, f"want ~{want:.0f}, got {part.volume:.1f}"
    print(PASS, f"projected outline extrudes: 2 bodies, vol {part.volume:.0f}")


def test_sphere_exact_circle():
    """Sphere r=8 onto XY → EXACTLY one curve, the exact circle r=8. Also the
    sewn-edge guard: the sphere's seam meridian (a visible RgNLine) must NOT
    leak in as a stray radial curve."""
    curves = _project_silhouette(Sphere(8), _plane_of("XY"))
    assert curves == [{"kind": "circle", "x": 0.0, "y": 0.0, "r": 8.0}], curves
    print(PASS, "sphere silhouette: the exact circle r=8, no seam stray")


def _sil_doc(features, cached_by_id, ids=("p0", "p1", "p2", "p3")):
    ents = [
        {"id": pid, "type": "projected",
         "source": {"kind": "silhouette", "body": "body1", "group": "p0"},
         "curve": cached_by_id[pid]}
        for pid in ids
    ]
    return {"parameters": {}, "features": features + [
        {"id": "f3", "type": "sketch", "plane": SIDE, "entities": ents},
    ]}


def test_refresh_corrects_wrong_cache():
    """Garbage cached curves → 4 corrective updates carrying the true outline
    (kind-mismatched garbage falls through nearest-match to positional
    assignment); the corrected doc is then quiet (convergence contract)."""
    garbage = {k: dict(WRONG) for k in ("p0", "p1", "p2", "p3")}
    p = []
    _part, err, _bodies = rebuild(_sil_doc(_cyl_features(), garbage), projections=p)
    assert not err, err
    assert len(p) == 4 and all(u["stale"] is False for u in p), p
    seeded = {u["entity"]: u["curve"] for u in p}
    kinds = sorted(c["kind"] for c in seeded.values())
    assert kinds == ["line", "line", "poly", "poly"], kinds
    p2 = []
    rebuild(_sil_doc(_cyl_features(), seeded), projections=p2)
    assert p2 == [], f"steady state must emit NOTHING, got {p2}"
    print(PASS, "wrong caches corrected in one pass, then quiet")
    return seeded


def test_resize_tracks_nearest(seeded):
    """r 10→15: every curve moved beyond tolerance; the silhouette LINES must
    track their own side via nearest-match (x=+10 → x=+15, never the -15 line),
    and the rim polys stay on their own y level."""
    p = []
    _part, err, _bodies = rebuild(_sil_doc(_cyl_features(r=15), seeded), projections=p)
    assert not err, err
    assert len(p) == 4 and all(u["stale"] is False for u in p), p
    for u in p:
        old, new = seeded[u["entity"]], u["curve"]
        assert new["kind"] == old["kind"], (old, new)
        if new["kind"] == "line":
            old_x, new_x = old["x1"], new["x1"]
            assert abs(abs(new_x) - 15) < 1e-6, new
            assert (old_x > 0) == (new_x > 0), \
                f"line jumped sides: {old_x} -> {new_x} (nearest-match broke)"
        else:
            old_y, new_y = old["pts"][0][1], new["pts"][0][1]
            assert abs(old_y - new_y) < 1e-6, f"rim changed level: {old_y} -> {new_y}"
    print(PASS, "resized r=15: lines track their side, rims their level")


def test_shrunk_body_extra_siblings_stale(seeded):
    """The body shrinks to a SPHERE (revolve) → 2 fresh curves (the revolve seam
    lies on the silhouette, splitting its circle into two exact half-circle
    arcs) for 4 siblings: kind mismatch skips the cached/nearest passes,
    positional assignment gives the shortlex-first two siblings the arcs, the
    remaining 2 go stale."""
    sphere_features = [
        {"id": "f1", "type": "sketch", "plane": "XZ", "entities": [
            {"id": "a1", "type": "arc", "x1": 0, "y1": -8, "x2": 0, "y2": 8,
             "mx": 8, "my": 0},
            {"id": "l1", "type": "line", "x1": 0, "y1": 8, "x2": 0, "y2": -8}]},
        {"id": "f2", "type": "revolve", "sketch": "f1", "axis": "Z", "angle": 360,
         "operation": "new"},
    ]
    p = []
    _part, err, _bodies = rebuild(_sil_doc(sphere_features, seeded), projections=p)
    assert not err, err
    assert len(p) == 4, p
    by_id = {u["entity"]: u for u in p}
    for pid, mx in (("p0", 8.0), ("p1", -8.0)):
        u = by_id[pid]
        assert u["stale"] is False and u["curve"]["kind"] == "arc", u
        assert (u["curve"]["mx"], u["curve"]["my"]) == (mx, 0.0), u
    for pid in ("p2", "p3"):
        assert by_id[pid] == {"sketch": "f3", "entity": pid, "stale": True}, by_id[pid]
    print(PASS, "shrunk to a sphere: 2 arcs to the first siblings, 2 go stale")


def test_missing_body_all_stale(seeded):
    """No body at all (extrude removed) → every sibling goes stale, once."""
    feats = [f for f in _cyl_features() if f["id"] != "f2"]
    doc = _sil_doc(feats, seeded)
    p = []
    rebuild(doc, projections=p)
    assert sorted(u["entity"] for u in p) == ["p0", "p1", "p2", "p3"], p
    assert all(u["stale"] is True and "curve" not in u for u in p), p
    doc2 = copy.deepcopy(doc)
    for e in doc2["features"][1]["entities"]:
        e["stale"] = True
    p2 = []
    rebuild(doc2, projections=p2)
    assert p2 == [], f"already-stale must not re-emit, got {p2}"
    print(PASS, "missing body: all siblings stale on the transition, then quiet")


def main():
    print("test_silhouette:")
    reference = test_cylinder_side_outline()
    test_seam_off_generator_same_outline(reference)
    test_projected_outline_extrudes()
    test_sphere_exact_circle()
    seeded = test_refresh_corrects_wrong_cache()
    test_resize_tracks_nearest(seeded)
    test_shrunk_body_extra_siblings_stale(seeded)
    test_missing_body_all_stale(seeded)
    print("ALL PASS")


if __name__ == "__main__":
    main()
