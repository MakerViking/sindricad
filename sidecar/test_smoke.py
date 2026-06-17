"""Backend smoke test — exercises rebuild/tessellate/selectors/export directly
(no WebSocket) so failures point straight at the geometry code.

Run:  uv run python test_smoke.py
"""

import os
import tempfile

from builder import rebuild
from tessellate import tessellate, edge_polylines, bbox
from exporters import export

# The §2 example: a bracket with two holes and a filleted vertical edge.
EXAMPLE = {
    "parameters": {"width": 40, "height": 20, "thickness": 5, "hole_d": 6},
    "features": [
        {
            "id": "f1",
            "type": "sketch",
            "plane": "XY",
            "entities": [
                {"type": "rectangle", "width": "width", "height": "height", "x": 0, "y": 0}
            ],
        },
        {"id": "f2", "type": "extrude", "sketch": "f1", "distance": "thickness", "operation": "new"},
        {
            "id": "f3",
            "type": "sketch",
            "plane": "XY",
            "entities": [{"type": "circle", "radius": 3, "x": -12, "y": 0}],
        },
        {"id": "f4", "type": "extrude", "sketch": "f3", "distance": "thickness", "operation": "cut"},
        {"id": "f5", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 2},
    ],
}


def test_rebuild():
    part, errors = rebuild(EXAMPLE)
    assert not errors, f"unexpected errors: {errors}"
    assert part is not None

    pos, idx, fids = tessellate(part, 0.1)
    assert len(pos) > 0 and len(pos) % 3 == 0, "positions malformed"
    assert len(idx) > 0 and len(idx) % 3 == 0, "indices malformed"
    assert len(fids) == len(idx) // 3, "one faceId per triangle expected"
    assert max(idx) < len(pos) // 3, "index out of range"

    edges = edge_polylines(part)
    assert len(edges) > 0
    bb = bbox(part)
    assert bb["max"][0] > bb["min"][0]
    print(f"  rebuild OK: {len(pos)//3} verts, {len(idx)//3} tris, "
          f"{len(set(fids))} faces, {len(edges)} edges")
    return part


def test_error_naming():
    """An over-large fillet radius must fail and name the offending feature."""
    doc = {
        "parameters": {},
        "features": [
            {"id": "s", "type": "sketch", "plane": "XY",
             "entities": [{"type": "rectangle", "width": 10, "height": 10}]},
            {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"},
            {"id": "bad", "type": "fillet",
             "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 100},
        ],
    }
    part, errors = rebuild(doc)
    assert errors, "expected a fillet failure"
    assert errors[0]["feature_id"] == "bad", f"wrong feature flagged: {errors[0]}"
    print(f"  error-naming OK: flagged feature '{errors[0]['feature_id']}'")


def test_exports():
    part, errors = rebuild(EXAMPLE)
    assert not errors
    d = tempfile.mkdtemp()
    for fmt in ("step", "stl", "3mf"):
        p = os.path.join(d, f"part.{fmt}")
        export(part, fmt, p)
        assert os.path.exists(p) and os.path.getsize(p) > 0, f"{fmt} export empty"
    print(f"  export OK: step/stl/3mf written to {d}")


if __name__ == "__main__":
    print("Fission sidecar smoke test")
    test_rebuild()
    test_error_naming()
    test_exports()
    print("ALL PASS")
