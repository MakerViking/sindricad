"""Non-Latin text must never be embossed as .notdef boxes (sidecar/font_coverage.py).

Run: uv run python test_font_coverage.py

These tests assert what a user would SEE on the part, not that a checker was
called:

  * the tofu is measured first, from real geometry, so the guard is pinned to a
    demonstrated failure rather than a described one;
  * the Japanese case must still BUILD — OCCT falls back per glyph for CJK, and
    a coverage check naive enough to read only the chosen font's cmap would
    refuse a document that renders perfectly today;
  * the refusal's suggested font is used to build the same string, so the advice
    is proven rather than decorative.

Every test that needs a script this computer may not have installed says so and
skips, in the style test_text_on_face already uses for font-dependent numbers: a
CI runner has no guaranteed font for any script, including Latin.
"""

import font_guard  # noqa: E402  (MUST precede build123d — see its docstring)

font_guard.ensure()

import builder  # noqa: E402
import errors  # noqa: E402
import font_coverage  # noqa: E402
import tessellate  # noqa: E402
import untrusted  # noqa: E402

PASS = "  ok"
SKIP = "  -- skipped"

# A Latin+Japanese mix: the string a version-stamped part actually carries, and
# the one that proves the Latin run and the CJK run come out of the same layout.
MIXED = "v0.2 テスト"

# Thai renders as tofu in every Latin font AND has no OCCT fallback subset, so
# it is the reproducible tofu case. (Japanese is not: OCCT falls back for it.)
TOFU = "ทดสอบ"

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
    return [{"id": "b", "type": "box", "length": 60, "width": 30, "height": 5}, feat]


def _sketch_and_extrude(text, font=None):
    ent = {"id": "t", "type": "text", "text": text, "height": 10, "x": 0, "y": 0}
    if font:
        ent["font"] = font
    return [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [ent]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 3, "operation": "new"},
    ]


def _raw_faces(text, font=None):
    """Glyph faces straight from the UNGUARDED builder — what shipped before."""
    ent = {"text": text, "height": 10, "x": 0, "y": 0}
    if font:
        ent["font"] = font
    raw = getattr(builder._text_faces, "_unguarded", builder._text_faces)
    return raw(ent, lambda v: v)


def _free_edge_count(shape):
    """Edges with exactly one adjacent face — the topological form of "leaks"."""
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

    emap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape.wrapped, TopAbs_EDGE, TopAbs_FACE, emap)
    return sum(1 for i in range(1, emap.Extent() + 1)
               if emap.FindFromIndex(i).Extent() < 2)


def _degenerate_triangles(positions, indices, floor=1e-9):
    """Triangles with effectively no area. A .notdef box is not degenerate, but a
    glyph outline pushed through a font it does not belong to often is, and a
    slicer will choke on them long before a human notices."""
    import numpy as np

    P = np.asarray(positions, dtype=float).reshape(-1, 3)
    T = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    return int((area <= floor).sum())


def test_the_tofu_is_real_and_the_guard_refuses_it():
    """Two halves of one claim, because neither alone is worth anything.

    FIRST measure the bug: build the Thai string through the unguarded glyph
    path and show every character comes back as the SAME shape — that identity
    is what .notdef means, and it is the part a description of the bug cannot
    prove. THEN show a rebuild refuses it, names the characters, and leaves the
    body untouched.
    """
    if not font_coverage.missing_glyphs(TOFU):
        print(SKIP, "this computer's default font covers Thai; no tofu to measure")
        return

    faces = _raw_faces(TOFU)
    assert len(faces) == len(TOFU), \
        f"expected one glyph per character, got {len(faces)} for {len(TOFU)}"
    areas = sorted(round(f.area, 6) for f in faces)
    assert areas[0] == areas[-1], (
        "the unguarded path was supposed to emit five IDENTICAL .notdef boxes; "
        f"got distinct areas {areas} — has OCCT grown a fallback for Thai?")

    part, errs, _ = builder.rebuild(
        {"parameters": {}, "features": _box_and_text(text=TOFU)})
    assert errs, "a string of tofu boxes was embossed with no error at all"
    msg = errs[0].get("message", "")
    assert errs[0].get("code") == errors.FONT_MISSING_GLYPHS, errs[0]
    for ch in TOFU:
        assert ch in msg, f"the message must name the character {ch!r}: {msg}"
    assert abs(part.volume - 60 * 30 * 5) < 1e-6, \
        f"the refused text still changed the body: {part.volume}"
    print(PASS, f"{len(TOFU)} identical .notdef boxes ({areas[0]} mm2 each) are now "
                f"refused, naming every character, body untouched")


