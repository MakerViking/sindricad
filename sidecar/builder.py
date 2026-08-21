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
from types import SimpleNamespace

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import (
    Rectangle,
    Circle,
    Box,
    Cylinder,
    Sphere,
    Polyline,
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
    Text,
    FontStyle,
    Align,
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
    thicken,
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
    edge_fingerprint,
    _edge_mid,
    _edge_dir,
    _edge_curve,
    _edge_radius,
    _edge_center,
    _edge_cost,
    _edge_dedup_key,
    _bbox_diag,
    POS_DRIFT,
    REL_DRIFT,
)
import texture
import untrusted
from errors import BODY_SLOT, GeomError

PLANES = {"XY": Plane.XY, "XZ": Plane.XZ, "YZ": Plane.YZ}
AXES = {"X": Axis.X, "Y": Axis.Y, "Z": Axis.Z}
KEEP = {"top": Keep.TOP, "bottom": Keep.BOTTOM, "both": Keep.BOTH}


def _sketch_plane_ref(f):
    """A sketch's plane reference, preferring a by-id datum link over the baked
    placement. Follows the `split` precedent: a datum id lives in its OWN
    `planeId` field rather than being smuggled into `plane`, so `plane` stays a
    valid PlaneSpec for every existing reader (and stays populated as a cache, so
    the frontend can place the sketch without resolving the datum first).

    This is what makes an offset plane stay editable: edit the datum's offset and
    the sketch follows, instead of the distance being baked into `plane.origin`."""
    return f.get("planeId") or f["plane"]


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
    """Serialize a body to a base64 ASCII BREP string. LEGACY.

    This is how imported geometry used to be embedded in the document. Nothing
    writes it any more — v5 stores binary BREP in the blob store and the document
    carries only its content hash (`_shape_to_blob`), because on the 356 MiB
    reference assembly this encoding produced a 541.8 MiB field, over both the
    websocket frame cap and the 64 MiB embedded-BREP cap.

    Kept because `_brep_b64_to_shape` still READS pre-v5 documents, and the tests
    need to be able to construct one."""
    buf = io.BytesIO()
    export_brep(shape, buf)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _shape_to_blob(shape):
    """Store a shape's geometry in the durable blob store and return its content
    hash.

    THE HASH RULE. `blobstore.put_bytes` hashes exactly the bytes it stores, at
    the moment they are produced, and we carry that value from here into the
    document. Never re-derive a hash by re-serialising a shape: `write(read(x))
    != x` byte-wise for BREP, because reading rebuilds the shape graph in a
    different but equivalent order. A re-derived hash would change on every
    generation, so every lookup would miss.

    Raises on failure, deliberately. The document no longer carries an embedded
    copy, so a hash we could not store means a feature with NO geometry
    anywhere — and quietly handing back a document like that would lose the
    user's import in a way nothing downstream could detect. Refusing the import
    is recoverable; a silently empty document is not."""
    import geomstore
    import blobstore

    try:
        return blobstore.default_store().put_bytes(geomstore.serialize_shape(shape))
    except Exception as e:  # noqa: BLE001
        raise ValueError(
            f"could not store the imported geometry ({e}). Check free disk space "
            "and permissions on the SindriCAD data directory."
        ) from e


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


def _list_shapes(lst):
    """Elements of an OCP shape list WITHOUT draining its Python iterator.

    Exhausting a pybind11-bound OCCT collection costs ~101 us of FIXED cost when
    StopIteration fires, independent of length, while Extent() is 0.18 us and
    First()/Last() are 0.55 us together. In a per-EDGE loop that dominates
    everything else: the same pattern in tessellate.edge_polylines_by_body was
    11x on the reference assembly, and here it measured 3.2-3.4x on
    _refacet_clean and 1.66x end-to-end on a 64k-triangle mesh import.

    First() on an EMPTY list raises Standard_NoSuchObject, so the count is
    checked before either accessor is touched. An edge has one or two adjacent
    faces in all but non-manifold geometry, so the drain only happens in the >2
    case. Returns a tuple so callers can iterate it as often as they like for
    free. (tessellate.py carries its own copy — see the note in its version.)"""
    n = lst.Extent()
    if n == 0:
        return ()
    if n == 1:
        return (lst.First(),)
    if n == 2:
        return (lst.First(), lst.Last())
    return tuple(lst)  # non-manifold: rare, and correctness beats the microseconds


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
                    for other in _list_shapes(emap.FindFromKey(exp.Current())):
                        j = fmap.FindIndex(other)
                        if j != i:
                            out.add(j)
                exp.Next()
            return out

        fverts = {
            i: np.array([(v.X, v.Y, v.Z) for v in f.vertices()])
            for i, f in faces_by_idx.items()
        }

        # This function is the longest stretch on the mesh-import path that has
        # loops in it at all, and it published NOTHING while it ran — so the
        # stall watchdog saw a heartbeat that had stopped moving and reaped a
        # worker that was making real progress (field f3b9c287; measured 116.7 s
        # here on a 124,668-triangle plate). A tick AROUND a long loop proves
        # nothing — the gap the watchdog sees is INSIDE it — so the loops publish
        # from within.
        #
        # Where the time actually goes, measured on a 50,188-triangle plate
        # (24.2 s total): 54% in the sew + ShapeFix pair further down, which are
        # two single OCCT calls with no loop in them at all; 11% in the final
        # validation; then ~9% rebuilding regions, ~6% growing them, ~6% reading
        # face vertices. So ticking the loops is HALF the fix — the import
        # budget in server.py's `import` branch covers the blocking calls.
        #
        # Every `n`th iteration rather than every one: a tick is cheap but not
        # free (it crosses into a shared mp Value), and the watchdog's budget is
        # tens of seconds, so per-iteration resolution buys nothing. The stride
        # is per-loop because one iteration means very different work in each —
        # a whole region rebuilt vs one triangle bucketed.
        #
        # keep_index throughout this function: it runs INSIDE something that has
        # already said what it is — the import's "Simplifying faces" phase, or a
        # cleanUp feature's own index — and a bare liveness tick that overwrote
        # that would leave the STALL line and the crash reply naming nothing.
        def _tick_every(k, n=64):
            if k % n == 0:
                progress_tick(keep_index=True)

        # region-grow from the biggest faces: absorb an edge-adjacent face when
        # ALL its vertices lie within tol of the ANCHOR's plane (anchored, not
        # chained, so regions can't drift step by step across the part)
        region = {}
        planes = []  # region id -> (point, normal) as np arrays
        for grown, i in enumerate(sorted(faces_by_idx, key=lambda i: -faces_by_idx[i].area)):
            _tick_every(grown)
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
        for bucketed, (t, fid) in enumerate(zip(tri_w, face_ids)):
            _tick_every(bucketed, 8192)  # one triangle per iteration: long stride
            rid = region.get(fid_to_idx.get(fid))
            if rid is not None:
                region_tris[rid].append(t)

        new_faces = []
        for rebuilt, (rid, rtris) in enumerate(region_tris.items()):
            _tick_every(rebuilt, 16)  # a whole region per iteration: short stride
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
        # The two calls below are the single most expensive thing in here and
        # there is NO loop to tick inside either — measured 4.5 s and 8.6 s
        # (19% + 36% of the whole function) on a 50,188-triangle plate. Ticking
        # BETWEEN them is the only honest liveness signal available: it says the
        # sew finished, which is true. It halves the worst silent stretch, it
        # does not remove it — the import budget in server.py's `import` branch
        # is what has to cover what is left (see the note there).
        sew.Perform()
        progress_tick(keep_index=True)
        fixer = ShapeFix_Shape(sew.SewedShape())
        fixer.Perform()
        progress_tick(keep_index=True)
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
            progress_tick(keep_index=True)  # one connected component per pass, each its own sew
            seed = unvisited.pop()
            compo, queue = [seed], [seed]
            while queue:
                k = queue.pop()
                eexp = TopExp_Explorer(cmap.FindKey(k), TopAbs_EDGE)
                while eexp.More():
                    if cemap.Contains(eexp.Current()):
                        for other in _list_shapes(cemap.FindFromKey(eexp.Current())):
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
        progress_tick(keep_index=True)  # the hard validation below is several more OCCT calls

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
        parts = shape.solids()
        # Count FIRST. Sorting by volume computes one per solid, and a body with
        # a single solid cannot have debris — so the old order paid for a volume
        # it then threw away. Measured on the reference assembly: 42.7 s across
        # 3,071 single-solid bodies, for an answer known from the count alone.
        if len(parts) < 2:
            return shape
        parts = sorted(parts, key=lambda s: -abs(s.volume))
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
# B-rep formats get a far higher ceiling than meshes. A STEP file is a compact
# description of exact surfaces, so its byte size says little about the work it
# implies; the 356 MiB reference assembly is 3,071 leaves and 133,284 faces. A
# MESH file of the same byte size is a far larger triangle count and a much
# heavier viewport, which is why STL/3MF/OBJ keep the lower cap.
#
# What actually protects the machine now is the RAM check
# (_refuse_if_memory_is_short), which scales with the file AND with what is free
# at that moment. This is only a backstop against absurd input, so it can be
# generous without being reckless.
MAX_IMPORT_BREP_FILE_BYTES = 1024 * 1024 * 1024
MAX_IMPORT_SCAN_BYTES = 64 * 1024 * 1024    # decompressed ASCII-STL / 3MF scan window
MAX_BREP_BYTES = 64 * 1024 * 1024           # decoded embedded-BREP body cap
_BREP_MAGIC = b"CASCADE Topology V"         # OCCT ASCII BREP header signature


def _import_size_cap(fmt):
    """The file-size ceiling for `fmt`. B-rep formats (STEP/STP/BREP) get the
    higher one; everything mesh-shaped keeps the original."""
    return (
        MAX_IMPORT_BREP_FILE_BYTES
        if fmt in ("step", "stp", "brep")
        else MAX_IMPORT_FILE_BYTES
    )


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


def _canonicalize_roots(roots):
    """Canonicalise a multi-root file PER ROOT, then compound the results.

    Per root for the same reason the assembly path works per leaf: `_canonical_ok`
    compares `result.volume` against `shape.volume`, and `Compound.volume` does
    not recurse into nested compounds. Hand the gate a multi-root compound and it
    reads a partial volume it can never match, so `_canonicalize` does the whole
    expensive pass and then silently discards every bit of it. Per root, each
    comparison is on a shape the gate can actually measure.

    REACHABILITY, measured rather than assumed: this needs a STEP whose product
    count does not exceed its root count (`step_assembly`'s `is_assembly` test),
    with more than one root. A file written by OCCT's own STEPCAFControl_Writer
    from two free shapes does NOT qualify — it gains a wrapper product, so 2
    roots arrive as 3 nodes and the file takes the assembly path instead. So this
    is a correctness fix on a branch that another writer's output can reach, not
    one demonstrated against a file in this repo.
    """
    out = []
    for r in roots:
        w = _wrap_topods(r)
        if w is not None:
            out.append(_canonicalize(w))
    return Compound(children=out)


def _canonical_ok(result, shape, deep=True):
    """Is `result` an acceptable canonicalisation of `shape`?

    Same solid count, same face count, and with `deep`, also structurally valid
    with the volume within 0.5%. Any doubt (an exception anywhere in the checks)
    is a NO — this decides whether a rewritten surface gets baked permanently
    into the stored B-rep, so the safe answer is to keep the original.

    `deep` exists because the two halves differ in cost by two orders of
    magnitude. MEASURED across the 3,060 leaves of the reference assembly:
    the counts cost 3.5 s, `BRepCheck_Analyzer` 72 s and the volume comparison
    122 s. Running the full gate on every leaf made _canonicalize 209 s against
    the 6.9 s it costs without — 29x the entire pass it was meant to guard, and
    62% of the whole import.

    So: full gate after the sew/ShapeFix rebuild below, which re-creates faces
    from scratch and genuinely can produce an invalid or volume-shifted solid.
    Counts only after SweptToElementary alone, which is a topology-preserving
    modifier — the counts still catch gross damage, and this path previously had
    NO validation at all.

    NOTE the volume comparison is only meaningful when neither side is a compound
    of compounds: `Compound.volume` does not recurse, so on nested input it reads
    a partial figure and the gate can never pass. Callers with multi-root input
    must canonicalise per root (see import_geometry) rather than hand the whole
    compound in here.
    """
    from OCP.BRepCheck import BRepCheck_Analyzer

    try:
        if len(result.solids()) != max(1, len(shape.solids())):
            return False
        if len(result.faces()) != len(shape.faces()):
            return False
        if not deep:
            return True
        return bool(
            BRepCheck_Analyzer(result.wrapped).IsValid()
            and abs(result.volume - shape.volume)
            <= max(1e-6, 0.005 * abs(shape.volume))
        )
    except Exception:  # noqa: BLE001 — an unmeasurable result is not acceptable
        return False


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
            # `work` is SweptToElementary's output, and until now it was returned
            # here WITHOUT any of the validation every other exit applies. That
            # modifier rewrites surfaces across the whole shape; if it produced
            # something invalid or volume-shifted, the unchecked return baked it
            # into the embedded B-rep, permanently and silently. Same gate as the
            # converted path below.
            if work is not shape and _canonical_ok(work, shape, deep=False):
                return work
            return shape

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
        return result if _canonical_ok(result, shape) else shape
    except Exception:
        return shape


def _stl_distinct_normals(path):
    """How many DISTINCT facet normals a binary STL has, or None if it isn't one.

    Used as a cheap EMPIRICAL screen for "this mesh is organic and cannot reduce".
    It is deliberately NOT claimed as an exact bound: `_maybe_unify` merges only
    coplanar faces, but `_refacet_clean` also collapses NEAR-coplanar staircases,
    so the final face count can land well below the number of distinct normals —
    measured, a 4,001-normal sphere finishes at 1,269 faces. Calibrate against
    measurement, not against the merge rule.

    Binary STL stores the normal in the first 12 bytes of each 50-byte record, so
    this is one strided numpy read with no geometry work: measured 50 ms on 72k
    triangles. ASCII STL returns None (the caller then just skips the gate)."""
    import numpy as np

    try:
        size = os.path.getsize(path)
        if size < 84:
            return None
        with open(path, "rb") as fh:
            head = fh.read(84)
            ntri = int(np.frombuffer(head[80:84], dtype="<u4")[0])
            # the exact-size identity is what distinguishes binary from ASCII
            if ntri == 0 or size != 84 + 50 * ntri:
                return None
            raw = np.frombuffer(fh.read(50 * ntri), dtype=np.uint8)
        if raw.size != 50 * ntri:
            return None
        n = raw.reshape(ntri, 50)[:, :12].copy().view("<f4").reshape(ntri, 3)
        n = n[np.isfinite(n).all(axis=1)]
        if n.size == 0:
            return None
        # quantize before uniquing: triangles of one planar face give normals that
        # agree only to floating-point noise, and rounding merges them.
        return int(len(np.unique(np.round(n, 3), axis=0)))
    except Exception:
        return None


# Distinct-facet-normal ceiling for the early organic-mesh refusal in
# _sew_mesh_file. CALIBRATED FROM MEASUREMENT, not derived — the screen is only a
# correlate of "will not reduce", so the number is set above every mesh observed
# to import successfully, and the cost of being wrong is rejecting a model that
# would have worked. Measured on spheres/tori (normals -> outcome on the slow
# path): 4,001 -> PASS (1,269 faces), 10,105 -> PASS (1,155 faces),
# 8,631 -> reject, 19,918 -> reject. The pass/reject frontier is not monotonic in
# this statistic, so the gate sits at 20,000 — clear of the largest measured PASS
# by ~2x. Anything between 10k and 20k simply takes the old slow path and gets the
# old answer; the gate exists for the 40k-175k range, where the slow path costs
# ~2 minutes or SIGSEGVs.
MAX_IMPORT_FACET_DIRECTIONS = 20_000


def _too_dense_error(ntri):
    """The user-facing refusal for a mesh past MAX_IMPORT_TRIANGLES.

    Raised from two places, which is not redundancy: import_geometry uses the
    cheap header/line-count peek, while _sew_obj_file re-checks the EXACT count
    after parsing, because an OBJ n-gon fans out to more triangles than the
    peek's one-per-`f`-line estimate."""
    return ValueError(
        f"This mesh has ~{ntri:,} triangles — too dense to import as an editable "
        f"model (limit ~{MAX_IMPORT_TRIANGLES:,}). It's almost certainly an organic/"
        f"scanned model; reduce it first, or import a STEP / clean CAD mesh."
    )


def _sew_mesh_file(path):
    """Read a triangle-mesh file (STL/3MF/OBJ) into a sewn, editable B-rep body.

    Shared by the mesh formats and by the glTF path, which round-trips its
    triangles through a temporary STL to get here — the sew + unify + refacet
    sequence is what turns 12 triangles back into a 6-faced box, and duplicating
    it for glTF would mean maintaining two versions of the same recovery."""
    # Refuse a hopeless mesh BEFORE the expensive path, not after it. The face gate
    # at the bottom of this function only fires once sew + unify + refacet have run,
    # which on an organic mesh means the user waits for work that cannot succeed:
    # measured 117.8 s for a 125,706-triangle sphere before the refusal, and at
    # 147,851 triangles ShapeUpgrade_UnifySameDomain SIGSEGVs the worker outright
    # (~35 s in, reproduced twice) — under MAX_IMPORT_TRIANGLES, so the cap does not
    # protect against it. Screening on facet directions rejects those in ~50 ms.
    #
    # OBJ and glTF both round-trip through a temporary binary STL to get here, so
    # they inherit the gate; native 3MF does not and still takes the slow path.
    nn = _stl_distinct_normals(path)
    if nn is not None and nn > MAX_IMPORT_FACET_DIRECTIONS:
        raise ValueError(
            f"This mesh is curved/organic ({nn:,} distinct facet directions — a clean "
            f"CAD part has a few hundred at most), so it cannot reduce to an editable "
            f"model. SindriCAD edits prismatic CAD models; import a STEP or a "
            f"flat-faced part."
        )
    shapes = Mesher().read(path)
    if not shapes:
        raise ValueError("no geometry found in the mesh file")
    shape = shapes[0] if len(shapes) == 1 else Compound(list(shapes))
    # Publish the same two phases the STEP branch does. The mesh path published
    # NOTHING, so _HB_IDX stayed at phase 0 for the whole import — and phase 0's
    # share is 0.47 with frac capped at 0.95, i.e. a hard ceiling of 44%. That is
    # the "immer bei 44%" in field report b78de7ed: the bar was not stopping at a
    # stage boundary, it had simply run out of phase 0 and had no phase 1 to move
    # into. It also gives sew+unify+refacet its own stall budget instead of
    # sharing a deadline sized from the file's byte count.
    _import_phase(IMPORT_PHASE_CANONICALIZE)
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
    return shape


def _read_obj_triangles(path):
    """(positions, indices) from a Wavefront OBJ, triangulated.

    Only `v` and `f` matter for a solid import: normals and texture coords are
    per-corner presentation data that the sew + unify + refacet path recomputes
    anyway, and materials carry no geometry. Handles the three things real OBJ
    files in the wild actually use beyond the basics: `f a/b/c` corner triples
    (only the vertex index is read), NEGATIVE indices (relative to the vertices
    seen so far, per the spec), and n-gon faces (fan-triangulated, which is
    correct for the convex planar faces OBJ faces are required to be).

    Raises ValueError with a user-facing message rather than returning empty, so
    a malformed file cannot silently import as nothing."""
    verts, tris = [], []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("v "):
                p = line.split()
                if len(p) >= 4:
                    verts.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("f "):
                idx = []
                for tok in line.split()[1:]:
                    s = tok.split("/", 1)[0]
                    if not s:
                        continue
                    i = int(s)
                    # OBJ is 1-based; a negative index counts back from the last
                    # vertex READ SO FAR, so it must be resolved here and not later
                    idx.append(i - 1 if i > 0 else len(verts) + i)
                for k in range(1, len(idx) - 1):  # fan
                    tris.extend((idx[0], idx[k], idx[k + 1]))
    if not verts or not tris:
        raise ValueError("no triangles found in the OBJ file")
    # Bounds-checked only now: a POSITIVE index may legally forward-reference a
    # vertex that appears further down the file, so `n` is not known during parse.
    n = len(verts)
    if any(i < 0 or i >= n for i in tris):
        raise ValueError("the OBJ file references vertices that do not exist")
    pos = [c for v in verts for c in v]
    return pos, tris


def _sew_triangles(pos, idx):
    """Sew a raw triangle soup into an editable B-rep body.

    Round-trips through a temporary binary STL so it lands in _sew_mesh_file:
    the sew + unify + refacet recovery there is what turns 12 triangles back
    into a 6-faced box, and neither the OBJ nor the glTF importer wants a
    second copy of it. Both call here."""
    import mesh_writers

    fd, tmp = tempfile.mkstemp(suffix=".stl")
    os.close(fd)
    try:
        mesh_writers.write_stl(pos, idx, tmp)
        return _sew_mesh_file(tmp)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _sew_obj_file(path):
    """Read an OBJ into a sewn, editable B-rep body via the shared mesh path."""
    pos, idx = _read_obj_triangles(path)
    ntri = len(idx) // 3
    if ntri > MAX_IMPORT_TRIANGLES:
        raise _too_dense_error(ntri)
    return _sew_triangles(pos, idx)


def _is_ascii_stl(path):
    """True for an ASCII STL, False for binary (or anything unreadable).

    The SIZE IDENTITY is what discriminates, not the leading keyword: a binary
    STL's 80-byte header is free-form and legally may also begin with "solid",
    which is why the naive check misfires. Binary is exactly 84 + 50*n bytes with
    n at byte 80; anything else that starts with "solid" is ASCII."""
    try:
        size = os.path.getsize(path)
        if size < 15:
            return False
        with open(path, "rb") as fh:
            head = fh.read(84)
        if head[:5].lower() != b"solid":
            return False
        if len(head) < 84:
            return True  # too short to be binary at all
        import struct

        ntri = int(struct.unpack("<I", head[80:84])[0])
        return not (ntri and size == 84 + 50 * ntri)
    except OSError:
        return False


def _read_ascii_stl_triangles(path):
    """(positions, indices) from an ASCII STL, read by OCCT.

    build123d's Mesher is lib3mf, and lib3mf cannot read ASCII STL AT ALL: it
    raises "Lib3MFException 5: Reading from a stream was not possible" (verified
    against a 2-facet file). So every ASCII STL import failed outright, which is
    field report b78de7ed, "Import von STL Dateien nicht moeglich". Many
    exporters still default to ASCII, so this was not a rare corner.

    OCCT's RWStl reads BOTH encodings and is already linked in, so this needs no
    new dependency and no hand-written parser. Hand the triangles to
    _sew_triangles like OBJ and glTF do: it writes a temporary BINARY STL and
    re-enters _sew_mesh_file, so ASCII files also pick up the organic-mesh gate
    that _stl_distinct_normals can only apply to binary."""
    from OCP.RWStl import RWStl

    poly = RWStl.ReadFile_s(path)
    if poly is None or poly.NbTriangles() == 0:
        raise ValueError("no geometry found in the mesh file")
    pos = []
    for i in range(1, poly.NbNodes() + 1):
        p = poly.Node(i)
        pos.extend((p.X(), p.Y(), p.Z()))
    idx = []
    for i in range(1, poly.NbTriangles() + 1):
        a, b, c = poly.Triangle(i).Get()
        idx.extend((a - 1, b - 1, c - 1))  # OCCT indices are 1-based
    return pos, idx


def _glb_dominant_color(path):
    """The base colour of the glTF's most-used material, as '#RRGGBB', or None.

    Read straight from the GLB's JSON chunk rather than through XCAF: OCCT's
    RWGltf_CafReader does not populate the colour tool for these files (measured:
    ColorTool reports zero colours after a successful Perform), and the JSON is
    unambiguous.

    "Dominant" = the material covering the most triangles, not materials[0]. A
    file whose first material is a tiny detail would otherwise dictate the colour
    of the whole import. Returns None when the file carries no materials, which
    the caller must treat as "leave the body's colour alone".
    """
    import struct

    from mesh_writers import _linear_to_srgb_hex

    try:
        with open(path, "rb") as fh:
            head = fh.read(20)
            if len(head) < 20 or struct.unpack("<I", head[:4])[0] != 0x46546C67:
                return None
            jlen = struct.unpack("<I", head[12:16])[0]
            doc = json.loads(fh.read(jlen))
    except Exception:
        return None  # advisory only: never fail an import over a colour

    materials = doc.get("materials") or []
    if not materials:
        return None
    accessors = doc.get("accessors") or []
    weight = {}
    for mesh in doc.get("meshes") or []:
        for prim in mesh.get("primitives") or []:
            mat = prim.get("material")
            if mat is None:
                continue
            acc = prim.get("indices")
            n = accessors[acc].get("count", 0) if isinstance(acc, int) and acc < len(accessors) else 0
            weight[mat] = weight.get(mat, 0) + n
    best = max(weight, key=weight.get) if weight else 0
    if not isinstance(best, int) or best >= len(materials):
        return None
    factor = (materials[best].get("pbrMetallicRoughness") or {}).get("baseColorFactor")
    if not factor or len(factor) < 3:
        return None
    return _linear_to_srgb_hex(factor)


def _read_glb(path):
    """Read a binary glTF (.glb) into a single shape via OCCT's own reader.

    glTF is Y-up and carries its own unit scale; RWGltf_CafReader does both
    conversions itself (SetSystemCoordinateSystem / SetSystemLengthUnit), which is
    why this does not hand-roll a rotation — getting that wrong lands every import
    on its side, and the file still loads, so it is easy to miss.

    The result is a faceted mesh body with the same limits as the STL/OBJ path:
    glTF carries triangles, not B-rep, so there is nothing prismatic to recover.
    """
    from OCP.Message import Message_ProgressRange
    from OCP.RWGltf import RWGltf_CafReader
    from OCP.RWMesh import RWMesh_CoordinateSystem
    from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document

    doc = TDocStd_Document(TCollection_ExtendedString("glb"))
    reader = RWGltf_CafReader()
    reader.SetDocument(doc)
    reader.SetParallel(True)
    reader.SetSystemLengthUnit(0.001)  # our documents are millimetres
    reader.SetSystemCoordinateSystem(RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup)
    reader.SetFileCoordinateSystem(RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Yup)
    if not reader.Perform(TCollection_AsciiString(path), Message_ProgressRange()):
        raise ValueError("couldn't read this glTF file — it may be corrupt or not a .glb")
    shape = reader.SingleShape()
    if shape is None or shape.IsNull():
        raise ValueError("no geometry found in the glTF file")
    # _wrap_topods, not Shape.cast: the reader hands back a raw TopoDS_COMPOUND,
    # which Shape.cast() turns into None (see its docstring).
    wrapped = _wrap_topods(shape)
    if wrapped is None:
        raise ValueError("couldn't interpret the geometry in this glTF file")
    return wrapped


def _assembly_payload(asm):
    """Turn a read STEP assembly into the flat blob shape plus its manifest.

    The blob's top-level children ARE the leaf occurrences, in order, already
    world-placed. Nesting is deliberately NOT kept in the geometry: binding
    manifest row i to child i only needs flat order to survive the BREP round
    trip, which is a far weaker property than 12 levels of nesting surviving,
    and is asserted directly by test_assembly.py.

    `_canonicalize` runs PER LEAF rather than over the whole shape. That is not
    only cheaper — it is the only version that can work at all here. Gate 4
    compares `result.volume` against `shape.volume`, and `Compound.volume`
    (composite.py) does not recurse into nested compounds, so the gate is
    structurally unpassable for any assembly shape. A single solid is exactly
    what those gates were written for.
    """
    leaves, parts = [], []
    for node_index, topods in asm.leaves:
        leaf = _wrap_topods(topods)
        if leaf is None:
            continue
        if leaf.solids():
            leaf = _canonicalize(leaf)
        else:
            # A solid-less product (a bare face or shell) fails gate 1 —
            # `len(solids) == max(1, len(shape.solids()))` compares 0 against 1
            # — so canonicalizing it can only waste time and never succeed.
            pass
        leaves.append(leaf)
        parts.append({"node": node_index, "faces": len(leaf.faces())})

    nodes = [
        {
            "name": n.name,
            "parent": n.parent,
            **({"color": n.color} if n.color else {}),
        }
        for n in asm.nodes
    ]
    return Compound(children=leaves), nodes, parts


# Peak RSS an import costs, as a multiple of the FILE size, over and above the
# already-resident OCCT/build123d libraries. MEASURED on generated STEP
# assemblies: a 13.7 MiB file grew RSS by 122.1 MiB (8.94x) and a 46.1 MiB file
# by 370.4 MiB (8.04x) — linear in file size across that range. 10x is those
# numbers with headroom, not a guess.
#
# Deliberately conservative in the SAFE direction: over-estimating the cost makes
# us refuse an import that might just have fitted, which the user can act on.
# Under-estimating it hands them an OOM kill, which arrives as "the geometry
# kernel crashed" and sends them hunting a geometry bug that does not exist.
IMPORT_RSS_PER_FILE_BYTE = 10

# Leave this much of the estimate as slack for everything else on the machine.
# An import that would consume literally all available memory takes the desktop
# down with it.
_MEMORY_HEADROOM = 1.25


def _refuse_if_memory_is_short(size, available=None):
    """Refuse an import that plainly will not fit in RAM, BEFORE OCCT starts.

    An OOM kill lands on the worker as a bare SIGKILL with no traceback, which
    the supervisor can only report as "the geometry kernel crashed" — naming a
    geometry fault for what is actually a machine limit.

    Proceeds silently when memory cannot be measured (`available_bytes()`
    returns None on an unrecognised platform or a failed probe): refusing on a
    number we could not read would be a worse failure than the one this prevents.
    """
    if size <= 0:
        return
    if available is None:
        import sysmem
        available = sysmem.available_bytes()
    if available is None:
        return  # unknown — never refuse on a number we could not read
    need = size * IMPORT_RSS_PER_FILE_BYTE
    if need * _MEMORY_HEADROOM <= available:
        return
    import sysmem
    raise ValueError(
        f"not enough memory to import this file — it needs about "
        f"{sysmem.describe(need)} and only {sysmem.describe(available)} is free. "
        f"Close some applications and try again, or import a smaller file."
    )


