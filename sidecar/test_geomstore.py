"""Tests for geomstore.py. Run: uv run python test_geomstore.py

Exercises real OCCT round-trips (not byte-equality — OCCT does not guarantee that;
we compare restored volume / face count), the deepest-restorable-checkpoint walk,
corrupt-blob demotion to a miss, atomic tmp sweep, eviction under pins + refcounts,
and mesh put/get. Uses a throwaway temp root so it never touches the real cache."""

import io
import os
import shutil
import tempfile

from build123d import Solid
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_ShapeEnum
from OCP.TopExp import TopExp_Explorer

import geomstore


def _volume(topods):
    g = GProp_GProps()
    BRepGProp.VolumeProperties_s(topods, g)
    return g.Mass()


def _face_count(topods):
    exp = TopExp_Explorer(topods, TopAbs_ShapeEnum.TopAbs_FACE)
    n = 0
    while exp.More():
        n += 1
        exp.Next()
    return n


def _sample_shape():
    """A box+cylinder boolean: a genuine multi-face OCCT solid."""
    return Solid.make_box(10, 10, 10) + Solid.make_cylinder(3, 20)


def _manifest(blob_key, body_id=1, name="Body1"):
    return [{"body_id": body_id, "name": name, "blob_key": blob_key}]


PASS = []
FAIL = []


def check(name, cond):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}")


def test_blob_roundtrip(store):
    print("test_blob_roundtrip")
    shape = _sample_shape()
    want_vol, want_faces = shape.volume, len(shape.faces())
    size = store.put_blob("aa" + "0" * 30, shape)
    check("put_blob returns positive size", size > 0)

    got = store.get_blob("aa" + "0" * 30)
    check("get_blob returns a shape", got is not None)
    check("restored volume matches", abs(_volume(got) - want_vol) < 1e-6)
    check("restored face count matches", _face_count(got) == want_faces)

    # dedup: second put of the same key is a no-op returning the same size.
    check("put_blob dedups on existing key", store.put_blob("aa" + "0" * 30, shape) == size)
    check("get_blob(missing) is None", store.get_blob("ff" + "0" * 30) is None)


def test_checkpoint_find(store):
    print("test_checkpoint_find")
    # A 5-key chain; only key index 3 gets a real checkpoint + blob.
    keys = ["ck%02d" % i + "1" * 28 for i in range(5)]
    shape = _sample_shape()
    blob_key = "bb" + "1" * 30
    store.put_blob(blob_key, shape)
    store.save_checkpoint(keys[3], feat_index=3, manifest=_manifest(blob_key),
                          state_json='{"n": 4}', replay_ms=800.0)

    hit = store.find_checkpoint(keys)
    check("find_checkpoint returns the present row", hit is not None)
    check("deepest present feat_index is 3", hit and hit["feat_index"] == 3)
    check("state_json round-trips", hit and hit["state_json"] == '{"n": 4}')
    check("manifest parsed to list", hit and hit["manifest"][0]["blob_key"] == blob_key)

    # A deeper checkpoint should win over the shallower one.
    deep_blob = "bc" + "2" * 30
    store.put_blob(deep_blob, shape)
    store.save_checkpoint(keys[4], feat_index=4, manifest=_manifest(deep_blob),
                          state_json='{"n": 5}', replay_ms=200.0)
    hit2 = store.find_checkpoint(keys)
    check("deeper checkpoint wins", hit2 and hit2["feat_index"] == 4)

    check("find_checkpoint([]) is None", store.find_checkpoint([]) is None)
    check("no-match chain is None", store.find_checkpoint(["zz" + "9" * 28]) is None)


def test_corrupt_blob_skips(store):
    print("test_corrupt_blob_skips")
    keys = ["dk%02d" % i + "3" * 28 for i in range(5)]
    shape = _sample_shape()
    shallow_blob, deep_blob = "d1" + "3" * 30, "d2" + "3" * 30
    store.put_blob(shallow_blob, shape)
    store.put_blob(deep_blob, shape)
    store.save_checkpoint(keys[1], 1, _manifest(shallow_blob), '{"n": 2}', 100.0)
    store.save_checkpoint(keys[3], 3, _manifest(deep_blob), '{"n": 4}', 100.0)

    # Truncate the deep blob to a stub: get_blob must miss, find must fall back to 1.
    with open(store._blob_path(deep_blob), "r+b") as fh:
        fh.truncate(12)
    check("get_blob(truncated) is None", store.get_blob(deep_blob) is None)

    hit = store.find_checkpoint(keys)
    check("find falls back past corrupt deep checkpoint", hit and hit["feat_index"] == 1)


