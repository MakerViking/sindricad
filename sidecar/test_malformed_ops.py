"""COVERAGE RATCHET: every wire op must refuse a malformed payload legibly.

Run: uv run python test_malformed_ops.py

Not a set of hand-picked cases. BOTH axes are read out of server.py's own source
at runtime — the ops from its `op == "..."` branches, and the malformed payloads
from the request fields it reads plus the `_REQUIRED_FIELDS` table its guard
validates against (see "the malformed axis, DERIVED" below). An op or a field
added later is covered the day it lands, and neither can leave a stale copy here
behind.

The first cut of this file hand-wrote the payload half, and a reviewer showed
what that costs: `{"features": [7]}` and a path holding a NUL byte both sat one
character outside the four dicts, both came back as uncoded CPython prose, and
one of them poisoned the delta state exactly like the defect this file was
written for. The derived matrix found both on its first run.

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

Chasing that found a real defect, now R4: a document that FAILED was accepted
into the RETAINED delta state, so the next rebuild sent with no document at all
(the normal incremental path) replayed the poison. Three shapes reached it —
`features` not a list, `features` holding non-objects, and a null document — and
R4 asserts the STATE (the good document is still there, at its own revision, and
still builds) rather than merely that the bad one was refused.

R6 runs the opposite way: a well-formed request for each op must still be
SERVED, so a validation row that is too strict cannot hide behind a file full of
refusals. R7 covers what the shape matrix structurally cannot reach: a payload
whose FIELDS are all well formed but whose VALUE is out of vocabulary, which is
refused past the field guard and was still answering uncoded.
"""

import asyncio
import json
import os
import re
import sys
import tempfile

os.environ.setdefault("SINDRI_DISK_CACHE", "0")

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))

import websockets  # noqa: E402

import errors  # noqa: E402
from harness_util import (  # noqa: E402
    SpawnedServer, parse_request_fields, parse_required_fields, parse_server_ops,
    ws_call, _MAX_WS,
)

PASS = "  ok"

