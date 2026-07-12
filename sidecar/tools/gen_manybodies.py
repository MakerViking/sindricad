"""Synthetic many-body benchmark documents for large-assembly scale work.

Emits a .sindri whose features are `import{format:"brep"}` bodies — N features,
each carrying a compound of K small boxes — mimicking a large imported assembly
(the shape of document that exposed the sidecar's scale limits: stall-watchdog
kills on honest work, monolithic replies in the 100+ MB range).

Run with the sidecar venv:
    .venv/bin/python tools/gen_manybodies.py --features 500 --solids 6 out.sindri

The geometry is trivial on purpose: scale problems here are about COUNT
(features × bodies × payload), not surface complexity.
"""
from __future__ import annotations
import argparse, base64, io, json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _grid_import_brep(feature_idx: int, solids: int, size: float, gap: float) -> str:
    """One import feature's payload: a compound of `solids` boxes in a row,
    the row placed on a grid by feature index. Returns base64 BREP."""
    from build123d import Box, Compound, Pos, export_brep

    row = feature_idx % 32
    col = feature_idx // 32
    boxes = []
    for s in range(solids):
        boxes.append(
            Pos(col * (solids + 1) * (size + gap) + s * (size + gap),
                row * (size + gap), 0.0)
            * Box(size, size, size)
        )
    comp = Compound(children=boxes)
    buf = io.BytesIO()
    export_brep(comp, buf)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def generate(n_features: int, solids_per: int, size: float = 5.0, gap: float = 2.0) -> dict:
    features = []
    for i in range(n_features):
        features.append({
            "id": f"import_{i}",
            "type": "import",
            "format": "brep",
            "name": f"Part {i}",
            "brep": _grid_import_brep(i, solids_per, size, gap),
            "solid": True,
        })
    return {"version": 1, "parameters": {}, "features": features}


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate a many-body benchmark .sindri")
    ap.add_argument("output", help="output .sindri path")
    ap.add_argument("--features", type=int, default=500, help="import features (default 500)")
    ap.add_argument("--solids", type=int, default=6,
                    help="solids per feature (default 6 — bodies after explode = features × solids)")
    args = ap.parse_args()
    doc = generate(args.features, args.solids)
    with open(args.output, "w") as f:
        json.dump(doc, f)
    print(f"{args.output}: {args.features} features × {args.solids} solids "
          f"= {args.features * args.solids} bodies, "
          f"{os.path.getsize(args.output) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
