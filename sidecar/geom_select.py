"""Selector resolution — the topological-naming mitigation.

Geometry is NEVER referenced by index. References are queryable property
descriptors, re-resolved against the freshly built solid on every rebuild.

Edge selectors:
  {"kind":"edge", "by":"axis",    "axis":"Z"}          edges parallel to Z (ALL of them)
  {"kind":"edge", "by":"all"}                          every edge
  {"kind":"edge", "by":"nearest", "point":[x,y,z]}     edge nearest a 3D point
  {"kind":"edge", "by":"match",   "fp":{...}, "nth":k} ONE edge by scored fingerprint
  {"kind":"edge", "by":"tangentChain", "seed":{...}}   an edge + its tangent-continuous chain
  {"kind":"edge", "by":"ofFace",  "face":{...}}        all edges bounding a face

Face selectors:
  {"kind":"face", "by":"normal",  "dir":[0,0,1]}       PLANAR faces whose normal ~ dir (ALL)
  {"kind":"face", "by":"nearest", "point":[x,y,z]}     face nearest a 3D point
  {"kind":"face", "by":"match",   "fp":{...}, "nth":k} ONE face by scored fingerprint
  {"kind":"face", "by":"all"}                          every face

--- selector v2 (`by:"match"` / structural forms) -----------------------------

The legacy `axis`/`normal` forms mean "ALL parallel / co-normal entities" — they
cannot mean "this ONE edge/face". `nearest` is the only single-entity legacy form
and it collides when two entities share a midpoint/centroid (concentric circles,
mirrored features) or when the rebuilt OCCT geometry drifts slightly from the kernel
that authored the selector.

`match` fixes that: it carries a multi-invariant geometric FINGERPRINT (edge:
midpoint + direction + length [+ radius/center for arcs]; face: centroid + normal +
area [+ radius]) and resolves by SCORING every candidate on the fields that are
present, lowest cost wins. Two concentric circles differ in radius/center; two
mirrored edges differ in midpoint; a drifted edge still matches because each invariant
is compared with tolerance, not equality. The margin to the runner-up is the
confidence; a genuine tie (symmetric twins) is broken by `nth` over a rebuild-stable
canonical order.

Resolution is BEST-EFFORT and never raises on a poor match: it returns the
lowest-cost candidate and records a `ResolveDiag` (confidence + lossy flag) via the
optional `diag` accumulator, so the rebuild always completes and downstream tooling
can see which selections were shaky. It returns nothing only when the body has no
candidates at all.

NOTE: the frontend now emits `by:"match"` edge selectors — the Project tool
persists sidecar-authored fingerprints as the source reference of projected
sketch entities (builder._recompute_projections resolves them on every rebuild,
and the projectGeometry op authors them). `by:"tangentChain"` is implemented and
covered by test_selector_v2.py but still has no frontend caller.
"""

import json
import math
import os

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

import errors

from build123d import Axis, Vector, GeomType

AXES = {"X": Axis.X, "Y": Axis.Y, "Z": Axis.Z}

# --- tunable scoring constants -----------------------------------------------
# These 13 numbers are the ONLY thing that governs how `by:"match"` scores
# candidates; they are externalized to selector_tuning.json (next to this file)
# so an optimization loop can tune them without editing resolver logic. The
# hardcoded defaults below are authoritative fallbacks: if the JSON is missing a
# key (or the whole file), the shipped behavior is unchanged. Values are applied
# to module globals so the resolver body can keep referencing them by name; the
# oracle overrides them per-experiment via configure().
#
#   ANG_TOL      ~11.5deg of slack on (1 - |dot|) for dir/normal
#   POS_DRIFT    mm of absolute positional drift budget (kernel disagreement)
#   REL_DRIFT    + this * bbox diagonal (position tol scales with the part)
#   LEN_REL_TOL  2% on length / radius
#   AREA_REL_TOL 5% on area
#   TIE_BAND     runner-up within 15% of best => a genuine tie (need nth)
#   NEAREST_TIE_BAND  the same idea for by:"nearest", but on RAW DISTANCE rather
#                than the weighted match cost — so it is far tighter. 15% apart
#                in millimetres is a clear winner; what we must refuse is the
#                degenerate case where two entities are indistinguishable by this
#                metric at all (a point on a shared edge, or on a circle's axis
#                where every point of the rim is equidistant). Measured on the
#                real corpus: the references that silently flipped were EXACT
#                ties (margin 0.0000), while legitimate picks cleared 2% easily.
#   ACCEPT_MAX   best cost above this => resolvable but marginal (lossy)
#   W_*          scoring weights, per normalized error term
#   W_RANK       penalty per rank step for concentric rims (scale-invariant)
_DEFAULTS = {
    "ANG_TOL": 0.02,
    "POS_DRIFT": 0.5,
    "REL_DRIFT": 1e-3,
    "LEN_REL_TOL": 0.02,
    "AREA_REL_TOL": 0.05,
    "TIE_BAND": 0.15,
    "NEAREST_TIE_BAND": 0.02,
    "ACCEPT_MAX": 2.5,
    "W_POS": 3.0,
    "W_DIR": 2.0,
    "W_LEN": 1.0,
    "W_RAD": 2.0,
    "W_AREA": 1.0,
    "W_TYPE": 4.0,
    "W_RANK": 2.0,
}
_TUNING = dict(_DEFAULTS)


def _apply_tuning():
    """Push the current _TUNING values onto module globals (ANG_TOL, W_POS, ...)."""
    globals().update({k: float(_TUNING[k]) for k in _DEFAULTS})


def configure(src):
    """Override tuning constants from a dict or a JSON file path.

    Missing keys keep their default. Unknown keys are ignored. The oracle calls
    this once per experiment with the config under test; the app auto-loads
    selector_tuning.json at import (below) for the shipped values.
    """
    if isinstance(src, str):
        with open(src) as f:
            src = json.load(f)
    _TUNING.update({k: src[k] for k in _DEFAULTS if k in src})
    _apply_tuning()


_apply_tuning()
try:
    configure(os.path.join(os.path.dirname(__file__), "selector_tuning.json"))
except FileNotFoundError:
    pass


# --- small helpers -----------------------------------------------------------

# The prose a lossy resolution carries. These are the amber timeline chip's
# TOOLTIP now (src/ui/timeline.ts renders any diagnostic's `reason` on a feature
# that built), so they are written for the user, not for us — "tie;
# canonical-first" was a developer note that shipped verbatim to a beta.
# REASON_TIE_CANONICAL is also a KEY: builder._judge_match tests for it to call a
# match implausible, so it is a named constant rather than a literal at both
# ends, and rewording it cannot silently unhook that check.
REASON_TIE_CANONICAL = "Several saved references matched equally well — the first was used."
REASON_TIE_NTH = "Several saved references matched equally well — the one this feature names was used."
REASON_MARGINAL = "The saved reference is no longer a close match — the nearest candidate was used."
REASON_SLID_OUT = ("This face moved out from under the saved pick point. The face still "
                   "in line with it was used; re-pick the face if that is the wrong one.")


def _v(seq):
    return Vector(*seq) if not isinstance(seq, Vector) else seq


def _finite3(seq, want=None):
    """A document-supplied coordinate list, rounded — or None if it is not one.

    Selector points come out of the .sindri file with no schema in front of
    them, and build123d's Vector SILENTLY collapses non-numeric args to
    (0,0,0) rather than raising, so an unchecked point does not fail, it
    relocates. Callers that need a real point must treat None as "no point".
    `want` pins the length where the caller knows it (3 for a coordinate).
    """
    try:
        vals = list(seq)
    except TypeError:
        return None
    if want is not None and len(vals) != want:
        return None
    out = []
    for v in vals:
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        if not math.isfinite(v):
            return None
        out.append(round(float(v), 6))
    return out or None


def _dist(a, b):
    return (a - b).length


def _unit(v):
    n = v.length
    return v / n if n > 1e-12 else v


def _rel_err(a, b):
    d = max(abs(a), abs(b), 1e-9)
    return abs(a - b) / d


# One-slot identity memo for _bbox_diag. Mirrors builder.bbox_of's _BBOX_MEMO,
# including its `is` guard — a different shape object recomputes.
_DIAG_MEMO = [None, 1.0]


