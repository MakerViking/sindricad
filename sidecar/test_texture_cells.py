"""Crease-aligned texture lattices: exactness, single-coverage, crack-freedom.

A "faceted" texture is meant to be planar facets meeting at real creases — that
is the whole reason it is the default, because a printer resolves a crease and
rounds a sub-millimetre sinusoid into mush. Sampling a height field onto a grid
only delivers that if vertices land ON the pattern's gradient breakpoints. They
did not: a uniform 4-samples-per-wavelength grid hits at most two of a
trapezoid's four corners, and the measured error reached 50% of the texture's own
depth.

These tests are the oracle for the lattice that replaces it. The exactness one is
not a smoke test — it caught a wrong derivation of _trapezoid's breakpoints (the
crest is a flat LAND, not a point, so there are four per period and not two)
that every other check in this repo passed straight through.

Run: uv run python test_texture_cells.py  (or: uv run pytest test_texture_cells.py)
"""

import numpy as np

import texture
from builder import rebuild

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Plane
from OCP.TopAbs import TopAbs_FACE, TopAbs_Orientation
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from build123d import Cone as BdCone, Face

PASS = "  ok"

# "Exact" to a nanometre, not to the last bit. The lattice puts vertices ON the
# creases, so the residual is pure floating-point noise from evaluating the field
# (measured worst: 1.6e-9mm, from hex's nearest-site arithmetic). That is six
# orders below the texture's own depth and below what STL/3MF can even store,
# which write float32.
EXACT_MM = 1e-6

PLATE, PLATE_Z, DEPTH, SCALE = 20.0, 5.0, 0.4, 2.0
CYL_H = 20.0
# radius chosen so the circumference is a WHOLE number of periods: a pattern of
# fixed period does not otherwise close on itself around a cylinder, and the
# phase jump at the seam would read as texture error that is really the
# parametrisation's
CYL_R_EXACT = 16.0 * SCALE / np.pi
BIG_CAP = 4_000_000

# Kinds whose faceted profile is piecewise linear, so a lattice can be EXACT.
# ribs/waves/knurl were already piecewise linear; hex was REDEFINED from a
# clipped cosine sum (curved walls, unmeshable) into a real honeycomb mesa.
# voronoi is still a conical field and noise/image are not periodic; they keep
# the sampled grid and are covered by test_texture.py instead.
LATTICE_KINDS = ("ribs", "waves", "knurl", "hex")

# Points strictly inside a triangle. The centroid alone is too weak: a triangle
# can straddle a crease and still match there by coincidence.
_BARY = np.array([
    [1 / 3, 1 / 3, 1 / 3],
    [0.60, 0.20, 0.20], [0.20, 0.60, 0.20], [0.20, 0.20, 0.60],
    [0.45, 0.45, 0.10], [0.10, 0.45, 0.45], [0.45, 0.10, 0.45],
])


def _plate_top_face():
    _part, errors, bodies = rebuild({"features": [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": PLATE, "height": PLATE, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": PLATE_Z, "operation": "new"},
    ]})
    assert not errors, errors
    shape = bodies[0]["shape"]
    BRepMesh_IncrementalMesh(shape.wrapped, 0.1, False, 0.5, True)
    ex = TopExp_Explorer(shape.wrapped, TopAbs_FACE)
    while ex.More():
        f = Face(ex.Current())
        if BRepAdaptor_Surface(f.wrapped).GetType() == GeomAbs_Plane and abs(f.center().Z - PLATE_Z) < 1e-6:
            return f
        ex.Next()
    raise AssertionError("no top face")


def _spec(kind, sharpness=0.5, angle=0.0, **kw):
    return texture.validate_texture_spec({
        "id": "t", "kind": kind, "scale": SCALE, "depth": DEPTH,
        "sharpness": sharpness, "angle": angle, "profile": "facet",
        "boundaryInset": 0.0, "seed": 1, **kw,
    })


def _displaced(face, spec):
    loc = TopLoc_Location()
    tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
    texture._GEOM_CACHE.clear()
    pos, idx, _n = texture.displace_face(face, tri, loc, loc.IsIdentity(), spec, BIG_CAP)
    return (np.asarray(pos, dtype=np.float64).reshape(-1, 3),
            np.asarray(idx, dtype=np.int64).reshape(-1, 3))


def _boundary(tris):
    counts = texture._boundary_edges([tuple(t) for t in tris])
    edges = [k for k, n in counts.items() if n == 1]
    ids = np.unique(np.asarray(edges, dtype=np.int64).ravel()) if edges else np.empty(0, np.int64)
    return ids, counts