def import_geometry(path, fmt):
    """Read an external geometry file and return the document payload for an
    `import` feature: {brep, solid, faces, name}. STL/3MF/OBJ are read as a
    (watertight) mesh solid; STEP/BREP come in as native B-rep."""
    fmt = (fmt or "").lower()
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    cap = _import_size_cap(fmt)
    if size > cap:
        raise ValueError(
            f"file is {size / (1024 * 1024):.0f} MiB — too large to import "
            f"(limit {cap // (1024 * 1024)} MiB)."
        )
    _refuse_if_memory_is_short(size)
    manifest = None
    if fmt in ("step", "stp"):
        # Read the XCAF product tree ourselves rather than through
        # build123d.import_step: that helper mangles every product name
        # (translate(" .()" -> "____"), so "M3 Nut (x20)" arrives as
        # "M3_Nut__x20_") and its `.children` are not world-placed. Same
        # STEPCAFControl_Reader underneath, so this is one read, not two.
        # Phase-marked because these are the two multi-minute stages on a large
        # assembly: measured 90.6 s for the read and 93.9 s for _canonicalize on
        # a 356 MiB file. _canonicalize being the LARGER of the two is why a bar
        # covering only the read would sit at 100% for a minute and a half.
        import step_assembly

        _import_phase(IMPORT_PHASE_READ)
        asm = step_assembly.read_assembly(path)
        _import_phase(IMPORT_PHASE_CANONICALIZE)
        if asm.is_assembly:
            shape, nodes, parts = _assembly_payload(asm)
            manifest = {"nodes": nodes, "parts": parts}
        else:
            # An ordinary part file stays on the historical path: ONE shape,
            # canonicalized whole, no manifest. Verified geometrically identical
            # to import_step's result across every .step in this repo.
            #
            # snap near-analytic spline faces to true planes/cylinders/… ONCE at
            # import, so the canonical form is baked into the embedded BREP.
            if len(asm.roots) == 1:
                shape = _canonicalize(_wrap_topods(asm.roots[0]))
            else:
                shape = _canonicalize_roots(asm.roots)
    elif fmt == "brep":
        shape = import_brep(path)
    elif fmt in ("stl", "3mf", "obj"):
        ntri = _peek_triangle_count(path, fmt)
        if ntri and ntri > MAX_IMPORT_TRIANGLES:
            raise _too_dense_error(ntri)
        if fmt == "obj":
            # build123d's Mesher reads ONLY .3mf and .stl, so every .obj import
            # raised a raw "Unknown file format .obj" — while both file pickers
            # advertised OBJ (src/io/files.ts). Parse it here and round-trip the
            # triangles through a temporary STL, exactly as the glTF branch below
            # does, so OBJ inherits the same sew + unify + refacet recovery
            # instead of a second copy of it.
            shape = _sew_obj_file(path)
        elif fmt == "stl" and _is_ascii_stl(path):
            # lib3mf (build123d's Mesher) cannot read ASCII STL, so this used to
            # fail 100% of the time. Read it with OCCT and round-trip the
            # triangles through the shared recovery path.
            pos, idx = _read_ascii_stl_triangles(path)
            shape = _sew_triangles(pos, idx)
        else:
            shape = _sew_mesh_file(path)
    elif fmt == "glb":
        # OCCT's glTF reader returns ONE triangulated FACE per mesh — geometrically
        # correct but a surface body, so a GLB box arrived as 1 face / 0 solids
        # where the identical STL imports as 6 faces and a real solid. Round-trip
        # the triangles through the shared mesh path rather than duplicating (or
        # skipping) its sew + unify + refacet work.
        from tessellate import tessellate

        pos, idx, _fids = tessellate(_read_glb(path), tolerance=0.01)
        ntri = len(idx) // 3
        if ntri > MAX_IMPORT_TRIANGLES:
            raise ValueError(
                f"This glTF has ~{ntri:,} triangles — too dense to import as an editable "
                f"model (limit ~{MAX_IMPORT_TRIANGLES:,}). Reduce it first, or import a "
                f"STEP / clean CAD mesh."
            )
        shape = _sew_triangles(pos, idx)
    else:
        # Coded, not just worded: this is the one refusal on the import path that
        # is purely about the REQUEST (an unknown format string), so a caller has
        # to be able to tell it apart from a real geometry failure without
        # matching prose. Local import, matching the other errors use in here.
        from errors import GeomError, BAD_REQUEST

        raise GeomError(f"unsupported import format: {fmt}", BAD_REQUEST)

    is_solid = len(shape.solids()) > 0
    name = os.path.splitext(os.path.basename(path))[0] or "Imported"
    _import_phase(IMPORT_PHASE_ENCODE)
    # The content hash of the geometry in the durable blob store. This REPLACED
    # an inline base64 ASCII BREP: on the 356 MiB reference assembly that field
    # alone was 541.8 MiB, i.e. 4.2x over the websocket frame cap and 6.4x over
    # the 64 MiB embedded-BREP cap re-checked on every rebuild, which is why a
    # large assembly could not be opened at all. Documents saved before this
    # still carry `brep` and are still read (see _import_shape).
    out = {
        "geom": _shape_to_blob(shape),
        "solid": is_solid,
        "faces": len(shape.faces()),
        "name": name,
    }
    # Only glTF carries a material colour worth honouring. Omitted (not null) when
    # there is none, so the frontend can tell "no colour in the file" from black.
    if fmt == "glb":
        colour = _glb_dominant_color(path)
        if colour:
            out["color"] = colour
    # The assembly tree, when the file carried one. Absent for every other
    # import, which is what keeps the historical rebuild path byte-identical.
    if manifest:
        out.update(manifest)
    return out


# --- rebuild -----------------------------------------------------------------


# Optional progress hook (set by the server's worker init): called once per
# feature so the supervisor can kill on STALL rather than wall clock. Must
# never be able to break a rebuild.
on_feature_tick = None


# Import phase codes, published through the SAME channel rebuild progress uses
# (on_feature_tick -> the parent's _HB_IDX). Display only: OCP holds the GIL for
# the whole of ReadFile+Transfer, so nothing can be observed INSIDE a phase and
# these must never be mistaken for a liveness signal.
#
# Determinate progress is not available: Message_ProgressIndicator cannot be
# constructed or subclassed in this OCP build (forcing one via __new__ and
# calling Start() segfaults), every Message_ProgressRange reports IsActive()
# False, and a watchdog thread gets zero wakeups because of the GIL. Phase
# codes are what is left.
IMPORT_PHASE_READ = 0        # reading + converting the file (build123d import_step)
IMPORT_PHASE_CANONICALIZE = 1  # _canonicalize: the LARGEST phase on a big assembly
IMPORT_PHASE_ENCODE = 2      # serialising the B-rep for the wire


def _import_phase(code):
    """Publish an import phase. Looked up through globals() every call because
    the worker rebinds `on_feature_tick` at startup — a module-scope
    `from builder import on_feature_tick` would capture None forever."""
    cb = globals().get("on_feature_tick")
    if cb is not None:
        try:
            cb(code)
        except Exception:
            pass  # a dropped progress frame must never fail an import


# The index a LIVENESS-ONLY tick publishes. The worker's hook honours it by
# leaving the shared index untouched (server._heartbeat_hook), which is the whole
# point: such a tick says "still alive", it does not say what is running, so it
# must not erase what does. Publishing -1 for it erased the import phase — the
# first tick inside _refacet_clean turned "Simplifying faces" into "(feature
# index -1)" in the STALL line and in the crash reply's feature_index, i.e. the
# very stall diagnostic these ticks exist to make useful named nothing.
#
# A distinct sentinel rather than reusing -1, because -1 has a MEANING that is
# still wanted elsewhere: the meshing/checkpoint ticks publish it to say "no
# feature is building", which is what stops the timeline claiming one is.
HB_KEEP_INDEX = -2


def progress_tick(keep_index=False):
    """Publish one unit of progress from a long phase that isn't a feature build
    (export meshing, checkpoint writes, the interference sweep). Same globals()
    lookup as `_import_phase`, for the same reason.

    `-1` is the server's documented "not a feature" heartbeat index, so this
    advances the counter without claiming some feature is building. It matters
    because the supervisor reaps on a heartbeat that STOPS MOVING: a phase that
    runs long without ticking is killed for being slow rather than for being
    wedged, which is the exact distinction the stall watchdog exists to make.

    `keep_index=True` publishes HB_KEEP_INDEX instead: use it from a stretch that
    runs INSIDE a phase or a feature that has already announced itself, so the
    liveness signal does not overwrite the name of what is running."""
    cb = globals().get("on_feature_tick")
    if cb is not None:
        try:
            cb(HB_KEEP_INDEX if keep_index else -1)
        except Exception:
            pass  # a dropped progress frame must never fail the work


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
    features: object = None     # the document's feature list (timeline-prefix context for projection sources)
    projections: object = None  # optional list; projection refresh entries append here (like diagnostics)


# --- feature handlers ---------------------------------------------------------
# One function per feature type, dispatched from the rebuild() loop below. Each
# handler is the exact body of the old inline if/elif branch (same logic, same
# comments, same error messages) — the loop still owns the try/except/errors.append
# and the no-op-continue semantics; handlers just raise like the old branches did.


def _handle_sketch(f, ctx):
    ctx.sketches[f["id"]] = _build_sketch(f, ctx.val, ctx.datums)
    # Associative projection refresh (opt-in, like diagnostics): re-resolve
    # projected entities against the timeline-prefix state we're sitting on
    # right now (ctx.bodies holds exactly the bodies built BEFORE this sketch).
    if ctx.projections is not None:
        _recompute_projections(f, ctx)


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
    # A missing sketch is almost always an UPSTREAM failure, not a broken
    # reference: the sketch feature raised (bad profile, non-planar wires) and so
    # never registered. Indexing ctx.sketches raw turned that into `KeyError:
    # 'f1'`, which the generic handler surfaced as "extrude failed (KeyError)" —
    # burying the real cause behind an internal error and making the user chase
    # the wrong feature. Name the sketch instead and say it didn't build.
    entry = _require_sketch(ctx, f.get("sketch"), "extrude")
    sk = entry["sketch"]
    if sk is None:
        raise ValueError("sketch has no closed profile to extrude")
    # A zero-distance extrude sweeps nothing; OCCT reports it as
    # Standard_ConstructionError. Negative IS meaningful (extrude the other way).
    if ctx.val(f["distance"]) == 0:
        raise ValueError("Extrude: distance must not be 0")
    # region points (one per selected area) pick + combine specific
    # profiles; a ring (annulus) keeps its hole, several areas union.
    pts = f.get("regions")
    if not pts and f.get("region"):
        pts = [f["region"]]
    if pts:
        # precompute cell bboxes ONCE (region picking is per-point)
        cells = [(fc, fc.bounding_box()) for fc in entry["faces"]]
        # Entity ids recorded when each area was picked. They outlive the point:
        # see _region_anchor_from_entities and field report a20cca53. Absent on
        # every document written before this existed, which is why the point stays
        # the fallback rather than being replaced.
        ents = f.get("regionEntities") or []
        # Each area's HOLE loops, parallel to `ents`. Without them the anchor is
        # derived from the outer loop alone, which rebuilds a SOLID face whose
        # centre sits inside the hole — field report 19314fdc, "extrude the shell
        # wall ... the result is never the shell, but the inside loop extrusion".
        hole_ents = f.get("regionHoleEntities") or []
        sel = []
        for i, p in enumerate(pts):
            # `_region_face_from_entities`, never the raw anchor: the check that
            # the rebuilt profile IS the cell the anchor landed in lives inside it,
            # and a caller that skips it inherits field 19314fdc.
            rf = (
                _region_face_from_entities(
                    entry, cells, ents[i], hole_ents[i] if i < len(hole_ents) else None
                )
                if i < len(ents)
                else None
            )
            if rf is None:
                rf = _region_face_at(
                    cells, Vector(*p), ctx.diagnostics, f.get("id"),
                )
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


def _group_sels_by_body(sel, ctx, label):
    """Split a selector (or list of them) into [(body, [selectors])] groups, in
    first-seen order.

    A selector's OWN `body` decides which shape it resolves against — the tools
    stamp it from the edge/face the user actually clicked. Without this a
    multi-body model resolves every selector against require_active() =
    bodies[-1], and because `by:"nearest"` always returns SOME winner it edits
    whichever body happened to be created last, silently (the ring/hexagon bug).

    A selector with no `body` falls back to the active body: that is exactly the
    old behaviour, so documents saved before the tools stamped bodies keep
    building unchanged.
    """
    sels = sel if isinstance(sel, list) else [sel]
    groups = {}  # body id -> (body, [selectors]); dicts keep insertion order
    for s in sels:
        bid = s.get("body") if isinstance(s, dict) else None
        if bid:
            body = ctx.find_body(bid)
            if body is None:
                raise ValueError(f"{label}: the target body no longer exists")
        else:
            body = ctx.require_active(label)
        groups.setdefault(body["id"], (body, []))[1].append(s)
    return list(groups.values())


def _blend_edges(f, ctx, label, combined, one_edge, blend_size):
    """Shared fillet/chamfer body: blend every selected edge, per owning body.

    `combined(edges) -> shape` runs the kernel op on a whole group at once;
    `one_edge(edge) -> shape` does a single edge (the fallback + failure probe).

    ALL-OR-NOTHING across bodies: every group's new shape is computed first and
    only assigned once they ALL succeed. Otherwise a two-body fillet whose
    second body raises would leave the first one blended while the timeline
    paints the feature red — a solid the user never asked for.
    """
    staged = []
    # A zero or negative blend is not a small blend, it is no blend. OCCT's own
    # message ("try a smaller value") is actively misleading for radius 0 or -3.
    if blend_size is not None and not (blend_size > 0):
        raise ValueError(
            f"{label}: size must be greater than 0 (got {blend_size:g})"
        )
    for body, sels in _group_sels_by_body(f["edges"], ctx, label):
        edges = resolve_edges(body["shape"], sels, diag=ctx.diagnostics, feature_id=f.get("id"))
        if not edges:
            raise GeomError(f"no edge found to {label.lower()} on {BODY_SLOT}",
                            body_id=body["id"], subject=body.get("name"))
        try:
            new_shape = combined(edges)
        except Exception as combined_err:
            # Combined call failed: fall back to per-edge blending on the evolving body.
            new_shape, unresolved = _sequential_blend(
                body["shape"], edges, lambda s, e: one_edge(e), blend_size, body["shape"]
            )
            if unresolved:
                # Hard no-silent-degradation rule: any edge we could not blend means
                # the feature FAILS — never a partial solid, never a smaller radius.
                # Paint exactly the offenders red, then re-raise the original error.
                _report_edge_failures(f, ctx, unresolved, one_edge)
                raise GeomError(f"{label} failed on {BODY_SLOT}: {combined_err}",
                                body_id=body["id"],
                                subject=body.get("name")) from combined_err
        staged.append((body, new_shape))
    for body, shape in staged:
        body["shape"] = shape


def _handle_fillet(f, ctx):
    r = ctx.val(f["radius"])
    _blend_edges(f, ctx, "Fillet", lambda es: fillet(es, radius=r), lambda e: fillet([e], radius=r), r)


def _handle_chamfer(f, ctx):
    d = ctx.val(f["distance"])
    _blend_edges(f, ctx, "Chamfer", lambda es: chamfer(es, length=d), lambda e: chamfer([e], length=d), d)


def _bad_up_to_plane(up_plane, f, ctx):
    """Why an `upToPlane` id didn't resolve to a datum — as an exception to raise.

    Four causes look identical from ctx.datums alone (the id simply isn't a key),
    and they need opposite fixes: reorder the timeline, undo a delete, re-pick the
    reference, or repair an upstream feature. The document's feature list
    distinguishes them, so ask it rather than assuming the ordering case.

    The id is UNTRUSTED document text and rides in `subject`, not in the sentence.
    """
    feats = list(ctx.features or ())
    ids = [g.get("id") for g in feats]
    # position of the press/pull itself: everything at a LATER index is "not yet"
    here = ids.index(f.get("id")) if f.get("id") in ids else len(feats)
    at = next((i for i, gid in enumerate(ids) if gid == up_plane), None)
    if at is None:
        msg = ("Press/Pull: the 'up to' plane is gone — the datum plane it points at "
               "was deleted. Re-pick a target.")
    elif feats[at].get("type") != "datumPlane":
        msg = ("Press/Pull: the 'up to' plane points at a feature that isn't a datum "
               "plane. Pick a datum plane, or XY / XZ / YZ.")
    elif at > here:
        msg = ("Press/Pull: the 'up to' plane isn't in the timeline yet — a datum plane "
               "has to come BEFORE the press/pull that extrudes up to it.")
    else:
        # earlier in the timeline, but never registered → its own feature failed
        msg = ("Press/Pull: the 'up to' datum plane didn't build — fix that feature "
               "first, then this one can reach it.")
    return GeomError(msg, subject=up_plane)


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
    # `upTo` / `upToPlane`: extrude each face UP TO a target surface instead of by
    # a fixed distance. Capture the target plane once (point + normal) so every
    # source face extrudes to the same surface.
    #   upTo      — a face Selector (the topology-fingerprint vocabulary)
    #   upToPlane — a datumPlane feature id, or "XY"/"XZ"/"YZ". NOT a Selector: a
    #               datum has no topology to fingerprint, so it names itself the
    #               way sketch.planeId and split.planeId already do.
    up = f.get("upTo")
    up_plane = f.get("upToPlane")
    if up and up_plane:
        raise ValueError(
            "Press/Pull: set an 'up to' face or an 'up to' plane, not both — clear one first."
        )
    tgt_pt = tgt_n = None
    if up_plane:
        # ctx.datums is filled in TIMELINE ORDER, so a missing id can mean four
        # different things — and "isn't in the timeline YET" is only one of them.
        # Guessing it for all four told a user whose datum had been DELETED that it
        # "has to come BEFORE" the press/pull, the exact inverse of the truth. Look
        # the id up in the document's own feature list to tell them apart.
        # (The id is document text: it rides in `subject`, never in the prose —
        # see untrusted.py and the BODY_SLOT note in errors.py.)
        if isinstance(up_plane, str) and up_plane not in ctx.datums and up_plane not in PLANES:
            raise _bad_up_to_plane(up_plane, f, ctx)
        pl = _plane_of(up_plane, ctx.datums)
        tgt_pt, tgt_n = pl.origin, pl.z_dir
    elif up:
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
    up_any = bool(up or up_plane)
    # `upToOffset` moves the landing along the extrude direction — positive past
    # the target, negative short of it — for a face target and a plane target alike.
    up_off = ctx.val(f.get("upToOffset") or 0)
    # ...and with NO target there is nothing to measure it from, so the number the
    # user typed was read and then thrown away: `d` fell back to `distance` and the
    # offset vanished with err == [] (a 3 mm push with a 7 mm offset gave 3 mm).
    # Refuse rather than drop it — a wire that silently ignores a field is the same
    # silent class as a boolean that changes nothing. A ZERO offset is not refused:
    # it drops nothing, and a client that always sends the field must stay valid.
    if up_off and not up_any:
        raise ValueError(
            "Press/Pull: 'up to offset' only means something with an 'up to' target — "
            "pick a face or a plane to extrude up to, or clear the offset."
        )
    dist = ctx.val(f["distance"])
    for sel in sels:
        found = resolve_faces(act["shape"], sel, diag=ctx.diagnostics, feature_id=f.get("id"))
        if not found:
            raise ValueError("no face found to press/pull")
        src = found[0]
        trim = None
        if up_any:
            # per source face: the offset is measured along ITS normal, so faces
            # pushed in different directions each get their own trim plane.
            d, trim_pt = _distance_to_target(src, tgt_pt, tgt_n, up_off)
            # A target COINCIDENT with the source face is one ordinary gesture away
            # (datum on a face, press T, click that datum) and used to return the
            # part untouched with err == [] — a green chip on an operation that did
            # nothing. Same silent class as the boolean no-op guards in
            # _boolean_into_bodies, so it gets the same treatment: raise, and let
            # the rebuild loop paint the feature red. Measured AFTER the offset,
            # because a coincident target WITH an offset does move the face.
            #
            # Measured across the WHOLE face, not at `d`'s single centre sample: a
            # TILTED target through the centre reads d == 0 while moving the rest
            # of the face by millimetres, and refusing it said "already level with
            # the face you picked" about a plane that climbs to z=15 over a face at
            # z=5. Worse, it was a cliff — nudging that datum by 2e-7 mm flipped
            # the outcome between −1000 mm³, refused, and +1000 mm³. Refuse only
            # when the face would not move ANYWHERE.
            lo, hi = _face_travel_range(src, trim_pt, tgt_n)
            if max(abs(lo), abs(hi)) < _PP_NO_MOVE:
                raise ValueError(
                    "Press/Pull moved nothing — the 'up to' target is already level with "
                    "the face you picked. Pick a different target, or set an offset."
                )
            trim = (trim_pt, tgt_n)
        else:
            d = dist
        # up-to distances are exact by construction — the inward
        # clamp would silently stop short of the chosen target
        act["shape"] = _press_pull(act["shape"], src, d, clamp=(not up_any), trim=trim)


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
    entry = _require_sketch(ctx, f.get("sketch"), "revolve")
    sk = entry["sketch"]
    angle = ctx.val(f.get("angle", 360))
    # A zero-degree revolve swept nothing yet still produced a body, so the
    # timeline showed a healthy feature that had done nothing at all.
    if angle == 0:
        raise ValueError("Revolve: angle must not be 0 — nothing would be swept")
    try:
        solid = revolve(sk, axis=AXES[f.get("axis", "Z")], revolution_arc=angle)
    except Exception as ex:
        # OCCT reports a profile that straddles the axis as a bare
        # `StdFail_NotDone` ("BRep_API: command not done"), which tells the user
        # nothing. Name the overwhelmingly likely cause instead; a profile may
        # TOUCH the axis, but it may not cross it.
        raise ValueError(
            "Revolve failed — the profile probably crosses the axis of "
            f"revolution ({f.get('axis', 'Z')}). Move it fully to one side "
            f"(it may touch the axis, but not cross it). [{type(ex).__name__}]"
        )
    _boolean_into_bodies(ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, ctx.hidden_bodies)


def _handle_loft(f, ctx):
    # Fusion flow: loft through the SELECTED profile regions (each on its own
    # sketch, in the order given). Resolving the region anchor to a Face — the
    # same region picking extrude uses — keeps a ring's HOLE, and build123d's
    # loft blends faces-with-holes into a tube natively. The legacy `sketches`
    # path lofts whole un-consumed sketch profiles (ribbon fallback).
    profs = f.get("profiles")
    if profs:
        sections = []
        for pr in profs:
            entry = ctx.sketches.get(pr["sketch"])
            if entry is None or not entry.get("faces"):
                raise ValueError("a loft profile's sketch has no closed area")
            cells = [(fc, fc.bounding_box()) for fc in entry["faces"]]
            rf = _region_face_at(cells, Vector(*pr["region"]), ctx.diagnostics, f.get("id"))
            if rf is None:
                raise ValueError("no profile found under a selected loft area")
            sections.append(rf)
    else:
        sections = [_require_sketch(ctx, s, "loft")["sketch"] for s in f.get("sketches", [])]
        sections = [s for s in sections if s is not None]
    if len(sections) < 2:
        raise ValueError("loft needs at least two profiles")
    try:
        solid = loft(sections)
    except Exception as ex:
        # OCCT reports "blend these two profiles" failures as a bare
        # StdFail_NotDone. The usual causes are profiles that are identical and
        # coincident (nothing to sweep between) or wildly mismatched.
        raise ValueError(
            "Loft failed to blend these profiles — they may be coincident, "
            f"identical, or too dissimilar to connect. [{type(ex).__name__}]"
        )
    _boolean_into_bodies(ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, ctx.hidden_bodies)


def _handle_sweep(f, ctx):
    prof = _require_sketch(ctx, f.get("profile"), "sweep")["sketch"]
    if prof is None:
        raise ValueError("sweep profile has no closed section")
    path = _require_sketch(ctx, f.get("path"), "sweep").get("wire")
    if path is None:
        raise ValueError("sweep path sketch has no curve to follow")
    solid = sweep(sections=prof, path=path)
    # Same New/Join/Cut boolean path as extrude/revolve/loft: booleans against
    # every visible overlapping body, with the loud no-op guards. (Sweep used to
    # inline `act["shape"] + solid` / `- solid` against only the active body —
    # unguarded, and a Cut with no active body silently created a new body.)
    _boolean_into_bodies(ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, ctx.hidden_bodies)


def _blob_top_children(shape):
    """The blob's top-level children, in stored order. Deliberately NOT
    `.solids()`: the manifest binds row i to child i, and a leaf product with no
    solid (the ones dropped silently today) has to keep its slot."""
    from OCP.TopoDS import TopoDS_Iterator

    out = []
    it = TopoDS_Iterator(shape.wrapped)
    while it.More():
        out.append(it.Value())
        it.Next()
    return out


def _bind_assembly(f, ctx, shape, nodes, parts):
    """Name the blob's children from the assembly manifest. Returns False, having
    recorded WHY, if the manifest and the geometry disagree — the caller then
    falls back to the historical unnamed explode. A wrong tree is worse than no
    tree: every body would still build, just labelled as the wrong part."""
    children = _blob_top_children(shape)
    if len(children) != len(parts):
        _skip_feature(
            ctx.diagnostics, f, "import",
            f"assembly manifest lists {len(parts)} parts but the stored geometry "
            f"has {len(children)} top-level shapes — falling back to unnamed bodies",
        )
        return False

    wrapped = []
    for i, (child, part) in enumerate(zip(children, parts)):
        # One tick per leaf. A single import feature rebuilding a large assembly
        # was the longest SILENT phase left in the product: measured 90 s
        # emitting one tick, against a 60 s stall budget. Wave 1.1 ticked export,
        # the interference sweep and checkpoint writes and missed this one.
        progress_tick()
        w = _wrap_topods(child)
        node_index = part.get("node") if isinstance(part, dict) else None
        if w is None or not isinstance(node_index, int) or not 0 <= node_index < len(nodes):
            _skip_feature(
                ctx.diagnostics, f, "import",
                f"assembly manifest entry {i} does not refer to a known part "
                f"— falling back to unnamed bodies",
            )
            return False
        # Face count is the checksum that turns an ordinal reference into a
        # CHECKED one. Without it a reordered or re-generated blob would bind
        # silently, and the only symptom would be parts wearing each other's names.
        expected_faces = part.get("faces")
        if expected_faces is not None and len(w.faces()) != expected_faces:
            _skip_feature(
                ctx.diagnostics, f, "import",
                f"assembly part {i} expected {expected_faces} faces but the stored "
                f"geometry has {len(w.faces())} — falling back to unnamed bodies",
            )
            return False
        wrapped.append((w, node_index))

    # A product owning several solids numbers them; one owning a single solid
    # keeps its bare name. Same convention the anonymous path already used.
    owned = {}
    for _w, node_index in wrapped:
        owned[node_index] = owned.get(node_index, 0) + 1

    base = f.get("name") or "Imported"
    feature_id = f.get("id")
    seen = {}
    for w, node_index in wrapped:
        label = (nodes[node_index] or {}).get("name") or base
        if owned[node_index] > 1:
            seen[node_index] = seen.get(node_index, 0) + 1
            label = f"{label} {seen[node_index]}"
        ctx.new_body(w, label, node_ref=f"{feature_id}/{node_index}")
    return True


_BINTOOLS_MAGIC = b"Open CASCADE Topology V"


def _blob_to_shape(data):
    """A stored binary BREP blob back to a build123d Shape.

    The magic check is NOT redundant with the blob store's hash verification.
    That hash proves the bytes are the ones the container declared — it does not
    prove they are benign, because whoever crafted a hostile `.sindri` chose both
    the bytes and the declared hash. So the same reasoning as
    `_brep_b64_to_shape` applies: refuse to aim a parser fuzz at OCCT.

    There is deliberately NO size cap here, unlike the 64 MiB `MAX_BREP_BYTES` on
    the legacy embedded path. That cap is exactly what makes a large assembly
    unopenable, and it is the thing this whole change exists to remove. The bound
    that replaces it is upstream: the container reader refuses an archive that
    declares more than 8 GiB before inflating a byte."""
    import geomstore

    if not data[: len(_BINTOOLS_MAGIC) + 2].lstrip(b"\n\r ").startswith(_BINTOOLS_MAGIC):
        raise ValueError("stored geometry is not a valid binary BREP (bad header)")
    # _wrap_topods, not Shape.cast: BinTools hands back a raw TopoDS, and for an
    # assembly that is a COMPOUND, which Shape.cast() turns into None (see its
    # docstring). Same trap the XCAF reader hit.
    shape = _wrap_topods(geomstore.deserialize_shape(data))
    if shape is None:
        raise ValueError("stored geometry decoded to an empty shape")
    return shape


def _import_shape(f):
    """The geometry for an import feature.

    Prefers the content hash (`geom`) and falls back to the legacy embedded
    base64 (`brep`). Both fields are present during the transition, so a blob
    that has gone missing — a wiped app-data directory, a document copied
    without its container — still rebuilds from the embedded copy rather than
    failing. Once `brep` is gone that fallback disappears and the missing-blob
    error below becomes the live path."""
    import blobstore

    digest = f.get("geom")
    b64 = f.get("brep")
    if digest:
        data = blobstore.default_store().get_bytes(digest)
        if data is not None:
            return _blob_to_shape(data)
        if not b64:
            raise ValueError(
                "the geometry for this imported body is missing from local storage. "
                "Open the .sindri file it was saved in, or re-import the original file."
            )
        # Fall through to the embedded copy, loudly: a miss here means either a
        # wiped store or a document that travelled without its container, and
        # both are worth seeing in the log rather than silently absorbing.
        print(f"[blobstore] blob {digest} missing; falling back to the embedded BREP",
              file=sys.stderr, flush=True)
    if not b64:
        raise ValueError("this imported body has no geometry attached")
    return _brep_b64_to_shape(b64)


def _assembly_root_index(nodes):
    """Index of the assembly's root product (the node with no parent), or None.
    First one wins: a well-formed tree has exactly one."""
    if not nodes:
        return None
    for i, n in enumerate(nodes):
        if isinstance(n, dict) and n.get("parent") is None:
            return i
    return None


