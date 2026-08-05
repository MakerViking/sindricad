"""Generate the benchmark documents `e2e/browser_tree_perf.cjs` measures against.

Two documents per size, holding the SAME bodies: one plain (the flat Browser
list) and one carrying an assembly manifest (the nested, collapsed-by-default
tree). Only the manifest differs, so the difference the benchmark measures is
the tree and nothing else.

Run with the sidecar venv, from the repo root:
    sidecar/.venv/bin/python e2e/gen_perf_docs.py
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR = os.path.join(HERE, "..", "sidecar")
sys.path.insert(0, os.path.join(SIDECAR, "tools"))
sys.path.insert(0, SIDECAR)

SIZES = (100, 1000, 3000)
SOLIDS_PER_FEATURE = 6
OUT = os.environ.get("SC_PERF_DIR", "/tmp")


def main():
    from gen_manybodies import generate

    for n_bodies in SIZES:
        features = n_bodies // SOLIDS_PER_FEATURE
        doc = generate(features, SOLIDS_PER_FEATURE)
        flat = json.loads(json.dumps(doc))  # same bodies, no manifest

        # Each import feature's blob is a compound of SOLIDS_PER_FEATURE boxes, so
        # its top-level children are exactly those boxes (6 faces each) — which is
        # the shape a real assembly manifest binds to, row i -> child i.
        for i, f in enumerate(doc["features"]):
            f["nodes"] = [
                {"name": f"Subassembly {i}", "parent": None},
                {"name": f"Widget {i}", "parent": 0},
            ]
            f["parts"] = [{"node": 1, "faces": 6} for _ in range(SOLIDS_PER_FEATURE)]

        for kind, d in (("flat", flat), ("tree", doc)):
            path = os.path.join(OUT, f"perf_{kind}_{n_bodies}.sindri")
            with open(path, "w") as fh:
                json.dump(d, fh)
            print(f"{path}  ({features} features x {SOLIDS_PER_FEATURE} solids)")


if __name__ == "__main__":
    main()
