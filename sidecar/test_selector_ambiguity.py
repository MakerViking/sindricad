"""Ambiguous-selector tests (sidecar): `by:"nearest"` must refuse to guess.

Regression for the silent wrong-face bug. `by:"nearest"` used to be a bare
min() over candidates: it always returned a winner, however far away and
however close the RUNNER-UP was. On 1.sindri feature f73 two faces sat exactly
equidistant from the stored point; which one won flipped when an unrelated
commit perturbed topology, so a press/pull silently pushed a wall instead of the
face the user clicked, with no error at all.

The resolver now measures the margin to the runner-up (the same TIE_BAND the v2
`match` path uses) and raises on a genuine tie unless `nth` says which one is
meant.

The one tie it does NOT refuse is the degenerate one (report e4732316): a face
that slid out from under the stored point ties with its neighbour on the
boundary they share, at every distance, so the refusal was unconditional and a
press/pull silently became a no-op. That case is broken by the UNBOUNDED surface
distance and reported as lossy. The tests below pin both halves — it recovers,
and it still refuses everything that is genuinely undetermined.

Run: uv run python test_selector_ambiguity.py
"""

from build123d import Box, Cylinder, Pos
from geom_select import resolve_faces, resolve_edges

PASS = "  ok"

BOX = Box(20, 20, 20)  # centred at the origin: faces at +/-10 on each axis


def face_sel(point, **kw):
    return {"kind": "face", "by": "nearest", "point": point, **kw}


def edge_sel(point, **kw):
    return {"kind": "edge", "by": "nearest", "point": point, **kw}


def test_equidistant_faces_raise_instead_of_guessing():
    """(15,15,0) is exactly as far from the +X face as from the +Y face. The old
    code silently picked whichever min() happened to see first."""
    try:
        resolve_faces(BOX, face_sel([15.0, 15.0, 0.0]))
    except ValueError as ex:
        msg = str(ex)
        assert "ambiguous face reference" in msg, msg
        # the message must name the competing candidates so the user knows what
        # to re-pick — a bare "ambiguous" is not actionable
        assert msg.count("a face at") >= 2, msg
        assert "15.00" in msg, msg
        print(PASS, "equidistant faces raise, naming both candidates")
        return
    raise AssertionError("an exactly ambiguous face pick did not raise")


def test_point_on_a_shared_edge_raises():
    """Dead on the edge between two faces: distance 0 to both."""
    try:
        resolve_faces(BOX, face_sel([10.0, 10.0, 0.0]))
    except ValueError as ex:
        assert "ambiguous" in str(ex)
        print(PASS, "a point on a shared edge raises (0mm vs 0mm)")
        return
    raise AssertionError("a point on a shared edge did not raise")


def test_clear_winner_still_resolves():
    """The whole point: an unambiguous pick behaves exactly as before."""
    got = resolve_faces(BOX, face_sel([15.0, 0.0, 0.0]))
    assert len(got) == 1, got
    c = got[0].center()
    assert abs(c.X - 10.0) < 1e-6 and abs(c.Y) < 1e-6 and abs(c.Z) < 1e-6, (c.X, c.Y, c.Z)
    print(PASS, "a clear winner resolves to the same face as before")


def test_moved_face_still_resolves_when_it_stays_nearest():
    """Ordinary parametric motion must keep working: the discriminator is
    AMBIGUITY, not distance-from-the-point. Grow the box and the top face moves
    away from the stored click point, but stays the unique nearest.

    LIMIT, deliberately pinned here: this holds while the top face is still
    closest. Grow the box far enough and the stored point ends up deep inside,
    where the side walls are nearer and mutually tied — then it raises, which is
    correct: the point no longer identifies the top face. `by:"match"`
    fingerprints are what survive that, not `nearest`."""
    tall = Box(20, 20, 24)                 # was 20 tall, top z=10 -> now z=12
    got = resolve_faces(tall, face_sel([0.0, 0.0, 10.0]))
    c = got[0].center()
    assert abs(c.Z - 12.0) < 1e-6, f"expected the top face at z=12, got {c.Z}"
    print(PASS, "a moved face still resolves while it stays the unique nearest")


