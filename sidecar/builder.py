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

API notes (verified against build123d 0.11.1, dual-compatible back to 0.10.x):
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
  - 0.11 makes `.wrapped` a property that ASSERTS on an empty shape (0.10 left
    the attribute simply absent) — never touch `.wrapped` directly on a shape
    that might be empty; go through `_wrapped_or_none(shape)` instead, which
    tolerates both AttributeError (0.10) and AssertionError (0.11).
"""

import base64
import hashlib
import io
import json
import math
import os
import sys
import tempfile
import time
import traceback
from collections import ChainMap
from dataclasses import dataclass

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

from geom_select import (
    resolve_edges,
    resolve_faces,
    _edge_mid,
    _edge_dir,
    _edge_curve,
    _edge_radius,
    _edge_center,
    _edge_cost,
    _bbox_diag,
    POS_DRIFT,
    REL_DRIFT,
)

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
    """Inverse of _shape_to_brep_b64. Validates the decoded blob looks like a real
    OCCT BREP (magic header + sane size) BEFORE handing it to the parser, so a
    crafted .sindri can't aim a parser fuzz at OCCT in the worker. import_brep
    needs a real path, so we round the bytes through a temp file."""
    data = base64.b64decode(b64)
    if len(data) > MAX_BREP_BYTES:
        raise ValueError("embedded BREP payload too large to import")
    # OCCT's BRepTools::Write emits a leading newline then "CASCADE Topology V<n>".
    # Strip the expected newline and require the signature right after it.
    if not data[: len(_BREP_MAGIC) + 2].lstrip(b"\n\r ").startswith(_BREP_MAGIC):
        raise ValueError("embedded payload is not a valid BREP (bad header)")
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


def _refacet_clean(shape, tol=0.12, debug=False):
    """Collapse facet-import raggedness. STL→B-rep leaves sliver bands and
    near-coplanar "staircase" faces around every real design plane (the planar
    merge unifies only EXACT coplanarity), and that debris is what defeats face
    picking, seam hiding, and Delete Face (the true supports hide behind
    slivers). Key insight: debris deviates from the design plane by DISTANCE
    (≤ ~0.1 mm) no matter how wild its own normal is — so region-grow faces by
    max vertex distance to an anchor plane (adjacency-only, so a real 0.1 mm
    AIR GAP between parts can't merge: those faces aren't edge-connected), snap
    the mesh vertices onto the intersection of their regions' planes, and
    rebuild the solid from the snapped mesh. Crisp planes meeting at crisp
    edges. Planar-only, best-effort, hard-validated: any doubt → the original
    shape, unchanged."""
    import numpy as np

    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType

    try:
        faces = _as_compound(shape).faces()
        if not faces or any(
            BRepAdaptor_Surface(f.wrapped).GetType() != GeomAbs_SurfaceType.GeomAbs_Plane
            for f in faces
        ):
            return shape  # planar-only pipeline (curved imports keep their B-rep)
    except Exception:
        return shape

    # clean each solid independently — two imported bodies can TOUCH, and a
    # shared sewing pass would stitch them together at the contact
    parts = _explode_solids(shape)
    if len(parts) > 1:
        cleaned_parts = [_refacet_clean(p, tol, debug=debug) for p in parts]
        if all(cp is p for cp, p in zip(cleaned_parts, parts)):
            return shape
        return Compound(cleaned_parts)

    try:
        from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
        from OCP.TopExp import TopExp, TopExp_Explorer
        from OCP.TopoDS import TopoDS
        from OCP.TopTools import (
            TopTools_IndexedDataMapOfShapeListOfShape,
            TopTools_IndexedMapOfShape,
        )

        comp = _as_compound(shape)
        fmap = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(comp.wrapped, TopAbs_FACE, fmap)
        emap = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(comp.wrapped, TopAbs_EDGE, TopAbs_FACE, emap)
        n = fmap.Extent()
        faces_by_idx = {i: Face(TopoDS.Face_s(fmap.FindKey(i))) for i in range(1, n + 1)}

        def neighbors(i):
            out = set()
            exp = TopExp_Explorer(fmap.FindKey(i), TopAbs_EDGE)
            while exp.More():
                if emap.Contains(exp.Current()):
                    for other in emap.FindFromKey(exp.Current()):
                        j = fmap.FindIndex(other)
                        if j != i:
                            out.add(j)
                exp.Next()
            return out

        fverts = {
            i: np.array([(v.X, v.Y, v.Z) for v in f.vertices()])
            for i, f in faces_by_idx.items()
        }

        # region-grow from the biggest faces: absorb an edge-adjacent face when
        # ALL its vertices lie within tol of the ANCHOR's plane (anchored, not
        # chained, so regions can't drift step by step across the part)
        region = {}
        planes = []  # region id -> (point, normal) as np arrays
        for i in sorted(faces_by_idx, key=lambda i: -faces_by_idx[i].area):
            if i in region:
                continue
            f = faces_by_idx[i]
            c, nv = f.center(), f.normal_at(f.center())
            p0 = np.array((c.X, c.Y, c.Z))
            nn = np.array((nv.X, nv.Y, nv.Z))
            rid = len(planes)
            planes.append((p0, nn))
            region[i] = rid
            queue = [i]
            while queue:
                k = queue.pop()
                for j in neighbors(k):
                    if j in region:
                        continue
                    d = np.abs((fverts[j] - p0) @ nn)
                    if len(d) and d.max() <= tol:
                        region[j] = rid
                        queue.append(j)
        if len(planes) >= n:
            return shape  # nothing merged — no debris to clean

        # mesh the whole shape once (consistent shared edges), weld vertices,
        # tag each welded vertex with the region planes of the faces using it
        import tessellate as _tess

        positions, indices, face_ids = _tess.tessellate(comp, 0.5)
        # tessellate() numbers faces by enumerate(comp.faces()) — translate that
        # 0-based order to fmap's 1-based indices instead of assuming they align
        fid_to_idx = {k: fmap.FindIndex(f.wrapped) for k, f in enumerate(comp.faces())}
        pos = np.array(positions).reshape(-1, 3)
        tris = np.array(indices).reshape(-1, 3)
        keys = [tuple(np.round(p / 1e-4).astype(np.int64)) for p in pos]
        weld = {}
        widx = np.empty(len(pos), dtype=np.int64)
        wpos = []
        for a, k in enumerate(keys):
            if k not in weld:
                weld[k] = len(wpos)
                wpos.append(pos[a])
            widx[a] = weld[k]
        wpos = np.array(wpos)
        vregions = [set() for _ in wpos]
        for t, fid in zip(tris, face_ids):
            rid = region.get(fid_to_idx.get(fid))
            if rid is None:
                continue
            for a in t:
                vregions[widx[a]].add(rid)

        # snap each welded vertex to the intersection of its regions' planes:
        # min |x−v| s.t. n_r·x = n_r·p_r — rank-deficient (near-parallel planes)
        # solved by lstsq, so a staircase vertex lands on the merged plane
        # instead of flying off along a bad intersection line
        snapped = wpos.copy()
        for vi, rs in enumerate(vregions):
            if not rs:
                continue
            A = np.array([planes[r][1] for r in rs])
            b = np.array([planes[r][1] @ planes[r][0] for r in rs])
            v = wpos[vi]
            try:
                y, *_ = np.linalg.lstsq(A @ A.T, b - A @ v, rcond=1e-3)
                x = v + A.T @ y
            except Exception:
                continue
            if np.linalg.norm(x - v) <= 3 * tol:
                snapped[vi] = x

        # rebuild each REGION as one planar polygon face: boundary edges of the
        # region's triangles chain into closed loops (outer + holes); points are
        # projected EXACTLY onto the region plane (lstsq snap residuals exceed
        # OCCT's plane-finding precision, so MakeFace gets the plane explicitly);
        # sewing at 1e-3 merges the per-face copies of shared boundaries. This
        # avoids the mesh round-trip entirely — no degenerate-triangle repair,
        # and the output IS the ideal one-face-per-plane solid.
        from collections import Counter, defaultdict

        from OCP.BRepBuilderAPI import (
            BRepBuilderAPI_MakeFace,
            BRepBuilderAPI_MakePolygon,
            BRepBuilderAPI_Sewing,
        )
        from OCP.gp import gp_Dir, gp_Pln, gp_Pnt
        from OCP.ShapeFix import ShapeFix_Face, ShapeFix_Shape, ShapeFix_Solid
        from OCP.TopAbs import TopAbs_SHELL

        tri_w = widx[tris]
        region_tris = defaultdict(list)
        for t, fid in zip(tri_w, face_ids):
            rid = region.get(fid_to_idx.get(fid))
            if rid is not None:
                region_tris[rid].append(t)

        new_faces = []
        for rid, rtris in region_tris.items():
            p0, nn = planes[rid]
            ec = Counter()
            for a, b, c in rtris:
                for e in ((a, b), (b, c), (c, a)):
                    ec[tuple(sorted(e))] += 1
            nxt = defaultdict(list)
            for a, b, c in rtris:
                for e in ((a, b), (b, c), (c, a)):
                    if ec[tuple(sorted(e))] == 1:
                        nxt[e[0]].append(e[1])
            loops = []
            while any(nxt.values()):
                start = next(k for k, v in nxt.items() if v)
                loop, v = [start], nxt[start].pop()
                guard = sum(len(x) for x in nxt.values()) + 2
                while v != start and guard > 0:
                    loop.append(v)
                    outs = nxt.get(v)
                    if not outs:
                        loop = None
                        break
                    v = outs.pop()
                    guard -= 1
                if loop and len(loop) >= 3:
                    loops.append(loop)
            if not loops:
                if debug:
                    print(f"refacet: region {rid} has no closed boundary")
                return shape  # a region without a closed boundary — bail

            def flat(idx_loop):
                # exact in-plane projection; prune ONLY exact duplicates — any
                # smarter (collinear) pruning must be identical in BOTH regions
                # sharing a boundary, or the sew is left with open T-junction
                # seams. Segmented collinear edges are merged by the final
                # UnifySameDomain pass instead.
                pts = [snapped[i] - ((snapped[i] - p0) @ nn) * nn for i in idx_loop]
                out = []
                m = len(pts)
                for k in range(m):
                    if np.linalg.norm(pts[k] - pts[(k - 1) % m]) < 1e-6:
                        continue
                    out.append(pts[k])
                return out

            def loop_area(pts):
                s = np.zeros(3)
                for k in range(len(pts)):
                    s += np.cross(pts[k], pts[(k + 1) % len(pts)])
                return abs(s @ nn) / 2

            wires = []
            for loop in loops:
                pts = flat(loop)
                if len(pts) < 3:
                    continue  # loop collapsed by the snap — nothing to bound
                mp = BRepBuilderAPI_MakePolygon()
                for p in pts:
                    mp.Add(gp_Pnt(*p))
                mp.Close()
                if mp.IsDone():
                    wires.append((mp.Wire(), loop_area(pts)))
            if not wires:
                continue  # region fully collapsed (pure debris) — no face needed
            wires.sort(key=lambda w: -w[1])
            mf = BRepBuilderAPI_MakeFace(
                gp_Pln(gp_Pnt(*p0), gp_Dir(*nn)), wires[0][0]
            )
            for w, _ in wires[1:]:
                mf.Add(w)
            if not mf.IsDone():
                if debug:
                    print(f"refacet: MakeFace failed for region {rid}")
                return shape  # can't rebuild this region faithfully — bail
            fx = ShapeFix_Face(mf.Face())
            fx.Perform()
            new_faces.append(fx.Face())

        # sew tolerance must cover the step seams: a vertex pinched between two
        # near-parallel surviving regions (a real step ≤ tol whose wall got
        # absorbed) cannot lie on both planes, so the two regions' boundary
        # copies diverge by up to ~tol there — sewing tighter leaves open seams
        sew = BRepBuilderAPI_Sewing(1.5 * tol)
        for f in new_faces:
            sew.Add(f)
        sew.Perform()
        fixer = ShapeFix_Shape(sew.SewedShape())
        fixer.Perform()
        sewn = fixer.Shape()
        # sewing disjoint bodies yields ONE shell holding several disconnected
        # face components; SolidFromShell on that is garbage (mixed orientation,
        # nonsense volume). Split faces into edge-connected components and build
        # one solid per component.
        cmap = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(sewn, TopAbs_FACE, cmap)
        cemap = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(sewn, TopAbs_EDGE, TopAbs_FACE, cemap)
        unvisited = set(range(1, cmap.Extent() + 1))
        solids = []
        while unvisited:
            seed = unvisited.pop()
            compo, queue = [seed], [seed]
            while queue:
                k = queue.pop()
                eexp = TopExp_Explorer(cmap.FindKey(k), TopAbs_EDGE)
                while eexp.More():
                    if cemap.Contains(eexp.Current()):
                        for other in cemap.FindFromKey(eexp.Current()):
                            j = cmap.FindIndex(other)
                            if j in unvisited:
                                unvisited.discard(j)
                                compo.append(j)
                                queue.append(j)
                    eexp.Next()
            part_sew = BRepBuilderAPI_Sewing(1.5 * tol)
            for k in compo:
                part_sew.Add(cmap.FindKey(k))
            part_sew.Perform()
            sexp = TopExp_Explorer(part_sew.SewedShape(), TopAbs_SHELL)
            while sexp.More():
                sf = ShapeFix_Solid()
                solids.append(Solid(sf.SolidFromShell(TopoDS.Shell_s(sexp.Current()))))
                sexp.Next()
        if not solids:
            if debug:
                print("refacet: sew produced no solids")
            return shape
        cleaned = solids[0] if len(solids) == 1 else Compound(solids)
        # merge the facet-length collinear edge segments left on the region
        # boundaries (faces are already maximal; this unifies EDGES)
        cleaned = _maybe_unify(cleaned)

        from OCP.BRepCheck import BRepCheck_Analyzer

        if debug:
            print(f"refacet: {len(cleaned.faces())} faces (was {n}), "
                  f"solids {len(_explode_solids(cleaned))} (was {len(_explode_solids(shape))}), "
                  f"valid {BRepCheck_Analyzer(cleaned.wrapped).IsValid()}, "
                  f"vol {cleaned.volume:.2f} vs {shape.volume:.2f}")
        ok = (
            len(cleaned.faces()) < n
            and len(_explode_solids(cleaned)) == len(_explode_solids(shape))
            and BRepCheck_Analyzer(cleaned.wrapped).IsValid()
            and abs(cleaned.volume - shape.volume)
            <= max(1.0, 0.01 * abs(shape.volume))
        )
        return cleaned if ok else shape
    except Exception:
        if debug:
            raise
        return shape


def _drop_debris(shape, debug=False):
    """Drop floating boolean debris from a body shape: a solid that is
    sub-epsilon (<0.1%) of the biggest piece AND has clear distance from it
    is residue of the cuts that carved the body, not user geometry (DDR: a
    1.5 mm³ chip floating 0.6 mm off the 17200 mm³ body). Anything touching —
    even zero-measure vertex/edge contact — is kept, as are all pieces of a
    genuinely multi-piece body. Best-effort: any doubt → shape unchanged."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    try:
        shape = _as_compound(shape)
        cached = getattr(shape, "_sindri_drop", None)
        if cached is not None:
            return cached  # same input object => same output OBJECT (identity
            # matters: the server's mesh cache is keyed by shape identity, and
            # rebuilding a fresh Compound here every rebuild would defeat it)
        parts = sorted(shape.solids(), key=lambda s: -abs(s.volume))
        if len(parts) < 2:
            return shape
        main, kept = parts[0], [parts[0]]
        for s in parts[1:]:
            tiny = abs(s.volume) < 1e-3 * abs(main.volume)
            if tiny and BRepExtrema_DistShapeShape(
                s.wrapped, main.wrapped
            ).Value() > 1e-7:
                if debug:
                    print(f"drop_debris: dropping floating solid "
                          f"vol {s.volume:.3f}")
                continue
            kept.append(s)
        if len(kept) == len(parts):
            return shape
        out = kept[0] if len(kept) == 1 else Compound(kept)
        try:
            shape._sindri_drop = out
        except Exception:
            pass
        return out
    except Exception:
        if debug:
            raise
        return shape


