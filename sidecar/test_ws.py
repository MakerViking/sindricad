"""WebSocket transport smoke test — starts the server in-process, connects a
client, sends a rebuild request, asserts a matched-id mesh reply. Also covers
the opt-in binary mesh frame (encoder unit test + binary-vs-JSON equality over
the real socket).

Run:  uv run python test_ws.py
"""

import asyncio
import json
import os
import socket
import struct
import subprocess
import sys

import numpy as np
import websockets

import server
from server import handle, HOST, PORT
from test_smoke import EXAMPLE

# The server requires the per-launch token (security round). In-process test:
# set it directly and dial with ?token=… (no Origin header → origin check skipped).
server._TOKEN = "test-token"
URL = f"ws://{HOST}:{PORT}?token=test-token"


def _decode_binary_frame(frame):
    """Python mirror of client.ts handleBinaryReply — used only by tests."""
    assert isinstance(frame, (bytes, bytearray)), "expected a binary frame"
    (header_len,) = struct.unpack_from("<I", frame, 0)
    header = json.loads(frame[4:4 + header_len].decode("utf-8"))
    offset = 4 + header_len + ((-header_len) % 4)
    views = []
    for meta in header["result"].get("$buffers", []):
        n = meta["len"]
        dt = np.dtype("<f4") if meta["dtype"] == "f32" else np.dtype("<u4")
        views.append(np.frombuffer(frame, dtype=dt, count=n, offset=offset))
        offset += n * 4
    for b in header["result"].get("bodies", []):
        if b.get("unchanged"):
            continue
        for field in ("positions", "normals", "indices", "faceIds"):
            if field in b and isinstance(b[field], dict):
                b[field] = views[b[field]["$buf"]]
        # packed edge polylines (server._pack_edges) — expand to the same list
        # the JSON reply carries, exactly as client.ts handleBinaryReply does
        ed = b.get("edges")
        if isinstance(ed, dict):
            pts = views[ed["$pts"]["$buf"]]
            counts = views[ed["$counts"]["$buf"]]
            out, o = [], 0
            for n in counts.tolist():
                pl = [[float(pts[o + k * 3 + j]) for j in range(3)] for k in range(n)]
                o += n * 3
                out.append({"points": pl, "body": ed["body"]}
                           if ed.get("body") is not None else {"points": pl})
            b["edges"] = out
    header["result"].pop("$buffers", None)
    return header


def _one_body_res(**over):
    """The minimal protocol-2 result the encoder accepts, with `over` replacing
    fields. Four tests built this literal by hand; a drifting copy still passes."""
    body = {"id": "b1", "name": "A", "etag": "e1",
            "positions": [0.0, 0.0, 0.0], "indices": [0],
            "faceIds": [0], "faceCount": 1}
    body.update(over)
    return {"protocol": 2, "bodies": [body]}


def test_encoder_unit():
    """_encode_binary_reply round-trips a synthetic result exactly (u32) /
    within f32 precision (floats); stubs and non-mesh fields ride the header."""
    res = {
        "protocol": 2,
        "bodies": [
            {"id": "b1", "name": "A", "etag": "e1",
             "positions": [0.125, -2.5, 3e5, 1.0, 2.0, 3.0],
             "normals": [0.0, 0.0, 1.0, 0.0, 1.0, 0.0],
             "indices": [0, 1, 0], "faceIds": [7],
             "faceOwners": ["f1"], "edges": [], "faceCount": 8},
            {"id": "b2", "name": "B", "etag": "e2", "unchanged": True},
        ],
        "bbox": {"min": [0, 0, 0], "max": [1, 1, 1]},
    }
    frame = server._encode_binary_reply("rq", res)
    out = _decode_binary_frame(frame)
    assert out["id"] == "rq" and out["ok"] is True
    b1, b2 = out["result"]["bodies"]
    assert np.allclose(b1["positions"], res["bodies"][0]["positions"], rtol=1e-6)
    assert np.allclose(b1["normals"], res["bodies"][0]["normals"])
    assert b1["indices"].tolist() == [0, 1, 0]
    assert b1["faceIds"].tolist() == [7]
    assert b1["faceOwners"] == ["f1"] and b1["faceCount"] == 8
    assert b2 == {"id": "b2", "name": "B", "etag": "e2", "unchanged": True}
    assert out["result"]["bbox"]["max"] == [1, 1, 1]
    print("  binary encoder unit OK")


