"""Selector-survival corpus generator (Norn oracle code — hash-locked at seal).

Generates a frozen corpus of (fingerprint, mutation, intended-entity) tuples for the
v2 `by:"match"` resolver in geom_select.py. The pipeline for every case:

  1. build the ORIGINAL part from a parametric spec;
  2. locate the INTENDED entity in it by an INDEPENDENT structural rule (build123d's
     own filters — never geom_select's scorer), and author a fingerprint from it, the
     way the frontend persists a selection;
  3. build the MUTATED part (one upstream parameter changed);
  4. locate the SAME logical entity in the mutated part and freeze its identity key
     (center+radius for circles, midpoint+length for lines, centroid+area[+radius] for
     faces) — this is the ground truth, computed without ever calling the resolver;
  5. certify the case: the intended entity actually moved (else it tests nothing), and
     its identity key is UNIQUE in the mutated part (else the ask is ambiguous — reject).

The eval (eval_selector_survival.py) rebuilds the mutated part from the stored spec,
runs the resolver under the config being tuned, and scores survival = resolved entity's
identity key == the frozen key. build_part / the key + fingerprint helpers / the locators
are shared with the eval by import, so both sides speak one geometry vocabulary and only
the SCORING (the tuned constants) varies between runs.

Run once to (re)generate:  .venv/bin/python tools/gen_selector_corpus.py --out tools/corpus_selectors.json
Deterministic given --seed; the checked-in corpus is the sha256-pinned fixture.
"""

import argparse
import json
import os
import random
import sys

# tools/ is a subdir of sidecar/; import the resolver + its geometry helpers from there.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from build123d import Box, Cylinder, Vector  # noqa: E402
import geom_select as gs  # noqa: E402


# --- geometry vocabulary shared with the eval ---------------------------------


def build_part(spec):
    """Deterministically build a part from a parametric spec (dispatch on archetype)."""
    a = spec["archetype"]
    p = spec["params"]
    if a == "box":
        part = Box(p["w"], p["d"], p["h"])
        pos = p.get("pos")
        return part.translate(Vector(*pos)) if pos else part
    if a == "pipe":
        return Cylinder(p["R"], p["h"]) - Cylinder(p["r"], p["h"])
    if a == "box_holes":
        part = Box(p["w"], p["d"], p["h"])
        for hx, hy, hr in p["holes"]:
            part = part - Cylinder(hr, p["h"] * 3.0).translate(Vector(hx, hy, 0))
        return part
    raise ValueError(f"unknown archetype: {a}")


def _rnd3(v):
    return [round(v.X, 4), round(v.Y, 4), round(v.Z, 4)]


def edge_key(e):
    """Rebuild-stable identity key for an edge. Circles key on center+radius (so
    concentric rims are distinct); other curves on midpoint+length."""
    curve = gs._edge_curve(e)
    if curve == "circle":
        c = gs._edge_center(e)
        r = gs._edge_radius(e)
        return ["edge", "circle", _rnd3(c) if c is not None else None,
                round(r, 4) if r is not None else None]
    try:
        length = round(e.length, 4)
    except Exception:
        length = None
    return ["edge", curve, _rnd3(gs._edge_mid(e)), length]


def face_key(f):
    """Identity key for a face: surface class + centroid + area (+ radius if curved)."""
    r = gs._face_radius(f)
    return ["face", gs._face_surface(f), _rnd3(gs._face_centroid(f)),
            round(f.area, 4), None if r is None else round(r, 4)]


def entity_key(kind, ent):
    return edge_key(ent) if kind == "edge" else face_key(ent)


def edge_fp(e):
    """Author an EdgeFingerprint from a real edge (same fields the frontend persists)."""
    m, d = gs._edge_mid(e), gs._edge_dir(e)
    fp = {"mid": [m.X, m.Y, m.Z], "dir": [d.X, d.Y, d.Z], "length": e.length, "curve": gs._edge_curve(e)}
    if gs._edge_curve(e) == "circle":
        r, c = gs._edge_radius(e), gs._edge_center(e)
        if r is not None:
            fp["radius"] = r
        if c is not None:
            fp["center"] = [c.X, c.Y, c.Z]
    return fp