def _unify_body(shape, debug=False):
    """Fuse a body's glued/overlapping constituent solids into unified material.

    Boolean joins of ragged facet-import bodies GLUE solids together instead of
    merging them: the body ends up a compound of individually-manifold solids
    sharing interface walls (cross-solid non-manifold edges), with coincident
    skin overlaps, genuine volume interpenetration (material double-counted in
    mass properties), and sometimes an inside-out duplicate solid that poisons
    point classification. All of that lives BETWEEN solids, so the per-solid
    _refacet_clean is structurally unable to see it. Repair (measured on the
    DDR document — proving-ground/membrane/): right inside-out solids with
    ShapeFix_Solid, then ONE N-ary fuse of all constituents + SimplifyResult
    (merges the coplanar splits the fuse leaves). Genuinely-disjoint pieces
    stay separate solids — fuse never merges non-touching or zero-measure
    (vertex/edge) contact, so grouped split bodies and separate physical
    pieces keep their identity. Best-effort, hard-validated: any doubt → the
    original shape, unchanged."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.ShapeFix import ShapeFix_Solid
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp
    from OCP.TopoDS import TopoDS
    from OCP.TopTools import TopTools_IndexedMapOfShape, TopTools_ListOfShape

    def _vol(topods):
        p = GProp_GProps()
        BRepGProp.VolumeProperties_s(topods, p)
        return p.Mass()

    try:
        smap = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(shape.wrapped, TopAbs_SOLID, smap)
        solids = [TopoDS.Solid_s(smap.FindKey(i)) for i in range(1, smap.Extent() + 1)]
        if not solids:
            return shape
        vols = [_vol(s) for s in solids]
        if len(solids) == 1 and vols[0] >= 0:
            return shape  # a single right-side-out solid has nothing to unify

        fixed = []
        for s in solids:
            fx = ShapeFix_Solid(s)
            fx.Perform()
            out = fx.Solid()
            fixed.append(s if out.IsNull() else out)

        if len(fixed) == 1:
            merged = fixed[0]  # lone inside-out solid, righted above
        else:
            args = TopTools_ListOfShape()
            args.Append(fixed[0])
            tools = TopTools_ListOfShape()
            for s in fixed[1:]:
                tools.Append(s)
            op = BRepAlgoAPI_Fuse()
            op.SetArguments(args)
            op.SetTools(tools)
            op.Build()
            if not op.IsDone():
                return shape
            try:
                op.SimplifyResult()  # cosmetic: merge coplanar fuse splits
            except Exception:
                pass
            merged = op.Shape()
            if merged.IsNull():
                return shape

        cleaned = _wrap_topods(merged)
        if cleaned is None:
            return shape

        # Debris dropped here is ≤0.1% of the max constituent per chunk,
        # well inside tol_v below, so the bracket gate needs no adjustment.
        cleaned = _drop_debris(cleaned, debug=debug)

        # The union is at least the biggest constituent and at most their sum
        # (an inside-out duplicate contributes nothing; interpenetration is
        # counted once). Outside that bracket the fuse ate or invented
        # material. NOTE: shrinking from the input compound's naive GProp mass
        # is EXPECTED — that mass double-counts overlaps; the union is the
        # physically true volume.
        hi = sum(abs(v) for v in vols)
        lo = max(abs(v) for v in vols)
        tol_v = max(1.0, 0.01 * hi)
        v_after = cleaned.volume
        n_after = len(cleaned.solids())
        valid = BRepCheck_Analyzer(cleaned.wrapped).IsValid()
        if debug:
            print(f"unify: solids {len(solids)} -> {n_after}, "
                  f"vol {sum(vols):.2f} -> {v_after:.2f} "
                  f"(bracket {lo:.2f}..{hi:.2f}), valid {valid}")
        ok = (
            valid
            and 1 <= n_after <= len(solids)
            and lo - tol_v <= v_after <= hi + tol_v
            and v_after > 0
        )
        return cleaned if ok else shape
    except Exception:
        if debug:
            raise
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
# Untrusted-input guards (an import path or embedded BREP comes from a .sindri doc
# the user opened, which may be hostile). Caps bound the worst case BEFORE a heavy
# read/parse, so a crafted file can't OOM the worker or aim a parser fuzz at OCCT.
MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024   # reject any import file above this outright
MAX_IMPORT_SCAN_BYTES = 64 * 1024 * 1024    # decompressed ASCII-STL / 3MF scan window
MAX_BREP_BYTES = 64 * 1024 * 1024           # decoded embedded-BREP body cap
_BREP_MAGIC = b"CASCADE Topology V"         # OCCT ASCII BREP header signature


def _count_stream(fh, needle, limit, max_bytes=None):
    """Count `needle` occurrences in a binary stream WITHOUT loading it whole.
    Reads 1 MiB chunks; keeps a len(needle)-1 byte carry between chunks so a match
    straddling a chunk boundary counts exactly once (the carry is shorter than the
    needle, so it can't itself hold a match — no double counting). Stops as soon as
    the count exceeds `limit` (already over the import cap) or `max_bytes` are read,
    so an oversized ASCII STL / 3MF model can't be slurped into memory."""
    nlen = len(needle)
    count = 0
    total = 0
    carry = b""
    while True:
        chunk = fh.read(1 << 20)
        if not chunk:
            break
        total += len(chunk)
        buf = carry + chunk
        count += buf.count(needle)
        carry = buf[-(nlen - 1):] if nlen > 1 else b""
        if count > limit or (max_bytes is not None and total >= max_bytes):
            return count
    return count


def _peek_triangle_count(path, fmt):
    """Best-effort triangle count straight from the file, WITHOUT building a B-rep,
    so a too-dense import fails fast. Streams large files in chunks (stops past the
    cap) so a multi-GB ASCII STL or a lying-header 3MF can't be slurped into memory.
    Returns None when it can't tell."""
    cap = MAX_IMPORT_TRIANGLES
    try:
        if fmt == "stl":
            with open(path, "rb") as fh:
                head = fh.read(84)
            if head[:5].lower() == b"solid":
                with open(path, "rb") as fh:
                    return _count_stream(fh, b"facet normal", cap, MAX_IMPORT_SCAN_BYTES)
            import struct  # binary STL: uint32 triangle count at byte 80
            return struct.unpack("<I", head[80:84])[0]
        if fmt == "3mf":
            import zipfile
            with zipfile.ZipFile(path) as z:
                model = next((n for n in z.namelist() if n.lower().endswith(".model")), None)
                if not model:
                    return None
                # zip-bomb guard: the declared UNCOMPRESSED model size is in the
                # central directory (no decompress). If it's past the scan window,
                # return a sentinel above the cap so the caller rejects it.
                if z.getinfo(model).file_size > MAX_IMPORT_SCAN_BYTES:
                    return cap + 1
                with z.open(model) as fh:  # stream-decompress, bounded by max_bytes
                    return _count_stream(fh, b"<triangle", cap, MAX_IMPORT_SCAN_BYTES)
        if fmt == "obj":
            n = 0
            with open(path, "rb") as fh:
                for ln in fh:  # lazy line iteration, early-break past the cap
                    if ln.startswith(b"f "):
                        n += 1
                        if n > cap:
                            return n
            return n
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


def _canonicalize(shape, tol=1e-3):
    """Canonical-recognition pre-pass for B-rep imports (STEP): snap near-analytic
    B-spline/Bezier faces to true planes/cylinders/cones/spheres, and swept
    surfaces to elementary ones. STEP writers routinely emit splines for what is
    really a plane or cylinder; defeaturing heals by EXTENDING neighbour surfaces,
    and extension is exact on analytic surfaces but fragile polynomial
    extrapolation on splines — snapping at import is what lets Delete Face work
    on such models. Best-effort and hard-validated (same face/solid counts, valid
    B-rep, volume within 0.5%): any doubt → the original shape, unchanged.
    All-analytic imports return immediately."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType

    CONVERTIBLE = (
        GeomAbs_SurfaceType.GeomAbs_BSplineSurface,
        GeomAbs_SurfaceType.GeomAbs_BezierSurface,
        GeomAbs_SurfaceType.GeomAbs_SurfaceOfExtrusion,
        GeomAbs_SurfaceType.GeomAbs_SurfaceOfRevolution,
    )
    try:
        faces = shape.faces()
        if not any(
            BRepAdaptor_Surface(f.wrapped).GetType() in CONVERTIBLE for f in faces
        ):
            return shape
    except Exception:
        return shape

    try:
        from OCP.BRep import BRep_Tool
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_Sewing
        from OCP.BRepCheck import BRepCheck_Analyzer
        from OCP.BRepTools import BRepTools
        from OCP.ShapeCustom import ShapeCustom, ShapeCustom_Surface
        from OCP.ShapeFix import ShapeFix_Face, ShapeFix_Shape, ShapeFix_Solid
        from OCP.TopAbs import TopAbs_SHELL, TopAbs_WIRE
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopoDS import TopoDS

        # swept (extrusion/revolution) surfaces -> elementary, as a whole-shape
        # modifier that preserves topology
        work = _wrap_topods(ShapeCustom.SweptToElementary_s(shape.wrapped)) or shape

        converted = 0
        new_faces = []
        for f in work.faces():
            t = BRepAdaptor_Surface(f.wrapped).GetType()
            nf = f.wrapped
            if t in (
                GeomAbs_SurfaceType.GeomAbs_BSplineSurface,
                GeomAbs_SurfaceType.GeomAbs_BezierSurface,
            ):
                surf = BRep_Tool.Surface_s(f.wrapped)
                ana = ShapeCustom_Surface(surf).ConvertToAnalytical(tol, False)
                if ana is not None:
                    # rebuild the face on the analytic surface with the original
                    # wires; ShapeFix_Face re-projects the pcurves
                    outer = BRepTools.OuterWire_s(f.wrapped)
                    mf = BRepBuilderAPI_MakeFace(ana, outer)
                    wexp = TopExp_Explorer(f.wrapped, TopAbs_WIRE)
                    while wexp.More():
                        w = TopoDS.Wire_s(wexp.Current())
                        if not w.IsSame(outer):
                            mf.Add(w)
                        wexp.Next()
                    if mf.IsDone():
                        fix = ShapeFix_Face(mf.Face())
                        fix.Perform()
                        nf = fix.Face()
                        converted += 1
            new_faces.append(nf)
        if converted == 0:
            return work if work is not shape else shape

        sew = BRepBuilderAPI_Sewing(max(tol, 1e-6))
        for nf in new_faces:
            sew.Add(nf)
        sew.Perform()
        # the transferred wires still carry pcurves referencing the OLD spline
        # surfaces — ShapeFix_Shape re-projects them onto the analytic ones
        # (without it the result is an invalid solid with the wrong volume)
        fixer = ShapeFix_Shape(sew.SewedShape())
        fixer.Perform()
        solids = []
        exp = TopExp_Explorer(fixer.Shape(), TopAbs_SHELL)
        while exp.More():
            sf = ShapeFix_Solid()
            solids.append(Solid(sf.SolidFromShell(TopoDS.Shell_s(exp.Current()))))
            exp.Next()
        if not solids:
            return shape
        result = solids[0] if len(solids) == 1 else Compound(solids)
        ok = (
            len(solids) == max(1, len(shape.solids()))
            and len(result.faces()) == len(shape.faces())
            and BRepCheck_Analyzer(result.wrapped).IsValid()
            and abs(result.volume - shape.volume)
            <= max(1e-6, 0.005 * abs(shape.volume))
        )
        return result if ok else shape
    except Exception:
        return shape


def import_geometry(path, fmt):
    """Read an external geometry file and return the document payload for an
    `import` feature: {brep, solid, faces, name}. STL/3MF/OBJ are read as a
    (watertight) mesh solid; STEP/BREP come in as native B-rep."""
    fmt = (fmt or "").lower()
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    if size > MAX_IMPORT_FILE_BYTES:
        raise ValueError(
            f"file is {size / (1024 * 1024):.0f} MiB — too large to import "
            f"(limit {MAX_IMPORT_FILE_BYTES // (1024 * 1024)} MiB)."
        )
    if fmt in ("step", "stp"):
        # snap near-analytic spline faces to true planes/cylinders/… ONCE at
        # import, so the canonical form is baked into the embedded BREP
        shape = _canonicalize(import_step(path))
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
        # collapse facet debris (slivers + near-coplanar staircases) so the
        # import is genuinely editable — crisp faces, crisp edges (best-effort;
        # returns the input unchanged on any doubt)
        shape = _refacet_clean(shape)
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


# Optional progress hook (set by the server's worker init): called once per
# feature so the supervisor can kill on STALL rather than wall clock. Must
# never be able to break a rebuild.
on_feature_tick = None


@dataclass
class _RebuildCtx:
    """Bundle of the per-rebuild closures/containers a feature handler needs.
    Built ONCE per rebuild() call from the exact same locals the old inline
    if/elif chain closed over (new_body/active/require_active/find_body still
    close over `bodies` and the id `counter` — bundling them here is just a
    named handle onto that existing state, not new state)."""

    val: object            # resolve a parameter name to its value (or pass a literal through)
    datums: dict            # datumPlane feature id -> PlaneSpec
    sketches: dict          # sketch feature id -> {"sketch":, "faces":, "wire":, ...}
    bodies: list            # ordered [{id, name, shape}] — mutated in place by handlers
    diagnostics: object     # optional list; low-confidence selector-v2 resolutions append here
    hidden_bodies: frozenset  # bodies hidden by the document's LIVE visibility map
    new_body: object
    active: object
    require_active: object
    find_body: object


# --- feature handlers ---------------------------------------------------------
# One function per feature type, dispatched from the rebuild() loop below. Each
# handler is the exact body of the old inline if/elif branch (same logic, same
# comments, same error messages) — the loop still owns the try/except/errors.append
# and the no-op-continue semantics; handlers just raise like the old branches did.


def _handle_sketch(f, ctx):
    ctx.sketches[f["id"]] = _build_sketch(f, ctx.val, ctx.datums)


def _handle_datum_plane(f, ctx):
    # No geometry — register the (optionally offset) plane so sketches
    # / splits can reference it by id. Validate it resolves here so a
    # bad datum flags at its own feature. `offset` shifts the source
    # plane along its normal; we store the resolved offset plane.
    base = _plane_of(f["plane"], ctx.datums)
    off = f.get("offset") or 0
    origin = base.origin + base.z_dir * off
    ctx.datums[f["id"]] = {
        "origin": [origin.X, origin.Y, origin.Z],
        "xdir": [base.x_dir.X, base.x_dir.Y, base.x_dir.Z],
        "normal": [base.z_dir.X, base.z_dir.Y, base.z_dir.Z],
    }


def _handle_extrude(f, ctx):
    entry = ctx.sketches[f["sketch"]]
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
    solid = extrude(target, amount=ctx.val(f["distance"]))
    # Captured-visibility semantics: an extrude that carries
    # `hiddenBodies` uses THAT set (participants decided at feature
    # creation, MCAD-style — later eye toggles are pure display).
    # A legacy feature without the field keeps the old behavior:
    # gated by the document's live visibility map.
    hid = (
        frozenset(f["hiddenBodies"])
        if "hiddenBodies" in f
        else ctx.hidden_bodies
    )
    _boolean_into_bodies(ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, hid)


def _report_edge_failures(f, ctx, edges, try_one):
    """Failure-path-only probe for fillet/chamfer: which of `edges` fail the op
    INDIVIDUALLY? Appends an `edgeOpFailed` diagnostic naming the offenders'
    midpoints — or ALL members when every edge passes alone (the combination
    itself is the failure) — so the frontend can paint exactly those edges red.
    Bounded (skipped past 32 edges) and only ever paid AFTER the combined op
    already raised; the happy path stays a single OCCT build."""
    if ctx.diagnostics is None or len(edges) > 32:
        return
    failed = []
    for e in edges:
        try:
            try_one(e)
        except Exception:
            failed.append(e)
    probed = failed or edges
    from geom_select import _edge_mid

    def mid3(e):
        p = _edge_mid(e)
        return [round(float(p.X), 3), round(float(p.Y), 3), round(float(p.Z), 3)]

    ctx.diagnostics.append({
        "feature_id": f.get("id"),
        "kind": "edgeOpFailed",
        "resolved": len(edges),
        "confidence": 0.0,
        "lossy": True,
        "reason": "per-edge" if failed else "combination",
        "failed": [{"mid": mid3(e)} for e in probed],
    })


def _edge_identity(e):
    """A geometric fingerprint of a live edge, stable enough to RE-FIND it on a
    body whose topology changed underfoot (each fillet/chamfer renumbers and
    slightly reshapes neighbouring edges). Mirrors the fields `_edge_cost`
    scores, so the same weighting that resolves user selectors also re-matches
    an evolving body."""
    fp = {
        "mid": list(_edge_mid(e).to_tuple()),
        "dir": list(_edge_dir(e).to_tuple()),
    }
    try:
        fp["length"] = float(e.length)
    except Exception:
        pass
    cv = _edge_curve(e)
    if cv:
        fp["curve"] = cv
    if cv == "circle":
        r = _edge_radius(e)
        if r is not None:
            fp["radius"] = r
        c = _edge_center(e)
        if c is not None:
            fp["center"] = list(c.to_tuple())
    return fp


def _canonical_blend_key(fp):
    """Deterministic sort key for the sequential-blend order: the resolved edges'
    rounded-3dp midpoint (the generator's exact acceptance key), then direction,
    then length as tiebreakers. Merged-blend volumes are ORDER-DEPENDENT (adjacent
    fillets that fuse remove slightly different material per order, ~10%+ spread),
    so a fixed canonical order is what makes a full rebuild reproducible and keeps
    the removed volume matched to the reference. Midpoints are unique across every
    corpus edge set; direction/length only ever break a genuine coincident-midpoint
    tie."""
    mid = fp["mid"]
    d = fp.get("dir", (0.0, 0.0, 0.0))
    ln = fp.get("length", 0.0)
    return (
        round(mid[0], 3), round(mid[1], 3), round(mid[2], 3),
        round(d[0], 3), round(d[1], 3), round(d[2], 3),
        round(ln, 3),
    )


def _rematch_edge(shape, fp, max_mid_dist, tol_pos):
    """Find the edge on `shape` that is `fp`'s current incarnation, or None.

    A gate (`max_mid_dist`, scaled to the blend size) rejects everything the
    edge could NOT have drifted into — so if the edge genuinely vanished we
    return None and let the caller raise, rather than silently blending the
    wrong edge. Among the survivors we pick the lowest `_edge_cost`, the exact
    scorer the selector resolver trusts."""
    mid = Vector(*fp["mid"])
    cands = [e for e in shape.edges() if (_edge_mid(e) - mid).length <= max_mid_dist]
    if not cands:
        return None
    return min(cands, key=lambda e: _edge_cost(e, fp, tol_pos))


def _sequential_blend(shape, edges, apply_one, blend_size, diag_part):
    """Fallback for a combined fillet/chamfer that OCCT rejected: apply the
    blend to ONE edge at a time on the evolving body. Filleting an edge lets
    the kernel settle that surface before the next, which succeeds on
    reflex/tight-clearance sets the single combined call cannot solve.

    Edges are applied in a CANONICAL order (rounded-midpoint, see
    _canonical_blend_key). Because overlapping blends fuse into order-dependent
    solids, this fixed order is what makes a rebuild deterministic and its
    removed volume reproducible. Multi-pass to a fixpoint: a straggler that
    fails early is retried after its neighbours have blended (more material
    around a reflex edge can make it buildable), with canonical order preserved
    among the remaining edges each pass. Every remaining edge is re-found by
    geometric identity each step (topology renumbers under us). Returns
    (new_shape, unresolved_original_edges); the caller enforces the
    all-or-nothing product rule.

    `apply_one(shape, edge) -> new_shape` runs the actual kernel op.
    """
    # Fingerprint every target up front, on the ORIGINAL body, before anything
    # moves — then fix the canonical application order once.
    pending = [(e, _edge_identity(e)) for e in edges]
    pending.sort(key=lambda t: _canonical_blend_key(t[1]))
    # Positional gate: an edge shortened by a neighbouring blend shifts its
    # midpoint by at most ~blend_size; add the resolver's baseline drift budget.
    base = POS_DRIFT + REL_DRIFT * _bbox_diag(diag_part)
    max_mid_dist = 1.5 * float(blend_size) + base
    tol_pos = max(base, float(blend_size))

    current = shape
    progressed = True
    while pending and progressed:
        progressed = False
        still = []
        for orig, fp in pending:
            target = _rematch_edge(current, fp, max_mid_dist, tol_pos)
            if target is None:
                still.append((orig, fp))
                continue
            try:
                current = apply_one(current, target)
                progressed = True
            except Exception:
                still.append((orig, fp))
        pending = still
    return current, [orig for orig, _ in pending]


def _handle_fillet(f, ctx):
    act = ctx.require_active("Fillet")
    edges = resolve_edges(act["shape"], f["edges"], diag=ctx.diagnostics, feature_id=f.get("id"))
    if not edges:
        raise ValueError("no edge found to fillet")
    r = ctx.val(f["radius"])
    try:
        act["shape"] = fillet(edges, radius=r)
        return
    except Exception as combined_err:
        # Combined call failed: fall back to per-edge blending on the evolving body.
        result, unresolved = _sequential_blend(
            act["shape"], edges, lambda s, e: fillet([e], radius=r), r, act["shape"]
        )
        if unresolved:
            # Hard no-silent-degradation rule: any edge we could not blend means
            # the feature FAILS — never a partial solid, never a smaller radius.
            # Paint exactly the offenders red, then re-raise the original error.
            _report_edge_failures(f, ctx, unresolved, lambda e: fillet([e], radius=r))
            raise combined_err
        act["shape"] = result


def _handle_chamfer(f, ctx):
    act = ctx.require_active("Chamfer")
    edges = resolve_edges(act["shape"], f["edges"], diag=ctx.diagnostics, feature_id=f.get("id"))
    if not edges:
        raise ValueError("no edge found to chamfer")
    d = ctx.val(f["distance"])
    try:
        act["shape"] = chamfer(edges, length=d)
        return
    except Exception as combined_err:
        # Combined call failed: fall back to per-edge blending on the evolving body.
        result, unresolved = _sequential_blend(
            act["shape"], edges, lambda s, e: chamfer([e], length=d), d, act["shape"]
        )
        if unresolved:
            _report_edge_failures(f, ctx, unresolved, lambda e: chamfer([e], length=d))
            raise combined_err
        act["shape"] = result


def _handle_press_pull(f, ctx):
    # target the body that OWNS the picked face (sent by the tool),
    # not just the active body — so press/pull on a multi-body model
    # modifies the right body.
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Press/Pull")
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
        # Point picks resolve GLOBALLY: the target only contributes
        # a PLANE, so "extrude until it meets that other part" is
        # legitimate — the user may aim at a face of ANY body.
        tf = None
        pt = (
            up.get("point")
            if isinstance(up, dict) and up.get("by") == "nearest"
            else None
        )
        if pt is not None:
            p = Vector(*pt)
            best = None
            for b in ctx.bodies:
                if b.get("shape") is None:
                    continue
                for fc in _as_compound(b["shape"]).faces():
                    dd_ = fc.distance_to(p)
                    if best is None or dd_ < best[0]:
                        best = (dd_, fc)
            if best is not None:
                tf = [best[1]]
        if tf is None:
            tf = resolve_faces(act["shape"], up, diag=ctx.diagnostics, feature_id=f.get("id"))
        if not tf:
            raise ValueError("Press/Pull: the 'up to' target surface wasn't found")
        tgt_pt, tgt_n = tf[0].center(), tf[0].normal_at()
    dist = ctx.val(f["distance"])
    for sel in sels:
        found = resolve_faces(act["shape"], sel, diag=ctx.diagnostics, feature_id=f.get("id"))
        if not found:
            raise ValueError("no face found to press/pull")
        src = found[0]
        d = _distance_to_target(src, tgt_pt, tgt_n) if up else dist
        # up-to distances are exact by construction — the inward
        # clamp would silently stop short of the chosen target
        act["shape"] = _press_pull(act["shape"], src, d, clamp=(not up))


def _handle_delete_face(f, ctx):
    # Remove the picked face(s) and heal the solid (defeaturing) — deletes
    # an imported chamfer/fillet or a protrusion, where there's no feature
    # to remove. Parametric: the face selector re-resolves each rebuild.
    # Body ids are POSITIONAL — an upstream split/combine renumbers them,
    # silently re-aiming a saved deleteFace at the wrong piece (its nearest
    # match is then some distant face; the delete fails or worse). So
    # nearest-point picks resolve GLOBALLY: the face nearest the recorded
    # point wins across ALL bodies, and a win on a different body than the
    # named one re-targets there with a lossy diagnostic.
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Delete Face")
    sels = f["face"] if isinstance(f["face"], list) else [f["face"]]
    act, faces = _retarget_delete_faces(
        act, ctx.bodies, sels, ctx.diagnostics, f.get("id")
    )
    if act is None:
        raise ValueError("Delete Face: the target body no longer exists")
    if not faces:
        raise ValueError("no face found to delete")
    act["shape"] = _defeature(act["shape"], faces)


def _handle_clean_up(f, ctx):
    # Repair boolean rot on a body, exposed as a PARAMETRIC feature
    # because downstream booleans re-manufacture it: first collapse
    # per-solid facet debris (slivers + near-coplanar staircases,
    # the same pass that runs at mesh import), then
    # unify the body's glued/overlapping solids (_unify_body — joins
    # of ragged bodies GLUE solids together instead of merging
    # them). Order matters: fusing the raw sliver-ridden solids
    # collapses to garbage (which the unify gates refuse), while the
    # refacet-cleaned solids fuse cleanly — measured on the DDR
    # document. Both best-effort: a body that can't confidently be
    # cleaned stays unchanged.
    targets = (
        [ctx.find_body(f["body"])] if f.get("body") else list(ctx.bodies)
    )
    for tb in targets:
        if tb is not None and tb.get("shape") is not None:
            tb["shape"] = _unify_body(
                _refacet_clean(
                    tb["shape"], tol=ctx.val(f.get("tolerance", 0.12))
                )
            )
        elif f.get("body"):
            # named body no longer exists (upstream removal/split
            # renumbered it) — a legitimate no-op, not a hard error
            _skip_feature(ctx.diagnostics, f, "cleanUp", "target body already consumed or missing")


def _handle_mirror(f, ctx):
    act = ctx.require_active("Mirror")
    act["shape"] = act["shape"] + mirror(act["shape"], about=_plane_of(f["plane"], ctx.datums))


def _handle_revolve(f, ctx):
    sk = ctx.sketches[f["sketch"]]["sketch"]
    solid = revolve(
        sk,
        axis=AXES[f.get("axis", "Z")],
        revolution_arc=ctx.val(f.get("angle", 360)),
    )
    _boolean_into_bodies(ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, ctx.hidden_bodies)


def _handle_loft(f, ctx):
    solid = loft([ctx.sketches[s]["sketch"] for s in f["sketches"]])
    _boolean_into_bodies(ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, ctx.hidden_bodies)


def _handle_sweep(f, ctx):
    prof = ctx.sketches[f["profile"]]["sketch"]
    if prof is None:
        raise ValueError("sweep profile has no closed section")
    path = ctx.sketches[f["path"]].get("wire")
    if path is None:
        raise ValueError("sweep path sketch has no curve to follow")
    solid = sweep(sections=prof, path=path)
    # Same New/Join/Cut boolean path as extrude/revolve/loft: booleans against
    # every visible overlapping body, with the loud no-op guards. (Sweep used to
    # inline `act["shape"] + solid` / `- solid` against only the active body —
    # unguarded, and a Cut with no active body silently created a new body.)
    _boolean_into_bodies(ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, ctx.hidden_bodies)


def _handle_import(f, ctx):
    base = f.get("name") or "Imported"
    shape = _brep_b64_to_shape(f["brep"])
    # explode:false keeps a multi-solid payload as ONE body. For imported
    # assemblies with hundreds of import features this divides body count
    # (browser tree entries, per-body payloads, draw calls) by the average
    # solids-per-import. Default (absent/true) keeps the historical
    # one-body-per-solid behavior.
    if f.get("explode") is False:
        ctx.new_body(shape, base)
        return
    parts = _explode_solids(shape)
    if len(parts) == 1:
        ctx.new_body(parts[0], base)
    else:
        for part_no, p in enumerate(parts, 1):
            ctx.new_body(p, f"{base} {part_no}")


def _handle_box(f, ctx):
    ctx.new_body(Box(ctx.val(f["length"]), ctx.val(f["width"]), ctx.val(f["height"])), "Box")


def _handle_cylinder(f, ctx):
    ctx.new_body(Cylinder(ctx.val(f["radius"]), ctx.val(f["height"])), "Cylinder")


def _handle_sphere(f, ctx):
    ctx.new_body(Sphere(ctx.val(f["radius"])), "Sphere")


def _handle_shell(f, ctx):
    act = ctx.require_active("Shell")
    openings = resolve_faces(act["shape"], f["faces"], diag=ctx.diagnostics, feature_id=f.get("id")) if f.get("faces") else []
    act["shape"] = _shell(act["shape"], ctx.val(f["thickness"]), openings)


def _handle_draft(f, ctx):
    act = ctx.require_active("Draft")
    faces = resolve_faces(act["shape"], f["faces"], diag=ctx.diagnostics, feature_id=f.get("id"))
    if not faces:
        raise ValueError("no face found to draft")
    act["shape"] = _draft(act["shape"], faces, ctx.val(f["angle"]), f.get("axis", "Z"))


def _handle_pattern_rect(f, ctx):
    act = ctx.require_active("Pattern")
    act["shape"] = _pattern_rect(
        act["shape"], ctx.val(f["countX"]), ctx.val(f["countY"]), ctx.val(f["spacingX"]), ctx.val(f["spacingY"])
    )


def _handle_pattern_circular(f, ctx):
    act = ctx.require_active("Pattern")
    act["shape"] = _pattern_circular(
        act["shape"], ctx.val(f["count"]), ctx.val(f.get("angle", 360)), f.get("axis", "Z")
    )


def _handle_simplify_mesh(f, ctx):
    act = ctx.require_active("Simplify Mesh")
    act["shape"] = _simplify_mesh(act["shape"], ctx.val(f.get("tolerance", 1)))


def _handle_scale(f, ctx):
    act = ctx.require_active("Scale")
    act["shape"] = scale(act["shape"], by=ctx.val(f.get("factor", 1)))


def _handle_move(f, ctx):
    rx, ry, rz = ctx.val(f.get("rx", 0)), ctx.val(f.get("ry", 0)), ctx.val(f.get("rz", 0))
    dx, dy, dz = ctx.val(f.get("dx", 0)), ctx.val(f.get("dy", 0)), ctx.val(f.get("dz", 0))
    ids = f.get("bodies")
    targets = [ctx.find_body(b) for b in ids] if ids else [ctx.require_active("Move")]
    for tgt in targets:
        if tgt is None:
            # stale id (upstream body removal/split renumbered it) —
            # a legitimate no-op, not a hard error
            _skip_feature(ctx.diagnostics, f, "move", "target body already consumed or missing")
            continue
        sh = tgt["shape"]
        # A disjoint body is a build123d ShapeList (no single `.wrapped`);
        # Rot/Pos (Location.__mul__) only accept ONE Shape, so normalize to
        # a Compound first — else "other must be a list of Locations".
        if sh is not None and _wrapped_or_none(sh) is None:
            sh = Compound(list(sh))
        if rx or ry or rz:
            sh = Rot(rx, ry, rz) * sh
        if dx or dy or dz:
            sh = Pos(dx, dy, dz) * sh
        tgt["shape"] = sh


def _handle_split(f, ctx):
    _do_split(f, ctx.bodies, ctx.find_body, ctx.active, ctx.new_body, ctx.datums)


def _handle_combine(f, ctx):
    _do_combine(f, ctx.bodies, ctx.find_body, diag=ctx.diagnostics)


def _handle_remove_body(f, ctx):
    # delete bodies by id (mainstream MCAD "Remove"); drop them from the list so
    # they're not tessellated/exported. Unknown ids are silently ignored.
    ids = set(f.get("bodies") or [])
    ctx.bodies[:] = [b for b in ctx.bodies if b["id"] not in ids]


# type string -> handler. Unknown types are NOT in this dict — the rebuild loop
# below raises the exact same "unknown feature type" ValueError the old trailing
# `else` branch did.
_FEATURE_HANDLERS = {
    "sketch": _handle_sketch,
    "datumPlane": _handle_datum_plane,
    "extrude": _handle_extrude,
    "fillet": _handle_fillet,
    "chamfer": _handle_chamfer,
    "press-pull": _handle_press_pull,
    "deleteFace": _handle_delete_face,
    "cleanUp": _handle_clean_up,
    "mirror": _handle_mirror,
    "revolve": _handle_revolve,
    "loft": _handle_loft,
    "sweep": _handle_sweep,
    "import": _handle_import,
    "box": _handle_box,
    "cylinder": _handle_cylinder,
    "sphere": _handle_sphere,
    "shell": _handle_shell,
    "draft": _handle_draft,
    "patternRect": _handle_pattern_rect,
    "patternCircular": _handle_pattern_circular,
    "simplifyMesh": _handle_simplify_mesh,
    "scale": _handle_scale,
    "move": _handle_move,
    "split": _handle_split,
    "combine": _handle_combine,
    "removeBody": _handle_remove_body,
}


def rebuild(document, diagnostics=None, resume=None, snapshots_out=None, persist=None):
    """Return (part, errors, bodies).

    part    : the merged build123d solid/compound of all bodies, or None.
    errors  : list of {feature_id, message}; a failing feature is recorded as a
              NO-OP and the build CONTINUES (MCAD-style — the timeline flags
              the feature red but everything after it still runs; one
              permanently-failing feature must not kill the rest of the
              document).
    bodies  : ordered list of {id, name, shape} — one per live body (for per-body
              tessellation and the browser tree).

    diagnostics : optional list; when given, low-confidence selector-v2 (`by:"match"`)
              resolutions append a ResolveDiag dict to it. Resolution is best-effort
              and never fails the build on a shaky match, so callers that don't pass a
              list are completely unaffected.

    Incremental-rebuild hooks (both default off → identical to a plain full rebuild):
      resume        : (start_index, snapshot) — restore the build state captured
                      after feature[start_index-1] and run only features[start_index:].
      snapshots_out : if a list is given, append (feature_index, snapshot) after each
                      successfully-built feature, so a caller can cache per-feature
                      state and resume from the longest unchanged prefix next time.
    A snapshot copies the body dicts (sharing OCCT shape refs — no geometry copy) plus
    the sketches/datums/id-counter, and is restored by mutating those containers IN
    PLACE so the new_body/active/find_body closures stay bound to them.
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

    def _snapshot():
        """Capture the build state after a feature. Body dicts are copied (so later
        in-place mutation `b["shape"]=…` can't corrupt the snapshot) but SHARE the
        OCCT shape refs — no geometry is copied. sketches/errors are APPEND-ONLY
        write-once registries within a run, so a snapshot stores a REFERENCE to the
        run's registry plus a high-water mark; _restore copies the prefix below the
        mark once. Copying whole registries per snapshot was O(N²) over a rebuild."""
        return {
            "bodies": [dict(b) for b in bodies],
            "sketches_ref": sketches, "n_sketches": len(sketches),
            "datums": {k: dict(v) for k, v in datums.items()},
            "n": counter["n"],
            # errors travel with the snapshot: an incremental resume PAST a failed
            # feature must still re-report its error (else the banner would clear
            # while the feature is still broken)
            "errors_ref": errors, "n_errors": len(errors),
        }

    def _restore(snap):
        """Restore a snapshot by mutating the state containers IN PLACE (never
        rebinding) so the closures above keep working."""
        bodies[:] = [dict(b) for b in snap["bodies"]]
        sk_src = snap["sketches_ref"]
        if sk_src is not sketches:
            sketches.clear()
            for k in list(sk_src.keys())[: snap["n_sketches"]]:
                sketches[k] = sk_src[k]
        else:
            for k in list(sketches.keys())[snap["n_sketches"]:]:
                del sketches[k]
        datums.clear(); datums.update({k: dict(v) for k, v in snap["datums"].items()})
        counter["n"] = snap["n"]
        err_src = snap["errors_ref"]
        if err_src is not errors:
            errors[:] = [dict(e) for e in err_src[: snap["n_errors"]]]
        else:
            del errors[snap["n_errors"]:]

    features = document.get("features", [])
    start = 0
    if resume is not None:
        start, snap = resume
        _restore(snap)
        if snap.get("replay_sketches") and start > 0:
            # disk checkpoints persist bodies/datums/errors but NOT the sketch
            # registry (build123d rehydration is unproven; sketches are cheap:
            # 0.19 s total on the 125-feature doc). Replay them instead — sound
            # because _build_sketch reads only params + the datums registry
            # (write-once, id-keyed, fully restored), never body geometry.
            for f2 in features[:start]:
                if f2.get("type") == "sketch":
                    try:
                        sketches[f2["id"]] = _build_sketch(f2, val, datums)
                    except Exception:
                        pass  # its failure is already in the restored errors

    # One context, built once per rebuild, handed to every feature handler below
    # (see _RebuildCtx) — bundles the exact closures/containers the old inline
    # if/elif chain closed over.
    ctx = _RebuildCtx(
        val=val, datums=datums, sketches=sketches, bodies=bodies,
        diagnostics=diagnostics, hidden_bodies=hidden_bodies,
        new_body=new_body, active=active, require_active=require_active,
        find_body=find_body,
    )

    for i in range(start, len(features)):
        f = features[i]
        t_feat = time.monotonic()
        # provenance: capture each body's shape identity + owner map before the
        # feature, so afterwards we can attribute newly-created faces to it.
        # sketch/datumPlane never touch bodies — skip capture AND attribution
        # for them (the eager owners merge alone was O(total faces) per feature,
        # 12.7% of a cold rebuild). The merged view is a lazy ChainMap over the
        # per-body dicts; reversed so duplicate fingerprints resolve like the
        # old last-body-wins dict.update() merge.
        prov = f.get("type") not in ("sketch", "datumPlane")
        if prov:
            pre_shape = {id(b): b.get("shape") for b in bodies}
            pre_owners_by_id = {id(b): (b.get("_owners") or {}) for b in bodies}
            pre_owners_all = ChainMap(*reversed(list(pre_owners_by_id.values())))
        try:
            t = f["type"]
            handler = _FEATURE_HANDLERS.get(t)
            if handler is None:
                raise ValueError(f"unknown feature type: {t}")
            handler(f, ctx)

        except ValueError as ex:  # name the feature so the timeline can flag it red
            # MCAD-style: a failed feature is a recorded NO-OP and the build
            # CONTINUES — the body state stays as it was and every feature after
            # it still runs. (It used to `break` here: one permanently-failing
            # feature — e.g. a deleteFace OCCT can't heal — silently killed the
            # whole downstream timeline, so nothing the user added after it ever
            # executed.) Owner attribution is skipped for the failed feature.
            # ValueErrors are hand-authored for users ("no edge found to
            # fillet", …) — surface them verbatim.
            errors.append({"feature_id": f.get("id"), "message": str(ex)})
        except Exception as ex:
            # Anything NOT a hand-authored ValueError is an unexpected internal
            # failure (OCCT crash, KeyError, …) — the raw message is meaningless
            # to a user, so surface the feature + exception type instead and log
            # the full traceback to stderr for debugging.
            label = f.get("name") or f.get("type") or "feature"
            print(f"feature {f.get('id')} ({label}) failed:", file=sys.stderr)
            traceback.print_exc()
            errors.append(
                {
                    "feature_id": f.get("id"),
                    "message": f"{label} failed ({type(ex).__name__})",
                }
            )
        else:
            if prov:
                _update_owners(f, val, bodies, pre_shape, pre_owners_by_id, pre_owners_all)
        if snapshots_out is not None:  # cache point: state after this feature
            snapshots_out.append((i, _snapshot()))
        if persist is not None:
            _persist_tick(
                persist, i, time.monotonic() - t_feat, bodies, datums, errors, counter
            )
        if on_feature_tick is not None:
            try:
                on_feature_tick(i)
            except Exception:
                pass

    # A disjoint join (e.g. two bodies that don't touch) yields a ShapeList, which
    # has no single `.wrapped` TopoDS shape. Normalize each body to one Compound so
    # every consumer (tessellate/bbox/edges/export) gets a uniform Shape.
    out_bodies = []
    for b in bodies:
        sh = b["shape"]
        if sh is not None and _wrapped_or_none(sh) is None:
            sh = Compound(list(sh))
        if sh is not None:
            # final pass only — mid-timeline drops would shift downstream
            # geometric selectors and delete chips a later join re-absorbs
            sh = _drop_debris(sh)
        out_bodies.append({"id": b["id"], "name": b["name"], "shape": sh,
                           "owners": b.get("_owners") or {}})

    shapes = [b["shape"] for b in out_bodies if b["shape"] is not None]
    if not shapes:
        part = None
    elif len(shapes) == 1:
        part = shapes[0]
    else:
        part = Compound(shapes)

    return part, errors, out_bodies


# --- incremental rebuild cache (persistent-worker-local) --------------------
# The sidecar runs one long-lived worker process, so a per-feature snapshot cache
# lives in its module memory and survives between rebuilds. On a worker respawn
# (25 s timeout / kernel crash → the pool recreates the worker) this module reloads
# and the cache is empty, so recovery is a clean full rebuild. Only rebuild_cached()
# touches it; plain rebuild() (used by export/interference) is unaffected.
_CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}


# import features embed multi-MB BREP b64 — hashing it once per (feature id,
# size, head, tail) instead of json.dumps-ing it into every signature keeps
# per-edit sig work O(doc structure), not O(embedded geometry)
_IMPORT_BREP_SIGS = {}


def _feature_sig(f):
    if f.get("type") == "import" and isinstance(f.get("brep"), str):
        b = f["brep"]
        mk = (f.get("id"), len(b), b[:64], b[-64:])
        h = _IMPORT_BREP_SIGS.get(mk)
        if h is None:
            h = hashlib.blake2b(b.encode(), digest_size=16).hexdigest()
            _IMPORT_BREP_SIGS[mk] = h
        g = dict(f)
        g["brep"] = h
        return json.dumps(g, sort_keys=True, separators=(",", ":"))
    return json.dumps(f, sort_keys=True, separators=(",", ":"))


def _global_sig(document):
    # params affect features globally. Body visibility only gates LEGACY extrude
    # booleans (features without a captured `hiddenBodies` set) — when every
    # extrude carries its own set, an eye toggle changes NO geometry and must
    # not invalidate the cache (it used to force a full rebuild per click).
    legacy_vis = any(
        f.get("type") == "extrude" and "hiddenBodies" not in f
        for f in document.get("features", [])
    )
    return json.dumps(
        {
            "p": document.get("parameters", {}),
            "v": document.get("bodyVisibility", {}) if legacy_vis else None,
        },
        sort_keys=True, separators=(",", ":"),
    )


# --- durable checkpoint cache (proving-ground/rebuild-scaling-design-2026-07-03.md §3) ---
#
# Chain keys are INPUT-addressed: key_i = H(key_{i-1} ‖ feature_sig_i), seeded with
# H(env_sig ‖ global_sig). Geometry is never hashed, so OCCT float nondeterminism
# can't poison a key; a chain key found on disk proves the entire document prefix
# (and params/visibility/env) that produced it is byte-identical — exactly the
# validity condition of today's RAM prefix cache. Phase 1 changes durability only,
# not invalidation semantics. Restores are verified against per-body fingerprints
# (face count / volume / bbox): any divergence is a cache MISS, never wrong geometry.

_ENV_SIG = None


def _env_sig():
    """Hash of everything outside the document that shapes geometry: kernel/library
    versions + the sidecar's own geometry source files. Automatic and conservative —
    any builder change costs one cold rebuild per doc instead of risking stale
    geometry from a forgotten manual version bump. SINDRI_ENV_SIG overrides for dev."""
    global _ENV_SIG
    if _ENV_SIG is None:
        forced = os.environ.get("SINDRI_ENV_SIG")
        if forced:
            _ENV_SIG = forced
        else:
            h = hashlib.blake2b(digest_size=16)
            try:
                import OCP
                h.update(getattr(OCP, "__version__", "?").encode())
            except Exception:
                pass
            try:
                import build123d as _b3d
                h.update(getattr(_b3d, "__version__", "?").encode())
            except Exception:
                pass
            here = os.path.dirname(os.path.abspath(__file__))
            for name in ("builder.py", "geom_select.py", "tessellate.py", "selector_tuning.json"):
                try:
                    with open(os.path.join(here, name), "rb") as fh:
                        h.update(fh.read())
                except OSError:
                    pass
            _ENV_SIG = h.hexdigest()
    return _ENV_SIG


# --- P3: scoped invalidation (design §5 Phase 3) ----------------------------
# The durable chain keys scope params (and, for the features that consult it,
# visibility) PER FEATURE instead of poisoning key_0: a parameter edit then
# invalidates only from the first feature whose expressions (transitively)
# reference it, and a visibility toggle only from the first extrude — both were
# full cold rebuilds before. Conservative by construction: the reference scan
# is a word-boundary superset (a body name that happens to equal a param name
# merely over-invalidates, never under). The RAM cache keeps the old
# whole-document _global_sig semantics untouched; on its (now more frequent)
# miss the disk chain simply resumes deeper.

_IDENT_RE = None


def _param_closure(params):
    """name -> the set of param names its raw value transitively references."""
    import re
    global _IDENT_RE
    if _IDENT_RE is None:
        _IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
    names = set(params)
    deps = {
        n: (set(_IDENT_RE.findall(v)) & names) if isinstance(v, str) else set()
        for n, v in params.items()
    }
    closed = {}

    def close(n, seen):
        if n in closed:
            return closed[n]
        if n in seen:
            return {n}  # cycle guard — self-set, still conservative
        out = {n}
        for d in deps[n]:
            out |= close(d, seen | {n})
        closed[n] = out
        return out

    return {n: close(n, set()) for n in names}


def _feature_scope(f, params, closure, hidden_json):
    """The per-feature invalidation scope string: raw values of every param the
    feature's strings (transitively) reference, plus the hidden-body set for
    feature types that consult visibility (extrude booleans)."""
    refs = set()

    def walk(v):
        if isinstance(v, str):
            if len(v) <= 256:  # embedded BREP b64 etc. can't reference params
                refs.update(_IDENT_RE.findall(v))
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(f)
    used = set()
    hit = refs & set(params)
    for r in hit:
        used |= closure[r]
    scope = json.dumps(
        {n: params[n] for n in sorted(used)}, sort_keys=True, separators=(",", ":")
    )
    if f.get("type") == "extrude" and "hiddenBodies" not in f:
        # legacy extrude only: gated by the LIVE visibility map, so the map is
        # part of its invalidation scope. A captured-visibility extrude carries
        # hiddenBodies in its own signature and ignores the live map entirely.
        scope += "|" + hidden_json
    return scope


# Identity-keyed memos for per-feature signature/scope work. With the delta
# wire protocol the worker holds ONE document object and patches it, so an
# unchanged feature keeps its exact dict object across edits — id() identity is
# a sound memo key as long as the entry also pins the object (so the id can't
# be recycled). Rebuilt each pass, so they never outgrow the current document.
_SIG_MEMO = {}
_SCOPE_MEMO = {}


def _feature_sigs(features):
    """Per-feature sigs with identity memoization: json.dumps runs only for
    features whose dict object actually changed since the last rebuild."""
    global _SIG_MEMO
    new_memo = {}
    sigs = []
    for f in features:
        ent = _SIG_MEMO.get(id(f))
        s = ent[1] if (ent is not None and ent[0] is f) else _feature_sig(f)
        new_memo[id(f)] = (f, s)
        sigs.append(s)
    _SIG_MEMO = new_memo
    return sigs


def _chain_keys_scoped(document, feature_sigs):
    """Input-addressed chain keys with P3 scoping: key_0 = H(env) only; each
    key_i folds in the feature's sig + its param/visibility scope."""
    global _SCOPE_MEMO
    params = document.get("parameters", {}) or {}
    closure = _param_closure(params)
    vis = document.get("bodyVisibility", {}) or {}
    hidden_json = json.dumps(sorted(k for k, v in vis.items() if v is False))
    pkey = json.dumps(params, sort_keys=True, separators=(",", ":"))
    k = hashlib.blake2b(_env_sig().encode(), digest_size=16).hexdigest()
    keys = []
    new_memo = {}
    for f, s in zip(document.get("features", []), feature_sigs):
        ent = _SCOPE_MEMO.get(id(f))
        if ent is not None and ent[0] is f and ent[1] == pkey and ent[2] == hidden_json:
            scope = ent[3]
        else:
            scope = _feature_scope(f, params, closure, hidden_json)
        new_memo[id(f)] = (f, pkey, hidden_json, scope)
        k = hashlib.blake2b((k + s + scope).encode(), digest_size=16).hexdigest()
        keys.append(k)
    _SCOPE_MEMO = new_memo
    return keys


def _disk_store():
    """The geomstore singleton, or None when disabled (SINDRI_DISK_CACHE=0) or
    unavailable. Never raises: the disk cache is advisory by design."""
    if os.environ.get("SINDRI_DISK_CACHE", "1") == "0":
        return None
    try:
        import geomstore
        return geomstore.default_store()
    except Exception:
        return None


def _body_fingerprint(shape):
    """Cheap identity check for a restored body (design §3.3): face/edge/vertex counts
    + volume + bbox. BinTools preserves doubles exactly, so comparison is tight; a
    mismatch means the restore diverged and the checkpoint is treated as a miss. The
    exact edge/vertex counts catch a same-volume/same-bbox but topologically different
    solid that the aggregate volume/bbox alone would wave through (they are deterministic
    integers, so they never cause a false miss on OCCT float noise)."""
    bb = shape.bounding_box()
    return {
        "f": len(shape.faces()),
        "e": len(shape.edges()),
        "vx": len(shape.vertices()),
        "v": round(shape.volume, 6),
        "b": [round(x, 4) for x in (bb.min.X, bb.min.Y, bb.min.Z,
                                    bb.max.X, bb.max.Y, bb.max.Z)],
    }


def _blob_key(chain_key, body_id):
    """One feature can modify SEVERAL bodies (extrude-cut across overlapping
    bodies, combine): the chain key alone would collide their blobs and the
    dedup skip in put_blob would silently keep only the first one written
    (caught by the restore fingerprint guard). Mix the body id in."""
    return hashlib.blake2b(
        (chain_key + ":" + str(body_id)).encode(), digest_size=16
    ).hexdigest()


def _persist_tick(persist, i, dt_s, bodies, datums, errors, counter):
    """Per-feature bookkeeping for the durable cache: track each body's
    last-modifying chain key (shape-identity comparison, O(bodies)), and drop a
    budget-spaced checkpoint when accumulated replay cost since the last one
    exceeds the budget (~1 s). Written DURING the loop on purpose: a timeout or
    crash then loses at most one budget's worth of work (the ratchet)."""
    keys = persist["keys"]
    mod = persist["mod"]
    for b in bodies:
        cur = mod.get(b["id"])
        sh = b.get("shape")
        if cur is None or cur[0] is not sh:
            mod[b["id"]] = (sh, _blob_key(keys[i], b["id"]))
    persist["acc_ms"] += dt_s * 1000.0
    if persist["acc_ms"] < persist.get("budget_ms", 1000.0):
        return
    _save_checkpoint(persist, i, bodies, datums, errors, counter["n"])


def _save_checkpoint(persist, i, bodies, datums, errors, counter_n):
    """Best-effort: a cache write failure must never break a rebuild."""
    try:
        store, keys, mod = persist["store"], persist["keys"], persist["mod"]
        manifest, fps, owners = [], [], {}
        for b in bodies:
            sh = b.get("shape")
            if sh is None or _wrapped_or_none(sh) is None:
                manifest.append({"body_id": b["id"], "name": b["name"], "blob_key": None})
                fps.append(None)
                continue
            blob_key = (mod.get(b["id"]) or (None, _blob_key(keys[i], b["id"])))[1]
            store.put_blob(blob_key, sh)
            manifest.append({"body_id": b["id"], "name": b["name"], "blob_key": blob_key})
            fps.append(_body_fingerprint(sh))
            owners[b["id"]] = [[list(k), v] for k, v in (b.get("_owners") or {}).items()]
        state = json.dumps({
            "datums": datums,
            "errors": errors,
            "n": counter_n,
            "owners": owners,
            "fps": fps,
        })
        store.save_checkpoint(keys[i], i, manifest, state, persist["acc_ms"])
        persist["acc_ms"] = 0.0
    except Exception:
        pass


def _restore_from_disk(store, chain_keys):
    """Find the deepest restorable checkpoint for this exact document prefix and
    reconstruct a resume snapshot from it. Returns (start_index, snapshot, mod_map)
    or None. Every failure path — missing blob, fingerprint mismatch, bad JSON —
    returns None (cache miss), never partial state."""
    try:
        cp = store.find_checkpoint(chain_keys)
        if cp is None:
            return None
        state = json.loads(cp["state_json"])
        bodies = []
        mod = {}
        for ent, fp in zip(cp["manifest"], state["fps"]):
            if ent["blob_key"] is None:
                bodies.append({"id": ent["body_id"], "name": ent["name"],
                               "shape": None, "_owners": {}})
                continue
            raw = store.get_blob(ent["blob_key"])
            if raw is None:
                return None
            shape = _wrap_topods(raw)
            if shape is None:
                return None
            got = _body_fingerprint(shape)
            if (got["f"] != fp["f"]
                    or abs(got["v"] - fp["v"]) > max(1e-4, 1e-6 * abs(fp["v"]))
                    or any(abs(a - c) > 1e-3 for a, c in zip(got["b"], fp["b"]))):
                return None  # diverged restore = miss, never wrong geometry
            body = {
                "id": ent["body_id"], "name": ent["name"], "shape": shape,
                "_owners": {
                    tuple(k): v
                    for k, v in state.get("owners", {}).get(ent["body_id"], [])
                },
            }
            bodies.append(body)
            mod[ent["body_id"]] = (shape, ent["blob_key"])
        snap = {
            "bodies": bodies,
            "sketches_ref": {}, "n_sketches": 0,  # rebuilt via replay_sketches
            "datums": state["datums"],
            "n": state["n"],
            "errors_ref": state["errors"], "n_errors": len(state["errors"]),
            "replay_sketches": True,
        }
        return cp["feat_index"] + 1, snap, mod
    except Exception:
        return None


# RAM snapshots kept per feature (beyond disk checkpoints); bounds worker memory
# (~0.2 MB/snapshot measured, so 300 ≈ 60 MB) — a resume below the window falls
# through to the disk cache. SINDRI_RAM_SNAP_WINDOW overrides for large docs / tight RAM.
_RAM_SNAP_WINDOW = int(os.environ.get("SINDRI_RAM_SNAP_WINDOW", "300"))


def rebuild_cached(document, diagnostics=None):
    """Incremental rebuild: reuse cached per-feature state for the unchanged document
    PREFIX and re-run only from the first changed feature. Resume sources, deepest
    wins: (1) in-RAM per-feature snapshots from the previous build in this worker,
    (2) durable disk checkpoints (geomstore) that survive worker restarts, crashes
    and timeouts. Falls back to a full rebuild when params/visibility change or both
    caches miss. Same return as rebuild(); geometrically identical to a full rebuild
    (verified by the incremental-vs-full smoke test + the differential harness)."""
    global _CACHE
    features = document.get("features", [])
    new_sigs = _feature_sigs(features)
    gsig = _global_sig(document)
    store = _disk_store()
    keys = _chain_keys_scoped(document, new_sigs) if store is not None else []

    resume = None
    from_disk = False
    disk_mod = {}
    if _CACHE["global_sig"] == gsig and _CACHE["snaps"]:
        old_sigs = _CACHE["feature_sigs"]
        k = 0
        while k < len(new_sigs) and k < len(old_sigs) and new_sigs[k] == old_sigs[k]:
            k += 1
        # snaps below the RAM retention window are None — fall through to disk
        if k > 0 and k - 1 < len(_CACHE["snaps"]) and _CACHE["snaps"][k - 1] is not None:
            resume = (k, _CACHE["snaps"][k - 1])  # restore state after feature k-1
    if resume is None and store is not None:
        # Checkpoint restore unpickles every prefix body from disk — on a large
        # document this is a long, otherwise-silent phase; tick around it so
        # the supervisor's stall watchdog never mistakes it for a hang.
        if on_feature_tick is not None:
            try:
                on_feature_tick(-1)
            except Exception:
                pass
        hit = _restore_from_disk(store, keys)
        if on_feature_tick is not None:
            try:
                on_feature_tick(-1)
            except Exception:
                pass
        if hit is not None:
            start_i, snap, disk_mod = hit
            resume = (start_i, snap)
            from_disk = True

    persist = None
    if store is not None and features:
        persist = {"store": store, "keys": keys, "mod": dict(disk_mod),
                   "acc_ms": 0.0, "budget_ms": 1000.0}
        if resume is not None and not from_disk:
            # RAM resume: last-modifier keys for prefix bodies are unknown; stamp
            # them at the resume point. Same blob bytes under a fresh key — a
            # small dedup loss, never a correctness one.
            k0 = resume[0] - 1
            for b in resume[1]["bodies"]:
                if b.get("shape") is not None and k0 >= 0:
                    persist["mod"][b["id"]] = (b["shape"], _blob_key(keys[k0], b["id"]))

    t_build = time.monotonic()
    snaps_out = []
    part, errors, bodies = rebuild(
        document, diagnostics=diagnostics, resume=resume,
        snapshots_out=snaps_out, persist=persist,
    )
    elapsed = time.monotonic() - t_build

    # Builds WITH feature errors are cached too: failed features are recorded
    # no-ops, snapshots carry the accumulated errors (so a resume past a broken
    # feature re-reports it), and OCCT failures are deterministic. Refusing to
    # cache here would force a slow full rebuild on EVERY edit of a document
    # with one permanently-failing feature.
    start = resume[0] if resume else 0
    if from_disk:
        merged = [None] * start  # no per-feature RAM snaps for the disk prefix
    else:
        merged = list(_CACHE["snaps"][:start])  # reused prefix
    merged.extend(snap for (_i, snap) in snaps_out)  # freshly built tail
    for j in range(0, max(0, len(merged) - _RAM_SNAP_WINDOW)):
        merged[j] = None  # bound RAM; disk checkpoints cover the deep prefix
    _CACHE = {"feature_sigs": new_sigs, "snaps": merged, "global_sig": gsig}

    # Tip checkpoint: make the just-built state instantly restorable by the next
    # process (app restart, worker respawn). The final snapshot carries exactly
    # the loop state to persist. Debounced by build cost — trivial warm edits
    # (<0.5 s) don't spam the store; anything that cost real time is worth the
    # ~15 ms/body write.
    if (persist is not None and merged and merged[-1] is not None
            and (elapsed >= 0.5 or persist["acc_ms"] >= 500.0)):
        tip = merged[-1]
        _save_checkpoint(
            persist, len(features) - 1, tip["bodies"], tip["datums"],
            tip["errors_ref"][: tip["n_errors"]], tip["n"],
        )
    if persist is not None:
        # annotate returned bodies with their content key so the server can key
        # per-body DISK MESH ARTIFACTS by it (load path skips the Python
        # triangle-readback loop entirely)
        for b in bodies:
            mk = persist["mod"].get(b["id"])
            if mk is not None:
                b["meshKey"] = mk[1]
    return part, errors, bodies


def _as_compound(s):
    """Normalize a possibly-disjoint shape (a build123d ShapeList, e.g. a body split
    into pieces, or an extrude of several disjoint region faces) to a single
    Compound so .bounding_box() and boolean ops work. Single shapes pass through.

    A ShapeList is a `list` subclass, so we wrap by TYPE rather than by probing
    `.wrapped`: build123d >=0.11 asserts on `.wrapped` for an EMPTY single shape (an
    empty boolean result), which must pass through untouched, not be re-wrapped."""
    if _wrapped_or_none(s) is not None:
        return s  # a real, non-empty single shape
    if isinstance(s, (list, tuple)):
        return Compound(list(s))  # a ShapeList of disjoint shapes
    return s  # an empty single shape (0.11 asserts on .wrapped) — pass through


# --- face provenance: which feature created/last-modified each face --------
# Lets the UI map a picked face back to its feature (click a chamfer face → select
# the chamfer). Each body carries `_owners`: {face-fingerprint → feature id}. After
# every feature we re-fingerprint the CHANGED bodies; a face whose fingerprint is new
# (not carried over from before) is attributed to the current feature, while
# unchanged faces keep their owner. A move transforms the fingerprint keys so
# provenance survives it. Fingerprint = (area, centre) quantized.

def _face_fp(face):
    """Quantized (area, centre) fingerprint. Memoized by the face's TShape when
    its Location is identity (measured: >99% of faces after booleans, and equal
    identity-located TShapes ARE the same geometry): OCP hashes TShape wrappers
    stably at ~0.3 µs, while the GProp area/centre evaluation behind .area and
    .center() was 23% of a cold rebuild (70k calls). Non-identity locations are
    computed uncached — correctness over coverage."""
    w = _wrapped_or_none(face)
    key = None
    if w is not None:
        try:
            if w.Location().IsIdentity():
                key = w.TShape()
                hit = _FP_MEMO.get(key)
                if hit is not None:
                    return hit
        except Exception:
            key = None
    try:
        c = face.center()
        fp = (round(face.area, 2), round(c.X, 1), round(c.Y, 1), round(c.Z, 1))
    except Exception:
        return None
    if key is not None:
        if len(_FP_MEMO) > 200_000:
            _FP_MEMO.clear()  # bound process-lifetime growth; it's only a cache
        _FP_MEMO[key] = fp
    return fp


_FP_MEMO = {}
_WIDTH_MEMO = {}


def _shape_face_fps(shape):
    try:
        faces = shape.faces()
    except Exception:
        return []
    return [fp for fp in (_face_fp(f) for f in faces) if fp is not None]


def _move_fp(fp, trsf):
    from OCP.gp import gp_Pnt
    area, cx, cy, cz = fp
    p = gp_Pnt(cx, cy, cz)
    p.Transform(trsf)
    return (area, round(p.X(), 1), round(p.Y(), 1), round(p.Z(), 1))


def _remove_features(shape, faces):
    """One low-level BOPAlgo_RemoveFeatures attempt. Returns (healed | None, alerts).

    None means OCCT errored, produced no solid, or silently returned the shape
    UNCHANGED — per-feature failure is a WARNING by design (the BRepAlgoAPI wrapper
    hides it), so the face-count drop is the real success signal. `alerts` carries
    the OCCT warning keys (e.g. BOPAlgo_AlertUnableToRemoveTheFeature) for an
    honest error message."""
    from OCP.BOPAlgo import BOPAlgo_RemoveFeatures
    from OCP.Message import Message_Gravity
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    rf = BOPAlgo_RemoveFeatures()
    rf.SetShape(_as_compound(shape).wrapped)
    for fc in faces:
        rf.AddFaceToRemove(fc.wrapped)
    rf.SetRunParallel(True)
    rf.Perform()
    alerts = []
    try:
        rep = rf.GetReport()
        for grav in (
            Message_Gravity.Message_Warning,
            Message_Gravity.Message_Alarm,
            Message_Gravity.Message_Fail,
        ):
            for a in rep.GetAlerts(grav):
                alerts.append(a.GetMessageKey())
    except Exception:
        pass
    if rf.HasErrors():
        return None, alerts
    solids = []
    exp = TopExp_Explorer(rf.Shape(), TopAbs_SOLID)
    while exp.More():
        solids.append(Solid(TopoDS.Solid_s(exp.Current())))
        exp.Next()
    if not solids:
        return None, alerts
    before = len(_as_compound(shape).faces())
    after = sum(len(s.faces()) for s in solids)
    if after >= before:
        return None, alerts
    return (solids[0] if len(solids) == 1 else Compound(solids)), alerts


def _face_width(f):
    """Characteristic band width: 2·area/perimeter (≈ true width for a long strip,
    small for a corner patch, large for a real base face). Same TShape memo as
    _face_fp (width is location-invariant, so identity-location gating isn't even
    needed — but reuse the same safe pattern)."""
    w = _wrapped_or_none(f)
    key = None
    if w is not None:
        try:
            key = w.TShape()
            hit = _WIDTH_MEMO.get(key)
            if hit is not None:
                return hit
        except Exception:
            key = None
    per = sum(e.length for e in f.edges())
    out = (2.0 * f.area / per) if per > 0 else 0.0
    if key is not None:
        if len(_WIDTH_MEMO) > 200_000:
            _WIDTH_MEMO.clear()
        _WIDTH_MEMO[key] = out
    return out


def _expand_blend_chain(shape, seeds, width_factor=4.0, max_faces=64):
    """Grow the picked face(s) into the connected chamfer/fillet chain they belong to.

    RemoveFeatures heals by extending the faces ADJACENT to the removed set. Pick one
    member of a chamfer chain and its neighbours are the OTHER blend faces — tangent
    or shallow, so extension fails and the whole delete no-ops. Feeding it the full
    chain makes the true base faces the neighbours, which extend exactly.

    Chain membership is geometric: a candidate must be narrow (width within
    `width_factor` of the widest seed) AND band-shaped (width well under its own
    longest edge — the oblique-dihedral test alone is symmetric, a support meets
    its chamfer at 45° too; a base face is never a narrow band of the chamfer's
    scale, so these two filters are what stop expansion at the supports) and
    blend-like:
      * planar band meeting some neighbour at a clearly oblique dihedral
        (a chamfer strip against its supports — never ~0° or ~90°), or
      * cylinder/cone/torus/sphere band tangent to a neighbour (a fillet), or
      * a small patch adjacent to ≥2 faces already in the chain (a corner patch).
    Returns the seeds unchanged when nothing qualifies — or when expansion hits
    `max_faces`, which means the "chain" is really a mesh of narrow faces (e.g. a
    honeycomb wall lattice), not a blend: retrying on that is doomed and slow."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp, TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from OCP.TopTools import (
        TopTools_IndexedDataMapOfShapeListOfShape,
        TopTools_IndexedMapOfShape,
    )

    comp = _as_compound(shape)
    fmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(comp.wrapped, TopAbs_FACE, fmap)
    emap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(comp.wrapped, TopAbs_EDGE, TopAbs_FACE, emap)

    seed_idx = [fmap.FindIndex(s.wrapped) for s in seeds]
    seed_idx = [i for i in seed_idx if i > 0]
    if not seed_idx:
        return list(seeds)

    faces_by_idx = {}

    def face_at(i):
        if i not in faces_by_idx:
            faces_by_idx[i] = Face(TopoDS.Face_s(fmap.FindKey(i)))
        return faces_by_idx[i]

    neighbors_cache = {}

    def neighbors(i):
        """[(other_face_index, shared_edge_midpoint)] over the face's edges."""
        if i in neighbors_cache:
            return neighbors_cache[i]
        out = []
        exp = TopExp_Explorer(fmap.FindKey(i), TopAbs_EDGE)
        while exp.More():
            edge = exp.Current()
            if emap.Contains(edge):
                mid = None
                for other in emap.FindFromKey(edge):
                    j = fmap.FindIndex(other)
                    if j != i:
                        if mid is None:
                            mid = Edge(TopoDS.Edge_s(edge)).position_at(0.5)
                        out.append((j, mid))
            exp.Next()
        neighbors_cache[i] = out
        return out

    def dihedral(i, j, pt):
        """Angle in degrees between the two faces' surface normals at pt (a point
        on the shared edge). ~0 = tangent, ~90 = perpendicular, between = oblique."""
        try:
            n1, n2 = face_at(i).normal_at(pt), face_at(j).normal_at(pt)
            d = max(-1.0, min(1.0, n1.dot(n2)))
            return math.degrees(math.acos(abs(d)))
        except Exception:
            return 90.0

    FILLET_TYPES = (
        GeomAbs_SurfaceType.GeomAbs_Cylinder,
        GeomAbs_SurfaceType.GeomAbs_Cone,
        GeomAbs_SurfaceType.GeomAbs_Torus,
        GeomAbs_SurfaceType.GeomAbs_Sphere,
    )
    BAND_ASPECT_MAX = 0.4  # width / longest edge — a band, not a full face
    blend_cache = {}

    def is_blend(i):
        if i in blend_cache:
            return blend_cache[i]
        f = face_at(i)
        longest = max((e.length for e in f.edges()), default=0.0)
        if longest <= 0 or _face_width(f) / longest > BAND_ASPECT_MAX:
            blend_cache[i] = False
            return False
        t = BRepAdaptor_Surface(TopoDS.Face_s(fmap.FindKey(i))).GetType()
        if t in FILLET_TYPES:
            r = any(dihedral(i, j, pt) < 10.0 for j, pt in neighbors(i))
        elif t == GeomAbs_SurfaceType.GeomAbs_Plane:
            r = any(15.0 <= dihedral(i, j, pt) <= 75.0 for j, pt in neighbors(i))
        else:
            r = False
        blend_cache[i] = r
        return r

    cap = width_factor * max(_face_width(face_at(i)) for i in seed_idx)
    # the ≥2-chain-neighbours fallback is for CORNER PATCHES only — without a hard
    # size limit it absorbs base faces once several strips surround them
    patch_area_max = (cap / 2.0) ** 2
    chain = set(seed_idx)
    queue = list(seed_idx)
    while queue:
        i = queue.pop()
        for j, _pt in neighbors(i):
            if j in chain or _face_width(face_at(j)) > cap:
                continue
            in_chain_neighbors = sum(1 for k, _ in neighbors(j) if k in chain)
            if is_blend(j) or (
                in_chain_neighbors >= 2 and face_at(j).area <= patch_area_max
            ):
                chain.add(j)
                queue.append(j)
                if len(chain) >= max_faces:
                    return list(seeds)  # runaway absorb — not a blend chain
    return [face_at(i) for i in chain]


def _wound_boundary(comp, faces):
    """Faces of `comp` adjacent (edge-sharing) to `faces` but not in the set —
    the faces that would border the wound if `faces` were removed."""
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp, TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from OCP.TopTools import (
        TopTools_IndexedDataMapOfShapeListOfShape,
        TopTools_IndexedMapOfShape,
    )

    fmap = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(comp.wrapped, TopAbs_FACE, fmap)
    emap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(comp.wrapped, TopAbs_EDGE, TopAbs_FACE, emap)
    removed = {fmap.FindIndex(x.wrapped) for x in faces}
    adj = set()
    for x in faces:
        exp = TopExp_Explorer(x.wrapped, TopAbs_EDGE)
        while exp.More():
            if emap.Contains(exp.Current()):
                for other in emap.FindFromKey(exp.Current()):
                    j = fmap.FindIndex(other)
                    if j not in removed:
                        adj.add(j)
            exp.Next()
    return [Face(TopoDS.Face_s(fmap.FindKey(j))) for j in adj]


def _tool_fill(shape, targets, feature_faces=None, max_planes=12):
    """Erase a MISSING-material region (chamfer/fillet cut into a corner) by
    boolean emulation instead of healing: build the filler wedge as the
    intersection of the local support faces' material half-spaces, clipped to a
    box around the targets, and fuzzy-fuse it in. Never extends or intersects the
    feature faces themselves — the restored corner emerges from the boolean — so
    it works exactly where RemoveFeatures' adjacent-face extension gives up
    (tangent neighbours, ragged facet supports).

    `targets` = the face(s) to erase THIS round (one convex pocket's worth);
    `feature_faces` = the whole feature (defaults to targets) — fellow feature
    faces are excluded from the support set, since a tangent chamfer continuation
    must never act as a bounding half-space. Returns the filled shape or None,
    with hard validation: planar supports only, ≥1 target face consumed, valid
    B-rep, and the void bounded to the targets' own extent so a wedge that would
    flood an unrelated feature (a hole) or extrude past an unbounded side (a
    deleted top face, a tab end) is rejected."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.GeomAbs import GeomAbs_SurfaceType
    from OCP.TopTools import TopTools_ListOfShape

    comp = _as_compound(shape)
    feature_faces = feature_faces or targets
    feat_fps = {fp for fp in (_face_fp(f) for f in feature_faces) if fp is not None}
    # supports = faces adjacent to the TARGETS that aren't part of the feature.
    # Facet-debris slivers (STL heritage) can sit between a chamfer and its true
    # support — look THROUGH them one ring: the sliver's own neighbours join the
    # support set (the wrong-side filter below discards any that don't actually
    # bound this pocket).
    first_ring = [
        b for b in _wound_boundary(comp, targets) if _face_fp(b) not in feat_fps
    ]
    bases, seen = [], set(feat_fps)
    for b in first_ring:
        fp = _face_fp(b)
        if fp in seen:
            continue
        seen.add(fp)
        if _face_width(b) < 0.25 and b.area < 1.0:  # debris — pass through
            for c in _wound_boundary(comp, [b]):
                cfp = _face_fp(c)
                if cfp not in seen and not (
                    _face_width(c) < 0.25 and c.area < 1.0
                ):
                    seen.add(cfp)
                    bases.append(c)
        else:
            bases.append(b)
    if not bases:
        return None
    # v1 supports planar supports only (the wedge is a half-space intersection)
    for b in bases:
        if BRepAdaptor_Surface(b.wrapped).GetType() != GeomAbs_SurfaceType.GeomAbs_Plane:
            return None

    # dedupe bases into distinct support planes. Parallel same-direction planes at
    # different offsets are a facet STAIRCASE (STL heritage) approximating one
    # design plane — keep the OUTERMOST (largest material half-space): the wedge
    # then covers the whole wound, and the fill flattens the staircase instead of
    # being truncated by its innermost step (which strands the void short of the
    # feature faces).
    groups = []  # [(normal, max_material_offset)]
    for b in bases:
        p0, n = b.center(), b.normal_at(b.center())
        off = p0.dot(n)
        for g in groups:
            if n.dot(g[0]) > 0.9998:  # same direction (opposing normals differ)
                g[1] = max(g[1], off)
                break
        else:
            groups.append([n, off])
    # drop wrong-side "supports": a neighbour whose material half-space excludes
    # the target face itself (e.g. the step wall of a stacked-plate clip meeting
    # the chamfer at its far edge) is geometry BEYOND the pocket, not a bound of
    # it — keeping it pinches the wedge off the target. The solid surface still
    # bounds the void in that direction, so dropping it can't overfill. Sample the
    # target's own vertices + center (its bbox corners overestimate for oblique
    # faces).
    samples = []
    for f in targets:
        samples.append(f.center())
        samples.extend(Vector(v.X, v.Y, v.Z) for v in f.vertices())
    groups = [
        (n, off)
        for n, off in groups
        if all(p.dot(n) <= off + 0.1 for p in samples)
    ]
    if not groups:
        return None
    if len(groups) > max_planes:
        return None  # too many distinct supports — mis-scoped region
    planes = [(n * off, n) for n, off in groups]

    # local clip box around the feature. Inflate a side only when some support
    # half-space bounds the wedge there; on an unbounded side, clip at the
    # feature's own bbox — the band spans exactly the void it cut, so the restored
    # material ends flush with the feature's extent (e.g. a chamfer chain that
    # wraps a tab END has no support plane past the end; the fill must stop at the
    # tab end, not run on into the inflation box).
    # clip/guard region = the WHOLE feature, not just this round's targets: a
    # clipped per-target fill leaves an end-cap that later rounds would see as a
    # support capping their wedge below the remaining pocket. Extending the wedge
    # through fellow feature faces' region is safe — the solid itself bounds the
    # void there — and lets sequential fills meet instead of walling each other off.
    region = Compound(list(feature_faces))
    bb = region.bounding_box()
    d = (bb.max - bb.min).length * 0.2 + 0.5
    lo = [bb.min.X, bb.min.Y, bb.min.Z]
    hi = [bb.max.X, bb.max.Y, bb.max.Z]
    for ax in range(3):
        comps = [(n.X, n.Y, n.Z)[ax] for n, _ in groups]
        # strict-with-epsilon: a support at EXACTLY 0.5 (hex-pocket walls tilted
        # 30° off-axis produce ±0.5 components with float dust on top) barely
        # bounds the wedge on this axis — inflating for it lets the wedge tube
        # run past the feature into a neighbouring pocket's void, and the
        # bounds guard then rejects a perfectly fillable notch. Clip flush at
        # the feature bbox instead, per the design above.
        if any(v < -0.5 - 1e-9 for v in comps):
            lo[ax] -= d
        if any(v > 0.5 + 1e-9 for v in comps):
            hi[ax] += d
    if min(h - l for h, l in zip(hi, lo)) < 1e-6:
        return None  # flat, unbounded region (e.g. a lone big face) — no wedge
    tool = Pos(
        (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2
    ) * Box(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    for p0, n in planes:
        # material lies on the -n side of each base plane (n = outward normal)
        pl = Plane(origin=(p0.X, p0.Y, p0.Z), z_dir=(-n.X, -n.Y, -n.Z))
        tool = split(tool, bisect_by=pl, keep=Keep.TOP)
        if tool is None or not tool.solids():
            return None

    # the actual fill = the void components of (wedge − solid) that TOUCH the
    # feature faces. Selecting components (a) leaves unrelated voids inside the
    # wedge region alone (a screw hole near the corner must not get plugged) and
    # (b) exposes the degenerate case for the bounds guard below.
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    try:
        outside = _as_compound(tool) - comp
    except Exception:
        return None
    voids = [
        s
        for s in outside.solids()
        if BRepExtrema_DistShapeShape(s.wrapped, region.wrapped).Value() < 1e-2
    ]
    if not voids:
        return None
    # bounds guard: a real chamfer/fillet void lies within the feature's own
    # bounding box (the band spans the void it cut — the restored corner/edge sits
    # on the box boundary), so only fuzz-scale slack is legitimate. A void escaping
    # the box — e.g. deleting a box's whole top face makes the "wedge" an unbounded
    # slab clipped only by the inflation box — is NOT a feature void; filling it
    # would silently extrude the part. Reject.
    margin = 0.5
    vb = Compound(voids).bounding_box()
    if (
        vb.min.X < bb.min.X - margin or vb.min.Y < bb.min.Y - margin
        or vb.min.Z < bb.min.Z - margin or vb.max.X > bb.max.X + margin
        or vb.max.Y > bb.max.Y + margin or vb.max.Z > bb.max.Z + margin
    ):
        return None
    # a feature void can't exceed feature-area × feature-extent; bigger means
    # the wedge flooded something that isn't this feature
    gain_cap = max(1.0, sum(f.area for f in feature_faces)) * max(
        1.0, max(_face_width(f) for f in feature_faces)
    ) * 3.0
    if sum(v.volume for v in voids) > gain_cap:
        return None

    fu = BRepAlgoAPI_Fuse()
    args, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
    args.Append(comp.wrapped)
    for v in voids:
        tools.Append(v.wrapped)
    fu.SetArguments(args)
    fu.SetTools(tools)
    fu.SetFuzzyValue(1e-5)
    fu.Build()
    if not fu.IsDone():
        return None
    result = _wrap_topods(fu.Shape())
    if result is None:
        return None
    n_before = len(comp.solids())
    if len(result.solids()) != n_before:
        return None
    gain = result.volume - comp.volume
    if gain <= 1e-9 or gain > gain_cap:
        return None
    # progress check: the fill must consume at least one feature face. A single
    # convex wedge can only fill ONE convex pocket — a chain that wraps several
    # corners (e.g. around a tab end) is filled pocket-by-pocket by _tool_fill_all,
    # so partial consumption here is progress, not failure.
    fps_targets = {fp for fp in (_face_fp(f) for f in targets) if fp is not None}
    consumed = fps_targets - set(_shape_face_fps(result))
    if fps_targets and not consumed:
        return None  # the wedge missed the wound entirely
    if not BRepCheck_Analyzer(result.wrapped).IsValid():
        return None
    solids = result.solids()
    return solids[0] if len(solids) == 1 else Compound(list(solids))


def _tool_fill_all(shape, feature_faces, max_rounds=24):
    """Erase a whole (possibly non-convex) missing-material feature by repeated
    convex wedge fills. A chain that wraps several corners has DIFFERENT support
    pairs per segment — a single global wedge (AND of all half-spaces) degenerates
    — so fill face-by-face: each round targets one remaining face using only ITS
    adjacent supports (fellow feature faces excluded), largest faces first (corner
    patches often gain usable supports only after their strips are filled).
    Succeeds only when EVERY feature face is consumed — a half-filled chamfer
    chain is worse than an honest error. Returns the filled shape or None.

    The ACCUMULATED gain across rounds is capped to the whole feature's
    gain_cap: each round's fill respects its own per-round cap, but a
    degenerate flat remnant can otherwise staircase — round after round each
    under-cap — into many times the feature's volume (measured +20.7 mm³
    from a 1.5 mm² ledge on the DDR honeycomb rim)."""
    cur = shape
    v0 = _as_compound(shape).volume
    total_cap = max(1.0, sum(f.area for f in feature_faces)) * max(
        1.0, max(_face_width(f) for f in feature_faces)
    ) * 3.0
    remaining = sorted(feature_faces, key=lambda f: -f.area)
    for _ in range(max_rounds):
        filled = None
        for target in remaining:
            filled = _tool_fill(cur, [target], feature_faces=remaining)
            if filled is not None:
                break
        if filled is None:
            return None  # no remaining face could be filled — give up honestly
        if _as_compound(filled).volume - v0 > total_cap:
            return None  # staircasing past the whole feature's budget
        # remember the surfaces of the pre-fill remaining set: the fuse can SPLIT
        # a band face at the clip boundary, and the stub keeps its plane but gets
        # a new fingerprint — losing it would hand it to later rounds as a
        # SUPPORT, whose half-space then cuts the next wedge to nothing
        prev = []
        for f in remaining:
            try:
                c = f.center()
                prev.append((f.normal_at(c), c, f.bounding_box()))
            except Exception:
                pass
        cur = filled
        left_fps = {
            fp for fp in (_face_fp(f) for f in remaining) if fp is not None
        } & set(_shape_face_fps(cur))

        def is_fragment(g):
            try:
                gc = g.center()
                gn = g.normal_at(gc)
            except Exception:
                return False
            for n, c, fb in prev:
                if (
                    abs(gn.dot(n)) > 0.999
                    and abs((gc - c).dot(n)) < 0.05
                    and fb.min.X - 0.5 <= gc.X <= fb.max.X + 0.5
                    and fb.min.Y - 0.5 <= gc.Y <= fb.max.Y + 0.5
                    and fb.min.Z - 0.5 <= gc.Z <= fb.max.Z + 0.5
                ):
                    return True
            return False

        remaining = sorted(
            (
                f
                for f in _as_compound(cur).faces()
                if _face_fp(f) in left_fps or is_fragment(f)
            ),
            key=lambda f: -f.area,
        )
        if not remaining:
            return cur
    return None


def _tool_cut(shape, targets, max_planes=12):
    """Erase an EXTRA-material remnant (a broken wall stub, or the ledge left
    by a prior wedge fill) by boolean emulation — the mirror of _tool_fill:
    build the same support-half-space wedge, clipped FLUSH to the remnant's
    own bbox on unbounded axes, and SUBTRACT it instead of fusing. The flush
    clip is what makes the cut honest: on the DDR honeycomb rim the remnant's
    top edge lies exactly on the rim line, so the cut plane coincides with
    real geometry and the rim continues straight across — no invented gash.

    The remnant = the picked face(s) plus the narrow wound-boundary bands
    attached to them (a stub's own side slivers and cap — they'd otherwise
    wall the tool off from the material). Hard-validated like the fill:
    planar supports only, loss capped to remnant size, ≥1 target consumed,
    solid count preserved, valid B-rep; any doubt → None."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.GeomAbs import GeomAbs_SurfaceType

    comp = _as_compound(shape)
    # remnant companions are TARGET-sized: cap band area relative to the
    # picked face(s), else a structural rim band (13 mm² next to a 1.4 mm²
    # ledge) joins the cut set and the tool eats real wall material
    band_cap = 2.0 * sum(t.area for t in targets)
    bands = [
        b
        for b in _wound_boundary(comp, targets)
        if _face_width(b) < 2.5 and b.area <= band_cap
    ]
    cut_set = list(targets) + bands
    cut_fps = {fp for fp in (_face_fp(f) for f in cut_set) if fp is not None}
    supports = [
        b for b in _wound_boundary(comp, cut_set) if _face_fp(b) not in cut_fps
    ]
    if not supports:
        return None
    for b in supports:
        if BRepAdaptor_Surface(b.wrapped).GetType() != GeomAbs_SurfaceType.GeomAbs_Plane:
            return None
    # group parallel same-direction planes, keep the outermost (same staircase
    # rule as _tool_fill), then keep only half-spaces containing the remnant
    groups = []
    for b in supports:
        p0, n = b.center(), b.normal_at(b.center())
        off = p0.dot(n)
        for g in groups:
            if n.dot(g[0]) > 0.9998:
                g[1] = max(g[1], off)
                break
        else:
            groups.append([n, off])
    samples = []
    for f in cut_set:
        samples.append(f.center())
        samples.extend(Vector(v.X, v.Y, v.Z) for v in f.vertices())
    groups = [
        (n, off)
        for n, off in groups
        if all(p.dot(n) <= off + 0.1 for p in samples)
    ]
    if not groups or len(groups) > max_planes:
        return None

    region = Compound(cut_set)
    bb = region.bounding_box()
    d = (bb.max - bb.min).length * 0.2 + 0.5
    lo = [bb.min.X, bb.min.Y, bb.min.Z]
    hi = [bb.max.X, bb.max.Y, bb.max.Z]
    for ax in range(3):
        comps = [(n.X, n.Y, n.Z)[ax] for n, _ in groups]
        if any(v < -0.5 - 1e-9 for v in comps):
            lo[ax] -= d
        if any(v > 0.5 + 1e-9 for v in comps):
            hi[ax] += d
    if min(h - l for h, l in zip(hi, lo)) < 1e-6:
        return None  # flat remnant with no thickness anywhere — nothing to cut
    tool = Pos(
        (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2
    ) * Box(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    for n, off in groups:
        p0 = n * off
        pl = Plane(origin=(p0.X, p0.Y, p0.Z), z_dir=(-n.X, -n.Y, -n.Z))
        tool = split(tool, bisect_by=pl, keep=Keep.TOP)
        if tool is None or not tool.solids():
            return None

    # loss cap mirrors _tool_fill's gain cap: a remnant can't outweigh its
    # own area × extent; more means the tool caught unrelated material
    loss_cap = max(1.0, sum(f.area for f in cut_set)) * max(
        1.0, max(_face_width(f) for f in cut_set)
    ) * 3.0
    # raw OCCT cut, NOT build123d's `-`: the operator's clean() runs a GLOBAL
    # coplanar merge that dissolves the small remnant companions of every
    # OTHER cell into the big skin/floor faces — after one ledge cut, the
    # next ledge would have no band topology left to recognize its stub by.
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.TopTools import TopTools_ListOfShape

    cu = BRepAlgoAPI_Cut()
    args, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
    args.Append(comp.wrapped)
    tools.Append(_as_compound(tool).wrapped)
    cu.SetArguments(args)
    cu.SetTools(tools)
    cu.SetFuzzyValue(1e-5)
    cu.Build()
    if not cu.IsDone():
        return None
    result = _wrap_topods(cu.Shape())
    if result is None:
        return None
    result = _as_compound(result)
    loss = comp.volume - result.volume
    if loss <= 1e-9 or loss > loss_cap:
        return None
    if len(result.solids()) != len(comp.solids()):
        return None
    fps_targets = {fp for fp in (_face_fp(f) for f in targets) if fp is not None}
    if fps_targets and not (fps_targets - set(_shape_face_fps(result))):
        return None  # the cut missed the picked face entirely
    if not BRepCheck_Analyzer(result.wrapped).IsValid():
        return None
    solids = result.solids()
    return solids[0] if len(solids) == 1 else Compound(list(solids))


def _defeature(shape, faces):
    """Remove one or more faces from a solid and heal the gap — deleting an
    (imported) chamfer/fillet or a small protrusion where there's no feature
    history to edit. Four rungs, cheapest first:
      1. stock OCCT defeaturing on the picked face(s),
      2. retry with the whole recognized chamfer/fillet chain (rescues corner
         chamfers — see _expand_blend_chain),
      3. tool-solid fill: fuse a wedge built from the base faces' half-spaces
         (works where extension-healing is structurally unable — ragged or
         tangent supports; see _tool_fill),
      4. tool-solid cut: the subtractive mirror, for EXTRA-material remnants
         (broken wall stubs, prior-fill ledges) that have no bounded fill —
         see _tool_cut. Last on purpose: additive/extension heals are more
         conservative and must win when both apply."""
    healed, alerts = _remove_features(shape, faces)
    if healed is not None:
        return healed
    chain = _expand_blend_chain(shape, faces)
    expanded = len(chain) > len(faces)
    if expanded:
        healed, alerts2 = _remove_features(shape, chain)
        if healed is not None:
            return healed
        alerts += alerts2
    # a FLAT picked face (zero-thickness bbox — e.g. the horizontal ledge a
    # prior wedge fill left on the honeycomb rim) can never be a chamfer to
    # fill: blend-chain expansion from it grabs tangent structural bands and
    # the fill floods their wounds instead. For flat faces the subtractive
    # cut is the honest heal — try it FIRST; sloped chamfers keep fill-first.
    fbb = Compound(list(faces)).bounding_box()
    flat = min(
        fbb.max.X - fbb.min.X, fbb.max.Y - fbb.min.Y, fbb.max.Z - fbb.min.Z
    ) < 1e-6
    if flat:
        cut = _tool_cut(shape, faces)
        if cut is not None:
            return cut
        # no fill fallback for flat faces: a flat face is never a fillable
        # blend, and chain expansion from one grabs tangent structural bands
        # whose wound-fill floods (+20.7 mm³ measured) — honest error instead
    else:
        filled = _tool_fill_all(shape, chain if expanded else faces)
        if filled is not None:
            return filled
        cut = _tool_cut(shape, faces)
        if cut is not None:
            return cut
    detail = f" (OCCT: {', '.join(sorted(set(alerts)))})" if alerts else ""
    tried = (
        f" — even removing its whole {len(chain)}-face chamfer/fillet chain and "
        "wedge-filling the corner"
        if expanded
        else " — wedge-filling didn't apply either"
    )
    raise ValueError(
        "can't heal after removing that face" + tried
        + " — use Press/Pull to cut it instead" + detail
    )


def _update_owners(f, val, bodies, pre_shape, pre_owners_by_id, pre_owners_all):
    """Attribute each face of every CHANGED body to a feature. Unchanged bodies (same
    shape object) keep their owners untouched — bounding the cost to what moved."""
    fid = f.get("id")
    is_move = f.get("type") == "move"
    move_ids, trsf = None, None
    if is_move and bodies:
        ids = f.get("bodies")
        move_ids = set(ids) if ids else {bodies[-1]["id"]}
        rx, ry, rz = val(f.get("rx", 0)), val(f.get("ry", 0)), val(f.get("rz", 0))
        dx, dy, dz = val(f.get("dx", 0)), val(f.get("dy", 0)), val(f.get("dz", 0))
        trsf = (Pos(dx, dy, dz) * Rot(rx, ry, rz)).wrapped.Transformation()
    for b in bodies:
        sh = b.get("shape")
        if sh is None:
            b["_owners"] = {}
            continue
        bid = id(b)
        if bid in pre_shape and sh is pre_shape[bid]:
            continue  # unchanged this feature — keep prior owners
        prior = pre_owners_by_id.get(bid, {})
        if trsf is not None and b.get("id") in move_ids and prior:
            prior = {_move_fp(k, trsf): v for k, v in prior.items()}  # follow the move
        owners = {}
        for fp in _shape_face_fps(sh):
            owners[fp] = prior.get(fp) or pre_owners_all.get(fp) or fid
        b["_owners"] = owners


def _bbox_overlap(a, b, tol=1e-6):
    """Cheap AABB overlap test (no boolean, can't crash)."""
    ba, bb = _as_compound(a).bounding_box(), _as_compound(b).bounding_box()
    return (
        ba.min.X <= bb.max.X + tol and ba.max.X >= bb.min.X - tol
        and ba.min.Y <= bb.max.Y + tol and ba.max.Y >= bb.min.Y - tol
        and ba.min.Z <= bb.max.Z + tol and ba.max.Z >= bb.min.Z - tol
    )


def _wrapped_or_none(sh):
    """`sh.wrapped` (the single TopoDS shape) or None, tolerating two cases: a
    ShapeList has no single wrapped shape, and build123d >=0.11 makes `.wrapped` a
    property that ASSERTS on an empty shape (`_wrapped is None`) where 0.10 left the
    attribute simply absent. Both mean 'no usable solid here'."""
    try:
        return sh.wrapped
    except (AttributeError, AssertionError):
        return None


def _try_vol(shape):
    """Best-effort |volume| of a shape. Returns 0.0 for a genuinely EMPTY shape (so
    the no-op boolean guards fire on it), and None only when OCCT truly can't measure
    a non-empty shape. build123d >=0.11 asserts on empty shapes instead of reporting
    zero, so we detect emptiness via `_wrapped_or_none` first."""
    try:
        s = _as_compound(shape)
    except Exception:
        return None
    if _wrapped_or_none(s) is None:
        return 0.0  # empty shape -> zero volume
    try:
        return abs(s.volume)
    except Exception:
        return None


def _noop_eps(ref):
    """Volume change smaller than this (per the op's reference volume) counts as
    "the boolean did nothing": an absolute floor plus a 0.01% relative slice,
    mirroring the tolerances used by _unify_body / cleanup elsewhere in this
    file. The ONE definition every boolean no-op guard shares
    (_boolean_into_bodies for extrude/revolve/loft/sweep, _do_combine for
    Combine) — tune it here, never inline a copy."""
    return max(1e-6, 1e-4 * (ref or 0.0))


def _boolean_into_bodies(bodies, solid, op, new_body, hidden=frozenset()):
    """MCAD-style extrude operation: New Body adds a separate body; Join / Cut /
    Intersect boolean the new solid against EVERY VISIBLE body it overlaps — so an
    extrude that bridges two bodies merges both. Join with nothing to act on just
    adds a new body. HIDDEN bodies are never touched (a hidden body is intentionally
    protected from edits), so they're excluded from the overlap set.

    Guards no-op / destructive booleans: a Join whose prism is already inside the
    body, or a Cut/Intersect that meets no material, used to return the model
    UNCHANGED with no error ("I extruded and nothing happened"). Each op is now
    measured by volume and, when it changed nothing (or Intersect would empty a
    body), raises ValueError — the rebuild loop records it as a feature error and
    flags the feature red, instead of silently doing nothing. Volume-read failures
    fall through to the old behavior (never raise a misleading no-op error)."""
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
    # a change smaller than this counts as "nothing happened" — shared by every
    # boolean guard site (here and _do_combine) so the tolerance convention
    # can't drift between features.
    eps = _noop_eps

    prism_vol = _try_vol(solid)
    if op == "join":
        if not hits:
            new_body(solid)
            return
        merged = solid
        for b in hits:
            merged = merged + _as_compound(b["shape"])  # `+` fuses solids
        # No-op guard: the fused volume should exceed what was already there. If it
        # doesn't, the prism sat entirely inside the body and added no material.
        merged_vol, hit_vol = _try_vol(merged), _sum_hit_vol(hits)
        if merged_vol is not None and hit_vol is not None \
                and merged_vol <= hit_vol + eps(prism_vol):
            raise ValueError(
                "Join added no material — the profile is already inside the body. "
                "Did you mean Cut?"
            )
        name = hits[0]["name"]
        for b in hits:
            bodies.remove(b)
        # joins of ragged bodies GLUE solids instead of merging them (interior
        # walls, coincident skins, visible seams at every contact); unify right
        # here so a join yields ONE true solid. Fast no-op on clean results
        # (single right-side-out solid), hard-gated otherwise.
        new_body(_unify_body(merged), name)
    elif op == "cut":
        # compute every cut first, measure how much came off, and only commit when
        # the extrude actually removed material from some body.
        results, removed, measured = [], 0.0, False
        for b in hits:
            before = _try_vol(b["shape"])
            newshape = _as_compound(b["shape"]) - solid
            after = _try_vol(newshape)
            results.append((b, newshape))
            if before is not None and after is not None:
                measured = True
                removed += max(0.0, before - after)
        if not hits or (measured and removed < eps(prism_vol)):
            raise ValueError(
                "Cut removed nothing — the extrude doesn't reach any body. "
                "Drag the other way, or use Join."
            )
        for b, newshape in results:
            b["shape"] = newshape
    elif op == "intersect":
        if not hits:
            raise ValueError(
                "Intersect left nothing — the profile doesn't overlap any body."
            )
        results = []
        for b in hits:
            newshape = _as_compound(b["shape"]) & solid
            v = _try_vol(newshape)
            if v is not None and v < eps(_try_vol(b["shape"])):
                raise ValueError(
                    "Intersect would leave the body empty — the profile doesn't "
                    "overlap it."
                )
            results.append((b, newshape))
        for b, newshape in results:  # commit only after all hits pass the guard
            b["shape"] = newshape
    else:
        raise ValueError(f"unknown extrude operation: {op}")


def _sum_hit_vol(hits):
    """Total |volume| of the hit bodies, or None if any can't be measured (so the
    join no-op guard stays conservative rather than firing on a bad read)."""
    total = 0.0
    for b in hits:
        v = _try_vol(b["shape"])
        if v is None:
            return None
        total += v
    return total


def _vertex_components(solids):
    """Group solids into physically-connected pieces (union-find over solids that
    share a vertex). A connected lump — even one OCCT reports as many sub-solids
    (a honeycomb half is dozens) — collapses to one group; genuinely separate lumps
    stay apart. Returns a list of solid-lists."""
    n = len(solids)
    if n <= 1:
        return [list(solids)] if solids else []
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    vmap = {}
    for i, s in enumerate(solids):
        for v in s.vertices():
            vmap.setdefault((round(v.X, 3), round(v.Y, 3), round(v.Z, 3)), []).append(i)
    for idxs in vmap.values():
        for j in idxs[1:]:
            parent[find(idxs[0])] = find(j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(solids[i])
    return list(groups.values())


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
            if f.get("groupSides"):
                # One body per physically-SEPARATE piece. First split the solids by
                # SIDE of the plane (the two halves touch along the cut, so pure
                # connectivity would falsely merge them), then within each side group
                # solids that are actually connected. So a connected half stays ONE
                # body (a honeycomb half is dozens of solids → one piece), while
                # genuinely disconnected lumps (separate tabs) each get their own.
                # OPT-IN (new splits only) — body ids are positional, so changing the
                # count would renumber downstream bodies and break older files.
                n, o = plane.z_dir, plane.origin
                top = [p for p in pieces if (p.center() - o).dot(n) >= 0]
                bottom = [p for p in pieces if (p.center() - o).dot(n) < 0]
                groups = _vertex_components(top) + _vertex_components(bottom)
                if groups:
                    def _one(g):
                        return g[0] if len(g) == 1 else Compound(g)
                    target["shape"] = _one(groups[0])
                    for g in groups[1:]:
                        new_body(_one(g), "Split")
                else:
                    target["shape"] = res
            else:
                # legacy: one body per disconnected solid. Kept as the default so files
                # saved before `groupSides` keep their exact positional body ids (any
                # change to the body count cascades into every downstream body ref).
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


def _retarget_delete_faces(named, bodies, sels, diag, fid):
    """Resolve deleteFace selectors with global geometric re-targeting.

    Nearest-point selectors resolve across ALL bodies: the face closest to the
    recorded pick point wins, wherever it lives. This keeps the app's core
    invariant (geometry by geometric selector, never index) honest for the BODY
    reference too — body ids are positional, so an upstream split/combine
    renumbers them and the named body can quietly become a different piece of
    the part; the delete's nearest match on that wrong piece is then some
    distant face and the heal fails (measured: one inserted split turned all 9
    saved deletes red). Legitimate geometry shifts (an edited upstream dimension
    moving the face) keep working exactly as before — the moved face is still
    the global nearest. Non-point selectors (normal/axis/match) have no pick
    point to re-anchor by and stay on the named body.

    Returns (body, faces); body is None when nothing can anchor the delete. A
    re-target to a body other than the named one is recorded in `diag` as a
    lossy resolution."""
    live = [b for b in bodies if b.get("shape") is not None]
    points = [
        Vector(*sel["point"])
        for sel in sels
        if isinstance(sel, dict) and sel.get("by") == "nearest" and sel.get("point")
    ]
    has_named = named is not None and named.get("shape") is not None

    if not points or not live:
        # nothing to re-anchor by — classic resolution on the named body
        if not has_named:
            return None, []
        faces = []
        for sel in sels:
            faces.extend(resolve_faces(named["shape"], sel, diag=diag, feature_id=fid))
        return named, faces

    def bbox_dist(b, p):
        # _as_compound: a mid-timeline body can be a disjoint ShapeList, which
        # has neither .bounding_box() nor a single wrapped TopoDS
        bb = _as_compound(b["shape"]).bounding_box()
        dx = max(bb.min.X - p.X, 0.0, p.X - bb.max.X)
        dy = max(bb.min.Y - p.Y, 0.0, p.Y - bb.max.Y)
        dz = max(bb.min.Z - p.Z, 0.0, p.Z - bb.max.Z)
        return (dx * dx + dy * dy + dz * dz) ** 0.5

    # pass 1: the body owning the globally-nearest face to the first pick point
    # (a delete heals ONE solid; all of a multi-face delete's picks were made on
    # the same body, so the first point is a sound anchor). Cheap bbox lower
    # bound first, so distant bodies never pay a face scan.
    p0 = points[0]
    winner = None  # (dist, body)
    for b in sorted(live, key=lambda b: bbox_dist(b, p0)):
        if winner is not None and bbox_dist(b, p0) >= winner[0]:
            break
        try:
            d = min(fc.distance_to(p0) for fc in _as_compound(b["shape"]).faces())
        except Exception:
            continue
        if winner is None or d < winner[0]:
            winner = (d, b)
    if winner is None:
        return (named, []) if has_named else (None, [])

    target = winner[1]
    if has_named and target is not named and diag is not None:
        diag.append({
            "feature_id": fid,
            "kind": "deleteFace",
            "resolved": 1,
            "confidence": 0.8,
            "lossy": True,
            "reason": f"picked face found on {target['id']} "
                      f"(body ids shifted upstream); re-targeted from {named['id']}",
        })

    # pass 2: resolve every selector on the winning body
    faces = []
    for sel in sels:
        faces.extend(resolve_faces(target["shape"], sel, diag=diag, feature_id=fid))
    return target, faces


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
        _skip_feature(diag, f, "combine", "target body already consumed or missing")
        return
    tool_ids = f.get("tools") or [b["id"] for b in bodies if b["id"] != target["id"]]
    tools = [t for t in (find_body(tid) for tid in tool_ids) if t is not None and t["id"] != target["id"]]
    if not tools:
        _skip_feature(diag, f, "combine", "tool bodies already consumed or missing")
        return

    shape = target["shape"]
    before_vol = _try_vol(shape)
    for t in tools:
        if op == "join":
            shape = shape + t["shape"]
        elif op == "cut":
            shape = shape - t["shape"]
        else:  # intersect
            shape = shape & t["shape"]
    # No-op / destructive guards, same volume-eps convention as
    # _boolean_into_bodies. Only the SILENT failure modes raise: a Cut that
    # removed nothing still consumes the tools (the user loses bodies and gains
    # nothing), and an Intersect that empties the target destroys it outright.
    # Join-with-embedded-tool and Intersect-inside-tool are NOT guarded — their
    # volume is unchanged but they visibly absorb the tool bodies, which is a
    # legitimate, observable operation (unlike extrude, nothing here is silent).
    # Volume-read failures skip the guard (never raise a misleading no-op error).
    after_vol = _try_vol(shape)
    if before_vol is not None and after_vol is not None:
        guard_eps = _noop_eps(before_vol)
        if op == "cut" and after_vol >= before_vol - guard_eps:
            raise ValueError(
                "Combine (Cut) removed nothing — no tool body overlaps the target."
            )
        if op == "intersect" and after_vol < guard_eps:
            raise ValueError(
                "Combine (Intersect) would leave the target empty — the tools "
                "don't overlap it."
            )
    # A join of ragged/facet-heritage bodies GLUES solids instead of merging
    # them: the "combined" body stays a compound of pieces sharing interior
    # walls, with coincident skins and a visible seam at every contact — the
    # boolean-rot class the cleanUp feature repairs after the fact. Repair it
    # AT THE SOURCE so a Combine yields one true solid. _unify_body is a fast
    # no-op on clean results and hard-validated (any doubt → unchanged), and
    # replayed history heals existing combines on the next rebuild.
    target["shape"] = _unify_body(shape) if op == "join" else shape

    if not f.get("keepTools"):
        consumed = {t["id"] for t in tools}
        bodies[:] = [b for b in bodies if b["id"] not in consumed]


def _skip_feature(diag, f, kind, reason):
    """Record a non-fatal stale-body-reference skip for any feature (same
    shape as geom_select's selector diagnostics) — so the rebuild result
    surfaces that the feature did nothing instead of silently dropping it.
    No `diag` list = nothing recorded, and the feature is simply skipped."""
    if diag is None:
        return
    diag.append(
        {
            "feature_id": f.get("id"),
            "kind": kind,
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


def _press_pull(part, face, d, clamp=True):
    """Push/pull a single solid face by signed distance `d` (mm): +d grows the body
    (boss), -d cuts inward (pocket). `clamp=False` skips the inward-push safety
    cap: the up-to-surface path computes an EXACT distance to a user-chosen
    target, and capping at 90% of local thickness silently stopped short.

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
        dd = _clamp_planar(part, face, d) if clamp else d  # cap an inward push so it can't go through
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
    interactively-drawn polyline profile can be extruded like in mainstream MCAD.
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
    # crossing a profile carves it into separately-selectable sub-areas (mainstream MCAD
    # parity), and touching/overlapping loops split at the shared boundaries. This
    # mirrors the frontend arrangement (src/sketch/region.ts).
    located_faces = _subdivide_faces(all_edges, plane)

    if faces:
        sk = faces[0]
        for fc in faces[1:]:
            sk = sk + fc
        # Disjoint loops (e.g. a honeycomb of many hexagons) make `sk` a ShapeList,
        # which `plane * sk` rejects — normalize to one Compound first.
        if _wrapped_or_none(sk) is None:
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
        if _wrapped_or_none(sk) is None:
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
    separately-selectable sub-areas (MCAD parity), and touching/overlapping loops
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
