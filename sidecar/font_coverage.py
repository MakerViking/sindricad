"""Refuse to emboss .notdef boxes.

WHY THIS EXISTS
---------------
Text on a face is REAL GEOMETRY: it gets extruded, booleaned into the body and
printed. When the chosen font has no glyph for a character, FreeType hands OCCT
glyph 0 — .notdef — and `Font_BRepTextBuilder` turns that into an outline like
any other. The user gets a part covered in embossed rectangles, with a green
timeline chip and no message anywhere. Nothing in the pipeline looked at glyph
coverage before this module.

MEASURED, on this machine, with `Text("...", font="DejaVu Sans")` (glyph face
areas at font_size 10, one row per script):

    Latin  "AB"      -> 16.173, 20.360        real glyphs
    Hebrew "שלום"    -> 14.180,  9.409, ...   real glyphs (DejaVu covers Hebrew)
    Cyrillic "АБ"    -> 16.173, 18.560        real glyphs
    Japanese "テスト" -> 10.631,  4.407, ...   real glyphs, via OCCT's fallback
    Korean "안녕"     -> 7.321,  4.333, ...    real glyphs, via OCCT's fallback
    Thai   "ทดสอบ"   -> 14.201 x 5            TOFU
    Devanagari "नमस्ते" -> 14.201 x 6            TOFU
    U+E000 (PUA)     -> 14.201 x 2            TOFU
    Egyptian "𓂠"     -> 14.201                TOFU

14.201 mm2 is the .notdef box. Note the Japanese row: on a machine with a CJK
font installed the CJK case ALREADY works, and it works for every family —
those four areas are byte-identical to the ones "Noto Sans CJK JP" produces.
That is not build123d; it is OCCT's own per-glyph fallback inside `Font_FTFont`,
and it is why this module MUST model the fallback rather than just read the
chosen font's cmap: a naive cmap check would refuse "テスト in Arial", which
renders perfectly today, and break every existing document that uses it.

THE RULE OCCT ACTUALLY APPLIES
------------------------------
A character renders iff

  * the resolved primary face has it (`Font_FTFont::HasSymbol`), OR
  * the font registered as the fallback for `Font_FTFont::CharSubset` of that
    character has it.

Font_UnicodeSubset has exactly four values — Western, CJK, Korean, Arabic — and
EVERY ONE OF THEM, Western included, gets a fallback. An earlier cut of this
module asserted the opposite (that Western has no fallback) and skipped it.
MEASURED here: `Font_FontMgr::FindFallbackFont(Font_UnicodeSubset_Western,
Font_FA_Regular)` returns DejaVu Sans, and

    Text("ทดสอบ v2", font="Noto Sans Thai")
      -> 7 faces, areas 10.047 10.974 11.413 11.666 11.979 12.923 13.472

builds a solid of 7 DISTINCT real glyphs even though that face answers False to
`HasSymbol` for 'v', '2' and 'A'. Skipping the Western fallback therefore
reported the plain ASCII in that string as tofu; 476 of the 701 families
installed here lack 'v' and so falsely refused "Hello 123".

What the Thai row above really shows is narrower: this machine's Western
fallback IS DejaVu Sans, the same face the default already resolves to, so for
Thai the fallback adds nothing and the boxes are real. Anything neither the
primary face nor its subset's fallback owns — Thai in a Latin family,
Devanagari, private use, an unassigned codepoint — still tofus, and is still
refused.

So the check below asks OCCT the same two questions the renderer asks, with the
same objects. It is not a reimplementation of coverage; it is the renderer's own
predicate, read before the geometry is built instead of after it is printed.

WHY IT REFUSES INSTEAD OF SUBSTITUTING
--------------------------------------
The tempting fix is to silently swap in a font that does cover the string. It
was rejected:

  * An emboss is geometry. Silently changing which font drew it makes the SAME
    document produce a DIFFERENT solid on a different computer — a worse and
    much quieter failure than the one being fixed.
  * The document says font = X. Drawing in Y and still reporting X is a lie the
    user cannot see until the part is printed.
  * The refusal names a font that IS installed here and DOES cover the string,
    so the existing font picker is all the user needs. No new UI, no new
    persisted "effective font" field, no drift between the 2D typing preview and
    the extruded solid.

WHY A SEPARATE MODULE, PATCHED IN, RATHER THAN AN EDIT TO builder.py
--------------------------------------------------------------------
`builder._env_sig` hashes the BYTES of builder.py, geom_select.py,
tessellate.py and selector_tuning.json into the mesh-cache key. Adding so much
as an import line to builder.py costs EVERY existing user one full cold rebuild
(~20 s, OCCT-bound) of every document they open. `font_guard` already exists for
this exact reason and is installed the same way, from `server._worker_init`.

`_text_faces` is the single funnel every glyph in the app comes out of — the
sketch build, `textOnFace`, and the per-keystroke `tessellateText` preview all
call it, deliberately, so the outline you type can never drift from the solid
you print. Wrapping that one function therefore covers all three, and it is why
this is a wrapper and not three call-site edits.
"""

