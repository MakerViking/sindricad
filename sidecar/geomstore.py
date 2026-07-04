"""Durable checkpoint store for the OCCT rebuild cache (design §3.2/§3.3, Phase 1).

Why this exists: rebuilding the measured 125-feature document costs ~26 s cold, but
restoring a body from a binary BREP blob costs ~14 ms — a ~1,700x lever. This module
is the disk side of that: a content-addressed blob store (ONE body per blob, keyed by
the chain key of the last feature that modified it, so an unchanged body dedups for
free — same inputs => same key => same file, no geometry hashing) plus a SQLite index
of checkpoints.

The index is SOFT STATE. Every method degrades a missing / corrupt / short entry to a
cache MISS — never an exception, never wrong geometry — so a deleted or truncated cache
only ever costs a rebuild (the `.sindri` portability constraint, §1). A fresh directory
scan can always reconstruct what is restorable; the index is only there to make the
lookup O(1) instead of O(disk).

Single-process use only (the one geometry worker). SQLite's own locking is the only
concurrency control needed; there is no cross-process protocol here.
"""

import io
import json
import os
import re
import sqlite3
import time
import uuid

from OCP.BinTools import BinTools, BinTools_FormatVersion
from OCP.TopoDS import TopoDS_Shape

# Binary BREP, PINNED to format V3: this OCP build's V4 reader fails on real
# sidecar bodies (booleans + defeaturing heritage) with
# NCollection_IndexedMap::FindKey / 'UnExpected BRep_PointRepresentation', for
# every triangle/normal flag combination — measured on the DDR document. V3
# round-trips the same shapes in ~4 ms. Revisit only with a differential test.
_FMT = BinTools_FormatVersion.BinTools_FormatVersion_VERSION_3

# Mesh keys embed a body key + a tolerance suffix; keep the filename to hex+dash so a
# stray key can never escape meshes/ or collide with the shard layout.
_MESH_SANITIZE = re.compile(r"[^0-9a-fA-F-]")

_BBREP = ".bbrep"


def _default_root():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache"
    )
    return os.path.join(base, "sindricad", "geom")


def _fsync_dir(path):
    """fsync a directory so a rename INTO it is durable across a crash. Best-effort:
    a few filesystems refuse an O_RDONLY directory fsync, and a lost cache entry is
    only ever a miss, so a failure here is not worth raising over."""
    try:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass


