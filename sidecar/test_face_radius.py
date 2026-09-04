"""A recognised cylinder face must answer `radius`, however its surface is wrapped.

GH #49 (surface fitting on mesh import). The fitter builds each recognised
cylinder the only way OCCT lets you build one from a fitted axis and a boundary
of existing edges:

    BRepBuilderAPI_MakeFace(Geom_CylindricalSurface(...), wire, True) + ShapeFix_Face

ShapeFix_Face re-wraps the surface in a `Geom_RectangularTrimmedSurface`, and
build123d's `Face.radius` explicitly returns None for a trimmed surface
(two_d.py:1245 — `... and not isinstance(self.geom_adaptor(), Geom_RectangularTrimmedSurface)`).
So the face still reports GeomType.CYLINDER, still measures the right area, and
still IS a cylinder of radius 3 — but every radius-aware path in geom_select
read None and silently skipped it:

  * `query_entities(body, 'face', {'surface':'cylinder','radius':{...}})` returned
    ZERO hits on a fitted bore, which is the selector a user (or the MCP bridge)
    reaches for first;
  * `face_fingerprint` omitted `radius`, so every saved `by:"match"` reference to
    a fitted face was authored WEAKER than the same reference on a native
    cylinder — it had to separate concentric bores on centroid and area alone.

The fix is a fallback through `BRepAdaptor_Surface`, which resolves the trim and
reports the underlying analytic surface. Rebuilding the face on
`Geom_RectangularTrimmedSurface.BasisSurface()` does NOT work (judge 1 measured
it), so the adaptor is the route.

WHY BOTH LEGS MATTER. The query leg alone would pass with a fingerprint that
still dropped `radius`; the fingerprint leg alone would pass with a query that
still missed. They are separate call sites of the same helper, and this suite
pins both plus a native control (a face built by the kernel, whose surface is
NOT trimmed) so a "fix" that broke ordinary cylinders would fail here.

The sphere leg is included because build123d's `Face.radius` covers CYLINDER and
SPHERE through the same trimmed-surface refusal — the fallback has to cover both
or the sphere half stays quietly broken. No sphere is FITTED in this PR; this is
the helper's contract, not an import claim.

Run:  uv run python test_face_radius.py
"""

import math
import os

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

import occt_smp  # noqa: E402

occt_smp.configure()

from build123d import Cylinder, Face, Solid, Sphere  # noqa: E402
from OCP.BRep import BRep_Tool  # noqa: E402
from OCP.BRepBuilderAPI import (  # noqa: E402
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakeWire,
    BRepBuilderAPI_Sewing,
)
from OCP.Geom import (  # noqa: E402
    Geom_CylindricalSurface,
    Geom_RectangularTrimmedSurface,
    Geom_SphericalSurface,
)
from OCP.gp import gp_Ax2, gp_Ax3, gp_Circ, gp_Dir, gp_Pnt  # noqa: E402
from OCP.ShapeFix import ShapeFix_Face, ShapeFix_Shape, ShapeFix_Solid  # noqa: E402
from OCP.TopAbs import TopAbs_ShapeEnum  # noqa: E402
from OCP.TopExp import TopExp_Explorer  # noqa: E402
from OCP.TopoDS import TopoDS  # noqa: E402

from geom_select import face_fingerprint, query_entities  # noqa: E402

PASS = "  ok"

R = 3.0
H = 10.0
SPHERE_R = 4.0


# --- fixtures ----------------------------------------------------------------


def _rim_wire(z):
    circ = gp_Circ(gp_Ax2(gp_Pnt(0, 0, z), gp_Dir(0, 0, 1)), R)
    edge = BRepBuilderAPI_MakeEdge(circ).Edge()
    return BRepBuilderAPI_MakeWire(edge).Wire()