def test_trapezoid_has_four_breakpoints_per_period():
    """The land flattens BOTH the trough and the crest, so the profile turns four
    corners per period, not two. Missing the upper pair is what rounded the crest
    off — assert against the field itself, not against the derivation."""
    for land in (0.25, 0.5, 0.98):
        phases = texture._crease_phases(land)
        assert len(phases) == 4, (land, phases)
        x = np.linspace(0.0, SCALE, 20001)
        h = texture._trapezoid(x, SCALE, land)
        # a breakpoint is where the slope changes; find them from the field
        slope = np.round(np.diff(h) / np.diff(x), 6)
        found = x[1:-1][np.abs(np.diff(slope)) > 1e-9] / SCALE
        # cluster the numerically-adjacent hits and compare with the phases
        got = sorted({round(float(v), 3) for v in found})
        want = sorted(round(p, 3) for p in phases)
        assert len(got) == len(want), (land, got, want)
        assert max(abs(a - b) for a, b in zip(got, want)) < 2e-3, (land, got, want)
    assert texture._crease_phases(0.0) == (0.0, 0.5), "pure V keeps trough+crest only"
    print(PASS, "trapezoid turns four corners per period; _crease_phases names all four")


def test_faceted_waves_are_a_sine_polyline_not_a_trapezoid():
    """`waves` and `ribs` shipped BYTE-IDENTICAL under the default profile: both
    height functions returned the same `_trapezoid`, so a kind the UI offers
    separately, names separately and stores separately drew exactly the other
    one (measured max|w-r| = 0.000000 at every land and angle). They differed
    only under `round`, which is not the default, so almost nobody could see it.

    Waves is now a sine POLYLINE — piecewise linear, because a curved level set
    cannot be meshed exactly (that is what left the old cosine-walled hex 41% of
    its own depth off), but rounded where ribs is flat-topped.

    Three claims, each read off the field rather than off the derivation: it
    differs from ribs by a real fraction of depth at every slider position, it
    still spans [0,1] exactly (so `depth` keeps meaning what it says), and the
    creases it turns are EXACTLY the ones `_wave_phases` declares — the lattice
    plants one sample line per phase, so an undeclared crease is a chord cutting
    the curve and a phase that turns no corner is triangles bought for nothing.

    Faceted waves takes no shape parameter (see `_wave_levels`), so `sharpness`
    is swept here to pin that down rather than to vary anything."""
    u, v = np.meshgrid(np.linspace(0.0, 6.0, 601), np.linspace(0.0, 6.0, 601))
    for sharp in (0.0, 0.5, 1.0):
        for angle in (0.0, 30.0):
            w = texture._height_waves(u, v, SCALE, angle, sharp, facet=True)
            r = texture._height_ribs(u, v, SCALE, angle, sharp, facet=True)
            assert float(np.abs(w - r).max()) > 0.25, \
                f"waves collapsed onto ribs at sharp={sharp} angle={angle}"
            assert abs(float(w.min())) < 1e-12 and abs(float(w.max()) - 1.0) < 1e-12, \
                f"waves must span [0,1]: got [{w.min()}, {w.max()}]"

    x = np.linspace(0.0, SCALE, 200001)
    h = texture._facet_wave(x, SCALE)
    slope = np.round(np.diff(h) / np.diff(x), 6)
    hits = np.sort(x[1:-1][np.abs(np.diff(slope)) > 1e-9] / SCALE)
    got = []
    for t in hits:  # cluster the numerically-adjacent hits
        if not got or float(t) - got[-1] > 1e-3:
            got.append(float(t))
    want = sorted(texture._wave_phases())
    assert len(got) == len(want), (got, want)
    assert max(abs(a - b) for a, b in zip(got, want)) < 1e-3, (got, want)

    # the oracle must actually bite: put the shipped bug back and the collapse
    # has to be what the first assertion catches
    orig = texture._facet_wave
    texture._facet_wave = lambda x, period: texture._trapezoid(x, period, 0.5)
    try:
        w = texture._height_waves(u, v, SCALE, 0.0, 0.5, facet=True)
        r = texture._height_ribs(u, v, SCALE, 0.0, 0.5, facet=True)
        collapsed = float(np.abs(w - r).max())
    finally:
        texture._facet_wave = orig
    assert collapsed < 1e-12, f"mutation failed to reproduce the bug ({collapsed})"
    print(PASS, "faceted waves is a sine polyline, distinct from ribs, creases as declared")


