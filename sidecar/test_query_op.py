"""The `query` op: resolve selectors, match predicates, return storable refs.

Run: uv run python test_query_op.py

The point of this op is that what it hands back can be PERSISTED and will still
mean the same thing after the model changes. So the load-bearing test is not
"does it find things" — it is the MUTATED ROUND TRIP: author a reference against
one model, change the model, and require the reference to still land on the same
feature. An unmutated round trip is non-discriminating, because a weak reference
and a strong one both resolve correctly when nothing has moved.
"""

import math
import os

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

from build123d import Box, Cylinder, Pos, Rot, Sphere  # noqa: E402

from builder import query_geometry, rebuild  # noqa: E402
from geom_select import _edge_radius, resolve_edges  # noqa: E402

PASS = "  ok"


def _doc(*features):
    return {"parameters": {}, "features": list(features)}


def _q(doc, *items):
    return query_geometry(doc, list(items))["results"]


BOX = _doc({"id": "b1", "type": "box", "length": 20, "width": 20, "height": 20})
# A tube built the way the app builds one: solid extrude, then a cut. Primitives
# always make a NEW body, so two cylinders would be two bodies, not a tube.
TUBE = _doc(
    {"id": "s1", "type": "sketch", "plane": "XY",
     "entities": [{"id": "k1", "type": "circle", "radius": 10, "x": 0, "y": 0}]},
    {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 20, "operation": "new"},
    {"id": "s2", "type": "sketch", "plane": "XY",
     "entities": [{"id": "k2", "type": "circle", "radius": 6, "x": 0, "y": 0}]},
    {"id": "e2", "type": "extrude", "sketch": "s2", "distance": 20, "operation": "cut"},
)


def test_a_returned_reference_survives_a_mutation():
    """THE test. Author a reference to the OUTER rim of a tube, then rebuild the
    tube at a different size and require it to still resolve to the outer rim.

    Without the concentric rank the fingerprint carries, a scaled model resolves
    this to the INNER rim — a wrong reference written straight into the user's
    document. The unmutated case cannot show this: both the weak and the full
    fingerprint resolve to 10.0 when nothing has moved."""
    res = _q(TUBE, {"id": "q", "kind": "edge",
                    "where": {"curve": "circle", "radius": {"min": 9, "max": 11}}})[0]
    assert res["ok"], res
    assert res["count"] >= 1, res
    sel = res["entities"][0]["sel"]
    fp = sel["fp"]
    assert fp.get("radius_rank") is not None and fp.get("radius_group") == 2, \
        f"a concentric rim must carry its rank, or the mutation case fails: {fp}"

    # the SAME tube, scaled: outer 10 -> 13, inner 6 -> 7.8
    mutated = Cylinder(13, 20) - Cylinder(7.8, 20)
    got = resolve_edges(mutated, sel)
    assert len(got) == 1, got
    r = _edge_radius(got[0])
    assert abs(r - 13.0) < 0.01, \
        f"the stored reference resolved to r={r:.2f}; 7.8 is the INNER rim, so the " \
        "rank was lost and this reference would have been silently wrong"
    print(PASS, f"a returned reference still means the outer rim after a mutation (r={r:.1f})")


