"""Text-on-face tests (sidecar): emboss/engrave a string directly onto a solid
face. Covers the exact volume contract, the guards that exist to stop silent
degradation, and the two traps that shaped the design (glyphs smaller than
_press_pull's mesh-facet floor; a face that moved after the text was placed).

Run: uv run python test_text_on_face.py
"""

import math

import builder
from build123d import Box, Pos

PASS = "  ok"

TOP_PLANE = {"origin": [0, 0, 2.5], "normal": [0, 0, 1], "xdir": [1, 0, 0]}


def _box_and_text(**over):
    """Box(60,30,5) + one textOnFace on its top face. `over` patches the text."""
    feat = {
        "id": "t1", "type": "textOnFace",
        "face": {"kind": "face", "by": "nearest", "point": [0, 0, 2.5], "body": "body1"},
        "pick": [0, 0, 2.5], "plane": TOP_PLANE,
        "text": "SindriCAD", "height": 6, "align": "center",
        "depth": 0.6, "operation": "emboss",
    }
    feat.update(over)
    return [
        {"id": "b", "type": "box", "length": 60, "width": 30, "height": 5},
        feat,
    ]


def _rebuild(feats):
    return builder.rebuild({"parameters": {}, "features": feats})


def _glyph_area(text="SindriCAD", height=6, align="center"):
    ent = {"text": text, "height": height, "align": align, "x": 0, "y": 0}
    return sum(g.area for g in builder._text_faces(ent, lambda v: v))


def test_emboss_adds_exactly_the_glyph_volume():
    part, errors, _ = _rebuild(_box_and_text())
    assert not errors, errors
    expect = 60 * 30 * 5 + _glyph_area() * 0.6
    assert abs(part.volume - expect) < 1e-6, f"emboss volume {part.volume} != {expect}"
    assert len(part.solids()) == 1, f"emboss left {len(part.solids())} solids"
    print(PASS, "emboss adds exactly the glyph volume, one solid")


def test_engrave_removes_exactly_the_glyph_volume():
    part, errors, _ = _rebuild(_box_and_text(operation="engrave"))
    assert not errors, errors
    expect = 60 * 30 * 5 - _glyph_area() * 0.6
    assert abs(part.volume - expect) < 1e-6, f"engrave volume {part.volume} != {expect}"
    assert len(part.solids()) == 1, f"engrave left {len(part.solids())} solids"
    print(PASS, "engrave removes exactly the glyph volume, one solid")


def test_tiny_glyphs_are_not_dropped():
    """A period is 0.368 mm2 at font_size 6 — below the 1.0 mm2 floor that
    _press_pull rejects on any body past 300 faces. This feature must build its
    own prisms, so every dot and comma still contributes."""
    with_dot = _glyph_area(text="i.", height=6, align="left")
    without = _glyph_area(text="i", height=6, align="left")
    assert with_dot > without, "test is not exercising a tiny glyph"
    part, errors, _ = _rebuild(_box_and_text(text="i.", height=6, align="left"))
    assert not errors, errors
    expect = 60 * 30 * 5 + with_dot * 0.6
    assert abs(part.volume - expect) < 1e-6, "a tiny glyph was dropped"
    print(PASS, f"tiny glyphs survive (period adds {(with_dot - without):.3f} mm2)")


def test_tiny_glyph_on_a_dense_body():
    """The regression _press_pull would have caused: the <1.0 mm2 mesh-facet
    guard only fires once a body passes 300 faces, so it would have looked fine
    on a plain box and refused every period on a real imported part."""
    dense = Box(60, 30, 5)
    for i in range(-6, 7):
        for j in range(-2, 3):
            dense -= Pos(i * 4, j * 5, 2.0) * Box(1.2, 1.2, 2.0)
    n = len(dense.faces())
    assert n > 300, f"dense fixture only has {n} faces"
    bodies = [{"id": "body1", "name": "Box", "shape": dense}]
    ctx = builder._RebuildCtx(
        val=lambda v: v, datums={}, sketches={}, bodies=bodies, diagnostics=None,
        hidden_bodies=frozenset(), new_body=None, active=lambda: bodies[-1],
        require_active=lambda label: bodies[-1],
        find_body=lambda bid: next((b for b in bodies if b["id"] == bid), None),
    )
    feat = _box_and_text(text="i.", height=6, align="left")[1]
    # pick between the pockets: on top of one, every wall is equidistant and the
    # selector rightly refuses the ambiguous reference
    feat["face"] = {"kind": "face", "by": "nearest", "point": [2, 2.5, 2.5], "body": "body1"}
    feat["pick"] = [2, 2.5, 2.5]
    before = dense.volume
    builder._handle_text_on_face(feat, ctx)
    got = bodies[0]["shape"].volume - before
    expect = _glyph_area(text="i.", height=6, align="left") * 0.6
    assert abs(got - expect) < 1e-6, f"dense body: {got} != {expect}"
    print(PASS, f"tiny glyphs still emboss on a {n}-face body")


