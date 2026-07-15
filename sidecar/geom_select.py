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
  {"kind":"face", "by":"normal",  "dir":[0,0,1]}       faces whose normal ~ dir (ALL)
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

NOTE: `by:"match"` and `by:"tangentChain"` are fully implemented and covered by
test_selector_v2.py, but the shipping frontend does not emit them yet — it still
only sends legacy `axis`/`normal`/`nearest`/`all` selectors (deferred: persistent
edge references need a stable id scheme on the TS side first). Don't go hunting
for a frontend caller; there isn't one yet.
"""

import json
import math
import os

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
#   ANG_TOL      ~1.1deg of slack on (1 - |dot|) for dir/normal
#   POS_DRIFT    mm of absolute positional drift budget (kernel disagreement)
#   REL_DRIFT    + this * bbox diagonal (position tol scales with the part)
#   LEN_REL_TOL  2% on length / radius
#   AREA_REL_TOL 5% on area
#   TIE_BAND     runner-up within 15% of best => a genuine tie (need nth)
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


def _v(seq):
    return Vector(*seq) if not isinstance(seq, Vector) else seq


def _dist(a, b):
    return (a - b).length


def _unit(v):
    n = v.length
    return v / n if n > 1e-12 else v


def _rel_err(a, b):
    d = max(abs(a), abs(b), 1e-9)
    return abs(a - b) / d


def _bbox_diag(part):
    try:
        bb = part.bounding_box()
        return (bb.max - bb.min).length or 1.0
    except Exception:
        return 1.0


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
    try:
        return _unit(f.normal_at())
    except Exception:
        return Vector(0, 0, 0)


def _face_radius(f):
    try:
        return float(f.radius)
    except Exception:
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
    edge_fingerprint and future concentric-face rank support (unused today)."""
    c, n = _face_centroid(f), _face_normal(f)
    fp = {"centroid": [c.X, c.Y, c.Z], "normal": [n.X, n.Y, n.Z], "area": f.area, "surface": _face_surface(f)}
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
        reason = "tie broken by nth" if nth is not None else "tie; canonical-first"
        return tied[idx], margin, (nth is None), reason

    lossy = best_cost > ACCEPT_MAX
    return best, margin, lossy, ("marginal match" if lossy else None)


def _push_diag(diag, feature_id, kind, resolved, confidence, lossy, reason):
    if diag is None or not (lossy or confidence < 0.5):
        return
    diag.append(
        {
            "feature_id": feature_id,
            "kind": kind,
            "resolved": resolved,
            "confidence": round(float(confidence), 3),
            "lossy": bool(lossy),
            "reason": reason,
        }
    )


# --- public API --------------------------------------------------------------


def resolve_edges(part, sel, diag=None, feature_id=None):
    """Resolve an edge selector — or a LIST of selectors — to build123d edges.

    `diag`/`feature_id` are optional: when a list is given, low-confidence v2 matches
    append a ResolveDiag dict for the rebuild to surface.
    """
    if part is None:
        raise ValueError("no part to select edges from")

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
        return [min(part.edges(), key=lambda e: _dist(e.center(), p))]
    if by == "match":
        fp = sel["fp"]
        edges = list(part.edges())
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
    raise ValueError(f"unknown edge selector: {by}")


def resolve_faces(part, sel, diag=None, feature_id=None):
    """Resolve a face selector to a list of build123d faces."""
    if part is None:
        raise ValueError("no part to select faces from")
    by = sel.get("by")
    if by == "normal":
        d = _unit(_v(sel["dir"]))
        return list(part.faces().filter_by(lambda f: _face_normal(f).dot(d) > 0.99))
    if by == "nearest":
        p = _v(sel["point"])
        try:
            return [min(part.faces(), key=lambda f: f.distance_to(p))]
        except Exception:
            return [min(part.faces(), key=lambda f: _dist(f.center(), p))]
    if by == "all":
        return list(part.faces())
    if by == "match":
        return _faces_matching(part, sel["fp"], diag, feature_id, nth=sel.get("nth"))
    raise ValueError(f"unknown face selector: {by}")


def _faces_matching(part, fp, diag, feature_id, nth=None):
    tol_pos = POS_DRIFT + REL_DRIFT * _bbox_diag(part)
    best, conf, lossy, reason = _resolve_one(
        list(part.faces()), lambda f: _face_cost(f, fp, tol_pos), _canonical_key_face, nth
    )
    _push_diag(diag, feature_id, "face", 1 if best else 0, conf, lossy, reason)
    return [best] if best is not None else []


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
