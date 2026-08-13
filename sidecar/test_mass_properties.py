"""Exact kernel mass properties (builder.mass_properties, op `massProperties`).

Run: uv run python test_mass_properties.py

THE ORACLES ARE ALL CURVED, DELIBERATELY. The app already shows volume, area,
mass and centre of mass, computed from the display tessellation — and on a BOX
that agrees with the exact answer to ~1e-9. So a box-only suite passes even if
this op secretly called the mesh maths, which is the whole thing it exists to
replace. Only curved bodies discriminate:

    sphere r10      exact 4188.790205   mesh 4128.755079   -1.4332%
    cylinder r5 h20 exact 1570.796327   mesh 1555.551818   -0.9705%

Every expected value below is derived analytically, not captured from a run.
"""

import math
import os

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

from build123d import Box, Compound, Cone, Cylinder, Pos, Shell, Solid, Sphere  # noqa: E402

from builder import mass_properties, rebuild  # noqa: E402

PASS = "  ok"


def _one(shape, checks=False):
    return mass_properties([{"id": "b1", "name": "B", "shape": shape}],
                           checks=checks)["bodies"][0]


def _close(a, b, rel=1e-9):
    return abs(a - b) <= rel * max(abs(a), abs(b), 1.0)


def test_curved_volume_and_area_are_exact_not_tessellated():
    r = 10.0
    s = _one(Sphere(r))
    assert s["measured"] is True, s
    want_v = 4.0 / 3.0 * math.pi * r ** 3       # 4188.790204786391
    want_a = 4.0 * math.pi * r ** 2             # 1256.6370614359172
    assert _close(s["volume"], want_v), f"sphere volume {s['volume']} != {want_v}"
    assert _close(s["area"], want_a), f"sphere area {s['area']} != {want_a}"
    # the mesh answer, which this must NOT be
    assert abs(s["volume"] - 4128.755079) > 1.0, "that is the tessellated volume"

    c = _one(Cylinder(5, 20))
    want_v = math.pi * 25.0 * 20.0             # 1570.796326794897
    assert _close(c["volume"], want_v), f"cylinder volume {c['volume']} != {want_v}"
    assert abs(c["volume"] - 1555.551818) > 1.0, "that is the tessellated volume"
    print(PASS, "curved volume and area are exact, not tessellated")


def test_centre_of_mass_is_exact_where_volume_alone_would_not_show_it():
    """A cone's centroid is a quarter of the way up from its base — h/4. Volume
    can look right while the centre is wrong, so this is the assertion that
    catches a COM taken from triangles."""
    h = 12.0
    rec = _one(Cone(6, 0, h))
    want_z = -h / 4.0  # build123d centres the cone on the origin: base at -h/2
    assert _close(rec["com"][2], want_z, 1e-9), \
        f"cone COM z {rec['com'][2]} != {want_z}"
    assert _close(rec["com"][0], 0.0, 1e-6) and _close(rec["com"][1], 0.0, 1e-6), rec["com"]
    print(PASS, f"cone centre of mass is exactly h/4 from the base ({want_z})")


def test_totals_aggregate_correctly_across_bodies():
    """One document discriminates three things at once: exact volume, exact area,
    and — the one an unweighted mean gets catastrophically wrong — the total
    centre of mass."""
    bodies = [
        {"id": "b1", "name": "big", "shape": Sphere(10)},
        {"id": "b2", "name": "small", "shape": Pos(40, 0, 0) * Sphere(5)},
    ]
    res = mass_properties(bodies)
    t = res["total"]
    assert t["bodies"] == 2, t

    v1 = 4.0 / 3.0 * math.pi * 1000.0
    v2 = 4.0 / 3.0 * math.pi * 125.0
    assert _close(t["volume"], v1 + v2), f"{t['volume']} != {v1 + v2}"     # 1500pi
    assert _close(t["area"], 4 * math.pi * 100 + 4 * math.pi * 25)         # 500pi

    # volume-weighted: (v1*0 + v2*40) / (v1+v2) = 40 * 125/1125 = 40/9
    want_x = 40.0 * 125.0 / 1125.0
    assert _close(t["com"][0], want_x), f"total COM x {t['com'][0]} != {want_x}"
    assert abs(t["com"][0] - 20.0) > 1.0, \
        "20.0 is the UNWEIGHTED mean of the two centres — the weighting is missing"
    assert _close(t["com"][1], 0.0, 1e-6) and _close(t["com"][2], 0.0, 1e-6), t["com"]

    # the union box, not a box of the merged compound
    assert t["bbox"]["min"][0] <= -10.0 and t["bbox"]["max"][0] >= 45.0, t["bbox"]
    print(PASS, f"totals aggregate exactly; COM is volume-weighted ({want_x})")