def test_blank_text_raises_instead_of_building_nothing():
    """_text_faces is best-effort and returns [] for blank text AND for a font
    it can't load. Unguarded that ships a green timeline chip and no geometry."""
    part, errors, _ = _rebuild(_box_and_text(text="   "))
    assert errors, "blank text silently produced no geometry"
    assert "no glyphs" in errors[0].get("message", ""), errors
    assert abs(part.volume - 60 * 30 * 5) < 1e-6, "the base body should survive"
    print(PASS, "blank text raises rather than silently embossing nothing")


def test_zero_depth_raises():
    _, errors, _ = _rebuild(_box_and_text(depth=0))
    assert errors and "greater than 0" in errors[0].get("message", ""), errors
    print(PASS, "zero depth raises")


def _cyl_text(**over):
    """Cylinder r=20 h=60 (axis Z) + text on its lateral face, read from +X."""
    feat = {
        "id": "t1", "type": "textOnFace",
        "face": {"kind": "face", "by": "nearest", "point": [20, 0, 0], "body": "body1"},
        "pick": [20, 0, 0],
        "plane": {"origin": [20, 0, 0], "normal": [1, 0, 0], "xdir": [0, 0, 1]},
        "text": "SindriCAD", "height": 8, "align": "center",
        "depth": 0.6, "operation": "emboss",
    }
    feat.update(over)
    return [{"id": "c", "type": "cylinder", "radius": 20, "height": 60}, feat]


def test_curved_face_emboss_and_engrave():
    """The regression baseline from the kernel study: 11 glyphs on a R=20
    cylinder, one valid solid each way.

    The volumes are deliberately NOT asserted equal. On a curved face they must
    not be: an outward shell over the same patch holds more material than the
    inward one, because it sits at a larger radius. For a cylinder that ratio is
    exactly (2R+d)/(2R-d), and checking it is a much stronger test than symmetry
    would have been — a wrong projection direction, a flipped thicken sign or a
    truncated patch all break it, and none of them break "both are positive"."""
    up, e1, _ = _rebuild(_cyl_text())
    down, e2, _ = _rebuild(_cyl_text(operation="engrave"))
    assert not e1, e1
    assert not e2, e2
    base = math.pi * 400 * 60
    added, removed = up.volume - base, base - down.volume
    assert added > 1.0 and removed > 1.0, f"curved emboss/engrave moved nothing ({added}, {removed})"
    expect = (2 * 20 + 0.6) / (2 * 20 - 0.6)
    got = added / removed
    assert abs(got - expect) < expect * 0.005, f"shell ratio {got:.6f} != {expect:.6f}"
    assert len(up.solids()) == 1 and len(down.solids()) == 1
    print(PASS, f"cylinder emboss/engrave exact ({added:.3f} mm3, shell ratio {got:.6f})")


def test_cone_and_sphere():
    """Cone and sphere, at the handler level: SindriCAD has a `sphere` primitive
    feature but no `cone` one, so the cone is driven straight into the handler
    rather than left uncovered."""
    from build123d import Cone, Sphere

    for name, solid, pick in (
        ("sphere", Sphere(30), [0, -30, 0]),
        ("cone", Cone(25, 8, 60), None),
    ):
        if pick is None:  # the cone's slanted lateral face — take a real point on it
            lat = [f for f in solid.faces() if f.geom_type.name == "CONE"][0]
            c = lat.center()
            pick = [c.X, c.Y, c.Z]
            n = lat.normal_at(c)
            normal = [n.X, n.Y, n.Z]
        else:
            normal = [0, -1, 0]
        bodies = [{"id": "body1", "name": name, "shape": solid}]
        ctx = builder._RebuildCtx(
            val=lambda v: v, datums={}, sketches={}, bodies=bodies, diagnostics=None,
            hidden_bodies=frozenset(), new_body=None, active=lambda: bodies[-1],
            require_active=lambda label: bodies[-1],
            find_body=lambda bid: next((b for b in bodies if b["id"] == bid), None),
        )
        before = solid.volume
        builder._handle_text_on_face({
            "id": "t1", "type": "textOnFace",
            "face": {"kind": "face", "by": "nearest", "point": pick, "body": "body1"},
            "pick": pick,
            "plane": {"origin": pick, "normal": normal, "xdir": [0, 0, 1]},
            "text": "Ag", "height": 6, "align": "center",
            "depth": 0.6, "operation": "emboss"}, ctx)
        out = bodies[0]["shape"]
        assert out.volume > before, f"{name} emboss added nothing"
        assert len(out.solids()) == 1, f"{name} left {len(out.solids())} solids"
        print(PASS, f"{name} emboss builds one valid solid (+{out.volume - before:.3f} mm3)")