import unicodedata

import errors
import untrusted

# build123d's own `Text(font=...)` default. A document that never chose a font
# is rendered with this, so the check must resolve the same thing.
DEFAULT_FONT = "Arial"

# How many missing characters the message lists before it says "and N more".
# The whole message is capped at untrusted.MAX_MESSAGE downstream; this keeps the
# useful part first rather than letting a pasted paragraph fill the budget.
_MAX_LISTED = 8

# Families to offer first when the chosen font cannot render the string, in the
# order a user is most likely to recognise them. Only ever suggested when the
# family is actually installed AND actually covers the missing characters, so an
# entry that is wrong for a platform simply never fires. The general scan below
# catches everything not listed here.
_PREFERRED = (
    # Linux / bundled-Noto systems
    "Noto Sans CJK JP", "Noto Sans CJK SC", "Noto Sans CJK TC", "Noto Sans CJK KR",
    "Noto Sans", "Noto Serif", "Source Han Sans",
    # Windows
    "Yu Gothic", "Meiryo", "MS Gothic", "Microsoft YaHei", "SimSun",
    "Malgun Gothic", "Nirmala UI", "Leelawadee UI", "Arial Unicode MS",
    # macOS
    "Hiragino Sans", "PingFang SC", "Apple SD Gothic Neo", "Arial Unicode MS",
)

_faces = {}      # (family, aspect_value) -> Font_FTFont | None
_fallbacks = {}  # (subset_value, aspect_value) -> Font_FTFont | None
_resolved = {}   # (family, aspect_value) -> the family OCCT actually uses

# The family name is DOCUMENT text, so the face cache is keyed on something the
# user (or an imported file) controls. A real document uses a handful; this only
# stops a pathological one from pinning an FT face per distinct string. Dropped
# wholesale rather than LRU-evicted — refilling an entry costs 0.1 ms.
_MAX_CACHED_FACES = 256


def _occt():
    """The OCCT font symbols, imported lazily.

    Deliberately not at module scope: `server` imports this module in the
    worker initialiser, and OCP.Font is only meaningful once build123d has
    populated Font_FontMgr — see font_guard for why that import is fragile
    enough to be sequenced by hand.
    """
    from OCP.Font import (
        Font_FA_Bold, Font_FA_BoldItalic, Font_FA_Italic, Font_FA_Regular,
        Font_FontMgr, Font_FTFont, Font_FTFontParams, Font_UnicodeSubset,
    )
    from OCP.TCollection import TCollection_AsciiString

    aspects = {
        "regular": Font_FA_Regular, "bold": Font_FA_Bold,
        "italic": Font_FA_Italic, "bolditalic": Font_FA_BoldItalic,
    }
    return (Font_FontMgr, Font_FTFont, Font_FTFontParams, Font_UnicodeSubset,
            TCollection_AsciiString, aspects)


def _aspect(style):
    _, _, _, _, _, aspects = _occt()
    return aspects.get((style or "regular"), aspects["regular"])