def _fitted_tube():
    """A closed solid whose lateral face was BUILT THE WAY THE FITTER BUILDS ONE:
    an analytic Geom_CylindricalSurface trimmed by two existing circular edges,
    then ShapeFix_Face. The two rims are shared by identity with the planar caps,
    so the sew has nothing to bridge (the prototype's route).

    Returns (solid, lateral_face)."""
    surf = Geom_CylindricalSurface(gp_Ax3(gp_Pnt(0, 0, -H / 2), gp_Dir(0, 0, 1)), R)
    bottom, top = _rim_wire(-H / 2), _rim_wire(H / 2)

    mk = BRepBuilderAPI_MakeFace(surf, bottom, True)
    mk.Add(top)
    fix = ShapeFix_Face(mk.Face())
    fix.Perform()
    lateral = fix.Face()

    caps = [BRepBuilderAPI_MakeFace(w).Face() for w in (bottom, top)]

    sew = BRepBuilderAPI_Sewing(1e-3, True, True, True, False)
    sew.Add(lateral)
    for c in caps:
        sew.Add(c)
    sew.Perform()
    shell = sew.SewedShape()

    sfs = ShapeFix_Shape(shell)
    sfs.Perform()
    exp = TopExp_Explorer(sfs.Shape(), TopAbs_ShapeEnum.TopAbs_SHELL)
    assert exp.More(), "the hand-built tube did not sew into a shell"
    solid = Solid(ShapeFix_Solid().SolidFromShell(TopoDS.Shell_s(exp.Current())))

    lat = [f for f in solid.faces() if str(f.geom_type) == "GeomType.CYLINDER"]
    assert len(lat) == 1, f"expected one cylinder face, got {len(lat)}"
    return solid, lat[0]


def _trimmed_sphere_face():
    """A spherical face whose surface is explicitly rectangular-trimmed — the same
    wrapper ShapeFix_Face puts around the fitted cylinder, reached directly
    because a hand-built sphere patch does not need a sew to exhibit it."""
    sph = Geom_SphericalSurface(gp_Ax3(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), SPHERE_R)
    trimmed = Geom_RectangularTrimmedSurface(sph, 0.0, math.pi, 0.0, math.pi / 2)
    return Face(BRepBuilderAPI_MakeFace(trimmed, 1e-6).Face())


# --- tests -------------------------------------------------------------------


def test_the_fixture_really_is_the_trimmed_surface_trap():
    """Guard on the FIXTURE, not the code under test. If a future OCCT or
    build123d stops wrapping the fitted face in Geom_RectangularTrimmedSurface,
    every assertion below would pass for the wrong reason — the fallback would
    never be exercised and this suite would read as coverage while covering
    nothing. Fail loudly instead."""
    _, lat = _fitted_tube()
    surf = BRep_Tool.Surface_s(lat.wrapped)
    assert isinstance(surf, Geom_RectangularTrimmedSurface), (
        f"fixture no longer reproduces the trap: surface is {type(surf).__name__}. "
        "Rebuild it so ShapeFix_Face's trimmed wrapper is present, or this suite "
        "is testing nothing.")
    assert lat.radius is None, (
        f"build123d Face.radius now answers {lat.radius} on a trimmed surface; the "
        "fallback is no longer the thing under test")
    assert str(lat.geom_type) == "GeomType.CYLINDER", lat.geom_type
    assert abs(lat.area - 2 * math.pi * R * H) < 1e-6, lat.area
    print(PASS, f"fixture is trimmed, reports CYLINDER, area {lat.area:.4f}, "
                f"Face.radius {lat.radius}")


def test_a_fitted_cylinder_is_found_by_a_radius_query():
    """THE user-facing leg. `{'surface':'cylinder','radius':{...}}` is the first
    selector anybody reaches for on a bore. Today it returns 0 on a fitted one."""
    solid, _ = _fitted_tube()
    hits = query_entities(solid, "face",
                          {"surface": "cylinder", "radius": {"min": 2.9, "max": 3.1}})
    assert len(hits) == 1, (
        f"radius query found {len(hits)} faces on the fitted tube, expected 1 "
        f"(R={R}); the trimmed surface hid it")
    assert str(hits[0].geom_type) == "GeomType.CYLINDER", hits[0].geom_type
    print(PASS, f"radius query on a fitted cylinder -> {len(hits)} face")


def test_a_radius_query_still_excludes_the_wrong_radius():
    """The fallback must not answer a number that matches everything. A band that
    excludes 3.0 has to come back empty, or the leg above would pass with a
    fallback that returned a constant."""
    solid, _ = _fitted_tube()
    hits = query_entities(solid, "face",
                          {"surface": "cylinder", "radius": {"min": 4.9, "max": 5.1}})
    assert len(hits) == 0, f"a 4.9-5.1 band matched {len(hits)} faces on an R={R} tube"
    print(PASS, "a band that excludes 3.0 matches nothing")