def _handle_import(f, ctx):
    base = f.get("name") or "Imported"
    shape = _import_shape(f)
    nodes, parts = f.get("nodes"), f.get("parts")
    # explode:false keeps a multi-solid payload as ONE body. For imported
    # assemblies with hundreds of import features this divides body count
    # (browser tree entries, per-body payloads, draw calls) by the average
    # solids-per-import. Default (absent/true) keeps the historical
    # one-body-per-solid behavior. It is checked FIRST because it is an explicit
    # instruction to collapse, which a manifest cannot override.
    if f.get("explode") is False:
        # ...but collapsing the GEOMETRY must not throw away the TREE. This used
        # to return here with a body named "Imported" and no node_ref at all, so
        # the whole assembly hierarchy — product names, structure, colours —
        # was discarded by the one flag a user would reach for on exactly the
        # documents where that hierarchy matters most.
        #
        # One body can only honestly claim one node, so it claims the ROOT: the
        # body carries the assembly's own name and sits under it in the Browser,
        # instead of appearing as an anonymous loose body.
        root = _assembly_root_index(nodes)
        if root is not None:
            label = (nodes[root] or {}).get("name") or base
            body = ctx.new_body(shape, label, node_ref=f"{f.get('id')}/{root}")
        else:
            body = ctx.new_body(shape, base)
        # Exempt from _drop_debris. That pass deletes any solid under 0.1% of
        # the biggest one that does not touch it, on the theory that it is
        # residue from the booleans that carved the body. An explicitly
        # collapsed import is the opposite case: every solid in it is a part
        # the user's file declared, and small ones that float clear of the
        # largest are the NORM in an assembly, not debris.
        #
        # Measured on asm_nested: main body 3200 mm3, and four legitimate parts
        # at 3.0 mm3 each — 0.094%, just under the threshold — were silently
        # deleted, taking 4 of 7 parts and 24 of 42 faces with them. It never
        # showed up before because the exploded path gives each body ONE solid,
        # and the pass returns early below two.
        body["_intact"] = True
        return
    # Assembly manifest, when the import recorded one. Absent for every import
    # made before this existed and for every non-assembly file, which is what
    # keeps those documents rebuilding exactly as they did.
    if nodes and parts and _bind_assembly(f, ctx, shape, nodes, parts):
        return
    parts = _explode_solids(shape)
    if len(parts) == 1:
        ctx.new_body(parts[0], base)
    else:
        for part_no, p in enumerate(parts, 1):
            ctx.new_body(p, f"{base} {part_no}")


def _require_positive(op, **dims):
    """Reject a non-positive dimension BY NAME, before OCCT ever sees it.

    OCCT answers a zero-height box with `Standard_DomainError` and a zero-factor
    scale with `Standard_ConstructionError`. Those class names reach the user as
    the WHOLE explanation and say nothing about what to change — measured across
    seven operations in docs/EDGE-CASES.md. Every one of them is a predictable
    degenerate input, so name the field and the value the user actually typed.
    """
    for name, v in dims.items():
        if v is None:
            continue
        if not (v > 0):
            raise ValueError(f"{op}: {name} must be greater than 0 (got {v:g})")


def _require_sketch(ctx, sid, op):
    """Fetch a sketch entry, or explain WHICH upstream sketch failed.

    A missing sketch is almost always an UPSTREAM failure, not a broken
    reference: the sketch feature raised (bad profile, zero-radius circle,
    non-planar wires) and so never registered. Indexing `ctx.sketches` raw turned
    that into `KeyError: 'f1'`, which the generic handler surfaced as
    "<op> failed (KeyError)" — burying the real cause behind an internal error
    and pointing the user at the wrong feature.

    Extracted after finding the same fault in FOUR handlers (extrude, revolve,
    loft, sweep); each had its own raw lookup. Route every sketch fetch here.
    """
    entry = ctx.sketches.get(sid)
    if entry is None:
        raise ValueError(
            f"the sketch this {op} depends on ({sid}) did not build — "
            "fix that sketch first"
        )
    return entry


def _handle_box(f, ctx):
    l, w, h = ctx.val(f["length"]), ctx.val(f["width"]), ctx.val(f["height"])
    _require_positive("Box", length=l, width=w, height=h)
    ctx.new_body(Box(l, w, h), "Box")


def _handle_cylinder(f, ctx):
    r, h = ctx.val(f["radius"]), ctx.val(f["height"])
    _require_positive("Cylinder", radius=r, height=h)
    ctx.new_body(Cylinder(r, h), "Cylinder")


def _handle_sphere(f, ctx):
    r = ctx.val(f["radius"])
    _require_positive("Sphere", radius=r)
    ctx.new_body(Sphere(r), "Sphere")


def _handle_shell(f, ctx):
    # Hollow each body that owns a selected opening face — the selectors carry
    # their own body (see _group_sels_by_body), so a multi-body model shells the
    # body clicked, not bodies[-1]. No faces at all = hollow the active body
    # closed, which is the ribbon's "shell with no opening" path.
    t = ctx.val(f["thickness"])
    # A zero wall is not a shell; OCCT reports it as a bare RuntimeError. A
    # NEGATIVE thickness is legitimate (it shells outward) and is left alone.
    if t == 0:
        raise ValueError("Shell: thickness must not be 0")
    if not f.get("faces"):
        act = ctx.require_active("Shell")
        act["shape"] = _shell(act["shape"], t, [])
        return
    staged = []
    for body, sels in _group_sels_by_body(f["faces"], ctx, "Shell"):
        openings = resolve_faces(body["shape"], sels, diag=ctx.diagnostics, feature_id=f.get("id"))
        # An empty `faces` on the FEATURE means "hollow it closed" and is handled
        # above. Getting here with nothing RESOLVED is the opposite: the user
        # picked an opening and it no longer lands. _shell treats [] as "closed",
        # so without this the body comes back SEALED — it exports, it prints, and
        # nothing ever said the opening was lost. Refuse instead, like draft.
        if not openings:
            raise GeomError(f"no face found to shell on {BODY_SLOT}",
                            body_id=body["id"], subject=body.get("name"))
        staged.append((body, _shell(body["shape"], t, openings)))
    for body, shape in staged:
        body["shape"] = shape


def _handle_offset_face(f, ctx):
    # Offset Face: move the selected faces along their own normals, keeping the
    # body closed (the neighbouring faces stretch to follow). Targets the body
    # that OWNS the picked faces, like press-pull — NOT require_active, which
    # only ever sees bodies[-1] and would edit the wrong body on a multi-body model.
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Offset face")
    if act is None:
        raise ValueError("Offset face: the target body no longer exists")
    faces = resolve_faces(act["shape"], f["faces"], diag=ctx.diagnostics, feature_id=f.get("id"))
    if not faces:
        raise ValueError("no face found to offset")
    _guard_offsetable(act["shape"], faces, "Offset face")
    d = ctx.val(f["distance"])
    # Offsetting by zero moves nothing, but used to report success — the same
    # silent no-op class as revolve angle:0 and pattern count:0.
    if d == 0:
        raise ValueError("Offset face: distance must not be 0")
    # clamp per face by its own kind: a cylinder can't collapse past its radius,
    # a planar face can't be pushed through the body
    pairs = [
        (fc, _clamp_cylinder(fc, d) if fc.geom_type == GeomType.CYLINDER else _clamp_planar(act["shape"], fc, d))
        for fc in faces
    ]
    act["shape"] = _offset_faces(act["shape"], pairs)


def _handle_thicken(f, ctx):
    # Thicken: give surface geometry a wall. The input is either the faces of a
    # solid or a whole SURFACE body (a non-watertight mesh import, which is
    # read-only reference geometry until thickened).
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Thicken")
    if act is None:
        raise ValueError("Thicken: the target body no longer exists")
    sel = f.get("faces")
    faces = (
        resolve_faces(act["shape"], sel, diag=ctx.diagnostics, feature_id=f.get("id"))
        if sel
        else list(_as_compound(act["shape"]).faces())
    )
    if not faces:
        raise ValueError("no face found to thicken")
    _guard_offsetable(act["shape"], faces, "Thicken")
    t = ctx.val(f["thickness"])
    if abs(t) < 1e-9:
        raise ValueError("Thicken: the thickness is zero")
    solid = thicken(faces, amount=t, both=bool(f.get("symmetric")))
    # Default "new": a thickened surface body is its own body. "join" merges it
    # into the solids it touches (thickening a face of an existing part).
    _boolean_into_bodies(
        ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, ctx.hidden_bodies
    )


def _handle_draft(f, ctx):
    # Taper each body that owns a selected face. Staged like fillet/chamfer so a
    # failure on one body can't leave another already drafted.
    angle = ctx.val(f["angle"])
    axis = f.get("axis", "Z")
    # A 90-degree taper folds the face flat onto itself; OCCT reports it as
    # Standard_ConstructionError. Anything at or beyond vertical is degenerate.
    if not (-90 < angle < 90):
        raise ValueError(
            f"Draft: angle must be between -90 and 90 degrees (got {angle:g})"
        )
    staged = []
    for body, sels in _group_sels_by_body(f["faces"], ctx, "Draft"):
        faces = resolve_faces(body["shape"], sels, diag=ctx.diagnostics, feature_id=f.get("id"))
        if not faces:
            raise GeomError(f"no face found to draft on {BODY_SLOT}",
                            body_id=body["id"], subject=body.get("name"))
        staged.append((body, _draft(body["shape"], faces, angle, axis)))
    for body, shape in staged:
        body["shape"] = shape


def _thicken_patches(patches, depth, op, part):
    """Give each projected surface patch its depth, growing OUTWARD for an emboss
    and INWARD for an engrave.

    `thicken` follows the patch's own normal, which it inherits from the target
    shell's orientation. That points outward on everything modelled here, but an
    imported STEP face can carry a reversed orientation — in which case an emboss
    would burrow inward and an engrave would raise a scar, both silently. So the
    sign is MEASURED once, by asking whether a point half a depth along the
    patch normal is inside the part, rather than assumed.
    """
    probe = patches[0].faces()[0]
    c = probe.center()
    n = probe.normal_at(c)
    sign = 1.0 if op == "emboss" else -1.0
    try:
        step = max(depth * 0.5, 1e-3)
        outside = not part.is_inside(Vector(c.X + n.X * step, c.Y + n.Y * step, c.Z + n.Z * step))
        if not outside:
            sign = -sign  # this face's normal points INTO the part
    except Exception:
        # An unmeasurable orientation is not a reason to guess silently.
        raise ValueError("Text: couldn't tell which way is out of this face — re-pick it")
    tools = []
    for p in patches:
        t = Solid.thicken(p, depth * sign)
        if t is None:
            raise ValueError("Text: couldn't give the text depth on this face")
        tools.append(t)
    return tools


def _guard_text_plane(plane, face):
    """The text's layout plane was captured from the picked face when the tool
    ran. If an upstream edit has since moved or tilted that face, the glyphs
    would silently float off it (or sink into it) while the timeline stayed
    green — so check and raise instead.

    A planar face tessellates exactly, so the client's raycast hit lies exactly
    on the B-rep plane and a tight tolerance is safe here."""
    n = face.normal_at()
    if abs(abs(plane.z_dir.dot(n)) - 1.0) > 1e-3:
        raise ValueError("Text: the face this text sits on has tilted — re-pick the face")
    if abs(n.dot(face.center() - plane.origin)) > 1e-3:
        raise ValueError("Text: the face this text sits on has moved — re-pick the face")


def _taper_glyph_prisms(glyphs, plane, depth, bevel, f, ctx):
    """Sloped-wall glyph prisms, or none of them.

    Routed through the SAME sacrificial probe as the rim blends, for a different
    reason: this path does not only crash, it HANGS. One glyph at 40 degrees was
    still running after 30 seconds and another consumed 600 s, and OCCT holds
    the GIL throughout, so no in-worker deadline can fire — a SIGALRM armed for
    1.0 s was measured arriving at 10.39 s, exactly when the kernel returned.
    A subprocess with a timeout is the only guard that works.
    """
    angle = _taper_angle(bevel, abs(depth))
    cleared = _probe_bevels(_bevel_recipe(f, ctx, bevel, ("taper",)))
    bad = [i for i in range(len(glyphs)) if not cleared.get((i, "taper"), False)]
    if bad:
        raise ValueError(
            f"Text: sloped walls at {angle:.0f}° don't work on {len(bad)} of the "
            f"{len(glyphs)} letters in this font. Use a rounded or chamfered "
            "bevel, a smaller bevel, or a different font."
        )
    out = []
    for g in glyphs:
        prism = _taper_prism(plane * g, depth, angle)
        if prism is None:
            raise ValueError(
                f"Text: sloped walls at {angle:.0f}° failed on one of the letters. "
                "Use a rounded or chamfered bevel, or a smaller bevel."
            )
        out.append(prism)
    return out


def _bevel_glyph_prisms(prisms, glyphs, direction, radius, f, ctx):
    """Bevel every glyph prism's rim, or none of them.

    ALL-OR-NOTHING is not fastidiousness, it is the measured shape of the
    problem. Best-effort bevelling produced "SindriCAD Emboss 24" with 2 of 19
    letters bevelled and 17 sharp — one valid solid, BRepCheck clean, nothing
    downstream able to flag it. Only 7 of 20 real strings came out uniformly
    bevelled, so a warning would fire on two uses in three, which is not a
    diagnostic, it is the normal state.

    The operator is chosen PER GLYPH, not once for the string. That looks like
    it would produce a mongrel — rounded R's beside chamfered A's — but at the
    sizes a text bevel uses the two are visually indistinguishable, and the
    measured alternative is far worse: on "SindriCAD" at 0.1 mm, chamfer fails
    on 'S' and fillet fails on 'r', so insisting on one operator refuses a job
    that mixing completes. "Chamfer wins for emboss" is refuted across fonts
    anyway (Nimbus Roman chamfer 2/19 vs fillet 15/19; Cantarell the reverse;
    per-font success spans 11%-89%), so only the ORDER of preference is kept.
    """
    order = ("fillet", "chamfer") if f.get("operation") == "engrave" else ("chamfer", "fillet")
    if f.get("bevelStyle") in ("chamfer", "fillet"):
        order = (f["bevelStyle"],)

    # A bevel eating `radius` from both sides of a stroke of width w collides at
    # w/2 — and OCCT agreed, raising in 568 of 568 operations at that ratio.
    # Refusing here costs nothing and saves a process fork.
    narrowest = min((w for w in (_min_stroke_width(g) for g in glyphs) if w > 0), default=0.0)
    if narrowest and radius >= narrowest * _BEVEL_MIN_STROKE_RATIO:
        raise ValueError(
            f"Text: a {radius:g} mm bevel is too big for this text — the thinnest "
            f"stroke is about {narrowest:.2f} mm. Use under "
            f"{narrowest * _BEVEL_MIN_STROKE_RATIO:.2f} mm, or make the text larger."
        )

    cleared = _probe_bevels(_bevel_recipe(f, ctx, radius, order))
    out, unbevelable = [], 0
    for i, prism in enumerate(prisms):
        edges = _rim_edges(prism, direction)
        done = None
        for kind in order:
            if not cleared.get((i, kind), False):
                continue  # this one either kills the kernel or can't do it
            done = _blend_rim(prism, edges, radius, kind)
            if done is not None:
                break
        if done is None:
            unbevelable += 1
        else:
            out.append(done)
    if unbevelable:
        # Never forward OCCT's own "try a smaller length value(s)": success is
        # NON-MONOTONE in bevel size (6 of 92 glyph tracks failed at a smaller
        # bevel and succeeded at a larger one), so that advice is not true. Some
        # raises also arrive with an EMPTY message body
        # (gp_VectorWithNullMagnitude), so the kernel's text is not passed
        # through either.
        raise ValueError(
            f"Text: this font can't take a {radius:g} mm bevel on "
            f"{unbevelable} of its {len(prisms)} letters. Try a different bevel "
            "size or font, or turn the bevel off."
        )
    return out


def _edge_sig(e):
    """A rebuild-stable identity for an edge: rounded midpoint + length. Used to
    tell which edges a boolean CREATED — TShape identity doesn't survive one."""
    try:
        m = e.center()
        return (round(m.X, 5), round(m.Y, 5), round(m.Z, 5), round(e.length, 5))
    except Exception:
        return None


def _bevel_pocket_mouth(before, after, face, radius, f, ctx, glyphs):
    """Bevel the opening of an engraved pocket.

    An engrave can't be bevelled the way an emboss is: the rim the user means is
    the pocket MOUTH, and that edge does not exist until the cut has happened.
    So the new edges lying on the picked face's own surface are found after the
    boolean and blended there.

    Blended PER GLYPH rather than in one call: a single whole-rim fillet was
    measured raising on 5 of 12 real strings, once after burning 8.9 seconds.
    Note the engrave direction is also the SAFE one — of 89 SIGSEGVs recorded
    across 4,883 glyph blends, every single one was in the emboss path and none
    in 1,710 engrave cells — so this side does not need the probe.
    """
    old = {_edge_sig(e) for e in before.edges()}
    surf = face.geom_type == GeomType.PLANE
    n = face.normal_at()
    origin = face.center()
    mouth = []
    for e in after.edges():
        if _edge_sig(e) in old:
            continue
        try:
            m = e.center()
            on_face = (
                abs(n.dot(m - origin)) < 1e-4
                if surf
                else _distance_to_surface(m, face) < 1e-4
            )
        except Exception:
            on_face = False
        if on_face:
            mouth.append(e)
    if not mouth:
        raise ValueError(
            "Text: couldn't find the engraved edges to bevel — turn the bevel off, "
            "or use a smaller depth."
        )
    kind = f.get("bevelStyle") if f.get("bevelStyle") in ("chamfer", "fillet") else "fillet"
    for attempt in ((kind,) if f.get("bevelStyle") else ("fillet", "chamfer")):
        try:
            out = chamfer(mouth, length=radius) if attempt == "chamfer" else fillet(mouth, radius=radius)
        except Exception:
            continue
        if _blend_is_sane(after, out):
            return out
    raise ValueError(
        f"Text: this font can't take a {radius:g} mm bevel on an engrave. Try a "
        "different bevel size or font, or turn the bevel off."
    )


def _distance_to_surface(pt, face):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.gp import gp_Pnt

    v = BRepBuilderAPI_MakeVertex(gp_Pnt(pt.X, pt.Y, pt.Z)).Vertex()
    d = BRepExtrema_DistShapeShape(v, face.wrapped)
    d.Perform()
    return d.Value() if d.IsDone() else 1e9


def _handle_text_on_face(f, ctx):
    """Emboss (raise) or engrave (cut) text directly on a solid face.

    Glyphs come from the SAME `_text_faces` the sketch Text tool uses, so face
    text and sketch text of one string are identical geometry out of one font
    engine. They are laid out on the feature's own `plane` — captured from the
    picked face when the tool ran — extruded into per-glyph prisms, and
    booleaned in ONE `_serial_bool` call (a chained per-glyph boolean redoes the
    whole op + clean per step, O(n²), and measured 5x slower on a 17-glyph word).

    Deliberately NOT built on `_press_pull`, despite the shape of the two being
    identical: its mesh-facet guard rejects any face under 1.0 mm² once a body
    passes 300 faces, and glyph faces measure 0.368 mm² at font_size 6 — every
    dot, period and comma on any imported part would be refused. It also
    silently clamps an inward push, which would quietly shorten an engrave.

    An engrave deeper than the material is ALLOWED and cuts through: stencil
    lettering is a real use. What is refused is a cut that breaks the body into
    pieces, which is never what someone typing a word meant.
    """
    op = f.get("operation", "emboss")
    if op not in ("emboss", "engrave"):
        raise ValueError(f"Text: unknown operation {op!r}")
    depth = ctx.val(f["depth"])
    if not (depth > 0):
        raise ValueError(f"Text: depth must be greater than 0 (got {depth:g})")

    groups = _group_sels_by_body(f["face"], ctx, "Text")
    if len(groups) != 1:
        raise ValueError("Text: sits on one face of one body")
    body, sels = groups[0]
    faces = resolve_faces(body["shape"], sels, diag=ctx.diagnostics, feature_id=f.get("id"))
    if not faces:
        raise GeomError(f"Text: no face found on {BODY_SLOT} — re-pick the face",
                        body_id=body["id"], subject=body.get("name"))
    face = faces[0]
    planar = face.geom_type == GeomType.PLANE

    plane = _plane_of(f["plane"], ctx.datums)
    if planar:
        _guard_text_plane(plane, face)

    # `_text_faces` is best-effort by design — one bad font must not fail a whole
    # rebuild — so it returns [] for a missing font just as it does for empty
    # text. Unguarded, that ships a green timeline chip and no geometry.
    glyphs = _text_faces(_text_entity_of(f), ctx.val)
    if not glyphs:
        font = f.get("font") or "the default font"
        raise ValueError(
            f"Text: produced no glyphs — check the text isn't blank and that "
            f"{font} is installed"
        )

    sign = 1.0 if op == "emboss" else -1.0
    bevel = ctx.val(f["bevel"]) if f.get("bevel") else 0.0
    if bevel < 0:
        raise ValueError(f"Text: bevel can't be negative (got {bevel:g})")
    if bevel and bevel >= depth:
        raise ValueError(
            f"Text: a {bevel:g} mm bevel needs more than {depth:g} mm of depth to "
            "sit in — deepen the text or reduce the bevel."
        )

    tapered = bevel > 0 and f.get("bevelStyle") == "taper"
    if planar:
        if tapered:
            tools = _taper_glyph_prisms(glyphs, plane, depth * sign, bevel, f, ctx)
        else:
            tools = [extrude(plane * g, depth * sign) for g in glyphs]
    else:
        if tapered:
            raise ValueError(
                "Text: sloped walls only work on a flat face. Use a rounded or "
                "chamfered bevel here, or pick a flat face."
            )
        # Project along the face's inward normal at the pick point — i.e. the
        # layout plane's own -Z, since that plane was built from the face there.
        direction = (-plane.z_dir.X, -plane.z_dir.Y, -plane.z_dir.Z)
        extent = body["shape"].bounding_box().diagonal
        patches = _text_patches_on_curved(
            [plane * g for g in glyphs], face, direction, f["pick"], extent
        )
        tools = _thicken_patches(patches, depth, op, body["shape"])
    # An emboss tool always ends up OUTSIDE the body (_thicken_patches measures
    # the sign rather than trusting the face orientation), so its rim is the face
    # furthest along the outward normal — the layout plane's +Z either way.
    rim_dir = (plane.z_dir.X, plane.z_dir.Y, plane.z_dir.Z)

    if bevel and not tapered and op == "emboss":
        # Bevel the free-standing prisms BEFORE the fuse. Measured: per-glyph,
        # 20/20 real strings produced a result against 4/20 for one whole-rim
        # call over the fused body, where "SindriCAD" and "The quick brown fox"
        # failed at every radius tried.
        tools = _bevel_glyph_prisms(tools, glyphs, rim_dir, bevel, f, ctx)

    before = max(1, len(body["shape"].solids()))
    result = _serial_bool(body["shape"], tools, "fuse" if op == "emboss" else "cut")
    if len(result.solids()) > before:
        raise ValueError(
            "Text: the text isn't sitting on the face — it ended up as loose "
            "solids. Re-pick the face."
            if op == "emboss"
            else "Text: this engrave cuts the body into pieces — use a smaller depth."
        )
    if bevel and op == "engrave":
        result = _bevel_pocket_mouth(body["shape"], result, face, bevel, f, ctx, glyphs)
    body["shape"] = result


def _handle_texture(f, ctx):
    # Two-phase, like every other selector feature but lazier: validate NOW
    # (so a bad kind/param/image path shows red on the timeline immediately)
    # against the CURRENT shape via a THROWAWAY resolve, but never touch
    # act["shape"] — the spec is stored raw and re-resolved once, lazily,
    # against the FINAL shape at tessellation/export time (texture.py's
    # resolve_body_textures), so it survives downstream topology changes the
    # same way every other lossy-tolerant selector already does.
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Texture")
    if act is None:
        raise ValueError("Texture: the target body no longer exists")
    sel = f.get("faces") or {"by": "all"}
    found = texture._resolve_texture_faces(act["shape"], sel)
    if not found:
        raise ValueError("no face found for texture")
    spec = texture.validate_texture_spec(f)
    # REBIND, never mutate in place: body dicts are shallow-copied by
    # _snapshot() (dict(b)), so appending to an EXISTING list would corrupt
    # any earlier snapshot's view of "_textures" through the shared reference.
    act["_textures"] = (act.get("_textures") or []) + [spec]


def _handle_pattern_rect(f, ctx):
    act = ctx.require_active("Pattern")
    cx, cy = ctx.val(f["countX"]), ctx.val(f["countY"])
    # A count of 0 used to return the original body with no error at all, so the
    # pattern silently did nothing and the timeline showed a healthy feature.
    _require_positive("Pattern", countX=cx, countY=cy)
    act["shape"] = _pattern_rect(
        act["shape"], cx, cy, ctx.val(f["spacingX"]), ctx.val(f["spacingY"])
    )


def _handle_pattern_circular(f, ctx):
    act = ctx.require_active("Pattern")
    n = ctx.val(f["count"])
    _require_positive("Pattern", count=n)
    act["shape"] = _pattern_circular(
        act["shape"], n, ctx.val(f.get("angle", 360)), f.get("axis", "Z")
    )


def _handle_simplify_mesh(f, ctx):
    act = ctx.require_active("Simplify Mesh")
    act["shape"] = _simplify_mesh(act["shape"], ctx.val(f.get("tolerance", 1)))


def _handle_scale(f, ctx):
    act = ctx.require_active("Scale")
    factor = ctx.val(f.get("factor", 1))
    # A factor of 0 collapses the solid to a point; OCCT reports that as
    # Standard_ConstructionError. Negative factors DO work (mirror through the
    # origin) and are left alone.
    if factor == 0:
        raise ValueError("Scale: factor must not be 0 — it would collapse the body to a point")
    act["shape"] = scale(act["shape"], by=factor)


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
    # they're not tessellated/exported.
    ids = set(f.get("bodies") or [])
    # An id that matches nothing used to be ignored in silence, so a Remove whose
    # target had been renumbered by an upstream edit reported success having
    # deleted nothing — the timeline showed a healthy feature over a stale
    # reference. Name the ids instead.
    missing = sorted(ids - {b["id"] for b in ctx.bodies})
    if missing:
        raise ValueError(
            f"Remove: no such body {', '.join(missing)} — it may have been "
            "renumbered or consumed by an earlier feature"
        )
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
    "offsetFace": _handle_offset_face,
    "thicken": _handle_thicken,
    "draft": _handle_draft,
    "textOnFace": _handle_text_on_face,
    "texture": _handle_texture,
    "patternRect": _handle_pattern_rect,
    "patternCircular": _handle_pattern_circular,
    "simplifyMesh": _handle_simplify_mesh,
    "scale": _handle_scale,
    "move": _handle_move,
    "split": _handle_split,
    "combine": _handle_combine,
    "removeBody": _handle_remove_body,
}


def _make_val(params):
    """A value resolver over one document's parameter table: a parameter name
    resolves to its value; a numeric literal passes through.

    Any other string is a hard error: the frontend evaluates expressions and
    ships plain numbers, so an unresolved string here would otherwise leak
    into OCCT as garbage (crash or silent junk geometry). In rebuild() the
    raise is caught by the per-feature error handler -> red chip, build
    continues; project_geometry surfaces it as a per-source error entry."""

    def val(x):
        if isinstance(x, str):
            if x in params:
                return params[x]
            raise ValueError(
                f'unresolved parameter or expression "{x}" — expected a number '
                f"(expressions are evaluated by the app before building)"
            )
        return x

    return val