def test_normal_is_planarity_gated_and_uses_the_tuned_tolerance():
    """A lying-down cylinder's barrel reports "up" at one point on its surface.
    The legacy by:"normal" selector returned it, which is what made Shell fail
    with a bare OCCT error; this predicate must not reintroduce that."""
    from geom_select import query_entities, _face_normal, _face_surface
    from build123d import Vector

    lying = Rot(0, 90, 0) * Cylinder(5, 20)
    # the barrel DOES report +Z at its sampled point — that is the trap
    raw = [f for f in lying.faces() if _face_normal(f).dot(Vector(0, 0, 1)) > 0.99]
    assert any(_face_surface(f) != "plane" for f in raw), \
        "setup: expected a curved face to report +Z, or this proves nothing"

    hits = query_entities(lying, "face", {"normal": {"dir": [0, 0, 1]}})
    assert hits == [], f"a curved barrel matched a direction predicate: {len(hits)}"

    # a flat top still matches, and the tolerance is genuinely applied. The
    # direction must be OFF-AXIS to test this at all: [0,0,0.9] normalises to
    # exactly +Z, so no tolerance would ever reject it.
    res = _q(BOX, {"id": "q", "kind": "face", "where": {"normal": {"dir": [0, 0, 1]}}})[0]
    assert res["count"] == 1, res
    off = [0, 0.1, 1]  # ~5.7 degrees off +Z; 1-cos(5.7) ~ 0.005, inside ANG_TOL 0.02
    loose = _q(BOX, {"id": "q", "kind": "face", "where": {"normal": {"dir": off}}})[0]
    assert loose["count"] == 1, f"5.7 degrees off should be inside the default band: {loose}"
    tight = _q(BOX, {"id": "q", "kind": "face",
                     "where": {"normal": {"dir": off, "tol": 1e-9}}})[0]
    assert tight["count"] == 0, "an explicit tolerance must actually be applied"
    print(PASS, "the normal predicate is planar-only and honours its tolerance")


def test_a_flat_selector_is_refused_rather_than_matching_everything():
    """The item envelope is {kind, sel, where, limit, body, id}. Writing the
    selector FLAT on the item used to leave `sel` unset, which means "no
    selector", which the filter step reads as "match everything" — so a query for
    the one up-facing face of a box came back with all 6, ok:true, and an empty
    `diagnostics`. Nothing in the reply said the selector had been dropped.

    The control is the nested form: it must return STRICTLY FEWER than every
    face, or this test would pass just as well against the broken code."""
    flat = _q(BOX, {"id": "q", "kind": "face", "by": "normal", "dir": [0, 0, 1]})[0]
    assert not flat["ok"], f"a flat selector must be refused: {flat}"
    assert flat["code"] == "badRequest", flat
    # The message has to name the fix. "invalid item" would leave the caller
    # guessing at exactly the point the schema already failed them.
    assert "sel" in flat["error"], flat["error"]
    assert "`by`" in flat["error"] and "`dir`" in flat["error"], flat["error"]

    nested = _q(BOX, {"id": "q", "kind": "face",
                      "sel": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}})[0]
    assert nested["ok"], nested
    assert nested["count"] == 1, nested
    every = _q(BOX, {"id": "q", "kind": "face"})[0]
    assert every["count"] == 6, every
    assert nested["count"] < every["count"], \
        "CONTROL: the nested form must narrow, or the refusal above proves nothing"
    print(PASS, "a flat selector is refused, not silently widened to everything")


def test_the_normal_selector_honours_deg_and_keeps_its_own_default():
    """by:"normal" advertised `deg` and read only `dir`, so deg:0 and deg:80 were
    the same query. The empty direction is the worse half: a direction 11.5 deg
    off +Z returned count 0 with ok:true, an authoritative "no such faces" for a
    box that has one.

    The default must NOT move to _cos_slack's ANG_TOL: every stored by:"normal"
    selector in every saved document resolves through this branch, so widening
    the default would re-target live Shell/Draft/Offset features."""
    def n(**extra):
        sel = {"kind": "face", "by": "normal", "dir": extra.pop("dir")}
        sel.update(extra)
        return _q(BOX, {"id": "q", "kind": "face", "sel": sel})[0]

    off = [0, 0.19937, 0.97992]   # 11.5 deg off +Z — outside the 8.11 deg default
    assert n(dir=off)["count"] == 0, "setup: 11.5 deg must be outside the default band"
    assert n(dir=off, deg=20)["count"] == 1, "deg must WIDEN — this is the silent-empty bug"
    # ... and the same key must TIGHTEN, or "deg works" could just mean "deg is
    # read as always-accept", which is the failure it replaced.
    assert n(dir=off, deg=1)["count"] == 0, "deg must tighten as well as widen"
    assert n(dir=[0, 0, 1], deg=0)["count"] == 1, "deg:0 must still match an exact normal"

    # The default band, pinned on both sides so a tuning change cannot widen it.
    assert n(dir=[0, 0.08716, 0.99619])["count"] == 1, "5 deg is inside the default"
    assert n(dir=[0, 0.15643, 0.98769])["count"] == 0, "9 deg is outside the default"

    # A degree-shaped `tol` is refused here now too, not just on the where path.
    bad = n(dir=[0, 0, 1], tol=5)
    assert not bad["ok"] and bad["code"] == "badRequest", bad
    assert "COSINE" in bad["error"], bad["error"]
    print(PASS, "the normal selector honours deg and keeps its 8.11 deg default")


