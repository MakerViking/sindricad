"""Insert > Part from File: another document's bodies, copied in. Run:
    cd sidecar && .venv/bin/python test_insert_document.py

Entered where the app's click lands: the `insertDocument` op's worker
(server._insert_document_job, which is builder.insert_document), and then a
rebuild of the document holding the exact `import` feature the frontend writes
from its reply (src/io/files.ts insertPartFromFile). Judged on the EFFECT: body
count, names, volumes, placement, and the open document's warm cache.

Doug's ask (29): parts shared across projects (fasteners, standoffs, inserts)
brought into an assembly to check fit-up. The payload has to be an ORDINARY
import so saving, undo and Move need nothing new, which is what the second half
of each test proves by building it.
"""

import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("SINDRI_DISK_CACHE", "0")
# The insert writes a real blob. Never into the user's store.
os.environ["SINDRI_BLOB_DIR"] = tempfile.mkdtemp(prefix="insert_doc_blobs_")

FAILED = []


def check(label, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + label + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILED.append(label)


import builder  # noqa: E402
import errors  # noqa: E402
import server  # noqa: E402


def box_feats(idx, w, h, d, x=0, y=0):
    """sketch + extrude: a w x h x d box standing on z=0 at (x, y)."""
    s = f"s{idx}"
    return [{"id": s, "type": "sketch", "plane": "XY",
             "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": y}]},
            {"id": f"e{idx}", "type": "extrude", "sketch": s, "distance": d, "operation": "new"}]


def bbox(shape):
    bb = shape.bounding_box()
    return tuple(round(v, 6) for v in (bb.min.X, bb.min.Y, bb.min.Z, bb.max.X, bb.max.Y, bb.max.Z))


def inserted(payload, fid="ins"):
    """The `import` feature insertPartFromFile writes from a reply."""
    return {"id": fid, "type": "import", "format": "brep", "name": payload["name"],
            "geom": payload["geom"], "solid": payload["solid"],
            "nodes": payload["nodes"], "parts": payload["parts"]}


# The part file: two visible bodies and one the user hid there.
PART = {
    "parameters": {},
    "features": box_feats(1, 10, 10, 50) + box_feats(2, 4, 4, 20, x=30) + box_feats(3, 2, 2, 2, x=-40),
    "bodyVisibility": {"body3": False},
}
# The document the user has open: a plate.
ASSEMBLY = {"parameters": {}, "features": box_feats(9, 100, 100, 2, x=-50, y=-50)}


def test_the_parts_land_as_they_were_and_can_be_moved():
    print("the inserted parts land where and as they were, and move like any body")
    _p, _e, src = builder.rebuild(PART)
    src = {b["id"]: b for b in src}
    payload = builder.insert_document(PART, "Standoff kit")

    check("one part per VISIBLE body (the hidden one stays behind)",
          payload["bodies"] == ["body1", "body2"], payload["bodies"])
    check("the parts sit under a root named after the file",
          payload["nodes"][0] == {"name": "Standoff kit", "parent": None}
          and [n["parent"] for n in payload["nodes"][1:]] == [0, 0], payload["nodes"])
    check("each part is named as it was built there",
          [n["name"] for n in payload["nodes"][1:]] == [src["body1"]["name"], src["body2"]["name"]],
          payload["nodes"])
    check("the blob is in the store under the hash it was given",
          os.path.exists(os.path.join(os.environ["SINDRI_BLOB_DIR"], payload["geom"] + ".bbrep")))
    check("nothing to warn about on a clean file",
          "failed" not in payload and "appearanceLost" not in payload, payload)

    doc = dict(ASSEMBLY, features=ASSEMBLY["features"] + [inserted(payload)])
    _p, errs, bodies = builder.rebuild(doc)
    check("the assembly builds with the insert in it", not errs, errs)
    got = {b["id"]: b for b in bodies}
    check("the plate plus the two parts, no more",
          sorted(got) == ["body1", "body2", "body3"], sorted(got))
    for here, there in (("body2", "body1"), ("body3", "body2")):
        b = got.get(here)
        if b is None:
            continue
        check(f"{here} has the name {there} had", b["name"] == src[there]["name"], b["name"])
        check(f"{here} is tied to its tree node", b.get("node_ref", "").startswith("ins/"), b.get("node_ref"))
        check(f"{here} has exactly the volume {there} had",
              abs(b["shape"].volume - src[there]["shape"].volume) < 1e-6,
              (b["shape"].volume, src[there]["shape"].volume))
        check(f"{here} sits exactly where {there} sat",
              bbox(b["shape"]) == bbox(src[there]["shape"]),
              (bbox(b["shape"]), bbox(src[there]["shape"])))

    move = {"id": "mv", "type": "move", "dx": 7, "dy": 0, "dz": 2, "rx": 0, "ry": 0, "rz": 0,
            "bodies": ["body3"]}
    _p, errs, moved = builder.rebuild(dict(doc, features=doc["features"] + [move]))
    moved = {b["id"]: b for b in moved}
    want = bbox(got["body3"]["shape"])
    want = (want[0] + 7, want[1], want[2] + 2, want[3] + 7, want[4], want[5] + 2)
    check("Move takes an inserted part like any other body",
          not errs and bbox(moved["body3"]["shape"]) == want,
          (errs, bbox(moved["body3"]["shape"]), want))