def test_nth_disambiguates_a_deliberate_tie():
    """A caller that genuinely means "the second of the tied pair" can say so."""
    a = resolve_faces(BOX, face_sel([15.0, 15.0, 0.0], nth=0))[0]
    b = resolve_faces(BOX, face_sel([15.0, 15.0, 0.0], nth=1))[0]
    ca, cb = a.center(), b.center()
    assert (ca.X, ca.Y) != (cb.X, cb.Y), (ca, cb)
    # and it must be stable, not order-of-iteration luck
    again = resolve_faces(BOX, face_sel([15.0, 15.0, 0.0], nth=0))[0].center()
    assert (again.X, again.Y, again.Z) == (ca.X, ca.Y, ca.Z)
    print(PASS, "nth picks among tied faces, stably")


def test_equidistant_edges_raise():
    """Edges get the same treatment (fillet/chamfer selectors)."""
    try:
        resolve_edges(BOX, edge_sel([0.0, 0.0, 0.0]))  # centre: every edge equidistant
    except ValueError as ex:
        assert "ambiguous edge reference" in str(ex), str(ex)
        print(PASS, "equidistant edges raise")
        return
    raise AssertionError("an ambiguous edge pick did not raise")


def test_clear_edge_winner_still_resolves():
    got = resolve_edges(BOX, edge_sel([10.0, 10.0, 0.0]))
    assert len(got) == 1
    c = got[0].center()
    assert abs(c.X - 10.0) < 1e-6 and abs(c.Y - 10.0) < 1e-6, (c.X, c.Y, c.Z)
    print(PASS, "a clear edge winner resolves unchanged")


def test_ambiguity_is_reported_as_a_diagnostic_too():
    """The frontend gets a ResolveDiag entry, not just an exception string."""
    diag = []
    try:
        resolve_faces(BOX, face_sel([15.0, 15.0, 0.0]), diag=diag, feature_id="fX")
    except ValueError:
        pass
    assert diag and diag[-1]["feature_id"] == "fX", diag
    assert diag[-1]["lossy"] is True and diag[-1]["resolved"] == 0, diag
    print(PASS, "an ambiguous pick also emits a ResolveDiag entry")


def test_a_confident_pick_records_no_diagnostic():
    """An unambiguous pick must leave `diag` EMPTY, however slim its margin.

    Regression for a projection failure: the success path used to log an advisory
    entry carrying the distance margin in `confidence`, and `_push_diag` admits
    anything under 0.5 — so a clear winner (cylinder rim, margin 0.109) was
    recorded as low confidence. builder._project_source refused any non-empty
    `diag`, so projecting that rim reported "the source selection is ambiguous on
    this body" for a pick the gate had already ruled unambiguous. `diag` means
    "resolutions worth acting on"; consumers rely on that."""
    diag = []
    got = resolve_faces(BOX, face_sel([0.0, 0.0, 30.0]), diag=diag, feature_id="fY")
    assert len(got) == 1, got
    assert diag == [], f"a confident face pick must record nothing, got {diag}"

    # and an edge pick whose margin clears the tie band but is well under 0.5 —
    # the shape of the cylinder-rim case that actually broke.
    diag2 = []
    resolve_edges(BOX, edge_sel([10.0, 10.0, 3.0]), diag=diag2, feature_id="fZ")
    assert diag2 == [], f"a confident edge pick must record nothing, got {diag2}"
    print(PASS, "a confident pick records no diagnostic (advisory entries stay out)")


