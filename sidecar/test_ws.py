"""WebSocket transport smoke test — starts the server in-process, connects a
client, sends a rebuild request, asserts a matched-id mesh reply. Also covers
the opt-in binary mesh frame (encoder unit test + binary-vs-JSON equality over
the real socket).

Run:  uv run python test_ws.py
"""

import asyncio
import json
import struct

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
    header["result"].pop("$buffers", None)
    return header


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


async def main():
    test_encoder_unit()
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

    print("WS ALL PASS")


if __name__ == "__main__":
    asyncio.run(main())