def _bbox_diag(part):
    """Diagonal of `part`'s AABB, the scale that position tolerances ride on
    (POS_DRIFT + REL_DRIFT * diag).

    MEMOIZED because the underlying `.bounding_box()` is OCCT's AddOptimal_s,
    whose cost explodes on NON-ANALYTIC surfaces — and this is called once per
    edge_fingerprint(). Measured: an all-analytic plate 0.0 ms; the same plate
    with two TORUS faces from a hole-rim fillet 13.8 ms; real imported STEP
    (nist_ftc_06, 187 faces of which 12 tori) 132.6 ms. That last one made
    fingerprinting the body's 573 edges cost 37.5 s, essentially all of it this
    call recomputing the same box.

    Cached on object identity only, and a stale value is BENIGN here: it scales a
    tolerance, so being a little off widens or narrows the matching band rather
    than changing which entity is correct. That is the opposite of builder's
    bbox_of, whose conservatism IS load-bearing (a box tighter than the truth
    silently drops a real interference), which is why that one is exact and this
    one may be approximate."""
    if _DIAG_MEMO[0] is part:
        return _DIAG_MEMO[1]
    try:
        bb = part.bounding_box()
        d = (bb.max - bb.min).length or 1.0
    except Exception:
        d = 1.0
    _DIAG_MEMO[0], _DIAG_MEMO[1] = part, d
    return d


def _edge_curve(e):
    """Coarse curve class name matching EdgeFingerprint.curve."""
    try:
        n = e.geom_type.name.lower()
    except Exception:
        return "other"
    if n == "line":
        return "line"
    if n == "circle":
        return "circle"
    if n == "ellipse":
        return "ellipse"
    if n in ("bspline", "bezier"):
        return "bspline"
    return "other"


def _edge_mid(e):
    """Midpoint of the edge (fraction 0.5 of its LENGTH), with a center() fallback."""
    try:
        return e.position_at(0.5)
    except Exception:
        return e.center()


def _edge_dir(e):
    """Unit tangent at the midpoint, sign-normalized (edges are unoriented, so a
    reversed rebuilt edge still matches). Falls back to the chord direction."""
    try:
        d = _unit(e.tangent_at(0.5))
    except Exception:
        try:
            verts = e.vertices()
            d = _unit(Vector(verts[-1].to_tuple()) - Vector(verts[0].to_tuple()))
        except Exception:
            return Vector(0, 0, 0)
    return _sign_normalize(d)


def _sign_normalize(d):
    """Make the first non-tiny component positive, so +dir and -dir hash the same."""
    for c in (d.X, d.Y, d.Z):
        if abs(c) > 1e-9:
            return d if c > 0 else d * -1
    return d


def _edge_radius(e):
    try:
        return float(e.radius)
    except Exception:
        return None


def _edge_center(e):
    try:
        return e.arc_center
    except Exception:
        return None


def _face_surface(f):
    try:
        n = f.geom_type.name.lower()
    except Exception:
        return "other"
    if n in ("plane", "cylinder", "cone", "sphere", "torus"):
        return n
    if n in ("bspline", "bezier"):
        return "bspline"
    return "other"


def _face_centroid(f):
    try:
        return f.center()
    except Exception:
        return _v((0, 0, 0))


def _face_normal(f):
    # NOTE: this is an ON-DISK FORMAT, not just a helper. face_fingerprint()
    # stores its output in every saved `by:"match"` face selector, and
    # _face_cost() compares live faces against those stored values. Flipping the
    # orientation convention here would score every existing selector at
    # W_DIR * (1 - (-1)) / ANG_TOL = 200 against ACCEPT_MAX 2.5 — i.e. every
    # saved face reference in every .sindri goes lossy at once. The test suite
    # CANNOT catch that, because it authors and compares through this same
    # function. Change the convention only with a migration and a tester note.
    #
    # It honours TopAbs_REVERSED already: normal_at() bottoms out in
    # BRepGProp_Face::Normal, which applies the reversal itself, so a face off a
    # boolean or a shell reports its OUTWARD normal on valid geometry. There is
    # no inward-twin bug here to fix.
    try:
        return _unit(f.normal_at())
    except Exception:
        return Vector(0, 0, 0)


def _is_planar(f):
    """True when `f` is a planar face. `Face.is_planar` returns a Plane or None,
    and can raise on a face with a null surface handle — guarded like every other
    face query in this module. A face that throws is excluded, which matches the
    behaviour it already had: _face_normal returns (0,0,0) for it, whose dot with
    any direction is 0 and so never passed the by:"normal" threshold anyway."""
    try:
        return f.is_planar is not None
    except Exception:
        return False


def _face_radius(f):
    """Radius of a cylindrical or spherical face, else None.

    `Face.radius` answers None for ANY face whose surface is a
    `Geom_RectangularTrimmedSurface`, whatever lies underneath (build123d
    two_d.py:1245 gates on exactly that). ShapeFix_Face puts that wrapper around
    every cylinder the mesh-import fitter builds, so a fitted bore reported the
    right `geom_type` and the right area while its radius read None — which made
    `query_entities(..., {'surface':'cylinder','radius':{...}})` return ZERO on
    it, and made `face_fingerprint` author a `by:"match"` reference WEAKER than
    the same reference on a kernel-built cylinder. Both call sites come through
    here, so they are fixed together.

    `BRepAdaptor_Surface` resolves the trim and reports the underlying analytic
    surface. Rebuilding the face on `.BasisSurface()` does not (measured).

    The GeomAbs gate is not decoration: `.Cylinder()` on a planar face raises
    Standard_NoSuchObject. The `_face_surface` gate in FRONT of everything is
    there so a dense imported body's thousands of planar facets leave with one
    geom_type read and no adaptor — `face_fingerprint` calls this on every face
    it authors, and `Face.radius` would read geom_type again anyway. Measured on
    3,600 planar faces: 4.51 us/face before this change, 4.30 us/face after; a
    cylindrical face pays 9.4 us for the second geom_type read, and a body has
    thousands of the former and a handful of the latter.
    """
    if _face_surface(f) not in ("cylinder", "sphere"):
        return None
    try:
        r = f.radius
        if r is not None:
            return float(r)
    except Exception:
        pass
    try:
        from OCP.BRepAdaptor import BRepAdaptor_Surface
        from OCP.GeomAbs import GeomAbs_SurfaceType

        ad = BRepAdaptor_Surface(f.wrapped)
        t = ad.GetType()
        if t == GeomAbs_SurfaceType.GeomAbs_Cylinder:
            return float(ad.Cylinder().Radius())
        if t == GeomAbs_SurfaceType.GeomAbs_Sphere:
            return float(ad.Sphere().Radius())
    except Exception:
        pass
    return None


# --- concentric rank (scale-invariant rim discriminator) ---------------------


def _rank_in_center_group(e, part, tol):
    """(rank, group_size) for a circle edge `e` within its shared-center group in
    `part`. rank = number of concentric siblings with strictly smaller radius
    (0 = innermost); scale-invariant under a uniform mutation. Returns (None, None)
    for a non-circle / degenerate edge. Strictly-less-than counting is robust to `e`
    appearing (or not) in a fresh part.edges() list."""
    c, r = _edge_center(e), _edge_radius(e)
    if c is None or r is None:
        return None, None
    sibs = []
    for x in part.edges():
        if _edge_curve(x) == "circle":
            cc, rr = _edge_center(x), _edge_radius(x)
            if cc is not None and rr is not None and _dist(cc, c) < tol:
                sibs.append(rr)
    rank = sum(1 for rr in sibs if rr < r - 1e-9)
    return rank, len(sibs)


def _circle_center_groups(edges, tol):
    """Map id(e) -> (rank, group_size) for every circle edge in `edges`. Circles whose
    centers coincide within `tol` form one group; rank is the index in the group's
    ascending-radius order. Keyed by id(e), so the caller MUST score over this same
    edge-list instance."""
    circles = []
    for e in edges:
        if _edge_curve(e) == "circle":
            c, r = _edge_center(e), _edge_radius(e)
            if c is not None and r is not None:
                circles.append((e, c, r))
    out = {}
    for e, c, r in circles:
        sibs = [rr for (_x, cc, rr) in circles if _dist(cc, c) < tol]
        out[id(e)] = (sum(1 for rr in sibs if rr < r - 1e-9), len(sibs))
    return out