def test_one_body_is_its_own_root_named_after_the_file():
    print("a one-body part is named after its file, not 'Body1'")
    one = {"parameters": {}, "features": box_feats(1, 3, 3, 10)}
    payload = builder.insert_document(one, "M3x10")
    check("a single node, the root, named after the file",
          payload["nodes"] == [{"name": "M3x10", "parent": None}], payload["nodes"])
    check("its part binds to it", [p["node"] for p in payload["parts"]] == [0], payload["parts"])
    _p, errs, bodies = builder.rebuild(dict(ASSEMBLY, features=ASSEMBLY["features"] + [inserted(payload)]))
    check("it builds as one body called M3x10",
          not errs and [b["name"] for b in bodies][1:] == ["M3x10"], [b["name"] for b in bodies])


def test_the_open_documents_cache_is_untouched():
    print("inserting builds another document without touching the open one's cache")
    builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
    builder.rebuild_cached(ASSEMBLY)
    before = (list(builder._CACHE["feature_sigs"]), builder._CACHE["global_sig"],
              [id(s) for s in builder._CACHE["snaps"]])
    builder.insert_document(PART, "Standoff kit")
    after = (list(builder._CACHE["feature_sigs"]), builder._CACHE["global_sig"],
             [id(s) for s in builder._CACHE["snaps"]])
    check("the cache still describes the OPEN document, snapshot for snapshot",
          before == after, (len(before[0]), len(after[0])))