def _open_face(family, aspect):
    """(face, family-OCCT-really-uses) for `family`, freshly opened, uncached.

    `face` is None when OCCT will not give an opinion — the family does not
    resolve, or FreeType refuses the file (colour bitmap fonts are the common
    case). The resolved name is still returned: it is what the message must
    quote, and it is known even when the face cannot be opened.
    """
    try:
        mgr_cls, ft_cls, params_cls, _subset, ascii_str, _asp = _occt()
        # Resolve through Font_FontMgr FIRST, the way build123d's text_2d does,
        # so the message can name what this computer really substitutes: ask for
        # Arial on Linux and you are handed DejaVu Sans without being told.
        found = mgr_cls.GetInstance_s().FindFont(ascii_str(family), aspect)
        real = found.FontName().ToCString() if found is not None else family
        ft = ft_cls()
        # Point size is irrelevant to coverage — HasSymbol is a cmap lookup on
        # the face — so any legal size will do.
        if ft.FindAndInit(ascii_str(real), aspect, params_cls(12, 72)):
            return ft, real
        return None, real
    except Exception:
        return None, family  # cannot tell -> must not refuse; see missing_glyphs


def _face(family, aspect):
    """`_open_face`, remembered. The hot path: every glyph build asks for this.

    Measured at ~0.1 ms to open and ~0.2 us per lookup, which is why nothing here
    needs a budget or a fast path. Cached anyway because an FT face holds the
    font file open, and the typing preview asks once per keystroke.
    """
    key = (family, int(aspect))
    if key in _faces:
        return _faces[key]
    # Evict BEFORE writing, never after: a clear placed below would drop the
    # `_resolved` entry this very call just produced, so the refusal message
    # would stop naming the substitution on exactly the call that found it.
    if len(_faces) >= _MAX_CACHED_FACES:
        _faces.clear()
        _resolved.clear()
    face, real = _open_face(family, aspect)
    _resolved[key] = real
    _faces[key] = face
    return face


def _fallback_face(subset, aspect):
    """The face OCCT falls back to for a Font_UnicodeSubset, or None.

    Cached including the None, because Font_FontMgr PRINTS to stderr each time a
    subset has no fallback ("unable to find Arabic fallback font!") and this runs
    on every keystroke of the typing preview.
    """
    key = (int(subset), int(aspect))
    if key in _fallbacks:
        return _fallbacks[key]
    face = None
    try:
        mgr_cls, ft_cls, params_cls, _sub, ascii_str, aspects = _occt()
        found = mgr_cls.GetInstance_s().FindFallbackFont(subset, aspect)
        if found is None:  # some aspects have no fallback face; regular usually does
            found = mgr_cls.GetInstance_s().FindFallbackFont(subset, aspects["regular"])
        if found is not None:
            ft = ft_cls()
            if ft.FindAndInit(ascii_str(found.FontName().ToCString()), aspect,
                              params_cls(12, 72)):
                face = ft
    except Exception:
        face = None
    _fallbacks[key] = face
    return face


def _drawable(ch):
    """False only for whitespace, which contributes no outline in any font.

    U+3000 is why this exists: the ideographic space every Japanese IME emits is
    absent from most Latin faces, and reporting it missing would fire the guard
    on ordinary CJK typing. `\\n` and `\\t` are the same story — `HasSymbol` is
    False for them in every font tested.

    Everything else stays in, INCLUDING the invisible categories, because
    invisible to a reader is not invisible to the kernel. Measured with
    `Text("A" + ch + "A")` in DejaVu Sans: the zero-width and format characters
    (U+200B, U+200D, U+FEFF, U+2060) are all present in the font and add no face,
    so `HasSymbol` already clears them — but a private-use U+E000 and an
    unassigned U+0378 each add a 14.201 mm2 .notdef box, exactly like Thai. An
    earlier cut of this function skipped every Unicode category starting with
    "C" and let both of those through.
    """
    return not ch.isspace()


def _label(ch):
    """How a missing character is written in the message.

    A character in a "C" category is either invisible or stripped outright by
    `untrusted.clean` on the way to the wire, so quoting it literally produces a
    message with a hole where the explanation should be. Those get `U+XXXX`.
    """
    if unicodedata.category(ch).startswith("C"):
        return f"U+{ord(ch):04X}"
    return ch


def resolved_family(family=None, style="regular"):
    """The family OCCT substitutes for `family` on this computer (may be itself)."""
    fam = family or DEFAULT_FONT
    aspect = _aspect(style)
    _face(fam, aspect)  # populates _resolved as a side effect
    return _resolved.get((fam, int(aspect)), fam)