# --- fingerprint authoring (canonical; corpus + frontend should both use this) ---


def edge_fingerprint(e, part):
    """Author an edge selector fingerprint from a real edge. For a circle, additionally
    records radius_rank/radius_group so concentric rims survive a scale mutation that
    makes the absolute radius (and midpoint, a circumference point) stale."""
    m, d = _edge_mid(e), _edge_dir(e)
    fp = {"mid": [m.X, m.Y, m.Z], "dir": [d.X, d.Y, d.Z], "length": e.length, "curve": _edge_curve(e)}
    if _edge_curve(e) == "circle":
        r, c = _edge_radius(e), _edge_center(e)
        if r is not None:
            fp["radius"] = r
        if c is not None:
            fp["center"] = [c.X, c.Y, c.Z]
        rank, gsize = _rank_in_center_group(e, part, POS_DRIFT + REL_DRIFT * _bbox_diag(part))
        if gsize is not None:
            fp["radius_rank"], fp["radius_group"] = rank, gsize
    return fp


def face_fingerprint(f, part):
    """Author a face selector fingerprint. `part` is accepted for symmetry with
    edge_fingerprint and future concentric-face rank support (unused today).

    `area` is OMITTED when the integration yields zero (or worse) on a face that
    plainly has extent — which happens on damaged imports, whose faces can carry
    broken parametric domains that BRepGProp bounds to nothing. Storing that 0.0
    is not merely uninformative, it is corrosive: _rel_err against 0.0 is 1.0 for
    EVERY candidate, so the area term contributes a flat W_AREA/AREA_REL_TOL =
    +20 against an ACCEPT_MAX of 2.5. The reference is then permanently lossy,
    and its area discriminator is flattened to a constant, so ties fall through
    to position and normal alone. _face_cost already guards with `if "area" in
    fp`, so an absent key degrades cleanly to the remaining terms.
    """
    c, n = _face_centroid(f), _face_normal(f)
    fp = {"centroid": [c.X, c.Y, c.Z], "normal": [n.X, n.Y, n.Z]}
    try:
        a = f.area
    except Exception:
        a = None
    if a is not None and math.isfinite(a) and a > 0.0:
        fp["area"] = a  # kept in its historical position in the key order
    fp["surface"] = _face_surface(f)
    r = _face_radius(f)
    if r is not None:
        fp["radius"] = r
    return fp


# --- scoring -----------------------------------------------------------------


def _edge_cost(e, fp, tol_pos, rank_info=None):
    # Concentric rim (radius_group >= 2): under a uniform scale mutation the midpoint
    # (a CIRCUMFERENCE point, not the center), length, and absolute radius all go stale
    # and favor the wrong rim. Score only the scale-stable signals — center (locates the
    # family), curve type, and the radius RANK within the shared-center group. rank_info
    # is (rank, group_size) for THIS edge in the current part, or None.
    if _edge_curve(e) == "circle" and fp.get("radius_group", 1) >= 2 and "radius_rank" in fp:
        c = _edge_center(e)
        cost = W_POS * _dist(c, _v(fp["center"])) / tol_pos if (c is not None and "center" in fp) else 0.0
        if fp.get("curve") and _edge_curve(e) != fp["curve"]:
            cost += W_TYPE
        if rank_info is not None and rank_info[1] == fp["radius_group"]:
            cost += W_RANK * abs(rank_info[0] - fp["radius_rank"])
        else:
            # group size changed under mutation: fall back to the (stale) absolute radius
            r = _edge_radius(e)
            if "radius" in fp and r is not None:
                cost += W_RAD * _rel_err(r, fp["radius"]) / LEN_REL_TOL
        return cost

    cost = W_POS * _dist(_edge_mid(e), _v(fp["mid"])) / tol_pos
    if "dir" in fp:
        dot = abs(_edge_dir(e).dot(_unit(_v(fp["dir"]))))
        cost += W_DIR * (1.0 - dot) / ANG_TOL
    if "length" in fp:
        cost += W_LEN * _rel_err(e.length, fp["length"]) / LEN_REL_TOL
    if fp.get("curve") and _edge_curve(e) != fp["curve"]:
        cost += W_TYPE
    if _edge_curve(e) == "circle":
        r = _edge_radius(e)
        if "radius" in fp and r is not None:
            cost += W_RAD * _rel_err(r, fp["radius"]) / LEN_REL_TOL
        c = _edge_center(e)
        if "center" in fp and c is not None:
            cost += W_POS * _dist(c, _v(fp["center"])) / tol_pos  # kills concentrics
    return cost


def _face_cost(f, fp, tol_pos):
    cost = W_POS * _dist(_face_centroid(f), _v(fp["centroid"])) / tol_pos
    if "normal" in fp:
        dot = _face_normal(f).dot(_unit(_v(fp["normal"])))  # signed: an inward twin is rejected
        cost += W_DIR * (1.0 - dot) / ANG_TOL
    if "area" in fp:
        cost += W_AREA * _rel_err(f.area, fp["area"]) / AREA_REL_TOL
    if fp.get("surface") and _face_surface(f) != fp["surface"]:
        cost += W_TYPE
    if "radius" in fp:
        r = _face_radius(f)
        if r is not None:
            cost += W_RAD * _rel_err(r, fp["radius"]) / LEN_REL_TOL
    return cost


def _canonical_key_edge(e):
    p = _edge_mid(e)
    try:
        ln = e.length
    except Exception:
        ln = 0.0
    return (round(p.X, 3), round(p.Y, 3), round(p.Z, 3), round(ln, 3))


def _canonical_key_face(f):
    p = _face_centroid(f)
    try:
        ar = f.area
    except Exception:
        ar = 0.0
    return (round(p.X, 3), round(p.Y, 3), round(p.Z, 3), round(ar, 3))


def _resolve_one(cands, cost_fn, key_fn, nth):
    """Score `cands`, return (best_entity_or_None, confidence, lossy, reason).

    Best-effort: always returns the lowest-cost candidate (never raises on a poor
    match). A near-tie is broken by `nth` over a rebuild-stable canonical order.
    """
    if not cands:
        return None, 0.0, True, "no candidates on this body"
    scored = sorted(((cost_fn(x), x) for x in cands), key=lambda t: t[0])
    best_cost, best = scored[0]
    runner = scored[1][0] if len(scored) > 1 else math.inf
    margin = (runner - best_cost) / (runner + 1e-9) if math.isfinite(runner) else 1.0

    if margin < TIE_BAND:
        tied = [x for c, x in scored if (c - best_cost) / (runner + 1e-9) < TIE_BAND]
        tied.sort(key=key_fn)
        idx = nth if (isinstance(nth, int) and 0 <= nth < len(tied)) else 0
        reason = REASON_TIE_NTH if nth is not None else REASON_TIE_CANONICAL
        return tied[idx], margin, (nth is None), reason

    lossy = best_cost > ACCEPT_MAX
    return best, margin, lossy, (REASON_MARGINAL if lossy else None)


