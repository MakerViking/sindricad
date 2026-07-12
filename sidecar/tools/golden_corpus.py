"""golden_corpus.py — golden-document regression eval for the geometry sidecar.

Rebuilds real `.sindri` documents through a SPAWNED server.py subprocess and
records/compares their build invariants: body count, per-body mesh volume, the
document bbox, and the list of feature errors. A code change that silently alters
the geometry a saved document builds is caught here.

Tolerances are hardcoded literals in THIS file — no config, no env override — so
what "still matches" means can't be loosened from outside.

Usage (run from sidecar/ with .venv/bin/python):
  python tools/golden_corpus.py --capture ../src-tauri/*.sindri   # append baselines
  python tools/golden_corpus.py --check                           # compare vs golden.json

--capture is APPEND-ONLY: it refuses to modify an entry that already exists.
Changing a recorded baseline requires deleting its entry from golden.json by
hand — i.e. human review.
"""

import glob
import json
import os
import sys

import harness_util as H

GOLDEN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden.json")

# --- hardcoded comparison tolerances (the whole point of the tool; do not make
#     these configurable) ------------------------------------------------------
VOLUME_REL_TOL = 0.005           # per-body mesh volume: within 0.5%
BBOX_ABS_FLOOR = 1e-6            # bbox component: within max(this, ...)
BBOX_REL_TOL = 0.001             # ... 0.1% of the recorded bbox diagonal
REBUILD_TOLERANCE = 0.1          # the app's own viewport tessellation tolerance


def effective_doc(parsed):
    """Reconstruct the document the FRONTEND actually sends to the sidecar for a
    saved .sindri file (src/document/store.ts effectiveDoc): features up to the
    rollback marker, minus suppressed ones, with the extrude captured-visibility
    migration applied, carrying parameters + bodyVisibility. Building the raw
    saved feature list instead would rebuild features the app never builds."""
    feats = parsed.get("features") or []
    for f in feats:
        # store.ts stamps hiddenBodies=[] onto any extrude that predates
        # captured-visibility, so booleans aren't retroactively rewritten by eye
        # state. Match it so our build equals the app's.
        if f.get("type") == "extrude" and "hiddenBodies" not in f:
            f["hiddenBodies"] = []
    rollback = parsed.get("rollback")
    if rollback is not None:
        feats = feats[:rollback]
    suppressed = set(parsed.get("suppressed") or [])
    feats = [f for f in feats if f.get("id") not in suppressed]
    doc = {"parameters": parsed.get("parameters") or {}, "features": feats}
    if parsed.get("bodyVisibility"):
        doc["bodyVisibility"] = parsed["bodyVisibility"]
    return doc


def feature_types(doc):
    """Distinct feature types present in an effective document."""
    return sorted({f.get("type") for f in doc.get("features", []) if f.get("type")})


async def _rebuild(ws, doc):
    reply = await H.ws_call(ws, "rebuild", "rb", document=doc, tolerance=REBUILD_TOLERANCE)
    return reply


def invariants(result):
    """Extract the recorded/compared invariants from a rebuild result payload.
    We never send `known`, so every body carries a full mesh payload (no
    'unchanged' stubs)."""
    bodies = result.get("bodies") or []
    volumes = {}
    for b in bodies:
        pos, idx = b.get("positions"), b.get("indices")
        volumes[b["id"]] = H.mesh_volume(pos, idx) if (pos and idx) else 0.0
    ferrs = [
        {"feature_id": e.get("feature_id"), "error_class": H.error_class(e.get("message", ""))}
        for e in (result.get("featureErrors") or [])
    ]
    return {
        "bodies": len(bodies),
        "volumes": volumes,
        "bbox": result.get("bbox"),
        "featureErrors": ferrs,
    }


def _build_entry(result, doc, path):
    inv = invariants(result)
    return {
        "doc": os.path.basename(path),
        "path": path,
        "featureTypes": feature_types(doc),
        "bodies": inv["bodies"],
        "volumes": inv["volumes"],
        "bbox": inv["bbox"],
        "featureErrors": inv["featureErrors"],
    }


def load_golden():
    if not os.path.exists(GOLDEN_PATH):
        return {}
    with open(GOLDEN_PATH) as fh:
        return json.load(fh)


def _save_golden(data):
    with open(GOLDEN_PATH, "w") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")


# --- capture ------------------------------------------------------------------


async def _capture(paths):
    golden = load_golden()
    added, skipped, failed = [], [], []
    with H.SpawnedServer() as srv:
        async with __import__("websockets").connect(srv.url, max_size=H._MAX_WS) as ws:
            for path in paths:
                key = os.path.basename(path)
                if key in golden:
                    skipped.append(key)  # append-only: never overwrite
                    continue
                try:
                    parsed = json.load(open(path))
                    doc = effective_doc(parsed)
                    reply = await _rebuild(ws, doc)
                    if not reply.get("ok"):
                        failed.append((key, reply.get("error")))
                        continue
                    golden[key] = _build_entry(reply["result"], doc, path)
                    added.append(key)
                except Exception as ex:
                    failed.append((key, str(ex)))
    _save_golden(golden)
    print(f"captured {len(added)}: {added}")
    if skipped:
        print(f"skipped {len(skipped)} (already recorded — append-only): {skipped}")
    for key, why in failed:
        print(f"CAPTURE-FAILED {key}: {why}")
    print(f"golden.json now holds {len(golden)} entries")
    return 0 if not failed else 1


# --- check --------------------------------------------------------------------