def test_encoder_packs_edges():
    """Edge polylines move OUT of the inline JSON header into binary buffers and
    come back identical. Edges are the largest tolerance-INVARIANT component of a
    large assembly's reply (97.1 MiB / 1,726,523 points measured on the 356 MiB
    reference file), so packing them is what puts that reply under the frame cap.

    Asserts the packing HAPPENED, not just that the round-trip agrees: a
    _pack_edges that quietly left the triples inline would still round-trip, and
    this test would prove nothing."""
    edges = [
        {"points": [[0.0, 0.0, 0.0], [1.0, 2.0, 3.0]], "body": "b1"},
        {"points": [[4.0, 5.0, 6.0], [7.0, 8.0, 9.0], [1.5, -2.5, 0.25]], "body": "b1"},
    ]
    frame = server._encode_binary_reply("rq", _one_body_res(edges=edges))

    # the header must NOT still carry the point triples inline
    (header_len,) = struct.unpack_from("<I", frame, 0)
    raw_header = json.loads(frame[4:4 + header_len].decode("utf-8"))
    raw_edges = raw_header["result"]["bodies"][0]["edges"]
    assert isinstance(raw_edges, dict), f"edges were not packed: {type(raw_edges)}"
    assert set(raw_edges) == {"$pts", "$counts", "body"}, raw_edges

    out = _decode_binary_frame(frame)
    assert out["result"]["bodies"][0]["edges"] == edges
    print("  binary edge packing OK")


async def _recv_reply(ws):
    """Next non-progress frame (text-decoded JSON or raw bytes)."""
    while True:
        raw = await ws.recv()
        if isinstance(raw, (bytes, bytearray)):
            return raw
        msg = json.loads(raw)
        if msg.get("status") == "building":
            continue
        return msg


def test_viewport_profile_tiers():
    """A document large enough to blow the frame cap is meshed coarser; one that
    fits keeps full quality. Measured anchors: the 356 MiB reference assembly is
    3,071 bodies and needs 4.0/0.35 to fit; a normal document must be untouched."""
    assert server._viewport_profile(0) == (1.0, server._VIEWPORT_ANG_TOL)
    assert server._viewport_profile(1199) == (1.0, server._VIEWPORT_ANG_TOL)
    assert server._viewport_profile(1200) == (2.0, 0.26)
    assert server._viewport_profile(2199) == (2.0, 0.26)
    assert server._viewport_profile(2200) == (4.0, 0.35)
    assert server._viewport_profile(3071) == (4.0, 0.35), "the reference assembly"

    # the coarsening must actually reach the deflection BRepMesh gets
    fine = server._effective_tolerance(None, 0.1, 1.0)
    coarse = server._effective_tolerance(None, 0.1, 4.0)
    assert coarse == fine * 4.0, (fine, coarse)
    print("  viewport size tiers OK")


def test_oversized_reply_becomes_an_error():
    """A reply over the frame cap must come back as a NAMED error, not as a frame
    websockets refuses to send (which closes the socket with 1009 and reaches the
    user as the app vanishing mid-rebuild — GH #4's failure mode)."""
    big = "x" * (server._MAX_FRAME + 1024)
    out = json.loads(server._reply_bytes("rq", _one_body_res(name=big), True))
    assert out["ok"] is False, out
    assert "too detailed" in out["error"]["message"], out["error"]
    assert len(json.dumps(out)) < server._MAX_FRAME, "the error itself must fit"

    # and a normal reply is still returned intact
    assert isinstance(server._reply_bytes("rq", _one_body_res(), True), (bytes, bytearray))
    print("  oversized-reply guard OK")


def test_doc_bbox_equals_merged_part_bbox():
    """The document bbox is now the UNION of per-body boxes instead of one
    bbox(part) walk. That walk was a single 95.3 s OCCT call on the reference
    assembly with no way to tick inside it, against STALL_TIMEOUT = 60 s, so the
    supervisor reaped the worker before the rebuild could ever finish.

    The two must agree exactly — `part` is the Compound of the same shapes — or
    the camera silently frames the wrong volume. Driven through the REAL
    _rebuild_job on a multi-body document, not on hand-made dicts."""
    import os

    import builder
    from tessellate import bbox as bbox_of

    # union math first, including the cases the loop can hand it
    assert server._union_bbox([]) is None
    assert server._union_bbox([None, None]) is None
    assert server._union_bbox([
        {"min": [0, 0, 0], "max": [1, 1, 1]},
        None,
        {"min": [-5, 2, 0], "max": [-1, 9, 0.5]},
    ]) == {"min": [-5, 0, 0], "max": [1, 9, 1]}

    # then the real thing: a multi-solid import gives several bodies
    fixture = os.path.join(os.path.dirname(__file__), "fixtures", "asm_multisolid.step")
    payload = builder.import_geometry(fixture, "step")
    doc = {"version": 1, "parameters": {},
           "features": [dict(payload, id="f1", type="import", format="step")]}

    res = server._rebuild_job(doc, 0.1)
    assert "error" not in res, res
    assert len(res["bodies"]) > 1, f"need a multi-body fixture, got {len(res['bodies'])}"

    part, _errs, _bodies = builder.rebuild_cached(doc)
    expected = bbox_of(part)   # the very compound the old bbox(part) call walked
    assert res["bbox"] == expected, (res["bbox"], expected)
    print(f"  document bbox == merged-part bbox OK ({len(res['bodies'])} bodies)")


