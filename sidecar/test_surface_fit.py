"""Surface fitting on mesh import: a faceted hole becomes ONE cylindrical face.

GH #49. A mesh import used to end in a body whose every face was a Plane, so a
3 mm bore was 63 flat strips: unpickable as a hole, unqueryable by radius, and
denting rather than moving when pressed. `builder._fit_surfaces` recognises
cylinders, and the cones, spheres and tori that share an axis with one (planes
already come out of UnifySameDomain), and rebuilds each recognised region as one
analytic face bounded by the region's OWN existing edges, so the sew has nothing
to bridge and every unrecognised face survives verbatim.

WHY VOLUME IS NOT THE ORACLE HERE. Today's faceted import is already valid,
watertight, one solid, and its volume is within 0.02% of the source. Every one
of those is green BEFORE the fix, which is why they appear below as necessary
conditions and never as evidence. The oracle is the SURFACE-TYPE CENSUS
(A1: GeomAbs_Cylinder must appear at all) plus the behaviour of the
direct-modelling ops: press/pull the bore wall and the volume must land on the
ANALYTIC answer (A8), not on a faceted approximation of it.

THE TEST THAT ACTUALLY PINS THE HARD PART is A13, not A1. A through bore's two
rim loops make the face-orientation choice for you, so it builds correctly even
with the orientation handling removed. A CONVEX fillet quadrant does not: judge
2 measured one coming back from MakeFace at -47.1239 against a +47.1050 mesh
region, and `Reversed()` on the face does not change that sign. A13 builds all
four quadrants of a filleted box and reads every area.

Every fixture is regenerated with build123d into a fresh temp dir; nothing here
reads a file from outside the repo.

Run:  uv run python test_surface_fit.py
"""

import math
import os
import sys
import tempfile
from collections import Counter

import occt_smp

occt_smp.configure()

import builder  # noqa: E402
from builder import import_geometry, rebuild  # noqa: E402

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

# The plan's fixture P: a 40x40x10 plate with a 3 mm-radius through bore.
PLATE_VOLUME = 15717.2567          # exact, from the B-rep source
BORE_R = 3.0
ANG_TOLS = (0.2, 0.5)              # every fixture is exercised at both


def _census(shape):
    """{surface type name: count} over a shape's faces, read from the ADAPTOR.

    Never from `Face.radius` or the raw `BRep_Tool.Surface_s` class:
    `ShapeFix_Face` wraps a fitted through-bore in a
    `Geom_RectangularTrimmedSurface`, and judge 2 measured `Face.radius`
    returning None on a face whose `BRepAdaptor_Surface` reports Cylinder with
    the right radius. The adaptor reads through the trim; nothing else does."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    c = Counter()
    for f in shape.faces():
        c[str(BRepAdaptor_Surface(f.wrapped).GetType()).split("_")[-1]] += 1
    return dict(c)


def _cylinder_faces(shape):
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType

    return [f for f in shape.faces()
            if BRepAdaptor_Surface(f.wrapped).GetType()
            == GeomAbs_SurfaceType.GeomAbs_Cylinder]


def _cyl_radius(face):
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    return BRepAdaptor_Surface(face.wrapped).Cylinder().Radius()


def _cyl_axis(face):
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    ax = BRepAdaptor_Surface(face.wrapped).Cylinder().Axis()
    loc, dr = ax.Location(), ax.Direction()
    return (loc.X(), loc.Y(), loc.Z()), (dr.X(), dr.Y(), dr.Z())


def _surface(face):
    """(type name, parameters) of a face's surface, read through the ADAPTOR:
    radius for a cylinder or sphere, (semi-angle in degrees, reference radius)
    for a cone, (major, minor) for a torus, plus the axis or centre."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType as ST

    ad = BRepAdaptor_Surface(face.wrapped)
    t = ad.GetType()

    def _xyz(p):
        return (p.X(), p.Y(), p.Z())

    if t == ST.GeomAbs_Cylinder:
        c = ad.Cylinder()
        return "Cylinder", (c.Radius(), _xyz(c.Axis().Location()), _xyz(c.Axis().Direction()))
    if t == ST.GeomAbs_Cone:
        c = ad.Cone()
        return "Cone", (math.degrees(c.SemiAngle()), c.RefRadius(),
                        _xyz(c.Axis().Location()), _xyz(c.Axis().Direction()))
    if t == ST.GeomAbs_Sphere:
        c = ad.Sphere()
        return "Sphere", (c.Radius(), _xyz(c.Location()))
    if t == ST.GeomAbs_Torus:
        c = ad.Torus()
        return "Torus", (c.MajorRadius(), c.MinorRadius(), _xyz(c.Axis().Location()),
                         _xyz(c.Axis().Direction()))
    return str(t).split("_")[-1], ()


def _signed_area(face):
    """The SIGNED surface integral. `Face.area` is this number and it CAN be
    negative — that is the whole failure mode A13 exists to catch."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face.wrapped, props)
    return props.Mass()


def _free_edge_count(shape):
    """Edges with exactly one adjacent face. A closed solid has none; this is
    what "watertight" means topologically, and unlike `.volume` it cannot be
    faked by a shell that merely looks closed.

    The one exception is the point-sized edge at the pole of a sphere face that
    contains its pole (a dome, a capsule's end): that is how OCCT bounds such a
    face, and it has nothing on its other side because there is no other side.
    Anywhere else a degenerated edge is counted, because there it is a gap a
    repair closed."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType as ST
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopoDS import TopoDS
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

    emap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape.wrapped, TopAbs_EDGE, TopAbs_FACE, emap)
    n = 0
    for i in range(1, emap.Extent() + 1):
        faces = emap.FindFromIndex(i)
        if faces.Extent() >= 2:
            continue
        if (BRep_Tool.Degenerated_s(TopoDS.Edge_s(emap.FindKey(i))) and faces.Extent() == 1
                and BRepAdaptor_Surface(TopoDS.Face_s(faces.First())).GetType()
                == ST.GeomAbs_Sphere):
            continue
        n += 1
    return n


def _max_edge_tolerance(shape):
    from OCP.BRep import BRep_Tool
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    out = 0.0
    ex = TopExp_Explorer(shape.wrapped, TopAbs_EDGE)
    while ex.More():
        out = max(out, BRep_Tool.Tolerance_s(TopoDS.Edge_s(ex.Current())))
        ex.Next()
    return out


def _is_valid(shape):
    from OCP.BRepCheck import BRepCheck_Analyzer

    return BRepCheck_Analyzer(shape.wrapped).IsValid()


def _unified(path):
    """The shape as it reaches `_fit_surfaces`: read + sewn + UnifySameDomain,
    with the mesh vertices still exactly on the surfaces they came from."""
    from build123d import Compound, Mesher

    shapes = Mesher().read(path)
    raw = shapes[0] if len(shapes) == 1 else Compound(list(shapes))
    return builder._unify_if_valid(raw)


def _plate_stl(d, angular_tolerance=0.2, tag=""):
    from build123d import Box, Cylinder, export_stl

    src = Box(40, 40, 10) - Cylinder(BORE_R, 20)
    p = os.path.join(d, f"plate{tag}.stl")
    export_stl(src, p, tolerance=0.05, angular_tolerance=angular_tolerance)
    return p, src


def _stl_of(src, d, name, angular_tolerance=0.2):
    from build123d import export_stl

    p = os.path.join(d, f"{name}.stl")
    export_stl(src, p, tolerance=0.05, angular_tolerance=angular_tolerance)
    return p


def _staircase_box():
    """Two boxes fused 0.05 mm out of line — every side wall is a two-plane
    staircase the exact-coplanar unify cannot merge. This is `_refacet_clean`'s
    own fixture (test_smoke.test_refacet_clean), reused deliberately: the fitter
    must leave it entirely alone."""
    from build123d import Box, Pos

    return Box(20, 20, 10) + Pos(0.05, 0, 9.95) * Box(20, 20, 10)


def _import_body(path, fmt="stl"):
    """Import through the REAL feature path, so the test sees what a user gets."""
    payload = import_geometry(path, fmt)
    doc = {"parameters": {}, "features": [
        {"id": "im", "type": "import", "format": fmt, "name": "m",
         "geom": payload["geom"]}]}
    part, errors, bodies = rebuild(doc)
    assert not errors, errors
    return part, bodies, payload


def _import_with_fit_disabled(path, fmt="stl"):
    """The control: today's import, byte for byte. `_fit_surfaces` stubbed to
    the identity is exactly the pre-#49 pipeline, because the call site branches
    on `fitted is shape`."""
    keep = builder._fit_surfaces
    builder._fit_surfaces = lambda shape, debug=False, report=None, **_kw: shape
    try:
        return _import_body(path, fmt)
    finally:
        builder._fit_surfaces = keep


def _bore_facet_angle(path, radius=BORE_R):
    """The tessellator's angular step around the bore, MEASURED off the mesh.

    Every mesh vertex on a bore wall lies exactly on the true cylinder, so the
    distinct polar angles of the vertices at r == `radius` are the facet
    boundaries and 2*pi/N is the dihedral between neighbouring facets. Deriving
    it from the requested `angular_tolerance` instead would be assuming what the
    tessellator did rather than reading it."""
    angs = set()
    for v in _unified(path).vertices():
        if abs(math.hypot(v.X, v.Y) - radius) < 1e-6:
            angs.add(round(math.atan2(v.Y, v.X), 6))
    assert angs, "no bore vertices found — the fixture is not what this expects"
    return 2.0 * math.pi / len(angs)


# --------------------------------------------------------------------------
# A1 / A3 / A4 / A6 / A11 / A12: the plate, the case every number is quoted for
# --------------------------------------------------------------------------

def test_a1_census():
    """A1: the plate imports as 7 faces, six planes and ONE cylinder.

    Today: 23 faces, all Plane. This is the whole point of the feature and the
    only assertion in the suite that a faceted body cannot satisfy."""
    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        path, _src = _plate_stl(d, at)
        part, _bodies, _payload = _import_body(path)
        cen = _census(part)
        nf = len(part.faces())
        print(f"  A1 angular_tolerance={at}: {nf} faces {cen}")
        assert cen.get("Cylinder", 0) == 1, (
            f"angular_tolerance={at}: the bore must be ONE cylindrical face, "
            f"got {cen} over {nf} faces")
        assert nf == 7, f"angular_tolerance={at}: want 7 faces, got {nf} {cen}"
        assert cen.get("Plane", 0) == 6, f"want 6 planes, got {cen}"
    print("  A1 OK: 7 faces {Plane: 6, Cylinder: 1} at both tessellations")


def test_a3_volume_beats_the_faceted_import():
    """A3: the fitted volume is within 0.05% of the exact 15717.2567 AND closer
    to it than the faceted import is.

    The second half is the load-bearing one. "Within 0.05%" is satisfied by the
    faceted body too (it is off by 0.018%), so on its own it would pass with the
    fitter deleted. A chord always cuts inside the arc, so the faceted bore is
    systematically too WIDE and the body too light; recovering the arc has to
    move the volume back toward the truth, not merely keep it close."""
    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        path, _src = _plate_stl(d, at)
        fitted, _b, _p = _import_body(path)
        faceted, _b2, _p2 = _import_with_fit_disabled(path)
        e_fit = (fitted.volume - PLATE_VOLUME) / PLATE_VOLUME
        e_fac = (faceted.volume - PLATE_VOLUME) / PLATE_VOLUME
        print(f"  A3 angular_tolerance={at}: fitted {fitted.volume:.4f} "
              f"({100 * e_fit:+.4f}%) vs faceted {faceted.volume:.4f} "
              f"({100 * e_fac:+.4f}%)")
        assert abs(e_fit) < 5e-4, f"fitted volume off by {100 * e_fit:+.4f}%"
        assert abs(e_fit) < abs(e_fac), (
            f"fitting made the volume WORSE: {100 * e_fit:+.4f}% vs the faceted "
            f"import's {100 * e_fac:+.4f}%")
    print("  A3 OK: fitted volume beats the faceted import at both tessellations")


def test_a4_still_a_closed_valid_solid():
    """A4: valid, one solid, one shell, zero free edges.

    NOT evidence that fitting worked — the faceted import passes all four
    already. It is the floor: a body that fails any of these is worse than what
    it replaced, whatever its face census says."""
    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        path, _src = _plate_stl(d, at)
        part, _b, _p = _import_body(path)
        free = _free_edge_count(part)
        print(f"  A4 angular_tolerance={at}: valid={_is_valid(part)} "
              f"solids={len(part.solids())} shells={len(part.shells())} "
              f"free_edges={free}")
        assert _is_valid(part), "the fitted body is not BRepCheck-valid"
        assert len(part.solids()) == 1, f"want 1 solid, got {len(part.solids())}"
        assert len(part.shells()) == 1, f"want 1 shell, got {len(part.shells())}"
        assert free == 0, f"want 0 free edges, got {free}"
    print("  A4 OK: valid, 1 solid, 1 shell, 0 free edges at both tessellations")


def test_a6_radius_and_residual():
    """A6: R = 3.0 within 1e-4 and the fit residual under 1e-5.

    Two independent readings, because they can fail apart: the RADIUS is what
    the rest of the app queries and dimensions off, while the RESIDUAL says the
    mesh really was a cylinder rather than something a least-squares fit was
    willing to call one."""
    import numpy as np

    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        path, _src = _plate_stl(d, at)
        part, _b, _p = _import_body(path)
        cyl = _cylinder_faces(part)
        assert len(cyl) == 1, f"want one cylinder face, got {len(cyl)}"
        r = _cyl_radius(cyl[0])

        # the residual, read off the bore's OWN mesh vertices rather than off
        # anything the fitter produced
        pts = np.array([(v.X, v.Y, v.Z) for v in _unified(path).vertices()
                        if abs(math.hypot(v.X, v.Y) - BORE_R) < 0.05])
        fit = builder._fit_cylinder(pts, (0.0, 0.0, 1.0))
        assert fit is not None, "the Kasa fit refused the bore's own vertices"
        _c, _a, r_fit, resid = fit
        print(f"  A6 angular_tolerance={at}: face R={r:.7f} refit R={r_fit:.7f} "
              f"residual={resid:.3e}")
        assert abs(r - BORE_R) < 1e-4, f"radius {r:.7f}, want 3.0 +/- 1e-4"
        assert abs(r_fit - BORE_R) < 1e-4, f"refit radius {r_fit:.7f}"
        assert resid < 1e-5, f"fit residual {resid:.3e}, want < 1e-5"
    print("  A6 OK: R = 3.0 to 1e-4, residual under 1e-5")