def test_lattice_reproduces_the_height_field_exactly():
    """THE oracle. Interior triangles must reproduce the true field at points
    strictly inside them, not merely at their vertices — that is the difference
    between "the mesh touches the pattern" and "the mesh IS the pattern"."""
    face = _plate_top_face()
    worst = 0.0
    for kind in LATTICE_KINDS:
        for sharp in (0.0, 0.25, 0.5, 1.0):
            for angle in (0.0, 17.0, 45.0):
                spec = _spec(kind, sharp, angle)
                P, I = _displaced(face, spec)
                # "Interior" means strictly inside the FACE OUTLINE, which is
                # what this oracle has always measured. It used to be derived
                # from unshared mesh edges, but the boundary skirt (CODE_VERSION
                # 9) shares those edges with its wall, so the mesh no longer
                # reports the outline as its own boundary. Test the outline
                # directly: exact, and independent of how it happens to be meshed.
                half = PLATE / 2.0
                on_bnd = (np.abs(P[:, 0]) > half - 1e-9) | (np.abs(P[:, 1]) > half - 1e-9)
                interior = I[~on_bnd[I].any(axis=1)]
                assert len(interior) > 100, (kind, sharp, angle, len(interior))
                corners = P[interior]
                s = np.einsum("sb,tbc->tsc", _BARY, corners).reshape(-1, 3)
                h = texture.height_field(kind, spec, s[:, 0], s[:, 1])
                err = float(np.abs(s[:, 2] - (PLATE_Z + DEPTH * h)).max())
                assert err < EXACT_MM, f"{kind} sharp={sharp} angle={angle}: {err:.3e}mm off"
                worst = max(worst, err)
    print(PASS, f"lattice is exact for {'/'.join(LATTICE_KINDS)} (worst {worst:.2e}mm)")


def test_lattice_tiles_the_face_exactly_once():
    """Overlap and holes are both invisible in a triangle count, and the manifold
    check only catches them by luck. Displacement on a plane is along Z, so the
    xy areas must sum to the face's area: above is double coverage, below a hole.
    (Measured 2mm^2 of overlap on a 400mm^2 face from a Delaunay band bridging a
    concave notch in the structured region.)"""
    face = _plate_top_face()
    for kind in LATTICE_KINDS:
        for sharp in (0.0, 0.5, 1.0):
            for angle in (0.0, 17.0, 45.0):
                P, I = _displaced(face, _spec(kind, sharp, angle))
                A, B, C = P[I[:, 0], :2], P[I[:, 1], :2], P[I[:, 2], :2]
                area = 0.5 * np.abs((B[:, 0] - A[:, 0]) * (C[:, 1] - A[:, 1])
                                    - (C[:, 0] - A[:, 0]) * (B[:, 1] - A[:, 1])).sum()
                assert abs(area - PLATE * PLATE) < 1e-6, \
                    f"{kind} sharp={sharp} angle={angle}: covers {area:.4f} of {PLATE * PLATE}"
    print(PASS, "lattice tiles the face exactly once (no overlap, no holes)")


def test_lattice_keeps_the_boundary_on_the_shared_polyline():
    """The crack-free invariant: a textured face's boundary vertices must lie on
    the polyline the neighbouring untextured face still uses, or the seam leaks.
    Crease/boundary intersections are inserted into the ring, so this has to hold
    with the extra vertices too."""
    face = _plate_top_face()
    for kind in LATTICE_KINDS:
        for sharp in (0.0, 0.5, 1.0):
            for angle in (0.0, 17.0, 45.0):
                P, I = _displaced(face, _spec(kind, sharp, angle))
                bnd, _c = _boundary(I)
                B = P[bnd]
                # the plate's rim: |x| == 10 or |y| == 10, and undisplaced
                on_rim = ((np.abs(np.abs(B[:, 0]) - PLATE / 2) < 1e-9)
                          | (np.abs(np.abs(B[:, 1]) - PLATE / 2) < 1e-9))
                assert on_rim.all(), \
                    f"{kind} sharp={sharp} angle={angle}: {(~on_rim).sum()} boundary verts off the rim"
                assert np.abs(B[:, 2] - PLATE_Z).max() < 1e-12, "rim must stay undisplaced"
    print(PASS, "boundary stays on the shared polyline, undisplaced (no seam crack)")