async def main():
    test_encoder_unit()
    test_encoder_packs_edges()
    test_viewport_profile_tiers()
    test_oversized_reply_becomes_an_error()
    async with websockets.serve(handle, HOST, PORT):
        async with websockets.connect(URL) as ws:
            req_id = "req-1"
            await ws.send(json.dumps({
                "id": req_id, "op": "rebuild", "tolerance": 0.1, "document": EXAMPLE,
            }))
            reply = await _recv_reply(ws)
            assert isinstance(reply, dict), "no-opt-in must get a TEXT reply"
            assert reply["id"] == req_id, "id mismatch"
            assert reply["ok"] is True, f"rebuild failed: {reply}"
            # the rebuild reply is a delta payload (per-body); just confirm it
            # carries geometry, without pinning the exact wire shape here.
            r = reply["result"]
            print(f"  WS rebuild OK: result keys {sorted(r.keys())}")

            # binary opt-in: same doc, binary:true → ONE binary frame whose
            # decoded bodies match the JSON reply element-wise
            await ws.send(json.dumps({
                "id": "req-bin", "op": "rebuild", "tolerance": 0.1,
                "document": EXAMPLE, "binary": True,
            }))
            braw = await _recv_reply(ws)
            assert isinstance(braw, (bytes, bytearray)), "binary opt-in must get a binary frame"
            bin_reply = _decode_binary_frame(bytes(braw))
            assert bin_reply["id"] == "req-bin" and bin_reply["ok"] is True
            jb = {b["id"]: b for b in r["bodies"]}
            bb = {b["id"]: b for b in bin_reply["result"]["bodies"]}
            assert jb.keys() == bb.keys()
            for bid, tb in bb.items():
                sb = jb[bid]
                if sb.get("unchanged") or tb.get("unchanged"):
                    continue
                assert np.allclose(tb["positions"], sb["positions"], rtol=1e-6, atol=1e-4)
                assert tb["indices"].tolist() == sb["indices"]
                assert tb["faceIds"].tolist() == sb["faceIds"]
                if "normals" in sb:
                    assert np.allclose(tb["normals"], sb["normals"], atol=1e-6)
            print("  WS binary round-trip OK: matches JSON reply")

            # ping
            await ws.send(json.dumps({"id": "p", "op": "ping"}))
            pong = json.loads(await ws.recv())
            assert pong["ok"] and pong["result"]["pong"]
            print("  WS ping OK")

            # projectGeometry: envelope over the real socket — one good
            # faceBoundary source, one strict-resolution error entry.
            box = {"parameters": {}, "features": [
                {"id": "s1", "type": "sketch", "plane": "XY", "entities": [
                    {"id": "r1", "type": "rectangle", "width": 20, "height": 20,
                     "x": 0, "y": 0}]},
                {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 10,
                 "operation": "new"},
            ]}
            await ws.send(json.dumps({
                "id": "pg", "op": "projectGeometry", "document": box, "plane": "XY",
                "sources": [
                    {"kind": "faceBoundary", "body": "body1",
                     "sel": {"kind": "face", "by": "nearest", "point": [0, 0, 10]}},
                    {"kind": "edge", "body": "ghost",
                     "sel": {"kind": "edge", "by": "nearest", "point": [0, 0, 0]}},
                ],
            }))
            pg = await _recv_reply(ws)
            assert pg["id"] == "pg" and pg["ok"], f"projectGeometry failed: {pg}"
            results = pg["result"]["results"]
            assert [r["source_index"] for r in results] == [0, 1]
            assert results[0]["ok"] and len(results[0]["curves"]) == 4
            assert all(c["curve"]["kind"] == "line" and "fp" in c
                       for c in results[0]["curves"])
            assert not results[1]["ok"] and "created after this sketch" in results[1]["error"]
            print("  WS projectGeometry OK: 4 boundary lines + 1 error entry")

            # exportProject: the colored-3MF op, over the real socket (dispatch +
            # settings-size guard + threaded palette/bodyColors).
            import os
            import tempfile
            with tempfile.TemporaryDirectory() as td:
                out = os.path.join(td, "ws.3mf")
                await ws.send(json.dumps({
                    "id": "xp", "op": "exportProject", "document": EXAMPLE, "path": out,
                    "palette": [{"name": "Red", "color": "#E03030"}],
                    "bodyColors": {}, "bodyNames": {},
                    "settings": {"printer_model": "Snapmaker U1"},
                }))
                xp = json.loads(await ws.recv())
                assert xp["id"] == "xp" and xp["ok"], f"exportProject failed: {xp}"
                assert os.path.exists(xp["result"]["path"]) and os.path.getsize(out) > 0
                print(f"  WS exportProject OK: wrote {os.path.getsize(out)} bytes")

                # oversized settings must be refused (untrusted-input cap)
                await ws.send(json.dumps({
                    "id": "xp2", "op": "exportProject", "document": EXAMPLE, "path": out,
                    "palette": [], "bodyColors": {}, "bodyNames": {},
                    "settings": {"junk": "x" * 300000},
                }))
                xp2 = json.loads(await ws.recv())
                assert not xp2.get("ok"), "oversized settings must be rejected"
                print("  WS exportProject settings-cap OK")

    # LAST, deliberately: this one does real geometry (import + two rebuilds) in
    # THIS process, and the socket tests above are supervised by a 60 s stall
    # timer against a worker pool that is created lazily on first use. Running
    # heavy work in the parent first perturbs their timing enough to trip it.
    test_doc_bbox_equals_merged_part_bbox()

    print("WS ALL PASS")