def test_fit_cylinder_is_a_cylinder_fitter_and_nothing_else():
    """The Kasa fit on its own: it must recover a cylinder in a general pose,
    and flat input must be refused by the RESIDUAL rather than pass quietly.

    Measured, and worth knowing before tuning anything: on coplanar or collinear
    input the Kasa system is rank-deficient, `lstsq` returns its minimum-norm
    answer, and that answer is a SMALL, entirely plausible-looking radius —
    R = 6.67 for a flat 20x20 wall, R = 6.12 for a 0.05 mm staircase pair. No
    size screen can catch those. What catches them is that the residual comes
    back the same order as R (6.67 and 6.10), against a tolerance the caller
    caps at 0.06*R.

    That is the whole reason the plan forbids deriving the tolerance from
    triangle EDGE LENGTH: on this fixture that would be ~10 mm, the residual of
    6.67 would sit comfortably inside it, and every flat wall in every import
    would come back curved."""
    import numpy as np

    axis = np.array((1.0, 2.0, 3.0))
    axis = axis / np.linalg.norm(axis)
    e1 = np.cross(axis, (0.0, 0.0, 1.0))
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(axis, e1)
    base = np.array((5.0, -2.0, 7.0))
    r_true = 4.25
    pts = np.array([
        base + t * axis + r_true * (math.cos(u) * e1 + math.sin(u) * e2)
        for t in (-3.0, 0.0, 2.5)
        for u in np.linspace(0.0, 1.2, 9)      # a 69-degree arc, not a full ring
    ])
    got = builder._fit_cylinder(pts, axis)
    assert got is not None
    ctr, unit_ax, radius, resid = got
    # the axis point is the foot nearest the origin, so compare the axis LINE
    off = (base - ctr) - float((base - ctr) @ unit_ax) * unit_ax
    print(f"  fit_cylinder: R={radius:.9f} (true {r_true}) residual={resid:.3e} "
          f"axis offset={float(np.linalg.norm(off)):.3e}")
    assert abs(radius - r_true) < 1e-9, f"R={radius!r}"
    assert resid < 1e-9
    assert float(np.linalg.norm(off)) < 1e-9

    flat = np.array([(x, y, 0.0) for x in np.linspace(-10, 10, 7)
                     for y in np.linspace(-10, 10, 7)])
    stair = np.vstack((
        np.array([(0.0, y, z) for y in np.linspace(-10, 10, 5)
                  for z in np.linspace(0, 10, 5)]),
        np.array([(0.05, y, z) for y in np.linspace(-10, 10, 5)
                  for z in np.linspace(10, 20, 5)])))
    n2 = np.array((1.0, 0.0, 0.005))
    for label, data, ax in (("flat wall", flat, (0.0, 1.0, 0.0)),
                            ("staircase pair", stair,
                             np.cross((1.0, 0.0, 0.0), n2 / np.linalg.norm(n2)))):
        got = builder._fit_cylinder(data, ax)
        assert got is not None, f"{label}: expected a (bogus) fit, not a refusal"
        _c, _a, r_bad, resid_bad = got
        cap = 0.06 * r_bad          # the caller's own upper bound on pos_tol
        print(f"  fit_cylinder on a {label}: R={r_bad:.4f} residual={resid_bad:.4f} "
              f"vs the caller's tolerance cap {cap:.4f}")
        assert resid_bad > cap, (
            f"{label}: residual {resid_bad:.4f} is inside the tolerance cap "
            f"{cap:.4f}, so flat geometry would be accepted as a cylinder")
    print("  fit-cylinder unit OK")


def test_a11_unify_after_fitting_changes_nothing():
    """A11: UnifySameDomain over the fitted body keeps it valid and keeps the
    face count. It runs on every import (and inside `_explode_solids`), and it
    SEGFAULTS on an invalid solid rather than raising, so "fitting produced
    something UnifySameDomain survives" is a safety property, not cosmetics."""
    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        path, _src = _plate_stl(d, at)
        part, _b, _p = _import_body(path)
        before = len(part.faces())
        merged = builder._unify_if_valid(part)
        print(f"  A11 angular_tolerance={at}: {before} -> {len(merged.faces())} "
              f"faces, valid={_is_valid(merged)} {_census(merged)}")
        assert len(merged.faces()) == before, (
            f"unify changed the face count {before} -> {len(merged.faces())}")
        assert _is_valid(merged), "unify left an invalid solid"
        assert _census(merged).get("Cylinder", 0) == 1, _census(merged)
    print("  A11 OK: unify after fitting is a no-op that stays valid")


def test_a12_edge_tolerance_stays_sagitta_sized():
    """A12: the largest edge tolerance is at most 1.1 * the sagitta R(1-cos(t/2)).

    A fitted face bounded by the mesh's own chord polyline has a boundary that
    does not lie on the analytic surface — it lies inside it by one sagitta.
    OCCT absorbs that as EDGE TOLERANCE, and a tolerance that grew past the
    sagitta would mean the sew had papered over something else. `t` is measured
    off the mesh, not taken from the tessellation request.

    TWO bodies, because A15 changed what this measures on the plate. Once a rim
    is one `Geom_Circle` the boundary is exactly on the cylinder and the plate's
    tolerance collapses to 1.0e-05 against an allowance of 4.1e-03 — true, and
    no longer a test of anything. The FILLETED BOX still carries chord
    boundaries (a quarter cylinder's ends are chord runs in the top and bottom
    planes, not a closed circle), so the ceiling stays load-bearing there."""
    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        path, _src = _plate_stl(d, at)
        part, _b, _p = _import_body(path)
        theta = _bore_facet_angle(path)
        sagitta = BORE_R * (1.0 - math.cos(theta / 2.0))
        got = _max_edge_tolerance(part)
        print(f"  A12 plate angular_tolerance={at}: facet angle "
              f"{math.degrees(theta):.3f} deg, sagitta {sagitta:.3e}, max edge "
              f"tol {got:.3e} (allow {1.1 * sagitta:.3e})")
        assert got <= 1.1 * sagitta, (
            f"max edge tolerance {got:.3e} over 1.1 * sagitta {1.1 * sagitta:.3e}")

    from build123d import Axis, Box, fillet

    r = 1.0
    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        src = fillet(Box(40, 40, 10).edges().filter_by(Axis.Z), r)
        path = _stl_of(src, d, f"fil12_{at}", at)
        part, _b, _p = _import_body(path)
        assert len(_cylinder_faces(part)) == 4, "precondition: the fillets fitted"
        # the fillet's own facet angle, read off the mesh the same way: the
        # quadrant spans 90 degrees, so the step is that over the facet count.
        rows = len([f for f in _unified(path).faces()
                    if abs(math.hypot(f.center().X - 19.0,
                                      f.center().Y - 19.0) - r) < 0.2
                    and f.center().X > 19.0 - 1e-3 and f.center().Y > 19.0 - 1e-3])
        theta = (math.pi / 2.0) / rows
        sagitta = r * (1.0 - math.cos(theta / 2.0))
        got = _max_edge_tolerance(part)
        print(f"  A12 filleted box angular_tolerance={at}: {rows} facets per "
              f"quadrant, facet angle {math.degrees(theta):.3f} deg, sagitta "
              f"{sagitta:.3e}, max edge tol {got:.3e} (allow {1.1 * sagitta:.3e})")
        assert got <= 1.1 * sagitta, (
            f"max edge tolerance {got:.3e} over 1.1 * sagitta {1.1 * sagitta:.3e}")
    print("  A12 OK: edge tolerance stays sagitta-sized")


def test_a15_the_rim_is_one_circle():
    """A15: the bore's two rims are ONE `Geom_Circle` edge each, and a rim fillet
    lands on the analytic 15712.9103.

    A fitted cylindrical face bounded by the mesh's own chord polyline is only
    half a hole. The face answers a radius query, but the RIM is still 63 short
    line segments, so there is no edge to dimension, no edge to fillet, and
    `by:"nearest"` on the rim picks one chord out of 63. Today the plate imports
    with 0 circle edges and ~138 lines.

    15712.9103 is Pappus on the corner the fillet removes, not a number read off
    a run: the removed cross-section is a 1x1 corner minus a quarter disc
    (area 0.2146) whose centroid sits at x = 3.2233, so 2*pi*3.2233*0.2146 =
    4.3466 comes off the exact 15717.2567. A fillet that took one chord instead
    of the rim would remove about a sixtieth of that and still return green —
    measured, today's answer is 15736.5878 with no error at all.

    A rim is only upgraded when the face on the OTHER side of it can take the
    same circle edge. Letting the sewer bridge chords to a circle instead was
    measured and does not work: the gap is one sagitta (3.7e-3 mm) against a
    1e-3 sewing tolerance, and the plate came back with 129 free edges."""
    from geom_select import query_entities

    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        path, _src = _plate_stl(d, at)
        part, _b, _p = _import_body(path)
        circles = query_entities(part, "edge", {"curve": "circle"})
        lines = query_entities(part, "edge", {"curve": "line"})
        print(f"  A15 angular_tolerance={at}: {len(part.edges())} edges, "
              f"{len(circles)} circle(s), {len(lines)} line(s)")
        assert len(circles) == 2, (
            f"the bore's two rims must be one circle edge each, got "
            f"{len(circles)} circles and {len(lines)} lines over "
            f"{len(part.edges())} edges")
        for e in circles:
            got_r = e.radius
            assert abs(got_r - BORE_R) < 1e-4, f"rim radius {got_r:.7f}"
        # the two rims are the two ends of the same bore, not one rim twice
        zs = sorted(round(e.center().Z, 4) for e in circles)
        assert zs == [-5.0, 5.0], f"rim heights {zs}, want the two plate faces"

    d = tempfile.mkdtemp()
    path, _src = _plate_stl(d, 0.2)
    payload = import_geometry(path, "stl")
    doc = {"parameters": {}, "features": [
        {"id": "im", "type": "import", "format": "stl", "name": "m",
         "geom": payload["geom"]},
        {"id": "fl", "type": "fillet", "radius": 1.0,
         "edges": {"kind": "edge", "by": "nearest",
                   "point": [-BORE_R, 0.0, 5.0]}}]}
    part, errors, _bodies = rebuild(doc)
    assert not errors, errors
    print(f"  A15 rim fillet r=1: vol {part.volume:.4f} "
          f"({len(part.faces())} faces {_census(part)})")
    assert abs(part.volume - 15712.9103) < 0.5, (
        f"a fillet on the rim gave {part.volume:.4f}, want 15712.9103 — "
        f"a fillet that only caught one chord lands near 15717.2")
    assert _is_valid(part) and len(part.solids()) == 1
    # the fixture picks the rim, never the seam: the seam's midpoint is at
    # (3, 0, 0) and its ends are (3, 0, +/-5), so a pick at (-3, 0, 5) is
    # unambiguous on the far side.

    # ...two bores means ONE cap face carrying two rims. Rebuilding that face
    # once per rim would throw the first circle away and leave a free edge, so
    # this is not just "more of the same".
    from build123d import Box, Cylinder, Pos

    d = tempfile.mkdtemp()
    src = (Box(40, 40, 10)
           - Pos(-10, 0, 0) * Cylinder(3.0, 20)
           - Pos(10, 0, 0) * Cylinder(5.0, 20))
    part, _b, _p = _import_body(_stl_of(src, d, "two_rims"))
    circles = query_entities(part, "edge", {"curve": "circle"})
    radii = sorted(round(e.radius, 4) for e in circles)
    print(f"  A15 two bores: {len(part.faces())} faces, {len(circles)} circles "
          f"{radii}, vol {part.volume:.4f} (exact {src.volume:.4f})")
    assert radii == [3.0, 3.0, 5.0, 5.0], radii
    assert _free_edge_count(part) == 0 and _is_valid(part)

    # ...and the fallback. If the face on the far side of a rim cannot be
    # rebuilt on the circle, the circle has nothing to share with, the sew
    # reports free edges and the body gate turns the whole fit into a plain
    # refusal. Forcing that failure is the only way to see it: it does not
    # happen on any fixture here, which is exactly why it needs pinning.
    keep = builder._rebuild_planar_face
    builder._rebuild_planar_face = lambda face, swaps: None
    try:
        d = tempfile.mkdtemp()
        path, _src = _plate_stl(d, 0.2)
        part, _b, _p = _import_body(path)
    finally:
        builder._rebuild_planar_face = keep
    print(f"  A15 neighbour rebuild refused: {len(part.faces())} faces "
          f"{_census(part)} valid={_is_valid(part)} free={_free_edge_count(part)} "
          f"vol {part.volume:.4f}")
    assert _census(part).get("Cylinder", 0) == 0, (
        "a circle the neighbour could not take must refuse the whole fit, not "
        "ship a body with a free rim")
    assert _is_valid(part) and len(part.solids()) == 1
    assert _free_edge_count(part) == 0
    print("  A15 OK: two circular rims, a rim fillet that takes the whole rim, "
          "and a clean refusal when the neighbour will not take the circle")


# --------------------------------------------------------------------------
# A7 / A8 / A9: the ops the fit exists to enable, through the real handlers
# --------------------------------------------------------------------------