def test_japanese_still_builds_a_valid_watertight_solid():
    """The false positive that would have been worse than the bug.

    OCCT falls back per glyph for the CJK subset, so "v0.2 テスト" renders
    correctly in a Latin family TODAY. A coverage check that read only the
    chosen font's cmap would refuse it and break every such document. So: no
    refusal, real glyphs (not boxes), and a solid that is valid, watertight and
    free of degenerate triangles — the same bar any printable part has to clear.
    """
    if font_coverage.missing_glyphs(MIXED):
        print(SKIP, "no font on this computer can draw Japanese")
        return

    part, errs, _ = builder.rebuild(
        {"parameters": {}, "features": _box_and_text(text=MIXED, height=6)})
    assert not errs, errs

    from OCP.BRepCheck import BRepCheck_Analyzer

    assert BRepCheck_Analyzer(part.wrapped).IsValid(), "the embossed solid is invalid"
    assert builder._watertight(builder._as_compound(part)), "the solid is not watertight"
    assert _free_edge_count(part) == 0, "the solid has free edges"
    assert len(part.solids()) == 1, f"emboss left {len(part.solids())} solids"

    positions, indices, _ids = tessellate.tessellate(part, tolerance=0.05)
    bad = _degenerate_triangles(positions, indices)
    assert bad == 0, f"{bad} degenerate triangles in the meshed CJK emboss"
    # `tessellate` gives every B-rep face its own vertex chunk, so open edges by
    # INDEX are expected until the export welds them — weld first, exactly as
    # the export path does, or this measures the mesher rather than the part.
    welded_p, welded_i, _ = tessellate.weld_vertices(positions, indices)
    assert tessellate.open_edge_count(welded_i) == 0, \
        "the exported mesh of the CJK emboss is not closed"
    assert _degenerate_triangles(welded_p, welded_i) == 0, \
        "welding collapsed triangles in the CJK emboss"

    # ...and the glyphs are glyphs, not boxes: four Latin faces (v 0 . 2) plus
    # the four contours of テ ス ト, all differently shaped.
    faces = _raw_faces(MIXED)
    areas = {round(f.area, 4) for f in faces}
    assert len(areas) == len(faces), f"repeated glyph areas smell of tofu: {areas}"
    print(PASS, f"'{MIXED}' embosses {len(faces)} distinct glyphs into a valid, "
                f"watertight solid with 0 degenerate triangles")


def _family_without_latin():
    """An installed family whose OWN face has no 'v' — 476 of the 701 here.

    Ordered so the reproduction's family comes first when it is installed, then
    shortest-name-first like `suggest_family`, so the pick is deterministic.
    """
    aspect = font_coverage._aspect("regular")
    names = font_coverage._available_families()
    first = [n for n in ("Noto Sans Thai", "Noto Kufi Arabic") if n in names]
    for name in first + sorted(names - set(first), key=lambda n: (len(n), n)):
        face, _real = font_coverage._open_face(name, aspect)
        if face is not None and not face.HasSymbol("v"):
            return name
    return None


