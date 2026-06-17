"""document -> build123d. The heart of the sidecar.

Re-runs the whole feature tree from scratch on every rebuild (no incremental
regeneration, no persistent state). build123d's algebra mode IS the parametric
engine.

API notes (verified against build123d 0.9/0.10.x):
  - extrude(sketch, amount=...)            free function, algebra mode
  - fillet(edges, radius=...)              radius kwarg
  - chamfer(edges, length=...)             length kwarg (NOT distance)
  - revolve(sketch, axis=..., revolution_arc=...)   degrees, default 360
  - mirror(obj, about=Plane)               about defaults to Plane.XZ
  - loft(sections)                         iterable of sketches/faces
  - Plane.XY * sketch  /  Pos(x,y,z) * shape   placement via * in algebra mode
"""

from build123d import (
    Rectangle,
    Circle,
    Pos,
    Plane,
    Axis,
    Vector,
    Edge,
    Wire,
    Face,
    Compound,
    extrude,
    fillet,
    chamfer,
    mirror,
    revolve,
    loft,
)

from geom_select import resolve_edges

PLANES = {"XY": Plane.XY, "XZ": Plane.XZ, "YZ": Plane.YZ}
AXES = {"X": Axis.X, "Y": Axis.Y, "Z": Axis.Z}


def _plane_of(spec):
    """A base plane id ("XY"/"XZ"/"YZ") or a derived plane descriptor
    {origin, normal, xdir} from a face / offset."""
    if isinstance(spec, str):
        return PLANES[spec]
    return Plane(
        origin=Vector(*spec["origin"]),
        x_dir=Vector(*spec["xdir"]),
        z_dir=Vector(*spec["normal"]),
    )


def rebuild(document):
    """Return (part, errors). part is a build123d solid/compound or None.

    errors is a list of {feature_id, message}; the first failing feature stops
    the build so the timeline can flag it red, Fusion-style.
    """
    params = document.get("parameters", {})

    def val(x):
        """Resolve a parameter name to its value, or pass a literal through."""
        if isinstance(x, str) and x in params:
            return params[x]
        return x

    sketches = {}
    part = None
    errors = []

    for f in document.get("features", []):
        try:
            t = f["type"]

            if t == "sketch":
                sketches[f["id"]] = _build_sketch(f, val)

            elif t == "extrude":
                sk = sketches[f["sketch"]]
                if sk is None:
                    raise ValueError("sketch has no closed profile to extrude")
                target = sk
                region = f.get("region")
                if region:  # extrude only the profile under this world point
                    p = Vector(*region)
                    target = min(sk.faces(), key=lambda fc: (fc.center() - p).length)
                solid = extrude(target, amount=val(f["distance"]))
                op = f.get("operation", "new")
                if part is None or op == "new":
                    part = solid
                elif op == "join":
                    part = part + solid
                elif op == "cut":
                    part = part - solid

            elif t == "fillet":
                edges = resolve_edges(part, f["edges"])
                part = fillet(edges, radius=val(f["radius"]))

            elif t == "chamfer":
                edges = resolve_edges(part, f["edges"])
                part = chamfer(edges, length=val(f["distance"]))

            elif t == "mirror":
                part = part + mirror(part, about=PLANES[f["plane"]])

            elif t == "revolve":
                sk = sketches[f["sketch"]]
                part = revolve(
                    sk,
                    axis=AXES[f.get("axis", "Z")],
                    revolution_arc=val(f.get("angle", 360)),
                )

            elif t == "loft":
                part = loft([sketches[s] for s in f["sketches"]])

            else:
                raise ValueError(f"unknown feature type: {t}")

        except Exception as ex:  # name the feature so the timeline can flag it
            errors.append({"feature_id": f.get("id"), "message": str(ex)})
            break

    # A disjoint join (e.g. two bodies that don't touch) yields a ShapeList, which
    # has no single `.wrapped` TopoDS shape. Normalize to one Compound so every
    # consumer (tessellate/bbox/edges/export) gets a uniform Shape.
    if part is not None and getattr(part, "wrapped", None) is None:
        part = Compound(list(part))

    return part, errors


def _build_sketch(f, val):
    """Build a 2D sketch and locate it onto its plane (algebra mode).

    Primitives (rectangle/circle) become faces directly. Free-form `line`
    segments are assembled into closed wires and turned into faces, so an
    interactively-drawn polyline profile can be extruded like in Fusion.
    """
    plane = _plane_of(f["plane"])
    faces = []
    edges = []  # free-form line + arc edges, assembled into faces below

    for e in f["entities"]:
        if e.get("construction"):
            continue  # construction geometry is reference-only, not a profile
        et = e["type"]
        if et == "rectangle":
            x, y = val(e.get("x", 0)), val(e.get("y", 0))
            faces.append(Pos(x, y) * Rectangle(val(e["width"]), val(e["height"])))
        elif et == "circle":
            x, y = val(e.get("x", 0)), val(e.get("y", 0))
            faces.append(Pos(x, y) * Circle(val(e["radius"])))
        elif et == "line":
            edges.append(
                Edge.make_line(
                    (val(e["x1"]), val(e["y1"]), 0),
                    (val(e["x2"]), val(e["y2"]), 0),
                )
            )
        elif et == "arc":
            edges.append(
                Edge.make_three_point_arc(
                    (val(e["x1"]), val(e["y1"]), 0),
                    (val(e["mx"]), val(e["my"]), 0),  # through-point
                    (val(e["x2"]), val(e["y2"]), 0),
                )
            )
        elif et == "spline":
            pts = [(val(p["x"]), val(p["y"]), 0) for p in e.get("points", [])]
            if len(pts) >= 2:
                edges.append(Edge.make_spline(pts))

    if edges:
        faces.extend(_faces_from_edges(edges))

    if not faces:
        return None  # open/reference-only sketch — valid, just not extrudable yet

    sk = faces[0]
    for fc in faces[1:]:
        sk = sk + fc
    return plane * sk  # locate the 2D sketch onto its plane


def _faces_from_edges(edges):
    """Assemble line/arc edges into faces from their closed loops."""
    if not edges:
        return []
    try:
        wires = Wire.combine(edges)
    except Exception:
        return []

    out = []
    for w in wires:
        closed = w.is_closed
        if callable(closed):
            closed = closed()
        if not closed:
            continue
        face = _face_from_wire(w)
        if face is not None:
            out.append(face)
    return out


def _face_from_wire(w):
    """Make a Face from a closed wire, across build123d API variants."""
    try:
        return Face(w)
    except Exception:
        pass
    try:
        return Face.make_from_wires(w)
    except Exception:
        return None