def test_a7_nearest_picks_the_bore_as_one_cylinder():
    """A7: `by:"nearest"` at the bore wall resolves to exactly ONE cylindrical
    face.

    The point is [-3, 0, 0], never [+3, 0, 0]: the cylinder's seam edge has its
    midpoint at (3, 0, 0), so a pick there is genuinely ambiguous between the
    face and the seam and tells you nothing about the fit."""
    from geom_select import resolve_faces

    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        path, _src = _plate_stl(d, at)
        part, _b, _p = _import_body(path)
        found = resolve_faces(part, {"kind": "face", "by": "nearest",
                                     "point": [-BORE_R, 0.0, 0.0]})
        kinds = [str(k) for k in _census_of_faces(found)]
        print(f"  A7 angular_tolerance={at}: nearest(-3,0,0) -> {len(found)} face(s) {kinds}")
        assert len(found) == 1, f"want one face, got {len(found)}"
        assert found[0].wrapped.IsSame(_cylinder_faces(part)[0].wrapped), (
            f"nearest picked a {kinds} face, not the bore")
    print("  A7 OK: the bore is one pickable cylindrical face")


def _census_of_faces(faces):
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    return [str(BRepAdaptor_Surface(f.wrapped).GetType()).split("_")[-1]
            for f in faces]


def test_a8_press_pull_the_bore_wall():
    """A8: press/pull the bore wall by -1 lands on the ANALYTIC 15497.345.

    r 3 -> 4 is 16000 - pi*16*10 = 15497.345. Today the same gesture gives
    15703.796 with no error at all: it moves ONE facet of the wall, which is the
    "dents instead of resizing" the issue reports. The difference between those
    two numbers is the entire feature, and neither is a crash — this is why the
    ops are the oracle and validity is not.

    Driven through `rebuild` and the real press-pull handler, not `_press_pull`
    directly, so the selector re-resolution and the clamps are in the loop."""
    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        path, _src = _plate_stl(d, at)
        payload = import_geometry(path, "stl")
        doc = {"parameters": {}, "features": [
            {"id": "im", "type": "import", "format": "stl", "name": "m",
             "geom": payload["geom"]},
            {"id": "pp", "type": "press-pull",
             "face": {"kind": "face", "by": "nearest", "point": [-BORE_R, 0.0, 0.0]},
             "distance": -1.0}]}
        part, errors, _bodies = rebuild(doc)
        assert not errors, errors
        print(f"  A8 angular_tolerance={at}: bore wall -1 -> vol {part.volume:.3f} "
              f"({len(part.faces())} faces) {_census(part)}")
        assert abs(part.volume - 15497.345) < 0.5, (
            f"press/pull the bore by -1 gave {part.volume:.3f}, want 15497.345 "
            f"(15703.796 is the faceted dent)")
        assert len(_cylinder_faces(part)) == 1
        assert abs(_cyl_radius(_cylinder_faces(part)[0]) - 4.0) < 1e-3
    print("  A8 OK: the bore resizes to r=4, volume 15497.345")


def test_a9_delete_face_removes_the_bore():
    """A9: Delete Face on the bore heals the plate to a solid 16000 with 6 faces.

    Today this "works" too — it returns 15713.374 and a green chip, having
    deleted one facet strip and healed over it. A number close to the right one
    is the failure mode; the face COUNT is what separates them."""
    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        path, _src = _plate_stl(d, at)
        payload = import_geometry(path, "stl")
        doc = {"parameters": {}, "features": [
            {"id": "im", "type": "import", "format": "stl", "name": "m",
             "geom": payload["geom"]},
            {"id": "df", "type": "deleteFace",
             "face": {"kind": "face", "by": "nearest", "point": [-BORE_R, 0.0, 0.0]}}]}
        part, errors, _bodies = rebuild(doc)
        assert not errors, errors
        print(f"  A9 angular_tolerance={at}: delete bore -> vol {part.volume:.3f}, "
              f"{len(part.faces())} faces {_census(part)}")
        assert abs(part.volume - 16000.0) < 0.5, (
            f"deleting the bore gave {part.volume:.3f}, want the solid 16000.0")
        assert len(part.faces()) == 6, (
            f"a healed plate is a 6-faced box, got {len(part.faces())}")
    print("  A9 OK: the bore deletes to a solid 16000 box")


# --------------------------------------------------------------------------
# A10 / A16: what must NOT change
# --------------------------------------------------------------------------

def test_a10_a_body_with_nothing_to_fit_is_the_same_object():
    """A10: a body with no curved surface comes back as the SAME OBJECT, and its
    import is bit-identical to one with `_fit_surfaces` stubbed out.

    `is` identity is a contract, not a nicety: `_drop_debris` and the server's
    mesh cache both key on it, and the mesh-import call site branches on it to
    decide whether to refacet. The blob digest is the strong half — a fit that
    "changed nothing" but re-sewed the shape would return an equal-looking body
    with a different serialisation, and every downstream cache would miss.

    The staircase fixture is chosen because it is the DANGEROUS no-op: its
    near-parallel wall pairs sit 0.29 degrees apart, well inside the 25-degree
    seed window, so the fitter really does try to fit them and must refuse on
    size rather than never look.

    The last leg is a different fixture for a different reason — see the comment
    on it. Both mutants of the whole-shape defensive copy used to leave the
    whole suite ALL PASS."""
    d = tempfile.mkdtemp()
    path = _stl_of(_staircase_box(), d, "stair")

    uni = _unified(path)
    same = builder._fit_surfaces(uni)
    print(f"  A10 _fit_surfaces on the staircase body: identity={same is uni} "
          f"({len(uni.faces())} faces {_census(uni)})")
    assert same is uni, (
        "the fitter returned a NEW object for a body with nothing to fit — "
        "identity is what the caller and the caches read")

    live, lb, lp = _import_body(path)
    ctrl, cb, cp = _import_with_fit_disabled(path)
    print(f"  A10 import: live {len(live.faces())} faces vol {live.volume:.4f} "
          f"digest {lp['geom'][:16]}... | control {len(ctrl.faces())} faces "
          f"vol {ctrl.volume:.4f} digest {cp['geom'][:16]}...")
    assert lp["geom"] == cp["geom"], (
        "the stored geometry digest changed although nothing was fitted")
    assert lp["faces"] == cp["faces"]
    assert len(live.faces()) == len(ctrl.faces())
    assert abs(live.volume - ctrl.volume) < 1e-9

    # ...and the input must come back UNTOUCHED even when the fit succeeds.
    # `ShapeFix_Face` writes into the edges it is handed, and those edges are
    # shared with the faces that keep their old geometry, so fitting in place
    # raised the tolerance of edges on faces nothing had changed — measured
    # 15.84 mm on a PLANE/PLANE edge of a body `_fit_surfaces` then declined to
    # return. Identity alone does NOT catch that: the same object comes back,
    # quietly different.
    #
    # A CONE, NOT THE PLATE, and that is the whole point of this leg. On the
    # plate every candidate region is accepted and the rim becomes an exact
    # circle, so the input's tolerance stays at 1e-7 whether the defensive copy
    # exists or not — the leg was written to pin the mutation bug and could not
    # fail. A cone is the case that bites: 14 cylinders fit and the rest of it
    # is DECLINED, and a declined region is where ShapeFix leaves its marks.
    # Measured with the whole-shape copy deleted: the plate still reads
    # 1e-7 -> 1e-7 while this reads 1e-7 -> 5.46e-2.
    #
    # It pins ONE of the two copies. The trial-on-copies block sits INSIDE the
    # whole-shape copy, so with that copy in place nothing the trial wires do
    # can reach the caller's input on any fixture measured; what it protects is
    # the tolerance of the RETURNED shape, which is A12's subject.
    d2 = tempfile.mkdtemp()
    from build123d import Cone

    declining = _stl_of(Cone(8, 0, 20), d2, "cone")
    uni2 = _unified(declining)
    before = _max_edge_tolerance(uni2)
    out = builder._fit_surfaces(uni2)
    after = _max_edge_tolerance(uni2)
    print(f"  A10 input edge tolerance across a PARTIAL fit: {before:.3e} -> "
          f"{after:.3e} (result {len(out.faces())} faces, new object={out is not uni2})")
    assert out is not uni2, "precondition: this fixture must actually fit"
    assert after == before, (
        f"fitting mutated its INPUT: max edge tolerance {before:.3e} -> {after:.3e}")
    print("  A10 OK: same object, same digest, same body, input never mutated")


def test_a16_a_mixed_body_is_never_worse():
    """A16: a body carrying BOTH a bore and staircase debris comes out with no
    more faces than today's refacet-only import gives.

    This is the case the two passes disagree on. Fitting recognises the bore but
    leaves the staircase; refacet collapses the staircase but leaves the bore in
    63 pieces. The call site ships whichever result has fewer faces, so the
    guarantee this pins is one-directional: the feature may not make any file
    worse than it was."""
    from build123d import Cylinder

    d = tempfile.mkdtemp()
    mixed = _staircase_box() - Cylinder(BORE_R, 60)
    path = _stl_of(mixed, d, "mixed")
    live, _lb, lp = _import_body(path)
    ctrl, _cb, cp = _import_with_fit_disabled(path)
    print(f"  A16 mixed body: live {len(live.faces())} faces {_census(live)} "
          f"vol {live.volume:.3f} | control (refacet only) {len(ctrl.faces())} "
          f"faces {_census(ctrl)} vol {ctrl.volume:.3f}")
    assert len(live.faces()) <= len(ctrl.faces()), (
        f"fitting made a mixed body worse: {len(live.faces())} faces against "
        f"the refacet-only {len(ctrl.faces())}")
    assert _is_valid(live), "the mixed body came out invalid"
    assert len(live.solids()) == len(ctrl.solids())
    print("  A16 OK: a mixed body is never worse than refacet alone")


def _plate_and_staircases_stl(d, n):
    """A slicer plate: one bored bracket plus `n` staircase offcuts, 100 mm
    apart so nothing touches. The shape a multi-object 3MF has after unify."""
    from build123d import Box, Compound, Cylinder, Pos, export_stl

    parts = [Box(40, 40, 10) - Cylinder(BORE_R, 20)]
    parts += [Pos(100 * (i + 1), 0, 0) * _staircase_box() for i in range(n)]
    p = os.path.join(d, f"plate_and_{n}.stl")
    export_stl(Compound(parts), p, tolerance=0.05, angular_tolerance=0.2)
    return p


def test_one_body_does_not_decide_another_bodys_fit():
    """A16 across BODIES: a plate of debris offcuts must not veto the bracket's
    bore, and the bracket must not drag the offcuts into the fitted variant.

    A16 covers one body carrying both a bore and debris, so it is structurally
    blind to this: the fit-vs-refacet choice used to be made on the whole
    FILE's face count while everything either side of it was per body. Measured
    on this fixture before the fix: at n=6 the file compared 7 + 6*10 fitted
    against 23 + 6*6 refaceted, so refacet won file-wide and the bracket's bore
    shipped as 23 planes with `fitted` 0 — the same bracket imported alone
    comes back as 7 faces with one cylinder. At n=1 the fit won file-wide and
    every offcut kept 10 faces where refacet gives it 6, which is WORSE than
    the pre-#49 import gave that body.

    Both directions are asserted, because a per-file rule fails in both."""
    d = tempfile.mkdtemp()
    alone = _import_body(_plate_and_staircases_stl(d, 0))[0]
    solo_faces = len(alone.faces())
    assert _census(alone).get("Cylinder", 0) == 1, _census(alone)

    for n in (1, 6):
        path = _plate_and_staircases_stl(d, n)
        part, bodies, payload = _import_body(path)
        per_body = sorted(len(b["shape"].faces()) for b in bodies)
        print(f"  {n} offcut(s): {len(part.faces())} faces {_census(part)}, "
              f"per body {per_body}, reply fitted={payload.get('fitted')}")
        assert len(bodies) == n + 1, f"expected {n + 1} bodies, got {len(bodies)}"
        # the bracket keeps its bore no matter how much debris shares the file
        assert _census(part).get("Cylinder", 0) == 1, (
            f"{n} unrelated offcut(s) vetoed the bracket's fit: {_census(part)}")
        assert payload.get("fitted") == 1, payload.get("fitted")
        assert solo_faces in per_body, (
            f"the bracket did not come back as it does alone ({solo_faces}): "
            f"{per_body}")
        # ...and every offcut is still cleaned the way refacet alone cleans it
        assert per_body.count(6) == n, (
            f"an offcut kept its debris because another body fitted: {per_body}")


def test_the_debris_cleaner_is_not_run_once_the_fit_has_already_won():
    """A body the fit has already HALVED ships without the debris cleaner being
    consulted at all.

    `_refacet_clean` is the most expensive stage on the mesh path, and its
    answer is discarded whenever the fit wins: measured on a 15,490-face plate
    of through holes, 70.2 s of a 95.3 s import computing a 3,097-face result
    that lost to the fit's 209. The comparison exists for a body that is mostly
    debris with one small bore, which is exactly the body whose fit reduces
    LITTLE — so a strong fit is the signal that there is nothing to compare.

    Written as an availability test rather than a timing one: with the cleaner
    made unavailable, the plate must still import to its fitted answer."""
    d = tempfile.mkdtemp()
    path, _src = _plate_stl(d, 0.2)

    def _boom(shape, tol=0.12, debug=False):
        raise AssertionError("the debris cleaner was consulted on a won fit")

    keep = builder._refacet_clean
    builder._refacet_clean = _boom
    try:
        part, _bodies, payload = _import_body(path)
    finally:
        builder._refacet_clean = keep
    print(f"  no-refacet import: {len(part.faces())} faces {_census(part)}, "
          f"reply fitted={payload.get('fitted')}")
    assert len(part.faces()) == 7 and _census(part).get("Cylinder", 0) == 1, (
        f"the fitted plate is not what shipped: {len(part.faces())} faces "
        f"{_census(part)}")