def test_plain_ascii_is_not_refused_by_a_font_that_lacks_latin():
    """OCCT falls back for the WESTERN subset too, and skipping it refused text
    that renders perfectly.

    `Font_FontMgr::FindFallbackFont(Font_UnicodeSubset_Western, Font_FA_Regular)`
    returns DejaVu Sans on this machine, so every character the chosen face lacks
    but DejaVu supplies renders — yet the guard reported it missing. 476 of the
    701 families installed here have no 'v' of their own and so refused plain
    ASCII outright.

    Asserted on GEOMETRY as well as on the predicate, because the predicate is
    what was wrong: the reproduction document is Thai text plus an ASCII version
    stamp, in the very family the guard RECOMMENDS for Thai. Before the fix the
    sketch refused, the extrude cascaded, and the document produced no solid at
    all."""
    fam = _family_without_latin()
    if fam is None:
        print(SKIP, "every installed family covers Latin; no fallback to exercise")
        return
    face, _real = font_coverage._open_face(fam, font_coverage._aspect("regular"))
    assert not face.HasSymbol("v"), f"{fam} was supposed to lack Latin"

    assert font_coverage.missing_glyphs("Hello 123", fam) == [], (
        f"'{fam}' has no Latin of its own, but OCCT's Western fallback draws it — "
        "refusing this breaks documents that build today")
    font_coverage.check("Hello 123", fam)  # must not raise

    text = "\u0e17\u0e14\u0e2a\u0e2d\u0e1a v2"  # "ทดสอบ v2"
    faces = _raw_faces(text, font=fam)
    areas = sorted(round(f.area, 3) for f in faces)
    if len(faces) != 7 or len(set(areas)) != 7:
        print(SKIP, f"'{fam}' does not draw {text!r} as 7 distinct glyphs here: {areas}")
        return
    part, errs, _ = builder.rebuild(
        {"parameters": {}, "features": _sketch_and_extrude(text, font=fam)})
    assert not errs, f"the whole document was refused over its ASCII: {errs}"
    assert part is not None and part.volume > 0, "the document produced no geometry"
    print(PASS, f"'{fam}' has no Latin glyphs of its own, yet {text!r} builds "
                f"{len(faces)} distinct glyphs into {part.volume:.3f} mm3")


def test_genuine_tofu_is_still_refused_once_the_fallback_is_consulted():
    """The fix must not defang the guard.

    Consulting the Western fallback widens what counts as renderable, so the
    other half has to be pinned: a character that neither the chosen face NOR the
    fallback for its subset owns still draws a .notdef box and must still be
    refused. Each case measures the tofu FIRST — one face per character, all the
    same area, which is what .notdef means — and only then asserts the refusal,
    so a machine that really can draw the script skips instead of lying.

    Thai in a Latin family is the case that fires here: this computer's Western
    fallback IS that same Latin family, so the fallback adds nothing. CJK is
    included for a machine with no CJK font installed; where one is, OCCT's CJK
    fallback draws it and the guard must NOT refuse — which is what the Japanese
    watertight-solid test above asserts."""
    latin = font_coverage.resolved_family(None)
    checked = []
    for label, text in (("Thai", TOFU), ("CJK", "\u30c6\u30b9\u30c8")):
        faces = _raw_faces(text)
        areas = [round(f.area, 3) for f in faces]
        if len(faces) != len(text) or len(set(areas)) != 1:
            print(SKIP, f"{label} draws real glyphs in '{latin}' here: {sorted(set(areas))}")
            continue
        assert font_coverage.missing_glyphs(text) == list(text), (
            f"'{latin}' draws {len(faces)} identical {areas[0]} mm2 boxes for "
            f"{label}, but the guard reports {font_coverage.missing_glyphs(text)}")
        try:
            font_coverage.check(text, None)
            raise AssertionError(f"{label} tofu was waved through in '{latin}'")
        except errors.GeomError as ex:
            assert ex.code == errors.FONT_MISSING_GLYPHS, ex.code
        # ...and it never reaches geometry: the body is left exactly as it was.
        part, errs, _ = builder.rebuild(
            {"parameters": {}, "features": _box_and_text(text=text)})
        assert errs and errs[0].get("code") == errors.FONT_MISSING_GLYPHS, errs
        assert abs(part.volume - 60 * 30 * 5) < 1e-6, \
            f"refused {label} tofu still changed the body: {part.volume}"
        checked.append(f"{label} ({areas[0]} mm2 boxes)")
    if not checked:
        print(SKIP, "no script tofus on this computer; nothing left to keep refusing")
        return
    print(PASS, "genuine tofu is still refused: " + ", ".join(checked))