def rebuild(document, diagnostics=None, resume=None, snapshots_out=None, persist=None,
            projections=None):
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

    projections : optional list; when given, each sketch handler re-resolves its
              projected entities against the prefix state and appends refresh
              entries (see _recompute_projections). Steady state appends NOTHING —
              that convergence contract is what terminates the frontend's
              associative refresh loop.

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

    val = _make_val(params)

    sketches = {}
    datums = {}  # datumPlane feature id -> PlaneSpec (resolved lazily by _plane_of)
    bodies = []  # ordered [{id, name, shape}]
    counter = {"n": 0}
    errors = []

    def new_body(shape, name=None, node_ref=None):
        counter["n"] += 1
        # The name is sanitised HERE, not at the importer, because this is the
        # only choke point every body passes through. `step_assembly._clean`
        # runs when a STEP file is READ — but a saved document carries its
        # assembly node names in `features[].nodes[].name`, and a rebuild takes
        # them straight from there without ever revisiting the file. So a
        # hostile name survived a save/reload even with the importer clean, and
        # from here it reached `bodies[].name` on the wire and the DOM.
        # A name that is nothing BUT control characters cleans to "" and falls
        # back to the positional default rather than an empty label.
        entry = {
            "id": f"body{counter['n']}",
            "name": untrusted.clean(name, untrusted.MAX_SUBJECT) or f"Body{counter['n']}",
            "shape": shape,
        }
        # Which assembly-tree node this body came from, as "<featureId>/<index>".
        # Set only for manifest-bound imports, and omitted (not None) otherwise so
        # every other body dict is byte-identical to what it was before.
        if node_ref:
            entry["node_ref"] = node_ref
        bodies.append(entry)
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
        OCCT shape refs — no geometry is copied. sketches/errors/diagnostics are
        APPEND-ONLY write-once registries within a run, so a snapshot stores a
        REFERENCE to the run's registry plus a high-water mark; _restore copies the
        prefix below the mark once. Copying whole registries per snapshot was O(N²)
        over a rebuild."""
        return {
            "bodies": [dict(b) for b in bodies],
            "sketches_ref": sketches, "n_sketches": len(sketches),
            "datums": {k: dict(v) for k, v in datums.items()},
            "n": counter["n"],
            # errors travel with the snapshot: an incremental resume PAST a failed
            # feature must still re-report its error (else the banner would clear
            # while the feature is still broken)
            "errors_ref": errors, "n_errors": len(errors),
            # diagnostics travel for the SAME reason, and it is not cosmetic: the
            # frontend offers "Re-pick face" only when the build carries an
            # `ambiguous nearest pick` diagnostic, so a resume that replayed the
            # error without it left the user a dead-end toast on every reopened
            # document. `diagnostics` is None for callers that don't collect them
            # (exports, interference) — those still resume, so guard it.
            "diags_ref": diagnostics, "n_diags": len(diagnostics or ()),
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
        # same two branches as errors: a snapshot from a PREVIOUS run (RAM cache)
        # or from disk holds a foreign list, so copy its prefix in; a same-run
        # snapshot already shares the list, so just truncate to the mark. A
        # snapshot taken before diagnostics were collected has none to restore.
        dg_src = snap.get("diags_ref")
        if diagnostics is not None and dg_src is not None:
            if dg_src is not diagnostics:
                diagnostics[:] = [dict(d) for d in dg_src[: snap["n_diags"]]]
            else:
                del diagnostics[snap["n_diags"]:]

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
        find_body=find_body, features=features, projections=projections,
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
            #
            # This is THE choke point for per-feature failures: it feeds both
            # `featureErrors` on an ok:true rebuild AND, via server._fatal_from,
            # the whole-job error. A fillet whose reference went ambiguous
            # reports through the ok:true path, which is precisely where a code
            # is most useful and where a code applied only to `_err` would never
            # appear. GeomError subclasses ValueError so it lands here unchanged.
            #
            # `subject` is untrusted document text and is capped here, at the one
            # place every per-feature failure passes through, rather than trusted
            # to have been capped at each raise site.
            entry = {"feature_id": f.get("id"),
                     "message": untrusted.clean(str(ex), untrusted.MAX_MESSAGE)}
            _code = getattr(ex, "code", None)
            if _code:
                entry["code"] = _code
            _body_id = getattr(ex, "body_id", None)
            if _body_id:
                entry["body_id"] = _body_id
            _subject = getattr(ex, "subject", None)
            if _subject:
                entry["subject"] = untrusted.clean(_subject, untrusted.MAX_SUBJECT)
            errors.append(entry)
        except Exception as ex:
            # Anything NOT a hand-authored ValueError is an unexpected internal
            # failure (OCCT crash, KeyError, …) — the raw message is meaningless
            # to a user, so surface the feature + exception type instead and log
            # the full traceback to stderr for debugging.
            #
            # The sentence names the feature's TYPE, which is ours. The document's
            # own name for the feature is untrusted text and rides in `subject`
            # instead of the prose — a renamed feature is exactly as
            # attacker-influenced as an imported body name.
            kind = f.get("type") or "feature"
            label = f.get("name") or kind
            print(f"feature {f.get('id')} ({label}) failed:", file=sys.stderr)
            traceback.print_exc()
            entry = {
                "feature_id": f.get("id"),
                "message": f"{kind} failed ({type(ex).__name__})",
            }
            if f.get("name"):
                entry["subject"] = untrusted.clean(f["name"], untrusted.MAX_SUBJECT)
            errors.append(entry)
        else:
            if prov:
                _update_owners(f, val, bodies, pre_shape, pre_owners_by_id, pre_owners_all)
        if snapshots_out is not None:  # cache point: state after this feature
            snapshots_out.append((i, _snapshot()))
        if persist is not None:
            _persist_tick(
                persist, i, time.monotonic() - t_feat, bodies, datums, errors, counter,
                diagnostics,
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
        progress_tick()  # per body: the final pass over a 3,000-body document
        sh = b["shape"]
        if sh is not None and _wrapped_or_none(sh) is None:
            sh = Compound(list(sh))
        if sh is not None and not b.get("_intact"):
            # final pass only — mid-timeline drops would shift downstream
            # geometric selectors and delete chips a later join re-absorbs
            sh = _drop_debris(sh)
        entry = {"id": b["id"], "name": b["name"], "shape": sh,
                 "owners": b.get("_owners") or {},
                 "_textures": b.get("_textures")}
        # Rebuilt from an explicit key set, so anything new on the body dict has
        # to be listed here or it is silently dropped between rebuild and the
        # wire — which is how `_textures` was lost once already. Added only when
        # set, so a body from a non-assembly import stays byte-identical.
        if b.get("node_ref"):
            entry["node_ref"] = b["node_ref"]
        out_bodies.append(entry)

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
# (face/edge/vertex counts + bbox): any divergence is a cache MISS, never wrong geometry.

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
            # untrusted.py is in here because feature errors are PERSISTED into
            # checkpoints: without it, editing the sanitiser would leave every
            # cached document replaying the messages the old one produced.
            for name in ("builder.py", "geom_select.py", "tessellate.py",
                         "untrusted.py", "selector_tuning.json"):
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
            for k, x in v.items():
                # `nodes`/`parts` are the imported assembly tree: product NAMES
                # straight out of a STEP file, which are not expressions and must
                # never be scanned for parameter identifiers. A real product
                # called "Bracket t Left" would otherwise pull parameter `t` into
                # this import's invalidation scope, so dragging an unrelated
                # slider would force a cold re-import of the single most
                # expensive feature in the document.
                if k in ("nodes", "parts"):
                    continue
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
    + bbox. A mismatch means the restore diverged and the checkpoint is treated as a
    miss. The counts are deterministic integers, so they never cause a false miss on
    OCCT float noise, and they catch a same-bbox but topologically different solid the
    box alone would wave through — measured stable across a real BREP round trip on
    400 bodies of the reference assembly.

    Every term here is chosen for cost: this runs per body inside _restore_from_disk,
    which walks 3,072 of them on that assembly (see the loop's comment for what the
    old cost did to the stall supervisor).

    - Counts come from TopExp.MapShapes_s, not build123d's `.faces()/.edges()/
      .vertices()`, which build a full list of wrapper objects just to take len() —
      measured 45x slower, and `.edges()` additionally runs a Python-level degenerate
      filter over every edge. These counts therefore INCLUDE degenerate edges, which
      is fine for a fingerprint (still deterministic) but means a value taken here is
      NOT comparable with one taken through build123d.
    - The box is BRepBndLib's poles-based one, not `shape.bounding_box()` (OCCT's
      exact AddOptimal_s): 0.080 ms/body against 67.3 ms.
    - `useTriangulation` MUST stay False. With True the box shifts by up to 0.49 mm
      once a shape carries a triangulation — 492x the 1e-3 compare tolerance — and a
      body IS tessellated when the checkpoint is written and is NEVER tessellated when
      restored, so True would false-miss intermittently and force a cold rebuild. That
      is also why `tessellate.mesh_bbox` (True by design) must not be reused here
      despite computing the same kind of box.
    - Volume is deliberately absent: 23.0 ms/body buying discrimination the counts and
      the box already provide. A blob-key collision restores either a different part
      (caught by the counts) or the same part at a different placement (caught by the
      box)."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_VERTEX
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedMapOfShape

    def count(kind):
        m = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(shape.wrapped, kind, m)
        return m.Extent()

    bnd = Bnd_Box()
    BRepBndLib.Add_s(shape.wrapped, bnd, False)
    return {
        "f": count(TopAbs_FACE),
        "e": count(TopAbs_EDGE),
        "vx": count(TopAbs_VERTEX),
        "b": [] if bnd.IsVoid() else [round(x, 4) for x in bnd.Get()],
    }


def _blob_key(chain_key, body_id):
    """One feature can modify SEVERAL bodies (extrude-cut across overlapping
    bodies, combine): the chain key alone would collide their blobs and the
    dedup skip in put_blob would silently keep only the first one written
    (caught by the restore fingerprint guard). Mix the body id in."""
    return hashlib.blake2b(
        (chain_key + ":" + str(body_id)).encode(), digest_size=16
    ).hexdigest()


def _persist_tick(persist, i, dt_s, bodies, datums, errors, counter, diagnostics=None):
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
    _save_checkpoint(persist, i, bodies, datums, errors, counter["n"], diagnostics)


def _save_checkpoint(persist, i, bodies, datums, errors, counter_n, diagnostics=None):
    """Best-effort: a cache write failure must never break a rebuild."""
    try:
        store, keys, mod = persist["store"], persist["keys"], persist["mod"]
        manifest, fps, owners = [], [], {}
        textures = {}
        for b in bodies:
            # One tick per body, at the top so every path through the loop
            # counts (the shapeless `continue` below included). Serialising a
            # body's B-rep to the blob store is the expensive part, and on a
            # large assembly this loop alone can outrun the stall timeout.
            progress_tick()
            sh = b.get("shape")
            # The assembly-tree node this body came from. Body metadata that is
            # NOT recoverable from the shape, exactly like `_owners` and
            # `_textures` below — and an import always blows the checkpoint
            # budget, so a disk resume is the NORMAL way an assembly document
            # reopens. Omitting it here would flatten the tree on every reopen,
            # with no error and nothing for `_body_fingerprint` to catch, since
            # that compares geometry only.
            node_ref = b.get("node_ref")
            entry = {"body_id": b["id"], "name": b["name"], "blob_key": None}
            if node_ref:
                entry["node_ref"] = node_ref
            # Same class of state, and the same trap: `_intact` exempts an
            # explicitly collapsed import from _drop_debris, and it is NOT
            # recoverable from the shape. Dropping it here would let the debris
            # pass delete legitimate small parts on every disk resume — which is
            # the NORMAL way an assembly document reopens, since an import always
            # blows the checkpoint budget. Third time this key set has bitten:
            # `_textures`, then `node_ref`, now this.
            if b.get("_intact"):
                entry["_intact"] = True
            if sh is None or _wrapped_or_none(sh) is None:
                manifest.append(entry)
                fps.append(None)
                continue
            blob_key = (mod.get(b["id"]) or (None, _blob_key(keys[i], b["id"])))[1]
            store.put_blob(blob_key, sh)
            entry["blob_key"] = blob_key
            manifest.append(entry)
            fps.append(_body_fingerprint(sh))
            owners[b["id"]] = [[list(k), v] for k, v in (b.get("_owners") or {}).items()]
            # `_textures` is body state that is NOT in the shape: _handle_texture
            # stores the raw spec and displacement happens lazily at tessellation.
            # Without persisting it, a disk resume past the texture feature returned
            # an untextured body with no error — the mesh AND the export silently
            # lost the texture. Same class of state as `_owners` above.
            if b.get("_textures"):
                textures[b["id"]] = b["_textures"]
        state = json.dumps({
            "datums": datums,
            "errors": errors,
            # diagnostics ride along with errors so a disk resume can re-report
            # BOTH (see _snapshot). Every producer emits plain JSON scalars; if
            # one ever emits something json can't encode, this whole write fails
            # into the `except` below and SILENTLY disables the disk cache — hence
            # test_checkpoint's serializability guard.
            "diagnostics": diagnostics or [],
            "n": counter_n,
            "owners": owners,
            "textures": textures,
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
            # One tick per body, at the top so every path through the loop counts —
            # same rule as the checkpoint-WRITE loop. Ticking INSIDE matters: this
            # restore measured 146.2 s on the 356 MiB reference assembly (3,072
            # bodies) against STALL_TIMEOUT = 60 s, and the ticks used to sit only
            # before and after, leaving one silent 146 s gap. The supervisor reaped
            # the worker at 60 s, before rebuild_cached's first print — which is why
            # the document simply never opened and NOTHING was logged. Cheapening
            # _body_fingerprint brought the same restore under 8.5 s, but a bigger
            # assembly would walk into the same wall; the tick is the real fix.
            progress_tick()
            if ent["blob_key"] is None:
                shapeless = {"id": ent["body_id"], "name": ent["name"],
                             "shape": None, "_owners": {}}
                if ent.get("node_ref"):
                    shapeless["node_ref"] = ent["node_ref"]
                if ent.get("_intact"):
                    shapeless["_intact"] = True
                bodies.append(shapeless)
                continue
            raw = store.get_blob(ent["blob_key"])
            if raw is None:
                return None
            shape = _wrap_topods(raw)
            if shape is None:
                return None
            got = _body_fingerprint(shape)
            # e/vx were always computed and stored but never actually compared; they
            # carry the discrimination the dropped volume term used to add, for free.
            if (got["f"] != fp["f"]
                    or got["e"] != fp["e"]
                    or got["vx"] != fp["vx"]
                    or len(got["b"]) != len(fp["b"])
                    or any(abs(a - c) > 1e-3 for a, c in zip(got["b"], fp["b"]))):
                return None  # diverged restore = miss, never wrong geometry
            body = {
                "id": ent["body_id"], "name": ent["name"], "shape": shape,
                "_owners": {
                    tuple(k): v
                    for k, v in state.get("owners", {}).get(ent["body_id"], [])
                },
            }
            # only set the key when the body really is textured, so a plain body's
            # dict stays exactly as it was before textures were persisted
            tex = state.get("textures", {}).get(ent["body_id"])
            if tex:
                body["_textures"] = tex
            # same rule for the assembly-tree node: absent on every body that did
            # not come from a manifest-bound import, and on every checkpoint
            # written before this existed
            if ent.get("node_ref"):
                body["node_ref"] = ent["node_ref"]
            if ent.get("_intact"):
                body["_intact"] = True
            bodies.append(body)
            mod[ent["body_id"]] = (shape, ent["blob_key"])
        snap = {
            "bodies": bodies,
            "sketches_ref": {}, "n_sketches": 0,  # rebuilt via replay_sketches
            "datums": state["datums"],
            "n": state["n"],
            "errors_ref": state["errors"], "n_errors": len(state["errors"]),
            # .get: checkpoints written before diagnostics were persisted have no
            # such key. In practice _env_sig hashes builder.py into every chain
            # key, so those rows can no longer be matched at all — this is purely
            # so a stale row degrades to the old behaviour instead of raising.
            "diags_ref": state.get("diagnostics", []),
            "n_diags": len(state.get("diagnostics", [])),
            "replay_sketches": True,
        }
        return cp["feat_index"] + 1, snap, mod
    except Exception:
        return None


# RAM snapshots kept per feature (beyond disk checkpoints); bounds worker memory
# (~0.2 MB/snapshot measured, so 300 ≈ 60 MB) — a resume below the window falls
# through to the disk cache. SINDRI_RAM_SNAP_WINDOW overrides for large docs / tight RAM.
_RAM_SNAP_WINDOW = int(os.environ.get("SINDRI_RAM_SNAP_WINDOW", "300"))


def rebuild_cached(document, diagnostics=None, projections=None, readonly=False):
    """Incremental rebuild: reuse cached per-feature state for the unchanged document
    PREFIX and re-run only from the first changed feature. Resume sources, deepest
    wins: (1) in-RAM per-feature snapshots from the previous build in this worker,
    (2) durable disk checkpoints (geomstore) that survive worker restarts, crashes
    and timeouts. Falls back to a full rebuild when params/visibility change or both
    caches miss. Same return as rebuild(); geometrically identical to a full rebuild
    (verified by the incremental-vs-full smoke test + the differential harness).

    `readonly=True` READS both resume tiers exactly as normal but writes NOTHING
    BACK — neither `_CACHE` nor a disk checkpoint. It exists for callers that
    build a TRUNCATED document (a timeline prefix) alongside the human's own
    editing: `_CACHE` is module state keyed on the last document built, so a
    prefix build leaves it describing only that prefix, and the human's next
    rebuild of their UNCHANGED full document then resumes from the cut point
    instead of the tip. Measured over a real socket on a 46-feature document:
    0.121 s -> 3.173 s, a 26x penalty on a build with nothing to do.

    Two separate mechanisms, both closed by writing nothing. The obvious one is
    the truncated `feature_sigs`, which bounds the next prefix-match loop. The
    second is `proj_quiet`: it is written from `projections`, and an aux caller
    passes none, so it lands False and falsifies the quiet-proof — which pulls
    the NEXT build's resume down to `proj_cap`, i.e. to the EARLIEST projected
    sketch in the whole timeline rather than to the cut point. On one measured
    document that was resume 5 rather than 19, and it accounted for essentially
    the whole penalty on its own.

    Note this leaves a shallow-RAM-beats-deep-disk asymmetry untouched: the disk
    tier is consulted only `if resume is None`, so any shallow `_CACHE` still
    vetoes a deeper valid checkpoint (measured 2.550 s vs 0.022 s). Writing
    nothing avoids CREATING that state; it does not fix the preference order.
    """
    global _CACHE
    features = document.get("features", [])
    new_sigs = _feature_sigs(features)
    gsig = _global_sig(document)
    store = _disk_store()
    keys = _chain_keys_scoped(document, new_sigs) if store is not None else []

    # RESUME CAP (projection soundness): when the caller collects projection
    # refresh entries, never resume PAST the first sketch carrying projected
    # entities. Emission is transient — an update from a previous build that the
    # frontend never applied (preview active, redo, doc reopened mid-refresh) is
    # not re-derivable from document state, so a deep resume would skip the
    # sketch handler and let a stale cached curve stick silently. Applies to
    # BOTH resume tiers. Callers without a projections list (aux ops, exports)
    # keep full-depth resume.
    #
    # QUIET-PROOF exception (RAM tier only — the steady-state perf escape):
    # when the PREVIOUS build in this worker ran a projection pass that emitted
    # NOTHING, it proved fresh == cached for every projected sketch it built —
    # and an unapplied pending diff is impossible after a quiet pass (pending
    # diffs re-emit on every build until applied). If the sigs through the
    # projected sketch are also unchanged (k > proj_cap covers indices
    # 0..proj_cap, including the sketch itself, so its inputs AND cached curves
    # are the proven ones), a deep resume is sound. Any emitting or
    # accumulator-less build clears the proof; disk tier and worker restarts
    # stay conservative (no proof survives them).
    proj_cap = None
    if projections is not None:
        for pi, pf in enumerate(features):
            if pf.get("type") == "sketch" and any(
                isinstance(e, dict) and e.get("type") == "projected"
                for e in pf.get("entities") or []
            ):
                proj_cap = pi
                break

    resume = None
    from_disk = False
    disk_mod = {}
    if _CACHE["global_sig"] == gsig and _CACHE["snaps"]:
        old_sigs = _CACHE["feature_sigs"]
        k = 0
        while k < len(new_sigs) and k < len(old_sigs) and new_sigs[k] == old_sigs[k]:
            k += 1
        if proj_cap is not None and not (_CACHE.get("proj_quiet") and k > proj_cap):
            k = min(k, proj_cap)
        # snaps below the RAM retention window are None — fall through to disk
        if k > 0 and k - 1 < len(_CACHE["snaps"]) and _CACHE["snaps"][k - 1] is not None:
            resume = (k, _CACHE["snaps"][k - 1])  # restore state after feature k-1
    if resume is None and store is not None:
        # Checkpoint restore reads every prefix body from disk — on a large
        # document that is a long phase, and these two calls only bracket it.
        # Bracketing is NOT what keeps it alive: the gap the stall watchdog sees
        # is the one INSIDE, which is why _restore_from_disk ticks per body.
        progress_tick()
        hit = _restore_from_disk(store, keys if proj_cap is None else keys[:proj_cap])
        progress_tick()
        if hit is not None:
            start_i, snap, disk_mod = hit
            resume = (start_i, snap)
            from_disk = True

    persist = None
    if store is not None and features and not readonly:
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
    # Diagnostic: WHERE the incremental resume started. resume_from == 0 (or src=full)
    # means the whole history replayed (checkpoint miss) — the usual cause of a
    # surprise multi-second rebuild; a high resume_from means only the tail features
    # (e.g. one expensive boolean) ran, so the cost is genuine OCCT geometry.
    if features:
        _rp = resume[0] if resume else 0
        print(
            f"[rebuild-cached] features={len(features)} resume_from={_rp} "
            f"src={'full' if resume is None else ('disk' if from_disk else 'RAM')}",
            flush=True,
        )
    part, errors, bodies = rebuild(
        document, diagnostics=diagnostics, resume=resume,
        snapshots_out=snaps_out, persist=persist, projections=projections,
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
    if not readonly:
        _CACHE = {"feature_sigs": new_sigs, "snaps": merged, "global_sig": gsig,
                  # quiet-proof for the next build's resume-cap decision (see above);
                  # missing key (worker restart, Compute All reset) reads falsy =
                  # conservative
                  "proj_quiet": projections is not None and not projections}

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
            (tip.get("diags_ref") or [])[: tip["n_diags"]],
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

def _fp_world(area, cx, cy, cz, loc):
    """Round a LOCAL-frame (area, centre) into the world-frame fingerprint.

    Module level, not a closure inside _face_fp: that allocated a function
    object on all ~70k calls per rebuild, and re-ran the gp_Pnt import lookup
    on the hot memo-hit path. The import now only happens when there is an
    actual transform to apply."""
    if loc is None or loc.IsIdentity():
        return (round(area, 2), round(cx, 1), round(cy, 1), round(cz, 1))
    from OCP.gp import gp_Pnt

    p = gp_Pnt(cx, cy, cz)
    p.Transform(loc.Transformation())
    return (round(area, 2), round(p.X(), 1), round(p.Y(), 1), round(p.Z(), 1))


def _face_fp(face):
    """Quantized (area, centre) fingerprint, memoized by the face's TShape.

    The memo caches the face's geometry in its OWN (local) frame and applies the
    face's Location on retrieval. Area is invariant under a rigid transform and
    the centre is equivariant, so this is exact — verified on the 3,072-body
    reference assembly: 25,523 of 25,523 fingerprints byte-identical to the
    direct world-frame computation, zero differences.

    It used to memoize ONLY when the Location was already identity, on the
    measurement that >99% of faces are identity-located after booleans. That
    holds for modelled geometry and is completely false for IMPORTED assemblies:
    step_assembly places every leaf with `.Moved()`, so 0 of 133,295 faces on the
    reference file qualified and the memo was entirely dead there — the same
    `.Moved()` blind spot that killed the edge memo in tessellate.py. Since
    `_face_fp` is called twice per face on an open (once building the owner map
    in _update_owners, once resolving faceOwners in server._body_payload) and
    each call is a GProp surface integration at ~137 us, that dead memo was the
    single largest quality-preserving cost on the open path.

    TShape identity implies identical local geometry, which is what makes the
    key sound; the Location supplies everything else."""
    w = _wrapped_or_none(face)
    key = loc = None
    if w is not None:
        try:
            key = w.TShape()
            loc = w.Location()
            hit = _FP_MEMO.get(key)
            if hit is not None:
                return _fp_world(*hit, loc)
        except Exception:
            # both, or a half-set loc would be applied to a world-frame centre
            # below and transform it twice
            key = loc = None
    try:
        # Evaluate in the LOCAL frame and transform, rather than evaluating in
        # world and separately caching a local copy: that did TWO GProp
        # integrations per miss and measured 43.6 s -> 82.1 s on the first pass,
        # eating the whole benefit. One integration, same as before the memo.
        lf = face
        if loc is not None and not loc.IsIdentity():
            from OCP.TopLoc import TopLoc_Location
            from build123d import Face

            lf = Face(w.Located(TopLoc_Location()))
        c = lf.center()
        local = (lf.area, c.X, c.Y, c.Z)
        fp = _fp_world(*local, loc)
    except Exception:
        return None
    if key is not None:
        if len(_FP_MEMO) > 200_000:
            _FP_MEMO.clear()  # bound process-lifetime growth; it's only a cache
        _FP_MEMO[key] = local
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
                for other in _list_shapes(emap.FindFromKey(edge)):
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
                for other in _list_shapes(emap.FindFromKey(exp.Current())):
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
        progress_tick()  # per body: face attribution walks every face
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
    return _bbox_pair_overlap(bbox_of(a), bbox_of(b), tol)


# Memoized exact bounding boxes, keyed by shape OBJECT identity.
#
# An AddOptimal_s walk costs 95.5 s over the 3,072 bodies of the reference
# assembly, and BOTH callers loop over every body in the document — on every
# boolean feature and every interference run. Bodies a feature did not touch keep
# their shape object across rebuilds (rebuild_cached resumes from snapshots), so
# after the first pass a large assembly's boxes are free.
#
# Keyed by id() with the shape held ALIVE in the value, exactly like _SIG_MEMO:
# the strong reference is what makes id() reuse impossible, which is the only way
# an id-keyed cache can go wrong. It relies on the same identity assumption
# _MESH_CACHE already does — a feature that changes geometry produces a NEW shape
# object rather than mutating one in place (texture.py's module docstring spells
# out the one place that could have violated it, and does not).
_BBOX_MEMO = {}
_BBOX_MEMO_CAP = 20000  # ~6 generations of the largest assembly seen; then reset


def bbox_of(shape):
    """A shape's EXACT AABB as a PLAIN TUPLE (minX, minY, minZ, maxX, maxY, maxZ),
    memoized on shape identity (see _BBOX_MEMO).

    The underlying walk is EXPENSIVE and deliberately so: `.bounding_box()` is
    OCCT's AddOptimal_s, measured at 95.5 s over the 3,072 bodies of the 356 MiB
    reference assembly. Callers that loop over every body must still tick (see
    `_interference_job`) — the memo makes the SECOND pass free, not the first.

    The obvious cheap substitute — `BRepBndLib.Add_s(..., useTriangulation=False)`,
    the poles box `_body_fingerprint` uses — was tried here and REJECTED. It is 165x
    faster and usually looser, but on that same assembly it came out up to 0.164 mm
    TIGHTER than exact on 3 of 3,072 bodies (against a 1e-6 compare tol). For a
    fingerprint that is irrelevant; for these callers a box tighter than the truth
    silently drops a real interference or a body a boolean should have touched. If
    you retry this, the property to prove is CONSERVATISM per body over the whole
    document, not average speed — a 500-body sample showed zero violations and was
    simply too small. (Its one genuine advantage: it reports empty compounds as
    void, where the exact call hands back a degenerate point-box at the origin that
    spuriously overlaps anything near it — 8 such bodies in the reference assembly.)

    Two reasons it is a tuple and not the BoundBox.

    The pair sweep is O(n^2) in PAIRS but only O(n) in distinct shapes, so
    recomputing both boxes inside the test does quadratic work for linear
    information: at 3,060 bodies that is 9,360,540 OCCT bounding-box walks
    instead of 3,060.

    And `BoundBox.min.X` is a pybind11 property that calls into OCP on EVERY
    access, up to 12 per pair. Measured over 4,680,270 pairs (3,060 bodies):
    2.58 s reading BoundBox attributes against 0.40 s reading a tuple. The walk
    is hoisted; this hoists the reads out of the walk's result too."""
    key = id(shape)
    hit = _BBOX_MEMO.get(key)
    if hit is not None and hit[0] is shape:
        return hit[1]
    bb = _as_compound(shape).bounding_box()
    box = (bb.min.X, bb.min.Y, bb.min.Z, bb.max.X, bb.max.Y, bb.max.Z)
    if len(_BBOX_MEMO) >= _BBOX_MEMO_CAP:
        # Coarse but bounded: dropping everything costs one repopulating pass,
        # where an LRU would cost a comparison on every hit forever.
        _BBOX_MEMO.clear()
    _BBOX_MEMO[key] = (shape, box)
    return box