def _push_diag(diag, feature_id, kind, resolved, confidence, lossy, reason, at=None,
               candidates=None, code=None, candidate_fps=None):
    # HEAD GATE, load-bearing: a confident, unambiguous resolution records
    # NOTHING. `diag` means "resolutions worth acting on", and callers rely on
    # that — builder._project_source refuses on a lossy entry, and keying on
    # "diag is non-empty" instead once turned a perfectly good cylinder-rim pick
    # into a hard failure. Asserted by test_selector_ambiguity. Do not relax it
    # to carry informational entries; add a separate channel instead.
    if diag is None or not (lossy or confidence < 0.5):
        return
    entry = {
        "feature_id": feature_id,
        "kind": kind,
        "resolved": resolved,
        "confidence": round(float(confidence), 3),
        "lossy": bool(lossy),
        "reason": reason,
    }
    # `at` is the selector's OWN stored point, not the geometry we found. It is
    # what lets the UI identify WHICH selector of a multi-selector feature went
    # ambiguous, so it can offer to re-pick that one. Without it the frontend
    # knows a feature failed but not which of its five faces to ask about.
    # It comes STRAIGHT OUT OF THE DOCUMENT, so it is coerced defensively: a
    # hand-edited or corrupt file whose point holds a string used to raise the
    # ValueError right here, and rebuild's handler then put that string —
    # document text — into the feature's error message in the sidecar's own
    # voice, with no {body} slot. Dropping a malformed `at` costs the Re-pick
    # button on a reference that is already unrepairable.
    if at is not None:
        entry["at"] = _finite3(at, want=3)
        if entry["at"] is None:
            del entry["at"]
    if candidates:
        entry["candidates"] = list(candidates)
    # `candidates` is PROSE for a human and is frozen as string[] permanently —
    # it is a shipped TS interface member and changing its element type is a hard
    # compile break at three call sites. `candidateFps` is the structured twin:
    # each entry is a real fingerprint, so a caller can turn the one it wants
    # into a {by:"match", fp} selector and repair the reference without a human
    # picking in the viewport.
    if candidate_fps:
        entry["candidateFps"] = list(candidate_fps)
    # The code belongs on the DIAGNOSTIC as well as the error: the Re-pick UI
    # reads RebuildResult.diagnostics, never `error`, so a code that lives only
    # on the fatal is invisible to the one consumer that most wants it.
    if code:
        entry["code"] = code
    diag.append(entry)


# --- public API --------------------------------------------------------------


# How far apart two tied faces' closest points may be and still count as THE
# SAME point. Both come out of the same kernel on the same solid, so a genuine
# shared-boundary hit agrees to arithmetic noise (measured 7.000000 vs 7.000000
# on the report's geometry). This is slack for floating point, NOT a geometric
# tolerance, and it must stay tight: too tight only means refusing, which is
# exactly the behaviour it is narrowing.
SHARED_POINT_TOL = 1e-6

# How close to a face's UNTRIMMED surface the stored point must lie to count as
# still being ON that surface. A pick point was authored by a raycast onto the
# face, so while the face's TRIM can slide out from under it, the point stays in
# the surface to arithmetic noise: measured 1e-6mm on report e4732316's disc and
# 0 to 2.4e-8mm on every one of the 63 recoveries in the golden corpus. The
# tightest separation to the RUNNER-UP surface across those same 63 is 0.05mm.
# 1e-4 sits 100x above the worst noise and 500x below the tightest real
# separation. Erring small only means refusing, which is the behaviour this is
# narrowing.
ON_SURFACE_TOL = 1e-4


def _unbounded_surface_dist(f, point):
    """Distance from `point` to the face's underlying surface, IGNORING its trim.

    math.inf when the projection is degenerate — a point on a cylinder's axis
    has no nearest surface point (GeomAPI returns none), and "no answer" must
    never win a tie-break.
    """
    from OCP.BRep import BRep_Tool
    from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
    from OCP.gp import gp_Pnt

    try:
        proj = GeomAPI_ProjectPointOnSurf(
            gp_Pnt(float(point.X), float(point.Y), float(point.Z)),
            BRep_Tool.Surface_s(f.wrapped),
        )
        if proj.NbPoints() < 1:
            return math.inf
        return float(proj.LowerDistance())
    except Exception:
        return math.inf


def _slid_out_winner(tied, point):
    """The face a `nearest` tie belongs to when the point has slid OFF it.

    Bounded point-to-face distance cannot separate two faces that meet at an
    edge the point projects onto: the closest point on each is the SAME point of
    that shared edge, so both report the byte-identical distance and _nearest_one
    refuses at margin 0.0000. That is not exotic geometry, it is what a face does
    when the sketch under it moves — report e4732316 moved a circle, the column's
    top disc slid sideways out from under the press/pull's stored point, and the
    feature silently became a no-op, so the column left its up-to plane.

    The UNBOUNDED surfaces do separate them: the point is still dead in the
    disc's plane (1e-6mm) while the barrel it ties with is 7.8mm off. Re-scoring
    the tied set on that metric picks the face the point is still ON.

    "Still ON" is the whole claim, and it is tested ABSOLUTELY, not as a margin.
    A relative bar is not narrow enough, measured on 1.sindri: at its f73 the
    point is 0.5mm off one surface and 0.6mm off the other — off BOTH, so which
    one it "belongs" to is unknown — yet those clear a 2% margin comfortably. At
    its f70 the two surfaces are 0.0mm and 2.4e-8mm away — the point is on BOTH,
    and a relative margin reads 24 nanometres of float noise as a 96% win. Both
    are guesses of exactly the kind the ambiguity gate exists to refuse. So the
    tie-break fires only when EXACTLY ONE tied face still carries the point in
    its surface:

    STRICTLY narrower than the refusal it replaces, in four ways:
      - only when EVERY tied face's closest point is the same point, i.e. the tie
        really is caused by a boundary they share. (This alone is NOT a safety
        property — 1.sindri's f70 and f73 pass it too. It only establishes what
        kind of tie this is.)
      - the winner's surface must contain the point (ON_SURFACE_TOL), so a point
        adrift of everything cannot elect a nearest-of-the-wrong.
      - every other tied face's surface must NOT contain it, so a genuine
        coincidence of surfaces still refuses.
      - the winner must clear NEAREST_TIE_BAND on the new metric too.
      - faces only. An edge tie is a shared VERTEX, and an edge has no underlying
        surface whose extension means "the point is still on this one".

    Returns (face, margin), or (None, 0.0) when the tie must stand.
    """
    if len(tied) < 2:
        return None, 0.0
    try:
        closest = [f.distance_to_with_closest_points(point)[1] for f in tied]
    except Exception:
        return None, 0.0  # a face we cannot measure must not change the outcome
    first = closest[0]
    if any((c - first).length > SHARED_POINT_TOL for c in closest[1:]):
        return None, 0.0

    scored = sorted(((_unbounded_surface_dist(f, point), f) for f in tied),
                    key=lambda t: t[0])
    best_d, best = scored[0]
    runner = scored[1][0]
    # Written as a positive test so inf and nan fail it rather than pass it.
    if not (best_d <= ON_SURFACE_TOL):
        return None, 0.0
    if not (runner > ON_SURFACE_TOL):
        return None, 0.0
    margin = (runner - best_d) / (runner + 1e-9) if math.isfinite(runner) else 1.0
    if margin < NEAREST_TIE_BAND:
        return None, 0.0
    return best, margin