def test_the_suggested_font_actually_renders_the_string():
    """A suggestion nobody checks is decoration. Take the family the refusal
    names, build the same string with it, and require real geometry out."""
    if not font_coverage.missing_glyphs(TOFU):
        print(SKIP, "this computer's default font covers Thai")
        return
    message = font_coverage.coverage_message(TOFU)
    alt = font_coverage.suggest_family(TOFU)
    if alt is None:
        assert "No font installed" in message, message
        print(SKIP, "no installed font covers Thai; the message says so")
        return

    assert f"'{alt}'" in message, f"the message must name {alt}: {message}"
    assert not font_coverage.missing_glyphs(TOFU, alt), \
        f"{alt} was suggested but does not cover the string"
    part, errs, _ = builder.rebuild(
        {"parameters": {}, "features": _sketch_and_extrude(TOFU, font=alt)})
    assert not errs, errs
    areas = {round(f.area, 4) for f in _raw_faces(TOFU, font=alt)}
    assert len(areas) > 1, f"the suggested font produced identical shapes: {areas}"
    assert part.volume > 0, "the suggested font produced no solid"
    print(PASS, f"the suggested font '{alt}' really does render {TOFU!r}")


def test_a_font_with_no_outlines_is_refused_before_it_can_crash_the_kernel():
    """A colour bitmap font is not merely useless for geometry, it is FATAL.

    `Font_BRepFont::Init` returns false when it cannot open the face; build123d's
    `text_2d` ignores that return, and `Font_BRepTextBuilder::Perform` on the
    uninitialised font takes the process down. Verified by running
    `Text("Ab", font="Noto Color Emoji")` in a clean interpreter with build123d
    alone and NOTHING from this module: it dumps core. The family is offered by
    `list_fonts` like any other, so it is one click away in the font picker.

    Which is also why the crash itself is not re-run here — a test that segfaults
    takes the suite with it. What IS asserted is the guard: the same font now
    raises a named error, and it raises on the "no face" branch rather than
    falling through the coverage check, which has no opinion without a face.
    """
    aspect = font_coverage._aspect("regular")
    unusable = [f for f in sorted(font_coverage._available_families())
                if font_coverage._open_face(f, aspect)[0] is None]
    if not unusable:
        print(SKIP, "every installed family opens as an outline font")
        return
    name = unusable[0]
    assert not font_coverage.usable(name), name
    assert font_coverage.missing_glyphs("A", name) == [], \
        "missing_glyphs must stay agnostic when it has no face to interrogate"
    try:
        font_coverage.check("Ab", name)
        raise AssertionError(f"{name} was waved through to Font_BRepTextBuilder")
    except errors.GeomError as ex:
        assert ex.code == errors.FONT_UNUSABLE, ex.code
        assert name in str(ex), str(ex)
    # ...and it is never handed out as the cure for something else, which is what
    # "no opinion" read as "covers everything" would have done.
    assert not font_coverage.covers("A", name)
    assert font_coverage.suggest_family(TOFU) != name
    print(PASS, f"'{name}' has no outlines and is refused, not crashed into")