def face_fp(f):
    c, n = gs._face_centroid(f), gs._face_normal(f)
    fp = {"centroid": [c.X, c.Y, c.Z], "normal": [n.X, n.Y, n.Z], "area": f.area, "surface": gs._face_surface(f)}
    r = gs._face_radius(f)
    if r is not None:
        fp["radius"] = r
    return fp


# --- independent structural locators (ground-truth entity identity) -----------
# Each returns the ONE intended entity, chosen by geometry the mutation preserves.


def top_face(part):
    return max(part.faces(), key=lambda f: gs._face_centroid(f).Z)


def _circles(part, top=True):
    cs = [e for e in part.edges() if gs._edge_curve(e) == "circle"]
    if not cs:
        return []
    zc = max if top else min
    z = zc(gs._edge_mid(e).Z for e in cs)
    return [e for e in cs if abs(gs._edge_mid(e).Z - z) < 1e-6]


def top_rim_by_radius(part, want_outer):
    rims = _circles(part, top=True)
    if not rims:
        return None
    return (max if want_outer else min)(rims, key=lambda e: gs._edge_radius(e) or 0.0)


# Hole locators identify a hole by a logical property the mutation preserves
# (it is a SINGLE hole / the +X of a symmetric pair / the one nearest origin) —
# never by absolute position, since the hole moves between original and mutated.


def sole_hole_top_rim(part):
    """The top rim of the one drilled hole (exactly one top circle expected)."""
    tc = _circles(part, top=True)
    return tc[0] if len(tc) == 1 else None


def hole_top_rim_by_sign(part, sx):
    """Of a symmetric pair, the top rim on the chosen X side (the mirror-twin test)."""
    tc = [e for e in _circles(part, top=True)
          if gs._edge_center(e) is not None and (gs._edge_center(e).X * sx) > 0]
    return max(tc, key=lambda e: abs(gs._edge_center(e).X)) if tc else None


def hole_top_rim_nearest_origin(part):
    """The top rim closest to the origin — the original hole, when a distractor is added."""
    tc = [e for e in _circles(part, top=True) if gs._edge_center(e) is not None]
    if not tc:
        return None
    return min(tc, key=lambda e: (gs._edge_center(e).X ** 2 + gs._edge_center(e).Y ** 2))


def top_corner_z_edge(part, sx, sy):
    """A vertical (Z-parallel) box edge chosen by the sign of its X,Y corner — a
    logical identity a dimension change preserves (still the +X+Y vertical edge)."""
    zes = [e for e in part.edges() if gs._edge_curve(e) == "line" and abs(gs._edge_dir(e).Z) > 0.99]
    if not zes:
        return None
    return max(zes, key=lambda e: (sx * gs._edge_mid(e).X, sy * gs._edge_mid(e).Y))


# --- case assembly ------------------------------------------------------------


def _unique(part, kind, key):
    ents = part.edges() if kind == "edge" else part.faces()
    return sum(1 for e in ents if entity_key(kind, e) == key)


def make_case(cid, category, kind, orig_spec, mut_spec, locate, tol_note=""):
    """Assemble one certified case, or None if it fails certification."""
    try:
        op = build_part(orig_spec)
        mp = build_part(mut_spec)
        oent = locate(op)
        ment = locate(mp)
        if oent is None or ment is None:
            return None
        fp = edge_fp(oent) if kind == "edge" else face_fp(oent)
        key = entity_key(kind, ment)
        if None in (key[2],) or (kind == "edge" and key[3] is None):
            return None  # degenerate geometry
        # (a) the intended entity must have MOVED (else the case tests nothing)
        okey = entity_key(kind, oent)
        if okey == key:
            return None
        # (b) the frozen key must identify EXACTLY ONE entity in the mutated part
        if _unique(mp, kind, key) != 1:
            return None
        sel_kind = "edge" if kind == "edge" else "face"
        return {
            "id": cid,
            "category": category,
            "kind": kind,
            "mutated_spec": mut_spec,
            "selector": {"kind": sel_kind, "by": "match", "fp": fp},
            "expected_key": key,
            "note": tol_note,
        }
    except Exception:
        return None


def _draw(rng, lo, hi):
    return round(rng.uniform(lo, hi), 3)