def test_counts_use_the_addressable_convention():
    """A sphere is ONE face and ONE seam edge through build123d. The raw topology
    map reports 3 edges (it includes degenerates), and a selector cannot address
    those — so a caller told 3 has been misled by its own measurement surface."""
    s = _one(Sphere(10))
    assert s["counts"] == {"solids": 1, "shells": 1, "faces": 1, "edges": 1,
                           "vertices": 2}, s["counts"]
    b = _one(Box(10, 10, 10))
    assert b["counts"]["faces"] == 6 and b["counts"]["edges"] == 12, b["counts"]
    print(PASS, "counts follow the addressable (build123d) convention")


def test_an_open_shell_is_not_integrated_as_though_it_were_closed():
    """The OnlyClosed regression. With the 2-arg GProp call a solid-plus-open-shell
    compound reports Mass -26.909 at x=10.07 where the right answer is 64.0 at
    x=50.0 — and taking |V| turns that into a CONFIDENT WRONG POSITIVE."""
    lone = _one(Shell(Box(10, 10, 10).faces()[1:]))
    assert lone["measured"] is False and lone["reason"] == "no solid", lone
    assert "volume" not in lone, "an unmeasurable body must carry no numbers at all"

    mixed = Compound(children=[Pos(50, 0, 0) * Box(4, 4, 4),
                               Shell(Box(10, 10, 10).faces()[1:])])
    rec = _one(mixed)
    assert _close(rec["volume"], 64.0), f"volume {rec['volume']} != 64.0 (the box alone)"
    assert _close(rec["com"][0], 50.0, 1e-6), f"COM x {rec['com'][0]} != 50.0"
    print(PASS, "an open shell contributes no volume and does not drag the centre")


def test_nested_compounds_are_summed_not_read_off_the_top_level():
    """`Compound.volume` sums one level and returns 0 on a nested compound — not a
    partial figure, ZERO. A total built from it would be silently empty."""
    inner = Compound(children=[Box(10, 10, 10), Pos(20, 0, 0) * Box(2, 2, 2)])
    rec = _one(Compound(children=[inner]))
    assert _close(rec["volume"], 1008.0), f"nested volume {rec['volume']} != 1008.0"
    print(PASS, "a nested compound reports 1008.0, not the 0 its own property gives")


def test_unmeasurable_bodies_report_why_and_stay_out_of_the_total():
    empty = _one(Box(1, 1, 1) - Box(5, 5, 5))
    assert empty["measured"] is False and empty["reason"] == "empty", empty
    assert "bbox" not in empty, "an empty body must not contribute a point-box"

    failed = _one(None)
    assert failed["measured"] is False and failed["reason"] == "feature failed", failed

    # the degenerate point-box must not drag the document box to the origin
    bodies = [{"id": "a", "name": "far", "shape": Pos(100, 100, 100) * Box(2, 2, 2)},
              {"id": "b", "name": "gone", "shape": Box(1, 1, 1) - Box(5, 5, 5)}]
    t = mass_properties(bodies)["total"]
    assert t["bodies"] == 1, t
    assert t["bbox"]["min"][0] > 50.0, \
        f"an empty body dragged the total box to the origin: {t['bbox']}"
    print(PASS, "unmeasurable bodies say why, carry no numbers, and skew no totals")


def test_zero_total_volume_is_not_a_crash():
    t = mass_properties([{"id": "s", "name": "shell",
                          "shape": Shell(Box(10, 10, 10).faces()[1:])}])["total"]
    assert t["volume"] == 0.0 and t["com"] is None and t["bodies"] == 0, t
    assert mass_properties([])["total"]["com"] is None
    print(PASS, "a document with nothing measurable totals to zero, com None, no crash")