def test_clean_up_leaves_a_sealed_void_alone():
    """Clean Up on a body it cannot improve returns the SAME OBJECT, cavity and
    all.

    `_explode_solids` is not a lossless decomposition — it wraps each SHELL of a
    multi-shell solid in its own solid, so a sealed internal void comes back as
    a separate inside-out solid. Recombining those unconditionally would hand
    `_unify_body` two solids instead of one, and it rights the negative one and
    fuses it away: measured 26,000 mm3 / 12 faces / 2 shells becoming 27,000 /
    6 / 1, with no diagnostic, on a feature that re-fires every rebuild. The
    per-body choice is only allowed to rebuild the compound when some body
    actually changed; when every body declines, the input object is what comes
    back. That is the same "any doubt returns the INPUT OBJECT" contract the
    fitter keeps, read at the level above it."""
    from build123d import Box

    void = Box(30, 30, 30) - Box(10, 10, 10)
    assert len(void.shells()) == 2, "precondition: the fixture must be a cavity"
    tb = {"id": "b1", "name": "sealed", "shape": void}

    class _Ctx:
        bodies = [tb]
        diagnostics = []

        def find_body(self, _bid):
            return tb

        def val(self, v):
            return v

    builder._handle_clean_up({"id": "cu", "type": "cleanUp"}, _Ctx())
    out = tb["shape"]
    print(f"  sealed void through cleanUp: vol {out.volume:.4f} "
          f"{len(out.faces())} faces, {len(out.shells())} shells, "
          f"same object {out is void}")
    assert out is void, (
        f"Clean Up rebuilt a body it could not improve: vol {out.volume:.4f}, "
        f"{len(out.faces())} faces, {len(out.shells())} shells")


# --------------------------------------------------------------------------
# A13 / A14: partial cylinders and multiple regions
# --------------------------------------------------------------------------

def _fillet_quadrant_mesh_areas(path, r, half=20.0):
    """Mesh area of each of the four corner-fillet strips in the PRE-FIT body,
    keyed by the corner's sign pair. The control A13 compares against."""
    uni = _unified(path)
    out = {}
    for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        cx, cy = sx * (half - r), sy * (half - r)
        total, count = 0.0, 0
        for f in uni.faces():
            c = f.center()
            if (abs(math.hypot(c.X - cx, c.Y - cy) - r) < 0.2
                    and (c.X - cx) * sx > -1e-3 and (c.Y - cy) * sy > -1e-3):
                total += f.area
                count += 1
        out[(sx, sy)] = (total, count, (cx, cy))
    return out


def test_a13_fillet_strips():
    """A13: a filleted box's four quarter cylinders all build, all positive, all
    within 2% of their own mesh area — and a region that gets dropped leaves the
    fillet faceted on a body that is still valid.

    THIS is the orientation test. A through bore has two rim loops and comes out
    right whatever you do about orientation; a convex quadrant has one loop and
    comes back at -47.1239 against a +47.1050 mesh region unless the wires are
    reversed (judge 2; reversing the FACE does not change the sign, measured).
    Four quadrants rather than one because they differ only in which way round
    the boundary runs."""
    from build123d import Axis, Box, fillet

    r = 1.0
    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        src = fillet(Box(40, 40, 10).edges().filter_by(Axis.Z), r)
        path = _stl_of(src, d, f"fil{at}", at)
        mesh = _fillet_quadrant_mesh_areas(path, r)
        rows = min(c for _a, c, _xy in mesh.values())
        assert rows >= 3, (
            f"the fixture must give at least 3 facet rows per fillet, got {rows}")

        part, _b, _p = _import_body(path)
        cyl = _cylinder_faces(part)
        print(f"  A13 angular_tolerance={at}: {len(part.faces())} faces "
              f"{_census(part)}, {rows} facet rows per fillet")
        assert len(cyl) == 4, f"want one cylinder per fillet, got {len(cyl)}"
        for f in cyl:
            got_r = _cyl_radius(f)
            (ax, ay, _az), _dr = _cyl_axis(f)
            key = (1 if ax > 0 else -1, 1 if ay > 0 else -1)
            mesh_area, _n, _xy = mesh[key]
            area = _signed_area(f)
            rel = abs(area - mesh_area) / mesh_area
            print(f"      quadrant{key}: R={got_r:.6f} area={area:+.4f} "
                  f"mesh={mesh_area:.4f} rel={rel:.5f}")
            assert abs(got_r - r) < 1e-3, f"fillet radius {got_r:.6f}, want {r}"
            assert area > 0.0, (
                f"quadrant {key} built with NEGATIVE area {area:.4f} — the wire "
                f"runs the wrong way in UV and the face normal points inward")
            assert rel < 0.02, (
                f"quadrant {key} area {area:.4f} vs mesh {mesh_area:.4f} "
                f"(rel {rel:.5f}) — outside 2%")
        assert _is_valid(part) and len(part.solids()) == 1
        assert abs(part.volume - src.volume) / src.volume < 5e-4

    # ...and a dropped region is a clean fallback, not a broken body. Widening
    # the area band past every real ratio refuses each region at the last gate,
    # which is the closest thing to "the fit was almost right and still refused".
    keep = builder.FIT_AREA_BAND
    builder.FIT_AREA_BAND = (2.0, 3.0)
    try:
        d = tempfile.mkdtemp()
        src = fillet(Box(40, 40, 10).edges().filter_by(Axis.Z), r)
        path = _stl_of(src, d, "fil_drop")
        part, _b, _p = _import_body(path)
    finally:
        builder.FIT_AREA_BAND = keep
    print(f"  A13 dropped: {len(part.faces())} faces {_census(part)} "
          f"valid={_is_valid(part)} vol {part.volume:.3f}")
    assert _census(part).get("Cylinder", 0) == 0, "a refused region must stay faceted"
    assert _is_valid(part) and len(part.solids()) == 1, "the fallback body is broken"
    print("  A13 OK: four positive quadrants within 2%, and a clean fallback")


def test_a14_two_bores_of_different_radii():
    """A14: two bores of different radii become TWO regions, each with its own
    radius.

    The largest untested piece of the grower: one bore proves nothing about
    multi-seed greedy claiming, because a single region cannot be stolen from.
    Different radii rather than two of the same, so a single over-eager region
    that swallowed both would be visible as a wrong radius rather than hiding
    behind a plausible count."""
    from build123d import Box, Cylinder, Pos

    for at in ANG_TOLS:
        d = tempfile.mkdtemp()
        src = (Box(40, 40, 10)
               - Pos(-10, 0, 0) * Cylinder(3.0, 20)
               - Pos(10, 0, 0) * Cylinder(5.0, 20))
        path = _stl_of(src, d, f"two{at}", at)
        part, _b, _p = _import_body(path)
        cyl = _cylinder_faces(part)
        radii = sorted(round(_cyl_radius(f), 4) for f in cyl)
        print(f"  A14 angular_tolerance={at}: {len(part.faces())} faces "
              f"{_census(part)}, radii {radii}")
        assert len(cyl) == 2, f"want two cylinder faces, got {len(cyl)} {radii}"
        assert abs(radii[0] - 3.0) < 1e-3 and abs(radii[1] - 5.0) < 1e-3, radii
        assert _is_valid(part) and len(part.solids()) == 1
        assert abs(part.volume - src.volume) / src.volume < 5e-4
    print("  A14 OK: two bores, two regions, radii 3.0 and 5.0")


# --------------------------------------------------------------------------
# Cones, spheres and tori about a recognised axis
# --------------------------------------------------------------------------

def _rim_blend_stl(d):
    """The A15 plate (40x40x10, a 3 mm bore) with an r=1 fillet on the top rim of
    the bore: a ring torus of major radius 4 and minor radius 1 round the bore's
    axis, at z=4."""
    from build123d import Box, Cylinder, GeomType, fillet

    src = Box(40, 40, 10) - Cylinder(BORE_R, 20)
    top_rim = max(src.edges().filter_by(GeomType.CIRCLE), key=lambda e: e.center().Z)
    blended = fillet(top_rim, 1.0)
    return _stl_of(blended, d, "rim_blend"), blended


def test_a_blend_around_a_rim_comes_back_as_one_torus():
    """A fillet that wraps around a rim is a TORUS, and it now comes back as one.

    This test used to pin the opposite, as a characterisation the docstring
    asked to be turned around the day a torus screen landed: the same fixture
    came back as 615 faces with 94 cylinders, ONE the true bore and 93 slices of
    the torus with radii from 3.0033 up to 78.6673 and tilted axes, and Press/Pull
    raised on all of them (and on the true bore beside them).

    What makes it one face now: the bore's axis is recognised EXACTLY (its
    facets fit a cylinder to the file's float32 precision), every vertex of the
    blend maps onto one circle in that axis's (radius, height) plane, and that
    circle is centred off the axis, so it is a torus. Measured: 2,000 facets ->
    one torus R 4.0000004 r 1.0000004, and the body is the source's 8 faces.

    The volume is the oracle the old version could not have: the faceted import
    sits 0.449 mm3 off the exact 15712.9103 and the 94-cylinder fit 0.143 off;
    the fitted torus lands within 0.001. Press/Pull on the torus now refuses with
    the plain "flat and cylindrical faces only" sentence instead of a facet
    refusal or a sandbox crash."""
    d = tempfile.mkdtemp()
    path, blended = _rim_blend_stl(d)
    part, _bodies, payload = _import_body(path)
    surfaces = [_surface(f) for f in part.faces()]
    tori = [p for t, p in surfaces if t == "Torus"]
    bores = [p for t, p in surfaces if t == "Cylinder"]
    print(f"  rim blend: {len(part.faces())} faces {_census(part)}, tori {tori}, "
          f"vol {part.volume:.4f} (exact {blended.volume:.4f})")
    assert _census(part) == {"Plane": 6, "Cylinder": 1, "Torus": 1}, (
        f"the rim blend should come back as its source's 8 faces, got {_census(part)}")
    major, minor, loc, axis = tori[0]
    assert abs(major - 4.0) < 1e-3 and abs(minor - 1.0) < 1e-3, (
        f"the torus should be R 4 r 1, got R {major} r {minor}")
    assert abs(abs(axis[2]) - 1.0) < 1e-6 and math.hypot(loc[0], loc[1]) < 1e-3, (
        f"the torus must share the bore's axis, got {loc} {axis}")
    assert abs(loc[2] - 4.0) < 1e-3, f"the torus centre should sit at z=4, got {loc}"
    assert abs(bores[0][0] - BORE_R) < 1e-3
    assert _is_valid(part) and len(part.solids()) == 1 and _free_edge_count(part) == 0
    assert abs(part.volume - blended.volume) < 0.01, (
        f"the fitted blend is {part.volume - blended.volume:+.4f} mm3 off the exact "
        f"volume; the faceted import is 0.449 off")
    assert payload["fitted"] == 2 and payload["faceted"] == 0, (
        f"the reply should count the bore AND the torus, and no facets: "
        f"{payload.get('fitted')}, {payload.get('faceted')}")

    doc = {"parameters": {}, "features": [
        {"id": "im", "type": "import", "format": "stl", "name": "m",
         "geom": payload["geom"]},
        {"id": "pp", "type": "press-pull",
         "face": {"kind": "face", "by": "nearest", "point": [-3.2929, 0.0, 4.7071]},
         "distance": -0.1}]}
    _part, errors, _b = rebuild(doc)
    print(f"  press/pull on the torus: {errors}")
    assert errors and "flat and cylindrical faces only" in errors[0]["message"], (
        f"press/pull on a torus should refuse in plain words, got {errors}")
    print("  OK: one bore, one torus, the source's volume")


def test_a_countersink_and_a_chamfer_come_back_as_cones():
    """A countersink and a chamfered boss are CONES sharing the bore's or the
    boss's axis, and come back as one cone each.

    The mesh2step comparison (2026-09-23) put the countersink at 95 faces with
    14 cylinders and 81 planes, and the cone is the shape the prismatic-recognition
    measurement found most often in field files (cone was the first word of
    50.5% of its refusals). Measured now: the countersink comes back as the
    source's 8 faces (one 45-degree cone, one R3 bore), the chamfered boss as
    its 9."""
    from build123d import Box, Cone, Cylinder, GeomType, Pos, chamfer

    d = tempfile.mkdtemp()
    plate = Box(40, 40, 10)
    sink = plate - Cylinder(BORE_R, 20) - Pos(0, 0, 2) * Cone(3, 6, 3, align=None)
    boss = Box(40, 40, 10) + Pos(0, 0, 10) * Cylinder(6, 10)
    boss = chamfer(max(boss.edges().filter_by(GeomType.CIRCLE),
                       key=lambda e: e.center().Z), 1.0)
    for name, src, want, radius in (
            ("countersink", sink, {"Plane": 6, "Cylinder": 1, "Cone": 1}, 3.0),
            ("chamfered boss", boss, {"Plane": 7, "Cylinder": 1, "Cone": 1}, 6.0)):
        path = _stl_of(src, d, name.replace(" ", "_"))
        part, _bodies, payload = _import_body(path)
        faceted = _unified(path).volume
        surfaces = [_surface(f) for f in part.faces()]
        cones = [p for t, p in surfaces if t == "Cone"]
        print(f"  {name}: {len(part.faces())} faces {_census(part)}, cone "
              f"{[(round(c[0], 6), round(c[1], 6)) for c in cones]}, vol "
              f"{part.volume:.4f} (exact {src.volume:.4f}, faceted {faceted:.4f})")
        assert _census(part) == want, f"{name}: want {want}, got {_census(part)}"
        assert abs(cones[0][0] - 45.0) < 1e-3, f"{name}: the cone is 45 degrees, got {cones[0][0]}"
        assert abs(abs(cones[0][3][2]) - 1.0) < 1e-6, f"{name}: the cone must share the axis"
        cyl = [p for t, p in surfaces if t == "Cylinder"][0]
        assert abs(cyl[0] - radius) < 1e-3
        assert _is_valid(part) and len(part.solids()) == 1 and _free_edge_count(part) == 0
        # Comparative, not a fixed band: where the boss meets its chamfer both
        # faces are fitted and the edge between them is still the mesh's chords,
        # which costs the boss 0.259 mm3 (the countersink 0.020). The faceted
        # import is 2.007 and 1.200 off.
        assert abs(part.volume - src.volume) < 0.2 * abs(faceted - src.volume), (
            f"{name}: {part.volume - src.volume:+.4f} mm3 off the exact volume, "
            f"the faceted import {faceted - src.volume:+.4f}")
        assert payload["fitted"] == 2 and payload["faceted"] == 0
    print("  OK: both come back as their source's faces")