def test_invisible_characters_are_judged_on_what_the_kernel_draws():
    """"Invisible to a reader" is not "invisible to OCCT", and an earlier cut of
    the guard conflated them by skipping every Unicode category starting with C.

    Measured with `Text("A" + ch + "A")` in DejaVu Sans: the zero-width and
    format characters really do add no face — the font HAS them — while a
    private-use U+E000 and an unassigned U+0378 each add the same 14.201 mm2
    .notdef box Thai does. So the format characters must pass and those two must
    not; and since both are stripped from any message by `untrusted.clean`, the
    refusal has to name them by codepoint or say nothing at all.

    Written as escapes on purpose: every character under test is invisible in a
    source file, and a literal here would be unreviewable.
    """
    for cp in (0x200B, 0x200D, 0xFEFF, 0x2060):  # ZWSP, ZWJ, BOM, word joiner
        assert font_coverage.missing_glyphs("A" + chr(cp) + "B") == [], \
            f"U+{cp:04X} is present in the font and adds no geometry"
    for cp in (0xE000, 0x0378):  # private use, unassigned
        ch, text = chr(cp), "A" + chr(cp) + "B"
        if font_coverage.missing_glyphs(text) != [ch]:
            print(SKIP, f"this computer's default font has U+{cp:04X}")
            continue
        boxes = [f for f in _raw_faces(text) if round(f.area, 3) == 14.201]
        assert boxes, f"expected U+{cp:04X} to draw a .notdef box"
        msg = font_coverage.coverage_message(text)
        assert f"U+{cp:04X}" in untrusted.clean(msg), \
            f"a character the sanitiser strips must be named by codepoint: {msg}"
    print(PASS, "zero-width characters pass; private-use and unassigned ones are "
                "refused and named by codepoint")


def test_sketch_text_with_no_glyphs_no_longer_fails_green():
    """The silent path.

    `_text_faces` swallows every font failure into an empty list so one bad font
    cannot fail a whole rebuild. `textOnFace` checked for that; the SKETCH path
    did not — an unloadable font drew nothing and the sketch went green. What the
    user actually saw was the DOWNSTREAM extrude complaining "sketch has no
    closed profile", which blames the geometry and never mentions the font, on a
    sketch that looks fine. Simulated by making the underlying glyph builder come
    back empty, which is exactly what an unreadable font file does, since no font
    that behaves that way can be assumed present on any machine.

    The assertion is the pair: same document, misattributed BEFORE, named AFTER.
    Without the "before" half this only says an error happens.
    """
    doc = {"parameters": {}, "features": _sketch_and_extrude("Ab")}
    guarded = builder._text_faces
    original = guarded._unguarded

    builder._text_faces = lambda e, val, path_edge=None: []
    try:
        _part, before, _ = builder.rebuild(doc)
        assert [e["feature_id"] for e in before] == ["e"], \
            f"the sketch was supposed to pass silently: {before}"
        assert "font" not in before[0]["message"] and "glyph" not in before[0]["message"], \
            f"the old error already explained itself: {before[0]}"

        font_coverage.install()
        assert builder._text_faces is not guarded, "install() did not re-wrap"
        _part, after, _ = builder.rebuild(doc)
    finally:
        builder._text_faces = guarded

    sketch_errs = [e for e in after if e["feature_id"] == "s"]
    assert sketch_errs, f"text that produced no glyphs still failed green: {after}"
    assert sketch_errs[0].get("code") == errors.FONT_MISSING_GLYPHS, sketch_errs[0]
    assert "no glyphs" in sketch_errs[0]["message"], sketch_errs[0]
    assert original is not None
    print(PASS, "a sketch whose text produced no glyphs is red and names the font, "
                "instead of a green sketch and a puzzled extrude")


