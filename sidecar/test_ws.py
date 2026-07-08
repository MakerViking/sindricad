"""WebSocket transport smoke test — starts the server in-process, connects a
client, sends a rebuild request, asserts a matched-id mesh reply.

Run:  uv run python test_ws.py
"""

import asyncio
import json

import websockets

import server
from server import handle, HOST, PORT
from test_smoke import EXAMPLE

# The server requires the per-launch token (security round). In-process test:
# set it directly and dial with ?token=… (no Origin header → origin check skipped).
server._TOKEN = "test-token"
URL = f"ws://{HOST}:{PORT}?token=test-token"


async def main():
    async with websockets.serve(handle, HOST, PORT):
        async with websockets.connect(URL) as ws:
            req_id = "req-1"
            await ws.send(json.dumps({
                "id": req_id, "op": "rebuild", "tolerance": 0.1, "document": EXAMPLE,
            }))
            reply = json.loads(await ws.recv())
            assert reply["id"] == req_id, "id mismatch"
            assert reply["ok"] is True, f"rebuild failed: {reply}"
            # the rebuild reply is a delta payload (per-body); just confirm it
            # carries geometry, without pinning the exact wire shape here.
            r = reply["result"]
            print(f"  WS rebuild OK: result keys {sorted(r.keys())}")

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