def test_rounded_box_corners_come_back_as_spheres():
    """Where three equal fillets meet at a box corner the blend is a SPHERE
    octant, and every corner comes back as one: the box's 26 source faces, 12
    cylinders and 8 spheres, each centred on its corner.

    A sphere is a surface of revolution about every axis through its centre, so
    each corner is found once from each of its three edge cylinders and kept
    once. Its frame is placed so the patch's centre sits at u=pi, v=0; at the
    default frame the corner's boundary lay on the seam and next to a pole and
    the sewn body came back invalid (measured on the reporter's file)."""
    from build123d import Box, fillet

    d = tempfile.mkdtemp()
    src = fillet(Box(30, 20, 10).edges(), 2.0)
    part, _bodies, payload = _import_body(_stl_of(src, d, "rounded_box"))
    spheres = sorted((round(p[1][0], 3), round(p[1][1], 3), round(p[1][2], 3), round(p[0], 6))
                     for t, p in map(_surface, part.faces()) if t == "Sphere")
    print(f"  rounded box: {len(part.faces())} faces {_census(part)}, spheres {spheres}, "
          f"vol {part.volume:.4f} (exact {src.volume:.4f})")
    assert _census(part) == {"Plane": 6, "Cylinder": 12, "Sphere": 8}, _census(part)
    want = sorted((x * 13.0, y * 8.0, z * 3.0) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1))
    assert all(abs(s[3] - 2.0) < 1e-3 for s in spheres), spheres
    assert all(max(abs(a - b) for a, b in zip(s[:3], w)) < 1e-3
               for s, w in zip(spheres, want)), f"sphere centres {spheres} want {want}"
    assert _is_valid(part) and len(part.solids()) == 1 and _free_edge_count(part) == 0
    assert abs(part.volume - src.volume) < 0.01
    assert payload["fitted"] == 20 and payload["faceted"] == 0
    print("  OK: eight corners, eight spheres")


def _cover_stand_in():
    """The committable stand-in for the reporter's cover (GH #49): a box whose
    vertical edges are filleted 3, its bottom edges 3 and its top edges 1.3, so
    every corner is a vertical R3 cylinder between a bottom SPHERE (R3) and a top
    TORUS (R 1.7, r 1.3) — what the reporter's file holds at each of its eight
    corners, measured. 26 source faces: 6 planes, 12 cylinders, 4 tori, 4
    spheres."""
    from build123d import Axis, Box, Pos, fillet

    b = Pos(0, 0, 0.85) * Box(110.1, 59.1, 25.7)
    b = fillet(b.edges().filter_by(Axis.Z), 3.0)
    zmin = b.bounding_box().min.Z
    b = fillet([e for e in b.edges() if abs(e.center().Z - zmin) < 1e-6], 3.0)
    zmax = b.bounding_box().max.Z
    return fillet([e for e in b.edges() if abs(e.center().Z - zmax) < 1e-6], 1.3)


def test_the_reporters_corners_come_back_as_their_design():
    """GH #49's file, in a form that can be committed: every corner comes back
    as one torus, one sphere and its vertical cylinder, and the body is the
    source's 26 faces.

    Before this the stand-in came back as 1,290 faces with 180 cylinders, and
    the reporter's own file as 1,482 faces with 300, of which most at the
    corners were slices with radii 2.96-5.72 on tilted axes.

    THE TOP FACE IS THE LEG THAT MATTERS TO A USER. A corner torus meets the top
    face tangentially along a quarter circle, and the mesh gives that arc as
    chords. Left as chords, the torus leans 0.09 degrees off the top face at
    each chord's midpoint, which is past the 0.05 degrees at which the facet
    refusal reads the top face as one facet of an unrecognised curve, and
    Press/Pull refused the top face of a body that had fitted perfectly. The
    arc is now one true circular edge both faces share, and pressing the top
    face down 1 mm removes exactly its analytic area: (110.1 - 2.6) x
    (59.1 - 2.6) - (4 - pi) x 1.7^2 = 6071.2692 mm3."""
    from build123d import GeomType

    d = tempfile.mkdtemp()
    src = _cover_stand_in()
    part, _bodies, payload = _import_body(_stl_of(src, d, "cover"))
    surfaces = [_surface(f) for f in part.faces()]
    tori = [p for t, p in surfaces if t == "Torus"]
    spheres = [p for t, p in surfaces if t == "Sphere"]
    radii = sorted(round(p[0], 4) for t, p in surfaces if t == "Cylinder")
    print(f"  cover: {len(part.faces())} faces {_census(part)}; tori "
          f"{sorted((round(t[0], 6), round(t[1], 6)) for t in tori)}; spheres "
          f"{sorted(round(s[0], 6) for s in spheres)}; cylinders {radii}; vol "
          f"{part.volume:.4f} (exact {src.volume:.4f})")
    assert _census(part) == {"Plane": 6, "Cylinder": 12, "Torus": 4, "Sphere": 4}, _census(part)
    assert all(abs(t[0] - 1.7) < 1e-3 and abs(t[1] - 1.3) < 1e-3 for t in tori), tori
    assert all(abs(abs(t[3][2]) - 1.0) < 1e-6 for t in tori), "every torus is about a vertical axis"
    assert all(abs(s[0] - 3.0) < 1e-3 for s in spheres), spheres
    assert radii == [1.3] * 4 + [3.0] * 8, f"no fabricated cylinders: {radii}"
    assert _is_valid(part) and len(part.solids()) == 1 and _free_edge_count(part) == 0
    assert abs(part.volume - src.volume) < 0.05
    assert payload["fitted"] == 20 and payload["faceted"] == 0, (
        f"nothing on this body is a facet any more: {payload.get('fitted')}, "
        f"{payload.get('faceted')}")

    top = max((f for f in part.faces() if f.geom_type == GeomType.PLANE),
              key=lambda f: f.center().Z)
    arcs = sum(1 for e in top.edges() if e.geom_type == GeomType.CIRCLE)
    assert arcs == 4, f"the top face should carry one true arc per corner, got {arcs}"
    assert builder._facet_of_an_unrecognised_curve(part, [top]) is None, (
        "the top face still reads as a facet of an unrecognised curve")
    doc = {"parameters": {}, "features": [
        {"id": "im", "type": "import", "format": "stl", "name": "m",
         "geom": payload["geom"]},
        {"id": "pp", "type": "press-pull",
         "face": {"kind": "face", "by": "nearest", "point": [0.0, 0.0, top.center().Z]},
         "distance": -1.0}]}
    pressed, errors, _b = rebuild(doc)
    print(f"  press/pull the top face -1: {errors or 'ok'}, dV "
          f"{pressed.volume - part.volume:+.4f}")
    assert not errors, errors
    assert abs((part.volume - pressed.volume) - 6071.2692) < 0.01, (
        f"pressing the top face down 1 mm removed {part.volume - pressed.volume:.4f} mm3, "
        f"want its analytic area 6071.2692")
    print("  OK: four tori, four spheres, true arcs, and the top face presses")


def test_cones_spheres_and_tori_need_a_recognised_axis():
    """CHARACTERISATION of the scope round2 decision B1 set: coaxial cases
    first. A cone, sphere or torus is only recognised about the axis of a
    cylinder the body holds exactly, so these stay as they were:

      * a plain cone (no cylinder at all) keeps its v1 result, a run of
        fabricated cylinders, and no cone;
      * a drill point's cone shares the bore's axis but reaches its own APEX,
        where the surface is singular and no valid face can be bounded, so it
        stays faceted while the bore beside it is recognised;
      * a lone dome on a block has no cylinder to take an axis from.

    Turn this around, not delete it, when a standalone pass lands."""
    from build123d import Box, Cone, Cylinder, Pos, Sphere

    d = tempfile.mkdtemp()
    hole = Pos(0, 0, 2) * Cylinder(3, 6) + Pos(0, 0, -1 - 1.8025) * Cone(0, 3, 1.8025, align=None)
    cases = (("plain cone", Cone(8, 0, 20)),
             ("drill point", Box(40, 40, 10) - hole),
             ("dome", Box(20, 20, 10) + Pos(0, 0, 5) * Sphere(8)))
    for name, src in cases:
        part, _bodies, _p = _import_body(_stl_of(src, d, name.replace(" ", "_")))
        c = _census(part)
        print(f"  {name}: {len(part.faces())} faces {c}")
        assert not c.get("Cone") and not c.get("Sphere") and not c.get("Torus"), (
            f"{name}: recognised without a coaxial cylinder: {c}")
        assert _is_valid(part) and len(part.solids()) == 1
    bore = [p for t, p in map(_surface, _import_body(
        _stl_of(cases[1][1], d, "drill_point"))[0].faces()) if t == "Cylinder"]
    assert any(abs(p[0] - 3.0) < 1e-3 for p in bore), "the drill point's bore is still recognised"
    print("  OK (scope, pinned): no axis, no cone, sphere or torus")


def test_anywhere_on_the_bed_and_either_way_up():
    """The same parts placed where a slicer puts them, and turned over, come
    back as exactly their source's faces: no surface the source does not have,
    none it has missing.

    Every fixture above sits at the origin, and so does the reporter's file
    (largest coordinate 55). Away from it the file's float32 precision is
    coarser (1.5e-5 at x = 128), the exactness tolerance grows with it, and a
    review run found the pass making up cones, spheres and tori there: the rim
    blend moved to (128, 128) came back as a sphere and four 16.86-degree cones
    on tilted axes (the body named 105 axes where it has one). And the rim
    blend turned upside down came back as main imports it, 94 fabricated
    cylinders, because only ONE of its torus band's two rims ran the wrong way
    and both were only ever reversed together. Each case below failed one of
    those ways, or by refusing the body, or with a point-sized degenerated edge
    on a torus (valid by BRepCheck, and an edge with one face), before the
    fixes it names:

      * rim blend upside down / on its side: both ways round tried on fresh
        copies of the edges (a build leaves its pcurves on the edges it is
        given, and the next one reused them);
      * bore filleted on both rims, at the bed: an axis must end on parallels,
        and a band's rim circles go exactly round the band's own axis;
      * hole filleted on its bottom rim: a band's seam goes exactly through a
        vertex of a rim that stays chords;
      * countersink at the bed: a rim made one circle starts at the seam;
      * capsule and dome pin at the bed: a band round the axis is framed with
        its poles on the axis, the fan round a pole joins the sphere, and a
        hemisphere is told from its mirror image by its centroid;
      * cover at the bed: a seed whose ring spans three parallels looks one
        ring further out, and an axis' fit drops a neighbour's sliver that is
        off its parallels;
      * boss with a filleted top edge: the rim circle round the torus' own
        axis (round the loop's own fit, ShapeFix left the torus invalid)."""
    from build123d import Box, Cone, Cylinder, GeomType, Pos, Rot, Sphere, fillet

    d = tempfile.mkdtemp()
    rim_blend = _rim_blend_stl(d)[1]
    plate = Box(40, 40, 10) - Cylinder(BORE_R, 20)
    two_rims = fillet(plate.edges().filter_by(GeomType.CIRCLE), 1.0)
    sink = Box(40, 40, 10) - Cylinder(BORE_R, 20) - Pos(0, 0, 2) * Cone(3, 6, 3, align=None)
    capsule = Cylinder(5, 20) + Pos(0, 0, 10) * Sphere(5) + Pos(0, 0, -10) * Sphere(5)
    dome_pin = (Box(20, 20, 5) + Pos(0, 0, 7.5) * Cylinder(3, 10)
                + Pos(0, 0, 12.5) * Sphere(3))
    boss = Box(40, 40, 10) + Pos(0, 0, 10) * Cylinder(6, 10)
    boss = fillet(max(boss.edges().filter_by(GeomType.CIRCLE),
                      key=lambda e: e.center().Z), 2.0)
    bottom_rim = fillet(min(plate.edges().filter_by(GeomType.CIRCLE),
                            key=lambda e: e.center().Z), 1.0)
    bed = Pos(128, 128, 0)
    cases = (
        ("rim blend upside down", Rot(180, 0, 0) * rim_blend),
        ("rim blend on its side", Rot(90, 0, 0) * rim_blend),
        ("bore filleted on both rims, at the bed", bed * two_rims),
        ("hole filleted on its bottom rim", bottom_rim),
        ("countersink at the bed", bed * sink),
        ("capsule at the bed", bed * capsule),
        ("dome pin at the bed", bed * dome_pin),
        ("cover at the bed", bed * _cover_stand_in()),
        ("boss with a filleted top edge", boss),
    )
    for i, (name, src) in enumerate(cases):
        part, _bodies, payload = _import_body(_stl_of(src, d, f"placed_{i}"))
        want = _census(src)
        print(f"  {name}: {len(part.faces())} faces {_census(part)} (source "
              f"{len(src.faces())} {want}), vol {part.volume:.4f} (exact {src.volume:.4f})")
        assert _census(part) == want, f"{name}: want the source's {want}, got {_census(part)}"
        assert len(part.faces()) == len(src.faces()), name
        assert _is_valid(part) and len(part.solids()) == 1 and _free_edge_count(part) == 0, name
        assert abs(part.volume - src.volume) < 0.05, (
            f"{name}: {part.volume - src.volume:+.4f} mm3 off the exact volume")
        assert payload["faceted"] == 0 and not payload.get("fitSkipped"), (name, payload)
    print("  OK: every placement comes back as its source")