# Ops that take no payload at all, so "must refuse at least one malformed shape"
# cannot apply to them — there is nothing to malform. Named, with a reason each,
# rather than silently skipped: an exemption has to be argued for in writing or
# the set quietly grows until R3 means nothing. Mirrors EXCLUDED_OPS in
# tools/e2e_coverage.py.
PAYLOAD_FREE = {
    "ping": "liveness probe — answers pong regardless of what rides along",
    "listFonts": "reads the system font list; takes no request fields",
    # NOT "it validates and accepts": cancel is answered on the READ path in
    # handle() and returns before the _serialized task exists, so it never
    # reaches _dispatch or _malformed at all. Its _REQUIRED_FIELDS row is
    # documentation of that, not a check that runs.
    "cancel": "answered on the read path, so no guard ever sees it",
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

# The commonest leak of all is not a phrase but a SHAPE: `str(KeyError("path"))`
# is just "'path'", and the pre-fix server answered four ops that way
# (computeAll/export/import/tessellateText on an empty payload). No substring can
# catch that, so it is matched structurally — a whole message that is one quoted
# identifier is a KeyError repr, never a sentence written for a human.
_KEYERROR_REPR = re.compile(r"^'[\w.\-]+'$")


def _leaks(message):
    return any(p in message for p in LEAKS) or bool(_KEYERROR_REPR.match(message.strip()))

# --- the malformed axis, DERIVED ---------------------------------------------
#
# The first cut of this file hand-wrote four payload dicts listing field names,
# which is the same copied-set anti-pattern the op axis exists to avoid: adding
# `settings` to an op would have left the matrix silently blind to it. Both
# halves now come from server.py's own source at runtime.
#
#   FIELD SET   — scraped from every `req["x"]` / `req.get("x")` in server.py.
#   FIELD TYPE  — read from the `_REQUIRED_FIELDS` table the production guard
#                 validates against, so the junk is wrong in the way that
#                 matters for that field.
#
# WHAT IS STILL HAND-WRITTEN, and why it cannot be derived: the junk VALUES
# below are keyed by TYPE (four rows), not by field name. What lives INSIDE a
# document or a plane is structure no request-field scrape can know — there is
# no table in server.py that says "a document has features and parameters". So
# the inner keys are written once, per type, and a new FIELD of a known type
# needs no edit here at all. That is the derivable boundary.
TRANSPORT = {
    "id": "the request envelope — ws_call owns it, and junk here breaks reply "
          "correlation rather than testing validation",
    "op": "envelope too; a junk op is the unknownOp capability probe, covered "
          "by test_error_codes.py",
    "binary": "selects the reply ENCODING, so junk exercises the framing layer",
    "chunked": "same — reply framing, not request validation",
}
FIELDS = sorted(parse_request_fields() - set(TRANSPORT))
DECLARED = parse_required_fields()
# field -> its declared type names, e.g. "document" -> ("dict",)
TYPE_OF = {f: names for rows in DECLARED.values() for f, names, _req in rows}

# right OUTER type, wrong one level in
_INNER_JUNK = {
    "dict": {"features": "not-a-list", "parameters": 7, "origin": "x", "type": None},
    "str": "\x00\x01",
    "list": [{"kind": 9}],
}
# right outer type AND right container type — junk ELEMENTS. This is the shape
# that found the second delta-state poisoning: `{"features": [7]}` IS a list, so
# a guard that stops at the container passes it and the build still dies on
# `f.get("type")`.
_ELEMENT_JUNK = {
    "dict": {"features": [7], "parameters": {}, "origin": ["x"], "type": {}},
    "str": "",
    "list": [7],
}


def _junk(field, table):
    """Junk for `field` chosen by its DECLARED type. A field the table does not
    declare (settings, palette, known, …) is treated as a container, which is
    the shape those all have where they are read."""
    return table[TYPE_OF.get(field, ("dict",))[0]]


SHAPES = {
    # nothing at all: every required field missing
    "empty": {},
    # every field present, every one a scalar where a container is wanted
    "wrongtype": {f: 7 for f in FIELDS},
    # present-but-null, which `in req` says yes to and everything else says no
    "nulls": {f: None for f in FIELDS},
    # right outer type, wrong inside
    "deepjunk": {f: _junk(f, _INNER_JUNK) for f in FIELDS},
    # right outer type, right container, junk elements
    "junkelements": {f: _junk(f, _ELEMENT_JUNK) for f in FIELDS},
}

GOOD_DOC = {
    "features": [{"id": "b1", "type": "box", "length": 10, "width": 10, "height": 10}],
    "parameters": {},
}

REPLY_TIMEOUT = 60.0


async def _probe_every_op():
    """Send every derived shape to every op on one connection, pinging between.

    One long-lived server for the whole matrix: spawning is the expensive part,
    and reusing the connection is also what makes R4's state question askable at
    all. Returns the rows and whether the process survived."""
    ops = sorted(parse_server_ops())
    assert len(ops) >= 14, f"only found {len(ops)} ops — the scrape is broken: {ops}"
    # Guard the DERIVATION the same way: both scrapes returning nothing would
    # empty the matrix and leave every assertion below trivially true, which is
    # the failure mode a derived set trades for the copied one it replaced.
    missing = {"document", "path", "format", "entity", "plane"} - set(FIELDS)
    assert not missing, f"the request-field scrape lost known fields: {missing}"
    assert "rebuild" in DECLARED and TYPE_OF.get("document") == ("dict",), (
        f"the _REQUIRED_FIELDS parse is broken: {DECLARED}")
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

    leaked = [(o, s, m) for o, s, ok, _c, m in rows if ok is False and _leaks(m)]
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

    THE ASSERTION HAS TO NAME THE STATE, and the first version of this test did
    not: it sent baseRevision=1 after poisoning at revision=2, which does not
    match the poisoned revision, so _apply_doc_ops took its `rev != baseRevision`
    resync branch and answered ok:true whether the guard existed or not. It
    passed on unpatched server.py. The discriminator is the RESYNC FLAG, not ok:
    a healthy server still holds the GOOD document at the GOOD revision, so the
    delta must be served from it — same revision, no resync, and the box comes
    back. A poisoned server has moved its revision on and can only answer
    "resync", which is precisely the wasted round trip the defect costs a real
    client.

    Three poison shapes, because the guard was one shape wide twice over: a
    `features` that is not a list, a `features` list holding non-objects (both
    reach `f.get("type")` in the builder), and a document that is null (which
    _malformed used to skip as "not supplied" while _dispatch, keying on
    `"document" in req`, passed it straight through to overwrite the state)."""
    poisons = [
        ("features is a string", {"features": "not-a-list", "parameters": 7}),
        ("features holds non-objects", {"features": [7], "parameters": {}}),
        ("the document is null", None),
    ]
    rev = 0
    with SpawnedServer() as srv:
        async with websockets.connect(srv.url, max_size=_MAX_WS) as ws:
            for label, poison in poisons:
                rev += 1
                base = rev
                good = await ws_call(ws, "rebuild", f"g{rev}",
                                     document=GOOD_DOC, revision=base)
                assert good.get("ok"), (label, good)
                bodies = ((good.get("result") or {}).get("bodies")) or []
                assert len(bodies) == 1, (label, "the positive control did not "
                                                 "build one body", good)

                rev += 1
                bad = await ws_call(ws, "rebuild", f"b{rev}", revision=rev,
                                    document=poison)
                assert bad.get("ok") is False, (
                    f"a document with {label} was ACCEPTED: {bad}")
                assert (bad.get("error") or {}).get("code") == errors.BAD_REQUEST, \
                    (label, bad)

                # the delta path: no document at all, exactly what client.ts
                # sends, based on the revision the GOOD document had
                rev += 1
                after = await ws_call(ws, "rebuild", f"d{rev}",
                                      baseRevision=base, revision=rev, ops={})
                res = after.get("result") or {}
                assert after.get("ok"), (label, after)
                assert not res.get("resync"), (
                    f"a REFUSED document ({label}) poisoned the retained delta "
                    f"state — the server no longer holds the good document at "
                    f"revision {base} and can only ask for a full resend: {after}")
                assert len(res.get("bodies") or []) == 1, (
                    f"the delta after a refused document ({label}) did not "
                    f"rebuild the good document: {after}")
    print(PASS, f"a refused document ({len(poisons)} shapes) never becomes the "
                f"base for the next delta rebuild")


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


async def test_r6_a_well_formed_request_is_still_served(ops):
    """R6, the OTHER direction. Everything above asserts refusals, so a
    _REQUIRED_FIELDS row that is too STRICT — demanding a field the app does not
    send, or rejecting a legal shape — would refuse real traffic and leave the
    whole file green. The guard has already refused traffic the server used to
    accept once (test_cancel.py routed a sleep job as `{"document": 30}`), so
    this direction is not hypothetical.

    Unlike the matrix, these payloads are hand-written and CANNOT be derived: a
    well-formed request needs real geometry, a real writable path and a real
    font, none of which any table in server.py describes. It is therefore a
    positive CONTROL, not a ratchet — it does not claim to cover every op, and
    the ops it skips are named below so the gap is visible rather than implied.
    """
    skipped = {
        "tessellateText": "needs a real installed font family; test_text_on_face.py owns it",
        "projectGeometry": "needs real source entities on a real plane; covered by the geometry evals",
        "cancel": "answered on the read path, never reaches _dispatch",
        "export": "exercised below via a temp file, then fed back to import",
        "import": "exercised below",
    }
    with tempfile.TemporaryDirectory() as tmp:
        stl = os.path.join(tmp, "box.stl")
        proj = os.path.join(tmp, "box.3mf")
        wellformed = {
            "computeAll": {"document": GOOD_DOC},
            "massProperties": {"document": GOOD_DOC},
            "query": {"document": GOOD_DOC, "items": []},
            "interference": {"document": GOOD_DOC},
            "migrateGeometry": {"items": []},
            "rebuild": {"document": GOOD_DOC, "revision": 1},
            "export": {"document": GOOD_DOC, "format": "stl", "path": stl},
            "exportProject": {"document": GOOD_DOC, "path": proj},
            "listFonts": {},
            "ping": {},
        }
        # An op this control neither serves nor names is a silent gap.
        unaccounted = [o for o in ops if o not in wellformed and o not in skipped]
        assert not unaccounted, (
            "these ops are neither positively controlled nor listed as skipped "
            f"with a reason: {unaccounted}")

        with SpawnedServer() as srv:
            async with websockets.connect(srv.url, max_size=_MAX_WS) as ws:
                for op, payload in wellformed.items():
                    reply = await asyncio.wait_for(
                        ws_call(ws, op, f"w-{op}", **payload), REPLY_TIMEOUT)
                    assert reply.get("ok"), (
                        f"a WELL-FORMED {op} was refused — a validation row is "
                        f"too strict and this would be broken traffic in the "
                        f"app: {reply}")
                # and the file export just made is legal input to import
                assert os.path.exists(stl), "export reported ok but wrote nothing"
                back = await asyncio.wait_for(
                    ws_call(ws, "import", "w-import", path=stl, format="stl"),
                    REPLY_TIMEOUT)
                assert back.get("ok"), f"a WELL-FORMED import was refused: {back}"
    print(PASS, f"{len(wellformed) + 1} well-formed requests are still served "
                f"({len(skipped)} ops named as out of this control's reach)")


async def test_r7_a_refusal_past_the_field_guard_is_coded_too(ops):
    """R7. R2's property holds over the SHAPE MATRIX, and a reviewer showed what
    that leaves out: every op refuses on its first bad field, so a payload whose
    fields are all well-formed but whose VALUE is out of vocabulary never reaches
    the matrix at all. Three such refusals were measured uncoded on this branch.

    Two are fixed and asserted here. Coding the raise sites was not enough on its
    own: both raise a GeomError from inside a worker rather than returning an
    error dict, and _serialized's catch-all was dropping the code, so the
    `import` half of the commit below this one was INERT until that was fixed.
    That is what makes this test worth its runtime — it is the only thing that
    exercises the raise-and-propagate path end to end.

    STILL UNCODED, deliberately: `projectGeometry` with a junk plane answers
    "Expected floats", which comes out of the OCP binding inside the worker, not
    out of our code. Refusing it up front means teaching _malformed the whole
    PlaneSpec union (Plane3 | PlaneDef | a bare "XY"), and R6 has no positive
    control for projectGeometry to catch a guard that got that wrong — a too
    strict row there would break real projection traffic silently. Trigger to
    revisit: a positive control for projectGeometry exists."""
    assert {"export", "exportProject"} <= set(ops), ops
    with tempfile.TemporaryDirectory() as tmp:
        cases = [
            # a legal str, just not one of ours — raised by exporters.export
            ("export", {"document": GOOD_DOC, "format": "notaformat",
                        "path": os.path.join(tmp, "x.stl")}),
            # a legal path, junk settings — refused in _dispatch, past _malformed
            ("exportProject", {"document": GOOD_DOC,
                               "path": os.path.join(tmp, "x.3mf"), "settings": 7}),
        ]
        with SpawnedServer() as srv:
            async with websockets.connect(srv.url, max_size=_MAX_WS) as ws:
                for op, payload in cases:
                    reply = await asyncio.wait_for(
                        ws_call(ws, op, f"v-{op}", **payload), REPLY_TIMEOUT)
                    err = reply.get("error") or {}
                    assert reply.get("ok") is False, (op, reply)
                    assert err.get("code") == errors.BAD_REQUEST, (
                        f"{op} refused a well-FORMED payload with an out-of-"
                        f"vocabulary value and gave no code: {reply}")
                    assert not _leaks(err.get("message") or ""), (op, reply)
    print(PASS, f"{len(cases)} refusals past the field guard still carry a code")


def main():
    print("Malformed-payload coverage ratchet")
    ops, rows, alive = asyncio.run(_probe_every_op())
    test_r1_every_op_answers_and_the_worker_survives(ops, rows, alive)
    test_r2_a_refusal_is_machine_readable(rows)
    test_r3_every_op_taking_a_payload_actually_refuses_one(ops, rows)
    asyncio.run(test_r4_a_refused_document_never_enters_the_retained_state())
    asyncio.run(test_r5_a_frame_that_is_not_a_request_object_is_answered_not_fatal())
    asyncio.run(test_r6_a_well_formed_request_is_still_served(ops))
    asyncio.run(test_r7_a_refusal_past_the_field_guard_is_coded_too(ops))
    print("ALL PASS")


if __name__ == "__main__":
    main()
