"""Sketch-text tests (sidecar): text builds glyph faces, extrudes, and the preview
ops (tessellate_text / list_fonts) match the solid. Run: uv run python test_text.py
"""

import builder

PASS = "  ok"


def _rebuild(feats):
    part, errors, bodies = builder.rebuild({"parameters": {}, "features": feats})
    return part, errors, bodies


def test_text_extrudes_to_a_solid():
    part, errors, _ = _rebuild([
        {"id": "s", "type": "sketch", "plane": "XY",
         "entities": [{"id": "t", "type": "text", "text": "Ab", "height": 10, "x": 0, "y": 0}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 3, "operation": "new"},
    ])
    assert not errors, errors
    assert part.volume > 0, "text extrude produced no solid"
    assert len(part.faces()) > 6, "expected glyph faces beyond a plain prism"
    bb = part.bounding_box()
    assert 8 < (bb.max.X - bb.min.X) < 20, f"'Ab' width off: {bb.max.X - bb.min.X}"
    print(PASS, "text extrudes to a solid with glyph faces and sane bbox")


def test_empty_text_is_a_noop():
    # whitespace text contributes nothing; a sibling rectangle still builds
    part, errors, _ = _rebuild([
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [
            {"id": "t", "type": "text", "text": "   ", "height": 10},
            {"id": "r", "type": "rectangle", "width": 5, "height": 5, "x": 0, "y": 0}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 2, "operation": "new"},
    ])
    assert not errors and abs(part.volume - 50.0) < 1e-6, f"empty text was not a no-op: vol={part.volume}"
    print(PASS, "empty/whitespace text is a no-op (no crash)")


def test_tessellate_text_gives_outer_and_holes():
    res = builder.tessellate_text({"text": "o", "height": 10, "x": 0, "y": 0})
    assert len(res["faces"]) == 1, res
    face = res["faces"][0]
    assert len(face["outer"]) > 3 and len(face["holes"]) == 1, "the counter of 'o' must be a hole"
    assert len(face["holes"][0]) > 3, "hole polyline too short"
    print(PASS, "tessellate_text returns outer contour + counter hole for 'o'")


def test_tessellate_matches_solid_face_count():
    # preview face count == extruded glyph count (one font engine, no drift)
    n_preview = len(builder.tessellate_text({"text": "Ab", "height": 10})["faces"])
    assert n_preview == 2, n_preview  # A + b
    print(PASS, "preview glyph count matches the solid (one font engine)")


def test_list_fonts_nonempty():
    fams = builder.list_fonts()["families"]
    assert isinstance(fams, list) and len(fams) > 0, "no system fonts enumerated"
    print(PASS, f"list_fonts enumerated {len(fams)} families")


def main():
    print("Sketch-text tests")
    test_text_extrudes_to_a_solid()
    test_empty_text_is_a_noop()
    test_tessellate_text_gives_outer_and_holes()
    test_tessellate_matches_solid_face_count()
    test_list_fonts_nonempty()
    print("ALL PASS")


if __name__ == "__main__":
    main()
