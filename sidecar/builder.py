"""document -> build123d. The heart of the sidecar.

Re-runs the whole feature tree from scratch on every rebuild (no incremental
regeneration, no persistent state). build123d's algebra mode IS the parametric
engine.

The model is **multi-body**: the rebuild keeps an ordered list of named bodies
with an "active" body (the last one created/edited). Most features operate on the
active body — so a document with no body-splitting ops behaves exactly like the
old single-body code. Import adds a body; Split can produce two; Combine fuses
bodies together. The merged shape (a Compound of all bodies) is what gets
tessellated, measured and exported, so every downstream consumer stays uniform.

API notes (verified against build123d 0.10.x):
  - extrude(sketch, amount=...)            free function, algebra mode
  - fillet(edges, radius=...)              radius kwarg
  - chamfer(edges, length=...)             length kwarg (NOT distance)
  - revolve(sketch, axis=..., revolution_arc=...)   degrees, default 360
  - mirror(obj, about=Plane)               about defaults to Plane.XZ
  - loft(sections)                         iterable of sketches/faces
  - split(obj, bisect_by=Plane, keep=Keep.TOP|BOTTOM|BOTH)   cut by a plane
  - Mesher().read(path) -> [Shape]         STL/3MF/OBJ -> watertight solid(s)
  - import_step(path) / import_brep(path)  native B-rep read
  - export_brep(shape, BytesIO)            serialize a body for embedding
  - a + b / a - b / a & b                  union / cut / intersect (algebra mode)
  - Plane.XY * sketch  /  Pos(x,y,z) * shape   placement via * in algebra mode
"""

import base64
import io
import math
import os
import tempfile

from build123d import (
    Rectangle,
    Circle,
    Box,
    Cylinder,
    Sphere,
    Pos,
    Rot,
    Plane,
    Axis,
    Vector,
    Edge,
    Wire,
    Face,
    Shell,
    Solid,
    Compound,
    Shape,
    GeomType,
    Keep,
    Kind,
    extrude,
    fillet,
    chamfer,
    mirror,
    revolve,
    loft,
    sweep,
    offset,
    scale,
    split,
    import_step,
    import_brep,
    export_brep,
    Mesher,
)

from geom_select import resolve_edges, resolve_faces

PLANES = {"XY": Plane.XY, "XZ": Plane.XZ, "YZ": Plane.YZ}
AXES = {"X": Axis.X, "Y": Axis.Y, "Z": Axis.Z}
KEEP = {"top": Keep.TOP, "bottom": Keep.BOTTOM, "both": Keep.BOTH}


def _plane_of(spec, datums=None):
    """Resolve a plane reference to a build123d Plane.

    `spec` is one of: a base plane id ("XY"/"XZ"/"YZ"); a datum-plane feature id
    (registered in `datums` by a `datumPlane` feature); or a derived plane
    descriptor {origin, normal, xdir} from a face / offset / construction tool."""
    if isinstance(spec, str):
        if datums and spec in datums:
            return _plane_of(datums[spec], datums)
        if spec in PLANES:
            return PLANES[spec]
        raise ValueError(f"unknown plane reference: {spec}")
    return Plane(
        origin=Vector(*spec["origin"]),
        x_dir=Vector(*spec["xdir"]),
        z_dir=Vector(*spec["normal"]),
    )


# --- mesh / B-rep import -----------------------------------------------------