def test_predicates_compose_as_AND():
    """Dropping any one key must change the answer, or a key is being ignored."""
    both = _q(BOX, {"id": "q", "kind": "face",
                    "where": {"surface": "plane", "normal": {"dir": [0, 0, 1]}}})[0]
    only_surface = _q(BOX, {"id": "q", "kind": "face", "where": {"surface": "plane"}})[0]
    assert both["count"] == 1 and only_surface["count"] == 6, (both, only_surface)

    area_only = _q(BOX, {"id": "q", "kind": "face",
                         "where": {"area": {"min": 399, "max": 401}}})[0]
    assert area_only["count"] == 6, area_only
    within = _q(BOX, {"id": "q", "kind": "face",
                      "where": {"within": {"min": [-1, -1, 5], "max": [1, 1, 15]}}})[0]
    assert within["count"] == 1, f"within should isolate the top face: {within['count']}"
    print(PASS, "predicates compose as AND; each one changes the answer")


def test_count_is_the_pre_limit_total_and_expect_judges_it():
    res = _q(BOX, {"id": "q", "kind": "face", "where": {"surface": "plane"}, "limit": 2})[0]
    assert res["ok"] and res["count"] == 6 and len(res["entities"]) == 2, res

    ok = _q(BOX, {"id": "q", "kind": "face", "where": {"surface": "plane"},
                  "limit": 2, "expect": 6})[0]
    assert ok["ok"], "expect is judged on the true count, not the truncated list"

    bad = _q(BOX, {"id": "q", "kind": "face", "where": {"surface": "plane"}, "expect": 4})[0]
    assert not bad["ok"] and bad["code"] == "expectFailed", bad
    assert bad["count"] == 6, "a failed expectation must still report what it found"
    print(PASS, "count is the pre-limit total; expect is branchable and still reports")


def test_one_bad_item_never_fails_the_call():
    out = _q(BOX,
             {"id": "a", "kind": "face", "where": {"surface": "plane"}},
             {"id": "b", "kind": "face", "body": "nope", "where": {"surface": "plane"}},
             {"id": "c", "kind": "edge", "where": {"curve": "line"}})
    assert len(out) == 3, out
    assert out[0]["ok"] and out[2]["ok"], out
    assert not out[1]["ok"] and out[1]["error"], out[1]
    assert [r["index"] for r in out] == [0, 1, 2], "indices must stay aligned"
    print(PASS, "a bad item is contained; its neighbours still answer")


def test_edge_direction_is_sign_normalised():
    up = _q(BOX, {"id": "q", "kind": "edge", "where": {"dir": [0, 0, 1]}})[0]
    down = _q(BOX, {"id": "q", "kind": "edge", "where": {"dir": [0, 0, -1]}})[0]
    assert up["count"] == 4 and down["count"] == 4, (up["count"], down["count"])
    print(PASS, "+dir and -dir select the same edges (sign-normalised)")


def test_unknown_predicates_and_edge_createdBy_are_refused():
    bad = _q(BOX, {"id": "q", "kind": "face", "where": {"colour": "red"}})[0]
    assert not bad["ok"] and "colour" in bad["error"], bad
    assert bad["code"] == "badRequest", bad

    e = _q(BOX, {"id": "q", "kind": "edge", "where": {"createdBy": "f1"}})[0]
    assert not e["ok"] and e["code"] == "badRequest", e

    k = _q(BOX, {"id": "q", "kind": "vertex", "where": {}})[0]
    assert not k["ok"], k
    print(PASS, "unknown predicates, edge createdBy and bad kinds are all refused")


