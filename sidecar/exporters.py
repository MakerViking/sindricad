"""STEP / STL / 3MF export.

STEP and STL are build123d free functions. 3MF is NOT — it needs the Mesher
class (which also writes STL). Keep STL as a fallback if 3MF ever fails.
"""

import font_guard

font_guard.ensure()  # MUST precede build123d — see font_guard.py

from build123d import export_step, export_stl, Mesher


def export(part, fmt, path):
    """Write `part` to `path` in the given format. Returns the path."""
    if part is None:
        raise ValueError("nothing to export — the part is empty")

    fmt = fmt.lower()
    if fmt == "step":
        export_step(part, path)
    elif fmt == "stl":
        export_stl(part, path)
    elif fmt == "3mf":
        m = Mesher()
        m.add_shape(part)
        m.write(path)
    else:
        # Coded, like import_geometry's twin refusal: an unknown format string
        # is purely about the REQUEST, and a caller has to be able to tell it
        # from a real export failure without matching prose. _malformed cannot
        # catch it — the format is a legal str, just not one of ours.
        from errors import GeomError, BAD_REQUEST

        raise GeomError(f"unknown export format: {fmt}", BAD_REQUEST)
    return path
