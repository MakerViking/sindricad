"""Tests for blobstore.py. Run: cd sidecar && .venv/bin/python test_blobstore.py

Pure bytes — no OCP, no sidecar, no network.

The load-bearing test here is `test_hash_matches_rust`: this store is written by
BOTH Rust (extracting a container) and Python (importing geometry), addressed
purely by content hash. If the two languages ever disagree about that hash, every
container reference dangles and the failure looks like "the geometry vanished".
The vectors below are duplicated verbatim in src-tauri/src/container.rs so both
sides are pinned to the same constants.
"""

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blobstore  # noqa: E402

FAILED = []

# blake2b, digest_size=16. MUST match container.rs::tests::hash_matches_python.
SHARED_VECTORS = [
    (b"", "cae66941d9efbd404e4d88758ea67670"),
    (b"sindricad", "dc82074d29de5d86a53adf0120a12de8"),
    (b"\x00\xff" * 8, "2a7271a37f134cb3bfb8ff7e507e0da7"),
]


def check(label, cond):
    print(("  ok   " if cond else "  FAIL ") + label)
    if not cond:
        FAILED.append(label)


def test_hash_matches_rust():
    print("hash agrees with Rust (the seam)")
    for data, want in SHARED_VECTORS:
        check(f"blake2b-128 of {data[:12]!r} -> {want[:12]}...",
              blobstore.hash_bytes(data) == want)
    check("digest is 32 hex chars", len(blobstore.hash_bytes(b"x")) == 32)


def test_roundtrip():
    print("roundtrip")
    root = tempfile.mkdtemp(prefix="blobstore_rt_")
    try:
        s = blobstore.BlobStore(root=root)
        data = os.urandom(100_000)

        digest = s.put_bytes(data)
        check("put returns the hash of what it stored",
              digest == blobstore.hash_bytes(data))
        check("the file is NAMED by that hash",
              os.path.exists(os.path.join(root, digest + ".bbrep")))
        check("has() sees it", s.has(digest))
        check("bytes come back identical", s.get_bytes(data and digest) == data)

        # Idempotence is what makes concurrent Rust+Python writes safe.
        before = os.stat(s.path_for(digest)).st_mtime_ns
        check("re-put is a no-op returning the same hash", s.put_bytes(data) == digest)
        check("...and did not rewrite the file",
              os.stat(s.path_for(digest)).st_mtime_ns == before)
        check("no temp files left behind",
              not [n for n in os.listdir(root) if n.endswith(".tmp")])

        check("a miss is None, not an error", s.get_bytes("0" * 32) is None)
        check("has() is False for a miss", not s.has("0" * 32))
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_corruption_is_a_miss_not_wrong_geometry():
    """This store is the source of truth for the user's geometry, so bytes that
    do not hash to their own filename must NOT be handed back. Returning them
    would build a silently wrong shape — the worst failure class in the design."""
    print("corruption")
    root = tempfile.mkdtemp(prefix="blobstore_bad_")
    try:
        s = blobstore.BlobStore(root=root)
        digest = s.put_bytes(b"the real geometry" * 500)

        with open(s.path_for(digest), "wb") as fh:
            fh.write(b"tampered" * 500)  # valid file, wrong content

        check("corrupt blob is reported as a MISS", s.get_bytes(digest) is None)
        check("...and the bad file is reclaimed, not left to masquerade",
              not os.path.exists(s.path_for(digest)))

        # Truncation, the likelier real-world case.
        d2 = s.put_bytes(b"another body" * 500)
        with open(s.path_for(d2), "r+b") as fh:
            fh.truncate(100)
        check("truncated blob is reported as a MISS", s.get_bytes(d2) is None)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_rejects_non_hash_names():
    """A digest reaches the filesystem as a filename. It is ours, not a file's,
    but validate rather than trust: a traversing 'hash' must never resolve."""
    print("path safety")
    root = tempfile.mkdtemp(prefix="blobstore_path_")
    try:
        s = blobstore.BlobStore(root=root)
        for bad in ["../../etc/passwd", "..", "", "z" * 32, "abc", "A" * 32, None, "/abs/path"]:
            try:
                s.path_for(bad)
                check(f"rejected {bad!r}", False)
            except (ValueError, TypeError):
                check(f"rejected {bad!r}", True)
        check("has() on a bad name is False, not a raise", not s.has("../../x"))
        check("get_bytes on a bad name is None, not a raise", s.get_bytes("../../x") is None)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_root_comes_from_rust():
    """Rust resolves app_data_dir and passes SINDRI_BLOB_DIR; the two MUST agree
    or each writes a store the other cannot see."""
    print("root resolution")
    old = os.environ.get("SINDRI_BLOB_DIR")
    try:
        os.environ["SINDRI_BLOB_DIR"] = "/tmp/sindri_blob_env_check"
        check("SINDRI_BLOB_DIR wins", blobstore.default_root() == "/tmp/sindri_blob_env_check")
        del os.environ["SINDRI_BLOB_DIR"]
        fallback = blobstore.default_root()
        check("fallback is under a data dir, NOT the geomstore cache",
              "sindricad" in fallback and ".cache" not in fallback)
    finally:
        if old is None:
            os.environ.pop("SINDRI_BLOB_DIR", None)
        else:
            os.environ["SINDRI_BLOB_DIR"] = old


def test_no_occt_import():
    """geomstore imports OCP.BinTools at module level, which is why it can only
    be touched from a worker. This module must stay pure bytes."""
    print("stays out of OCCT")
    check("blobstore did not import OCP", not any(m.startswith("OCP") for m in sys.modules))
    check("blobstore did not import geomstore", "geomstore" not in sys.modules)


if __name__ == "__main__":
    test_no_occt_import()  # first: a later import would mask it
    test_hash_matches_rust()
    test_roundtrip()
    test_corruption_is_a_miss_not_wrong_geometry()
    test_rejects_non_hash_names()
    test_root_comes_from_rust()
    print()
    if FAILED:
        print(f"FAILED ({len(FAILED)}):")
        for f in FAILED:
            print("  - " + f)
        sys.exit(1)
    print("all blobstore tests passed")
