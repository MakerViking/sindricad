#!/usr/bin/env python3
"""Compare two resolution dumps. Usage: diff_resolutions.py A.json B.json"""
import json
import sys

a = json.load(open(sys.argv[1]))
b = json.load(open(sys.argv[2]))

print(f"A {sys.argv[1]}: {a['total']:4d} resolutions @ {a['sha'][:12]}"
      f"{' DIRTY' if a['dirty'] else ''}")
print(f"B {sys.argv[2]}: {b['total']:4d} resolutions @ {b['sha'][:12]}"
      f"{' DIRTY' if b['dirty'] else ''}\n")

diffs = 0
for name in sorted(set(a["docs"]) | set(b["docs"])):
    ra = (a["docs"].get(name) or {}).get("resolutions", [])
    rb = (b["docs"].get(name) or {}).get("resolutions", [])
    if len(ra) != len(rb):
        print(f"{name}: RESOLUTION COUNT {len(ra)} -> {len(rb)}")
        diffs += 1
        continue
    moved = []
    for x, y in zip(ra, rb):
        if x.get("keys") != y.get("keys") or x.get("n") != y.get("n"):
            moved.append((x, y))
    if moved:
        diffs += len(moved)
        print(f"{name}: {len(moved)}/{len(ra)} resolutions MOVED")
        for x, y in moved[:4]:
            print(f"   [{x['i']}] {x['fn']} by:{x['by']}  n {x['n']} -> {y['n']}")
            print(f"        was {x['keys'][:2]}")
            print(f"        now {y['keys'][:2]}")
    else:
        print(f"{name}: {len(ra):3d} resolutions identical")

print()
if diffs:
    print(f"DIFFERENT — {diffs} resolution(s) changed")
    sys.exit(1)
print("IDENTICAL — every selector resolved to the same entity")