def test_a_refused_body_still_gets_its_cylinders():
    """When the body built with cones, spheres and tori is refused, the body
    gets the cylinders-only fit, never stays faceted.

    Before this, one face that broke the sew threw away every cylinder in the
    body too, and a body the cylinders-only fit brings under MAX_IMPORT_FACES
    landed read-only. Measured in review, at print-bed coordinates: a
    countersink went from 13 cylinders to 323 flat faces, a capsule and a bore
    filleted on both rims from editable to reference geometry.

    The refusal is made here the way those were: every place offered for a
    cone's seam is turned half a degree, so it cuts the rim it should meet at a
    vertex and the sew leaves free edges, with the rims as circles and as
    chords alike."""
    from build123d import Box, Cone, Cylinder, Pos

    d = tempfile.mkdtemp()
    sink = Box(40, 40, 10) - Cylinder(BORE_R, 20) - Pos(0, 0, 2) * Cone(3, 6, 3, align=None)
    path = _stl_of(sink, d, "countersink")

    keep_fit = builder._fit_surfaces
    builder._fit_surfaces = (lambda shape, debug=False, report=None, **_kw:
                             keep_fit(shape, debug=debug, report=report, revolutions=False))
    try:
        v1, _b, v1_payload = _import_body(path)
    finally:
        builder._fit_surfaces = keep_fit

    keep_seams = builder._revolution_seams

    def _off_by_half_a_degree(q, d_, *args):
        import numpy as np

        turn = math.radians(0.5)
        return [(math.cos(turn) * r + math.sin(turn) * np.cross(d_, r), wraps)
                for r, wraps in keep_seams(q, d_, *args)]

    builder._revolution_seams = _off_by_half_a_degree
    try:
        part, _b, payload = _import_body(path)
    finally:
        builder._revolution_seams = keep_seams
    print(f"  cylinders only: {len(v1.faces())} faces {_census(v1)}; refused new pass: "
          f"{len(part.faces())} faces {_census(part)}, reply {payload.get('fitSkipped')}")
    assert _census(v1).get("Cylinder"), "precondition: the cylinders-only fit finds the bore"
    assert _census(part) == _census(v1) and len(part.faces()) == len(v1.faces()), (
        f"a refused body should get the cylinders-only fit {_census(v1)}, got {_census(part)}")
    assert payload["fitted"] == v1_payload["fitted"] and not payload.get("fitSkipped"), payload
    print("  OK: refused, and the bore is still a cylinder")


def test_an_old_clean_up_keeps_rebuilding_the_way_it_did():
    """A Clean Up saved before cones, spheres and tori were recognised has no
    `fit`, and rebuilds with the cylinders-only fitter it was saved with; one
    made now carries `fit: 2` (src/features/featureStarters.ts) and gets the
    new pass.

    Why the old one must not change: Clean Up runs at REBUILD time, so without
    the field every saved document with a Clean Up on a faceted body would
    re-face that body on its next open, and every fillet, press/pull and sketch
    that names one of its faces would be re-pointed or broken (round2 decision
    B1: Clean Up does not upgrade fitted bodies; re-import instead).

    The old document here is a countersink imported with BOTH passes stubbed,
    i.e. one whose stored body is the raw sewn mesh (a refacet that declined
    leaves exactly that). Measured, branch against main, byte for byte: the
    cylinders-only path is identical on the plate, the rim blend, the cover,
    the countersink, the plain cone and the reporter's file."""
    d = tempfile.mkdtemp()
    from build123d import Box, Cone, Cylinder, Pos

    sink = Box(40, 40, 10) - Cylinder(BORE_R, 20) - Pos(0, 0, 2) * Cone(3, 6, 3, align=None)
    path = _stl_of(sink, d, "countersink")
    keep_fit, keep_rf = builder._fit_surfaces, builder._refacet_clean
    builder._fit_surfaces = lambda shape, debug=False, report=None, **_kw: shape
    builder._refacet_clean = lambda shape, tol=0.12, debug=False: shape
    try:
        payload = import_geometry(path, "stl")
    finally:
        builder._fit_surfaces, builder._refacet_clean = keep_fit, keep_rf
    imported = {"id": "im", "type": "import", "format": "stl", "name": "m",
                "geom": payload["geom"]}

    stored, e0, sb = rebuild({"parameters": {}, "features": [imported]})
    old_diags, new_diags = [], []
    old, e1, ob = rebuild({"parameters": {}, "features": [
        imported, {"id": "cu", "type": "cleanUp"}]}, diagnostics=old_diags)
    new, e2, nb = rebuild({"parameters": {}, "features": [
        imported, {"id": "cu", "type": "cleanUp", "fit": 2}]}, diagnostics=new_diags)
    assert not e0 and not e1 and not e2, (e0, e1, e2)
    v1 = builder._unify_body(builder._fit_or_refacet(sb[0]["shape"], revolutions=False))
    print(f"  stored {len(stored.faces())} faces {_census(stored)} | old Clean Up "
          f"{len(old.faces())} {_census(old)} | v1 fitter {len(v1.faces())} "
          f"{_census(v1)} | new Clean Up {len(new.faces())} {_census(new)}")
    assert _census(stored) == {"Plane": len(stored.faces())}, "precondition: a faceted body"
    assert not _census(old).get("Cone"), (
        f"an old Clean Up re-faced its body with the new fitter: {_census(old)}")
    assert _fit_signature(old) == _fit_signature(v1) and len(old.faces()) == len(v1.faces()), (
        "an old Clean Up no longer matches the cylinders-only fitter it was saved with")
    assert _census(new) == {"Plane": 6, "Cylinder": 1, "Cone": 1}, (
        f"a new Clean Up should recognise the countersink: {_census(new)}")
    old_note = [x["reason"] for x in old_diags if x.get("code") == "cleanUpFitted"]
    new_note = [x["reason"] for x in new_diags if x.get("code") == "cleanUpFitted"]
    print(f"    notes: old {old_note} | new {new_note}")
    assert old_note and "cylindrical" in old_note[0], old_note
    assert new_note and "2 curved faces" in new_note[0], new_note
    print("  OK: old Clean Ups rebuild as they did, new ones see cones")


def test_the_reporters_file_when_it_is_here():
    """GH #49's own file, run only where it is on disk: it is the reporter's
    work and is never committed. Point SINDRI_GH49_FILE at the attachment
    (QMX++Front-Rear+Covers.3mf) to run it.

    The self-consistency oracle from the triage, per body: four spheres R 3, four
    tori R 1.7 r 1.3 (R + r = 3, the vertical corner radius), valid, one solid,
    no free edges, fewer than the 782 / 700 faces the cylinders-only fitter
    leaves, and the volume within 0.15% of the sewn mesh.

    The last two legs are what the two gates no committable fixture reaches are
    measured against. Without the facet-depth spread gate, body 1 ships a flat
    side wall bowed out 0.5 mm into a radius-78.6 "cylinder" and its volume moves
    +1.34%; without the sag-evidence gate each body ships a fifth, false torus
    and an edge tolerance of 0.35 mm."""
    path = os.environ.get("SINDRI_GH49_FILE")
    if not path or not os.path.exists(path):
        print("  SKIP: SINDRI_GH49_FILE is not set")
        return
    from build123d import Mesher

    shapes = Mesher().read(path)
    raw = shapes[0] if len(shapes) == 1 else builder.Compound(list(shapes))
    sewn = builder._explode_solids(builder._unify_if_valid(raw))
    fitted = builder._explode_solids(builder._sew_mesh_file(path))
    assert len(fitted) == 2 == len(sewn)
    for i, (pre, body) in enumerate(zip(sewn, fitted)):
        surfaces = [_surface(f) for f in body.faces()]
        tori = [p for t, p in surfaces if t == "Torus"]
        spheres = [p for t, p in surfaces if t == "Sphere"]
        dv = (abs(body.volume) - abs(pre.volume)) / abs(pre.volume)
        print(f"  body {i}: {len(body.faces())} faces {_census(body)}, dV {100 * dv:+.4f}%, "
              f"max edge tol {_max_edge_tolerance(body):.3e}")
        assert len(tori) == 4 and all(abs(t[0] - 1.7) < 1e-3 and abs(t[1] - 1.3) < 1e-3
                                      for t in tori), tori
        assert len(spheres) == 4 and all(abs(s[0] - 3.0) < 1e-3 for s in spheres), spheres
        assert _is_valid(body) and len(body.solids()) == 1 and _free_edge_count(body) == 0
        assert len(body.faces()) < (782, 700)[i]
        assert abs(dv) < 1.5e-3, f"body {i}: volume moved {100 * dv:+.3f}%"
        assert _max_edge_tolerance(body) < 0.05
    print("  OK: the reporter's file, both bodies")


# --------------------------------------------------------------------------
# A18: refuse, don't dent
# --------------------------------------------------------------------------

_REFUSAL = ("This face meets its neighbour at the shallow angle of a "
            "tessellation facet, so I cannot tell it from one piece of a "
            "curved surface I did not recognise, and moving it on its own "
            "would dent the body rather than resize the curve. On a mesh body "
            "that is still entirely faceted, Clean Up can sometimes recognise "
            "the curve.")


def _faceted_plate_doc(path, *extra):
    """An import + whatever follows it, with the fitter stubbed to the identity.

    Stubbing is the only way to reach the case: fitting the plan's plate
    SUCCEEDS, so the bore comes out analytic and there is no facet left to pick.
    The bodies a real user brings here are the ones the fitter declined —
    cones, spheres, scans, anything at all noisy — and this reproduces exactly
    that state. `import_geometry` has to run INSIDE the stub: the fitting
    happens there, in `_sew_mesh_file`, not in `rebuild`."""
    keep = builder._fit_surfaces
    builder._fit_surfaces = lambda shape, debug=False, report=None, **_kw: shape
    try:
        payload = import_geometry(path, "stl")
        doc = {"parameters": {}, "features": [
            {"id": "im", "type": "import", "format": "stl", "name": "m",
             "geom": payload["geom"]}] + list(extra)}
        return rebuild(doc)
    finally:
        builder._fit_surfaces = keep


def test_a18_a_facet_of_an_unrecognised_curve_refuses():
    """A18: press/pull and Offset Face REFUSE one facet of a curve that stayed
    faceted, and say why, instead of denting it.

    RED, measured on the plan's plate with `_fit_surfaces` stubbed off:
      - press/pull the bore facet by -1 returns errors == [] and volume
        15703.796. It moved ONE of the 16 strips of the wall. That is GH #49's
        "dents instead of resizing", and nothing anywhere told the user.
      - the same pick through Offset Face killed the process: exit 139, a
        SIGSEGV inside BRepOffset. In the product that is server.py's worker
        dying, so the refusal has to land before OCCT is handed the face --
        which is why the second leg below runs in a subprocess and asserts on
        the RETURN CODE. A test that only checked the message would pass on an
        in-process ValueError raised one line too late.

    The controls matter as much as the refusals: the cap of the SAME faceted
    body still presses (the refusal is about the face, not about the body being
    faceted), and the fitted bore of the same fixture is exercised by A8."""
    d = tempfile.mkdtemp()
    path, _src = _plate_stl(d)

    # precondition: the stub really does leave the bore in flat strips
    part, errors, bodies = _faceted_plate_doc(path)
    faceted = bodies[0]["shape"]
    assert not errors, errors
    assert not _cylinder_faces(faceted), (
        f"precondition: the stub must leave the bore faceted, got {_census(faceted)}")
    print(f"  A18 faceted control: {len(faceted.faces())} faces {_census(faceted)}, "
          f"vol {faceted.volume:.4f}")

    bore = {"kind": "face", "by": "nearest", "point": [-BORE_R, 0.0, 0.0]}
    cap = {"kind": "face", "by": "normal", "dir": [0.0, 0.0, 1.0]}

    # 1. press/pull the bore facet: refused, and the body is untouched
    part, errors, _b = _faceted_plate_doc(
        path, {"id": "pp", "type": "press-pull", "face": bore, "distance": -1.0})
    print(f"  A18 press/pull a bore facet -> {errors and errors[0]['message']!r}, "
          f"vol {part.volume:.3f}")
    assert errors and errors[0]["message"] == _REFUSAL, (
        f"want the refusal, got {errors} (15703.796 with no error is the dent)")
    assert abs(part.volume - faceted.volume) < 1e-6, (
        f"a refused press/pull must leave the body alone, {part.volume:.4f}")

    # 2. the cap of the SAME faceted body still presses: its neighbours are all
    #    at 90 degrees, so nothing about it says "curve"
    part, errors, _b = _faceted_plate_doc(
        path, {"id": "pp", "type": "press-pull", "face": cap, "distance": 2.0})
    print(f"  A18 press/pull the faceted cap +2 -> errors {errors}, "
          f"vol {part.volume:.3f}")
    assert not errors, f"a real cap must stay pressable, got {errors}"
    assert part.volume > faceted.volume + 3000, (
        f"the cap should have added ~3200 mm^3, got {part.volume:.3f}")

    # 3. Offset Face on the bore facet, in a SUBPROCESS: today exit 139
    import json
    import subprocess

    here = os.path.dirname(os.path.abspath(builder.__file__))
    doc = {"parameters": {}, "features": [
        {"id": "im", "type": "import", "format": "stl", "name": "m", "geom": None},
        {"id": "of", "type": "offsetFace", "faces": bore, "distance": -1.0}]}
    runner = os.path.join(d, "offset_a_facet.py")
    with open(runner, "w") as fh:
        fh.write(
            "import json, os, sys\n"
            f"sys.path.insert(0, {here!r})\n"
            "os.environ['SINDRI_DISK_CACHE'] = '0'\n"
            "import occt_smp; occt_smp.configure()\n"
            "import builder\n"
            "from builder import import_geometry, rebuild\n"
            "builder._fit_surfaces = lambda s, debug=False, report=None, **_kw: s\n"
            f"doc = json.loads({json.dumps(json.dumps(doc))})\n"
            f"doc['features'][0]['geom'] = import_geometry({path!r}, 'stl')['geom']\n"
            "part, err, _b = rebuild(doc)\n"
            "print('MSG', err[0]['message'] if err else None)\n"
        )
    r = subprocess.run([sys.executable, runner], capture_output=True, text=True)
    print(f"  A18 offsetFace in a subprocess -> exit {r.returncode} "
          f"(139 = SIGSEGV in BRepOffset)")
    assert r.returncode == 0, (
        f"offsetFace on a facet must be refused BEFORE OCCT sees it; the worker "
        f"exited {r.returncode}. stderr tail: {r.stderr[-400:]}")
    assert f"MSG {_REFUSAL}" in r.stdout, (
        f"want the refusal on stdout, got {r.stdout[-400:]!r}")

    # 4. the control that pins the TANGENCY FLOOR. A box with tangent top-edge
    #    fillets: the cap and the fitted r=2 cylinder beside it meet at their
    #    shared edge at 0.000012 degrees. That is not zero, so with no floor at
    #    all this cap refuses and a perfectly ordinary rounded box stops being
    #    editable. _FACET_TANGENT_DEG = 0.05 is what keeps it apart from the
    #    2.014 degrees a cone's leftover facets actually leave.
    from build123d import Axis, Box, fillet as b_fillet

    src = b_fillet(Box(40, 40, 10).edges().filter_by(Axis.Z, reverse=True)
                   .group_by(Axis.Z)[-1], radius=2)
    tf = _stl_of(src, d, "tangent_fillets")
    _part, bodies, _payload = _import_body(tf)
    rounded = bodies[0]["shape"]
    print(f"  A18 tangent-fillet box: {len(rounded.faces())} faces "
          f"{_census(rounded)}, vol {rounded.volume:.3f}")
    assert len(_cylinder_faces(rounded)) == 4, (
        f"precondition: the four top fillets must fit, got {_census(rounded)}")
    payload = import_geometry(tf, "stl")
    part, errors, _b = rebuild({"parameters": {}, "features": [
        {"id": "im", "type": "import", "format": "stl", "name": "m",
         "geom": payload["geom"]},
        {"id": "pp", "type": "press-pull", "face": cap, "distance": 2.0}]})
    print(f"  A18 press/pull a cap ringed by TANGENT fillets +2 -> errors "
          f"{errors}, vol {part.volume:.3f}")
    assert not errors, (
        f"a cap whose neighbours are tangent must stay pressable, got {errors}")
    assert abs(part.volume - (rounded.volume + 2592.0)) < 1.0, (
        f"the 36x36 cap +2 should add 2592 mm^3, got {part.volume:.3f}")

    print("  A18 OK: the facet refuses on both paths, the cap still presses, "
          "no SIGSEGV")


