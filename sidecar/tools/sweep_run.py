"""Run every sweep case in its own subprocess and classify the outcome.

A segfault is a RESULT, not a crash of the sweep: each case gets a fresh process,
so exit 139 (SIGSEGV) and a timeout are recorded like any other outcome. That is
the whole point — the interesting failures are the ones that kill the process.

Usage:  python sweep_run.py <sidecar-dir> [timeout-seconds]
"""
import json
import subprocess
import sys
import os

SIDECAR = sys.argv[1] if len(sys.argv) > 1 else "."
TIMEOUT = float(sys.argv[2]) if len(sys.argv) > 2 else 90.0
PY = os.path.join(SIDECAR, ".venv/bin/python")
HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.join(HERE, "sweep_cases.py")

env = dict(os.environ, PYTHONPATH=SIDECAR)

listing = subprocess.run([PY, CASES, "--list"], capture_output=True, text=True, env=env)
names = [ln.split("\t")[0] for ln in listing.stdout.strip().splitlines() if ln.strip()]
notes = {ln.split("\t")[0]: ln.split("\t")[1] for ln in listing.stdout.strip().splitlines() if "\t" in ln}

rows = []
for name in names:
    try:
        p = subprocess.run([PY, CASES, name], capture_output=True, text=True,
                           timeout=TIMEOUT, env=env)
        rc = p.returncode
        out = (p.stdout or "").strip().splitlines()
        payload = None
        for ln in reversed(out):
            if ln.startswith("{"):
                payload = json.loads(ln)
                break
        if rc == -11 or rc == 139:
            verdict, detail = "SEGFAULT", "worker died (SIGSEGV)"
        elif payload is not None:
            if payload["errors"]:
                verdict, detail = "ERROR", "; ".join(payload["errors"])[:160]
            else:
                verdict, detail = "OK", "bodies=%d" % payload["bodies"]
        else:
            tail = (p.stderr or "").strip().splitlines()
            detail = tail[-1][:160] if tail else "no output"
            verdict = "RAISED" if rc else "UNKNOWN"
    except subprocess.TimeoutExpired:
        verdict, detail = "TIMEOUT", f">{TIMEOUT:.0f}s"
    rows.append({"case": name, "verdict": verdict, "detail": detail,
                 "note": notes.get(name, "")})
    print("%-34s %-9s %s" % (name, verdict, detail[:100]), flush=True)

out_path = os.environ.get("SWEEP_OUT", "/tmp/sweep-results.json")
with open(out_path, "w") as fh:
    json.dump(rows, fh, indent=1)
print("results:", out_path)

print()
counts = {}
for r in rows:
    counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
print("SUMMARY:", ", ".join("%s=%d" % kv for kv in sorted(counts.items())))
