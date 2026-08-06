"""Tests for the import -> blob-store path. Run:
    cd sidecar && .venv/bin/python test_import_blob.py

Needs OCP (real geometry), unlike test_blobstore.py which is pure bytes.

The load-bearing test is `test_hash_is_stable_across_processes`. The whole
container design rests on carrying a content hash rather than re-deriving one,
and that is only sound if serialising a given shape is deterministic. The probe
measured that it IS deterministic for a given in-memory shape across processes,
while `write(read(x)) != x` byte-wise. This pins the half we depend on, in the
one place a future OCP upgrade could quietly break it.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

FIXTURE = os.path.join(HERE, "fixtures", "asm_nested.step")
FAILED = []


def check(label, cond):
    print(("  ok   " if cond else "  FAIL ") + label)
    if not cond:
        FAILED.append(label)


def _import_once(root):
    """Import the fixture in THIS process with the blob store pointed at `root`."""
    os.environ["SINDRI_BLOB_DIR"] = root
    import blobstore

    blobstore._default = None  # re-read the env
    import builder

    return builder.import_geometry(FIXTURE, "step")


def test_import_writes_a_blob_named_by_its_own_hash():
    print("import writes a hashed blob")
    root = tempfile.mkdtemp(prefix="import_blob_")
    try:
        out = _import_once(root)
        digest = out.get("geom")
        check("import returned a content hash", isinstance(digest, str) and len(digest) == 32)
        if not digest:
            return

        path = os.path.join(root, digest + ".bbrep")
        check("the blob exists, named by that hash", os.path.exists(path))

        with open(path, "rb") as fh:
            data = fh.read()
        check("the hash is blake2b-128 of the STORED bytes",
              hashlib.blake2b(data, digest_size=16).hexdigest() == digest)

        # Binary BinTools, not the ASCII writer. The two have distinct magic
        # strings; picking up the ASCII one here would silently forfeit the
        # measured 45% size win.
        check("the blob is BINARY BinTools, not ASCII BRepTools",
              data.lstrip(b"\n\r ").startswith(b"Open CASCADE Topology V"))

        # The inline base64 is GONE. Its presence was the whole problem: on the
        # 356 MiB reference assembly that one field was 541.8 MiB, over both the
        # frame cap and the embedded-BREP cap. Documents saved before v5 still
        # CARRY it and are still read (test_blob_rebuild covers that); nothing
        # writes it any more.
        check("no inline base64 is produced any more", "brep" not in out)

        # The blob deflates well, which is what keeps the container small — the
        # measured figure on these fixtures is ~0.15x of the base64 that used to
        # sit raw in the JSON.
        deflated = len(zlib.compress(data, 6))
        check(f"the blob deflates substantially ({deflated / len(data):.2f}x of raw)",
              deflated < len(data) * 0.5)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_hash_is_stable_across_processes():
    """Same file, two separate interpreters, same hash. If this ever fails, every
    stored reference goes stale on the next app launch and documents open with
    missing geometry — so it must fail LOUDLY here rather than in the field."""
    print("hash is stable across processes")
    root = tempfile.mkdtemp(prefix="import_blob_x_")
    try:
        script = (
            "import os,sys,json;"
            f"sys.path.insert(0,{HERE!r});"
            f"os.environ['SINDRI_BLOB_DIR']={root!r};"
            "import builder;"
            f"print(json.dumps(builder.import_geometry({FIXTURE!r},'step').get('geom')))"
        )
        runs = []
        for i in range(2):
            r = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
            if r.returncode != 0:
                check(f"subprocess run {i + 1} succeeded", False)
                print(r.stderr[-600:])
                return
            runs.append(json.loads(r.stdout.strip().splitlines()[-1]))

        check("both runs produced a hash", all(isinstance(h, str) for h in runs))
        check(f"the two processes agree ({str(runs[0])[:12]}...)", runs[0] == runs[1])
        check("and only ONE blob was written (the second deduped)",
              len([n for n in os.listdir(root) if n.endswith(".bbrep")]) == 1)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_import_refuses_when_the_store_is_unwritable():
    """Now that the document carries no inline copy, a hash we cannot store means
    a feature with NO geometry anywhere. Refusing the import is recoverable; a
    silently empty document is not, and nothing downstream could detect it."""
    print("refuses rather than importing nothing")
    root = tempfile.mkdtemp(prefix="import_blob_ro_")
    try:
        os.chmod(root, 0o500)  # readable, not writable
        if os.access(root, os.W_OK):
            print("  skip  (running as root: cannot make a directory unwritable)")
            return
        try:
            _import_once(root)
            check("the import was refused", False)
        except Exception as e:  # noqa: BLE001
            msg = str(e).lower()
            check("the import was refused", True)
            check("...with a message naming the cause",
                  "store" in msg or "disk" in msg or "permission" in msg)
    finally:
        os.chmod(root, 0o700)
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    if not os.path.exists(FIXTURE):
        print(f"missing fixture {FIXTURE}")
        sys.exit(1)
    test_import_writes_a_blob_named_by_its_own_hash()
    test_hash_is_stable_across_processes()
    test_import_refuses_when_the_store_is_unwritable()
    print()
    if FAILED:
        print(f"FAILED ({len(FAILED)}):")
        for f in FAILED:
            print("  - " + f)
        sys.exit(1)
    print("all import-blob tests passed")