def _missing_for_face(text, face, aspect):
    """The characters of `text` that `face` (plus OCCT's fallbacks) cannot draw.

    EVERY subset is consulted, Western included: see the module docstring for the
    measurement. Excluding Western here is what made a Thai family refuse the
    ASCII in "ทดสอบ v2" that it renders correctly.
    """
    _mgr, ft_cls, _params, _subset_cls, _ascii, _asp = _occt()

    missing, seen = [], set()
    for ch in text:
        if ch in seen or not _drawable(ch):
            continue
        seen.add(ch)
        try:
            if face.HasSymbol(ch):
                continue
            fallback = _fallback_face(ft_cls.CharSubset_s(ch), aspect)
            if fallback is not None and fallback.HasSymbol(ch):
                continue
        except Exception:
            continue  # OCCT would not answer for this character; do not guess
        missing.append(ch)
    return missing


def missing_glyphs(text, family=None, style="regular"):
    """The characters of `text` that would render as .notdef boxes, in order of
    first appearance and without duplicates.

    Conservative by construction: every branch that cannot establish an ANSWER
    treats the character as fine. A false positive here refuses a document that
    builds correctly today, which is strictly worse than the tofu this exists to
    stop; a false negative just leaves things as they are.
    """
    if not isinstance(text, str) or not text:
        return []
    aspect = _aspect(style)
    face = _face(family or DEFAULT_FONT, aspect)
    if face is None:
        return []  # no face to interrogate -> no opinion
    return _missing_for_face(text, face, aspect)


def covers(text, family, style="regular"):
    """True only when `family` opens here AND draws all of `text`.

    Opens the face WITHOUT caching it, because the only caller walks every
    installed family: holding all 701 of this machine's faces alive at once cost
    a measured 91 MB of RSS, for an answer that is used once.

    The "opens here" half is not a formality. "Noto Color Emoji" is a colour
    bitmap font: `Font_FTFont::FindAndInit` REFUSES it, so `missing_glyphs` has
    no face to interrogate and — correctly, for its own conservative contract —
    reports nothing missing. Read as coverage, that made it the recommended font
    for an Egyptian hieroglyph, which it cannot draw at all. "No opinion" and
    "yes" are the same value there and must not be the same answer here.
    """
    aspect = _aspect(style)
    face, _real = _open_face(family, aspect)
    if face is None:
        return False
    return not _missing_for_face(text, face, aspect)


def _available_families():
    """The families the font picker offers, as a set. Empty if OCCT will not say."""
    try:
        mgr_cls, _ft, _params, _sub, _ascii, _asp = _occt()
        from OCP.TColStd import TColStd_SequenceOfHAsciiString

        seq = TColStd_SequenceOfHAsciiString()
        mgr_cls.GetInstance_s().GetAvailableFontsNames(seq)
        return {seq.Value(i).ToCString() for i in range(1, seq.Length() + 1)}
    except Exception:
        return set()


def suggest_family(text, style="regular"):
    """An installed family that renders the WHOLE of `text`, or None.

    The predicate is deliberately "would picking this fix it", not "does this
    font own the missing glyphs" — the answer the user needs is a name they can
    choose in the picker, so the candidates come from the same
    `GetAvailableFontsNames` that feeds it and a suggestion is always
    selectable. Filtering on that set first also keeps `_PREFERRED` quiet: asking
    Font_FontMgr for a font that is not installed prints a substitution warning
    to stderr, and most of `_PREFERRED` is absent on any one platform.

    A full scan of the 701 families installed here costs 0.03 s, and only runs
    on the failure path.
    """
    names = _available_families()
    for family in _PREFERRED:
        if family in names and covers(text, family, style):
            return family
    # Shortest name first: "Noto Sans Thai" is the family a user means, and
    # "Noto Sans Thai Looped Medium" is a style variant of a different one.
    for family in sorted(names, key=lambda n: (len(n), n)):
        if covers(text, family, style):
            return family
    return None