def test_text_running_off_a_curved_face_raises():
    """The single most dangerous measured failure: text overflowing the
    silhouette truncates SILENTLY — one valid solid, no missing glyphs, a
    plausible volume, and two letters sheared off. Coverage measured 0.32."""
    _, errors, _ = _rebuild(_cyl_text(height=14))
    assert errors, "oversized text silently truncated instead of raising"
    assert "runs off this face" in errors[0].get("message", ""), errors
    print(PASS, "text overflowing a curved face raises instead of truncating")


def test_bevel_emboss_removes_material_from_the_rim():
    """A bevelled emboss must add strictly LESS than a sharp one — the bevel
    takes material off the letter rim — while still being one valid solid."""
    sharp, e1, _ = _rebuild(_box_and_text())
    bev, e2, _ = _rebuild(_box_and_text(bevel=0.05))
    assert not e1, e1
    assert not e2, e2
    base = 60 * 30 * 5
    assert bev.volume < sharp.volume, "the bevel removed nothing from the rim"
    assert bev.volume > base, "the bevel ate the whole text"
    assert len(bev.solids()) == 1
    print(PASS, f"bevelled emboss is one solid, {sharp.volume - bev.volume:.3f} mm3 off the rim")


def test_bevel_engrave_widens_the_mouth():
    """An engrave bevels the pocket MOUTH, which only exists after the cut, so
    it must remove MORE material than a sharp engrave."""
    sharp, e1, _ = _rebuild(_box_and_text(operation="engrave"))
    bev, e2, _ = _rebuild(_box_and_text(operation="engrave", bevel=0.05))
    assert not e1, e1
    assert not e2, e2
    assert bev.volume < sharp.volume, "the engrave bevel widened nothing"
    assert len(bev.solids()) == 1
    print(PASS, f"bevelled engrave is one solid, {sharp.volume - bev.volume:.3f} mm3 extra")


def test_bevel_wider_than_the_stroke_is_refused_up_front():
    """OCCT raised in 568 of 568 operations once the bevel reached half the
    stroke width — two bevels eating from opposite sides of a stroke of width w
    collide at w/2. Refusing here costs nothing and saves a process fork."""
    _, errors, _ = _rebuild(_box_and_text(height=3, bevel=0.4))
    assert errors, "an impossible bevel was handed to the kernel anyway"
    msg = errors[0].get("message", "")
    assert "too big for this text" in msg, msg
    print(PASS, "a bevel wider than the stroke is refused before the kernel sees it")


def test_bevel_deeper_than_the_text_is_refused():
    _, errors, _ = _rebuild(_box_and_text(depth=0.2, bevel=0.3))
    assert errors and "more than" in errors[0].get("message", ""), errors
    print(PASS, "a bevel deeper than the text is refused")


def test_probe_verdicts_are_cached():
    """The probe costs a process fork, and SindriCAD rebuilds the whole document
    on every change — so a second identical build must not fork again.
    `_probe_bevels` returns before spawning anything on a cache hit, so a cache
    that has not grown is proof no second probe ran."""
    builder._BEVEL_PROBE_CACHE.clear()
    _rebuild(_box_and_text(text="Ag", bevel=0.1))
    assert len(builder._BEVEL_PROBE_CACHE) == 1, builder._BEVEL_PROBE_CACHE
    _rebuild(_box_and_text(text="Ag", bevel=0.1))
    assert len(builder._BEVEL_PROBE_CACHE) == 1, "an identical rebuild reforked the probe"
    _rebuild(_box_and_text(text="Ag", bevel=0.05))
    assert len(builder._BEVEL_PROBE_CACHE) == 2, "a different bevel size reused a stale verdict"
    print(PASS, "probe verdicts cached per recipe — identical rebuilds don't refork")


