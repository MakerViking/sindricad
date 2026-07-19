"""Cold full-rebuild benchmark + regression gate.

Measures the median wall-clock ms of builder.rebuild() on a sha256-pinned document
across N FRESH processes (imports excluded, SINDRI_DISK_CACHE=0), and asserts frozen
output invariants so a "faster" build that silently drops work or corrupts geometry
FAILS the gate rather than looking like a win.

  # capture the baseline (writes tools/bench/rebuild_baseline.json)
  sidecar/.venv/bin/python sidecar/tools/bench_rebuild.py --doc src-tauri/5-cleanf.sindri --runs 5 --capture-baseline
  # measure + gate against the baseline
  sidecar/.venv/bin/python sidecar/tools/bench_rebuild.py --doc src-tauri/5-cleanf.sindri --runs 5

Prints one JSON line. Exit 0 = invariants hold and spread within budget; exit 1 = a
regression (invariant breach / excessive spread); exit 2 = a run crashed.

Invariants (a real rebuild must preserve them; each is an anti-gaming guard):
  bodies, faces         work not dropped
  errors + failing_ids  identical set of failing features (not fast-failed away)
  volume (0.01%)        geometry unchanged
  owners_sizes          per-body provenance owner-map not gutted (a named hotspot)
"""

import argparse
import hashlib
import json
import os
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR = os.path.dirname(HERE)
DEFAULT_BASELINE = os.path.join(HERE, "bench", "rebuild_baseline.json")


def doc_sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def single_run(doc_path, tessellate_flag=False):
    """One cold rebuild in this (fresh) process; time ONLY rebuild(), not imports.

    `tessellate_flag` additionally times tessellate() (with any body textures
    resolved) after the rebuild — rebuild() itself only validates/stores a
    texture spec, all the displacement cost lands in tessellate(), so a doc
    with texture features is invisible to this benchmark without it."""
    os.environ["SINDRI_DISK_CACHE"] = "0"
    sys.path.insert(0, SIDECAR)
    import builder

    with open(doc_path) as f:
        doc = json.load(f)
    t0 = time.perf_counter()
    part, errors, bodies = builder.rebuild(doc)
    ms = (time.perf_counter() - t0) * 1000.0
    try:
        volume = float(part.volume)
    except Exception:
        volume = 0.0
    out = {
        "ms": ms,
        "bodies": len(bodies),
        "faces": len(part.faces()) if part is not None else 0,
        "errors": len(errors),
        "failing_ids": sorted(str(e.get("feature_id")) for e in errors),
        "volume": volume,
        "owners_sizes": sorted(len(b.get("owners") or {}) for b in bodies),
    }
    if tessellate_flag:
        from tessellate import tessellate
        from texture import resolve_body_textures

        t1 = time.perf_counter()
        tris = 0
        for b in bodies:
            if b.get("shape") is None:
                continue
            textures = resolve_body_textures(b) if b.get("_textures") else None
            _pos, idx, _fids = tessellate(b["shape"], 0.1, textures=textures)
            tris += len(idx) // 3
        out["tessellate_ms"] = (time.perf_counter() - t1) * 1000.0
        out["tris"] = tris
    return out


_INV_KEYS = ("bodies", "faces", "errors", "failing_ids", "owners_sizes")


def _inv(m):
    return {k: m[k] for k in _INV_KEYS}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", required=True)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--single", action="store_true", help="internal: one run, print metrics")
    ap.add_argument("--tessellate", action="store_true",
                     help="also time tessellate() per body (needed to see texture-displacement cost)")
    ap.add_argument("--capture-baseline", action="store_true")
    ap.add_argument("--baseline", default=DEFAULT_BASELINE)
    ap.add_argument("--vol-tol", type=float, default=1e-4)   # 0.01%
    ap.add_argument("--max-spread", type=float, default=0.10)
    args = ap.parse_args()

    doc_path = os.path.abspath(args.doc)

    if args.single:
        print(json.dumps(single_run(doc_path, tessellate_flag=args.tessellate)))
        return 0

    runs = []
    for i in range(args.runs):
        cmd = [sys.executable, os.path.abspath(__file__), "--single", "--doc", doc_path]
        if args.tessellate:
            cmd.append("--tessellate")
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0 or not r.stdout.strip():
            print(f"run {i} crashed (exit {r.returncode}): {r.stderr[-400:]}", file=sys.stderr)
            return 2
        runs.append(json.loads(r.stdout.strip().splitlines()[-1]))

    ms = sorted(x["ms"] for x in runs)
    p50 = statistics.median(ms)
    spread = (ms[-1] - ms[0]) / p50 if p50 else 0.0
    inv0 = _inv(runs[0])
    runs_consistent = all(_inv(x) == inv0 for x in runs)
    volume = statistics.median(x["volume"] for x in runs)
    sha = doc_sha(doc_path)

    out = {
        "p50_ms": round(p50, 1), "min_ms": round(ms[0], 1), "max_ms": round(ms[-1], 1),
        "spread": round(spread, 4), "spread_ok": spread <= args.max_spread,
        "doc_sha": sha[:16], "bodies": inv0["bodies"], "faces": inv0["faces"],
        "errors": inv0["errors"], "volume": round(volume, 4),
        "owners_sizes": inv0["owners_sizes"], "runs_consistent": runs_consistent,
    }
    if args.tessellate:
        out["tessellate_p50_ms"] = round(statistics.median(x["tessellate_ms"] for x in runs), 1)
        out["tris"] = runs[0]["tris"]

    if args.capture_baseline:
        base = {"doc_sha": sha, "volume": volume, "p50_ms_at_capture": round(p50, 1), **inv0}
        os.makedirs(os.path.dirname(args.baseline), exist_ok=True)
        with open(args.baseline, "w") as f:
            json.dump(base, f, indent=1)
        out["baseline"] = "written"
        print(json.dumps(out))
        return 0

    with open(args.baseline) as f:
        base = json.load(f)
    checks = {
        "doc_sha": sha == base["doc_sha"],
        "volume": abs(volume - base["volume"]) <= args.vol_tol * max(abs(base["volume"]), 1e-9),
        **{k: inv0[k] == base[k] for k in _INV_KEYS},
    }
    out["invariants_ok"] = all(checks.values()) and runs_consistent and out["spread_ok"]
    out["failed_checks"] = [k for k, v in checks.items() if not v]
    print(json.dumps(out))
    return 0 if out["invariants_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
