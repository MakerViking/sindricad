"""Tests for font_guard.py. Run: uv run python test_font_guard.py

The bug being guarded is Windows-only in the wild (C:\\Windows\\Fonts holds font
files fontTools refuses), but the MECHANISM is portable: build123d scans a folder
at import time and one bad file aborts the whole import. So these tests build a
poisoned font folder in /tmp and prove, on this machine, that

  * build123d's own register_folder DOES raise on it (the field crash, reproduced),
  * with the guard installed it does NOT, and
  * a genuine font in the same folder still gets through.
"""

import glob as glob_module
import os
import tempfile

import font_guard  # noqa: F401  installs the guard and imports build123d

from build123d.text import FontManager

PASS = []
FAIL = []


def check(name, cond):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}")


# The two shapes that actually took the sidecar down in the field.
COLLECTION = b"ttcf\x00\x01\x00\x00" + b"\x00" * 32  # TTLibFileIsCollectionError
NOT_A_FONT = b"MZ\x90\x00" + b"\x00" * 32  # "bad sfntVersion" (a .fon is a DOS binary)


def _real_font():
    """Any genuine .ttf on this box, or None if the machine has no fonts."""
    for root in ("/usr/share/fonts", "/usr/local/share/fonts"):
        hits = glob_module.glob(os.path.join(root, "**", "*.ttf"), recursive=True)
        for path in hits:
            with open(path, "rb") as fh:
                if fh.read(4) == b"\x00\x01\x00\x00":
                    return path
    return None


def _poisoned_folder(tmp):
    """A folder shaped like C:\\Windows\\Fonts: two files build123d cannot open."""
    with open(os.path.join(tmp, "collection.ttf"), "wb") as fh:
        fh.write(COLLECTION)  # a collection wearing the wrong extension
    with open(os.path.join(tmp, "bitmap.ttf"), "wb") as fh:
        fh.write(NOT_A_FONT)
    with open(os.path.join(tmp, "collection.ttc"), "wb") as fh:
        fh.write(COLLECTION)  # correctly named: build123d routes this to TTCollection


def test_is_loadable():
    print("test_is_loadable")
    with tempfile.TemporaryDirectory() as tmp:
        _poisoned_folder(tmp)
        check(
            "a collection named .ttf is rejected",
            not font_guard._is_loadable(os.path.join(tmp, "collection.ttf")),
        )
        check(
            "a collection named .ttc is kept",
            font_guard._is_loadable(os.path.join(tmp, "collection.ttc")),
        )
        check(
            "a non-sfnt file is rejected",
            not font_guard._is_loadable(os.path.join(tmp, "bitmap.ttf")),
        )
        check(
            "a missing file is rejected, not raised on",
            not font_guard._is_loadable(os.path.join(tmp, "nope.ttf")),
        )
    real = _real_font()
    if real is None:
        check("SKIPPED: no system .ttf on this machine to test against", True)
    else:
        check(f"a real font is kept ({os.path.basename(real)})", font_guard._is_loadable(real))


def test_only_font_globs_are_touched():
    print("test_only_font_globs_are_touched")
    check("*.ttf pattern is filtered", font_guard._looks_like_a_font_scan("/x/*ttf"))
    check("*.otf pattern is filtered", font_guard._looks_like_a_font_scan("/x/*otf"))
    check("*.ttc pattern is filtered", font_guard._looks_like_a_font_scan("/x/*ttc"))
    check("an unrelated glob is left alone", not font_guard._looks_like_a_font_scan("/x/*.py"))
    check("a non-str pattern is left alone", not font_guard._looks_like_a_font_scan(b"/x/*ttf"))

    # and the wrapper must really pass other callers through untouched
    with tempfile.TemporaryDirectory() as tmp:
        open(os.path.join(tmp, "a.py"), "w").close()
        original = font_guard._install(drop_everything=False)
        try:
            got = glob_module.glob(os.path.join(tmp, "*.py"))
        finally:
            glob_module.glob = original
        check("non-font glob still returns its results", len(got) == 1)


def test_the_field_crash_and_its_fix():
    print("test_the_field_crash_and_its_fix")
    manager = FontManager()
    # Each poison ALONE, so both field failures are proven, not just whichever
    # one glob happened to return first.
    poisons = [
        ("collection.ttf", COLLECTION, "TTLibFileIsCollectionError"),  # report dd2c892f, 0.1.100
        ("bitmap.ttf", NOT_A_FONT, "TTLibError"),  # reports 2f888165 / 1af9a0ad / eab14e58
    ]
    for name, content, expected in poisons:
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, name), "wb") as fh:
                fh.write(content)

            # 1. reproduce: this is what happens to a Windows user today.
            raised = None
            try:
                manager.register_folder(tmp)
            except Exception as exc:  # noqa: BLE001 — the exception IS the assertion
                raised = exc
            check(
                f"{name} unguarded raises {expected} "
                f"(got {type(raised).__name__ if raised else 'NO exception'})",
                type(raised).__name__ == expected,
            )

            # 2. the fix: same folder, guard installed.
            original = font_guard._install(drop_everything=False)
            try:
                manager.register_folder(tmp)
                survived = True
            except Exception as exc:  # noqa: BLE001
                print(f"    guarded call still raised: {type(exc).__name__}: {exc}")
                survived = False
            finally:
                glob_module.glob = original
            check(f"{name} guarded does not raise", survived)


def test_a_real_font_survives_the_guard():
    print("test_a_real_font_survives_the_guard")
    real = _real_font()
    if real is None:
        check("SKIPPED: no system .ttf on this machine", True)
        return
    manager = FontManager()
    with tempfile.TemporaryDirectory() as tmp:
        _poisoned_folder(tmp)
        # a good font sitting in the same folder as the poison must still register
        with open(real, "rb") as src, open(os.path.join(tmp, "good.ttf"), "wb") as dst:
            dst.write(src.read())
        original = font_guard._install(drop_everything=False)
        try:
            names = manager.register_folder(tmp)
        finally:
            glob_module.glob = original
        check(f"the good font registered ({names})", len(names) > 0)


def test_build123d_actually_imported():
    print("test_build123d_actually_imported")
    import build123d

    check("build123d is importable through the guard", hasattr(build123d, "Box"))
    check("glob.glob was restored afterwards", glob_module.glob.__name__ == "glob")


def main():
    test_is_loadable()
    test_only_font_globs_are_touched()
    test_the_field_crash_and_its_fix()
    test_a_real_font_survives_the_guard()
    test_build123d_actually_imported()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        print("FAILURES:", ", ".join(FAIL))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