def test_the_facet_refusal_fires_on_native_geometry_and_says_so_honestly():
    """CHARACTERISATION, not an endorsement: the screen has no provenance, so it
    refuses on bodies that were never imported, and the copy has to be true for
    those users too.

    `_facet_of_an_unrecognised_curve` asks one question — is this face a plane
    with a neighbour at a dihedral in (0.05, FIT_SHARP_DEG)? A regular prism's
    side walls meet at the exterior angle 360/n, so every polygon of 15 or more
    sides is inside that window on every wall, and the sketch tool's side count
    is a plain dimension field. A shallow ridge and a face beside a shallow
    lead-in chamfer land there too. None of them imported anything, and with the
    screen removed press/pull on those walls does exactly the right thing.

    WHETHER THE SCREEN SHOULD FIRE ON THEM AT ALL IS OPEN, and deliberately not
    decided here: run length does not separate the two populations (a
    tessellated bore IS an n-gon prism, and at angular tolerance 0.8 a real one
    is a run of 16), narrowing the angle window does not either (native false
    positives measured at 11.4 and 20.4 degrees sit between true positives at
    2.0 and 22.9), and putting the old small-facet area heuristic in front of it
    brings back the BRepOffset SIGSEGV A18 exists to catch. So this test pins
    the two things that are settled: the class is reachable, and the sentence
    the user gets does not blame an import they never did or promise a Clean Up
    that will not help them."""
    docs = []
    for n in (12, 16):
        docs.append((f"{n}-gon prism", [
            {"id": "sk", "type": "sketch", "plane": "XY",
             "entities": [{"type": "polygon", "sides": n, "x": 0, "y": 0,
                           "radius": 10}]},
            {"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10},
        ]))
    seen = {}
    for name, feats in docs:
        part, errors, _b = rebuild({"parameters": {}, "features": feats})
        wall = next(f for f in part.faces() if abs(f.normal_at().Z) < 1e-6)
        hit = builder._facet_of_an_unrecognised_curve(part, [wall])
        seen[name] = hit is not None
        print(f"  {name}: {len(part.faces())} faces, side wall refused="
              f"{hit is not None}")
        assert not errors, errors
    assert seen["12-gon prism"] is False, (
        "a 12-gon's 30-degree walls are outside the window; if this changed, "
        "the false-positive class just got much wider")
    assert seen["16-gon prism"] is True, (
        "a 16-gon's 22.5-degree walls are inside the window — if this stopped "
        "firing, the screen was narrowed and this test should record the new "
        "boundary rather than be deleted")

    msg = builder._FACETED_CURVE_REFUSAL
    assert "re-import" not in msg, (
        f"the message tells a user who never imported anything to re-import: "
        f"{msg}")
    assert "on import" not in msg, (
        f"the message asserts an import that may never have happened: {msg}")
    assert "—" not in msg and "--" not in msg, f"house style: no em-dashes: {msg}"
    print("  OK: the screen fires on native geometry and the copy does not "
          "blame an import for it")


def test_clean_up_refits_an_old_import():
    """Clean Up runs the same fit-first pass, which is the ONLY route to it for
    a document imported before this shipped.

    Those documents store the faceted B-rep in the blob, so nothing re-reads the
    mesh file and the import feature can never fit them. The fixture is built
    the honest way: import with the fitter stubbed (that IS an old document's
    stored geometry), then rebuild the same blob with a cleanUp feature on top
    and no stub.

    AND THE RECOVERY IS ONLY PARTIAL, deliberately. What is stored has already
    been through `_refacet_clean`, which snapped every mesh vertex onto a PLANE
    — up to 0.12 mm, against a bore whose fit tolerance is 5.6e-3 mm. So the
    wall no longer lies on one cylinder and comes back as more than one region:
    measured 23 planes -> 14 faces with 2 cylinders, where a fresh import of the
    same mesh gives 7 faces with 1. That gap is the whole argument for fitting
    BEFORE refacet at import, and pinning it here stops anyone "fixing" Clean Up
    by reordering the import path back."""
    d = tempfile.mkdtemp()
    path, _src = _plate_stl(d, 0.2)
    keep = builder._fit_surfaces
    builder._fit_surfaces = lambda shape, debug=False, report=None, **_kw: shape
    try:
        payload = import_geometry(path, "stl")   # the old, faceted document
    finally:
        builder._fit_surfaces = keep
    imported = {"id": "im", "type": "import", "format": "stl", "name": "m",
                "geom": payload["geom"]}

    before, e0, _b = rebuild({"parameters": {}, "features": [imported]})
    after, e1, bodies = rebuild({"parameters": {}, "features": [
        imported, {"id": "cu", "type": "cleanUp"}]})
    assert not e0 and not e1, (e0, e1)
    radii = sorted(round(_cyl_radius(f), 4) for f in _cylinder_faces(after))
    print(f"  cleanUp: stored {len(before.faces())} faces {_census(before)} "
          f"vol {before.volume:.4f} -> {len(after.faces())} faces "
          f"{_census(after)} vol {after.volume:.4f}, radii {radii}")
    assert _census(before).get("Cylinder", 0) == 0, (
        "precondition: the stored document must be faceted")
    assert len(bodies) == 1 and _is_valid(after) and len(after.solids()) == 1
    assert radii, f"Clean Up recognised nothing, got {_census(after)}"
    # 0.08 mm, not 1e-3: refacet's plane snapping had already pushed the wall
    # OUT before Clean Up ever saw it, so the recovered radii come back high —
    # measured 3.0196 and 3.0579 against a true 3.0, which is judge 1's +1.7%
    # rim inflation read back off the radius instead of off the volume.
    assert all(abs(r - BORE_R) < 0.08 for r in radii), (
        f"a recognised region has the wrong radius: {radii}")
    assert len(after.faces()) < len(before.faces()), (
        f"Clean Up did not simplify: {len(before.faces())} -> {len(after.faces())}")
    assert abs(after.volume - PLATE_VOLUME) / PLATE_VOLUME < 1e-3
    print("  cleanUp OK: an old faceted import recovers its bore (partially, by "
          "design)")


def test_clean_up_says_when_it_recognised_a_cylinder():
    """Clean Up SAYS how many cylinders its fit-first pass recognised, so a
    deliberately faceted body cannot be re-read as round in silence.

    The reach `_handle_clean_up` has in the wrong direction: its screen is "every
    face is a Plane", which a NATIVE many-sided prism passes exactly as readily
    as an old faceted import, and a 48-gon extruded in the app comes back as a
    cylinder with +0.3% volume. There is no provenance to gate on (a Join
    rebuilds the body dict from scratch, so a flag set at import does not survive
    one), so the answer is to say so rather than to refuse: an amber note the
    user can act on by deleting the Clean Up.

    THE ADVISORY RIDES THE CHANNEL `_sealed_void_diag` ALREADY USES — an entry
    appended to the `diagnostics` list `rebuild` is handed, which reaches the
    frontend as `RebuildResult.diagnostics`. NO FRONTEND CHANGE IS NEEDED for the
    chip: `timeline.ts` `diagMap` keys the amber marker on "has a diagnostic and
    no error", deliberately generic rather than on a list of codes, so this
    lights the day it lands. `cleanUpFitted` is NOT in `repickReference.ts`'s
    REPAIRABLE_CODES, which is right: there is no reference to re-pick, only a
    feature to delete. (`kind` gained the string in src/types.ts; that is a
    documentation-only addition to a union, not behaviour.)

    The control is the load-bearing half. A diagnostic that fired whenever Clean
    Up CHANGED something would be noise on every debris cleanup, so the second
    leg runs Clean Up on a body that is genuinely repaired by the refacet pass
    and asserts SILENCE: the count is the delta in the cylinder census, not "did
    anything happen"."""
    d = tempfile.mkdtemp()
    path, _src = _plate_stl(d, 0.2)
    keep = builder._fit_surfaces
    builder._fit_surfaces = lambda shape, debug=False, report=None, **_kw: shape
    try:
        payload = import_geometry(path, "stl")   # the old, faceted document
    finally:
        builder._fit_surfaces = keep
    imported = {"id": "im", "type": "import", "format": "stl", "name": "m",
                "geom": payload["geom"]}

    diags = []
    after, errors, bodies = rebuild({"parameters": {}, "features": [
        imported, {"id": "cu", "type": "cleanUp"}]}, diagnostics=diags)
    assert not errors, errors
    n_cyl = len(_cylinder_faces(after))
    mine = [x for x in diags if x.get("code") == "cleanUpFitted"]
    print(f"  cleanUp on an old import: {n_cyl} cylinder(s) recognised, "
          f"{len(diags)} diagnostic(s) {[x.get('code') for x in diags]}")
    assert n_cyl > 0, (
        f"precondition: Clean Up must recognise something here, got "
        f"{_census(after)}")
    assert len(mine) == 1, (
        f"Clean Up recognised {n_cyl} cylinder(s) and said nothing about it: "
        f"{diags}")
    got = mine[0]
    print(f"    reason: {got.get('reason')!r}")
    assert got["feature_id"] == "cu", (
        f"the note must hang on the Clean Up feature, got {got.get('feature_id')!r}")
    assert str(n_cyl) in got["reason"], (
        f"the note must carry the COUNT ({n_cyl}): {got['reason']!r}")
    assert "delete this Clean Up" in got["reason"], (
        f"the note must say what to do about it: {got['reason']!r}")
    assert "—" not in got["reason"], f"house style: no em-dashes: {got['reason']!r}"
    # neutral values, exactly as `_sealed_void_diag` carries them: nothing was
    # RESOLVED here. `lossy` must stay False — it is the flag project_geometry
    # refuses a source selection on.
    assert got["resolved"] == 0 and got["confidence"] == 0.0
    assert got["lossy"] is False, "lossy would make this look like a marginal match"

    # ...and the control: a body the refacet pass really does repair, where
    # nothing round was recognised, must pass in silence. The staircase is
    # imported with `_refacet_clean` STUBBED, for the same reason the fixture
    # above stubs the fitter: the import path already cleans it, so the only way
    # to reach a Clean Up that has real work to do is to store the uncleaned
    # body first. That is what makes this a control and not a tautology — Clean
    # Up demonstrably CHANGES this body and still says nothing.
    d2 = tempfile.mkdtemp()
    stair = _stl_of(_staircase_box(), d2, "stair")
    keep_rf = builder._refacet_clean
    builder._refacet_clean = lambda shape, tol=0.12, debug=False: shape
    try:
        stair_payload = import_geometry(stair, "stl")
    finally:
        builder._refacet_clean = keep_rf
    stair_import = {"id": "im", "type": "import", "format": "stl", "name": "s",
                    "geom": stair_payload["geom"]}
    q_diags = []
    before_s, e0, _b = rebuild({"parameters": {}, "features": [stair_import]})
    quiet, e1, _b2 = rebuild({"parameters": {}, "features": [
        stair_import, {"id": "cu2", "type": "cleanUp"}]}, diagnostics=q_diags)
    assert not e0 and not e1, (e0, e1)
    print(f"  cleanUp on a staircase: {len(before_s.faces())} -> "
          f"{len(quiet.faces())} faces {_census(quiet)}, "
          f"{len(q_diags)} diagnostic(s)")
    assert len(quiet.faces()) < len(before_s.faces()), (
        f"precondition: Clean Up must actually repair the control body, "
        f"{len(before_s.faces())} -> {len(quiet.faces())} faces")
    assert _census(quiet).get("Cylinder", 0) == 0, (
        "precondition: the control body must have nothing round in it")
    assert not [x for x in q_diags if x.get("code") == "cleanUpFitted"], (
        f"Clean Up claimed a recognition on a body with no cylinder in it: "
        f"{q_diags}")
    print("  OK: Clean Up names its recognitions, and stays quiet when there "
          "were none")


def test_clean_up_cannot_re_fit_a_body_that_already_carries_a_cylinder():
    """CHARACTERISATION: Clean Up is a no-op on a PARTIALLY fitted body, which is
    what a mesh import ships from now on.

    `_fit_surfaces` screens out any shape with a single non-planar face
    ("already carries analytic surfaces (STEP)") before it does anything else,
    and `_refacet_clean` has the identical planar-only screen. So the moment one
    cylinder is recognised, both passes return the input object and Clean Up
    reduces to `_unify_body`. On the reporter's file that is a body of 1,482
    faces of which 914 refuse press/pull, and no amount of Clean Up moves any of
    them.

    Pinned because the refusal copy has to stay honest about it: the message
    names "a mesh body that is still entirely faceted", which is the shape the
    test above covers and NOT this one. Making the screen per-face is a real
    option for a later version (measured: 1,482 -> 1,360 faces, 300 -> 341
    cylinders on the reporter's file), but it also needs the body gate's
    whole-shape cylinder count relaxed, and with that done a deliberate native
    60-sided prism was measured collapsing into a cylinder. Whoever takes that
    on should turn this test around rather than delete it."""
    from build123d import Cone

    d = tempfile.mkdtemp()
    # a cone fits some strips and declines the rest: partly analytic, partly
    # facets, which is exactly the body a user picks a refusing face on
    path = _stl_of(Cone(8, 0, 20), d, "cone")
    part, bodies, _p = _import_body(path)
    assert _cylinder_faces(part), "precondition: something must have been fitted"
    refusing = sum(
        1 for f in part.faces()
        if builder._facet_of_an_unrecognised_curve(part, [f]) is not None)
    assert refusing, "precondition: something must still refuse"

    src = bodies[0]["shape"]
    assert builder._fit_surfaces(src) is src, (
        "the fitter re-fitted a partially fitted body; if that is now possible, "
        "the refusal copy may promise Clean Up outright")
    assert builder._refacet_clean(src) is src, (
        "the debris cleaner touched a body carrying an analytic face")
    print(f"  partially fitted body: {len(part.faces())} faces {_census(part)}, "
          f"{refusing} refuse press/pull, and both Clean Up passes decline it")


def _fit_signature(shape):
    """A canonical, ORDER-FREE description of what the fitter accepted: one
    tuple per fitted region (cylinder, cone, sphere or torus), sorted.

    Every number is read through the adaptor and rounded to 9 decimals, which is
    three orders finer than the tightest tolerance anything in the fitter uses,
    so this cannot round two genuinely different fits together. Sorted rather
    than in face order because the question A17 asks is whether the same REGIONS
    came out, not whether the sewer happened to lay them down the same way; the
    blob digest beside it is the stricter, order-sensitive half."""
    out = []
    for f in shape.faces():
        kind, params = _surface(f)
        if kind == "Plane":
            continue

        def _flat(p):
            for v in p:
                if isinstance(v, tuple):
                    yield from _flat(v)
                else:
                    yield v

        out.append((kind, round(_signed_area(f), 9),
                    tuple(round(v, 9) for v in _flat(params))))
    return tuple(sorted(out))


def _fit_run(path):
    """(blob digest, region signature) for one import of `path`."""
    payload = import_geometry(path, "stl")
    _part, _err, bodies = rebuild({"parameters": {}, "features": [
        {"id": "im", "type": "import", "format": "stl", "name": "m",
         "geom": payload["geom"]}]})
    return payload["geom"], _fit_signature(bodies[0]["shape"])


def test_a17_the_same_mesh_always_fits_the_same_way():
    """A17: two runs in this process and one in a fresh one produce the same
    regions AND the same stored geometry, byte for byte.

    Determinism is not a nicety here, it is what makes selectors survive. A
    fitted face is addressed by a geometric fingerprint, so a fit that came out
    differently on the next open would silently re-point every fillet and
    press/pull the user had put on it. The fitter is full of places where that
    could leak: a set iterated instead of a sorted list, `argsort` without
    `kind='stable'`, seeds ordered by an area that ties.

    THE FILLETED BOX IS THE FIXTURE THAT MATTERS. Its four quadrants have
    EXACTLY equal area, so the greedy claimer's primary key ties on all four and
    the integer tiebreak is the only thing deciding the order. A run keyed off
    dict or set iteration order would still pass on a body with one bore. The
    ROUNDED box does the same for the cones/spheres/tori pass: eight spheres of
    exactly equal area, each found once from each of three axes.

    The digest holds across processes (measured, both fixtures, six runs in two
    interpreters), so it is asserted rather than the tuples alone."""
    import json
    import subprocess

    from build123d import Axis, Box, Cylinder, Pos, fillet as b_fillet

    d = tempfile.mkdtemp()
    two_bores = _stl_of(
        Box(40, 40, 10) - Pos(-10, 0, 0) * Cylinder(3, 20)
        - Pos(10, 0, 0) * Cylinder(5, 20), d, "two_bores")
    fillets = _stl_of(
        b_fillet(Box(40, 40, 10).edges().filter_by(Axis.Z), radius=1), d, "fillets")
    rounded = _stl_of(b_fillet(Box(30, 20, 10).edges(), radius=2), d, "rounded")
    cases = (("two bores", two_bores), ("filleted box", fillets), ("rounded box", rounded))

    here = os.path.dirname(os.path.abspath(builder.__file__))
    runner = os.path.join(d, "fit_twice.py")
    with open(runner, "w") as fh:
        fh.write(
            "import json, os, sys\n"
            f"sys.path.insert(0, {here!r})\n"
            "os.environ['SINDRI_DISK_CACHE'] = '0'\n"
            "import occt_smp; occt_smp.configure()\n"
            # the test module itself, so the subprocess reads the regions with
            # the SAME helper rather than a second copy of it that could drift
            "import test_surface_fit as T\n"
            "print('OUT', json.dumps([T._fit_run(p) for p in sys.argv[1:]]))\n"
        )

    for name, path in cases:
        a = _fit_run(path)
        b = _fit_run(path)
        print(f"  A17 {name}: run 1 digest {a[0][:16]}... {len(a[1])} regions | "
              f"run 2 digest {b[0][:16]}... {len(b[1])} regions")
        assert a[1], f"precondition: {name} must fit something"
        assert a == b, (
            f"{name} fitted differently on the second run in the SAME process:\n"
            f"  {a}\n  {b}")

    r = subprocess.run([sys.executable, runner] + [p for _n, p in cases],
                       capture_output=True, text=True)
    assert r.returncode == 0, f"the subprocess exited {r.returncode}: {r.stderr[-500:]}"
    line = next(ln for ln in r.stdout.splitlines() if ln.startswith("OUT "))
    fresh = json.loads(line[4:])
    for (name, path), got in zip(cases, fresh):
        mine = _fit_run(path)
        # json has no tuples: compare the round trip so the shapes match.
        assert got[0] == mine[0], (
            f"{name}: a fresh interpreter stored a DIFFERENT body — digest "
            f"{got[0][:16]}... against {mine[0][:16]}...")
        assert got[1] == json.loads(json.dumps(mine[1])), (
            f"{name}: a fresh interpreter found different regions:\n"
            f"  {got[1]}\n  {mine[1]}")
        print(f"  A17 {name} in a fresh interpreter: same digest {got[0][:16]}..., "
              f"same {len(got[1])} regions")

    print("  A17 OK: same regions and the same stored bytes, twice here and "
          "once elsewhere")


def test_the_import_reply_says_what_was_recognised():
    """The import reply carries `fitted` and `faceted`, and `faceted` counts the
    faces the tools will actually refuse.

    Without this the feature is invisible: a faceted import and a fitted one
    both "work", and the user finds out which they got when press/pull refuses
    on a wall. `describeSurfaceFit` in src/io/files.ts turns the two numbers into
    the toast, so what it says has to be the truth about the body.

    `faceted` is NOT "faces that are not cylinders". A plate's six walls are
    real planes and reporting six as faceted would be a lie. It is the count of
    faces that are one facet of a curve nobody recognised, and the leg below
    pins it against `_facet_of_an_unrecognised_curve` face by face — the two
    readings are written separately (the guard short-circuits, a census cannot)
    and this is what stops them drifting apart."""
    from build123d import Cone

    d = tempfile.mkdtemp()
    plate, _src = _plate_stl(d, 0.2)
    payload = import_geometry(plate, "stl")
    print(f"  reply for the plate: fitted {payload.get('fitted')}, faceted "
          f"{payload.get('faceted')}, faces {payload['faces']}, "
          f"fitSkipped {payload.get('fitSkipped')!r}")
    assert payload["fitted"] == 1, (
        f"the plate's bore is one recognised surface, got {payload.get('fitted')}")
    assert payload["faceted"] == 0, (
        f"nothing on a fully fitted plate is still a facet, got "
        f"{payload.get('faceted')}")
    assert "fitSkipped" not in payload, (
        f"nothing was skipped, so the reply must not say one was: "
        f"{payload.get('fitSkipped')!r}")

    # A fit that was BUILT and then thrown away has to say so. That is the one
    # reason the sidecar ever sends, and until this leg existed nothing at any
    # layer observed it reaching the reply: the sidecar asserted only that
    # `fitSkipped` is ABSENT on a fully fitted plate, and the vitest exercises
    # `describeSurfaceFit`, a pure function a broken propagation cannot reach.
    # Three separate mutations of the plumbing (dropping the branch that copies
    # `report["skipped"]` into the reply, making `_skipped` a no-op, dropping
    # the `report=` argument) all left the whole suite ALL PASS.
    #
    # Forced with A15's stub, because no fixture here reaches the state on its
    # own — which is the point. It pins the SEW-checks writer plus the whole
    # chain from there to the reply; the body-gate writer is a second call site
    # of the same helper and survives this leg on its own.
    keep = builder._rebuild_planar_face
    builder._rebuild_planar_face = lambda face, swaps: None
    try:
        declined = import_geometry(plate, "stl")
    finally:
        builder._rebuild_planar_face = keep
    print(f"  reply for a plate whose fit failed its checks: fitted "
          f"{declined.get('fitted')}, faceted {declined.get('faceted')}, "
          f"fitSkipped {declined.get('fitSkipped')!r}")
    assert declined.get("fitSkipped") == "checks", (
        f"a fit that was built and thrown away must say so, got "
        f"{declined.get('fitSkipped')!r}")
    assert declined.get("fitted") == 0, (
        f"nothing was recognised, so `fitted` must be 0, got "
        f"{declined.get('fitted')}")

    # A cone is the honest partial case: v1 fits no cones, so a strip or two
    # comes back as a cylinder and the rest stays as tessellation.
    cone = _stl_of(Cone(8, 0, 20), d, "cone")
    payload = import_geometry(cone, "stl")
    _part, bodies, _p = _import_body(cone)
    body = bodies[0]["shape"]
    faces = body.faces()
    refused = sum(
        1 for f in faces
        if builder._facet_of_an_unrecognised_curve(body, [f]) is not None)
    print(f"  reply for a cone: fitted {payload['fitted']}, faceted "
          f"{payload['faceted']}, faces {payload['faces']} {_census(body)}; the "
          f"press/pull guard refuses {refused} of them")
    assert payload["fitted"] == len(_cylinder_faces(body)), (
        f"`fitted` must be the cylinder census: {payload['fitted']} against "
        f"{len(_cylinder_faces(body))}")
    assert payload["faceted"] == refused, (
        f"`faceted` promises the toast and the tools agree: the reply says "
        f"{payload['faceted']}, the guard refuses {refused}")
    assert 0 < payload["faceted"] < payload["faces"], (
        f"precondition: a cone must be PARTLY faceted, got {payload['faceted']} "
        f"of {payload['faces']}")

    # A STEP import never runs the fitter, so it must send none of these rather
    # than a row of zeros the toast would have to guess at.
    from build123d import Box, export_step

    step = os.path.join(d, "native.step")
    export_step(Box(10, 10, 10), step)
    native = import_geometry(step, "step")
    print(f"  reply for a STEP: keys {sorted(native)}")
    assert "fitted" not in native and "faceted" not in native, (
        f"a STEP import claimed a fitting result: {sorted(native)}")
    print("  OK: both counts on a mesh, silence on a STEP")


if __name__ == "__main__":
    test_a1_census()
    test_fit_cylinder_is_a_cylinder_fitter_and_nothing_else()
    test_a6_radius_and_residual()
    test_a3_volume_beats_the_faceted_import()
    test_a4_still_a_closed_valid_solid()
    test_a11_unify_after_fitting_changes_nothing()
    test_a12_edge_tolerance_stays_sagitta_sized()
    test_a15_the_rim_is_one_circle()
    test_a7_nearest_picks_the_bore_as_one_cylinder()
    test_a8_press_pull_the_bore_wall()
    test_a9_delete_face_removes_the_bore()
    test_a10_a_body_with_nothing_to_fit_is_the_same_object()
    test_a16_a_mixed_body_is_never_worse()
    test_one_body_does_not_decide_another_bodys_fit()
    test_the_debris_cleaner_is_not_run_once_the_fit_has_already_won()
    test_clean_up_leaves_a_sealed_void_alone()
    test_a13_fillet_strips()
    test_a14_two_bores_of_different_radii()
    test_a_blend_around_a_rim_comes_back_as_one_torus()
    test_a_countersink_and_a_chamfer_come_back_as_cones()
    test_rounded_box_corners_come_back_as_spheres()
    test_the_reporters_corners_come_back_as_their_design()
    test_cones_spheres_and_tori_need_a_recognised_axis()
    test_anywhere_on_the_bed_and_either_way_up()
    test_a_refused_body_still_gets_its_cylinders()
    test_a18_a_facet_of_an_unrecognised_curve_refuses()
    test_the_facet_refusal_fires_on_native_geometry_and_says_so_honestly()
    test_a17_the_same_mesh_always_fits_the_same_way()
    test_the_import_reply_says_what_was_recognised()
    test_clean_up_refits_an_old_import()
    test_clean_up_says_when_it_recognised_a_cylinder()
    test_clean_up_cannot_re_fit_a_body_that_already_carries_a_cylinder()
    test_an_old_clean_up_keeps_rebuilding_the_way_it_did()
    test_the_reporters_file_when_it_is_here()
    print("ALL PASS")
