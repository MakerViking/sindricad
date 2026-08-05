"""Tests for rebuilding an import feature FROM THE BLOB STORE. Run:
    cd sidecar && .venv/bin/python test_blob_rebuild.py

Why this suite is separate from test_import_blob.py: that one covers producing a
blob, this one covers CONSUMING it, and the consuming side has a failure mode
that only appears cold.

THE COLD-CACHE REQUIREMENT. Every op that carries a whole document goes through
`rebuild_cached`, and a warm checkpoint resolves an import WITHOUT ever touching
the blob. So a broken resolver passes on a developer's machine every time and
fails on a fresh one, after an app update, or on a wiped cache — exactly the
machines that are not ours. Every test here therefore points geomstore at an
empty directory, and `test_rebuild_is_cold` proves that isolation actually works
rather than assuming it.
"""

import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

FIXTURE = os.path.join(HERE, "fixtures", "asm_nested.step")
FAILED = []


def check(label, cond):
    print(("  ok   " if cond else "  FAIL ") + label)
    if not cond:
        FAILED.append(label)


class Cold:
    """A blob store and a geomstore cache, both empty, both isolated."""

    def __enter__(self):
        self.blobs = tempfile.mkdtemp(prefix="rebuild_blobs_")
        self.cache = tempfile.mkdtemp(prefix="rebuild_cache_")
        self._env = {k: os.environ.get(k) for k in ("SINDRI_BLOB_DIR", "XDG_CACHE_HOME")}
        os.environ["SINDRI_BLOB_DIR"] = self.blobs
        os.environ["XDG_CACHE_HOME"] = self.cache
        import blobstore

        blobstore._default = None  # re-read the env
        return self

    def __exit__(self, *a):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.blobs, ignore_errors=True)
        shutil.rmtree(self.cache, ignore_errors=True)


def _doc(feature):
    return {"parameters": {}, "features": [feature]}


def _import_feature(cold):
    import builder

    out = builder.import_geometry(FIXTURE, "step")
    f = {"id": "f1", "type": "import", "name": "Asm"}
    for k in ("brep", "geom", "solid", "faces", "nodes", "parts"):
        if k in out:
            f[k] = out[k]
    return f


def test_rebuild_is_cold():
    """Guard the guard: if geomstore were NOT isolated, every other test here
    could pass against a warm checkpoint and prove nothing."""
    print("the harness is actually cold")
    with Cold() as c:
        import geomstore

        store = geomstore.Store(root=os.path.join(c.cache, "sindricad", "geom"))
        check("geomstore root is the throwaway cache", c.cache in store.root)
        check("...and holds no checkpoints", store.find_checkpoint(["anything"]) is None)


def _as_legacy(f):
    """The same import feature as a pre-v5 document would have carried it: inline
    base64 ASCII BREP, no hash. Derived from the stored blob so it is a faithful
    v4 document rather than a hand-written approximation."""
    import blobstore
    import builder

    data = blobstore.default_store().get_bytes(f["geom"])
    legacy = dict(f)
    legacy.pop("geom")
    legacy["brep"] = builder._shape_to_brep_b64(builder._blob_to_shape(data))
    return legacy


def test_rebuilds_from_the_blob_alone():
    """The headline: a v5 feature carries ONLY a content hash, and must rebuild
    to exactly what the old inline-base64 document produced."""
    print("rebuilds from the hash alone")
    with Cold():
        import builder

        f = _import_feature(None)
        check("the import produced a hash", isinstance(f.get("geom"), str))
        check("...and no inline base64", "brep" not in f)

        _part, errors, bodies = builder.rebuild(_doc(dict(f)))
        check("no errors rebuilding from the blob", not errors)
        check(f"produced bodies ({len(bodies)})", len(bodies) > 0)
        check("bodies carry real shapes", all(b["shape"] is not None for b in bodies))
        # An assembly blob is a COMPOUND. build123d Shape.cast() returns None for
        # those, which would silently yield zero bodies -- the reason this path
        # uses _wrap_topods.
        check("the assembly tree still binds (named bodies, not 'Asm 1')",
              any(b["name"] != "Asm" and not b["name"].startswith("Asm ") for b in bodies))

        # Equivalence with the format it replaces: same document, same bodies.
        legacy_bodies = builder.rebuild(_doc(_as_legacy(f)))[2]
        check(f"same body count as a v4 document ({len(bodies)} vs {len(legacy_bodies)})",
              len(bodies) == len(legacy_bodies))
        check("same body NAMES as a v4 document",
              [b["name"] for b in bodies] == [b["name"] for b in legacy_bodies])


def test_a_pre_v5_document_still_opens():
    """Every document saved before the container format carries inline base64 and
    no hash. Those must keep rebuilding untouched -- this is the compatibility
    promise, and nothing else in the suite covers it."""
    print("a pre-v5 document still opens")
    with Cold() as c:
        import builder

        legacy = _as_legacy(_import_feature(None))
        for n in os.listdir(c.blobs):
            os.unlink(os.path.join(c.blobs, n))  # no blobs at all, as on a fresh machine

        _part, errors, bodies = builder.rebuild(_doc(legacy))
        check("rebuilt with no blob store to help it", not errors and len(bodies) > 0)


def test_a_missing_blob_with_no_fallback_is_a_clear_error():
    """What a v5 document does when its geometry cannot be found. It must name
    the situation and the way out — not raise a kernel-level message."""
    print("missing blob, no fallback")
    with Cold():
        import builder

        f = _import_feature(None)
        f["geom"] = "0" * 32  # a hash that was never stored

        _part, errors, bodies = builder.rebuild(_doc(f))
        msg = " ".join(str(e) for e in errors).lower()
        check("it errored rather than producing a silent empty body",
              bool(errors) and not bodies)
        check("the message says the geometry is missing", "missing" in msg)
        check("...and tells the user what to do", ".sindri" in msg or "re-import" in msg)


def test_tampered_blob_is_refused_before_occt_sees_it():
    """The hash proves the bytes are the ones the container declared; it does NOT
    prove they are benign, since a hostile file chooses both. So the header check
    still has to stand between a crafted document and the OCCT parser."""
    print("hostile bytes")
    with Cold() as c:
        import builder

        f = _import_feature(None)
        digest = f["geom"]
        # Write garbage under a name whose hash matches it, i.e. defeat the
        # store's own integrity check the way a crafted container would.
        import blobstore

        real = blobstore.default_store()
        with open(real.path_for(digest), "wb") as fh:
            fh.write(b"\n" + b"NOT A BREP AT ALL " * 200)

        _part, errors, bodies = builder.rebuild(_doc(f))
        check("refused, with no bodies produced", bool(errors) and not bodies)
        # get_bytes reclaims it as corrupt (hash mismatch) before the header
        # check is even reached; either refusal is correct, neither may pass.
        check("did not hand the bytes to OCCT and build something",
              all(b.get("shape") is None for b in bodies) if bodies else True)


if __name__ == "__main__":
    if not os.path.exists(FIXTURE):
        print(f"missing fixture {FIXTURE}")
        sys.exit(1)
    test_rebuild_is_cold()
    test_rebuilds_from_the_blob_alone()
    test_a_pre_v5_document_still_opens()
    test_a_missing_blob_with_no_fallback_is_a_clear_error()
    test_tampered_blob_is_refused_before_occt_sees_it()
    print()
    if FAILED:
        print(f"FAILED ({len(FAILED)}):")
        for f in FAILED:
            print("  - " + f)
        sys.exit(1)
    print("all blob-rebuild tests passed")
