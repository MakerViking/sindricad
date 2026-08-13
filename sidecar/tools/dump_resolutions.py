#!/usr/bin/env python3
"""Dump every selector resolution a rebuild performs, as a comparable artifact.

WHY THIS EXISTS: proving "no saved document resolves differently" needs an
instrument that can see a resolution CHANGE ITS MIND SILENTLY. The obvious
instruments cannot:

  - `diagnostics` arrays: _push_diag's head gate records NOTHING for a
    confident resolution, so a confident-winner -> confident-twin swap is
    invisible.
  - volume / area / face counts: a fillet moving to a mirror twin preserves all
    three.

So this records, for EVERY call to geom_select._resolve_one, the canonical key
of the entity actually returned plus that entity's cost — the two values that
change if and only if resolution moved.

It monkeypatches from the OUTSIDE and is never imported by shipped code, so the
instrument itself cannot perturb what it measures. Run it with cwd set to the
sidecar directory of the tree under test; `import builder` then picks up that
tree's code while the interpreter's site-packages stay shared:

    git worktree add --detach /tmp/base <pre-change-sha>
    cd /tmp/base/sidecar && $VENV/bin/python $REPO/sidecar/tools/dump_resolutions.py base.json
    cd $REPO/sidecar   && ./.venv/bin/python tools/dump_resolutions.py now.json
    python3 tools/diff_resolutions.py base.json now.json

The artifact asserts the sha it was produced from, so two files cannot be
compared without knowing what they are.

TWO THINGS MEASURED HERE, both counter-intuitive, both worth knowing before you
trust a clean run:

  1. An instrument on `_resolve_one` reads ZERO across nine real saved documents
     while their rebuilds genuinely run — blends resolve through
     builder._rematch_edge, which calls _edge_cost directly. Hence the wrapping
     of the PUBLIC entry points instead.
  2. Those nine documents contain NO by:"match" selectors at all: 137 of 148
     resolutions are by:"nearest", the rest list forms. So this harness covers
     the nearest path and says nothing about the match scorer — for that, the
     oracle is tools/eval_selector_survival.py. A tuning-weight perturbation
     will NOT move these numbers, because _nearest_one ranks on raw distance.

ALWAYS RUN A CONTROL. An "identical" verdict means nothing unless the diff is
shown to fire: perturb the pinned worktree (e.g. make _nearest_one return the
runner-up) and confirm the counts and keys move.
"""
import json
import os
import subprocess
import sys
import zipfile

os.environ["SINDRI_DISK_CACHE"] = "0"  # a cached rebuild performs NO resolutions
# sys.path[0] is THIS script's directory, not the tree under test — without this
# the instrument would measure whichever sidecar happened to be importable.
sys.path.insert(0, os.getcwd())

DOCS = [
    "~/Koding/projects/SindriCAD/src-tauri/Basket.sindri",
    "~/Koding/projects/SindriCAD/src-tauri/test3.sindri",
    "~/Koding/projects/SindriCAD/src-tauri/test5.sindri",
    "~/Koding/projects/SindriCAD/src-tauri/test6.sindri",
    "~/Koding/projects/SindriCAD/src-tauri/test7.sindri",
    "~/Koding/projects/SindriCAD/src-tauri/dess1.sindri",
    "~/Koding/projects/SindriCAD/src-tauri/1.sindri",
    "~/Koding/projects/SindriCAD/src-tauri/3.sindri",
    "~/Koding/projects/SindriCAD/src-tauri/5-cleanf.sindri",
]


def _load(path):
    p = os.path.expanduser(path)
    if not os.path.exists(p):
        return None
    if zipfile.is_zipfile(p):
        with zipfile.ZipFile(p) as z:
            return json.loads(z.read("document.json"))
    with open(p) as f:
        return json.load(f)


def _round(v):
    return round(v, 6) if isinstance(v, float) else v


def main():
    out_path = sys.argv[1]
    import geom_select as gs

    records = []

    def canon(kind, ents):
        key_fn = gs._canonical_key_face if kind == "face" else gs._canonical_key_edge
        out = []
        for e in ents or ():
            try:
                out.append([_round(v) for v in key_fn(e)])
            except Exception as ex:
                out.append(f"<{type(ex).__name__}>")
        return out

    # Wrap the PUBLIC entry points, not _resolve_one. Measured: across nine real
    # saved documents _resolve_one is called ZERO times — blends resolve through
    # builder._rematch_edge (which calls _edge_cost directly) and faces through
    # by:"normal"/region paths. An instrument on _resolve_one reports nine clean
    # documents while observing nothing at all.
    def wrap(name, kind):
        original = getattr(gs, name)

        def instrumented(*a, **kw):
            got = original(*a, **kw)
            sel = a[1] if len(a) > 1 else kw.get("sel")
            by = sel.get("by") if isinstance(sel, dict) else f"<{type(sel).__name__}>"
            records.append({"i": len(records), "fn": name, "by": by,
                            "n": len(got) if got is not None else None,
                            "keys": canon(kind, got)})
            return got

        instrumented.__name__ = name
        setattr(gs, name, instrumented)

    wrap("resolve_faces", "face")
    wrap("resolve_edges", "edge")

    import builder
    from builder import rebuild

    # _rematch_edge bypasses the resolver entirely and IS a resolution decision:
    # it picks which edge a stored blend reference now means.
    _orig_rematch = builder._rematch_edge

    def rematch(*a, **kw):
        got = _orig_rematch(*a, **kw)
        records.append({"i": len(records), "fn": "_rematch_edge",
                        "by": "match", "n": 0 if got is None else 1,
                        "keys": canon("edge", [got] if got is not None else [])})
        return got

    builder._rematch_edge = rematch

    sha = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True,
                         text=True).stdout.strip()
    dirty = bool(subprocess.run(["git", "status", "--porcelain"],
                                capture_output=True, text=True).stdout.strip())

    per_doc = {}
    for path in DOCS:
        doc = _load(path)
        name = os.path.basename(path)
        if doc is None:
            per_doc[name] = {"skipped": "not found"}
            continue
        start = len(records)
        try:
            _part, errs, bodies = rebuild(doc)
            per_doc[name] = {
                "resolutions": records[start:],
                "featureErrors": len(errs or []),
                "bodies": len(bodies or []),
            }
        except Exception as ex:
            per_doc[name] = {"resolutions": records[start:],
                             "raised": f"{type(ex).__name__}: {ex}"}
        print(f"{name:22} {len(records) - start:5d} resolutions", flush=True)

    with open(out_path, "w") as f:
        json.dump({"sha": sha, "dirty": dirty, "cwd": os.getcwd(),
                   "total": len(records), "docs": per_doc}, f, indent=1, sort_keys=True)
    print(f"\nwrote {out_path}: {len(records)} resolutions from {sha[:12]}"
          f"{' (DIRTY TREE)' if dirty else ''}")


main()