def test_a_lossy_match_is_reported_not_refused():
    """query is read-only inspection: "this reference went ambiguous, show me
    what it could mean" is one of its uses. It must NOT copy the projection
    path's refuse-on-lossy rule."""
    res = _q(BOX, {"id": "q", "kind": "face",
                   "sel": {"kind": "face", "by": "match",
                           "fp": {"centroid": [0, 0, 10], "normal": [0, 0, 1],
                                  "area": 400.0, "surface": "plane"}}})[0]
    assert res["ok"] and res["count"] == 1, res
    print(PASS, "a resolved selector answers, with any diagnostic alongside")


def test_a_refusal_still_carries_its_repair_payload():
    """The resolver writes candidateFps into `diag` and THEN raises. Assigning
    rec["diagnostics"] only on the success path threw that payload away with the
    exception — so the caller was told "ambiguous" and given nothing to re-pick
    from, which is the one case where the repair data matters most."""
    res = _q(BOX, {"id": "tie", "kind": "face",
                   "sel": {"kind": "face", "by": "nearest",
                           "point": [15.0, 15.0, 0.0]}})[0]
    assert not res["ok"] and res["code"] == "ambiguousReference", res
    assert res["diagnostics"], "the refusal discarded its diagnostics"
    fps = res["diagnostics"][0].get("candidateFps") or []
    assert len(fps) >= 2, fps
    # and a confident pick is unchanged: still ok, still no advisory noise
    clear = _q(BOX, {"id": "clear", "kind": "face",
                     "sel": {"kind": "face", "by": "nearest",
                             "point": [30.0, 0.0, 0.0]}})[0]
    assert clear["ok"] and clear["count"] == 1 and clear["diagnostics"] == [], clear
    print(PASS, f"a refusal keeps its {len(fps)} candidateFps; a clear pick stays clean")


def test_normal_takes_an_angle_and_refuses_a_degree_shaped_tol():
    """`tol` is a COSINE deviation (1 - dot), which is not guessable and was read
    as degrees in the field. `1 - dot` never exceeds 2, so `tol: 5` accepts the
    ANTIPODAL face — "facing up" and "facing down" return the same set. `deg` is
    the same threshold as a half-angle, which is what a caller means."""
    plain = _q(BOX, {"id": "q", "kind": "face",
                     "where": {"normal": {"dir": [0, 0, 1]}}})[0]
    assert plain["count"] == 1, plain

    # a half-angle either side of the sides, which sit exactly 90 deg away
    tight = _q(BOX, {"id": "q", "kind": "face",
                     "where": {"normal": {"dir": [0, 0, 1], "deg": 89}}})[0]
    wide = _q(BOX, {"id": "q", "kind": "face",
                    "where": {"normal": {"dir": [0, 0, 1], "deg": 91}}})[0]
    assert tight["count"] == 1, tight
    assert wide["count"] == 5, wide  # top + four sides, still not the bottom

    bad = _q(BOX, {"id": "q", "kind": "face",
                   "where": {"normal": {"dir": [0, 0, 1], "tol": 5}}})[0]
    assert not bad["ok"] and bad["code"] == "badRequest", bad
    assert "cosine" in bad["error"].lower(), bad["error"]

    both = _q(BOX, {"id": "q", "kind": "face",
                    "where": {"normal": {"dir": [0, 0, 1], "deg": 5, "tol": 0.1}}})[0]
    assert not both["ok"] and both["code"] == "badRequest", both

    # a legitimate cosine tol keeps working unchanged: deg 5 == tol 0.0038
    same = _q(BOX, {"id": "q", "kind": "face",
                    "where": {"normal": {"dir": [0, 0, 1], "tol": 0.0038}}})[0]
    assert same["ok"] and same["count"] == 1, same
    print(PASS, "normal takes deg, and a degree-shaped tol is refused not honoured")