def gen_dimension_change(rng, n):
    """Simple box/pipe, one dimension scaled — the position-drift control category."""
    out = []
    i = 0
    while len(out) < n and i < n * 6:
        i += 1
        w, d, h = _draw(rng, 10, 60), _draw(rng, 10, 60), _draw(rng, 6, 30)
        k = rng.uniform(1.2, 2.2)
        if rng.random() < 0.5:
            # face target: top face, mutate height
            orig = {"archetype": "box", "params": {"w": w, "d": d, "h": h}}
            mut = {"archetype": "box", "params": {"w": w, "d": d, "h": round(h * k, 3)}}
            c = make_case(f"dim_{len(out):03d}", "dimension_change", "face", orig, mut, top_face)
        else:
            sx, sy = rng.choice([1, -1]), rng.choice([1, -1])
            orig = {"archetype": "box", "params": {"w": w, "d": d, "h": h}}
            mut = {"archetype": "box", "params": {"w": round(w * k, 3), "d": round(d * k, 3), "h": h}}
            c = make_case(f"dim_{len(out):03d}", "dimension_change", "edge", orig, mut,
                          lambda p, sx=sx, sy=sy: top_corner_z_edge(p, sx, sy))
        if c:
            out.append(c)
    return out


def gen_moved_sketch(rng, n):
    """Rigid translation — position drifts, but length/area/type still pin the entity."""
    out = []
    i = 0
    while len(out) < n and i < n * 6:
        i += 1
        w, d, h = _draw(rng, 10, 50), _draw(rng, 10, 50), _draw(rng, 6, 25)
        dx, dy = _draw(rng, 3, 20) * rng.choice([1, -1]), _draw(rng, 3, 20) * rng.choice([1, -1])
        orig = {"archetype": "box", "params": {"w": w, "d": d, "h": h}}
        mut = {"archetype": "box", "params": {"w": w, "d": d, "h": h, "pos": [dx, dy, 0]}}
        kind = "face" if rng.random() < 0.5 else "edge"
        loc = top_face if kind == "face" else (lambda p: top_corner_z_edge(p, 1, 1))
        c = make_case(f"moved_{len(out):03d}", "moved_sketch", kind, orig, mut, loc)
        if c:
            out.append(c)
    return out


def gen_concentric(rng, n):
    """Pipe with two concentric top rims — disambiguate inner vs outer by radius/center."""
    out = []
    i = 0
    while len(out) < n and i < n * 8:
        i += 1
        R = _draw(rng, 12, 40)
        r = _draw(rng, 3, R - 4)
        h = _draw(rng, 6, 24)
        want_outer = rng.random() < 0.5
        dR = rng.uniform(1.15, 1.8)
        orig = {"archetype": "pipe", "params": {"R": R, "r": r, "h": h}}
        mut = {"archetype": "pipe", "params": {"R": round(R * dR, 3), "r": round(r * dR, 3), "h": h}}
        c = make_case(f"conc_{len(out):03d}", "concentric", "edge", orig, mut,
                      lambda p, wo=want_outer: top_rim_by_radius(p, wo))
        if c:
            out.append(c)
    return out


def gen_mirrored_twin(rng, n):
    """Two symmetric holes about X=0 — the resolver must not pick the mirror twin."""
    out = []
    i = 0
    while len(out) < n and i < n * 8:
        i += 1
        w, d, h = _draw(rng, 40, 80), _draw(rng, 20, 40), _draw(rng, 8, 20)
        a = _draw(rng, 6, w / 2 - 6)  # +-a separation
        hr = _draw(rng, 2.5, min(5.0, a - 1))
        if hr < 2:
            continue
        da = rng.uniform(0.6, 0.9)  # asymmetric mutation: bring holes closer
        sx = rng.choice([1, -1])    # which side is the intended hole
        orig = {"archetype": "box_holes", "params": {"w": w, "d": d, "h": h, "holes": [[a, 0, hr], [-a, 0, hr]]}}
        a2 = round(a * da, 3)
        mut = {"archetype": "box_holes", "params": {"w": w, "d": d, "h": h, "holes": [[a2, 0, hr], [-a2, 0, hr]]}}
        c = make_case(f"mirror_{len(out):03d}", "mirrored_twin", "edge", orig, mut,
                      lambda p, s=sx: hole_top_rim_by_sign(p, s))
        if c:
            out.append(c)
    return out