def test_lattice_costs_no_more_than_the_pattern_demands():
    """The lattice's triangle count tracks the PATTERN, not a sampling rate. A
    regression back to the sampled grid would still be manifold and roughly
    right, so only a budget assertion catches it.

    The ceilings are not all the same, and that is the honest result rather than
    a headline: ribs needs lines across one axis only. WAVES is on that same one
    axis but is a sine POLYLINE, so it pays per facet — 6 creases per period
    against ribs' 2 or 4 — and costs about a third more. Its count is fixed, so
    unlike ribs its ceiling does not move with the slider. A knurl with a LAND
    needs four breakpoints on both axes, so its tensor product is 4x4 cells = 32
    triangles — no cheaper than sampling, but exact where sampling was wrong by
    a third to a half of the texture's depth. Merging the coplanar trough and
    land quads would cut it further; that is an optimisation, not correctness."""
    face = _plate_top_face()
    cells = (PLATE / SCALE) ** 2
    ceilings = {("ribs", 0.0): 16, ("ribs", 0.5): 16, ("ribs", 1.0): 16,
                ("waves", 0.0): 16, ("waves", 0.5): 16, ("waves", 1.0): 16,
                ("knurl", 0.0): 16, ("knurl", 0.5): 40, ("knurl", 1.0): 40,
                # a hex mesa costs MORE than sampling, and that is the honest
                # trade: 6 walls, 6 spokes and a groove that has to be held
                # against Delaunay, in exchange for exact instead of 41% off
                ("hex", 0.0): 48, ("hex", 0.5): 48, ("hex", 1.0): 48}
    for (kind, sharp), ceiling in ceilings.items():
        _P, I = _displaced(face, _spec(kind, sharp))
        # The boundary skirt (CODE_VERSION 9) is not lattice: its cost tracks the
        # face's PERIMETER, so counting it here would make this budget depend on
        # the fixture's perimeter-to-area ratio instead of on the pattern, which
        # is the one thing the test exists to measure. Wall triangles are exactly
        # vertical, so they project to zero area in xy; every lattice triangle is
        # part of a heightfield over the plate and projects to a positive area.
        T = _P[I]
        plan = np.abs((T[:, 1, 0] - T[:, 0, 0]) * (T[:, 2, 1] - T[:, 0, 1])
                      - (T[:, 1, 1] - T[:, 0, 1]) * (T[:, 2, 0] - T[:, 0, 0]))
        lattice = I[plan > 1e-12]
        per_cell = len(lattice) / cells
        assert per_cell < ceiling, f"{kind} sharp={sharp}: {per_cell:.1f} tris/cell"
    # and the sampled path it replaced really is ~32 for a one-axis pattern
    _P, I = _displaced(face, _spec("noise", 0.5))
    assert len(I) / cells > 20.0, "noise should still take the sampled grid"
    print(PASS, f"lattice within its per-kind budget; sampling spends {len(I) / cells:.0f}/cell")


def test_lattice_meshes_stay_manifold():
    face = _plate_top_face()
    for kind in LATTICE_KINDS:
        for sharp in (0.0, 0.5, 1.0):
            for angle in (0.0, 17.0, 45.0):
                _P, I = _displaced(face, _spec(kind, sharp, angle))
                _b, counts = _boundary(I)
                ok, bad = texture._manifold_check(counts)
                assert ok, f"{kind} sharp={sharp} angle={angle}: {bad} non-manifold edge(s)"
    print(PASS, "lattice meshes are manifold across kinds, sharpness and angle")


def test_geometry_cache_key_separates_lattices():
    """The skeleton used to be kind-independent, so the cache key legitimately
    left kind/sharpness/profile/offset out. A lattice derives vertex placement
    from all four — leaving them out serves a knurl skeleton for a hex texture at
    the same scale and angle, which is silent wrong geometry, not a slow path."""
    face = _plate_top_face()
    loc = TopLoc_Location()
    tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
    base = _spec("ribs", 0.5)
    key = texture._geometry_key(face, tri, False, base, SCALE, 0.0, 0.0, BIG_CAP)
    for field, value in (("kind", "hex"), ("sharpness", 0.9),
                         ("profile", "round"), ("offset", 0.37)):
        other = dict(base, **{field: value})
        assert texture._geometry_key(face, tri, False, other, SCALE, 0.0, 0.0, BIG_CAP) != key, \
            f"{field} must take part in the geometry cache key"
    print(PASS, "geometry cache key separates kind/sharpness/profile/offset")


def test_offset_phase_locks_the_lattice():
    """`offset` shifts the field displace_face evaluates, so the lines have to
    shift with it. If they did not, the crests would drift off the vertices and
    the mesh would go back to slicing corners — exactness is the observable."""
    face = _plate_top_face()
    spec = _spec("ribs", 0.5, offset=0.317)
    P, I = _displaced(face, spec)
    # strictly inside the plate outline — see the note in
    # test_lattice_reproduces_the_height_field_exactly
    half = PLATE / 2.0
    on_bnd = (np.abs(P[:, 0]) > half - 1e-9) | (np.abs(P[:, 1]) > half - 1e-9)
    interior = I[~on_bnd[I].any(axis=1)]
    s = np.einsum("sb,tbc->tsc", _BARY, P[interior]).reshape(-1, 3)
    h = texture.height_field("ribs", spec, s[:, 0] + 0.317, s[:, 1])
    assert np.abs(s[:, 2] - (PLATE_Z + DEPTH * h)).max() < EXACT_MM, "offset must phase-lock the lattice"
    print(PASS, "a non-zero offset phase-locks the lattice (still exact)")