def _bbox_pair_overlap(a, b, tol=1e-6):
    """AABB overlap for two boxes already reduced to tuples by `bbox_of`."""
    return (
        a[0] <= b[3] + tol and a[3] >= b[0] - tol
        and a[1] <= b[4] + tol and a[4] >= b[1] - tol
        and a[2] <= b[5] + tol and a[5] >= b[2] - tol
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


def _serial_bool(base, tool, kind):
    """A boolean (kind = "fuse" | "cut" | "common") forced SERIAL.

    build123d's `+`/`-`/`&` hardcode `SetRunParallel(True)`, but OCCT's parallel BOP is
    pathologically slow — ~5-6x — when the tool is MANY small disjoint solids, e.g.
    joining/cutting the ~36 glyph prisms of a sketch text into a body (measured on the
    Basket doc: 1.3s parallel -> 0.23s serial, byte-identical volume + face count). Same
    UnifySameDomain clean and result shape as build123d, so it's a drop-in for the
    operators. `base`/`tool` must already be Compound/Solid (have `.wrapped`);
    `tool` may be a LIST of shapes — one N-tool boolean beats a chained per-tool
    loop, which redoes the whole op + clean per step (O(n²))."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse, BRepAlgoAPI_Cut, BRepAlgoAPI_Common
    from OCP.TopTools import TopTools_ListOfShape
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain

    op = {"fuse": BRepAlgoAPI_Fuse, "cut": BRepAlgoAPI_Cut, "common": BRepAlgoAPI_Common}[kind]()
    la = TopTools_ListOfShape(); la.Append(base.wrapped)
    lb = TopTools_ListOfShape()
    for t in tool if isinstance(tool, (list, tuple)) else [tool]:
        lb.Append(t.wrapped)
    op.SetArguments(la)
    op.SetTools(lb)
    op.SetRunParallel(False)
    op.Build()
    shape = op.Shape()
    up = ShapeUpgrade_UnifySameDomain(shape, True, True, True)
    up.AllowInternalEdges(False)
    try:
        up.Build()
        shape = up.Shape()
    except Exception:
        pass  # keep the un-cleaned result rather than fail the whole boolean
    return Compound(shape)


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
    # Tick per body. `_bbox_overlap` runs the EXACT `bbox_of` on each candidate,
    # measured 95.5 s over the 3,072 bodies of the 356 MiB reference assembly —
    # past the 60 s STALL_TIMEOUT, and `rebuild`'s tick is per FEATURE, so it has
    # already been spent by the time this loop starts. Unticked, a Join/Cut on a
    # freshly imported assembly is reaped mid-filter and dies with nothing logged.
    # This is still slow; the tick is what lets it finish and report progress.
    hits = []
    for b in bodies:
        progress_tick()
        if (b.get("shape") is not None
                and b.get("id") not in hidden
                and _bbox_overlap(b["shape"], solid)):
            hits.append(b)
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
            merged = _serial_bool(merged, _as_compound(b["shape"]), "fuse")  # serial: parallel BOP is ~5x slower for many-glyph tools
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
            newshape = _serial_bool(_as_compound(b["shape"]), solid, "cut")
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
            newshape = _serial_bool(_as_compound(b["shape"]), solid, "common")
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
    # _serial_bool, not build123d's +/-/&: a Combine tool is often a compound
    # of MANY disjoint solids (explode:false import, multi-region extrude) —
    # exactly the shape class where OCCT's parallel BOP is ~5x slower than
    # serial (see _serial_bool). Same UnifySameDomain clean, same result.
    kind = {"join": "fuse", "cut": "cut", "intersect": "common"}[op]
    for t in tools:
        shape = _serial_bool(_as_compound(shape), _as_compound(t["shape"]), kind)
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
        # ...and the mirror-image silent failure: a Cut that removes EVERYTHING.
        # Cutting a body with an identical coincident one left a body of volume
        # 0.0 and no error at all, so the browser tree gained a phantom body that
        # cannot be seen, selected meaningfully, or printed (docs/EDGE-CASES.md
        # §3). Same class as the no-op above — the user loses their body and is
        # told nothing.
        if op == "cut" and after_vol < guard_eps:
            raise ValueError(
                "Combine (Cut) would remove the whole target body — the tools "
                "cover all of it."
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
    try:
        if openings:
            return offset(shape, amount=amt, openings=list(openings), kind=Kind.INTERSECTION)
        return offset(shape, amount=amt, kind=Kind.INTERSECTION)
    except Exception as ex:
        # A wall thicker than the solid's own narrowest span has nowhere to go;
        # OCCT surfaces that as a bare RuntimeError, which told the user nothing
        # about the one number they need to change.
        raise ValueError(
            f"Shell failed with a wall of {abs(thickness):g}mm — this is usually "
            "thicker than the body's narrowest span; try a smaller thickness. "
            f"[{type(ex).__name__}]"
        )


def _rot_for(axis, deg):
    """A build123d Rotation of `deg` degrees about the named global axis."""
    if axis == "X":
        return Rot(deg, 0, 0)
    if axis == "Y":
        return Rot(0, deg, 0)
    return Rot(0, 0, deg)


def _fuse_pattern_cells(cells):
    """Union pattern cells. Bbox-DISJOINT cells (the common grid) need no
    boolean at all: bbox-disjoint ⇒ solid-disjoint, and fusing disjoint solids
    yields exactly the compound of them — the old incremental `result + cell`
    chain spent O(n²) full booleans + UnifySameDomain per cell to produce that
    (measured 1.8s → ~0 on a 10x10 grid). OVERLAPPING cells keep the
    incremental chain: one N-tool fuse of mutually-overlapping solids measured
    ~3x SLOWER than the chain (each chain step collapses the intermediate to
    one solid, shrinking later steps). Touching-exactly counts as overlapping
    (tolerance guard) so shared faces still merge like before."""
    if len(cells) == 1:
        return cells[0]
    tol = 1e-6
    boxes = [c.bounding_box() for c in cells]
    disjoint = all(
        a.max.X < b.min.X - tol or b.max.X < a.min.X - tol
        or a.max.Y < b.min.Y - tol or b.max.Y < a.min.Y - tol
        or a.max.Z < b.min.Z - tol or b.max.Z < a.min.Z - tol
        for i, a in enumerate(boxes) for b in boxes[i + 1:]
    )
    if disjoint:
        return _as_compound(cells)
    result = cells[0]
    for cell in cells[1:]:
        result = result + cell
    return result


def _pattern_rect(shape, nx, ny, dx, dy):
    """Replicate a body on an nx×ny grid (spacing dx, dy) and union the copies."""
    nx, ny = max(1, int(round(nx))), max(1, int(round(ny)))
    return _fuse_pattern_cells([Pos(i * dx, j * dy, 0) * shape for i in range(nx) for j in range(ny)])


def _pattern_circular(shape, count, total_angle, axis):
    """Replicate a body `count` times about a global axis spanning `total_angle`
    degrees and union the copies. A full 360° spread doesn't double the seam."""
    count = max(1, int(round(count)))
    full = abs(total_angle - 360) < 1e-6
    step = total_angle / count if full else (total_angle / (count - 1) if count > 1 else 0)
    return _fuse_pattern_cells([_rot_for(axis, k * step) * shape for k in range(count)])


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


# Below this many mm the face does not move: `_press_pull` returns the part
# untouched, and the up-to path REFUSES rather than report a green no-op (see
# _handle_press_pull). One constant so "no movement" cannot come to mean two
# different things at the two sites.
_PP_NO_MOVE = 1e-9

# How far past the source body an up-to prism may reach, as a multiple of that
# body's bounding-box DIAGONAL. The overshoot is span/|n·N| (see _prism_to_plane),
# so it blows up as the target goes edge-on: measured on a 20x20x10 box (diagonal
# 30 mm) with a datum tilted off the face normal, the result's z_max was 11.8 mm at
# 30°, 23.3 at 60°, then 1151.9 at 89.5°, 5735.6 at 89.9° and 572963.8 at 89.999°.
# Those tall ones are geometrically CORRECT — the plane really does climb that far
# — which is why nothing caught them; the problem is blast radius, a metre-high
# spike and a full retessellation of it from one misjudged click. 10 sits an order
# of magnitude above the legitimate cases (60° needs 1.9) and corresponds to about
# 84° off-normal for a face that spans its whole body, so it refuses only targets
# the user is looking at nearly edge-on.
_PP_MAX_OVERSHOOT = 10.0


def _press_pull(part, face, d, clamp=True, trim=None):
    """Push/pull a single solid face by signed distance `d` (mm): +d grows the body
    (boss), -d cuts inward (pocket). `clamp=False` skips the inward-push safety
    cap: the up-to-surface path computes an EXACT distance to a user-chosen
    target, and capping at 90% of local thickness silently stopped short.

    `trim=(point, normal)` is the up-to path: `d` then only SIZES the prism, and
    the material between the face and that plane is cut out of it on BOTH sides of
    the face (see `_prism_to_plane`) so every point of the face lands on the
    target, not just the ones under its centre. Which way each point travels is
    the plane's business, not `d`'s — a target that crosses the face pulls part of
    it out and pushes the rest in, so the up-to path adds AND subtracts.

    PLANAR faces extrude the face region into a prism and boolean it (union for +d,
    subtract for -d). This is far more robust than a local surface offset
    (BRepOffset), which SEGFAULTs on faceted / split imported faces — and it handles
    holed faces fine in practice. CYLINDRICAL faces still use the local offset (to
    resize a hole/boss cleanly). Other curved surfaces are rejected — OCCT's offset
    is too unreliable on them to risk taking down the sidecar.
    """
    # On the up-to path `d` is measured at the face CENTRE, and a tilted target
    # through that centre gives d == 0 while moving the rest of the face by
    # millimetres — so a tiny `d` is only "no movement" when there is no trim
    # plane. `_handle_press_pull` has already measured the real move across the
    # whole face before it hands one over.
    if trim is None and abs(d) < _PP_NO_MOVE:
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
        if trim is None and abs(dd) < _PP_NO_MOVE:
            return part
        if trim is None:
            prism = extrude(face, dd)  # +dd outward (boss), -dd inward (pocket)
            return (part + prism) if dd > 0 else (part - prism)
        # Up-to: two prisms, one per side of the face. `add` is the material
        # OUTSIDE the body between the face and the target, `cut` the material
        # INSIDE it — a target that crosses the face has both, and the sign of
        # `dd` (measured at one point, the centre) cannot pick between them.
        add, cut = _prism_to_plane(face, dd, trim[0], trim[1], part)
        if cut is not None:
            _refuse_if_cut_deletes_a_solid(part, cut)
        out = part
        if add is not None:
            out = out + add
        if cut is not None:
            out = out - cut
        return out
    if gt == GeomType.CYLINDER:
        return _offset_face(part, face, _clamp_cylinder(face, d))
    raise ValueError("Press/Pull supports flat and cylindrical faces only")


def _refuse_if_cut_deletes_a_solid(part, cut):
    """Refuse an up-to cut that would make one of `part`'s solids DISAPPEAR.

    An up-to target past the body's FAR side used to cut the whole thing away and
    report success — solids 0, volume 0, err []. Same silent class as the boolean
    no-op guards in `_boolean_into_bodies`: flag the feature red and leave the
    model alone.

    Emptiness was the first test, and it only fires when nothing at all is left:
    on a body an earlier cut had split in two, the prism ate one solid and the
    survivor kept the chip green (2 solids / 3200 mm³ → 1 solid / 1600).

    The solid COUNT was the second, and it is just as blind, one step deeper: a
    prism that consumes one solid while SPLITTING another leaves the count
    unchanged. Measured on a 20x20x10 plate + 6x20x10 rib + a separate 4x4x4
    block joined into the same body (2 solids / 5264 mm³): a cut down the rib
    removed the rib, split the plate in two and ate the block whole — 2 solids
    in, 2 solids out, err == [], 64 mm³ gone under a green chip.

    So test each solid on its own, which is what the invariant actually says: an
    up-to cut may split a solid in two or eat into one, but it must never make
    one disappear.

    Only the CUT prism is checked. A join that bridges two solids into one also
    drops the count, and that is a real, visible, legitimate outcome.
    """
    solids = part.solids()
    if not solids:
        return
    gone = 0
    for s in solids:
        # AABBs first: a solid the prism cannot reach needs no boolean, which
        # keeps this O(solids the prism actually touches) on a big body.
        try:
            if not _bbox_overlap(s, cut):
                continue
            rem = s - cut
        except Exception:
            continue  # a boolean that won't run is not evidence the solid died
        if not rem.solids():
            gone += 1
    if not gone:
        return
    if gone == len(solids):
        raise ValueError(
            "Press/Pull removed the whole body — the 'up to' target is past its "
            "far side. Pick a target inside the body, or push it by a distance."
        )
    raise ValueError(
        f"Press/Pull would delete {gone} of the body's {len(solids)} "
        "solids — the 'up to' target is past the far side of the piece you "
        "picked. Pick a target inside it, or push it by a distance."
    )


def _prism_to_plane(face, d, target_pt, target_n, part):
    """The material between `face` and the target plane, as `(add, cut)` — the half
    OUTSIDE the body and the half INSIDE it. Either may be None.

    Extrudes the face generously PAST the plane and cuts the prism on it, instead
    of extruding by the single scalar distance-to-the-plane. That scalar is
    measured at the face's CENTRE, so a target that isn't parallel to the face
    produced a FLAT-topped solid — correct along the centre line and silently
    wrong everywhere else, with no error. The trimmed prism's new face IS the
    target plane.

    BOTH sides, because "up to" means every point of the face travels to the
    target and a plane that CROSSES the face sends them opposite ways. Extruding
    only the side the centre is on left the rest of the face where it started:
    measured on a 20x20x10 box with a datum at (0,0,6) tilted 30°, the result
    carried the target plane over part of the top and 165.36 mm² of the original
    z=5 face over the rest — 41% of the picked face never moved, err == []. And
    the volume cannot see it (4794.671 for the half-moved shape against 4400.000
    for a true up-to, which is also what the earlier flat-top bug produced), so
    only the SHAPE is a witness.

    `split(..., bisect_by=<Plane>)` is the same call `_do_split` makes: split
    bounds an unbounded plane against the shape itself, so nothing has to build a
    bounded target face.

    The overshoot is derived, not guessed. A point p on the face reaches the plane
    at d + ((c − p)·N)/(n·N), so the face's own bbox diagonal over |n·N| bounds how
    far past the centre distance the furthest corner can sit.

    `part` is the source body, and it is here only to BOUND that overshoot —
    see `_PP_MAX_OVERSHOOT`."""
    n = face.normal_at()
    denom = n.dot(target_n)
    if abs(denom) < 1e-6:
        # unreachable via _distance_to_target (which refuses first), but this is the
        # term the overshoot divides by — never let it become an infinite prism.
        raise ValueError("Press/Pull: the face is parallel to the 'up to' surface — can't reach it")
    bb = face.bounding_box()
    span = (bb.max - bb.min).length  # ≥ |p − c| for every p on the face
    tilt = span / abs(denom)  # how far past d the furthest corner of the face lands
    # Blast-radius cap. Refusing only |n·N| < 1e-6 (above) leaves everything short
    # of dead-parallel legal, and 1/|n·N| grows without bound long before that:
    # a target a hair off edge-on turns a 20 mm part into a 1.15 m spike, correctly
    # and silently.
    #
    # The cap is on the TILT term ALONE. Folding the numeric slack below into it
    # bounded `d` too, and told a user aiming square-on at a datum 28,000 mm away
    # — |n·N| exactly 1.0, not edge-on by any reading — that the target was "too
    # close to edge-on" (27,000 built, 28,000 did not). A target that is FAR but
    # square-on is a legitimate long extrude; the tilt is what runs away.
    try:
        pbb = part.bounding_box()
        reach = (pbb.max - pbb.min).length
    except Exception:
        reach = None  # unmeasurable body: keep the old behaviour rather than refuse
    if reach and reach > 1e-9 and tilt > _PP_MAX_OVERSHOOT * reach:
        raise ValueError(
            "Press/Pull: the 'up to' surface is too close to edge-on from this face — "
            f"reaching it would build something over {_PP_MAX_OVERSHOOT:g}x the size of "
            "the body. Pick a target more square to the face."
        )
    # |travel| ≤ |d| + tilt everywhere on the face, so this reaches past the plane
    # from either side of it, with a little slack for a clean split.
    length = abs(d) + tilt + max(1.0, 0.01 * abs(d))
    plane = Plane(origin=target_pt, z_dir=target_n)
    # A point at signed height s above the face plane lies between the face and the
    # target exactly when s and (s − travel) have opposite signs, i.e. when
    # (q − target_pt)·N has the sign of −s·(n·N). So the +n prism keeps the side of
    # the target plane where that dot product is ≤ 0 for denom > 0, and the −n
    # prism keeps the other one.
    pos_keep = Keep.BOTTOM if denom > 0 else Keep.TOP
    neg_keep = Keep.TOP if denom > 0 else Keep.BOTTOM
    lo, hi = _face_travel_range(face, target_pt, target_n)
    # Skip the side the face demonstrably never travels to — the ordinary
    # parallel-target gesture has only one, and this keeps its cost unchanged.
    add = _trim_prism_at(face, length, plane, pos_keep) if hi > _PP_NO_MOVE else None
    cut = _trim_prism_at(face, -length, plane, neg_keep) if lo < -_PP_NO_MOVE else None
    if add is None and cut is None:
        raise ValueError(
            "Press/Pull: the 'up to' surface doesn't trim this face's extrusion — "
            "pick a target the face can actually reach."
        )
    return add, cut


def _trim_prism_at(face, length, plane, keep):
    """`face` extruded by `length` (signed, along its normal) and cut on `plane`,
    keeping `keep` — or None when that half holds no material."""
    kept = split(extrude(face, length), bisect_by=plane, keep=keep)
    if kept is None:
        return None
    return kept if kept.solids() else None


def _face_travel_range(src_face, target_pt, target_n):
    """`(min, max)` of the signed distance each point of `src_face` must travel
    along the face's own normal to land on the target plane.

    The distance is AFFINE over the face plane, so the extremes sit at the corners
    — but a face's `vertices()` do not bound a curved edge (a circular top face has
    one), so the face's bounding-box corners are projected back onto the face plane
    and measured too. Projecting first is what makes a target COINCIDENT with a
    tilted face read as exactly zero: off-plane corners of a tilted face's box
    would otherwise show movement where there is none."""
    c, n = src_face.center(), src_face.normal_at()
    denom = n.dot(target_n)
    if abs(denom) < 1e-6:
        raise ValueError("Press/Pull: the face is parallel to the 'up to' surface — can't reach it")

    def travel(p):
        return ((target_pt.X - p.X) * target_n.X
                + (target_pt.Y - p.Y) * target_n.Y
                + (target_pt.Z - p.Z) * target_n.Z) / denom

    pts = [c]
    try:
        pts += [Vector(v.X, v.Y, v.Z) for v in src_face.vertices()]
    except Exception:
        pass
    try:
        bb = src_face.bounding_box()
        for x in (bb.min.X, bb.max.X):
            for y in (bb.min.Y, bb.max.Y):
                for z in (bb.min.Z, bb.max.Z):
                    q = Vector(x, y, z)
                    pts.append(q - n * ((q - c).dot(n)))  # onto the face's own plane
    except Exception:
        pass
    ts = [travel(p) for p in pts]
    return min(ts), max(ts)


def _distance_to_target(src_face, target_pt, target_n, offset=0.0):
    """Signed distance to extrude `src_face` along its own normal so it lands on the
    target plane (a point `target_pt` on it + its normal `target_n`) — i.e. "up to
    that surface". Raises if the face is parallel to the target (it never reaches).

    `offset` shifts the landing along the EXTRUDE DIRECTION (the direction of
    travel, whichever way the face has to move to reach the target): positive goes
    PAST the target, negative stops short. Signing it off the travel direction
    rather than off +normal is what makes "positive = past" hold in both
    directions — a face that has to move against its own normal to reach the
    target would otherwise read the offset backwards.

    Returns `(d, trim_point)`: the signed distance, and a point on the plane the
    prism should be trimmed at (the target plane translated by `offset`), so both
    stay consistent — see `_prism_to_plane`.

    The source face must be PLANAR. A curved face has no single normal to measure
    along: `normal_at()` handed back one arbitrary direction and the wall was
    offset by that scalar, which silently collapsed a r5 h20 cylinder from
    1570.8 mm³ to 15.7 mm³ with no error."""
    try:
        gt = src_face.geom_type
    except Exception:
        gt = None
    if gt != GeomType.PLANE:
        raise ValueError(
            "Press/Pull: 'up to' needs a FLAT source face — a curved face has no single "
            "direction to measure to the target along. Push it by a distance instead."
        )
    c, n = src_face.center(), src_face.normal_at()
    denom = n.X * target_n.X + n.Y * target_n.Y + n.Z * target_n.Z
    if abs(denom) < 1e-6:
        raise ValueError("Press/Pull: the face is parallel to the 'up to' surface — can't reach it")
    num = (target_pt.X - c.X) * target_n.X + (target_pt.Y - c.Y) * target_n.Y + (target_pt.Z - c.Z) * target_n.Z
    d = num / denom
    if not offset:
        return d, target_pt
    # move the plane |offset| along the travel direction; the distance to the moved
    # plane is exactly d + offset·sign(d), so the two can't drift apart.
    shift = offset * (1.0 if d >= 0 else -1.0)
    return d + shift, target_pt + n * shift


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


def _guard_offsetable(part, faces, label):
    """Shared precondition for the OCCT offset family (Offset Face, Thicken).
    Raises ValueError — which the rebuild loop renders as user-facing prose —
    rather than letting BRepOffset take the sidecar down.

    Scope is deliberately the SAME two checks press/pull already trusts, no more.
    An earlier, broader "refuse any faceted body" guard was tried and removed: a
    cylinder STL imported through _refacet_clean reduces to 26 clean planar faces
    and offsets correctly (measured: 2278 → 2502 mm³), so refusing it would have
    blocked legitimate work. The import path already rejects meshes that DON'T
    reduce (MAX_IMPORT_FACES), and server.py's out-of-process worker is the
    backstop for whatever still manages to crash OCCT."""
    for f in faces:
        try:
            gt = f.geom_type
        except Exception:
            gt = None
        if gt not in (GeomType.PLANE, GeomType.CYLINDER):
            raise ValueError(f"{label} supports flat and cylindrical faces only")
        # a lone mesh facet on a dense body: reject rather than offset a sliver
        try:
            if len(part.faces()) > 300 and f.area < 1.0:
                raise ValueError(
                    f"can't {label.lower()} this region — it's a single mesh facet, "
                    "not a clean face"
                )
        except ValueError:
            raise
        except Exception:
            pass


def _offset_face(part, face, d):
    """Single-face convenience wrapper over _offset_faces (curved Press/Pull)."""
    return _offset_faces(part, [(face, d)])


def _offset_faces(part, pairs):
    """Local surface offset via OCCT (BRepOffset in Skin mode with per-face
    offsets, global offset 0). `pairs` is [(face, signed_distance_mm), ...];
    every face is registered before ONE MakeOffsetShape() pass so adjacent
    offsets close against each other instead of fighting over shared edges.
    Returns a fixed-up Solid."""
    import OCP.BRepOffset as _bro
    from OCP.GeomAbs import GeomAbs_JoinType
    from OCP.TopAbs import TopAbs_ShapeEnum
    from OCP.TopoDS import TopoDS
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid

    pairs = [(f, d) for f, d in pairs if abs(d) > 1e-9]
    if not pairs:
        return part

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
    for face, d in pairs:
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
    # pattern sources skip projected reference geometry (fixed/linked, never
    # replicated) — mirrors the `sources` filter in expandPattern
    def srcs_of(ids):
        return [by_id[s] for s in ids if s in by_id and by_id[s].get("type") != "projected"]

    if t == "patternRect":
        cx, cy = max(1, round(val(pat["countX"]))), max(1, round(val(pat["countY"])))
        sx, sy = val(pat["spacingX"]), val(pat["spacingY"])
        srcs = srcs_of(pat.get("sources", []))
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
        srcs = srcs_of(pat.get("sources", []))
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


_TEXT_FONT_STYLE = {
    "regular": FontStyle.REGULAR, "bold": FontStyle.BOLD,
    "italic": FontStyle.ITALIC, "bolditalic": FontStyle.BOLDITALIC,
}
_TEXT_HALIGN = {"left": Align.MIN, "center": Align.CENTER, "right": Align.MAX}


def _entity_edges(e, val):
    """The boundary edge(s) of one sketch entity, LOCAL to the sketch's XY frame
    (unlocated — the caller applies `plane *`). The ONE construction path shared
    by _build_sketch and projection sources, so a projected sketch curve is
    byte-for-byte the geometry the source sketch builds. Raises on degenerate
    input (per-feature error handling stays with the caller); returns [] for
    entity kinds with no curve boundary (point/text/unknown)."""
    t = e.get("type")
    if t == "line":
        return [Edge.make_line((val(e["x1"]), val(e["y1"]), 0), (val(e["x2"]), val(e["y2"]), 0))]
    if t == "arc":
        return [Edge.make_three_point_arc(
            (val(e["x1"]), val(e["y1"]), 0),
            (val(e["mx"]), val(e["my"]), 0),  # through-point
            (val(e["x2"]), val(e["y2"]), 0))]
    if t == "circle":
        return [Pos(val(e.get("x", 0)), val(e.get("y", 0))) * Edge.make_circle(val(e["radius"]))]
    if t == "spline":
        pts = [(val(p["x"]), val(p["y"]), 0) for p in e.get("points", [])]
        return [Edge.make_spline(pts)] if len(pts) >= 2 else []
    if t == "rectangle":
        x, y = val(e.get("x", 0)), val(e.get("y", 0))
        hw, hh = val(e["width"]) / 2, val(e["height"]) / 2
        c = [(x - hw, y - hh), (x + hw, y - hh), (x + hw, y + hh), (x - hw, y + hh)]
        return [Edge.make_line((c[k][0], c[k][1], 0), (c[(k + 1) % 4][0], c[(k + 1) % 4][1], 0))
                for k in range(4)]
    if t == "polygon":
        cx, cy = val(e.get("x", 0)), val(e.get("y", 0))
        r = val(e["radius"])
        n = max(3, int(round(val(e["sides"]))))
        ang = math.radians(val(e.get("angle", 0)))  # stored DEGREES (format v2)
        pts = [
            (cx + math.cos(ang + i / n * 2 * math.pi) * r, cy + math.sin(ang + i / n * 2 * math.pi) * r)
            for i in range(n)
        ]
        return [Edge.make_line((pts[i][0], pts[i][1], 0), (pts[(i + 1) % n][0], pts[(i + 1) % n][1], 0))
                for i in range(n)]
    if t == "slot":
        ax, ay = val(e["x1"]), val(e["y1"])
        bx, by = val(e["x2"]), val(e["y2"])
        w = val(e["width"]) / 2  # half-width = cap radius
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1.0
        dx, dy = dx / L, dy / L
        nx, ny = -dy * w, dx * w  # left perpendicular * radius
        a1, a2 = (ax + nx, ay + ny), (ax - nx, ay - ny)
        b1, b2 = (bx + nx, by + ny), (bx - nx, by - ny)
        a_tip = (ax - dx * w, ay - dy * w)
        b_tip = (bx + dx * w, by + dy * w)
        return [
            Edge.make_line((a1[0], a1[1], 0), (b1[0], b1[1], 0)),
            Edge.make_three_point_arc((b1[0], b1[1], 0), (b_tip[0], b_tip[1], 0), (b2[0], b2[1], 0)),
            Edge.make_line((b2[0], b2[1], 0), (a2[0], a2[1], 0)),
            Edge.make_three_point_arc((a2[0], a2[1], 0), (a_tip[0], a_tip[1], 0), (a1[0], a1[1], 0)),
        ]
    if t == "projected":
        # Projected reference geometry: edges from the CACHED ProjectedCurve —
        # plain numbers authored by the projection recompute, consumed verbatim
        # and never val()'d or resolved here.
        cv = e.get("curve") or {}
        ck = cv.get("kind")
        if ck == "line":
            # Zero-length cached line (a view-aligned projection persisted by
            # an older build): reference-only, like the point-like poly below
            if math.hypot(cv["x2"] - cv["x1"], cv["y2"] - cv["y1"]) <= 1e-9:
                return []
            return [Edge.make_line((cv["x1"], cv["y1"], 0), (cv["x2"], cv["y2"], 0))]
        if ck == "circle":
            return [Pos(cv["x"], cv["y"]) * Edge.make_circle(cv["r"])]
        if ck == "arc":
            return [Edge.make_three_point_arc(
                (cv["x1"], cv["y1"], 0),
                (cv["mx"], cv["my"], 0),  # through-point
                (cv["x2"], cv["y2"], 0))]
        if ck == "poly":
            pts = cv.get("pts") or []
            # A view-aligned source edge projects to a POINT: the degenerate
            # poly fallback ("never an error") arrives with coincident samples.
            # Collapse consecutive duplicates and skip point-like remains —
            # reference-only, like a sketch point — instead of feeding OCCT a
            # zero-length line (StdFail → whole sketch red).
            dedup = [p for i, p in enumerate(pts)
                     if i == 0 or math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-9]
            if len(dedup) < 2:
                return []
            return list(Polyline(*[(p[0], p[1], 0) for p in dedup]).edges())
        return []
    return []


def _entity_edge(e, val):
    """One build123d edge for a line/arc/circle/spline entity — used as a text path.
    Returns None for non-curve entities or on any construction failure."""
    if e.get("type") not in ("line", "arc", "circle", "spline"):
        return None
    try:
        eds = _entity_edges(e, val)
    except Exception:
        return None
    return eds[0] if eds else None


def _measure_text_width(s, font_size, font_style, font):
    if not s.strip():
        return 0.0
    try:
        kw = {"font_size": font_size, "font_style": font_style}
        if font:
            kw["font"] = font
        bb = Text(s, **kw).bounding_box()
        return bb.max.X - bb.min.X
    except Exception:
        return 1e9  # measurement failed: don't force a break


def _wrap_text(txt, box_w, font_size, font_style, font):
    """Greedy word-wrap `txt` to lines fitting box_w (mm), preserving explicit newlines —
    build123d's single_line_width does NOT wrap, so we do it by measuring. Capped so a
    huge string can't stall the per-keystroke preview."""
    if box_w <= 0 or len(txt) > 400:
        return txt
    lines = []
    for para in txt.split("\n"):
        line = ""
        for word in para.split(" "):
            cand = f"{line} {word}".strip()
            if line and _measure_text_width(cand, font_size, font_style, font) > box_w:
                lines.append(line)
                line = word
            else:
                line = cand
        lines.append(line)
    return "\n".join(lines)


def _text_faces(e, val, path_edge=None):
    """build123d faces for a `text` sketch entity (2D, on the sketch's local XY),
    anchored at (x, y), rotated, aligned; text-on-path when `path_edge` is set. Shared
    by the solid build and the preview op so glyphs match exactly. Best-effort: returns
    [] on empty/whitespace text or ANY font/glyph failure (one bad font can't fail the
    whole rebuild)."""
    txt = e.get("text") or ""
    if not txt.strip():
        return []
    try:
        kw = {
            "font_size": val(e["height"]),
            "font_style": _TEXT_FONT_STYLE.get(e.get("style", "regular"), FontStyle.REGULAR),
            "align": (_TEXT_HALIGN.get(e.get("align", "left"), Align.MIN), Align.CENTER),
            "rotation": val(e.get("angle", 0) or 0),
        }
        if e.get("font"):
            kw["font"] = e["font"]
        if path_edge is not None:
            kw["path"] = path_edge
            if e.get("positionOnPath") is not None:
                kw["position_on_path"] = val(e["positionOnPath"])
        box_w = e.get("boxWidth")
        if box_w is not None and path_edge is None:
            txt = _wrap_text(txt, val(box_w), kw["font_size"], kw["font_style"], e.get("font"))
        text = Text(txt, **kw)
        # text-on-path is already positioned by the path; a free text is anchored at (x,y)
        located = text if path_edge is not None else Pos(val(e.get("x", 0) or 0), val(e.get("y", 0) or 0)) * text
        return list(located.faces())
    except Exception:
        return []


def _text_entity_of(f):
    """The `text` sketch-entity dict a `textOnFace` feature is equivalent to.

    Lets `_text_faces` be reused verbatim, so sketch text, face text and the 2D
    typing preview all come out of ONE font engine — a face emboss can never
    drift from the outline the user was shown while typing. `u`/`v` are the
    in-plane anchor (the feature's own frame), which is `_text_faces`' `x`/`y`.
    Values stay unresolved so parameter-driven fields still work."""
    ent = {
        "text": f.get("text") or "",
        "height": f["height"],
        "style": f.get("style", "regular"),
        "align": f.get("align", "left"),
        "angle": f.get("angle", 0) or 0,
        "x": f.get("u", 0) or 0,
        "y": f.get("v", 0) or 0,
    }
    if f.get("font"):
        ent["font"] = f["font"]
    if f.get("boxWidth"):
        ent["boxWidth"] = f["boxWidth"]
    return ent


# --- text bevel ---------------------------------------------------------------
# Rounding or chamfering the rim of embossed/engraved letters. Every constant and
# every guard below exists because of a measured failure — 4,883 glyph blends
# across 9 font families produced 89 SIGSEGVs, 2.2% silently-corrupt solids, and
# a best-effort mode that left up to 17 of 19 letters sharp while returning a
# perfectly valid single solid.

_BEVEL_MIN_STROKE_RATIO = 0.5  # bevel must stay under half the glyph stroke width
# Cache of which (font, style, char, operator, radius) combinations survive the
# kernel, filled by the out-of-process probe. Radius is quantised because a user
# dragging the value would otherwise miss on every keystroke; it is IN the key
# rather than assumed irrelevant, even though every crash measured was radius-
# independent (Nimbus Roman 'B' cored at every radius from 0.2 mm to 0.001 mm).
_BEVEL_PROBE_CACHE: dict = {}
_BEVEL_PROBE_TIMEOUT = 30.0


def _bbox_of(shape):
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape.wrapped, box)
    return box.Get()


def _blend_is_sane(before, after, tol=1e-6):
    """Did this blend produce real geometry, or a self-intersecting lie?

    Per-glyph fillet returns corrupt solids in 2.2% of operations that pass
    EVERY conventional check — BRepCheck_Analyzer.IsValid() true, one solid,
    face-count delta equal to the rim-edge count, volume inside the normal band
    (and always LOWER, so a volume-sign test catches none of them).

    The one signal that separated all 7 known-bad from all 313 known-good, with
    no false positives, is the OPTIMAL bounding box growing: a blend only ever
    removes material from a convex rim, so a box that grew means the trimmed
    surfaces blew up. BRepBndLib.Add — the triangulation-based variant — is
    useless here (222 false positives out of 313), and a vertex-only box misses
    every case, because the vertices never move; it is the surfaces that do.
    """
    try:
        if len(after.solids()) != 1 or after.volume <= 0:
            return False
        a = _bbox_of(before)
        b = _bbox_of(after)
        for i in range(3):  # mins may not go lower
            if b[i] < a[i] - tol:
                return False
        for i in range(3, 6):  # maxes may not go higher
            if b[i] > a[i] + tol:
                return False
        return True
    except Exception:
        return False  # an unmeasurable blend is not an acceptable one


def _rim_edges(prism, direction):
    """The edges of `prism`'s far face along `direction` — the rim an emboss
    stands proud on."""
    d = Vector(*direction)
    faces = sorted(prism.faces(), key=lambda f: f.center().dot(d))
    return list(faces[-1].edges())


def _blend_rim(prism, edges, radius, kind):
    """One rim blend, validated. Returns the new solid, or None if this operator
    can't do it (raised, or returned something corrupt)."""
    try:
        out = chamfer(edges, length=radius) if kind == "chamfer" else fillet(edges, radius=radius)
    except Exception:
        return None
    return out if _blend_is_sane(prism, out) else None