def test_tmp_sweep():
    print("test_tmp_sweep")
    root = tempfile.mkdtemp(prefix="geomstore_sweep_")
    try:
        tmp_dir = os.path.join(root, "tmp")
        os.makedirs(tmp_dir)
        stale = os.path.join(tmp_dir, "leftover.tmp")
        with open(stale, "wb") as fh:
            fh.write(b"crash residue")
        geomstore.Store(root=root)  # __init__ sweeps tmp/
        check("stale tmp file swept on init", not os.path.exists(stale))
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_mesh_roundtrip(store):
    print("test_mesh_roundtrip")
    payload = bytes(range(256)) * 4
    store.put_mesh("body9-0.12", payload)
    check("mesh round-trips byte-exact", store.get_mesh("body9-0.12") == payload)
    check("get_mesh(missing) is None", store.get_mesh("nope-0.5") is None)
    # sanitized key still resolves consistently (dots -> dashes, deterministic).
    check("mesh key sanitized consistently", store.get_mesh("body9-0.12") == payload)


def test_eviction(store):
    print("test_eviction")
    shape = _sample_shape()
    # unique blob per checkpoint so evicting a row actually frees bytes...
    unique = []
    for i in range(4):
        bk = "e%d" % i + "4" * 30
        store.put_blob(bk, shape)
        unique.append(bk)
    # ...plus one shared blob referenced by two checkpoints (refcount retention).
    shared = "es" + "4" * 30
    store.put_blob(shared, shape)

    one_blob = os.path.getsize(store._blob_path(unique[0]))

    # cp0: pinned. cp1,cp2: evictable, each also references the shared blob. cp3: evictable.
    store.save_checkpoint("ecp0" + "4" * 28, 0, _manifest(unique[0]), "{}", 50.0, pinned=True)
    store.save_checkpoint("ecp1" + "4" * 28, 1,
                          _manifest(unique[1]) + _manifest(shared, 2, "S"), "{}", 10.0)
    store.save_checkpoint("ecp2" + "4" * 28, 2,
                          _manifest(unique[2]) + _manifest(shared, 2, "S"), "{}", 10.0)
    store.save_checkpoint("ecp3" + "4" * 28, 3, _manifest(unique[3]), "{}", 10.0)

    # cap that forces eviction of the non-pinned rows but keeps the pinned one.
    cap = one_blob * 2
    n = store.evict(byte_cap=cap)
    check("evict removed at least one checkpoint", n >= 1)

    check("pinned checkpoint survives", store.find_checkpoint(["ecp0" + "4" * 28]) is not None)
    check("pinned blob retained", os.path.exists(store._blob_path(unique[0])))
    # shared blob: retained iff at least one referencing checkpoint survives; if both
    # ecp1 and ecp2 were evicted it is reclaimed. Either way it must never be deleted
    # while a referencing row survives.
    survivors = [k for k in ("ecp1", "ecp2") if store.find_checkpoint([k + "4" * 28])]
    if survivors:
        check("shared blob kept while a referencer survives", os.path.exists(store._blob_path(shared)))
    else:
        check("shared blob reclaimed when no referencer survives", not os.path.exists(store._blob_path(shared)))

    # evicting again under a huge cap is a no-op.
    check("evict under high cap is a no-op", store.evict(byte_cap=1 << 40) == 0)


def test_stats(store):
    print("test_stats")
    s = store.stats()
    check("stats has rows/blobs/bytes", {"rows", "blobs", "bytes"} <= set(s))
    check("stats bytes non-negative", s["bytes"] >= 0)


def test_default_store():
    print("test_default_store")
    check("default_store is a singleton", geomstore.default_store() is geomstore.default_store())


def main():
    root = tempfile.mkdtemp(prefix="geomstore_test_")
    print(f"temp root: {root}\n")
    try:
        store = geomstore.Store(root=root)
        test_blob_roundtrip(store)
        test_checkpoint_find(store)
        test_corrupt_blob_skips(store)
        test_tmp_sweep()
        test_mesh_roundtrip(store)
        test_eviction(store)
        test_stats(store)
        test_default_store()
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        print("FAILURES:", ", ".join(FAIL))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