def test_unknown_predicate_VALUES_are_refused_like_unknown_keys():
    """An unknown KEY was already a badRequest; an unknown VALUE returned
    ok:true count:0, which reads as "no such face exists" — a wrong answer to a
    question that was never asked. Both alphabets are closed."""
    for bad in ("banana", "Plane"):
        r = _q(BOX, {"id": "q", "kind": "face", "where": {"surface": bad}})[0]
        assert not r["ok"] and r["code"] == "badRequest", (bad, r)
    r = _q(BOX, {"id": "q", "kind": "edge", "where": {"curve": "straight"}})[0]
    assert not r["ok"] and r["code"] == "badRequest", r

    ok = _q(BOX, {"id": "q", "kind": "face", "where": {"surface": "plane"}})[0]
    assert ok["ok"] and ok["count"] == 6, ok
    print(PASS, "a misspelt surface or curve is refused, not answered with zero")


def test_a_malformed_item_carries_a_code_not_just_prose():
    """`sel` as a bare string reaches sel.get("by") and dies with an
    AttributeError, which has no .code — so the record shipped raw Python prose
    that no caller can branch on. The list form of this was already fixed."""
    r = _q(BOX, {"id": "q", "kind": "face", "sel": "all"})[0]
    assert not r["ok"], r
    assert r["code"] == "badRequest", r
    print(PASS, "a malformed sel is coded badRequest, not bare prose")


TWO_BODIES = _doc(
    {"id": "s1", "type": "sketch", "plane": "XY",
     "entities": [{"id": "k1", "type": "circle", "radius": 10, "x": 0, "y": 0}]},
    {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 20, "operation": "new"},
    {"id": "s2", "type": "sketch", "plane": "XY",
     "entities": [{"id": "k2", "type": "circle", "radius": 3, "x": 200, "y": 0}]},
    {"id": "e2", "type": "extrude", "sketch": "s2", "distance": 6, "operation": "new"},
)


def _top_fp(doc, body=None):
    """The fingerprint of a body's top face, as a caller would have stored it."""
    item = {"id": "t", "kind": "face",
            "where": {"normal": {"dir": [0, 0, 1]}, "area": {"min": 1.0}}}
    if body:
        item["body"] = body
    r = _q(doc, item)[0]
    assert r["ok"] and r["count"] == 1, r
    return r["entities"][0]["sel"]["fp"]


def test_strict_refuses_the_three_ways_a_match_was_confidently_wrong():
    """by:"match" is a nearest-neighbour search that ALWAYS returns its best
    candidate — it cannot fail, so every one of these came back ok:true with
    expect:1 satisfied. Each case trips exactly one invariant."""
    fp = _top_fp(TWO_BODIES, "body1")

    # 1. the right fingerprint, the WRONG BODY: 30mm away on a part 6mm across
    wrong_body = _q(TWO_BODIES, {"id": "q", "kind": "face", "body": "body2", "expect": 1,
                                 "sel": {"kind": "face", "by": "match", "fp": fp}})[0]
    assert not wrong_body["ok"], f"a wrong-body match was accepted: {wrong_body}"
    assert wrong_body["code"] == "matchImplausible", wrong_body
    assert wrong_body["match"]["posRel"] > 2.0, wrong_body["match"]
    assert wrong_body["candidateFps"], "no repair payload on the refusal"

    # 2. ask for a CYLINDER, get a plane
    as_cyl = dict(fp, surface="cylinder", radius=12.5)
    typed = _q(BOX, {"id": "q", "kind": "face",
                     "sel": {"kind": "face", "by": "match", "fp": as_cyl}})[0]
    assert not typed["ok"] and typed["code"] == "matchImplausible", typed
    assert "classMismatch" in typed["match"], typed["match"]

    # 3. a fingerprint for a face 250x the size AND in the wrong place — the
    #    shape of the real defect. Size alone is deliberately not enough: see
    #    test_a_big_resize_that_did_not_move_is_accepted.
    huge = dict(_top_fp(BOX), area=99999.0, centroid=[0, 0, 0])
    fiction = _q(BOX, {"id": "q", "kind": "face",
                       "sel": {"kind": "face", "by": "match", "fp": huge}})[0]
    assert not fiction["ok"] and fiction["code"] == "matchImplausible", fiction
    assert fiction["match"]["sizeRatio"] >= 50.0, fiction["match"]
    print(PASS, "wrong body, wrong surface class and a 250x area are all refused")