def usable(family=None, style="regular"):
    """Can OCCT open this family as an OUTLINE font at all?

    False is not a nicety, it is a crash. `Font_BRepFont::Init` opens the face
    with `Font_FTFont::FindAndInit` and returns false when it cannot; build123d's
    `text_2d` does not check that return, and `Font_BRepTextBuilder::Perform` on
    the uninitialised font takes the whole process down. MEASURED: on this
    machine `Text("Ab", font="Noto Color Emoji")` SEGFAULTS — with or without
    this module, straight out of build123d — and that family is offered by
    `list_fonts` like any other, so a user can reach it from the font picker.

    One family of the 701 installed here fails, and it fails identically at
    point sizes 12, 16 and 72, so this is a property of the FILE (a colour
    bitmap font has no outlines) and not of the size Font_BRepFont happens to
    open it at.
    """
    return _face(family or DEFAULT_FONT, _aspect(style)) is not None


def _describe_font(family, style):
    """How to name the font in a message, disclosing any substitution.

    The family came out of the document, so it is capped and de-fanged like any
    other untrusted string before it is put in prose.
    """
    asked = untrusted.clean(family or DEFAULT_FONT, 60)
    real = untrusted.clean(resolved_family(family, style), 60)
    if real and real != asked:
        return f"'{asked}' (this computer draws it with '{real}')"
    return f"'{asked}'"


def coverage_message(text, family=None, style="regular"):
    """The refusal prose for `text`, or None when every character renders."""
    missing = missing_glyphs(text, family, style)
    if not missing:
        return None
    shown = [_label(ch) for ch in missing[:_MAX_LISTED]]
    more = len(missing) - _MAX_LISTED
    chars = " ".join(shown) + (f" and {more} more" if more > 0 else "")
    lead = (f"Text: the font {_describe_font(family, style)} has no glyph for "
            f"{chars} — those characters would be embossed as empty boxes.")
    alt = suggest_family(text, style)
    if alt:
        return lead + f" Pick a font that covers them, such as '{untrusted.clean(alt, 60)}'."
    return (lead + " No font installed on this computer covers them — install one "
            "(for example Noto Sans CJK for Japanese, Chinese or Korean) and restart.")


def check(text, family=None, style="regular"):
    """Raise before any geometry is built if `text` cannot be rendered.

    The unusable-font case is checked FIRST and separately: with no face to
    interrogate `missing_glyphs` has no opinion and would wave the string
    through — into the segfault documented on `usable`.
    """
    if not usable(family, style):
        raise errors.GeomError(
            f"Text: the font {_describe_font(family, style)} has no outlines to "
            "emboss — colour and bitmap fonts cannot be used for geometry. "
            "Pick a different font.",
            errors.FONT_UNUSABLE)
    message = coverage_message(text, family, style)
    if message:
        raise errors.GeomError(message, errors.FONT_MISSING_GLYPHS)


def install():
    """Wrap `builder._text_faces` so every glyph build is checked first.

    Idempotent. Returns True if the guard is in place afterwards.

    THREE things go on, and only the first is about coverage:

      1. `check` — the font cannot draw these characters (tofu), or cannot be
         opened as an outline font at all (a segfault; see `usable`).
      2. A backstop for the SILENT path. `_text_faces` is best-effort by design
         (one unreadable font must not fail a whole rebuild) and swallows EVERY
         exception into an empty list. `textOnFace` noticed and raised; the
         sketch path did not, so a text entity that produced nothing left a
         green timeline chip and a downstream extrude complaining about a
         profile. Non-blank text that yields no faces is now an error on both.
      3. Nothing at all for blank text: whitespace-only text is a documented
         no-op and stays one.
    """
    import builder

    original = builder._text_faces
    if getattr(original, "_coverage_guarded", False):
        return True

    def guarded(e, val, path_edge=None):
        text = e.get("text") if isinstance(e, dict) else None
        wanted = text.strip() if isinstance(text, str) else ""
        if wanted:
            check(text, e.get("font"), e.get("style", "regular"))
        faces = original(e, val, path_edge)
        if wanted and not faces:
            raise errors.GeomError(
                f"Text: the font {_describe_font(e.get('font'), e.get('style', 'regular'))} "
                "produced no glyphs for this text — it may be unreadable or damaged. "
                "Pick a different font.",
                errors.FONT_MISSING_GLYPHS)
        return faces

    guarded.__doc__ = original.__doc__
    guarded.__name__ = original.__name__
    guarded._coverage_guarded = True
    guarded._unguarded = original
    builder._text_faces = guarded
    return True