def _cylinder_lateral_face(radius):
    _part, errors, bodies = rebuild({"features": [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "circle", "radius": radius, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": CYL_H, "operation": "new"},
    ]})
    assert not errors, errors
    shape = bodies[0]["shape"]
    BRepMesh_IncrementalMesh(shape.wrapped, 0.1, False, 0.5, True)
    ex = TopExp_Explorer(shape.wrapped, TopAbs_FACE)
    while ex.More():
        f = Face(ex.Current())
        if BRepAdaptor_Surface(f.wrapped).GetType() == GeomAbs_Cylinder:
            return f
        ex.Next()
    raise AssertionError("no lateral face")


def _cyl_chart(face, P, spec=None):
    """(u_mm, v_mm) for points on a cylindrical face, from the surface's OWN
    placement and the SAME chart texture.py uses.

    Three traps, each of which quietly fakes a texture error that is really the
    test's: the frame is not the world frame; OCCT's u runs over [0, 2pi) while
    atan2 returns (-pi, pi], putting half the face a circumference out of place;
    and one full turn is no longer 2*pi*R but `_turn_mm`, which is rounded to a
    whole number of the pattern's u-period so the pattern closes at the seam."""
    surf = BRepAdaptor_Surface(face.wrapped)
    cyl = surf.Cylinder()
    ax = cyl.Position()
    period = texture._u_period(spec, SCALE) if spec is not None else SCALE
    turn = texture._turn_mm(surf, period)
    loc = np.array([ax.Location().X(), ax.Location().Y(), ax.Location().Z()])
    xd = np.array([ax.XDirection().X(), ax.XDirection().Y(), ax.XDirection().Z()])
    yd = np.array([ax.YDirection().X(), ax.YDirection().Y(), ax.YDirection().Z()])
    zd = np.array([ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z()])
    d = P - loc[None, :]
    # radial displacement leaves the angle alone, so this is the true u even for
    # displaced points
    return (np.mod(np.arctan2(d @ yd, d @ xd), 2 * np.pi) * (turn / (2 * np.pi)),
            d @ zd, turn)


def test_lattice_is_exact_on_a_cylinder():
    """The knurled-knob case. Comparing 3D positions would conflate texture error
    with the cylinder's own chordal error, so test what the lattice actually
    promises: no crease crosses a triangle, i.e. the field is LINEAR in the
    (u_mm, v_mm) chart across every interior triangle."""
    face = _cylinder_lateral_face(CYL_R_EXACT)
    worst = 0.0
    for kind in LATTICE_KINDS:
        # Which angles can even CLOSE around a cylinder. A rib pattern crosses a
        # crest every scale/cos(angle) along u, and the turn is rounded to a whole
        # number of those, so it closes at any angle. knurl and hex are 2D
        # lattices: closing needs the turn to be a lattice vector in BOTH
        # directions at once, which happens only when tan(angle) is rational. At
        # a general angle they cannot close and the seam carries a phase joint —
        # geometry, not a defect. Test them where closure exists.
        angles = (0.0, 30.0, 90.0) if kind in ("ribs", "waves") else (0.0, 90.0)
        for sharp in (0.0, 0.5, 1.0):
            for angle in angles:
                spec = _spec(kind, sharp, angle)
                P, I = _displaced(face, spec)
                u_mm, v_mm, circ = _cyl_chart(face, P, spec)
                # Strictly inside the face outline. Two sources, because neither
                # alone is complete since the boundary skirt (CODE_VERSION 9):
                # the mesh's own unshared edges still catch the u=0 SEAM (never
                # skirted, and carrying a phase joint), while the end circles are
                # now shared with the wall and have to be read off the chart.
                bnd, _c = _boundary(I)
                on_bnd = np.zeros(len(P), dtype=bool)
                on_bnd[bnd] = True
                vlo, vhi = v_mm.min(), v_mm.max()
                on_bnd |= (v_mm - vlo < 1e-9) | (vhi - v_mm < 1e-9)
                interior = I[~on_bnd[I].any(axis=1)]
                assert len(interior) > 100, (kind, sharp, angle, len(interior))
                chart = np.stack([u_mm, v_mm], axis=1)[interior].copy()
                # unwrap each triangle across the u=0 seam; the circumference is
                # a whole number of periods, so the shift cannot move the pattern
                ref = chart[:, 0:1, 0]
                chart[:, :, 0] = ref + (chart[:, :, 0] - ref + circ / 2) % circ - circ / 2
                hv = texture.height_field(kind, spec, chart[:, :, 0].ravel(),
                                          chart[:, :, 1].ravel()).reshape(-1, 3)
                s = np.einsum("sb,tbc->tsc", _BARY, chart).reshape(-1, 2)
                true = texture.height_field(kind, spec, s[:, 0], s[:, 1])
                err = float(np.abs((hv @ _BARY.T).ravel() - true).max() * DEPTH)
                assert err < EXACT_MM, f"{kind} sharp={sharp} angle={angle}: {err:.3e}mm off"
                worst = max(worst, err)
    print(PASS, f"lattice is exact on a cylinder too (worst {worst:.2e}mm)")