def _shape_to_brep_b64(shape):
    """Serialize a body to a base64 BREP string for embedding in the document.

    External geometry can't be regenerated from parameters, but the rebuild model
    is "send the whole document, rebuild from scratch". So we sew/read the file
    ONCE on import and stash the resulting solid as a self-contained BREP string;
    every rebuild just deserializes it (no dependency on the original file)."""
    buf = io.BytesIO()
    export_brep(shape, buf)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _brep_b64_to_shape(b64):
    """Inverse of _shape_to_brep_b64. import_brep needs a real path, so we round
    the bytes through a temp file."""
    data = base64.b64decode(b64)
    fd, path = tempfile.mkstemp(suffix=".brep")
    os.close(fd)
    try:
        with open(path, "wb") as fh:
            fh.write(data)
        return import_brep(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _maybe_unify(shape):
    """Best-effort merge of coplanar facets into single faces (OCCT
    UnifySameDomain). A freshly-read STL has one B-rep face per triangle; merging
    the coplanar ones recovers real planar faces (a CAD-exported box becomes 6
    selectable faces, not 12 triangles) — so the import is genuinely editable
    (press/pull, fillet, select). Curved regions (a faceted hole) stay faceted;
    recovering smooth surfaces from those is RANSAC fitting, a separate step.
    Falls back to the original shape if the upgrade yields nothing usable."""
    try:
        from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain

        up = ShapeUpgrade_UnifySameDomain(shape.wrapped, True, True, True)
        up.Build()
        merged = _wrap_topods(up.Shape())
        if merged is not None and len(merged.faces()) > 0:
            return merged
    except Exception:
        pass
    return shape


def _wrap_topods(topods):
    """Wrap a raw TopoDS_Shape in the right build123d class. build123d's
    Shape.cast() returns None for some OCCT-produced solids (e.g. the output of
    UnifySameDomain), so dispatch on the concrete shape type ourselves."""
    if topods is None or topods.IsNull():
        return None
    from OCP.TopAbs import TopAbs_ShapeEnum

    t = topods.ShapeType()
    if t == TopAbs_ShapeEnum.TopAbs_SOLID:
        return Solid(topods)
    if t in (TopAbs_ShapeEnum.TopAbs_COMPOUND, TopAbs_ShapeEnum.TopAbs_COMPSOLID):
        return Compound(topods)
    if t == TopAbs_ShapeEnum.TopAbs_SHELL:
        return Shell(topods)
    if t == TopAbs_ShapeEnum.TopAbs_FACE:
        return Face(topods)
    return Shape.cast(topods)


# Import guards. SindriCAD imports CLEAN / prismatic models as editable B-rep
# bodies (one B-rep face per mesh triangle). That's great for CAD-exported meshes
# but explodes on dense organic/scanned models — so we refuse those up front with
# a clear message rather than letting OCCT grind into the job timeout.
MAX_IMPORT_TRIANGLES = 150_000  # reject before the slow read (avoids the timeout)
MAX_IMPORT_FACES = 2_000        # after merge: more faces than this = organic/curved,
                                # not a clean editable model (a prismatic CAD part —
                                # even with fillets — merges to far fewer faces).


def _peek_triangle_count(path, fmt):
    """Best-effort triangle count straight from the file, WITHOUT building a B-rep,
    so a too-dense import fails fast. Returns None when it can't tell."""
    try:
        if fmt == "stl":
            with open(path, "rb") as fh:
                head = fh.read(84)
            if head[:5].lower() == b"solid":
                blob = open(path, "rb").read()
                if b"facet normal" in blob:  # genuine ASCII STL
                    return blob.count(b"facet normal")
            import struct  # binary STL: uint32 triangle count at byte 80
            return struct.unpack("<I", head[80:84])[0]
        if fmt == "3mf":
            import zipfile
            with zipfile.ZipFile(path) as z:
                model = next((n for n in z.namelist() if n.lower().endswith(".model")), None)
                return z.read(model).count(b"<triangle") if model else None
        if fmt == "obj":
            with open(path, "rb") as fh:
                return sum(1 for ln in fh if ln.startswith(b"f "))
    except Exception:
        return None
    return None


def _explode_solids(shape):
    """Split an imported shape into individually-controllable bodies. A multi-object
    STL comes back as ONE solid with several disconnected shells (Mesher fuses
    objects); a multi-object 3MF comes back as several solids. So `.solids()` alone
    isn't enough — for each solid with >1 shell, wrap each shell in its own solid.
    A non-solid (open shell / surface) is passed through as one body."""
    solids = shape.solids()
    if not solids:
        return [shape]
    out = []
    for sd in solids:
        shells = sd.shells()
        if len(shells) <= 1:
            out.append(sd)
            continue
        from OCP.BRep import BRep_Builder
        from OCP.TopoDS import TopoDS_Solid

        for sh in shells:
            mk = TopoDS_Solid()
            bld = BRep_Builder()
            bld.MakeSolid(mk)
            bld.Add(mk, sh.wrapped)
            out.append(_maybe_unify(_wrap_topods(mk)))
    return out


def import_geometry(path, fmt):
    """Read an external geometry file and return the document payload for an
    `import` feature: {brep, solid, faces, name}. STL/3MF/OBJ are read as a
    (watertight) mesh solid; STEP/BREP come in as native B-rep."""
    fmt = (fmt or "").lower()
    if fmt in ("step", "stp"):
        shape = import_step(path)
    elif fmt == "brep":
        shape = import_brep(path)
    elif fmt in ("stl", "3mf", "obj"):
        ntri = _peek_triangle_count(path, fmt)
        if ntri and ntri > MAX_IMPORT_TRIANGLES:
            raise ValueError(
                f"This mesh has ~{ntri:,} triangles — too dense to import as an editable "
                f"model (limit ~{MAX_IMPORT_TRIANGLES:,}). It's almost certainly an organic/"
                f"scanned model; reduce it first, or import a STEP / clean CAD mesh."
            )
        shapes = Mesher().read(path)
        if not shapes:
            raise ValueError("no geometry found in the mesh file")
        shape = shapes[0] if len(shapes) == 1 else Compound(list(shapes))
        shape = _maybe_unify(shape)
        nf = len(shape.faces())
        if nf > MAX_IMPORT_FACES:
            raise ValueError(
                f"This mesh didn't reduce to a clean editable model ({nf:,} faces — a "
                f"curved/organic surface stays faceted). SindriCAD edits prismatic CAD "
                f"models; import a STEP or a flat-faced part."
            )
    else:
        raise ValueError(f"unsupported import format: {fmt}")

    is_solid = len(shape.solids()) > 0
    name = os.path.splitext(os.path.basename(path))[0] or "Imported"
    return {
        "brep": _shape_to_brep_b64(shape),
        "solid": is_solid,
        "faces": len(shape.faces()),
        "name": name,
    }


# --- rebuild -----------------------------------------------------------------


def rebuild(document, diagnostics=None):
    """Return (part, errors, bodies).

    part    : the merged build123d solid/compound of all bodies, or None.
    errors  : list of {feature_id, message}; the first failing feature stops the
              build so the timeline can flag it red, Fusion-style.
    bodies  : ordered list of {id, name, shape} — one per live body (for per-body
              tessellation and the browser tree).

    diagnostics : optional list; when given, low-confidence selector-v2 (`by:"match"`)
              resolutions append a ResolveDiag dict to it. Resolution is best-effort
              and never fails the build on a shaky match, so callers that don't pass a
              list are completely unaffected.
    """
    params = document.get("parameters", {})
    # Bodies the user has hidden — excluded from extrude booleans (never edit a
    # hidden body). Ids are positional (regenerated each rebuild) but deterministic,
    # so they line up with the frontend's visibility map for this same document.
    hidden_bodies = frozenset(
        bid for bid, vis in (document.get("bodyVisibility") or {}).items() if not vis
    )

    def val(x):
        """Resolve a parameter name to its value, or pass a literal through."""
        if isinstance(x, str) and x in params:
            return params[x]
        return x

    sketches = {}
    datums = {}  # datumPlane feature id -> PlaneSpec (resolved lazily by _plane_of)
    bodies = []  # ordered [{id, name, shape}]
    counter = {"n": 0}
    errors = []

    def new_body(shape, name=None):
        counter["n"] += 1
        bodies.append(
            {"id": f"body{counter['n']}", "name": name or f"Body{counter['n']}", "shape": shape}
        )
        return bodies[-1]

    def active():
        return bodies[-1] if bodies else None

    def require_active(label):
        """The active body, or a clear error — for features that modify an
        existing body (fillet, shell, pattern, …) rather than create one."""
        if not bodies:
            raise ValueError(f"{label} needs an existing body")
        return bodies[-1]

    def find_body(bid):
        for b in bodies:
            if b["id"] == bid:
                return b
        return None

    for f in document.get("features", []):
        try:
            t = f["type"]

            if t == "sketch":
                sketches[f["id"]] = _build_sketch(f, val, datums)

            elif t == "datumPlane":
                # No geometry — register the (optionally offset) plane so sketches
                # / splits can reference it by id. Validate it resolves here so a
                # bad datum flags at its own feature. `offset` shifts the source
                # plane along its normal; we store the resolved offset plane.
                base = _plane_of(f["plane"], datums)
                off = f.get("offset") or 0
                origin = base.origin + base.z_dir * off
                datums[f["id"]] = {
                    "origin": [origin.X, origin.Y, origin.Z],
                    "xdir": [base.x_dir.X, base.x_dir.Y, base.x_dir.Z],
                    "normal": [base.z_dir.X, base.z_dir.Y, base.z_dir.Z],
                }

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
                    # precompute cell bboxes ONCE (region picking is per-point)
                    cells = [(fc, fc.bounding_box()) for fc in entry["faces"]]
                    sel = []
                    for p in pts:
                        rf = _region_face_at(cells, Vector(*p))
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
                _boolean_into_bodies(bodies, solid, f.get("operation", "new"), new_body, hidden_bodies)

            elif t == "fillet":
                act = require_active("Fillet")
                edges = resolve_edges(act["shape"], f["edges"], diag=diagnostics, feature_id=f.get("id"))
                act["shape"] = fillet(edges, radius=val(f["radius"]))

            elif t == "chamfer":
                act = require_active("Chamfer")
                edges = resolve_edges(act["shape"], f["edges"], diag=diagnostics, feature_id=f.get("id"))
                act["shape"] = chamfer(edges, length=val(f["distance"]))

            elif t == "press-pull":
                # target the body that OWNS the picked face (sent by the tool),
                # not just the active body — so press/pull on a multi-body model
                # modifies the right body.
                act = find_body(f["body"]) if f.get("body") else require_active("Press/Pull")
                if act is None:
                    raise ValueError("Press/Pull: the target body no longer exists")
                # one or many faces, each pushed by the same distance along its own
                # normal. Re-resolve every selector against the EVOLVING shape — each
                # push renumbers topology, and the selectors are geometric, so this
                # stays correct (the tool emits one by:"nearest" selector per face).
                sels = f["face"] if isinstance(f["face"], list) else [f["face"]]
                # `upTo`: extrude each face UP TO a target surface instead of by a
                # fixed distance. Capture the target plane once (point + normal) so
                # every source face extrudes to the same surface.
                up = f.get("upTo")
                tgt_pt = tgt_n = None
                if up:
                    tf = resolve_faces(act["shape"], up, diag=diagnostics, feature_id=f.get("id"))
                    if not tf:
                        raise ValueError("Press/Pull: the 'up to' target surface wasn't found")
                    tgt_pt, tgt_n = tf[0].center(), tf[0].normal_at()
                dist = val(f["distance"])
                for sel in sels:
                    found = resolve_faces(act["shape"], sel, diag=diagnostics, feature_id=f.get("id"))
                    if not found:
                        raise ValueError("no face found to press/pull")
                    src = found[0]
                    d = _distance_to_target(src, tgt_pt, tgt_n) if up else dist
                    act["shape"] = _press_pull(act["shape"], src, d)

            elif t == "mirror":
                act = require_active("Mirror")
                act["shape"] = act["shape"] + mirror(act["shape"], about=_plane_of(f["plane"], datums))

            elif t == "revolve":
                sk = sketches[f["sketch"]]["sketch"]
                solid = revolve(
                    sk,
                    axis=AXES[f.get("axis", "Z")],
                    revolution_arc=val(f.get("angle", 360)),
                )
                act = active()
                if act is None:
                    new_body(solid)
                else:
                    act["shape"] = solid

            elif t == "loft":
                solid = loft([sketches[s]["sketch"] for s in f["sketches"]])
                act = active()
                if act is None:
                    new_body(solid)
                else:
                    act["shape"] = solid

            elif t == "sweep":
                prof = sketches[f["profile"]]["sketch"]
                if prof is None:
                    raise ValueError("sweep profile has no closed section")
                path = sketches[f["path"]].get("wire")
                if path is None:
                    raise ValueError("sweep path sketch has no curve to follow")
                solid = sweep(sections=prof, path=path)
                op = f.get("operation", "new")
                act = active()
                if act is None or op == "new":
                    new_body(solid)
                elif op == "join":
                    act["shape"] = act["shape"] + solid
                elif op == "cut":
                    act["shape"] = act["shape"] - solid

            elif t == "import":
                base = f.get("name") or "Imported"
                parts = _explode_solids(_brep_b64_to_shape(f["brep"]))
                if len(parts) == 1:
                    new_body(parts[0], base)
                else:
                    for i, p in enumerate(parts, 1):
                        new_body(p, f"{base} {i}")

            elif t == "box":
                new_body(Box(val(f["length"]), val(f["width"]), val(f["height"])), "Box")

            elif t == "cylinder":
                new_body(Cylinder(val(f["radius"]), val(f["height"])), "Cylinder")

            elif t == "sphere":
                new_body(Sphere(val(f["radius"])), "Sphere")

            elif t == "shell":
                act = require_active("Shell")
                openings = resolve_faces(act["shape"], f["faces"], diag=diagnostics, feature_id=f.get("id")) if f.get("faces") else []
                act["shape"] = _shell(act["shape"], val(f["thickness"]), openings)

            elif t == "draft":
                act = require_active("Draft")
                faces = resolve_faces(act["shape"], f["faces"], diag=diagnostics, feature_id=f.get("id"))
                if not faces:
                    raise ValueError("no face found to draft")
                act["shape"] = _draft(act["shape"], faces, val(f["angle"]), f.get("axis", "Z"))

            elif t == "patternRect":
                act = require_active("Pattern")
                act["shape"] = _pattern_rect(
                    act["shape"], val(f["countX"]), val(f["countY"]), val(f["spacingX"]), val(f["spacingY"])
                )

            elif t == "patternCircular":
                act = require_active("Pattern")
                act["shape"] = _pattern_circular(
                    act["shape"], val(f["count"]), val(f.get("angle", 360)), f.get("axis", "Z")
                )

            elif t == "simplifyMesh":
                act = require_active("Simplify Mesh")
                act["shape"] = _simplify_mesh(act["shape"], val(f.get("tolerance", 1)))

            elif t == "scale":
                act = require_active("Scale")
                act["shape"] = scale(act["shape"], by=val(f.get("factor", 1)))

            elif t == "move":
                rx, ry, rz = val(f.get("rx", 0)), val(f.get("ry", 0)), val(f.get("rz", 0))
                dx, dy, dz = val(f.get("dx", 0)), val(f.get("dy", 0)), val(f.get("dz", 0))
                ids = f.get("bodies")
                targets = [find_body(b) for b in ids] if ids else [require_active("Move")]
                for tgt in targets:
                    if tgt is None:
                        continue
                    sh = tgt["shape"]
                    # A disjoint body is a build123d ShapeList (no single `.wrapped`);
                    # Rot/Pos (Location.__mul__) only accept ONE Shape, so normalize to
                    # a Compound first — else "other must be a list of Locations".
                    if sh is not None and getattr(sh, "wrapped", None) is None:
                        sh = Compound(list(sh))
                    if rx or ry or rz:
                        sh = Rot(rx, ry, rz) * sh
                    if dx or dy or dz:
                        sh = Pos(dx, dy, dz) * sh
                    tgt["shape"] = sh

            elif t == "split":
                _do_split(f, bodies, find_body, active, new_body, datums)

            elif t == "combine":
                _do_combine(f, bodies, find_body, diag=diagnostics)

            elif t == "removeBody":
                # delete bodies by id (Fusion "Remove"); drop them from the list so
                # they're not tessellated/exported. Unknown ids are silently ignored.
                ids = set(f.get("bodies") or [])
                bodies[:] = [b for b in bodies if b["id"] not in ids]

            else:
                raise ValueError(f"unknown feature type: {t}")

        except Exception as ex:  # name the feature so the timeline can flag it
            errors.append({"feature_id": f.get("id"), "message": str(ex)})
            break

    # A disjoint join (e.g. two bodies that don't touch) yields a ShapeList, which
    # has no single `.wrapped` TopoDS shape. Normalize each body to one Compound so
    # every consumer (tessellate/bbox/edges/export) gets a uniform Shape.
    out_bodies = []
    for b in bodies:
        sh = b["shape"]
        if sh is not None and getattr(sh, "wrapped", None) is None:
            sh = Compound(list(sh))
        out_bodies.append({"id": b["id"], "name": b["name"], "shape": sh})

    shapes = [b["shape"] for b in out_bodies if b["shape"] is not None]
    if not shapes:
        part = None
    elif len(shapes) == 1:
        part = shapes[0]
    else:
        part = Compound(shapes)

    return part, errors, out_bodies


def _as_compound(s):
    """Normalize a possibly-disjoint shape (a build123d ShapeList, e.g. a body split
    into pieces, or an extrude of several disjoint region faces) to a single
    Compound so .bounding_box() and boolean ops work. Single shapes pass through."""
    return s if getattr(s, "wrapped", None) is not None else Compound(list(s))


def _bbox_overlap(a, b, tol=1e-6):
    """Cheap AABB overlap test (no boolean, can't crash)."""
    ba, bb = _as_compound(a).bounding_box(), _as_compound(b).bounding_box()
    return (
        ba.min.X <= bb.max.X + tol and ba.max.X >= bb.min.X - tol
        and ba.min.Y <= bb.max.Y + tol and ba.max.Y >= bb.min.Y - tol
        and ba.min.Z <= bb.max.Z + tol and ba.max.Z >= bb.min.Z - tol
    )


def _boolean_into_bodies(bodies, solid, op, new_body, hidden=frozenset()):
    """Fusion-style extrude operation: New Body adds a separate body; Join / Cut /
    Intersect boolean the new solid against EVERY VISIBLE body it overlaps — so an
    extrude that bridges two bodies merges both. Join with nothing to act on just
    adds a new body. HIDDEN bodies are never touched (a hidden body is intentionally
    protected from edits), so they're excluded from the overlap set."""
    # Extruding several DISJOINT region faces (e.g. 38 selected honeycomb cells)
    # yields a build123d ShapeList, which has no .bounding_box()/boolean ops —
    # normalize to one Compound so overlap-testing and cut/join/intersect work.
    solid = _as_compound(solid)
    if op == "new":
        new_body(solid)
        return
    hits = [
        b for b in bodies
        if b.get("shape") is not None
        and b.get("id") not in hidden
        and _bbox_overlap(b["shape"], solid)
    ]
    if op == "join":
        if not hits:
            new_body(solid)
            return
        merged = solid
        for b in hits:
            merged = merged + _as_compound(b["shape"])
        name = hits[0]["name"]
        for b in hits:
            bodies.remove(b)
        new_body(merged, name)
    elif op == "cut":
        for b in hits:
            b["shape"] = _as_compound(b["shape"]) - solid
    elif op == "intersect":
        for b in hits:
            b["shape"] = _as_compound(b["shape"]) & solid
    else:
        raise ValueError(f"unknown extrude operation: {op}")


def _do_split(f, bodies, find_body, active, new_body, datums):
    """Cut a body by a plane. keep=top/bottom keeps one side (replaces the body);
    keep=both splits it into separate bodies. `bodies` cuts every listed body
    ("cut all visible"); new pieces append to the global list, not `targets`, so
    the loop is snapshot-safe."""
    # cut by an existing datum plane (planeId) or an inline plane
    plane = _plane_of(f.get("planeId") or f["plane"], datums)
    keep = f.get("keep", "both")
    if keep not in KEEP:
        raise ValueError(f"unknown split keep mode: {keep}")
    if f.get("bodies"):
        targets = [t for t in (find_body(b) for b in f["bodies"]) if t is not None]
    else:
        one = find_body(f["body"]) if f.get("body") else active()
        targets = [one] if one is not None else []
    if not targets:
        raise ValueError("Split needs an existing body")
    for target in targets:
        res = split(target["shape"], bisect_by=plane, keep=KEEP[keep])
        pieces = res.solids()
        if keep == "both" and len(pieces) > 1:
            target["shape"] = pieces[0]
            for p in pieces[1:]:
                new_body(p, "Split")
        elif not pieces:
            # a plane that misses one of several bodies shouldn't fail the whole
            # cut — only error when the sole target wasn't intersected.
            if len(targets) == 1:
                raise ValueError("the plane does not intersect the body")
        else:
            target["shape"] = res


def _do_combine(f, bodies, find_body, diag=None):
    """Boolean-combine bodies: join (+), cut (-) or intersect (&). The target body
    is modified in place; tool bodies are consumed unless keepTools is set.

    Dangling references are NON-FATAL: if the target — or every tool — has already
    been consumed by an earlier combine (or renumbered away by an upstream edit;
    body ids are positional), the combine becomes a no-op recorded in `diag` rather
    than halting the whole rebuild. Re-joining a body an earlier combine already
    merged is geometrically idempotent, so skipping a stale duplicate yields the
    intended result; for cut/intersect, doing nothing is the safe fallback over
    cutting the wrong body. A malformed operation is still a hard error."""
    op = f["operation"]
    if op not in ("join", "cut", "intersect"):
        raise ValueError(f"unknown combine operation: {op}")
    target = find_body(f["target"]) if f.get("target") else (bodies[0] if bodies else None)
    if target is None:
        _skip_combine(diag, f, "target body already consumed or missing")
        return
    tool_ids = f.get("tools") or [b["id"] for b in bodies if b["id"] != target["id"]]
    tools = [t for t in (find_body(tid) for tid in tool_ids) if t is not None and t["id"] != target["id"]]
    if not tools:
        _skip_combine(diag, f, "tool bodies already consumed or missing")
        return

    shape = target["shape"]
    for t in tools:
        if op == "join":
            shape = shape + t["shape"]
        elif op == "cut":
            shape = shape - t["shape"]
        else:  # intersect
            shape = shape & t["shape"]
    target["shape"] = shape

    if not f.get("keepTools"):
        consumed = {t["id"] for t in tools}
        bodies[:] = [b for b in bodies if b["id"] not in consumed]


def _skip_combine(diag, f, reason):
    """Record a non-fatal dangling-reference combine skip in the diagnostics
    channel (same shape as geom_select's selector diagnostics). No `diag` list =
    nothing recorded, and the combine is simply skipped."""
    if diag is None:
        return
    diag.append(
        {
            "feature_id": f.get("id"),
            "kind": "combine",
            "resolved": 0,
            "confidence": 0.0,
            "lossy": True,
            "reason": reason,
        }
    )


def _simplify_mesh(shape, tol_deg):
    """Merge near-coplanar facets of an imported mesh into fewer, larger faces
    (OCCT UnifySameDomain with a widened angular tolerance). Recovers planar faces
    from imperfect/dense meshes and tames facet count. NOTE: this COARSENS curved
    regions (a faceted cylinder becomes coarser planar strips) — it does not
    reconstruct true smooth surfaces; that's RANSAC surface fitting (deferred)."""
    import math
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain

    up = ShapeUpgrade_UnifySameDomain(shape.wrapped, True, True, True)
    if tol_deg and tol_deg > 0:
        up.SetAngularTolerance(math.radians(tol_deg))
    up.Build()
    return _wrap_topods(up.Shape()) or shape


def _shell(shape, thickness, openings):
    """Hollow a solid to a wall `thickness`, removing `openings` faces (empty =
    a fully closed hollow). Sharp corners use the Intersection join."""
    amt = -abs(thickness)  # negative = hollow inward
    if openings:
        return offset(shape, amount=amt, openings=list(openings), kind=Kind.INTERSECTION)
    return offset(shape, amount=amt, kind=Kind.INTERSECTION)


def _rot_for(axis, deg):
    """A build123d Rotation of `deg` degrees about the named global axis."""
    if axis == "X":
        return Rot(deg, 0, 0)
    if axis == "Y":
        return Rot(0, deg, 0)
    return Rot(0, 0, deg)


def _pattern_rect(shape, nx, ny, dx, dy):
    """Replicate a body on an nx×ny grid (spacing dx, dy) and union the copies."""
    nx, ny = max(1, int(round(nx))), max(1, int(round(ny)))
    result = None
    for i in range(nx):
        for j in range(ny):
            cell = Pos(i * dx, j * dy, 0) * shape
            result = cell if result is None else result + cell
    return result


def _pattern_circular(shape, count, total_angle, axis):
    """Replicate a body `count` times about a global axis spanning `total_angle`
    degrees and union the copies. A full 360° spread doesn't double the seam."""
    count = max(1, int(round(count)))
    full = abs(total_angle - 360) < 1e-6
    step = total_angle / count if full else (total_angle / (count - 1) if count > 1 else 0)
    result = None
    for k in range(count):
        cell = _rot_for(axis, k * step) * shape
        result = cell if result is None else result + cell
    return result


def _draft(shape, faces, angle_deg, axis):
    """Taper `faces` by `angle_deg` about the line where each meets a neutral plane
    (the body's near end along the pull axis). Pull direction = +axis. Uses OCCT
    BRepOffsetAPI_DraftAngle directly (build123d has no draft wrapper)."""
    import math
    from OCP.BRepOffsetAPI import BRepOffsetAPI_DraftAngle
    from OCP.gp import gp_Dir, gp_Pln, gp_Pnt

    dirs = {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}
    dx, dy, dz = dirs.get(axis, (0, 0, 1))
    pull = gp_Dir(dx, dy, dz)
    # neutral plane at the body's minimum along the pull axis, so faces pivot there
    bb = shape.bounding_box()
    base = {"X": bb.min.X, "Y": bb.min.Y, "Z": bb.min.Z}[axis]
    origin = gp_Pnt(base * dx, base * dy, base * dz)
    neutral = gp_Pln(origin, pull)

    drafter = BRepOffsetAPI_DraftAngle(shape.wrapped)
    ang = math.radians(angle_deg)
    for fc in faces:
        drafter.Add(fc.wrapped, pull, ang, neutral)
    drafter.Build()
    if not drafter.IsDone():
        raise ValueError("draft failed for these faces / angle")
    return _wrap_topods(drafter.Shape())


def _press_pull(part, face, d):
    """Push/pull a single solid face by signed distance `d` (mm): +d grows the body
    (boss), -d cuts inward (pocket).

    PLANAR faces extrude the face region into a prism and boolean it (union for +d,
    subtract for -d). This is far more robust than a local surface offset
    (BRepOffset), which SEGFAULTs on faceted / split imported faces — and it handles
    holed faces fine in practice. CYLINDRICAL faces still use the local offset (to
    resize a hole/boss cleanly). Other curved surfaces are rejected — OCCT's offset
    is too unreliable on them to risk taking down the sidecar.
    """
    if abs(d) < 1e-9:
        return part
    try:
        gt = face.geom_type
    except Exception:
        gt = None
    if gt == GeomType.PLANE:
        # A lone mesh facet (a tiny planar triangle on a dense imported body):
        # reject cleanly rather than extrude a degenerate sliver.
        try:
            if len(part.faces()) > 300 and face.area < 1.0:
                raise ValueError(
                    "can't press/pull this region — it's a single mesh facet, not a "
                    "clean face (the imported body is faceted, not prismatic)"
                )
        except ValueError:
            raise
        except Exception:
            pass
        dd = _clamp_planar(part, face, d)  # cap an inward push so it can't go through
        if abs(dd) < 1e-9:
            return part
        prism = extrude(face, dd)  # +dd outward (boss), -dd inward (pocket)
        return (part + prism) if dd > 0 else (part - prism)
    if gt == GeomType.CYLINDER:
        return _offset_face(part, face, _clamp_cylinder(face, d))
    raise ValueError("Press/Pull supports flat and cylindrical faces only")


def _distance_to_target(src_face, target_pt, target_n):
    """Signed distance to extrude `src_face` along its own normal so it lands on the
    target plane (a point `target_pt` on it + its normal `target_n`) — i.e. "up to
    that surface". Raises if the face is parallel to the target (it never reaches).
    MVP: assumes a planar source and a planar target."""
    c, n = src_face.center(), src_face.normal_at()
    denom = n.X * target_n.X + n.Y * target_n.Y + n.Z * target_n.Z
    if abs(denom) < 1e-6:
        raise ValueError("Press/Pull: the face is parallel to the 'up to' surface — can't reach it")
    num = (target_pt.X - c.X) * target_n.X + (target_pt.Y - c.Y) * target_n.Y + (target_pt.Z - c.Z) * target_n.Z
    return num / denom


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


def _translate_entity(e, dx, dy, eid, val):
    t = e["type"]
    c = {"construction": True} if e.get("construction") else {}
    if t == "line":
        return {"type": "line", "id": eid, "x1": val(e["x1"]) + dx, "y1": val(e["y1"]) + dy, "x2": val(e["x2"]) + dx, "y2": val(e["y2"]) + dy, **c}
    if t == "rectangle":
        return {"type": "rectangle", "id": eid, "width": val(e["width"]), "height": val(e["height"]), "x": val(e.get("x", 0)) + dx, "y": val(e.get("y", 0)) + dy, **c}
    if t == "circle":
        return {"type": "circle", "id": eid, "radius": val(e["radius"]), "x": val(e.get("x", 0)) + dx, "y": val(e.get("y", 0)) + dy, **c}
    if t == "arc":
        return {"type": "arc", "id": eid, "x1": val(e["x1"]) + dx, "y1": val(e["y1"]) + dy, "x2": val(e["x2"]) + dx, "y2": val(e["y2"]) + dy, "mx": val(e["mx"]) + dx, "my": val(e["my"]) + dy, **c}
    if t == "spline":
        return {"type": "spline", "id": eid, "points": [{"x": val(p["x"]) + dx, "y": val(p["y"]) + dy} for p in e.get("points", [])], **c}
    return {"type": "point", "id": eid, "x": val(e["x"]) + dx, "y": val(e["y"]) + dy, **c}


def _rotate_entity(e, cx, cy, ang, eid, val):
    co, si = math.cos(ang), math.sin(ang)

    def R(x, y):
        ddx, ddy = x - cx, y - cy
        return cx + ddx * co - ddy * si, cy + ddx * si + ddy * co

    t = e["type"]
    c = {"construction": True} if e.get("construction") else {}
    if t == "circle":
        x, y = R(val(e.get("x", 0)), val(e.get("y", 0)))
        return [{"type": "circle", "id": eid, "radius": val(e["radius"]), "x": x, "y": y, **c}]
    if t == "point":
        x, y = R(val(e["x"]), val(e["y"]))
        return [{"type": "point", "id": eid, "x": x, "y": y, **c}]
    if t == "line":
        x1, y1 = R(val(e["x1"]), val(e["y1"]))
        x2, y2 = R(val(e["x2"]), val(e["y2"]))
        return [{"type": "line", "id": eid, "x1": x1, "y1": y1, "x2": x2, "y2": y2, **c}]
    if t == "arc":
        x1, y1 = R(val(e["x1"]), val(e["y1"]))
        x2, y2 = R(val(e["x2"]), val(e["y2"]))
        mx, my = R(val(e["mx"]), val(e["my"]))
        return [{"type": "arc", "id": eid, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "mx": mx, "my": my, **c}]
    if t == "spline":
        return [{"type": "spline", "id": eid, "points": [dict(zip(("x", "y"), R(val(p["x"]), val(p["y"])))) for p in e.get("points", [])], **c}]
    # rectangle can't carry rotation (axis-aligned) -> a 4-line loop
    hw, hh = val(e["width"]) / 2, val(e["height"]) / 2
    ex, ey = val(e.get("x", 0)), val(e.get("y", 0))
    corners = [R(ex - hw, ey - hh), R(ex + hw, ey - hh), R(ex + hw, ey + hh), R(ex - hw, ey + hh)]
    return [
        {"type": "line", "id": f"{eid}.{i}", "x1": corners[i][0], "y1": corners[i][1], "x2": corners[(i + 1) % 4][0], "y2": corners[(i + 1) % 4][1], **c}
        for i in range(4)
    ]


def _expand_pattern(pat, by_id, val):
    """Expand a sketch pattern definition into derived entity dicts. Mirrors
    src/sketch/pattern.ts (expandPattern). Derived ids are "<pat.id>#<n>"."""
    out = []
    counter = [0]

    def did():
        counter[0] += 1
        return f"{pat['id']}#{counter[0] - 1}"

    t = pat["type"]
    if t == "patternRect":
        cx, cy = max(1, round(val(pat["countX"]))), max(1, round(val(pat["countY"])))
        sx, sy = val(pat["spacingX"]), val(pat["spacingY"])
        srcs = [by_id[s] for s in pat.get("sources", []) if s in by_id]
        for i in range(cx):
            for j in range(cy):
                if i == 0 and j == 0:
                    continue
                for s in srcs:
                    out.append(_translate_entity(s, i * sx, j * sy, did(), val))
    elif t == "patternCircular":
        count, total = max(1, round(val(pat["count"]))), val(pat["angle"])
        full = total != 0 and abs(abs(total) - 360) < 1e-6
        step = math.radians(total / count if full else total / max(1, count - 1))
        cx, cy = val(pat["cx"]), val(pat["cy"])
        srcs = [by_id[s] for s in pat.get("sources", []) if s in by_id]
        for k in range(1, count):
            for s in srcs:
                out.extend(_rotate_entity(s, cx, cy, k * step, did(), val))
    elif t == "boltCircle":
        count = max(1, round(val(pat["count"])))
        r, rad = val(pat["bcd"]) / 2, val(pat["diameter"]) / 2
        cx, cy = val(pat["cx"]), val(pat["cy"])
        for k in range(count):
            a = (k / count) * 2 * math.pi
            out.append({"type": "circle", "id": did(), "radius": rad, "x": cx + r * math.cos(a), "y": cy + r * math.sin(a)})
    elif t == "gridHoles":
        cx0, cy0 = max(1, round(val(pat["countX"]))), max(1, round(val(pat["countY"])))
        sx, sy, rad = val(pat["spacingX"]), val(pat["spacingY"]), val(pat["diameter"]) / 2
        cx, cy = val(pat["cx"]), val(pat["cy"])
        for i in range(cx0):
            for j in range(cy0):
                out.append({"type": "circle", "id": did(), "radius": rad, "x": cx + (i - (cx0 - 1) / 2) * sx, "y": cy + (j - (cy0 - 1) / 2) * sy})
    elif t == "hexHoles":
        rings = max(0, round(val(pat["rings"])))
        s, rad = val(pat["spacing"]), val(pat["diameter"]) / 2
        cx, cy = val(pat["cx"]), val(pat["cy"])
        h = s * math.sqrt(3) / 2
        for q in range(-rings, rings + 1):
            for rr in range(max(-rings, -q - rings), min(rings, -q + rings) + 1):
                out.append({"type": "circle", "id": did(), "radius": rad, "x": cx + s * (q + rr / 2), "y": cy + h * rr})
    elif t == "honeycomb":
        rings = max(0, round(val(pat["rings"])))
        s, R = val(pat["spacing"]), val(pat["diameter"]) / 2
        cx, cy = val(pat["cx"]), val(pat["cy"])
        h = s * math.sqrt(3) / 2
        for q in range(-rings, rings + 1):
            for rr in range(max(-rings, -q - rings), min(rings, -q + rings) + 1):
                out.extend(_hexagon_lines(cx + s * (q + rr / 2), cy + h * rr, R, did()))
    return out


def _hexagon_lines(cx, cy, R, eid):
    """A pointy-top regular hexagon as 6 line entity dicts (mirrors pattern.ts)."""
    v = []
    for k in range(6):
        a = math.pi / 6 + k * math.pi / 3
        v.append((cx + R * math.cos(a), cy + R * math.sin(a)))
    return [
        {"type": "line", "id": f"{eid}.{k}", "x1": v[k][0], "y1": v[k][1], "x2": v[(k + 1) % 6][0], "y2": v[(k + 1) % 6][1]}
        for k in range(6)
    ]


def _build_sketch(f, val, datums=None):
    """Build a 2D sketch and locate it onto its plane (algebra mode).

    Returns {"sketch": union, "faces": [located per-loop faces]}. The union is the
    whole profile (revolve/loft/whole-extrude); `faces` keeps each closed loop as
    its own located Face so region selection can recover nested profiles (a ring,
    an inner disk) that the union collapses.

    Primitives (rectangle/circle) become faces directly. Free-form `line`
    segments are assembled into closed wires and turned into faces, so an
    interactively-drawn polyline profile can be extruded like in Fusion.
    """
    plane = _plane_of(f["plane"], datums)
    faces = []
    edges = []  # free-form line + arc edges, assembled into faces below
    all_edges = []  # EVERY entity's boundary as local edges, for planar subdivision

    # Associative patterns: expand each definition into its derived entities and
    # append them, so a patterned hole/array builds like hand-drawn geometry. The
    # math mirrors src/sketch/pattern.ts so frontend preview and build agree.
    entities = list(f.get("entities", []))
    if f.get("patterns"):
        by_id = {e["id"]: e for e in entities if e.get("id")}
        for pat in f["patterns"]:
            entities.extend(_expand_pattern(pat, by_id, val))

    for e in entities:
        if e.get("construction"):
            continue  # construction geometry is reference-only, not a profile
        et = e["type"]
        if et == "rectangle":
            x, y = val(e.get("x", 0)), val(e.get("y", 0))
            hw, hh = val(e["width"]) / 2, val(e["height"]) / 2
            faces.append(Pos(x, y) * Rectangle(val(e["width"]), val(e["height"])))
            c = [(x - hw, y - hh), (x + hw, y - hh), (x + hw, y + hh), (x - hw, y + hh)]
            for k in range(4):
                a, b = c[k], c[(k + 1) % 4]
                all_edges.append(Edge.make_line((a[0], a[1], 0), (b[0], b[1], 0)))
        elif et == "circle":
            x, y = val(e.get("x", 0)), val(e.get("y", 0))
            faces.append(Pos(x, y) * Circle(val(e["radius"])))
            all_edges.append(Pos(x, y) * Edge.make_circle(val(e["radius"])))
        elif et == "line":
            ed = Edge.make_line(
                (val(e["x1"]), val(e["y1"]), 0),
                (val(e["x2"]), val(e["y2"]), 0),
            )
            edges.append(ed)
            all_edges.append(ed)
        elif et == "arc":
            ed = Edge.make_three_point_arc(
                (val(e["x1"]), val(e["y1"]), 0),
                (val(e["mx"]), val(e["my"]), 0),  # through-point
                (val(e["x2"]), val(e["y2"]), 0),
            )
            edges.append(ed)
            all_edges.append(ed)
        elif et == "spline":
            pts = [(val(p["x"]), val(p["y"]), 0) for p in e.get("points", [])]
            if len(pts) >= 2:
                ed = Edge.make_spline(pts)
                edges.append(ed)
                all_edges.append(ed)
        elif et == "point":
            continue  # a sketch point is reference/snap-only, never part of a profile

    if edges:
        faces.extend(_faces_from_edges(edges))

    # the located open/closed path wire from the free edges (for sweep paths)
    path_wire = _path_wire(edges, plane)

    # Region-pick faces = the planar ARRANGEMENT of every sketch edge: a line
    # crossing a profile carves it into separately-selectable sub-areas (Fusion
    # parity), and touching/overlapping loops split at the shared boundaries. This
    # mirrors the frontend arrangement (src/sketch/region.ts).
    located_faces = _subdivide_faces(all_edges, plane)

    if faces:
        sk = faces[0]
        for fc in faces[1:]:
            sk = sk + fc
        # Disjoint loops (e.g. a honeycomb of many hexagons) make `sk` a ShapeList,
        # which `plane * sk` rejects — normalize to one Compound first.
        if getattr(sk, "wrapped", None) is None:
            sk = Compound(list(sk))
        sk = plane * sk  # locate the 2D sketch onto its plane
        if not located_faces:  # fall back to per-loop faces (degenerate arrangement)
            for fc in faces:
                for face in (plane * fc).faces():
                    located_faces.append(face)
    elif located_faces:
        # Crossing-only sketch (e.g. an "X", or free lines that only close by
        # crossing): no clean per-loop face, but the arrangement recovers the
        # profile. Union the located cells for the whole-sketch (revolve/loft/whole
        # extrude) target.
        sk = located_faces[0]
        for fc in located_faces[1:]:
            sk = sk + fc
        if getattr(sk, "wrapped", None) is None:
            sk = Compound(list(sk))
    else:
        return {"sketch": None, "faces": [], "wire": path_wire}

    return {"sketch": sk, "faces": located_faces, "wire": path_wire}


def _path_wire(edges, plane):
    """Combine a sketch's free line/arc/spline edges into ONE located wire (open or
    closed) for use as a sweep path. Picks the longest wire if the edges form
    several; returns None when there are no free edges."""
    if not edges:
        return None
    try:
        wires = Wire.combine(edges)
    except Exception:
        return None
    if not wires:
        return None
    longest = max(wires, key=lambda w: w.length)
    return plane * longest


def _region_face_at(cells, P):
    """Pick the planar arrangement cell whose material contains point P.

    `cells` is a list of (face, bounding_box) pairs — the caller precomputes the
    bboxes ONCE because region picking runs per selected point, and OCCT `is_inside`
    is far too slow to call on every face (38 honeycomb points × 160 cells of
    is_inside + a per-nested-face boolean was ~2.8 s). A bbox pre-filter cuts the
    point-in-face tests down to the 1-2 cells whose box actually contains P.

    Arrangement cells (from `_subdivide_faces`) already carry their holes natively, so
    the smallest containing cell IS the region — no nested-hole subtraction needed.
    Falls back to the nearest cell by center when P isn't inside any (tessellation
    drift / degenerate geometry)."""
    if not cells:
        return None
    best = None
    for fc, bb in cells:
        if not (bb.min.X - 1e-6 <= P.X <= bb.max.X + 1e-6
                and bb.min.Y - 1e-6 <= P.Y <= bb.max.Y + 1e-6
                and bb.min.Z - 1e-6 <= P.Z <= bb.max.Z + 1e-6):
            continue
        if _face_contains(fc, P) and (best is None or fc.area < best.area):
            best = fc
    if best is not None:
        return best
    return min((fc for fc, _ in cells), key=lambda fc: (fc.center() - P).length)


def _face_contains(face, p):
    try:
        return bool(face.is_inside(p))
    except Exception:
        return False


def _subdivide_faces(edges, plane):
    """Planar arrangement of all sketch edges into minimal faces, located onto the
    sketch plane. This is what lets a curve CROSSING a profile carve it into
    separately-selectable sub-areas (Fusion parity), and touching/overlapping loops
    split at their shared boundaries.

    Uses OCCT's 2D face splitter: split a padded cover face by every sketch edge,
    then keep only the ENCLOSED cells (those not touching the cover boundary). Real
    curved edges are preserved (smooth extrude) and faces with holes come out
    natively, so `_region_face_at` needs no change. Mirrors the frontend arrangement
    in src/sketch/region.ts (planarize + traceLoops). Returns [] on empty/failure so
    the caller falls back to per-loop faces — this is a 2D edge split, unlike the
    reverted 3D UnifySameDomain, and stays well under ~30 ms even for dense grids."""
    if not edges:
        return []
    try:
        from OCP.BOPAlgo import BOPAlgo_Splitter
        from OCP.TopoDS import TopoDS
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopAbs import TopAbs_FACE
        from OCP.TopTools import TopTools_ListOfShape

        xs, ys = [], []
        for e in edges:
            bb = e.bounding_box()
            xs += [bb.min.X, bb.max.X]
            ys += [bb.min.Y, bb.max.Y]
        spanx, spany = max(xs) - min(xs), max(ys) - min(ys)
        pad = (spanx + spany) * 0.1 + 1.0
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        w, h = spanx + 2 * pad, spany + 2 * pad
        cover = Pos(cx, cy) * Rectangle(w, h)

        sp = BOPAlgo_Splitter()
        args = TopTools_ListOfShape()
        args.Append(cover.wrapped)
        tools = TopTools_ListOfShape()
        for e in edges:
            tools.Append(e.wrapped)
        sp.SetArguments(args)
        sp.SetTools(tools)
        sp.Perform()
        res = sp.Shape()

        bx0, bx1 = cx - w / 2, cx + w / 2
        by0, by1 = cy - h / 2, cy + h / 2

        def on_cover(face):
            for vtx in face.vertices():
                if (abs(vtx.X - bx0) < 1e-6 or abs(vtx.X - bx1) < 1e-6
                        or abs(vtx.Y - by0) < 1e-6 or abs(vtx.Y - by1) < 1e-6):
                    return True
            return False

        cells = []
        exp = TopExp_Explorer(res, TopAbs_FACE)
        while exp.More():
            fc = Face(TopoDS.Face_s(exp.Current()))
            if not on_cover(fc):  # drop the cover's own exterior cells
                for face in (plane * fc).faces():
                    cells.append(face)
            exp.Next()
        return cells
    except Exception:
        return []


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