def _nearest_one(cands, dist_of, key_fn, describe, kind, sel, diag, feature_id,
                 fp_of=None, tie_breaker=None):
    """Resolve a `by:"nearest"` selector — or REFUSE, when the pick is ambiguous.

    A bare `min()` over the candidates cannot fail. It returns the closest entity
    however far away and, the case that actually bit us, however close the
    RUNNER-UP is. On a real document (1.sindri, feature f73) two faces sat ~2mm
    from the stored point; which one won flipped when an unrelated commit
    perturbed topology, so a press/pull silently pushed a wall instead of the
    face the user clicked. Nothing errored, because nothing could.

    So: score exactly as before (nearest wins, byte-for-byte for a clear winner)
    but also measure the margin to the runner-up, the same way _resolve_one does
    for v2 `match`. Below TIE_BAND the pick is not determined by the data and we
    raise, naming both candidates, so the timeline red-chips and the user can
    re-pick. `nth` overrides — a selector that deliberately means "the second of
    the tied pair" can still say so.

    NOTE the discriminator is AMBIGUITY, not absolute distance. A gate on "how
    far is the point from the winner" would break ordinary parametric motion:
    raise a box's height and its top face moves far from the stored point, yet
    it is still the unique nearest by a wide margin and must keep resolving.

    `tie_breaker` is the ONE second look at a tie (faces only — see
    _slid_out_winner). It is handed the tied set and returns a winner or None;
    None means refuse exactly as before.
    """
    cands = list(cands)
    if not cands:
        raise errors.GeomError(f"no {kind} to select from", errors.REFERENCE_NOT_FOUND)
    scored = sorted(((dist_of(c), c) for c in cands), key=lambda t: t[0])
    best_d, best = scored[0]
    runner = scored[1][0] if len(scored) > 1 else math.inf
    margin = (runner - best_d) / (runner + 1e-9) if math.isfinite(runner) else 1.0

    if margin >= NEAREST_TIE_BAND:
        # Record NOTHING: this pick is unambiguous by the gate's own rule two lines
        # up, so there is nothing for a consumer to act on. It used to push an
        # informational entry carrying `margin` as `confidence`, which broke two
        # ways: `confidence` means a distance MARGIN here but a fingerprint
        # match-QUALITY on the by:"match" path, and `_push_diag` admits anything
        # under 0.5 — so a clear winner at margin 0.11 was logged as low
        # confidence. `_project_source` (builder.py) then refused the projection
        # outright, which is how a cylinder-rim projection started reporting
        # "the source selection is ambiguous on this body". Keep `diag` meaning
        # "resolutions worth acting on"; every consumer already assumes that.
        return best

    tied = [c for d, c in scored if (d - best_d) / (runner + 1e-9) < NEAREST_TIE_BAND]
    tied.sort(key=key_fn)
    pt = sel.get("point") or []
    nth = sel.get("nth")
    if isinstance(nth, int) and 0 <= nth < len(tied):
        _push_diag(diag, feature_id, kind, 1, margin, True, REASON_TIE_NTH)
        return tied[nth]

    if tie_breaker is not None:
        won, won_margin = tie_breaker(tied)
        if won is not None:
            # NOT silent: the stored point no longer lands on the face, so the
            # reference IS drifting even though we recovered it. lossy=True is
            # what puts the amber chip on the timeline and this prose in its
            # tooltip.
            #
            # `code` is what makes the offer in that prose real. repairableDiagFor
            # (src/features/repickReference.ts) gates the timeline's "Re-pick
            # face…" on the code, not on resolved==0, so a recovery WITHOUT one
            # tells the user to re-pick the face while hiding the only gesture
            # that does it. The reference was ambiguous by the bounded metric and
            # a second look recovered it — that is the same repair, so it is the
            # same code.
            _push_diag(diag, feature_id, kind, 1, won_margin, True, REASON_SLID_OUT,
                       at=pt, code=errors.AMBIGUOUS_REFERENCE)
            return won

    where = ", ".join(f"{float(v):.2f}" for v in pt)
    described = [describe(c) for c in tied[:3]]
    # Structured twin of `described`, same tied[:3] bound. The cap is not
    # cosmetic: `tied` scales the band by the RUNNER-UP DISTANCE, so a stale
    # selector sitting 500 mm off the body admits everything within ~10 mm of
    # the winner, and an uncapped list would put an unbounded payload on an
    # error path. `dist` is what the entity was actually scored on, so a caller
    # can rank the candidates it is offered.
    fps = []
    if fp_of is not None:
        for d, c in [(dd, cc) for dd, cc in scored if cc in tied][:3]:
            try:
                fps.append({"fp": fp_of(c), "dist": round(float(d), 6)})
            except Exception:
                pass  # a candidate we cannot fingerprint must not break the refusal
    _push_diag(diag, feature_id, kind, 0, margin, True, "ambiguous nearest pick",
               at=pt, candidates=described, code=errors.AMBIGUOUS_REFERENCE,
               candidate_fps=fps)
    # The tail names the GESTURE, not just the goal. "re-pick the face" was true
    # but unactionable: the repair lives behind a right-click on the timeline
    # chip, and the reporter of e4732316 never found it, so a recoverable edit
    # read as the feature having come untied from its up-to plane.
    where_to_fix = (' (right-click the feature in the timeline, "Re-pick face…")'
                    if kind == "face" else "")
    raise errors.GeomError(
        f"ambiguous {kind} reference at ({where}): "
        + " and ".join(described)
        + f" are equally close ({best_d:.3f}mm vs {runner:.3f}mm), the saved "
        f"reference no longer identifies one. Re-pick the {kind}{where_to_fix}",
        errors.AMBIGUOUS_REFERENCE,
    )


def _describe_face(f):
    c = f.center()
    return f"a face at ({c.X:.2f},{c.Y:.2f},{c.Z:.2f}) area {f.area:.1f}"


def _describe_edge(e):
    c = e.center()
    try:
        n = f" length {e.length:.1f}"
    except Exception:
        n = ""
    return f"an edge at ({c.X:.2f},{c.Y:.2f},{c.Z:.2f}){n}"


def resolve_edges(part, sel, diag=None, feature_id=None):
    """Resolve an edge selector — or a LIST of selectors — to build123d edges.

    `diag`/`feature_id` are optional: when a list is given, low-confidence v2 matches
    append a ResolveDiag dict for the rebuild to surface.
    """
    if part is None:
        raise errors.GeomError("no part to select edges from", errors.REFERENCE_NOT_FOUND)

    # a list of selectors (multi-edge fillet/chamfer): union, de-duplicated.
    if isinstance(sel, list):
        seen = {}
        for s in sel:
            for e in resolve_edges(part, s, diag, feature_id):
                seen.setdefault(_edge_dedup_key(e), e)
        return list(seen.values())

    by = sel.get("by")
    if by == "axis":
        return list(part.edges().filter_by(AXES[sel["axis"]]))
    if by == "all":
        return list(part.edges())
    if by == "nearest":
        p = _v(sel["point"])
        return [_nearest_one(part.edges(), lambda e: _dist(e.center(), p),
                             _canonical_key_edge, _describe_edge, "edge", sel, diag, feature_id,
                             fp_of=lambda e: edge_fingerprint(e, part))]
    if by == "match":
        fp = sel["fp"]
        edges = list(part.edges())
        # A circle reference resolves to a circle when any exist: a rim selector must not
        # collapse onto a straight body edge just because its absolute position drifted
        # (e.g. a mirror-twin hole that translated under an upstream edit). Removing only
        # non-circles is monotonic — it never reorders the circle candidates.
        if fp.get("curve") == "circle":
            circles = [e for e in edges if _edge_curve(e) == "circle"]
            if circles:
                edges = circles
        tol_pos = POS_DRIFT + REL_DRIFT * _bbox_diag(part)
        rank_of = _circle_center_groups(edges, tol_pos)
        best, conf, lossy, reason = _resolve_one(
            edges, lambda e: _edge_cost(e, fp, tol_pos, rank_of.get(id(e))), _canonical_key_edge, sel.get("nth")
        )
        _push_diag(diag, feature_id, "edge", 1 if best else 0, conf, lossy, reason)
        return [best] if best is not None else []
    if by == "ofFace":
        faces = _faces_matching(part, sel["face"], diag, feature_id)
        out = {}
        for f in faces:
            for e in f.edges():
                out.setdefault(_edge_dedup_key(e), e)
        return list(out.values())
    if by == "tangentChain":
        fp = sel["seed"]
        edges = list(part.edges())
        tol_pos = POS_DRIFT + REL_DRIFT * _bbox_diag(part)
        rank_of = _circle_center_groups(edges, tol_pos)
        seed, conf, lossy, reason = _resolve_one(
            edges, lambda e: _edge_cost(e, fp, tol_pos, rank_of.get(id(e))), _canonical_key_edge, None
        )
        if seed is None:
            _push_diag(diag, feature_id, "edge", 0, 0.0, True, "tangentChain seed not found")
            return []
        chain = _tangent_chain(part, seed)
        _push_diag(diag, feature_id, "edge", len(chain), conf, lossy, reason)
        return chain
    raise errors.GeomError(f"unknown edge selector: {by}", errors.BAD_REQUEST)