def test_split_lineage_and_failures_come_back():
    print("split lineage and failed features are reported, not lost")
    split = {"id": "sp", "type": "split", "offset": 0, "keep": "both", "body": "body1",
             "plane": {"origin": [0, 0, 25], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
             "groupSides": True}
    broken = {"id": "bad", "type": "extrude", "sketch": "nope", "distance": 5, "operation": "new"}
    doc = {"parameters": {}, "features": box_feats(1, 10, 10, 50) + [split, broken]}
    payload = builder.insert_document(doc, "Halves")
    check("both halves come across", payload["bodies"] == ["body1", "body2"], payload["bodies"])
    check("the second half says which body it was cut from (for its name)",
          payload["pieceOf"].get("body2") == ["body1", 2], payload["pieceOf"])
    check("the feature that did not build is counted", payload.get("failed") == 1, payload.get("failed"))


def test_a_part_kept_whole_there_keeps_its_small_pieces():
    print("a body that held small separate pieces there still holds them here")
    from build123d import Box, Compound, Pos

    # An assembly imported as ONE body (explode: false), as big field files are:
    # a 20 mm block and a 1 mm part clear of it, 0.0125% of its volume.
    asm = Compound([Box(20, 20, 20), Pos(60, 0, 0) * Box(1, 1, 1)])
    src = {"parameters": {}, "features": [
        {"id": "imp", "type": "import", "format": "step", "name": "Asm",
         "brep": builder._shape_to_brep_b64(asm), "explode": False}]}
    _p, _e, there = builder.rebuild(src)
    payload = builder.insert_document(src, "Asm")
    _p, errs, here = builder.rebuild({"parameters": {}, "features": [inserted(payload)]})
    check("the other document shows both pieces", len(there[0]["shape"].solids()) == 2)
    check("so does the inserted copy (the debris pass is not run twice)",
          not errs and len(here[0]["shape"].solids()) == 2,
          (errs, len(here[0]["shape"].solids())))


def test_a_one_solid_part_still_has_a_cuts_chips_cleared():
    print("a cut that leaves a floating chip on an inserted one-solid part clears it, as on any body")
    block = {"parameters": {}, "features": box_feats(1, 20, 20, 20)}
    payload = builder.insert_document(block, "Block")
    check("a one-solid part is not marked intact (nothing for the flag to keep)",
          "intact" not in payload["parts"][0], payload["parts"])

    # Two 0.2 mm slots along two edges of the 20 mm block cut off a 0.2 x 0.2 mm
    # corner column, 0.8 mm3 and clear of everything: under 0.1% of the block,
    # so the debris pass drops it. The two 0.2 mm strips beside the slots are
    # 1% of it, and stay.
    def slot(i, w, h, x, y):
        return [{"id": f"s{i}", "type": "sketch", "plane": "XY",
                 "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": y}]},
                {"id": f"c{i}", "type": "extrude", "sketch": f"s{i}", "distance": 20,
                 "operation": "cut", "hiddenBodies": []}]
    cuts = slot(7, 0.2, 30, -9.7, 0) + slot(8, 30, 0.2, 0, -9.7)
    got = {}
    for label, feats in (("plain", block["features"]), ("inserted", [inserted(payload)])):
        _p, errs, bodies = builder.rebuild({"parameters": {}, "features": feats + cuts})
        got[label] = (errs, sorted(round(s.volume, 3) for b in bodies for s in b["shape"].solids()))
    check("the plain block loses the chip", got["plain"][1] == [78.4, 78.4, 7683.2], got["plain"])
    check("so does the inserted block", got["inserted"] == got["plain"], got["inserted"])


def test_refusals_are_coded():
    print("an insert with nothing to bring is refused in words, with a code")
    hidden = dict(PART, bodyVisibility={"body1": False, "body2": False, "body3": False})
    res = server._insert_document_job(hidden, "Hidden")
    check("all bodies hidden: insertNoBodies",
          res.get("error", {}).get("code") == errors.INSERT_NO_BODIES, res)
    broken = {"parameters": {}, "features": [
        {"id": "bad", "type": "extrude", "sketch": "nope", "distance": 5, "operation": "new"}]}
    res = server._insert_document_job(broken, "Broken")
    check("nothing built: insertNothingBuilt",
          res.get("error", {}).get("code") == errors.INSERT_NOTHING_BUILT, res)
    check("...with no feature id from the OTHER document on it",
          "feature_id" not in res.get("error", {}), res)


def main():
    test_the_parts_land_as_they_were_and_can_be_moved()
    test_one_body_is_its_own_root_named_after_the_file()
    test_the_open_documents_cache_is_untouched()
    test_split_lineage_and_failures_come_back()
    test_a_part_kept_whole_there_keeps_its_small_pieces()
    test_a_one_solid_part_still_has_a_cuts_chips_cleared()
    test_refusals_are_coded()
    if FAILED:
        print(f"\n{len(FAILED)} FAILED")
        sys.exit(1)
    print("\nALL PASS")


if __name__ == "__main__":
    main()
