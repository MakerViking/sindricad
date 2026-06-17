"""WebSocket transport smoke test — starts the server in-process, connects a
client, sends a rebuild request, asserts a matched-id mesh reply.

Run:  uv run python test_ws.py
"""

import asyncio
import json

import websockets

from server import handle, HOST, PORT
from test_smoke import EXAMPLE


async def main():
    async with websockets.serve(handle, HOST, PORT):
        async with websockets.connect(f"ws://{HOST}:{PORT}") as ws:
            req_id = "req-1"
            await ws.send(json.dumps({
                "id": req_id, "op": "rebuild", "tolerance": 0.1, "document": EXAMPLE,
            }))
            reply = json.loads(await ws.recv())
            assert reply["id"] == req_id, "id mismatch"
            assert reply["ok"] is True, f"rebuild failed: {reply}"
            r = reply["result"]
            assert len(r["mesh"]["positions"]) > 0
            assert len(r["mesh"]["faceIds"]) == len(r["mesh"]["indices"]) // 3
            assert len(r["edges"]) > 0
            print(f"  WS rebuild OK: {len(r['mesh']['positions'])//3} verts, "
                  f"{len(r['edges'])} edges, bbox={r['bbox']}")

            # ping
            await ws.send(json.dumps({"id": "p", "op": "ping"}))
            pong = json.loads(await ws.recv())
            assert pong["ok"] and pong["result"]["pong"]
            print("  WS ping OK")

    print("WS ALL PASS")


if __name__ == "__main__":
    asyncio.run(main())