def resolve_faces(part, sel, diag=None, feature_id=None):
    """Resolve a face selector — or a LIST of selectors — to build123d faces."""
    if part is None:
        raise errors.GeomError("no part to select faces from", errors.REFERENCE_NOT_FOUND)

    # a list of selectors (multi-face offset/thicken/shell/draft): union,
    # de-duplicated — mirrors resolve_edges. Without this branch a list reaches
    # sel.get("by") and dies with a bare AttributeError, which the rebuild loop
    # renders as an unhelpful "Shell failed (AttributeError)".
    if isinstance(sel, list):
        seen = {}
        for s in sel:
            for f in resolve_faces(part, s, diag, feature_id):
                seen.setdefault(_face_dedup_key(f), f)
        return list(seen.values())

    by = sel.get("by")
    if by == "normal":
        # PLANAR faces only. A single normal is only meaningful on a plane: on a
        # cylinder, normal_at() samples one point of the barrel, so a horizontal
        # boss reports "up" there and joins a selection of the flat top face.
        # Measured on third_party/.../nist_ftc_06.step, dir=[0,0,1] returned two
        # planes AND a 586.9mm2 cylinder, and feeding that to Shell raised a bare
        # OCCT "offset Error". build123d's own filter_by(Axis) gates on planarity
        # for exactly this reason; this branch never did.
        d = _unit(_v(sel["dir"]))
        return list(part.faces().filter_by(
            lambda f: _is_planar(f) and _face_normal(f).dot(d) > 0.99))
    if by == "nearest":
        p = _v(sel["point"])
        faces = list(part.faces())
        # distance_to is the true point-to-surface distance; it can throw on a
        # degenerate/faceted face, in which case fall back to centre distance for
        # ALL of them so the comparison stays like-for-like (a mixed metric would
        # make the runner-up margin meaningless).
        try:
            for f in faces:
                f.distance_to(p)
            dist_of = lambda f: f.distance_to(p)
        except Exception:
            dist_of = lambda f: _dist(f.center(), p)
        return [_nearest_one(faces, dist_of, _canonical_key_face, _describe_face,
                             "face", sel, diag, feature_id,
                             fp_of=lambda f: face_fingerprint(f, part),
                             tie_breaker=lambda tied: _slid_out_winner(tied, p))]
    if by == "all":
        return list(part.faces())
    if by == "match":
        return _faces_matching(part, sel["fp"], diag, feature_id, nth=sel.get("nth"))
    raise errors.GeomError(f"unknown face selector: {by}", errors.BAD_REQUEST)


def _faces_matching(part, fp, diag, feature_id, nth=None):
    tol_pos = POS_DRIFT + REL_DRIFT * _bbox_diag(part)
    best, conf, lossy, reason = _resolve_one(
        list(part.faces()), lambda f: _face_cost(f, fp, tol_pos), _canonical_key_face, nth
    )
    _push_diag(diag, feature_id, "face", 1 if best else 0, conf, lossy, reason)
    return [best] if best is not None else []


# --- face-anchored planes (sketch / datumPlane) ------------------------------

# How far a face's normal may drift from the cached plane's and still be "the
# same face": 1 - |dot| <= 1e-3, i.e. about 2.6 degrees. Same form and the same
# number as builder._guard_text_plane's gate, and justified the same way — a
# PLANAR face tessellates exactly, so the client's raycast normal is the B-rep
# normal to float precision. Anything past this is a tilt, not drift.
# SAME-SIGN, with abs only as a last resort: the antiparallel face of the body
# is a co-normal face too, and admitting it alongside the real one lets the far
# side win on distance alone — see the filter in resolve_face_on_plane.
PLANE_ANG_TOL = 1e-3
# mm of slack on a face's plane offset (n . centre) when deciding two co-normal
# faces are the SAME plane — the coplanar-tie gate below.
PLANE_COPLANAR_TOL = 1e-3


def plane_fallback_reason(code, label, detail=None):
    """The user-facing sentence for a face-anchored plane that fell back.

    Two of the three share one tail — "stayed at its saved position. Re-pick the
    face." — because the user's next action is the same for both, and this text
    IS the amber chip's tooltip. Kept in one function so the wording cannot drift
    between the places that push it.

    PLANE_TILTED does NOT say "Re-pick the face", and must not: the candidate
    filter above is taken against the CACHED plane's normal, and a re-pick writes
    only the selector, so picking the tilted face again reproduces this exact
    diagnostic. It is the one of the three whose repair is a different gesture,
    so it gets different words — see src/features/repickReference.ts, which
    leaves the button off for it.

    `label` is "Sketch" or "Plane"; it is ours, never document text.

    NOT HERE, deliberately: `matchImplausible`. A plausibility check would
    compare the resolved face against a fingerprint of the one the sketch was
    PLACED on, and nothing at runtime holds that fingerprint — the selector
    stores {kind, by, point, body} and no more. Measured on the case it was
    meant for (a boss removed, so the anchor drops to the plate top): with the
    pre-edit face as `want`, _judge_match flags "its area differs by 16x and it
    moved"; with the only `want` a rebuild can author — the stored point — it
    returns no verdict at all (posRel 0.176 against _MATCH_MAX_DRIFT 2.0, and no
    area to compare). Adding the call would be protection that protects nothing.
    Bring it back with a pick-time fingerprint on the selector, not before.
    """
    noun = label.lower()
    stayed = f"{noun} stayed at its saved position. Re-pick the face."
    if code == errors.PLANE_TILTED:
        return (f"{label}: the face this {noun} sits on has tilted — the {noun} "
                f"stayed at its saved position. Put it on the face again to "
                f"follow the new angle.")
    if code == errors.AMBIGUOUS_REFERENCE:
        return (f"{label}: this {noun}'s face reference no longer identifies one "
                f"face — {detail}. The {stayed}")
    return f"{label}: the face this {noun} sits on is gone — the {stayed}"


def push_plane_fallback(diag, feature_id, code, label, sel, detail=None):
    """Record a face-anchored plane falling back to its cached placement.

    `lossy` STAYS FALSE: it means "a best-effort match was taken", and this is
    the opposite — no match was taken at all. builder._project_source refuses a
    projection source when any diagnostic in its list is lossy, so a true here
    would turn an unrelated stale sketch anchor into a failed Project pick.
    confidence 0.0 is what gets it past _push_diag's head gate.

    `at` is the selector's own stored point (not the geometry), which is how the
    Re-pick repair finds WHICH selector to replace — see _push_diag.
    """
    _push_diag(diag, feature_id, "face", 0, 0.0, False,
               plane_fallback_reason(code, label, detail),
               at=(sel.get("point") if isinstance(sel, dict) else None), code=code)