def test_blank_text_is_still_a_no_op_under_the_guard():
    """The guard must not turn the documented empty-text no-op into an error:
    a whitespace-only text entity contributes nothing and a sibling rectangle
    still builds. U+3000 is in there on purpose — it is the space every Japanese
    IME emits, no Latin face has a glyph for it, and reporting it missing would
    make the guard fire on ordinary CJK typing."""
    part, errs, _ = builder.rebuild({"parameters": {}, "features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [
            {"id": "t", "type": "text", "text": " 　\n ", "height": 10},
            {"id": "r", "type": "rectangle", "width": 5, "height": 5, "x": 0, "y": 0}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 2, "operation": "new"},
    ]})
    assert not errs, errs
    assert abs(part.volume - 50.0) < 1e-6, f"blank text was not a no-op: {part.volume}"
    assert font_coverage.missing_glyphs("A　B\n") == [], \
        "an ideographic space was reported as a missing glyph"
    print(PASS, "whitespace-only text (incl. the IME's U+3000) is still a no-op")


def test_the_typing_preview_refuses_what_the_solid_refuses():
    """`tessellate_text` feeds the 2D outline the user sees WHILE TYPING, and it
    goes through `_text_faces` precisely so the preview can never drift from the
    solid. If the guard missed it, the user would be shown clean outlines for a
    string the emboss then rejects."""
    if not font_coverage.missing_glyphs(TOFU):
        print(SKIP, "this computer's default font covers Thai")
        return
    try:
        builder.tessellate_text({"text": TOFU, "height": 10, "x": 0, "y": 0})
        raise AssertionError("the preview happily drew tofu outlines")
    except errors.GeomError as ex:
        assert ex.code == errors.FONT_MISSING_GLYPHS, ex.code
    # ...and a string it CAN draw still previews, so the guard is not blanket.
    res = builder.tessellate_text({"text": "o", "height": 10, "x": 0, "y": 0})
    assert len(res["faces"]) == 1 and len(res["faces"][0]["holes"]) == 1, res
    print(PASS, "the typing preview refuses the same string the solid refuses")


def test_the_message_names_the_substituted_font():
    """Ask for Arial on Linux and OCCT hands you DejaVu Sans without a word. A
    message that blames "Arial" for a glyph DejaVu is missing sends the user
    looking in the wrong place."""
    real = font_coverage.resolved_family("Arial")
    if real == "Arial":
        print(SKIP, "Arial is installed here; nothing is substituted")
        return
    if not font_coverage.missing_glyphs(TOFU, "Arial"):
        print(SKIP, "the substitute covers Thai")
        return
    msg = font_coverage.coverage_message(TOFU, "Arial")
    assert "'Arial'" in msg and f"'{real}'" in msg, msg
    print(PASS, f"the refusal discloses that 'Arial' is drawn with '{real}' here")


def test_install_is_idempotent():
    """`_worker_init` runs once per worker, but a re-entrant or retried init must
    not stack wrappers — each layer would re-run the check and, worse, the
    innermost `_unguarded` handle used by the tests above would stop being the
    real builder."""
    font_coverage.install()
    first = builder._text_faces
    font_coverage.install()
    assert builder._text_faces is first, "install() double-wrapped"
    assert not hasattr(first._unguarded, "_coverage_guarded"), "wrapper wrapped itself"
    print(PASS, "install() is idempotent")


def main():
    print("Font coverage / non-Latin text tests")
    font_coverage.install()
    test_the_tofu_is_real_and_the_guard_refuses_it()
    test_japanese_still_builds_a_valid_watertight_solid()
    test_plain_ascii_is_not_refused_by_a_font_that_lacks_latin()
    test_genuine_tofu_is_still_refused_once_the_fallback_is_consulted()
    test_the_suggested_font_actually_renders_the_string()
    test_a_font_with_no_outlines_is_refused_before_it_can_crash_the_kernel()
    test_invisible_characters_are_judged_on_what_the_kernel_draws()
    test_sketch_text_with_no_glyphs_no_longer_fails_green()
    test_blank_text_is_still_a_no_op_under_the_guard()
    test_the_typing_preview_refuses_what_the_solid_refuses()
    test_the_message_names_the_substituted_font()
    test_install_is_idempotent()
    print("ALL PASS")


if __name__ == "__main__":
    main()
