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
import ast
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


def _function_owners(tree):
    """node -> the name of the innermost function containing it ("<module>" for
    top level). An unresolvable request read is reported by function name, which
    is what the allow_dynamic exemptions key on: a line number moves with the
    next edit above it, so it rides along as a convenience only."""
    owners = {}

    def descend(node, fn):
        for child in ast.iter_child_nodes(node):
            name = child.name if isinstance(
                child, (ast.FunctionDef, ast.AsyncFunctionDef)) else fn
            owners[child] = name
            descend(child, name)

    descend(tree, "<module>")
    return owners


def _literal_key_binder(node, name, parents):
    """The strings `name` can hold at `node`, or None if that isn't knowable.

    Resolution walks OUTWARD from the read to the nearest enclosing `for k in
    ("a", "b")` or comprehension generator over a literal sequence of strings.
    It is deliberately not a module-wide name map: server.py binds `k` to
    ("message", "feature_id", "code") in an unrelated error comprehension, and a
    map keyed on the bare name attributed those three to `req[k]` in _dispatch —
    a scrape that INVENTS request fields is its own kind of dishonest."""
    cur = node
    while cur is not None:
        if isinstance(cur, (ast.For, ast.AsyncFor)):
            generators = [(cur.target, cur.iter)]
        elif isinstance(cur, (ast.ListComp, ast.SetComp, ast.DictComp,
                              ast.GeneratorExp)):
            generators = [(g.target, g.iter) for g in cur.generators]
        else:
            generators = []
        for target, iterable in generators:
            if not isinstance(target, ast.Name) or target.id != name:
                continue
            if not isinstance(iterable, (ast.Tuple, ast.List, ast.Set)):
                return None  # bound here, but to something we can't read
            values = [e.value for e in iterable.elts
                      if isinstance(e, ast.Constant) and isinstance(e.value, str)]
            return set(values) if len(values) == len(iterable.elts) and values else None
        cur = parents.get(cur)
    return None


def parse_request_fields(allow_dynamic=None):
    """Every REQUEST FIELD server.py reads — scraped from its `req[...]` and
    `req.get(...)` sites AT RUNTIME, so a field a new op starts reading is
    malformable by test_malformed_ops.py the day it lands.

    PARSED, not regexed, because the regex version had a blind spot a reviewer
    measured a live defect through: it matched only literal `req["x"]` forms, so
    the four fields _dispatch reads through `{k: req[k] for k in (...)}` were
    invisible THERE. Two of them — `baseRevision` and `ops` — were read nowhere
    else either, so the derived matrix had never once sent them anything, and
    `ops` is what the app sends on every incremental rebuild. (`document` and
    `revision` were picked up from literal reads elsewhere; measured, not
    assumed.) A ratchet with a blind spot is worse than no ratchet, because it
    reports a matrix that looks complete.

    So a variable key is RESOLVED when the enclosing loop or comprehension binds
    it to a literal sequence, and anything still unresolvable RAISES rather than
    being silently dropped. `allow_dynamic` is {function name: reason} for reads
    that genuinely cannot be resolved this way; each one has to be argued for in
    writing at the call site, and the caller is expected to cover those fields
    another way.

    Returns the raw scrape including the transport envelope (`id`, `op`,
    `binary`, `chunked`); the caller decides what to exclude and must say why."""
    src = open(os.path.join(SIDECAR_DIR, "server.py")).read()
    tree = ast.parse(src)
    owners = _function_owners(tree)
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    fields, unresolved = set(), []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Subscript)
                and isinstance(node.value, ast.Name) and node.value.id == "req"):
            key = node.slice
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "req" and node.args):
            key = node.args[0]
        else:
            continue
        resolved = None
        if isinstance(key, ast.Constant) and isinstance(key.value, str):
            resolved = {key.value}
        elif isinstance(key, ast.Name):
            resolved = _literal_key_binder(node, key.id, parents)
        if resolved is None:
            unresolved.append((owners.get(node, "<module>"),
                               getattr(node, "lineno", 0), ast.unparse(node)))
        else:
            fields |= resolved
    allowed = dict(allow_dynamic or {})
    unexplained = [u for u in unresolved if u[0] not in allowed]
    if unexplained:
        raise RuntimeError(
            "server.py reads a request field through a key this scrape cannot "
            "resolve, so the derived malformed matrix would be silently blind "
            "to it. Resolve it, or name the function in allow_dynamic with a "
            "reason and cover those fields another way: "
            + "; ".join(f"{fn}() line {ln}: {src_}" for fn, ln, src_ in unexplained))
    return fields


def parse_required_fields():
    """server.py's `_REQUIRED_FIELDS` table, read from its SOURCE at runtime.

    Returns {op: ((field, (type-name, ...), required), ...)}. Parsed with `ast`
    rather than imported, because importing server.py pulls in OCCT and starts
    a worker pool; the types come back as NAMES ("dict", "str") for the same
    reason. A test can then derive its malformed payloads from the very table
    the production guard validates against, instead of hand-copying field names
    that drift the moment an op grows one."""
    src = open(os.path.join(SIDECAR_DIR, "server.py")).read()
    for node in ast.walk(ast.parse(src)):
        if not isinstance(node, ast.Assign):
            continue
        if not any(getattr(t, "id", None) == "_REQUIRED_FIELDS" for t in node.targets):
            continue
        table = {}
        for key, val in zip(node.value.keys, node.value.values):
            rows = []
            for row in val.elts:
                field, types, required = row.elts
                names = (
                    tuple(e.id for e in types.elts)
                    if isinstance(types, ast.Tuple)
                    else (types.id,)
                )
                rows.append((field.value, names, required.value))
            table[key.value] = tuple(rows)
        return table
    # An ABSENT table is a state worth measuring, not a crash: that is exactly
    # what a server predating the guard looks like, and a harness that cannot
    # even import against it cannot show a test going red on unpatched code.
    # Callers that need the table assert on the result — loudly, where the
    # missing rows actually matter.
    return {}


def run(coro):
    """Run an async entrypoint to completion."""
    return asyncio.run(coro)