def test_an_unreported_combination_is_never_assumed_usable():
    """The whole point of the probe: a glyph blend that SIGSEGVs reports nothing
    at all. That silence must read as 'do not hand this to the worker', never as
    'fine'. Forced here with a timeout, because the real crashing combination
    (Nimbus Roman 'B') is host-dependent."""
    recipe = {"text": "Ag", "font": None, "style": "regular", "align": "center",
              "height": 6, "depth": 0.6, "radius": 0.1, "kinds": ["chamfer", "fillet"]}
    builder._BEVEL_PROBE_CACHE.clear()
    good = builder._probe_bevels(dict(recipe))
    assert any(good.values()), f"probe cleared nothing at all: {good}"
    builder._BEVEL_PROBE_CACHE.clear()
    saved = builder._BEVEL_PROBE_TIMEOUT
    builder._BEVEL_PROBE_TIMEOUT = 0.001  # nothing can report in time
    try:
        starved = builder._probe_bevels(dict(recipe))
    finally:
        builder._BEVEL_PROBE_TIMEOUT = saved
    assert not any(starved.values()), f"a silent probe was read as usable: {starved}"
    print(PASS, "a probe that never reports is treated as unusable, not usable")


def test_bevel_refused_when_no_operator_clears_every_glyph():
    """Measured on this font: at 0.15 mm, 'd' and 'n' fail BOTH chamfer and
    fillet, so the whole text must be refused rather than shipped part-sharp."""
    _, errors, _ = _rebuild(_box_and_text(bevel=0.15))
    assert errors, "a text with unbevelable letters was shipped anyway"
    msg = errors[0].get("message", "")
    assert "can't take" in msg and "letters" in msg, msg
    print(PASS, "all-or-nothing: unbevelable letters refuse the whole text")


def test_taper_slopes_the_walls():
    """Sloped walls remove material from a straight prism, so a tapered emboss
    must add strictly less than a square-walled one and still be one solid."""
    square, e1, _ = _rebuild(_box_and_text(text="AD", bevel=0))
    slope, e2, _ = _rebuild(_box_and_text(text="AD", bevel=0.15, bevelStyle="taper"))
    assert not e1, e1
    assert not e2, e2
    base = 60 * 30 * 5
    assert base < slope.volume < square.volume, \
        f"taper volume {slope.volume} not between {base} and {square.volume}"
    assert len(slope.solids()) == 1
    print(PASS, f"tapered emboss slopes the walls ({square.volume - slope.volume:.3f} mm3 off)")


def test_taper_is_refused_on_a_curved_face():
    _, errors, _ = _rebuild(_cyl_text(bevel=0.1, bevelStyle="taper"))
    assert errors, "sloped walls were attempted on a curved face"
    assert "flat face" in errors[0].get("message", ""), errors
    print(PASS, "sloped walls are refused on a curved face")


def test_taper_rejects_silently_corrupt_geometry():
    """The taper path is the only one that returns CORRUPT GEOMETRY WITHOUT
    RAISING — measured: Text('g') at 25 degrees comes back with volume 0.0 and
    IsValid() false, Text('Q') with a NEGATIVE volume, and 'S'/'M'/'W' at 20
    degrees and up with plausible volumes on self-intersected walls. So
    _taper_prism must return None, never a shape, for anything it can't verify."""
    g = builder._text_faces({"text": "g", "height": 6, "x": 0, "y": 0}, lambda v: v)[0]
    assert builder._taper_prism(g, 0.6, 0) is not None, "a zero taper must build"
    flat = g.area * 0.6
    bad = 0
    for angle in (20, 25, 35, 45, 60):
        out = builder._taper_prism(g, 0.6, angle)
        if out is None:
            bad += 1
            continue
        # anything it DID return must be verifiably sane
        assert len(out.solids()) == 1 and 0 < out.volume <= flat * 1.001, \
            f"taper {angle}deg returned unverified geometry: vol={out.volume}"
    assert bad > 0, "expected at least one taper angle to be refused for this glyph"
    print(PASS, f"taper validation refused {bad} of 5 angles rather than returning garbage")