def test_port_in_use_exits_with_its_own_code():
    """A taken port must fail LOUDLY and distinctly, not as a generic crash.

    Field bug 2c0cd78a: a Windows user launched a second copy of the app, its
    sidecar could not bind 8765, and the shell reported "The geometry engine
    crashed (exit code 1)" — which named neither the port nor anything the user
    could do. server.py now exits EXIT_PORT_IN_USE and prints a FATAL line; the
    Rust shell (classify_exit in src-tauri/src/sidecar.rs) turns that pair into a
    message naming the port. This test pins BOTH halves of that contract.
    """
    holder = socket.socket()
    holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    holder.bind((HOST, 0))
    holder.listen()
    taken = holder.getsockname()[1]
    try:
        p = subprocess.run(
            [sys.executable, "server.py"],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            env={**os.environ, "SINDRI_SIDECAR_PORT": str(taken)},
            capture_output=True, text=True, timeout=180,
        )
    finally:
        holder.close()

    assert p.returncode == server.EXIT_PORT_IN_USE, (
        f"expected exit {server.EXIT_PORT_IN_USE} for a taken port, got {p.returncode}\n"
        f"stderr: {p.stderr[-2000:]}"
    )
    fatal = [ln for ln in p.stderr.splitlines() if ln.startswith("FATAL: ")]
    assert fatal, f"a bind failure must print a FATAL line; stderr: {p.stderr[-2000:]}"
    # the port has to be IN the message: it is the one thing that lets a user find
    # what is holding it, and Rust repeats this line verbatim rather than
    # hardcoding 8765 a fourth time.
    assert str(taken) in fatal[0], f"the port must be named: {fatal[0]}"
    # ...and it has to stay short, because it is repeated into a toast. The raw
    # OSError restates the address twice and belongs on the detail line instead.
    assert len(fatal[0]) < 100, f"FATAL line is too long for a toast: {fatal[0]}"
    assert any(ln.strip().startswith("bind failed:") for ln in p.stderr.splitlines()), \
        f"the underlying OSError must still reach the log; stderr: {p.stderr[-2000:]}"
    # and it must never claim to be listening
    assert "LISTENING" not in p.stdout, f"must not signal readiness: {p.stdout[-500:]}"
    print(f"  WS port-in-use OK: exit {p.returncode}, {fatal[0]}")


if __name__ == "__main__":
    test_port_in_use_exits_with_its_own_code()
    asyncio.run(main())