def _taper_prism(glyph, depth, angle_deg):
    """A glyph prism whose walls slope — the classic embossed-lettering look,
    as opposed to a blended rim.

    Validated hard, because this is the one path in the feature that returns
    CORRUPT GEOMETRY WITHOUT RAISING. Measured over 62 glyphs: 45 succeed, 15
    raise, and 2 come back silently wrong — Text('g') at 25 degrees returns
    volume 0.0 with IsValid() false, and Text('Q') returns a NEGATIVE volume.
    Separately, 'S', 'M' and 'W' at 20 degrees and up return entirely plausible
    volumes on self-intersected sidewalls, which only BRepCheck catches.

    A positive angle narrows the prism away from the face, which is what both
    directions want: a raised letter that slopes in toward its top, and an
    engraved one that opens out toward its mouth.
    """
    from OCP.BRepCheck import BRepCheck_Analyzer

    try:
        out = extrude(glyph, depth, taper=angle_deg)
    except Exception:
        return None
    try:
        if len(out.solids()) != 1:
            return None
        v = out.volume
        flat = glyph.area * abs(depth)
        # A taper only ever removes material from the straight prism, so a
        # volume outside (0, flat] is proof the walls self-intersected.
        if not (0 < v <= flat * 1.001):
            return None
        return out if BRepCheck_Analyzer(out.wrapped).IsValid() else None
    except Exception:
        return None


def _taper_angle(bevel, depth):
    """The wall angle that moves the top edge in by `bevel` millimetres over
    `depth` of rise — so the control stays a WIDTH whichever style is chosen."""
    return math.degrees(math.atan2(bevel, depth))


def _bevel_recipe(f, ctx, radius, kinds):
    return {
        "text": f.get("text") or "", "font": f.get("font"),
        "style": f.get("style", "regular"), "align": f.get("align", "left"),
        "height": ctx.val(f["height"]), "depth": ctx.val(f["depth"]),
        "radius": round(radius, 4), "kinds": list(kinds),
    }


def _recipe_key(r):
    return (r["text"], r["font"] or "", r["style"], r["align"],
            round(r["height"], 4), round(r["depth"], 4), r["radius"], tuple(r["kinds"]))


def _probe_glyphs(recipe):
    ent = {"text": recipe["text"], "height": recipe["height"], "style": recipe["style"],
           "align": recipe["align"], "x": 0, "y": 0}
    if recipe.get("font"):
        ent["font"] = recipe["font"]
    return _text_faces(ent, lambda v: v)


def _bevel_probe_main():
    """Entry point of the probe subprocess: `python -c "import builder;
    builder._bevel_probe_main()"` with the recipe as JSON on stdin.

    Prints a `try` line BEFORE each attempt and a `done` line after. That
    ordering is the whole mechanism: when the kernel takes the process down
    there is no exception and no traceback, so the last unmatched `try` is the
    only evidence of which glyph did it.

    Probes by glyph INDEX over the whole string rather than by character.
    Character would be the natural key — the crash signature is (font, style,
    glyph, operator, radius) — but a laid-out string cannot be mapped back to
    its characters reliably: an "i" is two disjoint faces, a space is none, and
    a wrapped line breaks any positional guess. Index needs no mapping and is
    exactly what the caller has in hand.
    """
    recipe = json.load(sys.stdin)
    glyphs = _probe_glyphs(recipe)
    angle = _taper_angle(recipe["radius"], recipe["depth"])
    for i, g in enumerate(glyphs):
        prism = extrude(g, recipe["depth"])
        edges = _rim_edges(prism, (0, 0, 1))
        for kind in recipe["kinds"]:
            print(json.dumps({"try": [i, kind]}), flush=True)
            try:
                if kind == "taper":
                    ok = _taper_prism(g, recipe["depth"], angle) is not None
                else:
                    ok = _blend_rim(prism, edges, recipe["radius"], kind) is not None
            except Exception:
                ok = False
            print(json.dumps({"done": [i, kind], "ok": ok}), flush=True)


def _probe_bevels(recipe):
    """Clear every (glyph, operator) of this text through a throwaway process
    before the real worker touches it.

    A glyph rim blend does not always raise: measured over 4,883 attempts, 1.8%
    took the process down with SIGSEGV — no exception, no traceback, nothing
    Python can catch. Geometry runs in a max_workers=1 pool, so that costs the
    user their whole rebuild and surfaces as "crashed the geometry kernel".
    Spending one fork to find out first turns it into a sentence they can act on.

    Returns {(index, kind): bool}. Anything the probe did not report on — it
    cored, or ran past the timeout — is False. Never True by default.

    CAVEAT, stated rather than hidden: the probe blends the glyph flat at the
    origin, which is congruent to the planar path (a rigid transform cannot
    change the outcome) but only an approximation of the curved one, where the
    real rim comes from a projected patch. Curved bevels are therefore
    best-effort protected, not proven.
    """
    key = _recipe_key(recipe)
    if key in _BEVEL_PROBE_CACHE:
        return _BEVEL_PROBE_CACHE[key]
    import subprocess

    verdicts = {}
    try:
        proc = subprocess.run(
            [sys.executable, "-c", "import builder; builder._bevel_probe_main()"],
            input=json.dumps(recipe), capture_output=True, text=True,
            cwd=os.path.dirname(os.path.abspath(__file__)),
            timeout=_BEVEL_PROBE_TIMEOUT,
        )
        for line in proc.stdout.splitlines():
            try:
                rec = json.loads(line)
            except Exception:
                continue  # font-subsystem chatter, not our protocol
            if "done" in rec:
                verdicts[(rec["done"][0], rec["done"][1])] = bool(rec["ok"])
    except subprocess.TimeoutExpired:
        pass  # everything unreported is treated as unusable, which is right
    _BEVEL_PROBE_CACHE[key] = verdicts
    return verdicts



def _min_stroke_width(glyph):
    """A cheap proxy for the thinnest stroke of a glyph: 2*area/perimeter, the
    width of the equivalent long thin rectangle."""
    try:
        per = sum(e.length for e in glyph.edges())
        return (2.0 * glyph.area / per) if per > 0 else 0.0
    except Exception:
        return 0.0


# --- text on a curved face ----------------------------------------------------




# A planar face just extrudes the glyph. A curved one has to PROJECT it onto the
# surface first, and every cheap way of doing that is wrong in a way that ships
# silently — hence the three constants below, each guarding a measured failure.

_TEXT_PROJ_DEFLECTION = 0.005  # meshing tolerance for the shadow integral
# A glyph must land essentially whole on the picked face, and this is the only
# thing standing between the user and a word with letters silently sheared off:
# overflowing text still reports one valid solid and a plausible volume.
#
# RECALIBRATED 2026-08-18 from a field report. The old 0.99 was set from a single
# sample (a R=20 cylinder in the default font) and sat inside the measurement
# noise of legitimate text, so it refused a correct document. Measured by moving
# this constant and reading the error the product actually produces -- no
# instrumentation of the internals, because an instrumented probe misreported
# which branch was firing and had to be thrown away:
#
#   ordinary text, R=20 cylinder, default font        >= 0.999   builds
#   the field document with its font REMOVED          [0.995, 0.999)
#   the field document as saved (a heavy face)        [0.985, 0.99)  <- refused
#   text genuinely hanging off the end of the face    [0.30, 0.35)
#
# THE FONT IS THE VARIABLE, not the geometry, and that is the same document at
# the same placement in both of the middle rows: a heavier face carries more
# glyph boundary, the shortfall is boundary mesh error, so a bold font reads
# lower while fitting perfectly well. 0.90 clears the worst legitimate reading by
# 0.085 and still refuses a real clip by a factor of nearly three.
#
# Worth knowing when reading the next bug report: the shortfall does NOT depend
# on text size. The field case was refused identically at every height from
# 1.5mm to 10mm, so "make it smaller" could never have helped, which is why the
# message no longer leads with it.
#
# NOT resolvable by tuning: a glyph clipped by a few percent is indistinguishable
# from a heavy font's measurement error, because the two overlap. Catching those
# needs a containment test rather than an area ratio.
_TEXT_MIN_COVERAGE = 0.90
# Projected area / flat area. The projection direction is fixed (build123d's
# Face.project_to_shape takes no radial option), so a glyph on a steeply
# turning-away surface gets smeared rather than wrapped — up to 6.7x on a torus
# throat, producing exact, valid, unreadable geometry. 2.0 is ~60 degrees of
# obliquity. A cylinder/cone/sphere at sane text sizes measures 1.01-1.12.
_TEXT_MAX_SMEAR = 2.0


def _shadow_area(shape, direction):
    """Area of `shape` seen along `direction` — the shadow it casts.

    Integrated over a fine triangulation because OCCT has no B-rep API for it.
    """
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.gp import gp_Vec
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    BRepMesh_IncrementalMesh(shape.wrapped, _TEXT_PROJ_DEFLECTION, False, 0.5, True)
    d = gp_Vec(*direction)
    total = 0.0
    exp = TopExp_Explorer(shape.wrapped, TopAbs_FACE)
    while exp.More():
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(TopoDS.Face_s(exp.Current()), loc)
        if tri is not None:
            trsf = loc.Transformation()
            for i in range(1, tri.NbTriangles() + 1):
                a, b, c = tri.Triangle(i).Get()
                p1 = tri.Node(a).Transformed(trsf)
                p2 = tri.Node(b).Transformed(trsf)
                p3 = tri.Node(c).Transformed(trsf)
                total += abs(gp_Vec(p1, p2).Crossed(gp_Vec(p1, p3)).Dot(d)) / 2.0
        exp.Next()
    return total


def _project_glyph(glyph, target_face, direction, extent):
    """Cut `target_face` down to the shadow `glyph` casts along `direction`.

    Hand-rolled rather than `Face.project_to_shape`, for two measured reasons.
    Its Face-target branch raises `TypeError: Surface_s(): incompatible function
    arguments` on EVERY curved face, and its Shape-target branch projects onto
    the whole solid — which runs one boolean per glyph against every face of the
    body, measured at 43 ms/glyph on a 6-face box but 378 ms/glyph on a 104-face
    one (~38 s for a word on a 1,000-face import).

    Returns the CONNECTED patches, because a two-sided prism through a cylinder
    legitimately hits the near wall and the far wall, and those must stay
    separate for the caller to choose between. A glyph straddling a surface seam
    is the opposite case — several faces that are really one patch — so the
    pieces are sewn before being handed back.
    """
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing
    from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
    from OCP.gp import gp_Vec
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    # two-sided: the glyph must reach the surface whichever side of it the
    # layout plane ended up on
    back = Pos(*[-x * extent for x in direction]) * glyph
    prism = BRepPrimAPI_MakePrism(back.wrapped, gp_Vec(*[x * 2 * extent for x in direction])).Shape()
    com = BRepAlgoAPI_Common(target_face.wrapped, prism)
    com.Build()
    if not com.IsDone():
        return []
    faces = []
    exp = TopExp_Explorer(com.Shape(), TopAbs_FACE)
    while exp.More():
        faces.append(Face(TopoDS.Face_s(exp.Current())))
        exp.Next()
    if len(faces) <= 1:
        return faces
    sew = BRepBuilderAPI_Sewing(1e-6)
    for f in faces:
        sew.Add(f.wrapped)
    sew.Perform()
    patches, seen = [], set()
    exp = TopExp_Explorer(sew.SewedShape(), TopAbs_SHELL)
    while exp.More():
        sh = Shell(TopoDS.Shell_s(exp.Current()))
        patches.append(sh)
        for f in sh.faces():
            seen.add(f.wrapped.TShape())
        exp.Next()
    patches.extend(f for f in faces if f.wrapped.TShape() not in seen)
    return patches


def _text_patches_on_curved(glyphs, face, direction, pick, extent):
    """One surface patch per glyph, projected onto `face` and gated.

    Raises rather than dropping anything: every failure mode here is silent by
    default — a missing glyph comes back as an empty list, a truncated one as a
    perfectly valid smaller patch."""
    pick_t = sum(p * q for p, q in zip(pick, direction))
    patches, missing, worst_cov, worst_smear = [], [], 1.0, 1.0
    for g in glyphs:
        cands = _project_glyph(g, face, direction, extent)
        if not cands:
            missing.append(g)
            continue
        # Choose by RAY PARAMETER against the point the user actually clicked.
        # Nearest-hit, face-centre sign and surface-normal sign were each
        # measured wrong on realistic bodies — on an overhang channel,
        # nearest-hit picks the block top instead of the channel floor, putting
        # the text on a completely different surface.
        best = min(
            cands,
            key=lambda c: abs(
                sum(p * q for p, q in zip((c.center().X, c.center().Y, c.center().Z), direction)) - pick_t
            ),
        )
        worst_cov = min(worst_cov, _shadow_area(best, direction) / g.area)
        worst_smear = max(worst_smear, best.area / g.area)
        patches.append(best)
    if missing or not patches:
        raise ValueError(
            "Text: the text runs off this face — make it smaller, or move it away "
            "from the edge"
        )
    if worst_cov < _TEXT_MIN_COVERAGE:
        raise ValueError(
            f"Text: one letter is only {worst_cov * 100:.0f}% on this face, so it "
            "would be cut off — move the text away from the edge, or make it smaller"
        )
    if worst_smear > _TEXT_MAX_SMEAR:
        raise ValueError(
            "Text: this part of the face curves too steeply away — the text would "
            "be stretched unreadably. Move it to a flatter spot or make it smaller."
        )
    return patches


def _wire_polyline(wire):
    """Sample a glyph-contour wire to a closed 2D polyline [[x,y], ...] in edge order."""
    pts = []
    for ed in wire.edges():
        try:
            n = max(2, min(24, int((ed.length or 1) / 0.3) + 2))
        except Exception:
            n = 8
        for i in range(n):
            p = ed.position_at(i / n)
            pts.append([round(p.X, 4), round(p.Y, 4)])
    if pts:
        pts.append(list(pts[0]))  # close the loop
    return pts


def _num_or(x, default=0.0):
    if isinstance(x, (int, float)):
        return x
    try:
        return float(x)
    except Exception:
        return default


def tessellate_text(entity, path_entity=None):
    """Per-glyph 2D outlines for a text entity: {"faces": [{"outer": [[x,y]...],
    "holes": [[[x,y]...]]}]} in FINAL sketch-2D coords (anchor/rotation/align/path
    applied). Uses _text_faces so the preview matches the extruded solid exactly.
    Stateless/read-only; entity fields are already resolved numbers from the client."""
    def v(x):
        return _num_or(x, 0.0)
    path_edge = _entity_edge(path_entity, v) if path_entity else None
    out = []
    for fc in _text_faces(entity, v, path_edge):
        out.append({
            "outer": _wire_polyline(fc.outer_wire()),
            "holes": [_wire_polyline(w) for w in fc.inner_wires()],
        })
    return {"faces": out}


def list_fonts():
    """Available system font families (OCCT Font_FontMgr, fontconfig-backed). Read-only."""
    try:
        from OCP.Font import Font_FontMgr
        from OCP.TColStd import TColStd_SequenceOfHAsciiString

        mgr = Font_FontMgr.GetInstance_s()
        seq = TColStd_SequenceOfHAsciiString()
        mgr.GetAvailableFontsNames(seq)
        return {"families": sorted({seq.Value(i).ToCString() for i in range(1, seq.Length() + 1)})}
    except Exception:
        return {"families": []}


# Two sketch points closer than this ARE the same point, so a line between them
# has no extent. OCCT's own Precision::Confusion (1e-7 mm, read off the kernel),
# deliberately not a tolerance of our own: anything wider would be picking a
# minimum-feature size, which docs/EDGE-CASES.md §1 leaves open as a product
# decision rather than a bug fix.
#
# MEASURED (sidecar/test_degenerate_entities.py pins all of it): OCCT does not
# refuse short lines. Above 1e-7 it builds the edge with its real length; from
# just under 1e-7 all the way down to 1e-15 it still builds an edge, but the one
# it hands back has length exactly 0.0; and it raises StdFail at only two points
# in the range — exactly 1e-7, and exactly coincident. Bisected at x = 0.1, 1,
# 10, 100 and 1000 the flip is 1e-7 to seven figures every time, so it is an
# absolute distance. `<= _COINCIDENT` is therefore the whole band the kernel
# will not give extent to, and refuses nothing OCCT would have built with any.
_COINCIDENT = 1e-7

# Two CONSECUTIVE spline points closer than this cannot be interpolated. This is
# not an OCCT constant but build123d's own default `tol` for Edge.make_spline,
# which it passes straight to GeomAPI_Interpolate — so the boundary belongs to
# our own call, and the test asserts the default still reads 1e-6.
#
# MEASURED: a gap of exactly 1e-6 RAISES, and so does everything below it;
# 1.0000001e-6 is the first gap that builds. Bisected at spans of 0.1, 1, 10, 100
# and 1000 mm it is the same absolute 1e-6 every time — a gap, not a ratio. The
# comparison below is therefore `<=`, not `<`: an earlier cut used `<` on a
# comment that claimed exactly 1e-6 built, which let precisely that value through
# to the kernel and out to the user as the worst message of the three, "sketch
# failed (Standard_ConstructionError)" with an empty body. That is the failure
# this guard exists to remove, so it must not be the one value it misses.
_SPLINE_MIN_GAP = 1e-6

# What to tell the user when OCCT itself refuses to build a curve. Keyed by
# entity type; every one of these failures is "the points are too close together
# or too straight", the kernel just says so in a different class each time. Each
# value is one clause with no dash of its own — the template supplies the only
# one, so the message does not read as two sentences fighting.
_UNBUILDABLE_ADVICE = {
    "line": "its two ends are too close together; move one end away from the other",
    "arc": "its three points are too close together, or too near one straight line, "
           "for an arc to pass through them; move its middle point off the line "
           "between the two ends",
    "spline": "two of its points are too close together to interpolate; move one "
              "of them",
    "slot": "it is too short or too narrow; give it more length or width",
    "polygon": "its radius is too small; give it a bigger one",
}


def _entity_anchor(e, val):
    """Where to send the user looking for one sketch entity.

    The start point where there is one, because that is where the sketch tool
    put the cursor; the centre otherwise. Degenerate entities draw nothing, so
    coordinates are the ONLY way to find them in a sketch of any size — that is
    why every message in the guard block carries this.
    """
    if "x1" in e:
        return val(e["x1"]), val(e["y1"])
    pts = e.get("points") or []
    if pts:
        return val(pts[0]["x"]), val(pts[0]["y"])
    return val(e.get("x", 0)), val(e.get("y", 0))


def _unbuildable_message(e, val):
    """A named, located message for a curve the KERNEL refused to build.

    The guards in _build_sketch catch what they can predict; this catches what
    they cannot, so no OCCT class name has to reach the user as the whole
    explanation. Two of the three boundaries involved are absolute constants
    (see _COINCIDENT and _SPLINE_MIN_GAP), but an arc's is a fixed fraction of
    its chord — 3.7252903e-9 * chord, measured identical on chords of 0.1, 1,
    10, 100 and 1000 mm — so no constant can express it, and a guard that tried
    was wrong at every scale but one: it refused arcs OCCT builds happily on a
    10 mm chord while still leaking StdFail_NotDone on a 1000 mm one. Letting
    the kernel decide and naming its refusal is exact at every size, and cannot
    refuse anything that would have built.

    The exception itself is deliberately not quoted: its class was the whole
    problem in field report 88042d97, and for a spline its message is empty.
    """
    kind = e.get("type") or "entity"
    x, y = _entity_anchor(e, val)
    advice = _UNBUILDABLE_ADVICE.get(
        kind, "its points are too close together to define it")
    article = "an" if kind[:1] in "aeiou" else "a"
    return (f"{article} {kind} in this sketch cannot be built (near {x:g}, {y:g}) — "
            f"{advice}, or delete it")


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
    plane = _plane_of(_sketch_plane_ref(f), datums)
    faces = []
    edges = []  # free-form line + arc edges, assembled into faces below
    all_edges = []  # EVERY entity's boundary as local edges, for planar subdivision
    # Which entity each arrangement edge came from. A selected region is stored in
    # the document as an interior POINT, which does not survive the user moving the
    # geometry that formed it (field report a20cca53) — the ids do, so they let the
    # anchor be recomputed. See _region_anchor_from_entities.
    by_ent = {}

    def _own(ent, eds):
        """tag `eds` as belonging to `ent`, and hand them straight back"""
        eid = ent.get("id")
        if eid:
            by_ent.setdefault(eid, []).extend(eds)
        return eds

    def _own_edges(ent):
        """`_own(ent, _entity_edges(ent, val))`, but a KERNEL refusal names the
        entity instead of reaching the generic handler as a bare class name.

        The backstop for everything the guard block above cannot predict. It can
        only fire where the build had already failed, so it cannot refuse
        geometry that would have built — which is what lets the guards stay on
        the safe side of every threshold rather than racing OCCT's.

        KeyError and TypeError pass through untouched: those mean a field is
        missing or the wrong shape, which is a malformed document, not geometry
        the user can move. So does ValueError, which is how the guards above
        raise: relabelling one would replace a message naming the entity with a
        weaker one about points being too close.

        Only OCCT's own failures are relabelled, by module rather than by a list
        of class names. The kernel raises a different class for each primitive
        (StdFail_NotDone for a line or arc, Standard_ConstructionError for a
        spline) and adding a curve type would add another, so matching on names
        would rot. Anything else — an IndexError off a malformed point list, an
        OverflowError out of a parameter expression, a plain bug in the arc or
        slot construction — is NOT the user's geometry being too small, and
        saying so would send them looking for a modelling fault that is not
        there. Those propagate to the generic handler, which is honest about
        being generic.
        """
        try:
            eds = _entity_edges(ent, val)
        except (KeyError, TypeError, ValueError):
            raise
        except Exception as ex:
            if type(ex).__module__.split(".")[0] != "OCP":
                raise
            raise ValueError(_unbuildable_message(ent, val)) from ex
        return _own(ent, eds)

    # Associative patterns: expand each definition into its derived entities and
    # append them, so a patterned hole/array builds like hand-drawn geometry. The
    # math mirrors src/sketch/pattern.ts so frontend preview and build agree.
    entities = list(f.get("entities", []))
    if f.get("patterns"):
        by_id = {e["id"]: e for e in entities if e.get("id")}
        for pat in f["patterns"]:
            entities.extend(_expand_pattern(pat, by_id, val))
    by_id_all = {e["id"]: e for e in entities if e.get("id")}  # text pathRef lookup
    text_local = []  # glyph faces (2D local); integrated into faces + located_faces below

    for e in entities:
        if e.get("construction"):
            continue  # construction geometry is reference-only, not a profile
        et = e["type"]
        # Degenerate primitives must be caught HERE, by name. A zero-radius circle
        # is a point, not a wire, so build123d's make_face fails its coplanarity
        # probe and reports "Cannot build face(s): wires not planar" — a message
        # that sends the user hunting for a tilted sketch that does not exist.
        # This was a real field bug (docs/EDGE-CASES.md §1): a ring whose inner
        # circle had collapsed to r=0.
        if et == "circle" and not (val(e["radius"]) > 0):
            cx, cy = val(e.get("x", 0)), val(e.get("y", 0))
            raise ValueError(
                f"a circle in this sketch has a radius of {val(e['radius']):g} "
                f"(centred at {cx:g}, {cy:g}) — give it a radius greater than 0, "
                "or delete it"
            )
        if et == "rectangle" and not (val(e["width"]) > 0 and val(e["height"]) > 0):
            rx, ry = val(e.get("x", 0)), val(e.get("y", 0))
            raise ValueError(
                f"a rectangle in this sketch has a zero width or height "
                f"(centred at {rx:g}, {ry:g}) — give it a size, or delete it"
            )
        # Lines and splines had no guard here, so a degenerate one fell through
        # to _entity_edges and OCCT answered with a bare StdFail_NotDone
        # ("BRep_API: command not done"), or — for a spline — a
        # Standard_ConstructionError whose message is the EMPTY STRING. The
        # generic handler turned those into "sketch failed (StdFail_NotDone)":
        # field report 88042d97, where one zero-length line failed a sketch,
        # five revolves and an extrude with seven errors, and the reporter could
        # see nothing wrong with the profile because a zero-length line draws
        # nothing. They read the cascade as a revolve bug ("I cannot rotate it
        # about the X"); every revolve was only saying its sketch was missing.
        #
        # These REFUSE rather than skip, like the two guards above. Skipping is
        # defensible — a zero-extent entity adds no area, and the frontend
        # already leaves them out of a region (that document's own
        # regionEntities excludes the bad line) — but the entity is invisible,
        # so a silent skip would leave it in the file forever with nothing ever
        # naming it. Hence the location in every message: it is the only way to
        # find geometry that draws nothing.
        #
        # ARCS deliberately have no threshold here. Their boundary is a fraction
        # of the chord, not a distance, so a constant is wrong at every size but
        # one; _own_edges below names the kernel's own refusal instead. See
        # _unbuildable_message.
        if et == "line":
            x1, y1 = val(e["x1"]), val(e["y1"])
            # <= because the whole band up to and including _COINCIDENT is
            # geometry OCCT gives no extent to — see that constant for the sweep.
            if math.hypot(val(e["x2"]) - x1, val(e["y2"]) - y1) <= _COINCIDENT:
                raise ValueError(
                    f"a line in this sketch has zero length (both ends at {x1:g}, "
                    f"{y1:g}) — move one end away from the other, or delete the line"
                )
        if et == "spline":
            pts = [(val(p["x"]), val(p["y"])) for p in e.get("points", [])]
            # Only CONSECUTIVE repeats break the interpolation: measured, a
            # spline that returns to an earlier point (a closed loop) builds
            # fine, while two points in a row at the same place raise. `<=`
            # because a gap of EXACTLY _SPLINE_MIN_GAP is refused by the kernel
            # too — see that constant.
            for i in range(1, len(pts)):
                if math.hypot(pts[i][0] - pts[i - 1][0],
                              pts[i][1] - pts[i - 1][1]) <= _SPLINE_MIN_GAP:
                    raise ValueError(
                        f"a spline in this sketch has two points in the same place "
                        f"(at {pts[i][0]:g}, {pts[i][1]:g}) — move one of them, or "
                        "delete the spline"
                    )
        if et == "rectangle":
            faces.append(
                Pos(val(e.get("x", 0)), val(e.get("y", 0)))
                * Rectangle(val(e["width"]), val(e["height"]))
            )
            all_edges.extend(_own_edges(e))
        elif et == "circle":
            faces.append(Pos(val(e.get("x", 0)), val(e.get("y", 0))) * Circle(val(e["radius"])))
            all_edges.extend(_own_edges(e))
        elif et in ("line", "arc", "spline", "polygon", "slot"):
            # free-form curves + parametric outlines: boundary edges join the
            # loop assembly AND the planar arrangement (one construction path —
            # _entity_edges — shared with sketch-curve projection sources)
            for ed in _own_edges(e):
                edges.append(ed)
                all_edges.append(ed)
        elif et == "point":
            continue  # a sketch point is reference/snap-only, never part of a profile
        elif et == "projected":
            # Projected reference geometry: edges come from the CACHED curve via
            # _entity_edges (plain numbers, never resolved here — _build_sketch
            # stays geometry-free; the checkpoint sketch-replay invariant
            # depends on it). A cached circle also contributes its FACE,
            # mirroring the native circle branch; degenerate curves (zero-length
            # line, point-like poly) yield no edges: reference-only.
            #
            # Deliberately NOT wrapped in _own_edges: these numbers are authored
            # by the projection recompute, not by a user, so a refusal here is
            # our bug and must not be dressed up as "move your points apart".
            if (e.get("curve") or {}).get("kind") == "circle":
                cv = e["curve"]
                faces.append(Pos(cv["x"], cv["y"]) * Circle(cv["r"]))
                all_edges.extend(_own(e, _entity_edges(e, val)))
            else:
                for ed in _own(e, _entity_edges(e, val)):
                    edges.append(ed)
                    all_edges.append(ed)
        elif et == "text":
            ref = e.get("pathRef")
            path_edge = _entity_edge(by_id_all[ref], val) if ref and ref in by_id_all else None
            # glyph CONTOURS deliberately never enter all_edges — feeding them to
            # _subdivide_faces' splitter would fragment overlapping profiles + explode cost
            text_local.extend(_text_faces(e, val, path_edge))

    if edges:
        faces.extend(_faces_from_edges(edges))
    faces.extend(text_local)  # glyph faces union into the whole-sketch profile (extrude)

    # the located open/closed path wire from the free edges (for sweep paths)
    path_wire = _path_wire(edges, plane)

    # Region-pick faces = the planar ARRANGEMENT of every sketch edge: a line
    # crossing a profile carves it into separately-selectable sub-areas (mainstream MCAD
    # parity), and touching/overlapping loops split at the shared boundaries. This
    # mirrors the frontend arrangement (src/sketch/region.ts).
    located_faces = _subdivide_faces(all_edges, plane)
    for tf in text_local:  # each glyph is separately region-selectable in mixed geometry
        located_faces.extend((plane * tf).faces())

    if faces:
        # Union the loop faces into the whole-sketch profile in ONE OCCT boolean
        # (build123d's multi-arg fuse) rather than N sequential pairwise fuses: the
        # old `sk = sk + fc` loop was O(N^2) and cost SECONDS on a honeycomb of a few
        # hundred cells. The batch fuse is ~70x faster and yields the identical union
        # (verified: same area, same extrude+cut volume/face count). This one stays
        # on build123d's PARALLEL path deliberately: it fuses planar FACES, not the
        # many-small-disjoint-SOLID class where _serial_bool's serial win applies.
        sk = faces[0].fuse(*faces[1:]) if len(faces) > 1 else faces[0]
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
        sk = located_faces[0].fuse(*located_faces[1:]) if len(located_faces) > 1 else located_faces[0]
        if _wrapped_or_none(sk) is None:
            sk = Compound(list(sk))
    else:
        return {"sketch": None, "faces": [], "wire": path_wire,
                "edgesByEntity": by_ent, "plane": plane}

    return {"sketch": sk, "faces": located_faces, "wire": path_wire,
            "edgesByEntity": by_ent, "plane": plane}


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


# How far a rebuilt region's area may sit from the arrangement cell its anchor
# landed in before the anchor is thrown away (see _region_face_from_entities).
# Both numbers come from the same edges through different code, so a correct pair
# matches to float noise; the wrong pairs this exists to catch are 9% apart.
REGION_AREA_TOL = 1e-6

# How far inside the rebuilt profile a cell must sit before that area mismatch is
# allowed to mean "the anchor fell into a hole". A hole clears the profile's
# boundary by millimetres; a cell that is merely a PIECE of the profile shares
# that boundary and the gap is exactly 0, so this only has to beat float noise.
REGION_HOLE_CLEARANCE = 1e-6


