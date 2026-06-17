"""STEP / STL / 3MF export.

STEP and STL are build123d free functions. 3MF is NOT — it needs the Mesher
class (which also writes STL). Keep STL as a fallback if 3MF ever fails.
"""

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
        raise ValueError(f"unknown export format: {fmt}")
    return path