def test_curved_faces_keep_the_boundary_on_the_shared_polyline():
    """The crack this closes was real and measured: subdivision placed boundary
    midpoints on the TRUE surface while the adjacent cap kept the straight chord,
    so 4,032 of 4,224 boundary vertices drifted off it by up to 0.048mm.

    Covers `noise` as well as the lattice kinds on purpose — noise still takes
    the subdivision path, so it is the one that regression-tests the chord fix
    rather than the lattice."""
    face = _cylinder_lateral_face(CYL_R_EXACT)
    base = _base_boundary_segments(face)
    for kind in LATTICE_KINDS + ("noise",):
        P, I = _displaced(face, _spec(kind, 0.5))
        _bnd, counts = _boundary(I)
        # Only vertices on a boundary SHARED with a neighbouring face have to
        # stay put. The UV seam is an artificial cut with no neighbour, and it is
        # deliberately displaced now (pinning it left a flat stripe up every
        # cylinder). Its two sides carry the same field value, so they move
        # together and stay coincident.
        #
        # Take the cap ring as the unshared EDGES with both ends on a cap plane.
        # Testing vertices alone is no longer enough: since the boundary skirt
        # (CODE_VERSION 9) the cap ring is the wall's foot, and the one vertex
        # where the seam meets a cap is unshared via its VERTICAL seam edge while
        # being legitimately displaced — its cap side is sealed by the wall.
        on_cap_v = (np.abs(P[:, 2]) < 1e-6) | (np.abs(P[:, 2] - CYL_H) < 1e-6)
        # ...and not ON the seam. The wall stops at the seam (seam edges are
        # never skirted), leaving one open vertical edge where it meets each
        # cap. Those four corner vertices are displaced by design and close
        # against their coincident twin on the other side of the cut, exactly as
        # the seam itself does. The seam here is the +X meridian.
        seam_v = (np.abs(P[:, 1]) < 1e-6) & (P[:, 0] > 0)
        ring = {v for (a, b), n in counts.items() if n == 1 and on_cap_v[a] and on_cap_v[b]
                for v in (a, b) if not seam_v[v]}
        assert ring, f"{kind}: no cap boundary ring found"
        worst = _max_distance_to_segments(P[sorted(ring)], base)
        assert worst < 1e-9, f"{kind}: cap boundary vertex {worst:.6f}mm off the shared polyline"
    print(PASS, "curved-face boundaries stay on the shared polyline (chord fix holds)")


def test_the_seam_strip_is_exact():
    """The staggered crushed hex cells of 0.1.75, and their whole bug class.

    Every other exactness check here excludes triangles touching the boundary,
    and on a closed face the UV seam columns ARE boundary — so the strip between
    them and the first lattice column was never scored, and three defects shipped
    unseen: (1) uniform ring densification put seam ring points at non-crease
    heights, (2) the near-ring cull then ate the lattice's own on-seam corners
    (a lost corner is a crushed cell — up to 46% of depth, staggered by row),
    and (3) _flip_to_creases refused to repair any triangle touching a ring
    vertex, though seam ring vertices displace with the field (that one also
    broke ribs/waves at angle 0: a 33%-of-depth notch on every row).

    So score EVERYTHING except the real rims, on a cylinder whose circumference
    is NOT a whole number of periods (the snapped turn is where the seam
    machinery earns its keep) and on a cone. Exact in the assembly's own chart,
    to fp noise."""
    solids = [("cylinder", _cylinder_lateral_face(20.0))]
    cone = BdCone(bottom_radius=15, top_radius=10, height=30)
    BRepMesh_IncrementalMesh(cone.wrapped, 0.1, False, 0.5, True)
    ex = TopExp_Explorer(cone.wrapped, TopAbs_FACE)
    while ex.More():
        f = Face(ex.Current())
        if BRepAdaptor_Surface(f.wrapped).GetType() == GeomAbs_Cone:
            solids.append(("cone", f))
            break
        ex.Next()
    assert len(solids) == 2, "no cone face"
    worst = 0.0
    for name, face in solids:
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
        flip = face.wrapped.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
        surf = BRepAdaptor_Surface(face.wrapped)
        for kind in LATTICE_KINDS:
            spec = _spec(kind)
            g = texture._displacement_geometry(
                face, tri, loc, loc.IsIdentity(), spec, SCALE, SCALE / 4.0, BIG_CAP, flip)
            u, v = g["u_mm"], g["v_mm"]
            I = np.asarray(g["flat_indices"], dtype=np.int64).reshape(-1, 3)
            h = texture.height_field(kind, spec, u, v)
            turn = texture._turn_mm(surf, texture._u_period(spec, SCALE))
            cu = u[I]
            # unwrap each triangle across the seam; the turn is a whole number
            # of periods, so the shift cannot move the pattern
            cu = cu - np.round((cu - cu[:, :1]) / turn) * turn
            sv = np.einsum("sb,tb->ts", _BARY, v[I])
            su = np.einsum("sb,tb->ts", _BARY, cu)
            sh = np.einsum("sb,tb->ts", _BARY, h[I])
            true = texture.height_field(kind, spec, su.ravel(), sv.ravel()).reshape(su.shape)
            terr = np.abs(sh - true).max(axis=1) * DEPTH
            # everything except the rim taper zone: one pattern cell + the
            # boundaryInset ramp is the deliberate flat-at-the-rim region
            mid = ((sv > v.min() + 2 * SCALE).all(axis=1)
                   & (sv < v.max() - 2 * SCALE).all(axis=1))
            assert mid.sum() > 500, (name, kind, int(mid.sum()))
            err = float(terr[mid].max())
            assert err < EXACT_MM, f"{kind} on {name}: seam strip {err:.3e}mm off"
            worst = max(worst, err)
    print(PASS, f"the seam strip is exact, rims aside (worst {worst:.2e}mm)")