def test_candidate_fps_resolve_back_to_the_very_entities_that_tied():
    """The structured candidates must be USABLE, which is a stronger claim than
    "present". Feed each one back as a {by:"match", fp} selector and require it
    to land on the entity it was authored from.

    Asserting the list is non-empty would be VACUOUS: _resolve_one returns
    scored[0] whenever there is any candidate at all, so a degraded or even
    empty fingerprint still "resolves". Identity is the only assertion that can
    fail, and the negative control below proves it can."""
    from geom_select import _canonical_key_face, _canonical_key_edge

    # faces: a point equidistant from two opposite faces of a box
    part = Box(20, 20, 20)
    diag = []
    try:
        resolve_faces(part, {"kind": "face", "by": "nearest", "point": [0, 0, 0]},
                      diag=diag, feature_id="f1")
        raise AssertionError("an equidistant face pick must refuse")
    except ValueError:
        pass
    entry = next(d for d in diag if d.get("reason") == "ambiguous nearest pick")
    fps = entry.get("candidateFps")
    assert fps and len(fps) >= 2, f"expected tied face fingerprints, got {fps}"
    assert len(fps) <= 3, f"must be bounded at 3, got {len(fps)}"

    keys = set()
    for rec in fps:
        assert "fp" in rec and isinstance(rec.get("dist"), float), rec
        got = resolve_faces(part, {"kind": "face", "by": "match", "fp": rec["fp"]})
        assert len(got) == 1, f"a candidate fingerprint must resolve to one face: {rec}"
        keys.add(_canonical_key_face(got[0]))
    assert len(keys) == len(fps), \
        f"each candidate must resolve to a DISTINCT face; got {len(keys)} for {len(fps)}"

    # CONTROL — proof that the distinct-keys assertion above can actually fail.
    # It is the real discriminator here: a degraded fingerprint (missing its
    # discriminating fields, or duplicated) makes every candidate score the same
    # and collapse onto one entity, because by:"match" is best-effort and always
    # returns SOMETHING. Feeding the same fingerprint twice must collapse to one
    # key; if this ever stops collapsing, the assertion above has gone blind.
    duped = {
        _canonical_key_face(resolve_faces(part, {"kind": "face", "by": "match", "fp": r["fp"]})[0])
        for r in (fps[0], fps[0])
    }
    assert len(duped) == 1, \
        "control failed: two identical fingerprints resolved differently, so the " \
        "distinct-keys assertion above cannot be trusted"

    # edges: the same, on the edge path
    diag = []
    try:
        resolve_edges(part, {"kind": "edge", "by": "nearest", "point": [0, 0, 0]},
                      diag=diag, feature_id="e1")
        raise AssertionError("an equidistant edge pick must refuse")
    except ValueError:
        pass
    entry = next(d for d in diag if d.get("reason") == "ambiguous nearest pick")
    efps = entry.get("candidateFps")
    assert efps and len(efps) >= 2, f"expected tied edge fingerprints, got {efps}"
    ekeys = set()
    for rec in efps:
        got = resolve_edges(part, {"kind": "edge", "by": "match", "fp": rec["fp"]})
        assert len(got) == 1, f"a candidate fingerprint must resolve to one edge: {rec}"
        ekeys.add(_canonical_key_edge(got[0]))
    assert len(ekeys) == len(efps), "each edge candidate must resolve distinctly"
    print(PASS, "candidateFps resolve back to the tied entities (with a negative control)")


def test_a_confident_pick_carries_no_candidate_fps():
    """The head gate again, from the other side: the fingerprint work must sit
    on the REFUSAL path only. Authoring fingerprints for every resolution would
    put a per-edge cost on the hot path for something nobody reads."""
    part = Box(20, 20, 20)
    diag = []
    resolve_faces(part, {"kind": "face", "by": "nearest", "point": [0, 0, 30]},
                  diag=diag, feature_id="f2")
    assert diag == [], f"a clear winner must record nothing at all, got {diag}"
    print(PASS, "a confident pick authors no candidate fingerprints")


def _plate_and_column(offset_x):
    """A 60x60x6 plate with a r5 column standing on it, the column shifted in X.

    The shape of the bug report: the column's top disc is a face a press/pull
    was picked on, and moving the sketch circle slides that disc sideways out
    from under the pick point.
    """
    return Box(60, 60, 6) + (Pos(offset_x, 0, 3 + 15) * Cylinder(5, 30))