class Store:
    """Durable blob + checkpoint store rooted at a cache directory."""

    def __init__(self, root=None):
        self.root = root or _default_root()
        self.blobs_dir = os.path.join(self.root, "blobs")
        self.meshes_dir = os.path.join(self.root, "meshes")
        self.tmp_dir = os.path.join(self.root, "tmp")
        for d in (self.blobs_dir, self.meshes_dir, self.tmp_dir):
            os.makedirs(d, exist_ok=True)
        # A crash can leave half-written temp files; nothing references them (writes
        # only ever publish via rename), so clear them before we start writing more.
        self._sweep_tmp()
        self.db = sqlite3.connect(
            os.path.join(self.root, "index.sqlite"), check_same_thread=False
        )
        self.db.row_factory = sqlite3.Row
        # WAL so a reader never blocks the writer; NORMAL sync is safe because the
        # index is rebuildable — we never trade a rebuild-vs-error decision on it.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS checkpoints (
                chain_key   TEXT PRIMARY KEY,
                feat_index  INTEGER,
                manifest    TEXT,   -- JSON [{body_id, name, blob_key}, ...]
                state       TEXT,   -- opaque JSON: datums, errors, n, owners, sketches
                replay_ms   REAL,   -- measured wall cost to recreate from the prior cp
                bytes       INTEGER,-- sum of referenced blob sizes at save time
                last_access REAL,
                pinned      INTEGER DEFAULT 0
            )"""
        )
        self.db.commit()

    # --- startup housekeeping -------------------------------------------------

    def _sweep_tmp(self):
        try:
            names = os.listdir(self.tmp_dir)
        except OSError:
            return
        for name in names:
            try:
                os.unlink(os.path.join(self.tmp_dir, name))
            except OSError:
                pass

    # --- path helpers ---------------------------------------------------------

    def _blob_path(self, key):
        # 2-hex-char shard keeps any one directory from holding tens of thousands of
        # files at 10k features. Keys are blake2b hex, so key[:2] is a clean shard.
        return os.path.join(self.blobs_dir, key[:2], key + _BBREP)

    def _mesh_path(self, key):
        return os.path.join(self.meshes_dir, _MESH_SANITIZE.sub("-", key) + ".bin")

    def _iter_blobs(self):
        try:
            shards = os.listdir(self.blobs_dir)
        except OSError:
            return
        for shard in shards:
            shard_dir = os.path.join(self.blobs_dir, shard)
            try:
                names = os.listdir(shard_dir)
            except OSError:
                continue
            for name in names:
                if name.endswith(_BBREP):
                    yield name[: -len(_BBREP)], os.path.join(shard_dir, name)

    # --- atomic write ---------------------------------------------------------

    def _atomic_write(self, dest, data):
        """Publish `data` at `dest` atomically: write a temp file, fsync it, rename
        into place, then fsync the destination directory. A crash at any point leaves
        either the old file or the new one, never a torn one, and never a temp file
        that outlives startup (the sweep reclaims those)."""
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = os.path.join(self.tmp_dir, uuid.uuid4().hex + ".tmp")
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, dest)
        _fsync_dir(os.path.dirname(dest))

    # --- blobs ----------------------------------------------------------------

    def put_blob(self, key, shape, with_triangles=True):
        """Serialize a body to blobs/<key[:2]>/<key>.bbrep and return its byte size.
        `shape` is a build123d Shape (its .wrapped TopoDS) or a raw TopoDS_Shape.
        If the key already exists this is a no-op (same key => identical body), which
        is what gives cross-checkpoint dedup for free.

        Triangles are ALWAYS included: writing with_triangles=False on a shape that
        has been tessellated leaves dangling polygon-on-triangulation point
        representations in the stream, and BinTools_ShapeSet::ReadGeometry fails with
        'UnExpected BRep_PointRepresentation' on read (measured on real DDR bodies).
        The flag is kept for API stability but False is ignored on purpose; the size
        cost buys load-time remeshing becoming a no-op."""
        dest = self._blob_path(key)
        if os.path.exists(dest):
            return os.path.getsize(dest)
        wrapped = shape.wrapped if hasattr(shape, "wrapped") else shape
        buf = io.BytesIO()
        BinTools.Write_s(wrapped, buf, True, False, _FMT)
        data = buf.getvalue()
        self._atomic_write(dest, data)
        return len(data)

    def get_blob(self, key):
        """Return a TopoDS_Shape, or None if the blob is missing / corrupt / short.
        Never raises: a bad blob is demoted to a miss and the useless file is removed
        so it cannot masquerade as present on the next find_checkpoint scan."""
        path = self._blob_path(key)
        try:
            shape = TopoDS_Shape()
            with open(path, "rb") as fh:
                data = fh.read()
            BinTools.Read_s(shape, io.BytesIO(data))
            if shape.IsNull():
                raise ValueError("null shape")
            return shape
        except FileNotFoundError:
            return None
        except Exception:
            # Truncated or garbage blob: reclaim it so the index scan sees a miss.
            try:
                os.unlink(path)
            except OSError:
                pass
            return None

    # --- meshes ---------------------------------------------------------------

    def put_mesh(self, key, payload):
        """Store a packed per-body mesh artifact (positions/indices/faceIds/edges)."""
        self._atomic_write(self._mesh_path(key), payload)
        return len(payload)

    def get_mesh(self, key):
        try:
            with open(self._mesh_path(key), "rb") as fh:
                return fh.read()
        except OSError:
            return None

    # --- checkpoints ----------------------------------------------------------

    def save_checkpoint(self, chain_key, feat_index, manifest, state_json,
                        replay_ms, pinned=False):
        """Upsert a checkpoint row keyed by chain_key. `manifest` is
        [{body_id, name, blob_key}, ...]; the referenced blobs must already be
        put_blob'd. bytes is the sum of the referenced blob sizes on disk. An existing
        pin is preserved (save must never silently unpin the open document)."""
        total = 0
        for entry in manifest:
            try:
                total += os.path.getsize(self._blob_path(entry["blob_key"]))
            except OSError:
                pass
        self.db.execute(
            """INSERT INTO checkpoints
                 (chain_key, feat_index, manifest, state, replay_ms, bytes,
                  last_access, pinned)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(chain_key) DO UPDATE SET
                 feat_index  = excluded.feat_index,
                 manifest    = excluded.manifest,
                 state       = excluded.state,
                 replay_ms   = excluded.replay_ms,
                 bytes       = excluded.bytes,
                 last_access = excluded.last_access,
                 pinned      = checkpoints.pinned | excluded.pinned""",
            (chain_key, feat_index, json.dumps(manifest), state_json,
             float(replay_ms), total, time.time(), 1 if pinned else 0),
        )
        self.db.commit()

    def find_checkpoint(self, chain_keys):
        """Given the FULL ordered list of per-feature chain keys (index i = key after
        feature i), return the DEEPEST restorable checkpoint as a dict, or None.

        "Restorable" = the row exists AND every blob its manifest references is on
        disk. One IN query fetches the candidates; we then walk from deepest to
        shallowest. A row whose blob vanished is unrestorable, so we drop it (soft
        state self-heals) and keep walking to a shallower checkpoint."""
        if not chain_keys:
            return None
        placeholders = ",".join("?" * len(chain_keys))
        rows = {
            r["chain_key"]: r
            for r in self.db.execute(
                f"SELECT * FROM checkpoints WHERE chain_key IN ({placeholders})",
                list(chain_keys),
            )
        }
        if not rows:
            return None
        for i in range(len(chain_keys) - 1, -1, -1):
            key = chain_keys[i]
            row = rows.get(key)
            if row is None:
                continue
            manifest = json.loads(row["manifest"])
            if all(os.path.exists(self._blob_path(e["blob_key"])) for e in manifest):
                self.db.execute(
                    "UPDATE checkpoints SET last_access = ? WHERE chain_key = ?",
                    (time.time(), key),
                )
                self.db.commit()
                return {
                    "chain_key": key,
                    "feat_index": row["feat_index"],
                    "manifest": manifest,
                    "state_json": row["state"],
                    "replay_ms": row["replay_ms"],
                    "pinned": bool(row["pinned"]),
                }
            self.db.execute("DELETE FROM checkpoints WHERE chain_key = ?", (key,))
            self.db.commit()
        return None

    def pin(self, chain_key, pinned):
        self.db.execute(
            "UPDATE checkpoints SET pinned = ? WHERE chain_key = ?",
            (1 if pinned else 0, chain_key),
        )
        self.db.commit()

    def purge(self, chain_keys):
        """Delete the given checkpoints AND the blobs their manifests reference
        (unless another surviving checkpoint still references a blob). This is
        the 'Compute All' path: put_blob dedups on key, so a hypothetically
        poisoned blob would survive a mere re-run — purging is what guarantees
        the next build re-serializes everything fresh."""
        if not chain_keys:
            return 0
        placeholders = ",".join("?" * len(chain_keys))
        doomed = list(self.db.execute(
            f"SELECT chain_key, manifest FROM checkpoints WHERE chain_key IN ({placeholders})",
            list(chain_keys),
        ))
        if not doomed:
            return 0
        doomed_keys = {r["chain_key"] for r in doomed}
        survivors_ref = set()
        for r in self.db.execute("SELECT chain_key, manifest FROM checkpoints"):
            if r["chain_key"] in doomed_keys:
                continue
            for e in json.loads(r["manifest"]):
                if e.get("blob_key"):
                    survivors_ref.add(e["blob_key"])
        self.db.execute(
            f"DELETE FROM checkpoints WHERE chain_key IN ({placeholders})",
            list(chain_keys),
        )
        self.db.commit()
        removed = 0
        for r in doomed:
            for e in json.loads(r["manifest"]):
                bk = e.get("blob_key")
                if bk and bk not in survivors_ref:
                    try:
                        os.unlink(self._blob_path(bk))
                        removed += 1
                    except OSError:
                        pass
        return removed

    # --- eviction -------------------------------------------------------------

    def evict(self, byte_cap=4 << 30):
        """Bring blob disk usage under `byte_cap`. Returns the number of checkpoints
        evicted.

        A blob referenced by ANY surviving checkpoint is retained (refcount over the
        manifests). Unreferenced (orphan) blobs are reclaimed first — they cost bytes
        but back nothing restorable. Then non-pinned checkpoints are evicted ordered
        by bytes / replay_ms descending (drop the big-but-cheap-to-replay ones first,
        §3.2), deleting a row BEFORE its now-unreferenced blobs so a crash mid-evict
        leaves at worst an orphan blob (reclaimable), never a row pointing at a hole.
        Pinned checkpoints are never evicted."""
        rows = list(self.db.execute("SELECT * FROM checkpoints"))
        refcount = {}
        parsed = {}
        for r in rows:
            manifest = json.loads(r["manifest"])
            parsed[r["chain_key"]] = manifest
            for e in manifest:
                refcount[e["blob_key"]] = refcount.get(e["blob_key"], 0) + 1

        total = 0
        for key, path in list(self._iter_blobs()):
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            if refcount.get(key, 0) <= 0:
                try:
                    os.unlink(path)
                except OSError:
                    pass
            else:
                total += size

        if total <= byte_cap:
            return 0

        candidates = [r for r in rows if not r["pinned"]]
        candidates.sort(
            key=lambda r: (r["bytes"] or 0) / max(r["replay_ms"] or 0.0, 1.0),
            reverse=True,
        )
        evicted = 0
        for r in candidates:
            if total <= byte_cap:
                break
            self.db.execute(
                "DELETE FROM checkpoints WHERE chain_key = ?", (r["chain_key"],)
            )
            self.db.commit()
            evicted += 1
            for e in parsed[r["chain_key"]]:
                bk = e["blob_key"]
                refcount[bk] -= 1
                if refcount[bk] <= 0:
                    path = self._blob_path(bk)
                    try:
                        total -= os.path.getsize(path)
                    except OSError:
                        pass
                    try:
                        os.unlink(path)
                    except OSError:
                        pass
        return evicted

    # --- stats ----------------------------------------------------------------

    def stats(self):
        rows = self.db.execute("SELECT COUNT(*) FROM checkpoints").fetchone()[0]
        blobs = 0
        total = 0
        for _key, path in self._iter_blobs():
            blobs += 1
            try:
                total += os.path.getsize(path)
            except OSError:
                pass
        return {"rows": rows, "blobs": blobs, "bytes": total}


_DEFAULT = None


def default_store():
    """Lazily-created process-wide singleton rooted at the default cache dir."""
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = Store()
    return _DEFAULT