def gen_boolean_stack(rng, n):
    """Box with a drilled hole; a dimension change drifts the boolean-created rim."""
    out = []
    i = 0
    while len(out) < n and i < n * 8:
        i += 1
        w, d, h = _draw(rng, 30, 70), _draw(rng, 20, 50), _draw(rng, 8, 20)
        hx, hy = _draw(rng, -w / 4, w / 4), _draw(rng, -d / 4, d / 4)
        hr = _draw(rng, 3, 8)
        k = rng.uniform(1.2, 1.9)
        orig = {"archetype": "box_holes", "params": {"w": w, "d": d, "h": h, "holes": [[hx, hy, hr]]}}
        # mutate box dims + hole position (the rim moves and OCCT re-derives it)
        hx2, hy2 = round(hx * 1.3, 3), round(hy * 1.3, 3)
        mut = {"archetype": "box_holes",
               "params": {"w": round(w * k, 3), "d": round(d * k, 3), "h": h, "holes": [[hx2, hy2, hr]]}}
        c = make_case(f"bool_{len(out):03d}", "boolean_stack", "edge", orig, mut, sole_hole_top_rim)
        if c:
            out.append(c)
    return out


def gen_added_feature(rng, n):
    """Mutation ADDS a second hole (a distractor) near a corner; the reference must
    stay on its own centre hole. Intended = the hole nearest the origin, which the
    corner distractor never displaces."""
    out = []
    i = 0
    while len(out) < n and i < n * 8:
        i += 1
        w, d, h = _draw(rng, 40, 80), _draw(rng, 30, 60), _draw(rng, 8, 20)
        hx, hy, hr = _draw(rng, -6, 6), _draw(rng, -6, 6), _draw(rng, 3, 6)
        k = rng.uniform(1.15, 1.6)
        hx_m, hy_m = round(hx * k, 3), round(hy * k, 3)
        # distractor near a corner of the mutated box — always farther from origin
        cx = round((rng.choice([1, -1])) * (w * k / 2 - hr - 3), 3)
        cy = round((rng.choice([1, -1])) * (d * k / 2 - hr - 3), 3)
        orig = {"archetype": "box_holes", "params": {"w": w, "d": d, "h": h, "holes": [[hx, hy, hr]]}}
        mut = {"archetype": "box_holes",
               "params": {"w": round(w * k, 3), "d": round(d * k, 3), "h": h,
                          "holes": [[hx_m, hy_m, hr], [cx, cy, hr]]}}
        c = make_case(f"added_{len(out):03d}", "added_feature", "edge", orig, mut,
                      hole_top_rim_nearest_origin)
        if c:
            out.append(c)
    return out


CATEGORIES = [
    ("concentric", gen_concentric, 45),
    ("mirrored_twin", gen_mirrored_twin, 45),
    ("boolean_stack", gen_boolean_stack, 40),
    ("dimension_change", gen_dimension_change, 30),
    ("added_feature", gen_added_feature, 30),
    ("moved_sketch", gen_moved_sketch, 30),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus", "corpus_selectors.json"))
    ap.add_argument("--seed", type=int, default=20260714)
    args = ap.parse_args()

    cases = []
    counts = {}
    for idx, (name, fn, n) in enumerate(CATEGORIES):
        rng = random.Random(args.seed + 1009 * (idx + 1))
        got = fn(rng, n)
        counts[name] = len(got)
        cases.extend(got)

    hard = counts["concentric"] + counts["mirrored_twin"]
    corpus = {
        "seed": args.seed,
        "n": len(cases),
        "counts": counts,
        "hard_fraction": round(hard / len(cases), 3) if cases else 0.0,
        "cases": cases,
    }
    with open(args.out, "w") as f:
        json.dump(corpus, f, indent=1)
    print(f"wrote {len(cases)} cases to {args.out}", file=sys.stderr)
    print(f"counts={counts} hard_fraction={corpus['hard_fraction']}", file=sys.stderr)


if __name__ == "__main__":
    main()
