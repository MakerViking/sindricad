"""Separate: one body per disjoint solid. Run:
    cd sidecar && .venv/bin/python test_separate.py

Entered where the user enters — a rebuild of a document holding a `separate`
feature — and judged on the EFFECT: body count, ids, volumes, where a later
feature lands.
"""

import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("SINDRI_DISK_CACHE", "0")

FAILED = []


def check(label, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + label + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILED.append(label)


def vol(b):
    return round(sum(s.volume for s in b["shape"].solids()), 3)


def main():
    import builder

    # 1. Two boxes that never touch, joined into ONE body, then separated.
    two = [
        {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "b", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "m", "type": "move", "dx": 40, "dy": 0, "dz": 0, "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]},
        {"id": "j", "type": "combine", "operation": "join"},
    ]
    _p, errs, joined = builder.rebuild({"parameters": {}, "features": two})
    check("the join leaves one body", not errs and len(joined) == 1, (errs, len(joined)))
    doc = two + [{"id": "s", "type": "separate", "body": "body1"}]
    _p, errs, bodies = builder.rebuild({"parameters": {}, "features": doc})
    check("separate gives one body per piece", not errs and len(bodies) == 2, (errs, len(bodies)))
    check("the original body keeps its id and name",
          bodies[0]["id"] == "body1" and bodies[0]["name"] == joined[0]["name"], bodies[0]["id"])
    check("the new piece is named after it", bodies[1]["name"] == f"{joined[0]['name']} (2)", bodies[1]["name"])
    check("no volume is lost", vol(bodies[0]) + vol(bodies[1]) == vol(joined[0]))

    # A later feature naming body1 still lands on the SAME piece, and the new
    # body can be moved on its own (the reason to separate in the first place).
    later = doc + [{"id": "m2", "type": "move", "dx": 0, "dy": 0, "dz": 50, "rx": 0, "ry": 0, "rz": 0,
                    "bodies": [bodies[1]["id"]]}]
    _p, errs, moved = builder.rebuild({"parameters": {}, "features": later})
    zs = [round(b["shape"].bounding_box().min.Z, 3) for b in moved]
    check("a separated piece moves on its own", not errs and zs[0] == -5.0 and zs[1] == 45.0, zs)

    # 2. Already one piece: refused in words, the body untouched.
    one = [{"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
           {"id": "s", "type": "separate", "body": "body1"}]
    _p, errs, bodies = builder.rebuild({"parameters": {}, "features": one})
    msg = " ".join(str(e.get("message", e)) for e in errs)
    check("a single piece is refused in words", "already one piece" in msg and len(bodies) == 1, msg)

    # 4. A stale body id: refused in words.
    stale = one[:1] + [{"id": "s", "type": "separate", "body": "body9"}]
    _p, errs, _b = builder.rebuild({"parameters": {}, "features": stale})
    msg = " ".join(str(e.get("message", e)) for e in errs)
    check("a missing body is named", "no such body body9" in msg, msg)

    # 3. The field case: an assembly imported whole (explode: false), separated.
    blobs = tempfile.mkdtemp(prefix="separate_blobs_")
    old = os.environ.get("SINDRI_BLOB_DIR")
    os.environ["SINDRI_BLOB_DIR"] = blobs
    import blobstore

    blobstore._default = None
    try:
        res = builder.import_geometry(os.path.join(HERE, "fixtures", "asm_nested.step"), "step")
        imp = {"id": "imp", "type": "import", "format": "step", "name": res["name"],
               "geom": res["geom"], "solid": res["solid"], "explode": False}
        _p, errs, whole = builder.rebuild({"parameters": {}, "features": [imp]})
        n_solids = len(whole[0]["shape"].solids())
        check("the whole import is one body of several solids", len(whole) == 1 and n_solids > 1, n_solids)
        _p, errs, parts = builder.rebuild({"parameters": {}, "features": [
            imp, {"id": "s", "type": "separate", "body": "body1"}]})
        check("separating it gives one body per solid", not errs and len(parts) == n_solids, (errs, len(parts)))
        check("the import's volume is unchanged", round(sum(vol(p) for p in parts), 2) == round(vol(whole[0]), 2))
    finally:
        if old is None:
            os.environ.pop("SINDRI_BLOB_DIR", None)
        else:
            os.environ["SINDRI_BLOB_DIR"] = old
        blobstore._default = None
        shutil.rmtree(blobs, ignore_errors=True)

    print()
    if FAILED:
        print(f"FAILED {len(FAILED)}:")
        for f in FAILED:
            print("  -", f)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