def test_a_face_that_slid_out_from_under_the_point_still_resolves():
    """THE BUG (report e4732316). Move the sketch circle and the top disc slides
    sideways; the stored point stays in the disc's plane but outside its rim, so
    the closest point on the disc is on its RIM — an edge it shares with the
    barrel, which therefore reports the byte-identical distance. Margin 0.0000,
    refusal, and the press/pull silently became a no-op.

    Bounded distance cannot separate that pair, but the UNBOUNDED surfaces can:
    the point is still dead in the disc's plane (0mm) and 7mm off the barrel."""
    part = _plate_and_column(12.0)          # was at x=0 when the point was stored
    diag = []
    got = resolve_faces(part, face_sel([0.0, 0.0, 33.0]), diag=diag, feature_id="fS")
    assert len(got) == 1, got
    f = got[0]
    c = f.center()
    assert abs(c.Z - 33.0) < 1e-6, f"expected the top disc at z=33, got {c.Z}"
    assert abs(c.X - 12.0) < 1e-6, f"expected the disc that MOVED (x=12), got {c.X}"
    assert abs(f.area - 78.54) < 0.1, f"expected the r5 disc (78.5mm2), got {f.area}"
    # it followed a drifting reference, so the user must be told: amber chip.
    assert diag and diag[-1]["feature_id"] == "fS", diag
    assert diag[-1]["lossy"] is True and diag[-1]["resolved"] == 1, diag
    # ... and told with a code, not just prose. src/features/repickReference.ts
    # gates the timeline's "Re-pick face…" on the code (or the legacy prose of
    # the REFUSAL, which this is not), so a recovery without one advertises a
    # gesture it hides. Keep this in REPAIRABLE_CODES over there.
    assert diag[-1].get("code") == "ambiguousReference", diag[-1]
    print(PASS, "a face that slid out from under the point resolves, lossily")


def test_a_point_off_BOTH_tied_surfaces_still_refuses():
    """1.sindri f73's shape, and the reviewer's regression. Two faces meeting at
    an edge, the point beyond the corner: both closest points are that same
    shared-edge point, so the coincidence check passes — but the point is 2mm off
    the top plane and 5mm off the side plane. It is on NEITHER, so which face it
    used to sit on is unknown and the tie must stand.

    A relative margin does not catch this: 2 vs 5 reads as a 60% win. Only an
    absolute "the point is still IN this surface" test does."""
    diag = []
    try:
        got = resolve_faces(BOX, face_sel([15.0, 0.0, 12.0]), diag=diag, feature_id="fO")
    except ValueError as ex:
        assert "ambiguous face reference" in str(ex), str(ex)
        print(PASS, "a point off both tied surfaces still refuses")
        return
    raise AssertionError(
        f"guessed {got[0].center()} from a point that is on neither surface")


def test_a_point_on_BOTH_tied_surfaces_still_refuses():
    """1.sindri f70's shape. The point is 5e-5mm off the top plane and dead ON
    the side plane — both well inside any sane "is it in this surface" tolerance,
    which is what it means for two surfaces to genuinely coincide at the pick.

    This is where a relative margin is worst: (5e-5 - 0) / 5e-5 reads as a 100%
    win off a difference no modelling operation could mean."""
    try:
        got = resolve_faces(BOX, face_sel([10.0, 0.0, 10.00005]))
    except ValueError as ex:
        assert "ambiguous face reference" in str(ex), str(ex)
        print(PASS, "a point on both tied surfaces still refuses")
        return
    raise AssertionError(
        f"guessed {got[0].center()} off 5e-5mm of separation")


def test_the_slid_face_tiebreak_does_not_resurrect_guessing():
    """The tie-break must only fire when the tied faces are tied BECAUSE the
    point sits on a boundary they share. Two faces that are merely equidistant
    still have to refuse — that is the bug this whole gate exists for, and an
    unbounded-surface rescore that ran unconditionally would answer it.

    (15,15,0) is such a case: both closest points land on the same box corner
    edge, but the two unbounded planes are 5mm away each — no winner either."""
    for point in ([15.0, 15.0, 0.0], [10.0, 10.0, 0.0], [0.0, 0.0, 0.0]):
        try:
            resolve_faces(BOX, face_sel(point))
        except ValueError as ex:
            assert "ambiguous face reference" in str(ex), str(ex)
            continue
        raise AssertionError(f"the tie-break guessed at {point} instead of refusing")
    print(PASS, "genuinely equidistant faces still refuse")


def test_the_refusal_says_where_to_re_pick():
    """The refusal used to say "re-pick the face" and stop. The only place to do
    that is a right-click on the timeline chip, which the reporter never found —
    so the message names the gesture."""
    try:
        resolve_faces(BOX, face_sel([15.0, 15.0, 0.0]))
    except ValueError as ex:
        msg = str(ex)
        assert "timeline" in msg, msg
        assert "Re-pick face" in msg, msg
        print(PASS, "the refusal names the gesture that repairs it")
        return
    raise AssertionError("an ambiguous face pick did not raise")