def _region_anchor_from_entities(entry, eids, hole_eids=None):
    """`(point, area, bbox)` for the region bounded by exactly these sketch
    entities, in the LOCATED frame — the anchor a stored region reference should
    use once the geometry it was picked on has moved, plus the area and bounding
    box of the profile it came from.

    Deriving a point is NOT by itself enough to make a stored reference safe, and
    this is deliberately not the function to call: go through
    `_region_face_from_entities`, which owns the check that the point resolved to
    the profile it was derived from. On a document that names a region's outer
    loop but not its holes — every file betas 0.1.123 to 0.1.144 wrote — the
    entities here rebuild a SOLID face and the point returned is inside the hole.
    That is field report 19314fdc and this function cannot see it: the hole ids it
    would need are simply absent from the document.

    Field report a20cca53: an extrude stores a bare interior POINT per selected
    area. Move the circle that formed that area and the point stays behind, lands
    inside whatever cell now covers it — the surrounding rectangle, in the report —
    and THAT gets extruded. It is silent, because containment succeeds: the point
    really is inside a profile, just not the one the user chose. The entity ids
    recorded alongside survive the move; the point does not.

    `hole_eids` names the entities bounding each HOLE of the region, and they are
    load-bearing on any profile with a hole: the outer loop ALONE rebuilds a SOLID
    face — for a rectangle exactly ONE face, so the face-count guard below passes —
    and the point taken from it sits inside the hole. The caller then resolves that
    to the inner cell. That is field report 19314fdc, the wall of a shell
    cross-section extruding as its inner loop, shipped in 0.1.123. So the holes are
    CUT out of the outer face here and the point comes from what is left, which is
    the region's material by construction: `Region.holes` are the DIRECT children
    of the loop, so outer-minus-them is exactly what the user picked.

    The point is `center()` where the kernel agrees that is in the material, and
    the centroid of the biggest triangle of the face's own triangulation where it
    does not. A shell's centroid is in its hole (measured (0,0,0) for the reported
    100x100/80x80, `is_inside` False), and so is a ring's and a crescent's — but
    `center()` is right for the ordinary convex profile and costs ~0.26 ms against
    ~2.9 ms to tessellate, so it is tried first and the tessellation is the answer
    for exactly the faces that need it.

    Returns None whenever the entities do not bound exactly one face, and the
    caller falls back to the stored point. That covers a line splitting a square
    (both halves carry the SAME entity set, and nothing here can tell them apart),
    a hole that cuts the material into two, a hole loop with no recoverable entity
    ids, and every document written before these fields existed. A wrong anchor is
    worse than a stale one, so this refuses rather than guesses — but "refuses when
    it knows" is not the same as "is safe", which is why the wrapper exists."""
    by_ent = entry.get("edgesByEntity") or {}
    plane = entry.get("plane")
    if not eids or plane is None:
        return None

    def collect(ids):
        """Every edge those entities contributed, or None if one of them is gone."""
        eds = []
        for eid in ids:
            got = by_ent.get(eid)
            if not got:
                return None  # an entity the reference names is gone: stale, not moved
            eds.extend(got)
        return eds

    def one_face(ids):
        """The single face those entities bound, or None — see the refusals above."""
        eds = collect(ids)
        if eds is None:
            return None
        try:
            faces = _faces_from_edges(eds)
        except Exception:
            return None
        return faces[0] if len(faces) == 1 else None

    face = one_face(eids)
    if face is None:
        return None
    holes = []
    for grp in (hole_eids or []):
        if not grp:
            # A hole loop whose provenance the tracer could not recover
            # (src/sketch/region.ts emits `traced[j]?.eids ?? []`, and Region's own
            # doc says that list is empty when the tracer deduped the loop away).
            # Treating it as "no hole" would rebuild the profile SOLID and put the
            # anchor straight back in the hole — field 19314fdc again, silently.
            return None
        hf = one_face(grp)
        if hf is None:
            return None  # a hole we cannot rebuild would leave the anchor in it
        holes.append(hf)
    try:
        if holes:
            # A REAL boolean subtract, not "pick the biggest cell": on an ordinary
            # shell the hole is the bigger face (6400mm2 against a 3600mm2 wall in
            # field report 19314fdc), so any area heuristic reproduces that bug.
            cut = face.cut(*holes)
            fs = cut.faces()
            if len(fs) != 1:
                return None  # a hole that severs the material: no single anchor
            face = fs[0]
        fc = plane * face
        # BEFORE `_face_interior_point`: tessellating a shape attaches a
        # triangulation, and `_body_fingerprint` documents a bbox that MOVES by up
        # to 0.49 mm once a shape carries one. The wrapper compares this box
        # against the arrangement's, so it has to be the exact one.
        bbox = fc.bounding_box()
        p = fc.center()
        if not _face_contains(fc, p):
            p = _face_interior_point(fc)
        # Backstop: the triangulation is the mesher's opinion, `is_inside` is the
        # kernel's. Fall back to the stored point rather than trust a point the
        # kernel does not agree is in the material.
        if p is None or not _face_contains(fc, p):
            return None
        return p, float(fc.area), bbox
    except Exception:
        return None


def _region_face_from_entities(entry, cells, eids, hole_eids=None):
    """The arrangement cell a stored region reference means, rebuilt from the
    sketch ENTITIES it recorded instead of from its interior point — or None, and
    then the caller must fall back to that point.

    THIS is the function to call. `_region_anchor_from_entities` derives the point;
    the invariant that makes the point safe to use lives here, because a caller
    that only derives it inherits field 19314fdc. The rebuilt profile must BE the
    cell the anchor landed in: 0.1.123 through 0.1.144 wrote `regionEntities` with
    no `regionHoleEntities`, so a holed region from one of those documents rebuilds
    SOLID and its anchor is inside the hole — live on every file they saved, with
    nothing moved, and no "does this region have holes" test can see it because the
    ids are absent. The areas disagree loudly when it happens (10000 against the
    6400 hole cell on the reported shell, 3600 against the 1256.6 hole of a
    centred-hole plate) while a correct anchor matches its cell exactly, curved
    boundaries included.

    The mismatch alone is not enough to condemn the anchor, though. A reference
    that names only SOME of its boundary entities also rebuilds bigger than its
    cell, and there the anchor is right and the stored point is the stale one that
    field a20cca53 is about — throwing the anchor away would reintroduce that bug
    to fix this one. What separates them is that a hole is strictly INSIDE the
    profile, while a cell that is merely a piece of it shares the profile's outer
    boundary. So the cell must clear the profile's bounding box on every axis that
    has room (the plane's normal has none) before a mismatch counts."""
    anchor = _region_anchor_from_entities(entry, eids, hole_eids)
    if anchor is None:
        return None
    pt, area, bbox = anchor
    # No diagnostics on this attempt: `regionStale` is about the stored POINT, and
    # if the anchor is not accepted the point is resolved by the caller and gets to
    # speak for itself.
    rf = _region_face_at(cells, pt)
    if rf is None:
        return None
    off = abs(rf.area - area)
    if off > REGION_AREA_TOL * max(rf.area, area) and _bbox_strictly_inside(
        _cell_bbox(cells, rf), bbox
    ):
        return None  # the anchor is in a hole this document never named
    return rf


def _cell_bbox(cells, face):
    """The bounding box the caller already computed for `face`, so a cell and the
    profile it is compared against are never measured at different moments — see
    the tessellation drift note in `_region_anchor_from_entities`."""
    for fc, bb in cells:
        if fc is face:
            return bb
    return face.bounding_box()


def _bbox_strictly_inside(inner, outer):
    """Is `inner` clear of `outer`'s boundary on every axis that has room?

    Both boxes here are of coplanar faces, so the plane's normal axis is flat in
    BOTH and can only be required to match, not to clear. Anything that fails to
    be strictly inside is treated as touching, which keeps the caller's area check
    from firing on a cell that is merely part of its profile."""
    if inner is None or outer is None:
        return False
    lo_i, hi_i = inner.min, inner.max
    lo_o, hi_o = outer.min, outer.max
    c = REGION_HOLE_CLEARANCE
    for a in ("X", "Y", "Z"):
        li, hi = getattr(lo_i, a), getattr(hi_i, a)
        lo, ho = getattr(lo_o, a), getattr(hi_o, a)
        if ho - lo <= c:  # flat axis: inside means "on the same plane"
            if li < lo - c or hi > ho + c:
                return False
        elif li <= lo + c or hi >= ho - c:
            return False
    return True


def _face_interior_point(face):
    """A point comfortably inside a planar face, holes included: the centroid of
    the largest triangle of its own triangulation.

    A triangle's centroid is well inside that triangle, so the biggest triangle
    gives the point the most clearance — measured inside on a 100x100/80x80 shell,
    a centred-hole plate, an r20/r18 ring whose biggest triangle is only 1mm2, an
    L, and a plain rectangle. Only ever call this on a face built here: tessellate
    attaches a triangulation to the shape, and `_body_fingerprint` documents a
    bbox that MOVES by up to 0.49 mm once a shape carries one."""
    try:
        verts, tris = face.tessellate(0.1)
    except Exception:
        return None
    best = None
    for (i, j, k) in tris:
        a, b, c = verts[i], verts[j], verts[k]
        area2 = ((b - a).cross(c - a)).length
        if best is None or area2 > best[0]:
            best = (area2, (a + b + c) * (1.0 / 3.0))
    return best[1] if best else None


def _region_face_at(cells, P, diag=None, feature_id=None):
    """Pick the planar arrangement cell whose material contains point P.

    `cells` is a list of (face, bounding_box) pairs — the caller precomputes the
    bboxes ONCE because region picking runs per selected point, and OCCT `is_inside`
    is far too slow to call on every face (38 honeycomb points × 160 cells of
    is_inside + a per-nested-face boolean was ~2.8 s). A bbox pre-filter cuts the
    point-in-face tests down to the 1-2 cells whose box actually contains P.

    Arrangement cells (from `_subdivide_faces`) already carry their holes natively, so
    the smallest containing cell IS the region — no nested-hole subtraction needed.
    Falls back to the nearest cell by center when P isn't inside any (tessellation
    drift / degenerate geometry).

    That fallback is for DRIFT — a point that should still be on its cell and is off
    by a rounding-scale amount. When the nearest cell is nowhere near P the reference
    is stale, not drifted, and silently extruding a different area is how a user ends
    up cutting geometry they never selected. Push a `regionStale` diagnostic in that
    case so the UI can offer a re-pick, and keep returning the nearest cell so the
    build still completes. Note this is NOT the mechanism behind field report
    a20cca53: there the stale point lands INSIDE a genuinely different cell, so
    containment succeeds and this fallback never runs. Entity-anchored regions are
    what fixes that; this only stops the no-containing-cell case being silent."""
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
    near = min((fc for fc, _ in cells), key=lambda fc: (fc.center() - P).length)
    if diag is not None:
        # distance from P to the chosen cell's BOX (0 when inside it) — a truer
        # "is P even near this cell" test than centre distance, which the ranking
        # above uses only to order candidates.
        bb = near.bounding_box()
        dx = max(bb.min.X - P.X, 0.0, P.X - bb.max.X)
        dy = max(bb.min.Y - P.Y, 0.0, P.Y - bb.max.Y)
        dz = max(bb.min.Z - P.Z, 0.0, P.Z - bb.max.Z)
        off = (dx * dx + dy * dy + dz * dz) ** 0.5
        if off > POS_DRIFT + REL_DRIFT * _bbox_diag(near):
            diag.append({
                "feature_id": feature_id,
                "kind": "regionStale",
                "resolved": 1,
                "confidence": 0.0,
                "lossy": True,
                "reason": "no profile contains the stored region point",
                "at": [round(float(P.X), 6), round(float(P.Y), 6), round(float(P.Z), 6)],
                "offBy": round(float(off), 4),
            })
    return near


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


# --- projection (Project/Include geometry) -----------------------------------
# Math + the projectGeometry aux-op behind the Fusion-style Project command:
# turn a 3D edge (a body edge, a face-boundary edge, a located sketch curve)
# into a 2D ProjectedCurve on a target sketch plane. The REBUILD never calls
# this from _build_sketch — projected entities carry a cached curve, and
# refreshing that cache is a rebuild-handler concern (see the plan). Numbers
# are rounded to 6 decimals HERE so the persisted document is byte-stable.

# sampled-poly density: one sample per 0.5 mm of edge length, clamped
_POLY_MIN_SEGS, _POLY_MAX_SEGS, _POLY_MM_PER_SEG = 16, 128, 0.5


def _r6(v):
    """Round for the wire/document: 6 decimals, -0.0 normalized to 0.0."""
    return round(float(v), 6) + 0.0


def _project_pt(plane, p):
    """A world point projected into the plane's 2D frame (drop the local Z)."""
    l = plane.to_local_coords(p)
    return l.X, l.Y


def _project_edge_to_plane(edge, plane):
    """Project one located 3D edge onto `plane` → a ProjectedCurve dict.

    Exact where exactness survives projection: a line stays a line (degenerate
    view-aligned line → 2-point poly, never an error); a circle whose axis is
    parallel to the plane normal stays a circle (closed) or a 3-point arc
    (open). Everything else (tilted circle, ellipse, bspline) is sampled to a
    poly — build123d's position_at is arc-length parametrized, so samples are
    evenly spaced along the curve."""
    ct = _edge_curve(edge)
    if ct == "line":
        ax, ay = _project_pt(plane, edge.position_at(0))
        bx, by = _project_pt(plane, edge.position_at(1))
        ax, ay, bx, by = _r6(ax), _r6(ay), _r6(bx), _r6(by)
        # Degeneracy check on the ROUNDED endpoints: a ~1.4e-6 diagonal
        # projection passes a raw-value check yet collapses to a zero-length
        # line on the 1e-6 grid (StdFail in _build_sketch's line branch).
        if math.hypot(bx - ax, by - ay) < 1e-6:
            # edge parallel to the view direction: projects to a point
            return {"kind": "poly", "pts": [[ax, ay], [bx, by]]}
        return {"kind": "line", "x1": ax, "y1": ay, "x2": bx, "y2": by}
    if ct == "circle":
        from OCP.BRepAdaptor import BRepAdaptor_Curve

        circ = BRepAdaptor_Curve(edge.wrapped).Circle()
        d = circ.Axis().Direction()
        axis = Vector(d.X(), d.Y(), d.Z())
        if abs(axis.dot(plane.z_dir)) > 1 - 1e-6:
            if edge.is_closed:
                cx, cy = _project_pt(plane, edge.arc_center)
                return {"kind": "circle", "x": _r6(cx), "y": _r6(cy), "r": _r6(circ.Radius())}
            (x1, y1), (mx, my), (x2, y2) = (
                _project_pt(plane, edge.position_at(t)) for t in (0, 0.5, 1)
            )
            return {"kind": "arc", "x1": _r6(x1), "y1": _r6(y1), "x2": _r6(x2), "y2": _r6(y2),
                    "mx": _r6(mx), "my": _r6(my)}
    # tilted circle / ellipse / bspline / anything else: sampled fallback
    try:
        n = int(min(_POLY_MAX_SEGS, max(_POLY_MIN_SEGS, edge.length / _POLY_MM_PER_SEG)))
        samples = [edge.position_at(i / n) for i in range(n + 1)]
    except Exception:
        # length/position_at both run GCPnts_AbscissaPoint, which raises
        # Standard_ConstructionError on degenerate seam/pole edges (sphere seam
        # meridian, revolve pole) — the hazard tessellate._sample_by_param
        # hardens; walk the raw curve parameter instead
        from tessellate import _sample_by_param

        raw = _sample_by_param(edge, _POLY_MIN_SEGS)
        if raw is None:
            raise
        samples = [Vector(*q) for q in raw]
    pts = []
    for p in samples:
        x, y = _project_pt(plane, p)
        pts.append([_r6(x), _r6(y)])
    return {"kind": "poly", "pts": pts}


def _curve_close(a, b, tol=1e-4):
    """Structural compare of two ProjectedCurve dicts: same kind and every number
    within `tol` (the projection-refresh change tolerance). Polys compare
    pointwise; a length mismatch is a change."""
    if a.get("kind") != b.get("kind"):
        return False
    if a.get("kind") == "poly":
        pa, pb = a.get("pts") or [], b.get("pts") or []
        if len(pa) != len(pb):
            return False
        return all(
            abs(p[0] - q[0]) <= tol and abs(p[1] - q[1]) <= tol for p, q in zip(pa, pb)
        )
    return all(abs(a[k] - b[k]) <= tol for k in a if k != "kind")


def _curve_reversed(c):
    """The same ProjectedCurve traversed the other way (HLR can emit the same
    outline segment with either orientation across buckets/rebuilds)."""
    k = c.get("kind")
    if k == "line":
        return {"kind": "line", "x1": c["x2"], "y1": c["y2"], "x2": c["x1"], "y2": c["y1"]}
    if k == "arc":
        return {**c, "x1": c["x2"], "y1": c["y2"], "x2": c["x1"], "y2": c["y1"]}
    if k == "poly":
        return {"kind": "poly", "pts": list(reversed(c.get("pts") or []))}
    return c  # circle: orientation-free


