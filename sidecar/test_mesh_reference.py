"""Mesh reference bodies: a mesh past MAX_IMPORT_TRIANGLES imports as a scan
that never touches OCCT, instead of being refused. Run:
    cd sidecar && .venv/bin/python test_mesh_reference.py

Every test enters where the user does (import_geometry, a rebuild of the
document, the rebuild job's payload, the export job) and observes the EFFECT:
triangle counts, positions, which body a tool acted on. The scan is generated
here (~8 MB, 160,000 triangles) so the suite needs no fixture and runs in CI.
"""

import os
import shutil
import struct
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("SINDRI_DISK_CACHE", "0")

FAILED = []
N_SCAN = 160_000  # just past MAX_IMPORT_TRIANGLES (150,000)


def check(label, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + label + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        FAILED.append(label)


def _grid_soup(n_tri, z=0.0):
    """n_tri triangles tiling a flat sheet 100 mm square, as an (n,3,3) soup.
    Shared corners, so the weld has real work to do."""
    k = int(np.ceil(np.sqrt(n_tri / 2)))
    xs = np.linspace(0, 100, k + 1, dtype=np.float32)
    tris = []
    for i in range(k):
        for j in range(k):
            a = (xs[i], xs[j], z)
            b = (xs[i + 1], xs[j], z)
            c = (xs[i + 1], xs[j + 1], z)
            d = (xs[i], xs[j + 1], z)
            tris.append((a, b, c))
            tris.append((a, c, d))
            if len(tris) >= n_tri:
                return np.array(tris, dtype=np.float32)
    return np.array(tris, dtype=np.float32)


def _write_stl(path, soup):
    with open(path, "wb") as fh:
        fh.write(b"\0" * 80 + struct.pack("<I", len(soup)))
        rec = np.zeros(len(soup), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
        rec["v"] = soup
        fh.write(rec.tobytes())


class Cold:
    """Empty, isolated blob store and cache, so nothing passes on a warm machine."""

    def __enter__(self):
        self.dir = tempfile.mkdtemp(prefix="meshref_")
        self._env = {k: os.environ.get(k) for k in ("SINDRI_BLOB_DIR", "XDG_CACHE_HOME")}
        os.environ["SINDRI_BLOB_DIR"] = os.path.join(self.dir, "blobs")
        os.environ["XDG_CACHE_HOME"] = os.path.join(self.dir, "cache")
        import blobstore
        import meshblob

        blobstore._default = None
        meshblob._cache.clear()
        return self

    def __exit__(self, *a):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.dir, ignore_errors=True)


def _scan_feature(res, fid="scan"):
    """The feature files.ts builds from an import reply."""
    return {"id": fid, "type": "import", "format": "stl", "name": res["name"],
            "geom": res["geom"], "solid": res["solid"], "meshOnly": True}


def main():
    import builder
    import meshblob
    import server

    with Cold() as c:
        scan = os.path.join(c.dir, "scan.stl")
        _write_stl(scan, _grid_soup(N_SCAN))

        # 1. Past the B-rep cap: a scan, not a refusal.
        res = builder.import_geometry(scan, "stl")
        check("a mesh past the B-rep cap imports as a scan", res.get("meshOnly") is True, res)
        check("the reply counts every triangle", res.get("triangles") == N_SCAN, res.get("triangles"))
        check("the reply says why it is reference geometry",
              (res.get("reference") or {}).get("why") == "tooManyTriangles", res.get("reference"))
        verts, idx = meshblob.load(res["geom"])
        check("the stored mesh round-trips its triangles", len(idx) == N_SCAN, len(idx))
        check("shared corners were welded", len(verts) < N_SCAN * 3, len(verts))

        # 1b. OBJ and 3MF take the same path (3MF written by our own exporter).
        import mesh_writers

        obj = os.path.join(c.dir, "scan.obj")
        with open(obj, "w") as fh:
            fh.write("".join(f"v {a} {b} {z}\n" for a, b, z in verts))
            fh.write("".join(f"f {a + 1} {b + 1} {d + 1}\n" for a, b, d in idx))
        r_obj = builder.import_geometry(obj, "obj")
        check("an OBJ past the cap imports as a scan",
              r_obj.get("meshOnly") and r_obj.get("triangles") == N_SCAN, r_obj.get("triangles"))
        tmf = os.path.join(c.dir, "scan.3mf")
        mesh_writers.write_plain_3mf(verts.astype(float).reshape(-1),
                                     idx.astype(np.int64).reshape(-1), tmf)
        r_3mf = builder.import_geometry(tmf, "3mf")
        check("a 3MF past the cap imports as a scan",
              r_3mf.get("meshOnly") and r_3mf.get("triangles") == N_SCAN, r_3mf.get("triangles"))

        # 2. Under the cap nothing changes: the B-rep path, no meshOnly.
        small = os.path.join(c.dir, "small.stl")
        _write_stl(small, _grid_soup(2, z=5.0))
        res_small = builder.import_geometry(small, "stl")
        check("a small mesh still takes the B-rep path", not res_small.get("meshOnly"), res_small)

        # 3. Past the scan cap: refused, and the words say so.
        old = builder.MAX_MESH_REFERENCE_TRIANGLES
        builder.MAX_MESH_REFERENCE_TRIANGLES = 155_000
        try:
            builder.import_geometry(scan, "stl")
            check("a mesh past the scan cap is refused", False)
        except ValueError as e:
            check("a mesh past the scan cap is refused in words",
                  "reference scan" in str(e), str(e))
        finally:
            builder.MAX_MESH_REFERENCE_TRIANGLES = old

        # 4. A document with a box, then the scan, then a fillet with no body
        #    named: the fillet must land on the BOX, not the scan imported last.
        doc = {"parameters": {}, "features": [
            {"id": "b1", "type": "box", "length": 20, "width": 20, "height": 20},
            _scan_feature(res),
            {"id": "mv", "type": "move", "dx": 10, "dy": 0, "dz": 0,
             "rx": 0, "ry": 0, "rz": 0, "bodies": ["body2"]},
            {"id": "fl", "type": "fillet", "radius": 1,
             "edges": {"kind": "edge", "by": "axis", "axis": "Z"}},
        ]}
        _p, errors, bodies = builder.rebuild(doc)
        check("the document with a scan builds cleanly", not errors, errors)
        by = {b["id"]: b for b in bodies}
        check("the scan is a mesh body with no shape",
              by["body2"].get("mesh") and by["body2"]["shape"] is None)
        check("the fillet acted on the box, not the scan",
              len(by["body1"]["shape"].faces()) > 6, len(by["body1"]["shape"].faces()))
        check("move composed a transform onto the scan",
              by["body2"]["mesh"]["xf"][0][3] == 10, by["body2"]["mesh"]["xf"])

        # 5. With ONLY a scan, a body-modifying tool refuses in words.
        only = {"parameters": {}, "features": [
            _scan_feature(res),
            {"id": "fl", "type": "fillet", "radius": 1,
             "edges": {"kind": "edge", "by": "axis", "axis": "Z"}},
        ]}
        _p, errors, _b = builder.rebuild(only)
        msg = " ".join(str(e.get("message", e)) for e in errors)
        check("a fillet on a scan-only document is refused in words",
              "reference geometry" in msg, msg)

        # 6. The rebuild job's payload: the scan's triangles, moved, one face id,
        #    and an `unchanged` stub on the next rebuild.
        out = server._rebuild_job(doc, 0.1)
        scan_body = next(b for b in out["bodies"] if b["id"] == "body2")
        check("the payload flags the scan", scan_body.get("meshOnly") is True, list(scan_body))
        check("the payload carries every triangle", len(scan_body["indices"]) == N_SCAN * 3)
        check("the payload has one face id", scan_body["faceCount"] == 1)
        check("the payload is moved by the transform",
              abs(scan_body["bbox"]["min"][0] - 10.0) < 1e-4, scan_body["bbox"])
        again = server._rebuild_job(doc, 0.1, known={"body2": scan_body["etag"]})
        stub = next(b for b in again["bodies"] if b["id"] == "body2")
        check("an unchanged scan is sent as a stub, not 160k triangles again",
              stub.get("unchanged") is True and stub.get("meshOnly") is True, list(stub))

        # 7. Disk resume keeps the scan AND its transform. Without the manifest
        #    carrying `mesh`, it came back as an empty shapeless body.
        import geomstore

        tmp = tempfile.mkdtemp(prefix="meshref_ckpt_")
        orig_store = builder._disk_store
        try:
            st = geomstore.Store(root=tmp)
            builder._disk_store = lambda: st
            keys = builder._chain_keys_scoped(doc, builder._feature_sigs(doc["features"]))
            builder.rebuild(doc, persist={"store": st, "keys": keys, "mod": {},
                                          "acc_ms": 0.0, "budget_ms": 0.0})
            hit = builder._restore_from_disk(st, keys)
            check("a checkpoint was written", hit is not None)
            if hit is not None:
                rb = {b["id"]: b for b in hit[1]["bodies"]}
                check("a disk resume keeps the scan and its transform",
                      rb["body2"].get("mesh") == by["body2"]["mesh"], rb["body2"])
        finally:
            builder._disk_store = orig_store
            builder._CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}
            shutil.rmtree(tmp, ignore_errors=True)

        # 8. Export: STL carries box + scan; STEP leaves the scan out LOUDLY.
        stl_out = os.path.join(c.dir, "out.stl")
        r = server._export_job(doc, "stl", stl_out)
        check("STL export succeeds", "error" not in r, r)
        with open(stl_out, "rb") as fh:
            fh.seek(80)
            n_out = struct.unpack("<I", fh.read(4))[0]
        check("STL export carries the scan's triangles", n_out > N_SCAN, n_out)
        r = server._export_job(doc, "step", os.path.join(c.dir, "out.step"))
        check("STEP export warns that the scan was left out",
              any("reference scans" in w["message"] for w in r.get("warnings", [])), r)
        scan_only = {"parameters": {}, "features": [_scan_feature(res)]}
        r = server._export_job(scan_only, "step", os.path.join(c.dir, "scan.step"))
        check("STEP export of only a scan is refused in words",
              "cannot be exported as STEP" in (r.get("error") or {}).get("message", ""), r)

        # 9. A scan blob handed to the B-rep reader is named, not called corrupt.
        import blobstore

        data = blobstore.default_store().get_bytes(res["geom"])
        try:
            builder._blob_to_shape(data)
            check("the B-rep reader refuses a scan blob", False)
        except ValueError as e:
            check("the B-rep reader names a scan blob", "reference scan" in str(e), str(e))

        # 10. Every tool that can be POINTED at a body: aimed at the scan it
        #     refuses in words; left implicit it works on the box and leaves the
        #     scan alone. Before, these died on AttributeError inside OCCT.
        top = {"kind": "face", "by": "nearest", "point": [0, 0, 10]}
        base = [{"id": "b1", "type": "box", "length": 20, "width": 20, "height": 20},
                _scan_feature(res)]
        aimed = {
            "combine target": {"type": "combine", "operation": "cut", "target": "body2", "tools": ["body1"]},
            "combine tool": {"type": "combine", "operation": "join", "target": "body1", "tools": ["body2"]},
            "split": {"type": "split", "plane": "XY", "keep": "both", "body": "body2"},
            "thicken": {"type": "thicken", "thickness": 1, "body": "body2"},
            "offset face": {"type": "offsetFace", "faces": top, "distance": 1, "body": "body2"},
            "delete face": {"type": "deleteFace", "face": top, "body": "body2"},
            "press/pull": {"type": "press-pull", "face": top, "distance": 3, "operation": "join", "body": "body2"},
        }
        for name, feat in aimed.items():
            _p, errs, bodies = builder.rebuild({"parameters": {}, "features": base + [{"id": "x", **feat}]})
            msg = " ".join(str(e.get("message", e)) for e in errs)
            check(f"{name} aimed at the scan refuses in words",
                  "imported scan" in msg and any(b.get("mesh") for b in bodies), msg)
        implicit = {
            "default combine": {"type": "combine", "operation": "join"},
            "split all visible": {"type": "split", "plane": "XY", "keep": "both", "bodies": ["body1", "body2"]},
        }
        for name, feat in implicit.items():
            _p, errs, bodies = builder.rebuild({"parameters": {}, "features": base + [{"id": "x", **feat}]})
            check(f"{name} skips the scan and succeeds",
                  not errs and any(b.get("mesh") for b in bodies), errs)

    print()
    if FAILED:
        print(f"FAILED {len(FAILED)}:")
        for f in FAILED:
            print("  -", f)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
