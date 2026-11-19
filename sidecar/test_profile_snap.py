"""A cut traced off a body's own wall meets that wall exactly.

Field report 995a4717: a sketch on a pocket floor traced the pocket's walls as
projected arcs, which the document stores to 6 decimals (`_r6`). Rebuilt from
those points, the arcs missed the real walls by 4.4e-7 to 1.0e-6 mm, more than
OCCT's 1e-7, so a symmetric cut that ran along the walls kept two copies of
each wall edge with a zero-area face between them. The body went invalid, the
Threads after it were refused, and the 3MF export had 142 unmatched edges.

`_snap_profile_to_bodies` rebuilds such edges on the body's own curves. Pinned
here by the body a rebuild returns: the micron-off trace must give the SAME
body as an exact one, face for face, and no sliver faces.

Run:  uv run python test_profile_snap.py
"""

import math

from builder import rebuild

PASS = "✓"


def _doc(trace):
    """A 40 x 40 x 10 block with a r10 pocket 1.6 deep, and a sketch on the
    pocket floor holding `trace`, cut symmetrically 3 mm each way, so its upper
    half runs along the pocket wall."""
    return {"parameters": {}, "features": [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": 40, "height": 40}]},
        {"id": "x1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new"},
        {"id": "s2", "type": "sketch",
         "plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         "entities": [{"type": "circle", "radius": 10, "x": 0, "y": 0}]},
        {"id": "x2", "type": "extrude", "sketch": "s2", "distance": -1.6, "operation": "cut"},
        {"id": "s3", "type": "sketch",
         "plane": {"origin": [0, 0, 8.4], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         "entities": trace},
        {"id": "x3", "type": "extrude", "sketch": "s3", "distance": 6, "symmetric": True,
         "operation": "cut"},
    ]}


def _traced_arcs(radius, dx):
    """The pocket wall as four arcs through points rounded to 6 decimals, the
    way a projected curve comes back out of the document."""
    def at(deg):
        a = math.radians(deg)
        return round(dx + radius * math.cos(a), 6), round(radius * math.sin(a), 6)
    ents = []
    for i in range(4):
        p, m, q = at(90 * i), at(90 * i + 45), at(90 * i + 90)
        ents.append({"id": f"a{i}", "type": "arc", "x1": p[0], "y1": p[1],
                     "mx": m[0], "my": m[1], "x2": q[0], "y2": q[1]})
    return ents


def _body(trace):
    _, err, bodies = rebuild(_doc(trace))
    assert not err, err
    assert len(bodies) == 1, bodies
    return bodies[0]["shape"]


def test_a_trace_a_micron_off_the_wall_cuts_the_same_body_as_an_exact_one():
    """RED before the fix: 13 faces against 9, a different volume, and a
    0.0005 mm2-class sliver along the wall."""
    exact = _body([{"type": "circle", "radius": 10, "x": 0, "y": 0}])
    for radius, dx in ((10 - 6e-7, 3e-7), (10 + 7e-7, 0.0), (10 + 1e-6, 0.0)):
        got = _body(_traced_arcs(radius, dx))
        assert got.is_valid
        small = [round(f.area, 9) for f in got.faces() if f.area < 1e-3]
        assert not small, f"trace r={radius} dx={dx} left sliver faces {small}"
        assert len(got.faces()) == len(exact.faces()), (
            f"trace r={radius} dx={dx}: {len(got.faces())} faces, the exact trace "
            f"has {len(exact.faces())}")
        assert abs(got.volume - exact.volume) < 1e-6, (
            f"trace r={radius} dx={dx}: volume {got.volume:.9f}, exact "
            f"{exact.volume:.9f}")
    print(f"{PASS} a cut traced up to 1e-6 mm off the wall gives the exact body: "
          f"{len(exact.faces())} faces, vol {exact.volume:.6f}")


def test_a_trace_deliberately_off_the_wall_is_left_alone():
    """0.01 mm is a gap someone modelled, 1000 times the snap distance."""
    exact = _body([{"type": "circle", "radius": 10, "x": 0, "y": 0}])
    wider = _body(_traced_arcs(10.01, 0.0))
    assert wider.volume < exact.volume - 0.5, (
        f"a 0.01 mm wider cut must remove more: {wider.volume:.6f} vs {exact.volume:.6f}")
    print(f"{PASS} a cut 0.01 mm off the wall stays where it was drawn")


if __name__ == "__main__":
    test_a_trace_a_micron_off_the_wall_cuts_the_same_body_as_an_exact_one()
    test_a_trace_deliberately_off_the_wall_is_left_alone()
    print("\nall profile snap tests passed")