def resolve_face_on_plane(part, sel, normal, label, diag=None, feature_id=None):
    """The body face a sketch / datum plane is anchored to — or None, having
    recorded WHY in `diag`.

    THE CO-NORMAL FILTER IS THE WHOLE FIX (GH #52). Plain by:"nearest" over every
    face binds whatever is closest to the stored raycast point, and after exactly
    the edit this exists to survive — a box's height 10 -> 20 — the anchored top
    face has moved away while the SIDE WALL still sits right next to the stored
    point. Measured with the point the app really stores: the side wall wins over
    ~75% of the face's area, with empty diagnostics. Keeping only faces parallel
    to the cached plane's normal removes every one of those; what is left can
    only be the face itself, its coplanar halves, or a parallel sibling — and the
    filter and the metric below are what stop each of those three from being the
    silent wrong answer (the far side, the sibling step, the split face).

    NEVER RAISES. The caller is a ROOT feature (a sketch), so a refusal has to
    come back as "keep the cached plane" — see builder._face_anchored_plane.
    `label` ("Sketch" / "Plane") only shapes the prose.
    """
    planar = [f for f in (part.faces() if part is not None else []) if _is_planar(f)]
    if not planar:
        # Nothing flat left to sit on: the anchor is GONE (body shelled away,
        # replaced by an import, booleaned out) rather than merely turned. The
        # two get different words because they need different fixes.
        push_plane_fallback(diag, feature_id, errors.REFERENCE_NOT_FOUND, label, sel)
        return None

    pt = _finite3(sel.get("point"), want=3) if isinstance(sel, dict) else None
    if pt is None:
        # A point that is not three finite numbers cannot be believed, and it
        # must not be GUESSED at either: Vector(*args) collapses anything
        # non-numeric to (0,0,0) without complaint, so the anchor would quietly
        # bind whichever co-normal face is nearest the world origin — a clear
        # winner, so not even an ambiguity. Only a hand-edited or corrupt
        # document can get here; it is refused like any other dead reference.
        push_plane_fallback(diag, feature_id, errors.REFERENCE_NOT_FOUND, label, sel)
        return None

    d = _unit(_v(normal))
    # SAME-SIGN FIRST. `abs` alone keeps the body's FAR SIDE as a candidate, and
    # the metric below then hands it the anchor the moment it is closer to the
    # stored point than the anchored face — a 2 mm plate nudged 1.1 mm is enough.
    # builder flips the resolved normal back to the cached side afterwards, so
    # the wrong face comes back as a plausible plane with nothing recorded. The
    # abs pass stays as a fallback for the case it was written for (a face whose
    # ORIENTATION flipped under a boolean, where no same-sign face is left).
    cands = [f for f in planar if _face_normal(f).dot(d) >= 1.0 - PLANE_ANG_TOL]
    if not cands:
        cands = [f for f in planar if abs(_face_normal(f).dot(d)) >= 1.0 - PLANE_ANG_TOL]
    if not cands:
        push_plane_fallback(diag, feature_id, errors.PLANE_TILTED, label, sel)
        return None

    p = _v(pt)
    # The metric is the IN-PLANE distance. The survivors of the filter above are
    # the face itself, its coplanar halves, and PARALLEL SIBLINGS (a step, a
    # plate under a boss). Ranked in 3-D a sibling takes the anchor as soon as
    # the anchored face travels further from the frozen pick point than the
    # sibling sits from it — raising a boss from 15 to 40 drops the anchor onto
    # the plate and cuts real material into a face nobody picked, silently. The
    # point stays OVER the face it was picked on however far that face slides
    # ALONG its normal, which is the only motion this feature exists to follow,
    # so project it onto each candidate's plane first.
    def _flat(f):
        n = _face_normal(f)
        return p - n * (n.dot(p) - n.dot(f.center()))

    # How far a candidate sits from the SAVED plane along the normal. The stored
    # point was ON the anchored face when it was picked, so d.p IS the cached
    # plane's offset (that is exactly how pickFacePlane builds the origin): zero
    # here means the face never moved.
    def _travel(f):
        return abs(d.dot(f.center()) - d.dot(p))

    # Same like-for-like fallback as resolve_faces' nearest branch: a mixed
    # metric would make the runner-up margin below meaningless.
    try:
        for f in cands:
            f.distance_to(_flat(f))
        dist_of = lambda f: f.distance_to(_flat(f))  # noqa: E731
    except Exception:
        dist_of = lambda f: _dist(f.center(), _flat(f))  # noqa: E731

    # The ambiguity rule is _nearest_one's, deliberately: same NEAREST_TIE_BAND,
    # same margin-to-the-runner-up definition. It is spelled out here rather than
    # delegated because the gate below has to see the TIED SET, and because a
    # refusal must return None instead of raising.
    scored = sorted(((dist_of(f), i) for i, f in enumerate(cands)), key=lambda t: t[0])
    best_d, best_i = scored[0]

    # THE UNMOVED-FACE OVERRIDE. Two stories can explain a winner that contains
    # the point but sits off the saved plane: the anchored face MOVED there, or a
    # cut removed the material under the point and this is the floor of that
    # cut (V8's through-slot: the two halves stay put at the saved offset, the
    # slot floor sits 5 mm below and directly beneath the point). Prefer the
    # story with the smaller displacement: an unmoved face whose in-plane gap is
    # SHORTER than the winner's normal travel is the better explanation. Only an
    # unmoved face can override — never a sibling that both moved and does not
    # contain the point — and only within the winner's travel, so a face that
    # merely happens to sit at the saved height somewhere else on the part (a
    # second boss of the same height, 30 mm away, while the anchored one is
    # raised 10) cannot steal the anchor. Both wrong turns were measured: a
    # blanket "saved offset wins" bound the second boss with no diagnostic.
    travel = _travel(cands[best_i])
    if best_d <= PLANE_COPLANAR_TOL and travel > PLANE_COPLANAR_TOL:
        stayed = [(dd, i) for dd, i in scored
                  if _travel(cands[i]) <= PLANE_COPLANAR_TOL and dd < travel]
        if stayed:
            scored = stayed
            best_d, best_i = scored[0]
    runner = scored[1][0] if len(scored) > 1 else math.inf
    margin = (runner - best_d) / (runner + 1e-9) if math.isfinite(runner) else 1.0
    if margin >= NEAREST_TIE_BAND:
        return cands[best_i]

    tied = [cands[i] for dd, i in scored if (dd - best_d) / (runner + 1e-9) < NEAREST_TIE_BAND]
    # COPLANAR-TIE GATE. A tie between faces that are the SAME PLANE has nothing
    # to be wrong about: a through-slot splits the anchored face in two and the
    # stored point lands over the removed slot, so both halves are EXACTLY
    # equidistant — the plain rule refuses that, and the sketch would go amber on
    # an edit that did nothing to it. Both halves give an identical plane, so
    # accept iff every tied face collapses onto one. A tie across DISTINCT planes
    # (the top and bottom of a thin plate) is a real ambiguity and still refuses.
    # Do NOT "harden" this into a cost-margin gate: the split-face tie is exact
    # by construction, so any margin rule rejects it again.
    # Co-normality is already guaranteed by the filter above, so comparing the
    # offset along `d` is a complete same-plane test.
    off = d.dot(cands[best_i].center())
    if all(abs(d.dot(f.center()) - off) <= PLANE_COPLANAR_TOL for f in tied):
        return cands[best_i]

    tied.sort(key=_canonical_key_face)  # stable prose across rebuilds
    push_plane_fallback(diag, feature_id, errors.AMBIGUOUS_REFERENCE, label, sel,
                        detail=" and ".join(_describe_face(f) for f in tied[:3]))
    return None


def _edge_dedup_key(e):
    """De-dup key for a union of edge selectors. Keys on the rounded midpoint AND
    length, so concentric edges (same center, different circumference) are NOT
    collapsed — fixing the old center-only key that silently dropped them."""
    p = _edge_mid(e)
    try:
        ln = round(e.length, 4)
    except Exception:
        ln = 0.0
    return (round(p.X, 4), round(p.Y, 4), round(p.Z, 4), ln)


def _face_dedup_key(f):
    """De-dup key for a union of face selectors. Centroid AND area, so two
    coplanar concentric faces (same centroid, different size) stay distinct —
    the face-side twin of _edge_dedup_key."""
    p = _face_centroid(f)
    try:
        ar = round(f.area, 4)
    except Exception:
        ar = 0.0
    return (round(p.X, 4), round(p.Y, 4), round(p.Z, 4), ar)


def _tangent_chain(part, seed):
    """Grow a tangent-continuous chain from `seed`: edges connected through a shared
    vertex whose tangents are collinear within ANG_TOL. Best-effort BFS over the
    body's edges (OCCT has no one-call tangent walker).

    Visited edges are tracked by GEOMETRIC key, not id(): `seed` was resolved from a
    separate `part.edges()` call, so its twin in this local list has a different
    Python id — keying on id() would re-add it as its own neighbour."""
    edges = list(part.edges())

    def endpoints(e):
        try:
            vs = e.vertices()
            return _v(vs[0].to_tuple()), _v(vs[-1].to_tuple())
        except Exception:
            return None, None

    def tangent_at_point(e, p):
        # tangent at whichever end coincides with p (fallback: midpoint tangent)
        try:
            a, b = endpoints(e)
            if a is not None and _dist(a, p) < _dist(b, p):
                return _sign_normalize(_unit(e.tangent_at(0.0)))
            return _sign_normalize(_unit(e.tangent_at(1.0)))
        except Exception:
            return _edge_dir(e)

    seen = {_edge_dedup_key(seed)}
    chain = [seed]
    frontier = [seed]
    while frontier:
        cur = frontier.pop()
        a, b = endpoints(cur)
        if a is None:
            continue
        for e in edges:
            k = _edge_dedup_key(e)
            if k in seen:
                continue
            ea, eb = endpoints(e)
            if ea is None:
                continue
            for shared in (a, b):
                if _dist(ea, shared) < 1e-6 or _dist(eb, shared) < 1e-6:
                    if abs(tangent_at_point(cur, shared).dot(tangent_at_point(e, shared))) > 1.0 - ANG_TOL:
                        seen.add(k)
                        chain.append(e)
                        frontier.append(e)
                    break
    return chain