def test_a_press_pull_keeps_its_up_to_plane_when_the_sketch_moves():
    """END TO END, the reporter's symptom: "the column was no longer tied to the
    offset plane". A press/pull with upToPlane whose face reference refuses is
    recorded as a NO-OP and the build continues, so the column silently reverts
    to its plain extrude height instead of landing on the datum.

    Mirrors bug-reports/docs/e4732316.json (not loadable here: bug-reports/ is
    not in the repo), then moves the circle the way the reporter did."""
    import builder

    def doc(circle_x):
        return {
            "version": 5, "paramDefs": {}, "parameters": {},
            "features": [
                {"id": "f1", "type": "sketch", "plane": "XY", "entities": [
                    {"id": "e0", "type": "rectangle", "x": 0, "y": 0,
                     "width": 56.4, "height": 44.4},
                    {"id": "e1", "type": "circle", "x": circle_x, "y": 0,
                     "radius": 4.74},
                ]},
                {"id": "f2", "type": "extrude", "sketch": "f1", "distance": 30.588,
                 "operation": "new", "regions": [[-25.0, -20.0, 0], [circle_x, 0, 0]],
                 "regionEntities": [["e0"], ["e1"]],
                 "regionHoleEntities": [[["e1"]], []]},
                {"id": "f3", "type": "datumPlane", "plane": "XY", "offset": 61},
                {"id": "f6", "type": "extrude", "sketch": "f1", "distance": 98.068,
                 "operation": "join", "regions": [[circle_x, 0, 0]],
                 "regionEntities": [["e1"]], "regionHoleEntities": [[]]},
                # the pick point is where the disc was BEFORE the move
                {"id": "f7", "type": "press-pull", "body": "body2", "distance": 20,
                 "operation": "join", "upToPlane": "f3", "upToOffset": -10,
                 "face": {"kind": "face", "by": "nearest",
                          "point": [-0.47, -1.45, 98.068]}},
            ],
        }

    _, errs, bodies = builder.rebuild(doc(0.0))
    assert errs == [], f"the unmoved document must build clean: {errs}"
    assert len(bodies) == 1, bodies
    top = bodies[0]["shape"].bounding_box().max.Z
    assert abs(top - 71.0) < 1e-3, f"baseline: expected the column at z=71, got {top}"

    diag = []
    _, errs, bodies = builder.rebuild(doc(12.0), diagnostics=diag)
    assert errs == [], f"moving the sketch circle broke the press/pull: {errs}"
    top = bodies[0]["shape"].bounding_box().max.Z
    assert abs(top - 71.0) < 1e-3, (
        f"the column left the offset plane: expected z=71, got {top} "
        "(98.068 means f7 was recorded as a no-op)")
    assert any(d.get("feature_id") == "f7" for d in diag), \
        f"the drifted reference must still be reported: {diag}"
    print(PASS, "a press/pull keeps its up-to plane when the sketch moves")


def main():
    test_equidistant_faces_raise_instead_of_guessing()
    test_point_on_a_shared_edge_raises()
    test_clear_winner_still_resolves()
    test_moved_face_still_resolves_when_it_stays_nearest()
    test_a_face_that_slid_out_from_under_the_point_still_resolves()
    test_a_point_off_BOTH_tied_surfaces_still_refuses()
    test_a_point_on_BOTH_tied_surfaces_still_refuses()
    test_the_slid_face_tiebreak_does_not_resurrect_guessing()
    test_the_refusal_says_where_to_re_pick()
    test_a_press_pull_keeps_its_up_to_plane_when_the_sketch_moves()
    test_nth_disambiguates_a_deliberate_tie()
    test_equidistant_edges_raise()
    test_clear_edge_winner_still_resolves()
    test_ambiguity_is_reported_as_a_diagnostic_too()
    test_a_confident_pick_records_no_diagnostic()
    test_candidate_fps_resolve_back_to_the_very_entities_that_tied()
    test_a_confident_pick_carries_no_candidate_fps()
    print("ALL PASS")


if __name__ == "__main__":
    main()