def test_a_solid_whose_shell_never_closes_is_refused_not_zeroed():
    """The gate the other four could not see. `len(s.solids()) == 0` runs BEFORE
    the integration, and an open shell wrapped in a TopoDS_SOLID passes it — it
    IS a solid by topology. OnlyClosed=True then integrates nothing, so Mass()
    stays 0.0 and CentreOfMass() returns its untouched reference point, the
    ORIGIN. That shipped as `measured: true, volume: 0.0, com: [0,0,0]` on a body
    sitting 36 mm away (Fenrir body2), i.e. a centre of mass outside its own box.

    Curved on purpose, and positioned away from the origin so that a regression
    reproduces the exact symptom: com [0,0,0] lying outside the bbox."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid

    cyl = Pos(40, 0, 0) * Cylinder(5, 20)
    faces = cyl.faces()
    # the barrel plus ONE cap: a cup, which sews into a single open shell.
    # (faces()[1:] on a cylinder leaves two disjoint discs and will not sew.)
    barrel = [f for f in faces if f.geom_type.name != "PLANE"]
    caps = [f for f in faces if f.geom_type.name == "PLANE"]
    open_shell = Shell(barrel + caps[:1])
    mk = BRepBuilderAPI_MakeSolid(open_shell.wrapped)
    rec = _one(Solid(mk.Solid()))

    assert rec["measured"] is False, \
        f"a solid with no closed shell was measured anyway: {rec}"
    assert rec["reason"] == "open shell", rec
    for k in ("volume", "com", "area", "bbox", "counts"):
        assert k not in rec, f"{k} present on an unmeasurable body: {rec}"
    print(PASS, "a solid whose shell never closes is refused, not zeroed")


def test_an_unpublishable_bbox_is_null_and_skews_no_total():
    """mesh_bbox returns None for a void box, and OCCT hands back +/-1e100 for
    unbounded geometry. The 1e100 is the dangerous one: it reads as an ordinary
    number and drags total.bbox to the edge of the universe. The None used to
    crash the union outright (r["bbox"]["min"][i] on a None)."""
    from builder import _publishable_bbox

    good = {"min": [-1.0, -2.0, -3.0], "max": [1.0, 2.0, 3.0]}
    assert _publishable_bbox(good) is True
    assert _publishable_bbox(None) is False, "a void box must not be published"
    assert _publishable_bbox({"min": [-1e100] * 3, "max": [1e100] * 3}) is False, \
        "OCCT's infinite box must not be published as numbers"
    assert _publishable_bbox({"min": [0.0, 0.0, float("nan")],
                              "max": [1.0, 1.0, 1.0]}) is False
    assert _publishable_bbox({"min": [0.0, 0.0], "max": [1.0, 1.0, 1.0]}) is False
    print(PASS, "void, infinite and malformed boxes are all refused publication")


def test_checks_are_opt_in_and_watertightness_is_real():
    plain = _one(Box(10, 10, 10))
    assert "valid" not in plain and "watertight" not in plain, \
        "checks must be ABSENT when not asked for, never false"

    box = _one(Box(10, 10, 10), checks=True)
    assert box["valid"] is True and box["watertight"] is True, box

    # THE discriminating case: written without CheckOrientedShells, HasFreeEdges
    # returns False for everything and this comes back True.
    lid_off = Shell(Box(10, 10, 10).faces()[1:])
    assert _watertight_of(lid_off) is False, \
        "an open shell reported watertight — CheckOrientedShells is missing"

    two = Compound(children=[Box(4, 4, 4), Pos(20, 0, 0) * Box(4, 4, 4)])
    assert _watertight_of(two) is True, "two disjoint closed solids are watertight"
    print(PASS, "checks are opt-in; an open shell is correctly not watertight")


def _watertight_of(shape):
    from builder import _watertight, _as_compound

    return _watertight(_as_compound(shape))


def test_bbox_is_conservative_on_curved_bodies():
    """The reported box comes from the triangulation, so it is never TIGHTER than
    the exact box. Assert containment, not equality — a box tighter than the truth
    is the one failure that matters."""
    rec = _one(Cylinder(30, 10))
    bb = rec["bbox"]
    for i, exact_lo, exact_hi in ((0, -30.0, 30.0), (1, -30.0, 30.0), (2, -5.0, 5.0)):
        assert bb["min"][i] <= exact_lo + 1e-6, f"axis {i} min {bb['min'][i]} > {exact_lo}"
        assert bb["max"][i] >= exact_hi - 1e-6, f"axis {i} max {bb['max'][i]} < {exact_hi}"
    print(PASS, "the reported box contains the exact box (conservative)")


def test_it_measures_what_the_document_actually_builds():
    doc = {"parameters": {}, "features": [
        {"id": "b", "type": "box", "length": 10, "width": 10, "height": 10},
    ]}
    _part, errs, bodies = rebuild(doc)
    assert not errs, errs
    t = mass_properties(bodies)["total"]
    assert _close(t["volume"], 1000.0), t
    print(PASS, "a rebuilt document measures end to end")


def main():
    print("Mass-properties tests")
    test_curved_volume_and_area_are_exact_not_tessellated()
    test_centre_of_mass_is_exact_where_volume_alone_would_not_show_it()
    test_totals_aggregate_correctly_across_bodies()
    test_counts_use_the_addressable_convention()
    test_an_open_shell_is_not_integrated_as_though_it_were_closed()
    test_nested_compounds_are_summed_not_read_off_the_top_level()
    test_unmeasurable_bodies_report_why_and_stay_out_of_the_total()
    test_zero_total_volume_is_not_a_crash()
    test_a_solid_whose_shell_never_closes_is_refused_not_zeroed()
    test_an_unpublishable_bbox_is_null_and_skews_no_total()
    test_checks_are_opt_in_and_watertightness_is_real()
    test_bbox_is_conservative_on_curved_bodies()
    test_it_measures_what_the_document_actually_builds()
    print("ALL PASS")


if __name__ == "__main__":
    main()