def _cmp_bodies(rec, cur):
    return None if rec == cur else f"body count {cur} != recorded {rec}"


def _cmp_volumes(rec, cur):
    diffs = []
    if set(rec) != set(cur):
        return f"body ids {sorted(cur)} != recorded {sorted(rec)}"
    for bid, rv in rec.items():
        cv = cur[bid]
        tol = abs(rv) * VOLUME_REL_TOL
        if abs(cv - rv) > max(tol, 1e-9):
            diffs.append(f"{bid} vol {cv:.4f} vs recorded {rv:.4f} (>{VOLUME_REL_TOL:.1%})")
    return "; ".join(diffs) if diffs else None


def _cmp_bbox(rec, cur):
    if rec is None and cur is None:
        return None
    if rec is None or cur is None:
        return f"bbox {cur} != recorded {rec}"
    tol = max(BBOX_ABS_FLOOR, BBOX_REL_TOL * H.bbox_diagonal(rec))
    for corner in ("min", "max"):
        for i in range(3):
            if abs(cur[corner][i] - rec[corner][i]) > tol:
                return f"bbox {corner}[{i}] {cur[corner][i]:.6f} vs recorded {rec[corner][i]:.6f} (tol {tol:.2g})"
    return None


def _cmp_ferrs(rec, cur):
    """Exact ordered match on (feature_id, error_class) pairs."""
    r = [(e["feature_id"], e["error_class"]) for e in rec]
    c = [(e["feature_id"], e["error_class"]) for e in cur]
    return None if r == c else f"featureErrors {c} != recorded {r}"


async def _check():
    golden = load_golden()
    if not golden:
        print("no golden.json — run --capture first")
        return 2
    handler_keys = H.parse_feature_handler_keys()

    results = {}  # key -> ("PASS"|"FAIL"|"UPDATE", [diff lines])
    with H.SpawnedServer() as srv:
        async with __import__("websockets").connect(srv.url, max_size=H._MAX_WS) as ws:
            for key in sorted(golden):
                entry = golden[key]
                try:
                    parsed = json.load(open(entry["path"]))
                    doc = effective_doc(parsed)
                    reply = await _rebuild(ws, doc)
                except Exception as ex:
                    results[key] = ("FAIL", [f"rebuild raised: {ex}"])
                    continue
                if not reply.get("ok"):
                    results[key] = ("FAIL", [f"rebuild not ok: {reply.get('error')}"])
                    continue
                cur = invariants(reply["result"])
                rec_ferrs = entry["featureErrors"]
                cur_ferrs = cur["featureErrors"]
                rec_set = {(e["feature_id"], e["error_class"]) for e in rec_ferrs}
                cur_set = {(e["feature_id"], e["error_class"]) for e in cur_ferrs}

                # Feature-error verdict first — it alone can force FAIL or UPDATE.
                if cur_set - rec_set:
                    # a NEW or CHANGED error class appeared — a real regression.
                    results[key] = ("FAIL", [
                        f"featureErrors: new/changed {sorted(cur_set - rec_set)} vs recorded {sorted(rec_set)}"
                    ])
                    continue
                if rec_set and cur_set != rec_set:
                    # some (or all) recorded sentinel errors cleared, none new —
                    # neither pass nor fail; a human must re-bless the baseline.
                    results[key] = ("UPDATE", [
                        f"featureErrors cleared {sorted(rec_set - cur_set)}; recorded {sorted(rec_set)}, now {sorted(cur_set)}"
                    ])
                    continue

                # errors match exactly (both empty, or the sentinel is unchanged) —
                # the build must still match its recorded geometry.
                diffs = []
                for label, fn, r, c in (
                    ("bodies", _cmp_bodies, entry["bodies"], cur["bodies"]),
                    ("volumes", _cmp_volumes, entry["volumes"], cur["volumes"]),
                    ("bbox", _cmp_bbox, entry["bbox"], cur["bbox"]),
                ):
                    d = fn(r, c)
                    if d:
                        diffs.append(f"{label}: {d}")
                results[key] = ("PASS" if not diffs else "FAIL", diffs)

    # report
    n = len(golden)
    k = 0
    clean_types = set()
    for key in sorted(results):
        status, diffs = results[key]
        if status == "PASS":
            k += 1
            for d in diffs:
                print(f"  {key}: {d}")  # never reached (PASS has no diffs) but explicit
            if not golden[key]["featureErrors"]:
                # A no-op transform (scale factor=1, move by 0, 1x1 patternRect)
                # rebuilds clean; crediting it would inflate clean-coverage. Delta
                # units earn coverage only through e2e's pre/post checks.
                clean_types |= set(golden[key]["featureTypes"]) - H.DELTA_UNITS
        elif status == "UPDATE":
            print(f"GOLDEN-UPDATE-NEEDED {key}: {diffs[0]}")
        else:
            for d in diffs:
                print(f"  DIFF {key}: {d}")

    c = len(clean_types & handler_keys)
    denom = len(handler_keys)
    print(f"PASS {k}/{n} clean-coverage {c}/{denom}")
    fails = [key for key, (s, _) in results.items() if s == "FAIL"]
    return 0 if not fails else 1


def main(argv):
    if "--capture" in argv:
        i = argv.index("--capture")
        raw = argv[i + 1:]
        paths = []
        for pat in raw:
            paths.extend(sorted(glob.glob(pat)) if any(c in pat for c in "*?[") else [pat])
        if not paths:
            print("no documents matched --capture arguments")
            return 2
        return H.run(_capture(paths))
    if "--check" in argv:
        return H.run(_check())
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