def test_triangle_winding_agrees_with_the_normals():
    """The two-halves bug: scipy Delaunay simplex orientation is arbitrary, and
    a double-sided renderer negates the shading normal on back-wound triangles
    — so a tube's REVERSED outer face rendered half lit, half inside-out, with
    a hard model-fixed boundary no lighting change could touch (2026-08-02).
    Inconsistent winding also rides into STL/3MF. Height oracles cannot see
    orientation, which is how it survived every exactness test.

    Assert every triangle's geometric winding agrees with its vertices'
    analytic normals, on the case that actually failed: the reversed outer
    face of a tube. Also self-checks the oracle by disabling the fix."""
    _part, errors, bodies = rebuild({"features": [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "circle", "radius": 25, "x": 0, "y": 0},
                      {"type": "circle", "radius": 20, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 30,
         "operation": "new", "regions": [[22.5, 0, 0]]},
    ]})
    assert not errors, errors
    BRepMesh_IncrementalMesh(bodies[0]["shape"].wrapped, 0.1, False, 0.5, True)
    outer = None
    ex = TopExp_Explorer(bodies[0]["shape"].wrapped, TopAbs_FACE)
    while ex.More():
        f = Face(ex.Current())
        ad = BRepAdaptor_Surface(f.wrapped)
        if ad.GetType() == GeomAbs_Cylinder and abs(ad.Cylinder().Radius() - 25) < 1e-6:
            outer = f
            break
        ex.Next()
    assert outer is not None, "no outer tube face"
    assert outer.wrapped.Orientation() == TopAbs_Orientation.TopAbs_REVERSED, \
        "fixture no longer reversed — find another reversed-face case"

    loc = TopLoc_Location()
    tri = BRep_Tool.Triangulation_s(outer.wrapped, loc)

    def disagreements(spec):
        texture._GEOM_CACHE.clear()
        pos, idx, nrm = texture.displace_face(
            outer, tri, loc, loc.IsIdentity(), spec, BIG_CAP)
        P = np.asarray(pos, dtype=np.float64).reshape(-1, 3)
        I = np.asarray(idx, dtype=np.int64).reshape(-1, 3)
        N = np.asarray(nrm, dtype=np.float64).reshape(-1, 3)
        gn = np.cross(P[I[:, 1]] - P[I[:, 0]], P[I[:, 2]] - P[I[:, 0]])
        ref = N[I[:, 0]] + N[I[:, 1]] + N[I[:, 2]]
        return int(((gn * ref).sum(axis=1) < 0.0).sum()), len(I)

    for kind in LATTICE_KINDS:
        bad, total = disagreements(_spec(kind))
        assert bad == 0, f"{kind}: {bad} of {total} triangles wound against their normals"

    # the oracle must actually bite: with the orientation pass disabled, the
    # raw Delaunay winding disagrees en masse
    orig = texture._orient_windings
    texture._orient_windings = lambda P, I, n: I
    try:
        bad, total = disagreements(_spec("hex"))
    finally:
        texture._orient_windings = orig
    assert bad > total // 10, f"oracle is toothless (only {bad} of {total} without the fix)"
    print(PASS, "triangle winding agrees with the analytic normals (reversed tube face)")