def test_preview_outlines_match_the_committed_solid():
    """While typing, the tool draws 2D outlines from `tessellateText` — 20.7 ms
    against 223 ms for a real emboss rebuild — and only builds the solid once
    typing pauses. That is only honest if both come out of the same font engine,
    so the preview entity the tool sends must be the one `_text_entity_of`
    builds, and must yield the same glyphs.

    This is the test that catches the tool's entity shape drifting away from the
    sidecar's: a renamed or forgotten field (u/v -> x/y, style, boxWidth) would
    silently move or restyle the preview while the commit stayed put."""
    feat = _box_and_text(text="Ag oj", height=6, align="center")[1]
    feat["u"], feat["v"] = 3.5, -2.0
    feat["angle"] = 15

    ent = builder._text_entity_of(feat)
    assert ent["x"] == 3.5 and ent["y"] == -2.0, f"u/v did not become x/y: {ent}"

    solid_glyphs = builder._text_faces(ent, lambda v: v)
    preview = builder.tessellate_text(ent)["faces"]
    assert len(preview) == len(solid_glyphs) > 0, \
        f"preview has {len(preview)} glyphs, solid has {len(solid_glyphs)}"

    # same footprint: the outline the user sees is where the material lands
    xs = [p[0] for fc in preview for p in fc["outer"]]
    ys = [p[1] for fc in preview for p in fc["outer"]]
    gb = [g.bounding_box() for g in solid_glyphs]
    assert abs(min(xs) - min(b.min.X for b in gb)) < 0.05, "preview/solid X origin differs"
    assert abs(max(xs) - max(b.max.X for b in gb)) < 0.05, "preview/solid X extent differs"
    assert abs(min(ys) - min(b.min.Y for b in gb)) < 0.05, "preview/solid Y origin differs"
    assert abs(max(ys) - max(b.max.Y for b in gb)) < 0.05, "preview/solid Y extent differs"

    holes = sum(len(fc["holes"]) for fc in preview)
    assert holes >= 2, f"'Ag oj' must keep its counters as holes, got {holes}"
    print(PASS, f"typing preview matches the committed solid ({len(preview)} glyphs, {holes} holes)")


def test_moved_face_raises_instead_of_floating():
    """The layout plane is captured at pick time. If the face later moves, the
    glyphs would hover in mid-air with a green timeline — raise instead."""
    feats = _box_and_text()
    feats[0]["height"] = 9  # top face moves 2.5 -> 4.5, plane still says 2.5
    _, errors, _ = _rebuild(feats)
    assert errors and "has moved" in errors[0].get("message", ""), errors
    print(PASS, "a face that moved raises 're-pick the face'")


def test_selector_binds_to_its_own_body():
    """by:"nearest" always returns SOME winner, so without the body stamp the
    text would silently land on whichever body was created last."""
    feats = [
        {"id": "b1", "type": "box", "length": 60, "width": 30, "height": 5},
        {"id": "m", "type": "move", "body": "body1", "dx": 0, "dy": 0, "dz": 0},
        {"id": "b2", "type": "box", "length": 10, "width": 10, "height": 40},
        {"id": "t1", "type": "textOnFace",
         "face": {"kind": "face", "by": "nearest", "point": [0, 0, 2.5], "body": "body1"},
         "pick": [0, 0, 2.5], "plane": TOP_PLANE,
         "text": "Ag", "height": 6, "align": "center",
         "depth": 0.6, "operation": "emboss"},
    ]
    _, errors, bodies = _rebuild([f for f in feats if f["id"] != "m"])
    assert not errors, errors
    by_id = {b["id"]: b for b in bodies}
    grew = by_id["body1"]["shape"].volume - 60 * 30 * 5
    assert grew > 0, "the text did not land on body1"
    assert abs(by_id["body2"]["shape"].volume - 10 * 10 * 40) < 1e-6, \
        "the text leaked onto the last-created body"
    print(PASS, "the text binds to its selector's own body, not the active one")


def main():
    print("Text-on-face tests")
    test_emboss_adds_exactly_the_glyph_volume()
    test_engrave_removes_exactly_the_glyph_volume()
    test_tiny_glyphs_are_not_dropped()
    test_tiny_glyph_on_a_dense_body()
    test_blank_text_raises_instead_of_building_nothing()
    test_zero_depth_raises()
    test_curved_face_emboss_and_engrave()
    test_cone_and_sphere()
    test_text_running_off_a_curved_face_raises()
    test_bevel_emboss_removes_material_from_the_rim()
    test_bevel_engrave_widens_the_mouth()
    test_bevel_wider_than_the_stroke_is_refused_up_front()
    test_bevel_deeper_than_the_text_is_refused()
    test_probe_verdicts_are_cached()
    test_an_unreported_combination_is_never_assumed_usable()
    test_bevel_refused_when_no_operator_clears_every_glyph()
    test_taper_slopes_the_walls()
    test_taper_is_refused_on_a_curved_face()
    test_taper_rejects_silently_corrupt_geometry()
    test_preview_outlines_match_the_committed_solid()
    test_moved_face_raises_instead_of_floating()
    test_selector_binds_to_its_own_body()
    print("ALL PASS")


if __name__ == "__main__":
    main()