def _curve_rep(c):
    """Three representative points (end, end, mid) for the nearest-curve metric.
    A circle has no ends: center twice + a radius-displaced point stand in."""
    k = c.get("kind")
    if k == "line":
        return (c["x1"], c["y1"]), (c["x2"], c["y2"]), \
            ((c["x1"] + c["x2"]) / 2, (c["y1"] + c["y2"]) / 2)
    if k == "arc":
        return (c["x1"], c["y1"]), (c["x2"], c["y2"]), (c["mx"], c["my"])
    if k == "circle":
        return (c["x"], c["y"]), (c["x"], c["y"]), (c["x"] + c["r"], c["y"])
    pts = c.get("pts") or [[0.0, 0.0]]
    return tuple(pts[0]), tuple(pts[-1]), tuple(pts[len(pts) // 2])


def _pt_dist(p, q):
    """Euclidean distance between two 2D points given as (x, y) pairs."""
    return math.hypot(p[0] - q[0], p[1] - q[1])


def _curve_dist(a, b):
    """Distance between two ProjectedCurves for silhouette nearest-matching:
    endpoint distances (orientation-insensitive) + midpoint distance. Different
    kinds never match (inf) — a resized cylinder's silhouette LINE must track a
    line, not the nearest rim poly."""
    if a.get("kind") != b.get("kind"):
        return float("inf")
    (a1, a2, am), (b1, b2, bm) = _curve_rep(a), _curve_rep(b)
    return min(
        _pt_dist(a1, b1) + _pt_dist(a2, b2),
        _pt_dist(a1, b2) + _pt_dist(a2, b1),
    ) + _pt_dist(am, bm)


def _curve_close_either(a, b):
    """_curve_close, orientation-insensitive: `a` matches `b` as-is or reversed."""
    return _curve_close(a, b) or _curve_close(_curve_reversed(a), b)


def _curve_oriented(c, cached):
    """`c` or its reverse — whichever endpoint order lies nearer `cached`'s.
    Matching is orientation-insensitive, but the ASSIGNED curve must keep the
    cached endpoint order: an HLR orientation flip on unchanged geometry would
    otherwise swap point indices 0/1 under endpoint-attached constraints/dims
    (and trip the orientation-sensitive emission gate in
    _recompute_projections)."""
    (c1, c2, _cm), (q1, q2, _qm) = _curve_rep(c), _curve_rep(cached)
    if _pt_dist(c1, q2) + _pt_dist(c2, q1) < _pt_dist(c1, q1) + _pt_dist(c2, q2):
        return _curve_reversed(c)
    return c


def _project_silhouette(shape, plane):
    """The visible outline (HLR) of a body projected onto `plane`, as a list of
    ProjectedCurve dicts in the plane's 2D frame.

    HLRBRep_Algo with an HLRAlgo_Projector built from the sketch plane's exact
    right-handed frame (gp_Ax2 sets Y = normal x xdir, matching the plane's
    y_dir) returns edges ALREADY in projector 2D coordinates (x, y, z=0) — no
    to_local_coords pass; _project_edge_to_plane against Plane.XY reuses the
    line/circle/arc-exactness + sampled-poly mapping unchanged.

    Buckets: VCompound (visible sharp edges) + OutLineVCompound (surface
    silhouettes). The probe's seam pitfall — a cylinder seam lying ON a
    silhouette generator moves that line INTO VCompound — is covered by this
    union, and probing shows OCCT promotes ANY outline-coincident regular edge
    the same way (a tangent edge seen edge-on lands in V too). Rg1LineV/RgNLineV
    are deliberately EXCLUDED: probing shows they only ever carry visible smooth/
    sewn edges NOT on the outline (a sphere's seam meridian, a tilted cylinder's
    seam generator) — stray interior curves that would split regions and break
    the sphere-projects-to-its-exact-circle contract."""
    from OCP.BRepLib import BRepLib
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
    from OCP.HLRAlgo import HLRAlgo_Projector
    from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    o, n, x = plane.origin, plane.z_dir, plane.x_dir
    ax2 = gp_Ax2(gp_Pnt(o.X, o.Y, o.Z), gp_Dir(n.X, n.Y, n.Z), gp_Dir(x.X, x.Y, x.Z))
    algo = HLRBRep_Algo()
    algo.Add(shape.wrapped if hasattr(shape, "wrapped") else shape)
    algo.Projector(HLRAlgo_Projector(ax2))
    algo.Update()
    algo.Hide()  # required — without it the visible/hidden buckets are empty
    hlr = HLRBRep_HLRToShape(algo)
    curves = []
    for comp in (hlr.VCompound(), hlr.OutLineVCompound()):
        if comp is None or comp.IsNull():
            continue
        ex = TopExp_Explorer(comp, TopAbs_EDGE)
        while ex.More():
            ed = TopoDS.Edge_s(ex.Current())
            ex.Next()
            # HLR edges carry only 2D curve-on-surface data; materialize a 3D
            # curve first — build123d's length/position_at SEGFAULT without it
            BRepLib.BuildCurves3d_s(ed)
            c = _project_edge_to_plane(Edge(ed), Plane.XY)
            if c["kind"] == "poly":
                xs = [p[0] for p in c["pts"]]
                ys = [p[1] for p in c["pts"]]
                if max(xs) - min(xs) < 1e-6 and max(ys) - min(ys) < 1e-6:
                    continue  # an edge seen end-on projects to a point: no curve
            # dedupe near-identical curves either way round (HLR emits the same
            # segment in several buckets for coincident geometry)
            if any(_curve_close_either(c, q) for q in curves):
                continue
            curves.append(c)
    return curves


def _assign_silhouette(sibs, fresh):
    """Assign one silhouette group's FRESH curve list to its sibling entities
    (the correspondence rule — documented in _recompute_projections' docstring).
    Returns {entity_id: curve-or-None}; None = stale. `sibs` arrive shortlex-
    sorted; `fresh` is None when the body itself no longer resolves."""
    if not fresh:
        return {e["id"]: None for e in sibs}
    remaining = list(fresh)
    out = {}
    movers = []
    for e in sibs:  # pass 1: cached-curve match (steady state / tiny drift)
        cached = e.get("curve") or {}
        m = next((c for c in remaining if _curve_close_either(c, cached)), None)
        if m is not None:
            out[e["id"]] = _curve_oriented(m, cached)
            remaining.remove(m)
        else:
            movers.append(e)
    # pass 2: nearest same-kind curve (a resized body's movers track), pairs
    # consumed in globally ascending _curve_dist order — greedy-per-sibling
    # would let a shortlex-earlier sibling steal another mover's clearly
    # nearer curve on an asymmetric move. Exact ties stay deterministic:
    # (dist, sibling shortlex position, HLR position).
    pairs = []
    for i, e in enumerate(movers):
        cached = e.get("curve") or {}
        for j, c in enumerate(remaining):
            dist = _curve_dist(c, cached)
            if dist < float("inf"):
                pairs.append((dist, i, j))
    taken_sibs = set()
    taken_curves = set()
    for _dist, i, j in sorted(pairs):
        if i in taken_sibs or j in taken_curves:
            continue
        e = movers[i]
        out[e["id"]] = _curve_oriented(remaining[j], e.get("curve") or {})
        taken_sibs.add(i)
        taken_curves.add(j)
    unmatched = [e for i, e in enumerate(movers) if i not in taken_sibs]
    remaining = [c for j, c in enumerate(remaining) if j not in taken_curves]
    for i, e in enumerate(unmatched):  # pass 3: positional; beyond the fresh set -> stale
        out[e["id"]] = remaining[i] if i < len(remaining) else None
    # Fresh curves left with NO sibling are DROPPED: a shape change can grow new
    # outline curves, but a refresh only updates existing entities — re-run the
    # Project pick to bring the new curves in (auto-adding entities from a
    # rebuild refresh is deferred).
    return out


def _recompute_projections(f, ctx):
    """Associative refresh of one sketch's projected entities, run by
    _handle_sketch right after the sketch is built: re-resolve every source
    against the TIMELINE-PREFIX state (ctx.bodies = the bodies built before
    this sketch; the features list before it for cross-sketch sources) and
    append change entries to ctx.projections.

    Convergence contract (what terminates the frontend's refresh loop): steady
    state emits NOTHING. A fresh curve is emitted only when it differs from the
    cached one beyond _curve_close's 1e-4 tolerance, or the entity was stale
    and resolves again (stale:false clears the flag). {stale: true} is emitted
    only on the not-stale -> stale TRANSITION. Resolution here is LENIENT
    (keep-last-shape + stale flag); the strict refuse-at-pick path is
    project_geometry's.

    Multi-edge sketchCurve correspondence: a source entity yielding several
    edges (rectangle/polygon/slot) was projected as N sibling entities sharing
    source.group. The pick site persists each sibling's edge index within
    _entity_edges' deterministic order as source.index — the authoritative
    correspondence, stable across sibling deletions AND source moves. A
    multi-edge sibling WITHOUT an index is unresolvable -> stale, like an
    unknown source kind. An index beyond the fresh edge count means that
    edge is gone -> stale.

    Silhouette correspondence: a silhouette source has NO per-curve selectors —
    the source is the whole body, and the fresh HLR curve LIST can change count
    and order across rebuilds. Each group's siblings (shortlex id order) are
    matched against the fresh list in three passes, each fresh curve consumed
    at most once: (1) cached-curve match within _curve_close tolerance (steady
    state); (2) NEAREST same-kind curve by _curve_dist — endpoint + midpoint
    distance, pairs consumed in globally ascending order — so a resized
    cylinder's silhouette lines track their own side; (3) the remaining
    siblings positionally against the remaining fresh curves. Assigned curves
    are orientation-normalized to the cached endpoint order (_curve_oriented).
    Siblings beyond the fresh set go stale; fresh curves with no sibling are
    DROPPED (re-run the Project pick to pick up new outline curves — auto-add
    from a refresh is deferred)."""
    ents = [e for e in f.get("entities") or []
            if isinstance(e, dict) and e.get("type") == "projected" and e.get("id")]
    if not ents:
        return
    plane = _plane_of(_sketch_plane_ref(f), ctx.datums)
    # features strictly BEFORE this sketch: the prefix a source may live in
    prefix = []
    for ft in ctx.features or []:
        if ft is f or ft.get("id") == f.get("id"):
            break
        prefix.append(ft)
    # per-(sketch, entity) fresh sketchCurve projection memo, filled lazily by
    # _fresh_projection — siblings of one multi-edge source share the projected
    # list instead of re-projecting the whole source per sibling
    curve_fresh = {}

    # silhouette groups: one fresh HLR curve list per BODY (computed once), each
    # (body, group) sibling set assigned from its own copy of that list
    sil_groups = {}
    for e in ents:
        s = e.get("source") or {}
        if s.get("kind") == "silhouette":
            sil_groups.setdefault((s.get("body"), s.get("group")), []).append(e)
    sil_assign = {}
    sil_fresh = {}
    for (body_id, _g), group in sil_groups.items():
        group.sort(key=lambda x: (len(x["id"]), x["id"]))
        if body_id not in sil_fresh:
            body = ctx.find_body(body_id)
            try:
                sil_fresh[body_id] = (
                    _project_silhouette(body["shape"], plane)
                    if body is not None and body.get("shape") is not None
                    else None
                )
            except Exception:
                sil_fresh[body_id] = None  # HLR failure = lost source (lenient)
        sil_assign.update(_assign_silhouette(group, sil_fresh[body_id]))

    for e in ents:
        if (e.get("source") or {}).get("kind") == "silhouette":
            fresh = sil_assign.get(e["id"])
        else:
            try:
                fresh = _fresh_projection(e, plane, prefix, curve_fresh, ctx)
            except Exception:
                fresh = None  # any resolution/projection failure = lost source
        if fresh is None:
            if not e.get("stale"):
                ctx.projections.append(
                    {"sketch": f["id"], "entity": e["id"], "stale": True}
                )
        elif e.get("stale") or not _curve_close(fresh, e.get("curve") or {}):
            ctx.projections.append(
                {"sketch": f["id"], "entity": e["id"], "curve": fresh, "stale": False}
            )


def _fresh_projection(e, plane, prefix, curve_fresh, ctx):
    """The freshly-projected curve for one projected entity, or None when its
    source no longer resolves against the prefix state (missing body / sketch /
    entity, ambiguous match). `curve_fresh` memoizes the projected edge list
    per sketchCurve source across one sketch's entities. Silhouette entities
    never reach here — their group-level correspondence runs in
    _recompute_projections."""
    src = e.get("source") or {}
    kind = src.get("kind")
    if kind in ("edge", "faceBoundary"):
        # faceBoundary persists PER-EDGE by:"match" sels too (see the pick site
        # in sketchMode.ts) — both kinds resolve via resolve_edges. LENIENT on
        # purpose: an upstream resize makes the fingerprint a "marginal match"
        # (length changed), which is exactly the association we must follow —
        # only a body/edge that no longer resolves AT ALL goes stale.
        body = ctx.find_body(src.get("body"))
        if body is None or body.get("shape") is None:
            return None
        edges = resolve_edges(body["shape"], src.get("sel"))
        if not edges:
            return None  # the source edge is gone — keep last shape
        return _project_edge_to_plane(edges[0], plane)
    if kind == "sketchCurve":
        key = (src.get("sketch"), src.get("entity"))
        if key not in curve_fresh:
            try:
                src_plane, eds = _resolve_sketch_curve(prefix, src, ctx.datums, ctx.val)
                curve_fresh[key] = [
                    _project_edge_to_plane(src_plane * ed, plane) for ed in eds
                ]
            except Exception:
                curve_fresh[key] = None  # lost source (lenient), memoized
        fresh = curve_fresh[key]
        if not fresh:
            return None
        if len(fresh) == 1:
            return fresh[0]
        idx = src.get("index")
        if isinstance(idx, int):
            # authoritative pick-time edge index (see the docstring above)
            return fresh[idx] if 0 <= idx < len(fresh) else None
        return None  # multi-edge sibling without an index: unresolvable
    return None  # unknown kind: unresolvable


def _collect_datums(document):
    """The datumPlane registry for a document WITHOUT running a rebuild — datum
    planes are pure plane algebra over specs stored in the doc (no body
    geometry), so replaying just them mirrors what rebuild() registers. A datum
    that fails to resolve is skipped (its sketch already flags red at rebuild)."""
    datums = {}
    ctx = SimpleNamespace(datums=datums)
    for f in document.get("features", []):
        if f.get("type") == "datumPlane":
            try:
                _handle_datum_plane(f, ctx)
            except Exception:
                pass
    return datums


def project_geometry(document, plane_spec, sources):
    """The projectGeometry aux-op: resolve each source against the PREFIX document
    (the frontend truncates at the sketch's timeline position) and project the
    resolved edges onto the target plane. Resolution is STRICT — a missing body/
    sketch/entity, a zero-edge or low-confidence selector match all produce a
    per-source error entry (pick time wants a clear refusal; the lenient
    keep-last-shape path is the rebuild refresh handler's job). Read-only: the
    `readonly=True` below is what MAKES that true — this call builds a truncated
    timeline prefix beside the human's own editing, and without it the prefix
    became the cached document and cost the human's next rebuild 3.173 s instead
    of 0.121 s. Note the poisoning happened even when the pick itself FAILED, so
    the flag belongs on the call, not on the success path.

    Returns {"results": [{source_index, ok, curves: [{fp?, curve}], error?}]}
    — `fp` (a sidecar-authored edge fingerprint for a by:"match" selector) only
    for body-edge sources; sketch curves are tracked by stable ids."""
    _part, _errors, bodies = rebuild_cached(document, readonly=True)
    datums = _collect_datums(document)
    plane = _plane_of(plane_spec, datums)
    results = []
    for i, src in enumerate(sources):
        try:
            curves = _project_source(src, plane, document, bodies, datums)
            results.append({"source_index": i, "ok": True, "curves": curves})
        except Exception as ex:
            results.append({
                "source_index": i, "ok": False, "curves": [],
                "error": str(ex) or type(ex).__name__,
            })
    return {"results": results}


def _require_body(bodies, bid):
    """The prefix body `bid` with live shape, or the strict pick-time refusal."""
    body = next((b for b in bodies if b["id"] == bid), None)
    if body is None or body.get("shape") is None:
        raise ValueError(
            f'source body "{bid}" is not available here — '
            "it may have been created after this sketch"
        )
    return body


def _resolve_sketch_curve(features, src, datums, val):
    """Resolve a sketchCurve source against `features` to (source plane, local
    boundary edges). Raises with the strict pick-time messages on a missing
    sketch / entity or an entity with no curve; the lenient refresh path
    (_fresh_projection) catches any raise and treats it as a lost source."""
    sf = next(
        (f for f in features
         if f.get("type") == "sketch" and f.get("id") == src.get("sketch")),
        None,
    )
    if sf is None:
        raise ValueError(
            f'source sketch "{src.get("sketch")}" is not available here — '
            "it may have been created after this sketch"
        )
    ent = next(
        (e for e in sf.get("entities") or [] if e.get("id") == src.get("entity")),
        None,
    )
    if ent is None:
        raise ValueError("the source curve no longer exists in its sketch")
    eds = _entity_edges(ent, val)
    if not eds:
        raise ValueError(f'a "{ent.get("type")}" entity has no curve to project')
    return _plane_of(sf["plane"], datums), eds


def _project_source(src, plane, document, bodies, datums):
    """Resolve ONE projection source to its [{fp?, curve}] list, or raise with a
    user-facing message. Source kinds: edge / faceBoundary / sketchCurve /
    silhouette (whole-body HLR outline)."""
    kind = src.get("kind")
    if kind in ("edge", "faceBoundary"):
        body = _require_body(bodies, src.get("body"))
        shape = body["shape"]
        diag = []
        if kind == "edge":
            edges = resolve_edges(shape, src["sel"], diag=diag)
        else:
            seen = {}
            for fc in resolve_faces(shape, src["sel"], diag=diag):
                for e in fc.edges():
                    seen.setdefault(_edge_dedup_key(e), e)
            edges = list(seen.values())
        if not edges:
            raise ValueError("the source geometry no longer exists on the body")
        # LOSSY is the flag that means "this resolution took a best-effort or
        # marginal path" — every diagnostic assertion in the suite keys on it.
        # Refusing on a merely non-empty `diag` was equivalent once, but it also
        # swept up advisory entries and turned a perfectly good pick into a hard
        # failure (see the note in geom_select._nearest_one).
        lossy = next((d for d in diag if d.get("lossy")), None)
        if lossy is not None:
            raise ValueError(
                "the source selection is ambiguous on this body — "
                + (lossy.get("reason") or "low-confidence match")
            )
        return [
            {"fp": edge_fingerprint(e, shape), "curve": _project_edge_to_plane(e, plane)}
            for e in edges
        ]
    if kind == "sketchCurve":
        val = _make_val(document.get("parameters", {}))
        src_plane, eds = _resolve_sketch_curve(
            document.get("features", []), src, datums, val
        )
        return [{"curve": _project_edge_to_plane(src_plane * ed, plane)} for ed in eds]
    if kind == "silhouette":
        body = _require_body(bodies, src.get("body"))
        curves = _project_silhouette(body["shape"], plane)
        if not curves:
            raise ValueError("the body has no visible silhouette on this plane")
        # whole-body source: no per-curve fingerprints (refresh re-runs HLR and
        # re-matches by curve, see _recompute_projections)
        return [{"curve": c} for c in curves]
    raise ValueError(f"unknown projection source kind: {kind}")


# --- mass properties ---------------------------------------------------------


def _watertight(shape):
    """Is `shape` a closed volume — every face part of a shell, no free edges?

    OCCT's `ShapeAnalysis_Shell.HasFreeEdges()` reads state that CheckOrientedShells
    populates; called without it, it returns False for EVERYTHING. Measured: a box
    with one face removed reports HasFreeEdges False naively and True after the
    check, so writing this the obvious way makes every non-empty shape watertight,
    and the test that would catch it passes.

    Preferred over `BRep_Tool.IsClosed_s`, which reads a flag STORED on the shape.
    That flag can be stale on imported STEP, which is exactly the geometry someone
    asks this question about.
    """
    from OCP.ShapeAnalysis import ShapeAnalysis_Shell
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedMapOfShape

    w = shape.wrapped
    shells = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(w, TopAbs_SHELL, shells)
    if shells.Extent() == 0:
        return False

    sa = ShapeAnalysis_Shell()
    sa.LoadShells(w)
    sa.CheckOrientedShells(w, True, False)
    if sa.HasFreeEdges():
        return False

    # Every face must belong to some shell: a compound of one closed solid PLUS a
    # loose face has no free edges on the shell, yet is not a closed volume.
    # One IndexedMap filled from every shell, compared by count — it dedups on
    # IsSame, so this is linear. A list-membership version would be O(F^2) with an
    # OCP round trip per comparison.
    in_shells = TopTools_IndexedMapOfShape()
    for i in range(1, shells.Extent() + 1):
        TopExp.MapShapes_s(shells.FindKey(i), TopAbs_FACE, in_shells)
    all_faces = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(w, TopAbs_FACE, all_faces)
    return in_shells.Extent() == all_faces.Extent()


_BBOX_LIMIT = 1e99


def _publishable_bbox(bb):
    """Is this mesh box something we can hand to a caller as a measurement?

    Two ways it is not. `tessellate.mesh_bbox` returns None for a VOID box (a
    body with no triangulation), and OCCT hands back a box of +/-1e100 for a
    shape with unbounded geometry — seen on damaged STEP imports. 1e100 is the
    dangerous one: it reads as an ordinary number, so it silently drags
    total.bbox out to the edge of the universe. The None used to crash the
    union outright.
    """
    if not bb:
        return False
    try:
        vals = list(bb["min"]) + list(bb["max"])
    except (KeyError, TypeError, IndexError):
        return False
    return len(vals) == 6 and all(
        isinstance(v, (int, float)) and math.isfinite(v) and abs(v) < _BBOX_LIMIT
        for v in vals)


def _measure_one(body, checks, tick):
    """One body's mass properties, or a `measured: false` record saying why.

    Four gates run BEFORE anything touches .wrapped / volume / a bounding box,
    because each of those has a way of lying or throwing on a degenerate body:
      - build123d >=0.11 makes `.wrapped` a property that ASSERTS on an empty shape
      - an empty compound has a .wrapped, reports area 0.0, and yields a degenerate
        point-box AT THE ORIGIN, which would drag the document bbox to include
        (0,0,0); bbox_of's docstring records 8 such bodies in the reference assembly
      - a shell-only body has no volume to speak of, and integrating it as though it
        were closed produces a NEGATIVE mass and a meaningless centre
    A FIFTH gate runs after the integration, because it is the only place the
    condition is visible: see the comment on `vol == 0.0` below.
    An unmeasurable body carries NO numeric keys at all, rather than zeros: a zero
    volume and an absent volume mean different things, and a formatter downstream
    cannot tell them apart after the fact.
    """
    out = {"id": body["id"], "name": body.get("name")}
    shape = body.get("shape")
    if shape is None:
        return {**out, "measured": False, "reason": "feature failed"}
    s = _as_compound(shape)
    if _wrapped_or_none(s) is None:
        return {**out, "measured": False, "reason": "empty"}
    tick()
    if len(s.faces()) == 0:
        return {**out, "measured": False, "reason": "empty"}
    if len(s.solids()) == 0:
        # a surface body: an open shell, or a mesh import that never closed
        return {**out, "measured": False, "reason": "no solid"}

    # ONE GProp pass yields volume AND centre of mass; two build123d property
    # reads would run the integration twice. OnlyClosed=True (the third
    # positional) is REQUIRED: the 2-arg form integrates open shells as if closed,
    # measured at Mass -26.909 / COM.x 10.074 on a solid-plus-open-shell compound
    # whose right answer is 64.0 at x=50.0. Taking |V| of that would have turned a
    # nonsense figure into a confident positive one.
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(s.wrapped, props, True)
    c = props.CentreOfMass()
    vol = abs(props.Mass())
    tick()

    # The gates above ran BEFORE the integration and so cannot see this one. An
    # open shell wrapped in a TopoDS_SOLID passes `len(s.solids()) == 0` — it IS
    # a solid by topology — and then OnlyClosed=True makes it contribute NOTHING:
    # Mass() stays 0.0 and CentreOfMass() hands back its untouched reference
    # point, the origin. abs() launders that into a clean zero, which is how a
    # body shipped `measured: true, volume: 0.0, com: [0,0,0]` with a centre of
    # mass 36 mm OUTSIDE its own bounding box (Fenrir body2 — the box comes from
    # the triangulation, a different path, and was right all along).
    # A closed solid cannot enclose zero volume, so past those gates vol == 0.0
    # means no shell closed. Both values are already computed; this costs nothing
    # on a path where the measurement itself is 86 s on the reference assembly.
    if vol == 0.0:
        return {**out, "measured": False, "reason": "open shell"}

    # `Shape.area` recurses into nested compounds correctly (unlike .volume, which
    # sums one level and returns 0 on a nested one), so area stays on build123d.
    area = s.area
    tick()

    # Counts through build123d, NOT TopExp.MapShapes_s. MapShapes_s is ~45x faster
    # and INCLUDES degenerate edges, but resolve_edges/resolve_faces operate on
    # part.edges()/part.faces() — so a caller told a sphere has 3 edges when only 1
    # is addressable has been misled by its own measurement surface. Semantics wins
    # over speed here; `counting` rides on the reply so the choice is legible.
    counts = {"solids": len(s.solids()), "shells": len(s.shells()),
              "faces": len(s.faces()), "edges": len(s.edges()),
              "vertices": len(s.vertices())}
    tick()

    # The TRIANGULATION's box, not the exact one. bbox_of is OCCT AddOptimal_s at
    # 95.5 s over the reference assembly and its memo is cold here (its only
    # callers are the interference paths), while shape.bounding_box() additionally
    # calls BRepTools.Clean_s and DISCARDS the triangulation the viewport is about
    # to draw. The mesh box is conservative — never tighter than exact, verified —
    # which is the safe direction, and it makes total.bbox agree with the rebuild's
    # own bbox instead of disagreeing by a hair forever.
    import tessellate

    bb = tessellate.mesh_bbox(s)
    if not _publishable_bbox(bb):
        bb = None
    tick()

    rec = {**out, "measured": True, "volume": vol, "area": area,
           "com": [c.X(), c.Y(), c.Z()], "bbox": bb, "counts": counts}
    if checks:
        # is_valid returns True for an EMPTY shape, so it is only meaningful past
        # the gates above.
        rec["valid"] = bool(s.is_valid)
        tick()
        rec["watertight"] = _watertight(s)
        tick()
    return rec


def mass_properties(bodies, checks=False, tick=None):
    """Exact kernel mass properties per body, plus a document total.

    The app's Properties panel derives these from the DISPLAY TESSELLATION, which
    is exact on planar bodies and under-reports every curved one — measured at
    -0.970% on a cylinder r5 h20 and -1.433% on a sphere r10. This is the exact
    answer to the same question.

    `checks` gates validity and watertightness, which are far more expensive than
    everything else here (BRepCheck_Analyzer alone measured 72 s over the reference
    assembly's 3,060 leaves, against a derived ~86 s for all the cheap measures
    combined).

    `tick` is called between phases and per body. It is a PARAMETER rather than an
    import because the stall supervisor reaps on a heartbeat that STOPS MOVING, and
    every phase below is a per-body OCCT call that can run long on a large
    assembly. Unticked, this gets killed for being slow rather than for being stuck.
    """
    tick = tick or (lambda: None)
    out = []
    for b in bodies:
        tick()
        out.append(_measure_one(b, checks, tick))

    measured = [r for r in out if r["measured"]]
    total = {"bodies": len(measured), "volume": 0.0, "area": 0.0,
             "com": None, "bbox": None, "counts": {}}
    if measured:
        total["volume"] = sum(r["volume"] for r in measured)
        total["area"] = sum(r["area"] for r in measured)
        for k in ("solids", "shells", "faces", "edges", "vertices"):
            total["counts"][k] = sum(r["counts"][k] for r in measured)
        # Volume-weighted mean, which is what a centre of mass IS. An unweighted
        # mean of the per-body centres is a different quantity: on a sphere r10 at
        # the origin plus a sphere r5 at x=40 it gives 20.0 where the answer is
        # 40/9. Weight by |V| — an inverted solid reports a negative mass, but its
        # centroid is still its centroid.
        wsum = total["volume"]
        if wsum > 0.0:
            total["com"] = [
                sum(r["volume"] * r["com"][i] for r in measured) / wsum for i in range(3)
            ]
        # Union the per-body boxes rather than boxing the merged compound: one
        # bounding_box() over everything is a single UNTICKABLE OCCT walk, measured
        # at 95.3 s on the reference assembly against a 60 s stall budget, and it
        # was reaped every time. Four lines here, and no import from server.
        # Only over bodies that HAVE a publishable box: an unbounded or
        # untriangulated one is null, and including it would either crash on the
        # subscript or push the union to 1e100.
        boxed = [r for r in measured if r.get("bbox")]
        if boxed:
            lo = [min(r["bbox"]["min"][i] for r in boxed) for i in range(3)]
            hi = [max(r["bbox"]["max"][i] for r in boxed) for i in range(3)]
            total["bbox"] = {"min": lo, "max": hi}
    return {"bodies": out, "total": total}


# --- query -------------------------------------------------------------------

_QUERY_MAX_ITEMS = 64
_QUERY_MAX_LIMIT = 5000
# A TOTAL cap, not just a per-item one. Per-item caps MULTIPLY: 64 items at 5,000
# entities each is ~173 MiB, over the frame cap — and this op replies through the
# plain `ws.send` path, which has no outbound size guard at all. Blowing the cap
# closes the socket with 1009, which reaches the user as the app dying mid-op.
_QUERY_MAX_TOTAL = 5000
# `limit` bounds RECORDS, not scan, and the stall supervisor never reaps a job
# that keeps ticking — so a correctly-ticked query over a large assembly could
# hold the dispatch lock for minutes and be unkillable. This is the ceiling that
# actually stops it.
_QUERY_BUDGET_S = 20.0


# The strict gate for by:"match". Three SCALE-RELATIVE invariants, ORed — not a
# threshold on the resolver's cost, which was measured useless for this: over the
# frozen 220-case corpus, refusing above ACCEPT_MAX (2.5) would reject 79.4% of
# CORRECT resolutions, and the specification failures score BELOW the median
# correct answer (65.11 against a p50 of 22.74). cost measures drift, not
# correctness, which is why ACCEPT_MAX only ever set an advisory flag.
#
# Calibration over the corpus's 218 correct resolutions:
#   class mismatch     0/218          a plane does not become a cylinder under an edit
#   positional drift   max 0.541      of the part's own bbox diagonal
#   size ratio         max ~1.75
# The size rule is a CONJUNCTION — a big size change AND a centroid that moved —
# because size alone was measured wrong in both directions. Loose (50x) accepted
# the real wrong-body defect (28.18x at drift 0.308). Tight (10x alone) refused
# ordinary resizes that resolved PERFECTLY: area is a squared quantity, so 10x
# area is only 3.16x linear, and a rib growing 2mm -> 7mm tripped it at
# dist 1.9e-16 — the tool refusing an answer it was simultaneously certain of.
# Every false refusal measured had the centroid dead still; every true catch had
# it moved. Requiring both separates them with no overlap.
_MATCH_MAX_DRIFT = 2.0
_MATCH_MAX_SIZE_RATIO = 10.0
_MATCH_SIZE_NEEDS_DRIFT = 0.1


def _ratio(a, b):
    """max/min, the way to say "grossly different". _rel_err saturates at 1.0
    (measured 0.996 for a 250x mismatch) and so cannot express it at all."""
    if a is None or b is None:
        return None
    a, b = abs(float(a)), abs(float(b))
    lo, hi = min(a, b), max(a, b)
    if lo <= 1e-12:
        return math.inf if hi > 1e-12 else 1.0
    return hi / lo


def _judge_match(want, got, kind, diag_span, bbox_diag):
    """Is the entity `got` a plausible answer to the fingerprint `want`?

    Compares two fingerprints — the one asked for and the one re-authored from
    what came back — so it needs nothing from the resolver's internals and
    cannot perturb resolution. by:"match" is a nearest-neighbour search that
    always returns its best candidate; this is the check it never had.
    """
    m = {"judged": True}
    reasons = []

    wk, gk = ("surface", "surface") if kind == "face" else ("curve", "curve")
    if want.get(wk) and got.get(gk) and want[wk] != got[gk]:
        m["classMismatch"] = f"{want[wk]} != {got[gk]}"
        reasons.append(f"asked for a {want[wk]}, found a {got[gk]}")

    wc = want.get("centroid") if kind == "face" else want.get("mid")
    gc = got.get("centroid") if kind == "face" else got.get("mid")
    if wc and gc:
        d = math.dist(wc[:3], gc[:3])
        m["dist"] = d
        if bbox_diag and bbox_diag > 0:
            m["posRel"] = d / bbox_diag
            if m["posRel"] > _MATCH_MAX_DRIFT:
                reasons.append(
                    f"it sits {m['posRel']:.1f}x the part's own size away "
                    f"({d:.3f}mm)")

    sk = "area" if kind == "face" else "length"
    ratio = _ratio(want.get(sk), got.get(sk))
    if ratio is not None:
        m["sizeRatio"] = ratio
        moved = m.get("posRel")
        if ratio >= _MATCH_MAX_SIZE_RATIO and (moved is None
                                               or moved >= _MATCH_SIZE_NEEDS_DRIFT):
            reasons.append(f"its {sk} differs by {ratio:.0f}x and it moved")

    # A coin-flip is not a match. The resolver breaks a tie by canonical order
    # when no `nth` says which one is meant, and records it — the same shape as
    # an already-shipped wrong press/pull.
    for d in diag_span or ():
        if d.get("reason") == "tie; canonical-first":
            m["tied"] = True
            reasons.append("several candidates tied and nothing said which")

    if reasons:
        m["implausible"] = reasons
    return m


def _bbox_diag_of(shape):
    """The part's own diagonal, so the drift gate is SCALE-RELATIVE. An absolute
    millimetre gate is exactly what _nearest_one's docstring rules out: ordinary
    parametric motion moves a face far from its stored point while it remains the
    right face. Uses the mesh box (0.053 ms) rather than the exact one (44.84 ms,
    846x, and it discards the triangulation)."""
    try:
        import tessellate

        bb = tessellate.mesh_bbox(shape)
        if not _publishable_bbox(bb):
            return None
        return math.dist(bb["min"], bb["max"])
    except Exception:
        return None


def query_geometry(document, items, prefix=False, strict=True):
    """Resolve selectors and/or match predicates, returning storable references.

    Per-item containment, like project_geometry: one bad item never fails the
    call. Each result carries `count` (the TRUE pre-limit total, so
    count > len(entities) is itself the truncation signal) and a `sel` the caller
    can persist verbatim.

    Read-only in the sense that matters: it never mutates the document. It DOES
    populate the rebuild cache, because a caller issuing many queries against an
    unchanging model would otherwise pay a full rebuild on every one of them.
    Measured on the 356 MiB assembly: two consecutive queries with an empty cache
    took 45.23 s and 44.16 s, both logging `resume_from=0 src=full` — the first
    did not help the second. After one ordinary rebuild populated the cache the
    same query took 0.31 s, then 0.10 s, logging `src=RAM`. About 440x.

    Pass `prefix=True` when the document is a TRUNCATED timeline rather than the
    whole thing. Caching a prefix is what poisons the human's warm cache (see
    rebuild_cached's own docstring), and only the caller knows which it is
    holding — the sidecar receives a feature list either way and cannot tell.

    `strict` (ON by default) judges what a by:"match" selector resolved to and
    REFUSES an implausible answer with code matchImplausible, instead of handing
    back a confident wrong entity. That selector is a nearest-neighbour search
    that always returns its best candidate, so without this it cannot fail: a
    fingerprint for a 394 mm2 face, sent with the wrong body id, came back as a
    14 mm2 face 30 mm away with ok:true and expect:1 satisfied. Every result
    carries `match`, on success too, so the judgement is legible either way;
    `match: {judged: false}` means no identity was claimed (a where-only item, or
    by:"normal"/"axis"/"all", which return a SET with an honest count and have no
    single entity to be wrong about). `strict: false` restores the old bytes.
    """
    import time

    import errors as ERR
    from errors import GeomError
    from geom_select import (edge_fingerprint, face_fingerprint, query_entities,
                             resolve_edges, resolve_faces)

    if not isinstance(items, list):
        raise GeomError("query: items must be a list", ERR.BAD_REQUEST)
    if len(items) > _QUERY_MAX_ITEMS:
        raise GeomError(f"query: at most {_QUERY_MAX_ITEMS} items per request", ERR.BAD_REQUEST)

    _part, _errors, bodies = rebuild_cached(document, readonly=prefix)
    live = [b for b in bodies if b.get("shape") is not None]
    by_id = {b["id"]: b for b in live}

    t0 = time.monotonic()
    budget_left = [_QUERY_MAX_TOTAL]
    results = []
    for i, item in enumerate(items):
        rec = {"index": i, "id": item.get("id"), "ok": False,
               "count": 0, "entities": [], "diagnostics": []}
        # Bound BEFORE the try, and copied out again in the except. A refusal
        # from the resolver (an ambiguous by:"nearest" pick) raises AFTER
        # _push_diag has written its candidateFps repair payload, so assigning
        # diagnostics only on the success path threw away the one thing that
        # lets the caller repair the selector it just asked about.
        diag = []
        try:
            if time.monotonic() - t0 > _QUERY_BUDGET_S:
                rec["error"] = "the query ran out of its time budget"
                rec["code"] = ERR.BUDGET_EXHAUSTED
                results.append(rec)
                continue

            kind = item.get("kind")
            if kind not in ("face", "edge"):
                raise GeomError('query: kind must be "face" or "edge"', ERR.BAD_REQUEST)
            limit = int(item.get("limit") or 200)
            if limit < 1 or limit > _QUERY_MAX_LIMIT:
                raise GeomError(f"query: limit must be 1..{_QUERY_MAX_LIMIT}", ERR.BAD_REQUEST)

            body = _require_body(bodies, item["body"]) if item.get("body") else None
            if body is None:
                if len(live) != 1:
                    raise GeomError(
                        f"query: this document has {len(live)} bodies — name one in `body`",
                        ERR.BAD_REQUEST)
                body = live[0]
            shape = body["shape"]

            cands = None
            if item.get("sel") is not None:
                # sel BEFORE where, always. Resolving first and filtering after is
                # not just an ordering preference: the resolver's concentric-rank
                # scoring is computed over the candidate set it is given, so
                # pre-filtering the edges would change a rim's group size and
                # silently drop the match to the scale-stale absolute radius.
                resolve = resolve_faces if kind == "face" else resolve_edges
                cands = resolve(shape, item["sel"], diag=diag, feature_id=item.get("id"))

            # Judge the RESOLUTION, before `where` can filter the result away: a
            # caller whose stored reference now points at the wrong entity needs
            # to hear that, not "nothing matched".
            sel = item.get("sel")
            fp_of = face_fingerprint if kind == "face" else edge_fingerprint
            match = {"judged": False}
            # by:"ofFace" and by:"tangentChain" claim an identity too — with an
            # INNER fingerprint (the face whose edges are wanted, the seed edge of
            # the chain). Judging only by:"match" left the gate one field name
            # from off: a fingerprint refused standalone sailed through ofFace and
            # reported judged:false, which the schema defines as "no identity was
            # claimed". Resolve that inner reference and judge it the same way.
            inner = None
            if isinstance(sel, dict):
                if sel.get("by") == "ofFace":
                    inner = ("face", sel.get("face"))
                elif sel.get("by") == "tangentChain":
                    inner = ("edge", sel.get("seed"))

            if (isinstance(sel, dict) and sel.get("by") == "match"
                    and isinstance(sel.get("fp"), dict) and cands):
                got = fp_of(cands[0], shape)
                match = _judge_match(sel["fp"], got, kind, diag,
                                     _bbox_diag_of(shape))
            elif inner and isinstance(inner[1], dict):
                ikind, ifp = inner
                iresolve = resolve_faces if ikind == "face" else resolve_edges
                ifp_of = face_fingerprint if ikind == "face" else edge_fingerprint
                idiag = []
                ihit = iresolve(shape, {"kind": ikind, "by": "match", "fp": ifp},
                                diag=idiag, feature_id=item.get("id"))
                if ihit:
                    match = _judge_match(ifp, ifp_of(ihit[0], shape), ikind, idiag,
                                         _bbox_diag_of(shape))
                    match["via"] = sel["by"]

            if strict and match.get("implausible"):
                rec["match"] = match
                rec["diagnostics"] = diag
                rec["error"] = (
                    "the stored reference does not plausibly identify what it "
                    "resolved to: " + "; ".join(match["implausible"]))
                rec["code"] = ERR.MATCH_IMPLAUSIBLE
                # what it WOULD have handed back, so the caller can re-pick or
                # confirm — the repair role candidateFps plays on the
                # ambiguous-nearest path. On a TIE this is only the winner; the
                # losing candidates are not enumerable here (see PROTOCOL).
                if match.get("via") is None and cands:
                    rec["candidateFps"] = [{"fp": fp_of(cands[0], shape)}]
                results.append(rec)
                continue

            # A lossy match is passed THROUGH with its diagnostic rather than
            # refused. project_geometry refuses because it is authoring a
            # persistent reference at pick time; query is read-only inspection,
            # and "this reference went ambiguous, show me what it could mean" is
            # one of the things it is for.
            hits = query_entities(shape, kind, item.get("where"), cands,
                                  owners=body.get("owners"), tick=progress_tick)

            rec["count"] = len(hits)
            rec["match"] = match
            rec["diagnostics"] = diag
            take = min(limit, budget_left[0])
            ents = []
            for e in hits[:take]:
                fp = fp_of(e, shape)
                ent = {"body": body["id"],
                       "sel": {"kind": kind, "by": "match", "fp": fp}}
                if kind == "face":
                    # last-modifier, not creator — documented on the wire
                    owners = body.get("owners") or {}
                    from geom_select import _owner_key

                    ent["createdBy"] = owners.get(_owner_key(e))
                ents.append(ent)
            budget_left[0] -= len(ents)
            rec["entities"] = ents

            expect = item.get("expect")
            if isinstance(expect, dict):
                # The object form: the CALLER supplies the discriminator, which
                # is the only assertion here that no calibration of mine can get
                # wrong. `count` is judged as before; every other key is a `where`
                # predicate that EVERY hit must satisfy — so "exactly one face,
                # and it is the ~400 mm2 one" becomes expressible. `expect: 1`
                # alone cannot say that: by:"match" always resolves exactly one,
                # so it asserts cardinality and is silent about identity.
                want_n = expect.get("count")
                cond = {k: v for k, v in expect.items() if k != "count"}
                if want_n is not None and want_n != rec["count"]:
                    rec["error"] = (f"expected exactly {want_n} {kind}s, "
                                    f"matched {rec['count']}")
                    rec["code"] = ERR.EXPECT_FAILED
                    results.append(rec)
                    continue
                if cond:
                    kept = query_entities(shape, kind, cond, hits[:take],
                                          owners=body.get("owners"),
                                          tick=progress_tick)
                    if len(kept) != len(hits[:take]):
                        bad = len(hits[:take]) - len(kept)
                        rec["error"] = (
                            f"{bad} of {len(hits[:take])} {kind}s failed "
                            f"{json.dumps(cond, sort_keys=True)}")
                        rec["code"] = ERR.EXPECT_FAILED
                        results.append(rec)
                        continue
            elif isinstance(expect, int) and expect != rec["count"]:
                # judged on count, not on the truncated list: a caller that sets
                # `expect` is asserting, and an assertion should be branchable.
                rec["error"] = (f"expected exactly {expect} {kind}s, matched {rec['count']}")
                rec["code"] = ERR.EXPECT_FAILED
                results.append(rec)
                continue
            rec["ok"] = True
        except Exception as ex:
            rec["error"] = str(ex) or type(ex).__name__
            rec["diagnostics"] = diag
            # Default to badRequest rather than shipping prose with no code. Only
            # GeomError carries one, so every Python-native exception raised by a
            # malformed item — `sel: "all"` reaching sel.get("by"), a non-numeric
            # limit, a missing `body` key — arrived uncoded and unbranchable. The
            # job level already defaults this way (server._error_from).
            rec["code"] = ERR.code_of(ex, ERR.BAD_REQUEST)
        results.append(rec)
    return {"results": results}
