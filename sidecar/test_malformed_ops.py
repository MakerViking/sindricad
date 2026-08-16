"""COVERAGE RATCHET: every wire op must refuse a malformed payload legibly.

Run: uv run python test_malformed_ops.py

Not a set of hand-picked cases. It enumerates the ops server.py ACTUALLY
dispatches — harness_util.parse_server_ops() regex-scrapes its `op == "..."`
branches at runtime, the same trick ribbonActions.test.ts uses on main.ts — and
sends four malformed shapes to each against a real spawned server. An op added
later is covered the day it lands, and an op removed cannot leave a stale row
behind.

WHY THIS SHAPE. The obvious property, "a malformed payload must not raise, hang
or kill the worker", ALREADY HELD before this file existed: measured 56/56
answered with the server still alive after every one, because _serialized wraps
_dispatch in a catch-all that sends `_err(req_id, str(ex))`. Asserting only that
would be a ratchet that cannot fail, which is worse than no ratchet — so it is
kept below as R1, a floor, and stated as a floor rather than dressed up as a
discovery.

The property with TEETH is that a refusal be machine-readable. That one was
broken: 33 of those 56 came back `ok:false` with NO `code` and a raw CPython
internal as the message — "'int' object has no attribute 'get'", "'document'",
"stat: path should be string, bytes, os.PathLike or integer". errors.BAD_REQUEST
exists for exactly this ("malformed/oversized input, refused up front") and only
2 of the 14 ops used it. Anything that has to branch on a failure — the agent
control surface, a retry, a test — could not tell "you sent nonsense" from "the
kernel fell over".

Chasing that found a real defect, now R4: a document whose `features` was not a
list was accepted into the RETAINED delta state, so the next rebuild sent with
no document at all (the normal incremental path) replayed the poison and failed
the same way.
"""

import asyncio
import json
import os
import sys

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))

import websockets  # noqa: E402

import errors  # noqa: E402
from harness_util import SpawnedServer, parse_server_ops, ws_call, _MAX_WS  # noqa: E402

PASS = "  ok"

# Ops that take no payload at all, so "must refuse at least one malformed shape"
# cannot apply to them — there is nothing to malform. Named, with a reason each,
# rather than silently skipped: an exemption has to be argued for in writing or
# the set quietly grows until R3 means nothing. Mirrors EXCLUDED_OPS in
# tools/e2e_coverage.py.
PAYLOAD_FREE = {
    "ping": "liveness probe — answers pong regardless of what rides along",
    "listFonts": "reads the system font list; takes no request fields",
    "cancel": "stops whatever is running; 'nothing was running' is a valid true",
}

# Raw CPython leaking through a refusal. Each of these was OBSERVED on the wire
# before the _malformed guard landed. The list is a heuristic and will need
# extending when a new leak shape shows up — that is fine, it fails loud. Do NOT
# delete a pattern to make a build green; code the raise site instead.
LEAKS = (
    "object has no attribute",
    "object is not subscriptable",
    "object is not iterable",
    "NoneType",
    "os.PathLike",
    "Traceback",
)

# Four payloads sent to EVERY op. They are deliberately generic — the same dict
# goes to all fourteen — because a per-op fixture is a hand-picked case again,
# and the point is that no op may be surprised by a field it did not want.
SHAPES = {
    # nothing at all: every required field missing
    "empty": {},
    # every field present, every one the wrong type
    "wrongtype": {
        "document": 7, "format": 7, "path": 7, "plane": 7, "entity": 7,
        "items": 7, "sources": 7, "bodies": 7, "settings": 7,
    },
    # present-but-null, which `in req` says yes to and everything else says no
    "nulls": {
        "document": None, "format": None, "path": None, "plane": None,
        "entity": None, "items": None, "sources": None, "bodies": None,
    },
    # right OUTER type, wrong inside — the shape that found the delta-state
    # poisoning. Do not drop it for looking redundant with "wrongtype": a guard
    # that only checks the top level passes that one and still breaks here.
    "deepjunk": {
        "document": {"features": "not-a-list", "parameters": 7},
        "format": "\x00\x01",
        "path": "",
        "plane": {"origin": "x"},
        "items": [{"kind": 9}],
        "entity": {"type": None},
    },
}

