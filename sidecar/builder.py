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
    Solid,
    Compound,
    GeomType,
    extrude,
    fillet,
    chamfer,
    mirror,
    revolve,
    loft,
)

from geom_select import resolve_edges, resolve_faces

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
                entry = sketches[f["sketch"]]
                sk = entry["sketch"]
                if sk is None:
                    raise ValueError("sketch has no closed profile to extrude")
                # region points (one per selected area) pick + combine specific
                # profiles; a ring (annulus) keeps its hole, several areas union.
                pts = f.get("regions")
                if not pts and f.get("region"):
                    pts = [f["region"]]
                if pts:
                    sel = []
                    for p in pts:
                        rf = _region_face_at(entry["faces"], Vector(*p))
                        if rf is not None:
                            sel.append(rf)
                    if not sel:
                        raise ValueError("no profile found under the selected area")
                    target = sel[0]
                    for s in sel[1:]:
                        target = target + s
                else:
                    target = sk  # whole sketch
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

            elif t == "press-pull":
                if part is None:
                    raise ValueError("Press/Pull needs an existing body")
                faces = resolve_faces(part, f["face"])
                if not faces:
                    raise ValueError("no face found to press/pull")
                part = _press_pull(part, faces[0], val(f["distance"]))

            elif t == "mirror":
                part = part + mirror(part, about=PLANES[f["plane"]])

            elif t == "revolve":
                sk = sketches[f["sketch"]]["sketch"]
                part = revolve(
                    sk,
                    axis=AXES[f.get("axis", "Z")],
                    revolution_arc=val(f.get("angle", 360)),
                )

            elif t == "loft":
                part = loft([sketches[s]["sketch"] for s in f["sketches"]])

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


def _press_pull(part, face, d):
    """Push/pull a single solid face by signed distance `d` (mm).

    Both planar and cylindrical faces use OCCT's local surface offset: the picked
    face moves along its normal and the adjacent side walls stretch to follow (the
    "true" Press/Pull — +d grows the body / boss, -d shrinks it). We deliberately
    do NOT extrude-and-boolean: that creates coincident faces when the face has
    holes (e.g. the top of a holed plate) and OCCT's boolean spins forever on it.

    Offsets are clamped away from the degenerate point (collapsing a hole's radius
    or pushing a face clean through the body), which otherwise SEGFAULTs OCCT. The
    server's per-rebuild timeout is the final backstop for anything that slips by.

    Non-cylinder curved surfaces (cone/sphere/spline/…) are rejected: OCCT's local
    offset is too unreliable on them to risk taking down the sidecar.
    """
    if abs(d) < 1e-9:
        return part
    try:
        gt = face.geom_type
    except Exception:
        gt = None
    if gt == GeomType.PLANE:
        return _offset_face(part, face, _clamp_planar(part, face, d))
    if gt == GeomType.CYLINDER:
        return _offset_face(part, face, _clamp_cylinder(face, d))
    raise ValueError("Press/Pull supports flat and cylindrical faces only")


def _clamp_cylinder(face, d):
    """Cap |d| to 90% of the cylinder radius so an inward offset can't collapse the
    radius to ~0 (which segfaults OCCT)."""
    try:
        r = float(face.radius)
    except Exception:
        return d
    if r > 1e-6:
        limit = 0.9 * r
        d = max(-limit, min(limit, d))
    return d


def _clamp_planar(part, face, d):
    """For an inward push (−, toward the body), cap it to 90% of the body's extent
    along the face normal so the face can't be pushed clean through the solid."""
    if d >= 0:
        return d  # pulling outward is always safe
    try:
        n = face.normal_at()
        proj = [v.X * n.X + v.Y * n.Y + v.Z * n.Z for v in part.vertices()]
        thickness = max(proj) - min(proj)
    except Exception:
        return d
    if thickness > 1e-6:
        d = max(d, -0.9 * thickness)
    return d


def _offset_face(part, face, d):
    """Local single-face surface offset via OCCT (BRepOffset in Skin mode with a
    per-face offset, global offset 0). Returns a fixed-up Solid. Used for curved
    Press/Pull (e.g. resizing a cylindrical hole)."""
    import OCP.BRepOffset as _bro
    from OCP.GeomAbs import GeomAbs_JoinType
    from OCP.TopAbs import TopAbs_ShapeEnum
    from OCP.TopoDS import TopoDS
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid

    mk = _bro.BRepOffset_MakeOffset()
    # GeomAbs_Intersection join is what makes a local single-face offset close up
    # cleanly against the neighbouring faces (the Arc join fails here).
    mk.Initialize(
        part.wrapped,
        0.0,
        1e-4,
        _bro.BRepOffset_Mode.BRepOffset_Skin,
        False,
        False,
        GeomAbs_JoinType.GeomAbs_Intersection,
        False,
        False,
    )
    mk.SetOffsetOnFace(face.wrapped, d)
    mk.MakeOffsetShape()
    if not mk.IsDone():
        raise ValueError("can't offset this face by that amount")
    sh = mk.Shape()
    # the offset yields a Shell; wrap it back into a Solid so downstream booleans,
    # tessellation and export all see a uniform solid.
    if sh.ShapeType() == TopAbs_ShapeEnum.TopAbs_SHELL:
        sh = BRepBuilderAPI_MakeSolid(TopoDS.Shell_s(sh)).Solid()
    return Solid(sh)


def _build_sketch(f, val):
    """Build a 2D sketch and locate it onto its plane (algebra mode).

    Returns {"sketch": union, "faces": [located per-loop faces]}. The union is the
    whole profile (revolve/loft/whole-extrude); `faces` keeps each closed loop as
    its own located Face so region selection can recover nested profiles (a ring,
    an inner disk) that the union collapses.

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
        elif et == "point":
            continue  # a sketch point is reference/snap-only, never part of a profile

    if edges:
        faces.extend(_faces_from_edges(edges))

    if not faces:
        return {"sketch": None, "faces": []}  # open/reference-only sketch

    sk = faces[0]
    for fc in faces[1:]:
        sk = sk + fc
    sk = plane * sk  # locate the 2D sketch onto its plane

    # each loop, located onto the plane, as an individual Face for region picking
    located_faces = []
    for fc in faces:
        for face in (plane * fc).faces():
            located_faces.append(face)
    return {"sketch": sk, "faces": located_faces}


def _region_face_at(faces, P):
    """Pick the planar region containing point P and cut out its nested holes.

    `faces` are the located per-loop faces. The region's outer boundary is the
    smallest-area face that contains P; any face strictly inside that outer face is
    a hole (so concentric circles give a ring). Falls back to the nearest face by
    center when P isn't inside any face (robustness for tessellation drift)."""
    if not faces:
        return None
    containing = [fc for fc in faces if _face_contains(fc, P)]
    if not containing:
        return min(faces, key=lambda fc: (fc.center() - P).length)
    outer = min(containing, key=lambda fc: fc.area)
    region = outer
    for fc in faces:
        if fc is outer:
            continue
        if fc.area < outer.area and _face_contains(outer, fc.center()):
            region = region - fc
    return region


def _face_contains(face, p):
    try:
        return bool(face.is_inside(p))
    except Exception:
        return False


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