def test_the_fingerprint_of_a_fitted_cylinder_carries_its_radius():
    """The persistence leg. Without this, every saved by:"match" reference to a
    fitted face is authored weaker than the same reference on a native one."""
    solid, lat = _fitted_tube()
    fp = face_fingerprint(lat, solid)
    assert "radius" in fp, (
        f"face_fingerprint dropped radius on a fitted cylinder: keys {sorted(fp)}")
    assert abs(fp["radius"] - R) < 1e-9, fp["radius"]
    assert fp["surface"] == "cylinder", fp
    print(PASS, f"fingerprint carries radius {fp['radius']:.6f}")


def test_the_native_control_is_unchanged():
    """A kernel-built cylinder is NOT trimmed, so it went through the old path and
    must keep going through it, with the same answers."""
    nat = Cylinder(R, H)
    lat = [f for f in nat.faces() if str(f.geom_type) == "GeomType.CYLINDER"][0]
    assert not isinstance(BRep_Tool.Surface_s(lat.wrapped), Geom_RectangularTrimmedSurface)
    assert lat.radius == R, lat.radius

    hits = query_entities(nat, "face",
                          {"surface": "cylinder", "radius": {"min": 2.9, "max": 3.1}})
    assert len(hits) == 1, f"native control: {len(hits)} hits, expected 1"
    fp = face_fingerprint(lat, nat)
    assert abs(fp["radius"] - R) < 1e-12, fp["radius"]

    # and the planar caps, which have no radius at all, stay out of it
    caps = query_entities(nat, "face", {"surface": "plane"})
    assert len(caps) == 2, len(caps)
    for c in caps:
        cfp = face_fingerprint(c, nat)
        assert "radius" not in cfp, f"a planar cap grew a radius: {cfp}"
    print(PASS, f"native cylinder still answers {lat.radius}, planar caps carry no radius")


def test_a_trimmed_sphere_answers_its_radius_too():
    """`Face.radius` refuses a trimmed SPHERE for exactly the same reason, so the
    fallback covers both or the sphere half stays broken."""
    sf = _trimmed_sphere_face()
    assert sf.radius is None, f"fixture is not trimmed any more: {sf.radius}"
    assert str(sf.geom_type) == "GeomType.SPHERE", sf.geom_type

    from geom_select import _face_radius

    got = _face_radius(sf)
    assert got is not None and abs(got - SPHERE_R) < 1e-9, (
        f"_face_radius on a trimmed sphere returned {got}, expected {SPHERE_R}")

    nat = Sphere(SPHERE_R)
    nfp = face_fingerprint(nat.faces()[0], nat)
    assert abs(nfp["radius"] - SPHERE_R) < 1e-12, nfp["radius"]
    print(PASS, f"trimmed sphere -> {got}, native sphere -> {nfp['radius']}")


def test_a_face_with_no_radius_is_still_None():
    """Standard_NoSuchObject: BRepAdaptor_Surface.Cylinder() RAISES on a plane
    (measured), so the fallback has to gate on the adaptor's type rather than
    try/except its way through every face in a dense body."""
    from geom_select import _face_radius

    for f in Cylinder(R, H).faces():
        if str(f.geom_type) == "GeomType.PLANE":
            assert _face_radius(f) is None, _face_radius(f)
    print(PASS, "a planar face still reports no radius")


def main():
    print("Face-radius tests (GH #49: the trimmed-surface trap)")
    test_the_fixture_really_is_the_trimmed_surface_trap()
    test_a_fitted_cylinder_is_found_by_a_radius_query()
    test_a_radius_query_still_excludes_the_wrong_radius()
    test_the_fingerprint_of_a_fitted_cylinder_carries_its_radius()
    test_the_native_control_is_unchanged()
    test_a_trimmed_sphere_answers_its_radius_too()
    test_a_face_with_no_radius_is_still_None()
    print("ALL PASS")


if __name__ == "__main__":
    main()