def test_the_uv_seam_is_textured_like_any_other_line():
    """The seam stripe, and the misdiagnosis that outlived it.

    A closed face's UV seam is an artificial cut, so `_boundary_taper` exempts it
    and both sides evaluate the same field — which only works because a full turn
    is now a whole number of the pattern's u-period. An earlier reading of "0 of
    78 seam vertices displaced" concluded the exemption had failed for
    ribs/waves/knurl. It had not: their field is simply ZERO at the seam, because
    the phase origin is the seam and phase 0 is a trough. The trough LAND there is
    the same width as every other trough's (measured 0.5mm on a 2mm period), so
    there is no stripe — nothing to fix.

    So test the two things that actually have to hold, neither of which is "the
    seam vertices moved": the field wraps, and the taper pins nothing on the seam
    that a real rim does not already own."""
    face = _cylinder_lateral_face(CYL_R_EXACT)
    loc = TopLoc_Location()
    tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
    flip = face.wrapped.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
    surf = BRepAdaptor_Surface(face.wrapped)
    for kind in LATTICE_KINDS:
        # only the angles at which the pattern can close (see the exactness test)
        for angle in ((0.0, 30.0, 90.0) if kind in ("ribs", "waves") else (0.0, 90.0)):
            spec = _spec(kind, 0.5, angle)
            g = texture._displacement_geometry(
                face, tri, loc, loc.IsIdentity(), spec, SCALE, SCALE / 4.0, BIG_CAP, flip)
            u, v = g["u_mm"], g["v_mm"]
            turn = texture._turn_mm(surf, texture._u_period(spec, SCALE))
            ur = (float(u.min()), float(u.max()))
            vr = (float(v.min()), float(v.max()))

            # 1. the field is periodic over one turn, so the two sides of the cut
            #    displace identically and stay coincident without welding
            du, vs = np.linspace(0.0, 1.0, 51), np.linspace(vr[0] + 0.5, vr[1] - 0.5, 97)
            U, V = np.meshgrid(du, vs)
            wrap = np.abs(texture.height_field(kind, spec, U.ravel(), V.ravel(), ur, vr)
                          - texture.height_field(kind, spec, U.ravel() + turn, V.ravel(), ur, vr)).max()
            assert wrap < 1e-9, f"{kind}@{angle}: field does not wrap at the seam ({wrap:.2e})"

            # 2. nothing on the seam is pinned flat except where a real rim crosses it
            seam = (np.abs(u) < 1e-6) | (np.abs(u - turn) < 1e-6)
            rim = (np.abs(v - vr[0]) < 1e-9) | (np.abs(v - vr[1]) < 1e-9)
            stuck = int((seam & ~rim & (g["taper"] == 0)).sum())
            assert stuck == 0, f"{kind}@{angle}: {stuck} seam vertices pinned flat"
    print(PASS, "the UV seam wraps and is exempt from the boundary taper")


def _base_boundary_segments(face):
    loc = TopLoc_Location()
    tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
    trsf, ident = loc.Transformation(), loc.IsIdentity()
    pts = []
    for i in range(1, tri.NbNodes() + 1):
        p = tri.Node(i)
        if not ident:
            p = p.Transformed(trsf)
        pts.append((p.X(), p.Y(), p.Z()))
    pts = np.asarray(pts)
    tris = []
    for i in range(1, tri.NbTriangles() + 1):
        a, b, c = tri.Triangle(i).Get()
        tris.append((a - 1, b - 1, c - 1))
    counts = texture._boundary_edges(tris)
    seg = [k for k, n in counts.items() if n == 1]
    return pts[[e[0] for e in seg]], pts[[e[1] for e in seg]]


def _max_distance_to_segments(Q, base):
    A, B = base
    d = B - A
    L2 = np.maximum((d * d).sum(axis=1), 1e-30)
    t = np.clip(((Q[:, None, :] - A[None]) * d[None]).sum(axis=2) / L2[None], 0.0, 1.0)
    proj = A[None] + t[..., None] * d[None]
    return float(np.linalg.norm(Q[:, None, :] - proj, axis=2).min(axis=1).max())


def main():
    print("Texture lattice tests")
    test_trapezoid_has_four_breakpoints_per_period()
    test_faceted_waves_are_a_sine_polyline_not_a_trapezoid()
    test_lattice_reproduces_the_height_field_exactly()
    test_lattice_tiles_the_face_exactly_once()
    test_lattice_keeps_the_boundary_on_the_shared_polyline()
    test_lattice_costs_no_more_than_the_pattern_demands()
    test_lattice_meshes_stay_manifold()
    test_lattice_is_exact_on_a_cylinder()
    test_the_seam_strip_is_exact()
    test_triangle_winding_agrees_with_the_normals()
    test_curved_faces_keep_the_boundary_on_the_shared_polyline()
    test_the_uv_seam_is_textured_like_any_other_line()
    test_geometry_cache_key_separates_lattices()
    test_offset_phase_locks_the_lattice()
    print("ALL PASS")


if __name__ == "__main__":
    main()
