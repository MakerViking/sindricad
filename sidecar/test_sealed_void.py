"""A cut that seals a cavity inside the body announces itself.

GH #52: a sketch's plane is baked at pick time, so a sketch placed on a body's
top face stays at the OLD height when the body grows. The extrude cut that used
to open a pocket then runs entirely inside the material and closes an invisible
bubble. Nothing fails — the user sees an unchanged-looking body and finds the
hole months later, in the slicer.

This is the backstop, and it is deliberately independent of the face-anchor fix:
it detects the RESULT, so it covers the ~all existing .sindri files that carry no
face reference and never will.

VOLUME IS A FALSE ORACLE HERE, which is the whole reason the check counts shells.
test_volume_cannot_tell_the_two_apart pins that: the sealed document and a
correctly-placed open pocket have the SAME volume to 1e-6 and the same solid
count; only the shell count separates them. Anybody "simplifying" this suite to a
volume comparison gets a green test that cannot see the bug.

Run:  uv run python test_sealed_void.py
"""

from builder import rebuild

BOX = 20.0        # length and width
R = 3.0           # cut circle radius
DEPTH = 5.0       # cut depth


def _doc(height, plane_z):
    """Box `height` tall (the primitive is CENTRED: top face is z=+height/2) with a
    circle sketched on a plane baked at `plane_z`, cut DEPTH downward.

    plane_z == height/2 is a correctly-placed cut (an open pocket in the top
    face); plane_z below it is the #52 shape (the plane stayed where it was baked
    while the body grew underneath it)."""
    return {"parameters": {}, "features": [
        {"id": "b1", "type": "box", "length": BOX, "width": BOX, "height": height},
        {"id": "s2", "type": "sketch",
         "plane": {"origin": [0, 0, plane_z], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         # entity shape trap: circles are {type,radius,x,y} — not kind/r/cx/cy. A
         # wrong shape makes the sketch fail, the extrude no-op, and the volume
         # land on the bare box's, which looks plausible and proves nothing.
         "entities": [{"id": "c1", "type": "circle", "radius": R, "x": 0, "y": 0}]},
        {"id": "x1", "type": "extrude", "sketch": "s2", "distance": -DEPTH,
         "operation": "cut", "regions": [[0, 0, plane_z]]},
    ]}


def _build(height, plane_z):
    diag = []
    _part, errors, bodies = rebuild(_doc(height, plane_z), diagnostics=diag)
    assert bodies and bodies[0].get("shape") is not None, f"no body built: {errors}"
    shape = bodies[0]["shape"]
    return {
        "errors": errors,
        "sealed": [d for d in diag if d.get("kind") == "sealedVoid"],
        "diag": diag,
        "vol": shape.volume,
        "solids": len(shape.solids()),
        "shells": len(shape.shells()),
    }


def test_sealed_void_is_reported():
    """The #52 document: box grown to 20 with the sketch plane still at z=5."""
    r = _build(20.0, 5.0)
    assert r["shells"] == 2, f"expected a second (inner) shell, got {r['shells']}"
    assert r["solids"] == 1, f"still one solid: {r['solids']}"
    assert r["errors"] == [], f"a sealed void must NOT fail the build: {r['errors']}"
    assert len(r["sealed"]) == 1, f"expected one sealedVoid diagnostic, got {r['diag']}"
    d = r["sealed"][0]
    assert d["feature_id"] == "x1", f"diagnostic must name the CUT: {d}"
    assert d["code"] == "sealedVoid", d
    assert d["reason"] == "This cut closed a cavity inside the body.", d
    # lossy is the flag project_geometry refuses a source selection on, and it
    # means "a best-effort MATCH was taken". Nothing was matched here.
    assert d["lossy"] is False, f"sealedVoid must not claim a lossy resolution: {d}"
    assert len(d["at"]) == 3 and abs(d["at"][2] - 2.5) < 1e-6, \
        f"`at` should point at the cavity (mid-cut z=2.5): {d}"
    print("  sealed void OK: 2 shells, build green, diagnostic on the cut")


def test_open_pocket_is_silent():
    """The control that stops this firing on every cut: the same cut placed
    correctly breaks the surface (1 shell) and says nothing. Without it, an
    unconditional diagnostic would pass the case above."""
    for height, plane_z, what in ((10.0, 5.0, "unedited document"),
                                  (20.0, 10.0, "plane that followed the top face")):
        r = _build(height, plane_z)
        assert r["shells"] == 1, f"{what}: an open pocket has ONE shell, got {r['shells']}"
        assert not r["sealed"], f"{what}: must not warn, got {r['sealed']}"
    print("  open pockets silent: unedited box and a correctly-followed plane")


def test_volume_cannot_tell_the_two_apart():
    """The oracle justification, as an assertion. A sealed void and a correct
    pocket of the same profile remove the same material — identical volume,
    identical solid count. If this ever fails, the shell check has become
    unnecessary; until then it is the only thing that sees the bug."""
    sealed = _build(20.0, 5.0)
    open_pocket = _build(20.0, 10.0)
    assert abs(sealed["vol"] - open_pocket["vol"]) < 1e-6, \
        f"volumes diverged ({sealed['vol']} vs {open_pocket['vol']}) — re-check the premise"
    assert sealed["solids"] == open_pocket["solids"] == 1
    assert sealed["shells"] != open_pocket["shells"], \
        "shell count no longer separates them — this backstop is blind"
    print(f"  false-oracle control: both {sealed['vol']:.3f} mm3, "
          f"shells {sealed['shells']} vs {open_pocket['shells']}")


def test_a_caller_that_collects_no_diagnostics_still_builds():
    """rebuild(diagnostics=None) is the common case (previews, exports). The
    shell counting is gated on it, so this is the guard against the gate itself
    throwing."""
    _part, errors, bodies = rebuild(_doc(20.0, 5.0))
    assert not errors, errors
    assert len(bodies[0]["shape"].shells()) == 2, "geometry must be unchanged"
    print("  diagnostics=None path unaffected")


def test_a_deliberate_hollow_is_not_an_error():
    """Stated as its own case because it is the reason this is a DIAGNOSTIC:
    sealing a cavity on purpose (a closed-cell part, a captive cavity) is legal
    geometry and must keep building. Same document as the #52 case — the sidecar
    cannot tell intent apart, and must not try."""
    r = _build(20.0, 5.0)
    assert r["errors"] == [], r["errors"]
    assert abs(r["vol"] - (BOX * BOX * 20.0 - 3.141592653589793 * R * R * DEPTH)) < 1e-3, \
        f"the cut must still have removed its material: {r['vol']}"
    print("  hollow builds green — a diagnostic, never an error")


def test_a_cut_that_splits_the_body_is_not_a_void():
    """Found in the field on the first real file this ran against
    (Laptop-stand.sindri, feature f55): a through-slot that cuts a body in TWO
    raised the shell count from 1 to 2 — two solids, one skin each — and the
    backstop called that a sealed cavity. A raw shell delta cannot tell a
    second PIECE from a second SKIN; shells minus solids can, because a void is
    a solid wearing more than one shell. Both spellings of a split are covered:
    the plain cut (one body holding two solids) and `separateBodies`, which is
    what that file used."""
    for separate in (False, True):
        doc = {"parameters": {}, "features": [
            {"id": "b1", "type": "box", "length": BOX, "width": BOX, "height": 10},
            # a 2 mm wide slot right through the middle, taller than the box
            {"id": "s2", "type": "sketch",
             "plane": {"origin": [0, 0, 5], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
             "entities": [{"id": "r1", "type": "rectangle", "width": 2,
                           "height": 2 * BOX, "x": 0, "y": 0}]},
            {"id": "x1", "type": "extrude", "sketch": "s2", "distance": -20,
             "operation": "cut", "separateBodies": separate},
        ]}
        diag = []
        _part, errors, bodies = rebuild(doc, diagnostics=diag)
        assert errors == [], errors
        shells = sum(len(b["shape"].shells()) for b in bodies)
        solids = sum(len(b["shape"].solids()) for b in bodies)
        assert solids == 2 and shells == 2, (separate, solids, shells)
        sealed = [d for d in diag if d.get("kind") == "sealedVoid"]
        assert not sealed, f"separateBodies={separate}: a split is not a cavity, got {sealed}"
    print("  a cut that splits the body into two pieces stays silent")


if __name__ == "__main__":
    test_sealed_void_is_reported()
    test_open_pocket_is_silent()
    test_volume_cannot_tell_the_two_apart()
    test_a_caller_that_collects_no_diagnostics_still_builds()
    test_a_deliberate_hollow_is_not_an_error()
    test_a_cut_that_splits_the_body_is_not_a_void()
    print("ALL PASS")