GOOD_DOC = {
    "features": [{"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10}],
    "parameters": {},
}

REPLY_TIMEOUT = 60.0


async def _probe_every_op():
    """Send all four shapes to every op on one connection, pinging in between.

    One long-lived server for the whole matrix: spawning is the expensive part,
    and reusing the connection is also what makes R4's state question askable at
    all. Returns the rows and whether the process survived."""
    ops = sorted(parse_server_ops())
    assert len(ops) >= 14, f"only found {len(ops)} ops — the scrape is broken: {ops}"
    rows = []
    with SpawnedServer() as srv:
        async with websockets.connect(srv.url, max_size=_MAX_WS) as ws:
            n = 0
            for op in ops:
                for shape_name, shape in SHAPES.items():
                    n += 1
                    try:
                        reply = await asyncio.wait_for(
                            ws_call(ws, op, f"m{n}", **shape), REPLY_TIMEOUT)
                    except asyncio.TimeoutError:
                        rows.append((op, shape_name, None, None, "NO REPLY"))
                        continue
                    err = reply.get("error") or {}
                    if not isinstance(err, dict):
                        err = {"message": str(err)}
                    rows.append((op, shape_name, reply.get("ok"),
                                 err.get("code"), err.get("message") or ""))
                # the op must not have taken the server with it
                pong = await asyncio.wait_for(ws_call(ws, "ping", f"p{n}"), REPLY_TIMEOUT)
                assert pong.get("ok"), f"the server stopped answering after {op}"
        alive = srv.proc.poll() is None
    return ops, rows, alive


def test_r1_every_op_answers_and_the_worker_survives(ops, rows, alive):
    """R1, the FLOOR — the property the task named, which already held (56/56)
    before this file was written. Kept because it is the one that would regress
    catastrophically and silently: a payload that wedges the dispatch lock or
    kills the pool looks, from the app, exactly like a hang."""
    silent = [(o, s) for o, s, ok, _c, _m in rows if ok is None]
    assert not silent, f"no reply within {REPLY_TIMEOUT}s: {silent}"
    assert alive, "the server process died during the malformed-payload matrix"
    assert len(rows) == len(ops) * len(SHAPES), (len(rows), len(ops), len(SHAPES))
    print(PASS, f"all {len(rows)} malformed payloads across {len(ops)} ops were "
                f"answered, and the worker survived every one")


def test_r2_a_refusal_is_machine_readable(rows):
    """R2, the one with teeth. A refusal must carry a code from the vocabulary
    and must not hand the client a CPython internal instead of a reason."""
    uncoded = [(o, s, m) for o, s, ok, c, m in rows if ok is False and not c]
    assert not uncoded, (
        "these refusals carry no error.code, so nothing can branch on them: "
        + "; ".join(f"{o}/{s}: {m!r}" for o, s, m in uncoded))

    unknown = [(o, s, c) for o, s, ok, c, _m in rows
               if ok is False and c not in errors.ALL]
    assert not unknown, f"codes outside errors.ALL reach the client as unclassified: {unknown}"

    leaked = [(o, s, m) for o, s, ok, _c, m in rows
              if ok is False and any(p in m for p in LEAKS)]
    assert not leaked, (
        "these refusals leak a Python internal instead of saying what was wrong: "
        + "; ".join(f"{o}/{s}: {m!r}" for o, s, m in leaked))
    print(PASS, "every refusal carries a code from errors.ALL and no CPython internals")


def test_r3_every_op_taking_a_payload_actually_refuses_one(ops, rows):
    """R3 closes R2's loophole. An op could satisfy R2 by answering ok:true to
    everything — never refusing is never uncoded. So each op that reads request
    fields must refuse at least ONE of the four shapes, with badRequest.

    Deliberately 'at least one', not 'all four': `rebuild` with no document is a
    legitimate delta request, `migrateGeometry` with no items is a legitimate
    no-op, and demanding all four would force behaviour changes on paths that
    are correct today."""
    refused = {
        op: [s for o, s, ok, c, _m in rows
             if o == op and ok is False and c == errors.BAD_REQUEST]
        for op in ops
    }
    mute = [op for op in ops if op not in PAYLOAD_FREE and not refused[op]]
    assert not mute, (
        f"these ops accepted all {len(SHAPES)} malformed shapes without one "
        f"badRequest — either they validate nothing, or they were added without "
        f"a _REQUIRED_FIELDS row: {mute}")

    # Guard the guard: an exemption that no longer names a real op is a hole.
    stale = [op for op in PAYLOAD_FREE if op not in ops]
    assert not stale, f"PAYLOAD_FREE names ops server.py no longer has: {stale}"
    print(PASS, f"all {len(ops) - len(PAYLOAD_FREE)} payload-taking ops refuse at "
                f"least one malformed shape with badRequest "
                f"({len(PAYLOAD_FREE)} payload-free ops exempt: "
                f"{', '.join(sorted(PAYLOAD_FREE))})")


async def test_r4_a_refused_document_never_enters_the_retained_state():
    """R4, the regression. _apply_doc_ops stores payload["document"] into
    _DOC_STATE unconditionally, so a document that FAILS still becomes the base
    for the next delta. Measured before the fix: a bad rebuild, then a rebuild
    sent with no document at all — the normal incremental path — came back with
    the identical "'str' object has no attribute 'get'" from the replay.

    Refusing the document before any job runs is what keeps it out of that
    state, so this asserts the state, not just the refusal."""
    with SpawnedServer() as srv:
        async with websockets.connect(srv.url, max_size=_MAX_WS) as ws:
            good = await ws_call(ws, "rebuild", "g1", document=GOOD_DOC, revision=1)
            assert good.get("ok"), good

            bad = await ws_call(
                ws, "rebuild", "g2", revision=2,
                document={"features": "not-a-list", "parameters": 7})
            assert bad.get("ok") is False, bad
            assert (bad.get("error") or {}).get("code") == errors.BAD_REQUEST, bad

            # the delta path: no document at all, exactly what client.ts sends
            after = await ws_call(ws, "rebuild", "g3", baseRevision=1, revision=3, ops={})
            assert after.get("ok"), (
                "a REFUSED document poisoned the retained delta state — the next "
                f"rebuild replayed it: {after}")
    print(PASS, "a refused document never becomes the base for the next delta rebuild")


async def test_r5_a_frame_that_is_not_a_request_object_is_answered_not_fatal():
    """R5. The op matrix above can only send well-formed request OBJECTS, so it
    is structurally blind to a frame that is valid JSON but not an object at
    all. Those took the whole CONNECTION down: `req.get("id")` sits outside any
    try, so `[1,2,3]` raised AttributeError and the socket closed with a bare
    1011 and no reply, losing every other in-flight request on it. The process
    survived; the conversation did not — which from the app is a dropped sidecar.

    R1's "the worker survives" cannot see this. Hence its own test."""
    with SpawnedServer() as srv:
        for frame in ("[1,2,3]", '"hello"', "7", "null"):
            async with websockets.connect(srv.url, max_size=_MAX_WS) as ws:
                await ws.send(frame)
                raw = await asyncio.wait_for(ws.recv(), REPLY_TIMEOUT)
                reply = json.loads(raw)
                assert reply.get("ok") is False, (frame, reply)
                assert (reply.get("error") or {}).get("code") == errors.BAD_REQUEST, \
                    (frame, reply)
                # and the SAME connection must still be usable afterwards
                pong = await asyncio.wait_for(ws_call(ws, "ping", "p"), REPLY_TIMEOUT)
                assert pong.get("ok"), (frame, pong)
    print(PASS, "a non-object frame is refused on the wire and leaves the "
                "connection usable")


def main():
    print("Malformed-payload coverage ratchet")
    ops, rows, alive = asyncio.run(_probe_every_op())
    test_r1_every_op_answers_and_the_worker_survives(ops, rows, alive)
    test_r2_a_refusal_is_machine_readable(rows)
    test_r3_every_op_taking_a_payload_actually_refuses_one(ops, rows)
    asyncio.run(test_r4_a_refused_document_never_enters_the_retained_state())
    asyncio.run(test_r5_a_frame_that_is_not_a_request_object_is_answered_not_fatal())
    print("ALL PASS")


if __name__ == "__main__":
    main()