def test_a_big_resize_that_did_not_move_is_accepted():
    """The size test is a CONJUNCTION, and this is why. Area is a SQUARED
    quantity, so a 10x area change is only 3.16x linear — a rib going 2mm -> 7mm.
    Judged on size alone, such a reference was refused while resolving perfectly:
    same centroid to 16 significant figures, same normal, same surface class.
    Refusing an answer you are simultaneously certain of breaks working
    documents, so a size change only counts against a match that also MOVED."""
    fp = _top_fp(BOX)
    resized = dict(fp, area=fp["area"] / 12.0)  # the face shrank 12x in place
    got = _q(BOX, {"id": "q", "kind": "face",
                   "sel": {"kind": "face", "by": "match", "fp": resized}})[0]
    assert got["ok"], f"a 12x in-place resize was refused: {got}"
    assert got["match"]["sizeRatio"] > 10.0, got["match"]
    assert got["match"]["posRel"] < 1e-6, got["match"]
    print(PASS, "a big resize that did not move is accepted, not refused")


def test_offace_and_tangentchain_cannot_bypass_the_gate():
    """Those selectors claim an identity too — with an INNER fingerprint. Judging
    only by:"match" left the gate one field name from off: a fingerprint refused
    standalone sailed through ofFace reporting judged:false, which the schema
    defines as "no identity was claimed"."""
    fp = _top_fp(TWO_BODIES, "body1")

    direct = _q(TWO_BODIES, {"id": "q", "kind": "face", "body": "body2",
                             "sel": {"kind": "face", "by": "match", "fp": fp}})[0]
    assert not direct["ok"] and direct["code"] == "matchImplausible", direct

    via = _q(TWO_BODIES, {"id": "q", "kind": "edge", "body": "body2",
                          "sel": {"kind": "edge", "by": "ofFace", "face": fp}})[0]
    assert not via["ok"], f"ofFace bypassed the gate: {via}"
    assert via["code"] == "matchImplausible", via
    assert via["match"].get("via") == "ofFace", via["match"]

    # and a legitimate ofFace still works
    own = _top_fp(TWO_BODIES, "body2")
    fine = _q(TWO_BODIES, {"id": "q", "kind": "edge", "body": "body2",
                           "sel": {"kind": "edge", "by": "ofFace", "face": own}})[0]
    assert fine["ok"] and fine["count"] >= 1, fine
    print(PASS, "ofFace judges its inner reference; a good one still resolves")


def test_a_good_match_is_untouched_and_says_it_was_judged():
    """The gate must not cost a correct answer. THE risk here is a false refusal,
    so this is the test that matters more than the three above."""
    fp = _top_fp(BOX)
    good = _q(BOX, {"id": "q", "kind": "face", "expect": 1,
                    "sel": {"kind": "face", "by": "match", "fp": fp}})[0]
    assert good["ok"] and good["count"] == 1, good
    assert good["match"]["judged"] is True, good["match"]
    assert "implausible" not in good["match"], good["match"]
    assert good["match"]["sizeRatio"] < 1.01 and good["match"]["posRel"] < 0.01, good["match"]

    # a set-returning item claims no identity, so there is nothing to judge
    setwise = _q(BOX, {"id": "q", "kind": "face", "where": {"surface": "plane"}})[0]
    assert setwise["ok"] and setwise["count"] == 6, setwise
    assert setwise["match"] == {"judged": False}, setwise["match"]
    print(PASS, "a correct match passes and is marked judged; a set item is not judged")


