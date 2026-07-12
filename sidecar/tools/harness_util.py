"""Shared plumbing for the sidecar eval harnesses (golden_corpus.py and
e2e_coverage.py).

Neutral mechanics ONLY: spawn a real server.py subprocess on an ephemeral port
with the disk cache off, read its `TOKEN` + `LISTENING` lines, drive ops over
the websocket, and compute mesh invariants (signed-tetra volume, bbox). Every
tolerance and every anti-gaming credit rule lives hardcoded in the tool that
owns it — never here — so an auditor can read each tool in isolation.

Run headless with sidecar/.venv/bin/python from the sidecar/ directory.
"""

import asyncio
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time

import websockets

# sidecar/ (parent of tools/) — server.py, builder.py etc. live here and the
# server must be spawned with this as its cwd.
SIDECAR_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The websocket must accept the same oversized frames the real app does: a
# rebuild ships the whole document, and an imported body embeds a multi-MB BREP.
_MAX_WS = 128 * 1024 * 1024

# Feature units whose coverage/clean-credit must come from a pre-vs-post DELTA,
# never from mere presence in a document: a no-op instance (scale factor=1,
# move by 0, a 1x1 patternRect) rebuilds cleanly and would otherwise inflate
# credit for a transform that did nothing. Single source of truth, imported by
# both harnesses so the two can't drift.
DELTA_UNITS = frozenset(
    {"patternRect", "patternCircular", "scale", "move", "removeBody", "mirror"}
)


def _free_port():
    """Pick an ephemeral loopback port. Tiny bind/close race before the server
    grabs it — acceptable for a local test harness, and never port 8765 because
    the OS won't hand out a port already bound by the user's live sidecar."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class SpawnedServer:
    """Context manager: launch `python server.py` as a child, wait until it
    prints `LISTENING <port>`, and expose its port/token/pid. Always kills the
    child on __exit__ (including on exception). Disk cache is forced OFF and the
    token env is cleared so the server MINTS and prints a fresh token."""

    def __init__(self, ready_timeout=90.0):
        self.ready_timeout = ready_timeout
        self.proc = None
        self.port = None
        self.token = None
        self.listening_line = None
        self._drainer = None

    def __enter__(self):
        self.port = _free_port()
        env = dict(os.environ)
        env["SINDRI_SIDECAR_PORT"] = str(self.port)
        env["SINDRI_DISK_CACHE"] = "0"  # deterministic: no persisted geometry
        env.pop("SINDRI_SIDECAR_TOKEN", None)  # force mint+print of a fresh token
        self.proc = subprocess.Popen(
            [sys.executable, "server.py"],
            cwd=SIDECAR_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )
        t0 = time.time()
        while time.time() - t0 < self.ready_timeout:
            line = self.proc.stdout.readline()
            if not line and self.proc.poll() is not None:
                rest = self.proc.stdout.read() or ""
                raise RuntimeError("server exited before LISTENING:\n" + rest)
            line = line.strip()
            if line.startswith("TOKEN "):
                self.token = line.split(None, 1)[1]
            elif line.startswith("LISTENING "):
                self.listening_line = line
                break
        else:
            self.close()
            raise RuntimeError("server never became ready")
        if not self.token:
            self.close()
            raise RuntimeError("server never printed a TOKEN line")
        # Keep draining stdout so the server's progress prints never fill the
        # pipe buffer and wedge the worker.
        self._drainer = threading.Thread(target=self._drain, daemon=True)
        self._drainer.start()
        return self

    def _drain(self):
        try:
            for _ in self.proc.stdout:
                pass
        except Exception:
            pass

    @property
    def url(self):
        return f"ws://127.0.0.1:{self.port}?token={self.token}"

    @property
    def pid(self):
        return self.proc.pid if self.proc else None

    def __exit__(self, *exc):
        self.close()

    def close(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


async def ws_call(ws, op, req_id, **kw):
    """Send one op and return the matching reply, skipping interim `status`
    (building-progress) frames — a long rebuild streams those before its `ok`
    reply."""
    await ws.send(json.dumps({"id": req_id, "op": op, **kw}))
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("id") != req_id:
            continue
        if "ok" not in msg:  # interim {"status":"building",...} frame
            continue
        return msg


def mesh_volume(positions, indices):
    """Enclosed volume of a closed triangle mesh via the signed-tetrahedron sum
    (each triangle forms a tetra with the origin; the signs cancel for interior
    facets). Returned as an absolute value so orientation doesn't flip the sign,
    and a body that is several disjoint solids sums to their total volume."""
    p = positions
    total = 0.0
    for k in range(0, len(indices), 3):
        a = indices[k] * 3
        b = indices[k + 1] * 3
        c = indices[k + 2] * 3
        ax, ay, az = p[a], p[a + 1], p[a + 2]
        bx, by, bz = p[b], p[b + 1], p[b + 2]
        cx, cy, cz = p[c], p[c + 1], p[c + 2]
        total += (
            ax * (by * cz - bz * cy)
            - ay * (bx * cz - bz * cx)
            + az * (bx * cy - by * cx)
        )
    return abs(total) / 6.0


def bbox_diagonal(bbox):
    """Length of a bbox's space diagonal — the reference length the golden bbox
    tolerance is a fraction of. `bbox` is {"min":[x,y,z],"max":[x,y,z]}."""
    lo, hi = bbox["min"], bbox["max"]
    return sum((hi[i] - lo[i]) ** 2 for i in range(3)) ** 0.5


def error_class(message):
    """Reduce a feature-error message to a stable ERROR CLASS: mask every number
    (coordinates, radii, volumes vary run to run and doc to doc) and collapse
    whitespace, so a sentinel keys on the KIND of failure, not on a specific
    value embedded in the text."""
    s = re.sub(r"-?\d+\.?\d*(?:[eE][-+]?\d+)?", "#", str(message))
    return re.sub(r"\s+", " ", s).strip()


def parse_feature_handler_keys():
    """The feature-type strings the builder actually dispatches — parsed from the
    `_FEATURE_HANDLERS = { ... }` literal in builder.py source AT RUNTIME, never
    a hardcoded list here, so this set tracks the real handler table and can't
    silently drift from it."""
    src = open(os.path.join(SIDECAR_DIR, "builder.py")).read()
    m = re.search(r"_FEATURE_HANDLERS\s*=\s*\{(.*?)\n\}", src, re.DOTALL)
    if not m:
        raise RuntimeError("could not locate _FEATURE_HANDLERS in builder.py")
    return set(re.findall(r'"([^"]+)"\s*:\s*_handle_', m.group(1)))


def parse_server_ops():
    """The op strings server.py dispatches — parsed from its `op == "..."`
    branches AT RUNTIME."""
    src = open(os.path.join(SIDECAR_DIR, "server.py")).read()
    return set(re.findall(r'op\s*==\s*"([^"]+)"', src))


def run(coro):
    """Run an async entrypoint to completion."""
    return asyncio.run(coro)
