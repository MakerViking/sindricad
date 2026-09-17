"""Time real worker rebuilds across edit/undo/redo with an isolated disk cache.

Run from the repository root:
    sidecar/.venv/bin/python sidecar/tools/bench_cache_history.py --runs 3

Uses a 100-feature plate with 49 through holes and edits hole 31. Measures the
shipping worker's geometry + mesh payload path and binary encoding separately;
excludes application startup, process transport, and browser rendering. Imports
and geometry checks are outside the timers. Every run gets a fresh temporary
cache; no user documents or application caches are changed.
"""

import argparse
import contextlib
import copy
import io
import json
import math
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def plate():
    features = [
        {"id": "outline", "type": "sketch", "plane": "XY", "entities": [
            {"type": "rectangle", "width": 100, "height": 100, "x": 0, "y": 0}]},
        {"id": "base", "type": "extrude", "sketch": "outline", "distance": 10,
         "operation": "new"},
    ]
    for i in range(49):
        features.extend([
            {"id": f"s{i}", "type": "sketch", "plane": "XY", "entities": [
                {"type": "circle", "radius": 2, "x": -36 + 12 * (i % 7),
                 "y": -36 + 12 * (i // 7)}]},
            {"id": f"h{i}", "type": "extrude", "sketch": f"s{i}", "distance": 12,
             "operation": "cut"},
        ])
    return {"parameters": {}, "features": features}


def run_once():
    import builder
    import geomstore
    import server

    original = plate()
    edited = copy.deepcopy(original)
    edited["features"][62]["entities"][0]["radius"] = 2.1
    rows = []
    with tempfile.TemporaryDirectory(prefix="sindri-history-bench-") as cache:
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"XDG_CACHE_HOME": cache, "SINDRI_DISK_CACHE": "1"}))
            stack.enter_context(patch.object(geomstore, "_DEFAULT", None))
            stack.callback(lambda: geomstore.default_store().db.close())
            stack.enter_context(patch.object(builder, "_CACHE", {
                "feature_sigs": [], "snaps": [], "global_sig": None,
            }))
            stack.enter_context(patch.object(server, "_MESH_CACHE", {}))
            known = {}
            for phase, doc in [("cold", original), ("unchanged", original),
                               ("edit", edited), ("undo", original), ("after_undo", original),
                               ("redo", edited), ("after_redo", edited)]:
                with contextlib.redirect_stdout(io.StringIO()) as logs:
                    start = time.perf_counter()
                    result = server._rebuild_job(doc, 0.1, known)
                    worker_ms = (time.perf_counter() - start) * 1000
                start = time.perf_counter()
                wire = server._encode_binary_reply(1, result)
                encode_ms = (time.perf_counter() - start) * 1000

                # These assertions also reject a quick no-op or a missing hole.
                assert not result.get("error"), result.get("error")
                assert not result.get("featureErrors"), result.get("featureErrors")
                assert len(result["bodies"]) == 1, "body lost or split"
                body = result["bodies"][0]
                ent = server._MESH_CACHE[body["id"]]
                shape = ent["shape"]
                want = 100000 - math.pi * 10 * (49 * 4 + (0.41 if doc is edited else 0))
                assert abs(shape.volume - want) < 1e-6, (phase, shape.volume, want)
                assert shape.is_valid, f"{phase}: invalid solid"
                assert len(shape.faces()) == 55, f"{phase}: face lost"
                assert len(ent["payload"]["faceOwners"]) == 55, "face provenance lost"
                known = {body["id"]: body["etag"]}
                resume_log = next(line for line in logs.getvalue().splitlines()
                                  if line.startswith("[rebuild-cached]"))
                rows.append({"phase": phase, "worker_ms": round(worker_ms, 3),
                             "encode_ms": round(encode_ms, 3), "wire_bytes": len(wire),
                             "resume": resume_log, "volume": round(shape.volume, 6)})
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()
    if args.runs < 1:
        ap.error("--runs must be positive")
    runs = [run_once() for _ in range(args.runs)]
    summaries = []
    for i, first in enumerate(runs[0]):
        values = [run[i]["worker_ms"] for run in runs]
        summaries.append({"phase": first["phase"], "worker_median_ms": statistics.median(values),
                          "worker_min_ms": min(values), "worker_max_ms": max(values),
                          "encode_median_ms": statistics.median(run[i]["encode_ms"] for run in runs)})
    print(json.dumps({"runs": runs, "summary": summaries, "geometry_checks": "passed"}, indent=2))


if __name__ == "__main__":
    main()