def test_strict_false_restores_the_old_confident_wrong_answer():
    """The escape hatch has to actually work, or `strict` is a one-way door."""
    fp = _top_fp(TWO_BODIES, "body1")
    item = {"id": "q", "kind": "face", "body": "body2", "expect": 1,
            "sel": {"kind": "face", "by": "match", "fp": fp}}
    loose = query_geometry(TWO_BODIES, [item], strict=False)["results"][0]
    assert loose["ok"] and loose["count"] == 1, loose
    assert loose["match"].get("implausible"), \
        "strict:false must still REPORT the judgement, just not act on it"
    print(PASS, "strict:false answers as before, with the judgement still visible")


def test_expect_can_assert_identity_not_just_cardinality():
    """`expect: 1` on a by:"match" is a tautology — that selector always resolves
    exactly one. The object form lets the CALLER supply the discriminator, which
    is the one assertion here that no calibration of mine can get wrong."""
    fp = _top_fp(BOX)
    sel = {"kind": "face", "by": "match", "fp": fp}

    ok = _q(BOX, {"id": "q", "kind": "face", "sel": sel,
                  "expect": {"count": 1, "area": {"min": 390, "max": 410}}})[0]
    assert ok["ok"], ok

    miss = _q(BOX, {"id": "q", "kind": "face", "sel": sel,
                    "expect": {"count": 1, "area": {"min": 1000}}})[0]
    assert not miss["ok"] and miss["code"] == "expectFailed", miss
    assert "area" in miss["error"], miss["error"]

    # the plain integer form is untouched
    n = _q(BOX, {"id": "q", "kind": "face", "where": {"surface": "plane"},
                 "expect": 6})[0]
    assert n["ok"], n
    print(PASS, "expect takes an object and asserts what was found, not just how many")


def test_totals_cap_bounds_the_whole_reply():
    """Per-item limits MULTIPLY. The total cap is what keeps a 64-item request
    from building a reply past the frame cap, which would close the socket."""
    from builder import _QUERY_MAX_TOTAL

    sphere = _doc({"id": "s", "type": "sphere", "radius": 10})
    items = [{"id": f"q{i}", "kind": "face", "where": {}, "limit": 5000}
             for i in range(8)]
    out = query_geometry(sphere, items)["results"]
    got = sum(len(r["entities"]) for r in out)
    assert got <= _QUERY_MAX_TOTAL, f"{got} entities exceeds the total cap"
    print(PASS, f"the whole reply is capped at {_QUERY_MAX_TOTAL} entities")


def main():
    print("Query-op tests")
    test_a_returned_reference_survives_a_mutation()
    test_normal_is_planarity_gated_and_uses_the_tuned_tolerance()
    test_a_flat_selector_is_refused_rather_than_matching_everything()
    test_the_normal_selector_honours_deg_and_keeps_its_own_default()
    test_predicates_compose_as_AND()
    test_count_is_the_pre_limit_total_and_expect_judges_it()
    test_one_bad_item_never_fails_the_call()
    test_edge_direction_is_sign_normalised()
    test_unknown_predicates_and_edge_createdBy_are_refused()
    test_a_lossy_match_is_reported_not_refused()
    test_a_refusal_still_carries_its_repair_payload()
    test_normal_takes_an_angle_and_refuses_a_degree_shaped_tol()
    test_unknown_predicate_VALUES_are_refused_like_unknown_keys()
    test_a_malformed_item_carries_a_code_not_just_prose()
    test_strict_refuses_the_three_ways_a_match_was_confidently_wrong()
    test_a_big_resize_that_did_not_move_is_accepted()
    test_offace_and_tangentchain_cannot_bypass_the_gate()
    test_a_good_match_is_untouched_and_says_it_was_judged()
    test_strict_false_restores_the_old_confident_wrong_answer()
    test_expect_can_assert_identity_not_just_cardinality()
    test_totals_cap_bounds_the_whole_reply()
    print("ALL PASS")


if __name__ == "__main__":
    main()
