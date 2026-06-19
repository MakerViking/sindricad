"""Selector resolution — the topological-naming mitigation.

Geometry is NEVER referenced by index. References are queryable property
descriptors, re-resolved against the freshly built solid on every rebuild.

Edge selectors:
  {"kind":"edge", "by":"axis",    "axis":"Z"}          edges parallel to Z
  {"kind":"edge", "by":"all"}                          every edge
  {"kind":"edge", "by":"nearest", "point":[x,y,z]}     edge nearest a 3D point

Face selectors:
  {"kind":"face", "by":"normal",  "dir":[0,0,1]}       faces whose normal ~ dir
  {"kind":"face", "by":"nearest", "point":[x,y,z]}     face nearest a 3D point
"""

from build123d import Axis, Vector

AXES = {"X": Axis.X, "Y": Axis.Y, "Z": Axis.Z}


def resolve_edges(part, sel):
    """Resolve an edge selector — or a LIST of selectors — to build123d edges."""
    if part is None:
        raise ValueError("no part to select edges from")
    # a list of selectors (multi-edge fillet/chamfer): union, de-duplicated
    if isinstance(sel, list):
        seen = {}
        for s in sel:
            for e in resolve_edges(part, s):
                c = e.center()
                key = (round(c.X, 4), round(c.Y, 4), round(c.Z, 4))
                seen.setdefault(key, e)
        return list(seen.values())
    by = sel["by"]
    if by == "axis":
        return part.edges().filter_by(AXES[sel["axis"]])
    if by == "all":
        return part.edges()
    if by == "nearest":
        p = Vector(*sel["point"])
        return [min(part.edges(), key=lambda e: (e.center() - p).length)]
    raise ValueError(f"unknown edge selector: {by}")


def resolve_faces(part, sel):
    """Resolve a face selector to a list/ShapeList of build123d faces."""
    if part is None:
        raise ValueError("no part to select faces from")
    by = sel["by"]
    if by == "normal":
        d = Vector(*sel["dir"]).normalized()
        return part.faces().filter_by(
            lambda f: f.normal_at().normalized().dot(d) > 0.99
        )
    if by == "nearest":
        p = Vector(*sel["point"])
        # distance to the face SURFACE, not its center: a cylinder's center sits
        # on its axis (far from the clicked wall), so center-distance mis-picks
        # curved faces. Fall back to center-distance if distance_to is unavailable.
        try:
            return [min(part.faces(), key=lambda f: f.distance_to(p))]
        except Exception:
            return [min(part.faces(), key=lambda f: (f.center() - p).length)]
    if by == "all":
        return part.faces()
    raise ValueError(f"unknown face selector: {by}")
