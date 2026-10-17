"""Mirror across a construction plane (sidecar) — GH #64.

A body Mirror names its plane as XY / XZ / YZ or, since #64, by the id of a
datumPlane feature. The mirror resolves that id where it runs in the timeline,
so it follows the plane when the plane (or the face it sits on) moves, and a
plane that does not exist there yet is refused in words, not with the internal
"unknown plane reference: dp".

Run: uv run python test_mirror_plane.py
"""

import copy
import os
import sys

os.environ.setdefault("SINDRI_DISK_CACHE", "0")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import builder  # noqa: E402

PASS = "  ok"
XY = {"origin": [0, 0, 0], "normal": [0, 0, 1], "xdir": [1, 0, 0]}
# the plane the pick bakes for the top face of the CENTRED 20x20x10 box
TOP_PLANE = {"origin": [0, 0, 5], "normal": [0, 0, 1], "xdir": [1, 0, 0]}


def _build(features):
    diag, planes = [], {}
    part, errors, bodies = builder.rebuild({"parameters": {}, "features": copy.deepcopy(features)},
                                           diagnostics=diag, planes=planes)
    return part, errors, bodies, planes


def _box(height=10):
    return {"id": "b1", "type": "box", "length": 20, "width": 20, "height": height}


def _z_range(part):
    bb = part.bounding_box()
    return round(bb.min.Z, 6), round(bb.max.Z, 6)


def test_mirror_across_an_offset_datum_plane():
    """Box z in [-5, 5], datum 15 above XY: the reflection lands in [25, 35],
    apart from the box, so the body is two solids and twice the volume."""
    part, errors, bodies, _ = _build([
        _box(),
        {"id": "dp", "type": "datumPlane", "plane": copy.deepcopy(XY), "offset": 15},
        {"id": "m1", "type": "mirror", "plane": "dp"},
    ])
    assert errors == [], errors
    assert len(bodies) == 1, [b.get("id") for b in bodies]
    assert len(part.solids()) == 2, len(part.solids())
    assert abs(part.volume - 8000.0) < 1e-6, part.volume
    assert _z_range(part) == (-5.0, 35.0), _z_range(part)
    print(PASS, "mirror across a datum 15 above XY: 2 solids, z [-5, 35], volume doubled")


def test_mirror_follows_a_face_anchored_datum():
    """The datum sits 3 above the box's top face. Raising the box from 10 to 20
    moves the face, the datum with it, and the reflection with the datum."""
    def feats(height):
        return [
            _box(height),
            {"id": "dp", "type": "datumPlane", "plane": copy.deepcopy(TOP_PLANE), "offset": 3,
             "face": {"kind": "face", "by": "nearest", "point": [9.5, 0, 5], "body": "body1"}},
            {"id": "m1", "type": "mirror", "plane": "dp"},
        ]

    part, errors, _b, planes = _build(feats(10))
    assert errors == [], errors
    assert planes["dp"]["origin"][2] == 8.0, planes["dp"]
    assert _z_range(part) == (-5.0, 21.0), _z_range(part)
    assert abs(part.volume - 8000.0) < 1e-6, part.volume

    part, errors, _b, planes = _build(feats(20))
    assert errors == [], errors
    assert planes["dp"]["origin"][2] == 13.0, planes["dp"]
    assert _z_range(part) == (-10.0, 36.0), _z_range(part)
    assert abs(part.volume - 16000.0) < 1e-6, part.volume
    print(PASS, "mirror follows a face-anchored datum when the box grows (z max 21 -> 36)")


def test_a_plane_later_in_the_timeline_is_refused_in_words():
    """A datum made AFTER the mirror does not exist where the mirror runs. The
    mirror goes red with a coded sentence that names no internal id, and the
    body it would have changed is left as it was."""
    part, errors, bodies, _ = _build([
        _box(),
        {"id": "m1", "type": "mirror", "plane": "dp"},
        {"id": "dp", "type": "datumPlane", "plane": copy.deepcopy(XY), "offset": 15},
    ])
    assert [e.get("code") for e in errors] == ["mirrorNoPlane"], errors
    msg = errors[0]["message"]
    assert msg.startswith("Mirror: the plane"), msg
    assert "dp" not in msg and "unknown plane reference" not in msg, msg
    assert errors[0].get("feature_id") == "m1", errors[0]
    assert len(bodies) == 1 and abs(part.volume - 4000.0) < 1e-6, part.volume
    print(PASS, "a datum after the mirror: coded mirrorNoPlane, in words, body untouched")


def test_a_base_plane_mirror_is_unchanged():
    """Every mirror saved before #64 names XY / XZ / YZ. A box moved off YZ and
    mirrored across it is two boxes, as it always was."""
    part, errors, _b, _ = _build([
        _box(),
        {"id": "mv", "type": "move", "bodies": ["body1"], "dx": 20, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0},
        {"id": "m1", "type": "mirror", "plane": "YZ"},
    ])
    assert errors == [], errors
    bb = part.bounding_box()
    assert (round(bb.min.X, 6), round(bb.max.X, 6)) == (-30.0, 30.0), (bb.min.X, bb.max.X)
    assert len(part.solids()) == 2 and abs(part.volume - 8000.0) < 1e-6, part.volume
    print(PASS, "a mirror across YZ builds as before")


def main():
    print("Mirror across a construction plane (GH #64)")
    test_mirror_across_an_offset_datum_plane()
    test_mirror_follows_a_face_anchored_datum()
    test_a_plane_later_in_the_timeline_is_refused_in_words()
    test_a_base_plane_mirror_is_unchanged()
    print("ALL PASS")


if __name__ == "__main__":
    main()
