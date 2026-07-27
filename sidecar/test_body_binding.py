"""Body-binding tests (sidecar): fillet / chamfer / shell / draft must edit ONLY
the bodies whose geometry the user selected.

Regression for the silent wrong-body bug: these four handlers used
require_active() = bodies[-1] and carried no body reference, so on a multi-body
model a `by:"nearest"` selector best-effort-matched onto the LAST-created body
and edited it with no error at all. Selectors now carry their own `body`
(_group_sels_by_body in builder.py).

Run: uv run python test_body_binding.py  (or: uv run pytest test_body_binding.py)
"""

from builder import rebuild

PASS = "  ok"

# body1 = a 40x40x10 box at the origin (vol 16000); body2 = a 6x6x10 box 100mm
# away (vol 360). Far apart, so any cross-talk is unambiguous; boxes because
# their edges are straight lines with exactly predictable midpoints.
BASE_FEATURES = [
    {"id": "s1", "type": "sketch", "plane": "XY",
     "entities": [{"type": "rectangle", "width": 40, "height": 40, "x": 0, "y": 0}]},
    {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new"},
    {"id": "s2", "type": "sketch", "plane": "XY",
     "entities": [{"type": "rectangle", "width": 6, "height": 6, "x": 100, "y": 0}]},
    {"id": "e2", "type": "extrude", "sketch": "s2", "distance": 10, "operation": "new"},
]

B1_CORNER = [20.0, 20.0, 5.0]   # body1 vertical corner edge
B2_CORNER = [103.0, 3.0, 5.0]   # body2 vertical corner edge
B1_TOP = [0.0, 0.0, 10.0]       # body1 top face
B2_SIDE = [103.0, 0.0, 5.0]     # body2 +X side wall (draft needs a wall, not a cap)


def build(*extra):
    """Rebuild BASE_FEATURES + `extra`; return ({body id: volume}, errors)."""
    _part, errors, bodies = rebuild({"parameters": {}, "features": BASE_FEATURES + list(extra)})
    return {b["id"]: b["shape"].volume for b in bodies}, errors


BASE, _base_errors = build()
assert _base_errors == [], _base_errors
assert abs(BASE["body1"] - 16000.0) < 1e-6 and abs(BASE["body2"] - 360.0) < 1e-6, BASE


def edge_sel(point, body=None):
    sel = {"kind": "edge", "by": "nearest", "point": point}
    return {**sel, "body": body} if body else sel


def face_sel(point, body=None):
    sel = {"kind": "face", "by": "nearest", "point": point}
    return {**sel, "body": body} if body else sel


def test_chamfer_bound_to_body_leaves_the_other_untouched():
    """THE BUG: a chamfer on a body1 edge used to shave body2 instead, silently."""
    vols, errors = build({"id": "c1", "type": "chamfer", "distance": 1.0,
                          "edges": edge_sel(B1_CORNER, "body1")})
    assert errors == [], errors
    assert vols["body1"] < BASE["body1"], "body1 (the selected body) was not chamfered"
    # exact equality: the untouched body must be the very same solid, not merely close
    assert vols["body2"] == BASE["body2"], (
        f"body2 was edited but nothing on it was selected: {BASE['body2']} -> {vols['body2']}"
    )
    print(PASS, "chamfer bound to body1 leaves body2 bit-identical")


def test_unbound_chamfer_would_have_hit_the_wrong_body():
    """Pins the old behaviour that made the bug silent: the SAME point with no
    `body` resolves against the active body and edits body2 — a wrong edit with
    no error. This is why the tools must stamp the body at pick time; it is kept
    as the back-compat path only so pre-existing documents still build."""
    vols, errors = build({"id": "c1", "type": "chamfer", "distance": 1.0,
                          "edges": edge_sel(B1_CORNER)})
    assert errors == [], errors
    assert vols["body1"] == BASE["body1"]
    assert vols["body2"] < BASE["body2"], "legacy path stopped resolving against the active body"
    print(PASS, "unbound selector still targets the active body (back-compat)")


def test_fillet_spans_two_bodies_in_one_feature():
    """A single Fillet may carry edges from several bodies: each selector
    resolves against its OWN body, and both get blended."""
    vols, errors = build({"id": "f1", "type": "fillet", "radius": 1.0,
                          "edges": [edge_sel(B1_CORNER, "body1"), edge_sel(B2_CORNER, "body2")]})
    assert errors == [], errors
    assert vols["body1"] < BASE["body1"], "body1 was not filleted"
    assert vols["body2"] < BASE["body2"], "body2 was not filleted"
    print(PASS, "one fillet feature blends edges on two different bodies")


def test_partial_failure_leaves_every_body_untouched():
    """All-or-nothing: r=7 rounds body1's corner happily but is impossible on
    body2, whose faces are only 6mm wide. body1 must NOT be left blended — a
    half-applied feature is a solid the user never asked for and cannot see."""
    solo, solo_errors = build({"id": "f1", "type": "fillet", "radius": 7.0,
                               "edges": edge_sel(B1_CORNER, "body1")})
    assert solo_errors == [] and solo["body1"] < BASE["body1"], (
        "precondition: r=7 must succeed on body1 alone", solo_errors
    )
    vols, errors = build({"id": "f1", "type": "fillet", "radius": 7.0,
                          "edges": [edge_sel(B1_CORNER, "body1"), edge_sel(B2_CORNER, "body2")]})
    assert errors, "an impossible fillet reported no error"
    assert "Body2" in errors[0]["message"], f"the error should name the failing body: {errors}"
    assert vols["body1"] == BASE["body1"], "body1 was left modified by a failed feature"
    assert vols["body2"] == BASE["body2"], "body2 was left modified by a failed feature"
    print(PASS, "a failing multi-body fillet is a clean no-op on every body")


def test_missing_body_is_a_clear_error_not_a_wrong_edit():
    """A selector naming a body that no longer exists must fail loudly rather
    than fall back to whatever body happens to be active."""
    vols, errors = build({"id": "c1", "type": "chamfer", "distance": 1.0,
                          "edges": edge_sel(B1_CORNER, "bodyGONE")})
    assert errors, "a dangling body reference silently succeeded"
    assert "no longer exists" in errors[0]["message"], errors
    assert vols == BASE, "a dangling body reference still edited something"
    print(PASS, "a dangling body reference errors instead of editing the wrong body")


def test_shell_targets_the_bound_body():
    vols, errors = build({"id": "sh1", "type": "shell", "thickness": 1.0,
                          "faces": face_sel(B1_TOP, "body1")})
    assert errors == [], errors
    assert vols["body1"] < BASE["body1"], "body1 was not shelled"
    assert vols["body2"] == BASE["body2"], (
        f"shell hollowed the wrong body: {BASE['body2']} -> {vols['body2']}"
    )
    print(PASS, "shell hollows the bound body only")


def test_shell_without_faces_still_uses_the_active_body():
    """The ribbon's no-opening path has no selector to carry a body."""
    vols, errors = build({"id": "sh1", "type": "shell", "thickness": 1.0})
    assert errors == [], errors
    assert vols["body2"] < BASE["body2"]
    assert vols["body1"] == BASE["body1"]
    print(PASS, "faceless shell still targets the active body")


def test_draft_targets_the_bound_body():
    vols, errors = build({"id": "d1", "type": "draft", "angle": 5, "axis": "Z",
                          "faces": face_sel(B2_SIDE, "body2")})
    assert errors == [], errors
    assert vols["body2"] != BASE["body2"], "body2 was not drafted"
    assert vols["body1"] == BASE["body1"], (
        f"draft tapered the wrong body: {BASE['body1']} -> {vols['body1']}"
    )
    print(PASS, "draft tapers the bound body only")


def main():
    test_chamfer_bound_to_body_leaves_the_other_untouched()
    test_unbound_chamfer_would_have_hit_the_wrong_body()
    test_fillet_spans_two_bodies_in_one_feature()
    test_partial_failure_leaves_every_body_untouched()
    test_missing_body_is_a_clear_error_not_a_wrong_edit()
    test_shell_targets_the_bound_body()
    test_shell_without_faces_still_uses_the_active_body()
    test_draft_targets_the_bound_body()
    print("ALL PASS")


if __name__ == "__main__":
    main()
