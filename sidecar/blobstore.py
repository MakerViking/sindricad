"""The durable geometry blob store: content-addressed BREP, one file per hash.

This directory is the SEAM between Rust and Python. Rust writes it when opening
a `.sindri` container (extracting the archive's geometry); the sidecar writes it
at import time, when it first produces a shape's bytes. Both read it.

That works without any locking because **the path is a pure function of the
content hash**: two writers racing on the same hash are writing byte-identical
data, and each publishes via rename. It is also why this store has no index —
unlike `geomstore`, whose SQLite index is documented single-process-only, and
which is exactly the wrong place to put a container's geometry: `geomstore`
lives in `$XDG_CACHE_HOME`, its `evict()` reclaims any blob with a refcount of 0,
and its `purge()` is wired to the Compute All button. A blob there would be
deleted by a user pressing a button. This store is under app-data, which nothing
sweeps.

THE HASH RULE (load-bearing, not style). Hash the STORED bytes ONCE, at the
moment they are produced, and carry that hash. Never re-derive one by
re-serialising a shape: `write(read(x)) != x` byte-wise for BREP, because reading
rebuilds the shape graph in a different but equivalent order. A re-derived hash
would change every generation, so every lookup would miss and the planned
instancing/dedup work would never fire. `put_bytes` returns the hash it computed
over exactly the bytes it stored — use that return value.

Deliberately OCP-FREE. `geomstore` imports `OCP.BinTools` at module level, which
is why it can only be touched from a worker; this module is pure bytes so it can
be used from anywhere, including the sidecar's parent process.
"""

import hashlib
import os
import uuid

_DIGEST_SIZE = 16  # blake2b-128 -> 32 hex chars, matching geomstore's key width
_SUFFIX = ".bbrep"
_CHUNK = 1 << 20


def default_root():
    """Where Rust told us the store is. `SINDRI_BLOB_DIR` is set by
    `sidecar.rs::configure_env` from `container.rs::blob_dir`, so the two agree
    exactly. The fallback exists for a bare `python server.py` (tests, probes)
    and is deliberately NOT the geomstore cache root."""
    env = os.environ.get("SINDRI_BLOB_DIR")
    if env:
        return env
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "share"
    )
    return os.path.join(base, "sindricad", "blobs")


def hash_bytes(data):
    """The content hash of a blob. Matches container.rs::hash_bytes byte for
    byte — a mismatch there would make every container reference dangle."""
    return hashlib.blake2b(data, digest_size=_DIGEST_SIZE).hexdigest()


class BlobStore:
    """Content-addressed byte storage. Flat, not sharded like geomstore's
    `blobs/<key[:2]>/`: that store holds one blob per BODY (3,060 for the
    reference assembly), this one holds one per IMPORT FEATURE."""

    def __init__(self, root=None):
        self.root = root or default_root()
        os.makedirs(self.root, exist_ok=True)

    def path_for(self, digest):
        if not _is_hash(digest):
            raise ValueError(f"not a content hash: {digest!r}")
        return os.path.join(self.root, digest + _SUFFIX)

    def has(self, digest):
        try:
            return os.path.exists(self.path_for(digest))
        except ValueError:
            return False

    def put_bytes(self, data):
        """Store `data` and return the hash computed over exactly those bytes.

        Idempotent: an existing file with the same hash holds identical content
        by construction, so a repeat is a no-op rather than a rewrite. That is
        also what makes it safe for Rust and Python to write concurrently."""
        digest = hash_bytes(data)
        dest = self.path_for(digest)
        if os.path.exists(dest):
            return digest
        self._atomic_write(dest, data)
        return digest

    def get_bytes(self, digest):
        """The stored bytes, or None if absent.

        A CORRUPT blob is not silently tolerated here the way a cache miss would
        be: this store is the source of truth for the user's geometry, so bytes
        that do not hash to their own filename are a real problem. They are
        removed and reported as a miss, which sends the caller to the container
        (or to a re-import) instead of building the wrong shape."""
        try:
            path = self.path_for(digest)
        except ValueError:
            return None
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError:
            return None
        if hash_bytes(data) != digest:
            try:
                os.unlink(path)
            except OSError:
                pass
            return None
        return data

    def _atomic_write(self, dest, data):
        """Publish atomically: write a temp file in the SAME directory, fsync it,
        rename into place, then fsync the directory. A crash at any point leaves
        either no file or a complete one, never a torn one. Mirrors
        geomstore._atomic_write and container.rs's publish path."""
        tmp = os.path.join(self.root, uuid.uuid4().hex + ".tmp")
        try:
            with open(tmp, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, dest)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        _fsync_dir(self.root)


def _is_hash(s):
    return (
        isinstance(s, str)
        and len(s) == _DIGEST_SIZE * 2
        and all(c in "0123456789abcdef" for c in s)
    )


def _fsync_dir(path):
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


_default = None


def default_store():
    global _default
    if _default is None:
        _default = BlobStore()
    return _default