# --- predicate queries -------------------------------------------------------
# `query` asks "which entities look like THIS", where the legacy selectors ask
# "which entity IS this". The vocabulary is deliberately the SAME functions the
# fingerprints are authored from (_face_surface, _edge_curve, _face_centroid, …),
# so a predicate's `surface` matches an fp's `surface` exactly rather than
# approximately — one vocabulary, not two that drift.


_FACE_KEYS = {"surface", "area", "normal", "radius", "within", "createdBy"}
_EDGE_KEYS = {"curve", "length", "dir", "radius", "within"}


def _in_range(v, spec):
    if v is None:
        return False
    lo, hi = spec.get("min"), spec.get("max")
    if lo is not None and v < float(lo):
        return False
    if hi is not None and v > float(hi):
        return False
    return True


def _within(pt, spec):
    """AABB test on the entity's CENTROID (not its extent), so `within` means
    "centred in this box". build123d's filter_by_position was measured 5.1x
    slower than this for the same answer."""
    lo, hi = spec.get("min") or [], spec.get("max") or []
    for i, v in enumerate((pt.X, pt.Y, pt.Z)):
        if i < len(lo) and v < float(lo[i]) - 1e-9:
            return False
        if i < len(hi) and v > float(hi[i]) + 1e-9:
            return False
    return True


_FACE_SURFACES = {"plane", "cylinder", "cone", "sphere", "torus", "bspline", "other"}
_EDGE_CURVES = {"line", "circle", "ellipse", "bspline", "other"}


def _cos_slack(spec, what):
    """The `1 - dot` slack a direction predicate accepts.

    `tol` is a COSINE deviation, not an angle, and that is not guessable: it was
    read as degrees in the field, where `tol: 5` means "accept everything" —
    `1 - dot` never exceeds 2, so the threshold admits the ANTIPODAL face and
    "facing up" and "facing down" return the same set. `deg` states the same
    threshold as a half-angle, which is what a caller almost always means.

    A tol above 1.0 already accepts a full hemisphere, so it is far more likely
    to be degrees than a deliberate choice. Refuse it rather than honour it.
    """
    if not isinstance(spec, dict):
        return ANG_TOL
    if "deg" in spec:
        if "tol" in spec:
            raise errors.GeomError(
                f"{what}: give either `deg` (an angle) or `tol` (a cosine "
                f"deviation), not both", errors.BAD_REQUEST)
        deg = float(spec["deg"])
        if not 0.0 <= deg <= 180.0:
            raise errors.GeomError(f"{what}: deg must be 0..180", errors.BAD_REQUEST)
        return 1.0 - math.cos(math.radians(deg))
    if "tol" in spec:
        tol = float(spec["tol"])
        if tol < 0.0:
            raise errors.GeomError(f"{what}: tol must be >= 0", errors.BAD_REQUEST)
        if tol > 1.0:
            raise errors.GeomError(
                f"{what}: tol is a COSINE deviation (1 - dot), not an angle — "
                f"{tol:g} accepts a hemisphere or more, so every face matches. "
                f"Use `deg` for an angle (deg 5 == tol 0.0038), or a tol <= 1.0.",
                errors.BAD_REQUEST)
        return tol
    return ANG_TOL


def query_entities(part, kind, where, cands=None, owners=None, tick=None):
    """Entities of `kind` matching every key in `where` (AND).

    Cheapest test first, so the expensive ones only ever see survivors: type,
    then the centroid box, then direction, then area — `f.area` is a GProp
    surface integration measured at 137 us on the reference assembly's faces,
    three times what a naive estimate assumes, and it dominates any mixed
    predicate. `tick` is a PARAMETER because this module cannot import builder
    (builder imports it), and an unticked scan over a dense imported body is
    exactly what the stall supervisor reaps.
    """
    tick = tick or (lambda: None)
    where = where or {}
    keys = _FACE_KEYS if kind == "face" else _EDGE_KEYS
    unknown = set(where) - keys
    if unknown:
        raise errors.GeomError(
            f"unknown {kind} predicate: {', '.join(sorted(unknown))}", errors.BAD_REQUEST)
    if kind == "edge" and "createdBy" in where:
        # _owners is a FACE map; an edge has two adjacent faces and no single
        # owner, so answering would mean inventing a rule.
        raise errors.GeomError("createdBy is not available for edges", errors.BAD_REQUEST)

    # Predicate VALUES are checked here, not per candidate. Both alphabets are
    # closed (they are what _face_surface/_edge_curve can return), so a value
    # outside them cannot match anything — and returning ok:true count:0 for
    # `surface: "Plane"` reads as "no such face exists", which is a wrong answer
    # to a question that was never asked. An unknown KEY was already refused
    # above; an unknown VALUE was not.
    if kind == "face" and "surface" in where and where["surface"] not in _FACE_SURFACES:
        raise errors.GeomError(
            f"unknown surface {where['surface']!r} — one of "
            f"{', '.join(sorted(_FACE_SURFACES))}", errors.BAD_REQUEST)
    if kind == "edge" and "curve" in where and where["curve"] not in _EDGE_CURVES:
        raise errors.GeomError(
            f"unknown curve {where['curve']!r} — one of "
            f"{', '.join(sorted(_EDGE_CURVES))}", errors.BAD_REQUEST)

    # Direction predicates are resolved ONCE, outside the loop: the threshold is
    # the same for every candidate, and parsing it inside means a malformed one
    # is swallowed by the per-candidate `except Exception: continue` and reported
    # as "nothing matched" instead of as a bad request.
    ndir = nslack = None
    if kind == "face" and "normal" in where:
        spec = where["normal"]
        ndir = _unit(_v(spec["dir"] if isinstance(spec, dict) else spec))
        nslack = _cos_slack(spec, "normal")
    edir = None
    if kind == "edge" and "dir" in where:
        # Edge `dir` keeps its hardcoded ANG_TOL — it takes a bare vector and has
        # never accepted a tolerance. Only the parse moves out of the loop.
        edir = _unit(_sign_normalize(_v(where["dir"])))

    if cands is None:
        cands = list(part.faces() if kind == "face" else part.edges())
    out = []
    for i, c in enumerate(cands):
        if (i & 0x1FF) == 0:
            tick()  # every 512 candidates: one dense body is still one body
        try:
            if kind == "face":
                if "surface" in where and _face_surface(c) != where["surface"]:
                    continue
                if "within" in where and not _within(_face_centroid(c), where["within"]):
                    continue
                if ndir is not None:
                    # PLANAR only, and the tolerance comes from the tuning file —
                    # never a hardcoded 0.99. This is the same defect the
                    # by:"normal" selector had; a new surface must not reintroduce it.
                    if not _is_planar(c):
                        continue
                    if 1.0 - _face_normal(c).dot(ndir) > nslack:
                        continue
                if "radius" in where and not _in_range(_face_radius(c), where["radius"]):
                    continue
                if "area" in where and not _in_range(c.area, where["area"]):
                    continue
                if "createdBy" in where:
                    if not owners or owners.get(_owner_key(c)) != where["createdBy"]:
                        continue
            else:
                if "curve" in where and _edge_curve(c) != where["curve"]:
                    continue
                if "within" in where and not _within(_edge_mid(c), where["within"]):
                    continue
                if edir is not None:
                    # _edge_dir is sign-normalized, so +dir and -dir select the
                    # same set. That is the existing convention, not a new one.
                    if 1.0 - abs(_edge_dir(c).dot(edir)) > ANG_TOL:
                        continue
                if "radius" in where and not _in_range(_edge_radius(c), where["radius"]):
                    continue
                if "length" in where and not _in_range(c.length, where["length"]):
                    continue
        except Exception:
            continue  # a candidate we cannot measure simply does not match
        out.append(c)
    return out


def _owner_key(face):
    """The quantized key builder._owners is indexed by. Imported here rather than
    from builder (which imports this module) — the rounding must stay in step
    with builder._face_fp, so it is asserted by a test rather than trusted."""
    c = _face_centroid(face)
    return (round(face.area, 2), round(c.X, 1), round(c.Y, 1), round(c.Z, 1))
