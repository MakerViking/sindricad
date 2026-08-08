"""Make `import build123d` survive an unreadable system font.

WHY THIS EXISTS
---------------
build123d/text.py runs, at MODULE SCOPE:

    available_fonts = FontManager().available_fonts

so merely importing build123d walks the OS font directories and hands every
file it finds to fontTools' ``TTFont()``. ``FontManager.register_folder`` has no
per-file error handling, so ONE unreadable font aborts the whole import — and
with it the geometry sidecar, before any geometry runs.

That is not hypothetical. Four field reports across 0.1.82, 0.1.85 and 0.1.100,
all Windows, all "the geometry engine could not start on this computer", in two
flavours:

  * ``TTLibFileIsCollectionError: specify a font number between 0 and 3`` — a
    TrueType Collection whose extension is not ``.ttc``. build123d routes only
    the ``.ttc`` extension to ``TTCollection``, so a collection named ``.ttf``
    reaches ``TTFont()``, which refuses to guess a face.
  * ``TTLibError: Not a TrueType or OpenType font (bad sfntVersion)`` — a file
    caught by the ``*ttf``/``*otf`` glob that is not an sfnt font at all.

Linux and macOS escape it in practice because their font directories rarely
hold either kind of file. C:\\Windows\\Fonts holds both.

HOW IT WORKS
------------
``register_folder`` finds candidates with ``glob.glob(...)`` — an attribute
lookup at call time, on the stdlib module. So for the duration of the build123d
import, and only for patterns that are looking for fonts, ``glob.glob`` is
wrapped to drop files that fontTools would refuse. build123d then never sees
them, and nothing in build123d is patched.

Call `ensure()` before anything imports build123d. It is idempotent and cheap
after the first call (build123d is in sys.modules by then).

WHY A CALL AND NOT AN IMPORT SIDE EFFECT
----------------------------------------
The obvious shape — `import font_guard` at the top of every module that imports
build123d — was the first version, and it was wrong for a reason that has
nothing to do with fonts. `builder._env_sig` hashes the BYTES of builder.py,
geom_select.py, tessellate.py and selector_tuning.json into the mesh-cache key,
so adding even an import line to two of them changes the key and costs every
user a full cold rebuild of every document. On a large assembly that is minutes.
Guarding from server.py's `_worker_init` instead reaches every worker (it is the
pool initializer, so no geometry job can run without it) and leaves the four
signature files untouched.

The check is the first four bytes of each file, not a full parse: a real parse
of every system font would add seconds to every cold start. That covers both
observed failures but cannot prove a file with a valid signature will parse, so
a failed import is retried once with system-font scanning disabled entirely.
Losing font enumeration degrades sketch text; failing to import loses the app.
"""

import glob
import os
import sys

# sfnt signatures fontTools accepts from TTFont().
_SFNT_TAGS = (b"\x00\x01\x00\x00", b"true", b"OTTO", b"typ1")
# A TrueType Collection. Loadable ONLY via the .ttc extension — see module docstring.
_COLLECTION_TAG = b"ttcf"
# The extensions build123d's register_folder globs for.
_FONT_EXTS = ("ttf", "otf", "ttc")

_skipped: list[str] = []  # what we hid, for the log line


def _is_loadable(path: str) -> bool:
    """True if build123d can open `path` without raising.

    Mirrors build123d's own dispatch: the `.ttc` EXTENSION (not the content)
    selects TTCollection, everything else goes to TTFont.
    """
    try:
        with open(path, "rb") as fh:
            tag = fh.read(4)
    except OSError:
        return False  # unreadable is indistinguishable from unusable, and just as fatal
    if tag == _COLLECTION_TAG:
        return os.path.splitext(path)[1].lower() == ".ttc"
    return tag in _SFNT_TAGS


def _looks_like_a_font_scan(pathname) -> bool:
    """Only touch the globs register_folder issues; leave every other caller alone."""
    return isinstance(pathname, str) and pathname.lower().endswith(_FONT_EXTS)


def _install(drop_everything: bool):
    """Swap in the filtering glob. Returns the original for restoration."""
    original = glob.glob

    def filtered(pathname, *args, **kwargs):
        results = original(pathname, *args, **kwargs)
        if not _looks_like_a_font_scan(pathname):
            return results
        if drop_everything:
            _skipped.extend(results)
            return []
        keep = []
        for path in results:
            if _is_loadable(path):
                keep.append(path)
            else:
                _skipped.append(path)
        return keep

    glob.glob = filtered
    return original


def _purge_partial_import():
    """Drop half-initialised build123d modules so a retry starts clean."""
    for name in [n for n in sys.modules if n == "build123d" or n.startswith("build123d.")]:
        del sys.modules[name]


def _import_build123d(drop_everything: bool):
    original = _install(drop_everything)
    try:
        import build123d  # noqa: F401  (the point of the exercise)
    finally:
        glob.glob = original


_done = False


def ensure():
    """Import build123d with the font scan guarded. Idempotent."""
    global _done
    if _done:
        return
    _done = True  # set FIRST: a re-entrant call must not start a second import
    _skipped.clear()
    try:
        _import_build123d(drop_everything=False)
    except Exception as exc:  # noqa: BLE001 — the retry is the whole point; re-raised below
        # A font with a valid signature that still will not parse. Rather than
        # take the sidecar down, give up on system fonts altogether and say so.
        print(
            f"[fonts] a system font broke build123d's import ({type(exc).__name__}: {exc}); "
            "retrying with system font scanning disabled. Sketch text will fall back to "
            "build123d's bundled fonts.",
            file=sys.stderr,
            flush=True,
        )
        _purge_partial_import()
        _skipped.clear()
        _import_build123d(drop_everything=True)

    if _skipped:
        # Named, not counted: knowing WHICH file a machine chokes on is the whole
        # reason the last four reports took a round trip each to diagnose.
        shown = ", ".join(os.path.basename(p) for p in _skipped[:12])
        more = f" (+{len(_skipped) - 12} more)" if len(_skipped) > 12 else ""
        print(
            f"[fonts] skipped {len(_skipped)} unusable font file(s) so build123d could "
            f"import: {shown}{more}",
            file=sys.stderr,
            flush=True,
        )

