"""Full-stack sidecar smoke test: starts the REAL server (worker-process pool +
websocket), then drives every feature through documents shaped exactly like the
frontend sends. Tears the server down at the end. Run from sidecar/ via uv.
"""
import asyncio, json, os, subprocess, sys, tempfile, time
import websockets

HOST, PORT = "127.0.0.1", 8765
D = tempfile.mkdtemp()
_id = [0]
def nid():
    _id[0] += 1
    return f"r{_id[0]}"

def sketch_rect(sid, w, h, plane="XY", x=0, y=0):
    return {"id": sid, "type": "sketch", "plane": plane,
            "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": y}]}

async def call(ws, op, **kw):
    rid = nid()
    await ws.send(json.dumps({"id": rid, "op": op, **kw}))
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("id") == rid:
            return msg

async def rebuild(ws, features, params=None):
    r = await call(ws, "rebuild", tolerance=0.1, document={"parameters": params or {}, "features": features})
    return r

def nbodies(r):
    return len(r["result"].get("bodies", [])) if r.get("ok") else None

async def main():
    PASS, FAIL = [], []
    def check(name, cond, info=""):
        (PASS if cond else FAIL).append(name)
        print(f"  {'OK ' if cond else 'FAIL'} {name}{(' — ' + info) if info else ''}")

    async with websockets.connect(f"ws://{HOST}:{PORT}", max_size=64 * 1024 * 1024) as ws:
        # ping
        r = await call(ws, "ping"); check("ping", r.get("ok") and r["result"]["pong"])

        # empty doc
        r = await rebuild(ws, []); check("empty doc", r["ok"] and not r["result"]["mesh"]["positions"])

        # sketch + extrude
        r = await rebuild(ws, [sketch_rect("s", 20, 20), {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"}])
        check("extrude", r["ok"] and nbodies(r) == 1, f"verts={len(r['result']['mesh']['positions'])//3}")

        # primitives + combine cut (cylinder through box)
        feats = [{"id": "bx", "type": "box", "length": 20, "width": 20, "height": 20},
                 {"id": "cy", "type": "cylinder", "radius": 5, "height": 30},
                 {"id": "cb", "type": "combine", "operation": "cut", "target": "body1", "tools": ["body2"]}]
        r = await rebuild(ws, feats); check("primitives+combine cut", r["ok"] and nbodies(r) == 1)

        # split both
        r = await rebuild(ws, [sketch_rect("s", 20, 20), {"id": "e", "type": "extrude", "sketch": "s", "distance": 20, "operation": "new"},
                               {"id": "sp", "type": "split", "plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]}, "keep": "both"}])
        check("split both", r["ok"] and nbodies(r) == 2)

        # datum plane + sketch on it
        r = await rebuild(ws, [{"id": "dp", "type": "datumPlane", "plane": {"origin": [0, 0, 12], "normal": [0, 0, 1], "xdir": [1, 0, 0]}},
                               sketch_rect("s", 10, 10, plane="dp"), {"id": "e", "type": "extrude", "sketch": "s", "distance": 4, "operation": "new"}])
        check("datum + sketch-on-datum", r["ok"] and r["result"]["bbox"]["min"][2] > 11.5)

        # revolve
        r = await rebuild(ws, [sketch_rect("s", 4, 10, plane="XZ", x=12), {"id": "rv", "type": "revolve", "sketch": "s", "axis": "Z", "angle": 270}])
        check("revolve", r["ok"] and nbodies(r) == 1)

        # loft (two free sketches)
        r = await rebuild(ws, [sketch_rect("s1", 20, 20),
                               {"id": "s2", "type": "sketch", "plane": {"origin": [0, 0, 15], "normal": [0, 0, 1], "xdir": [1, 0, 0]}, "entities": [{"type": "circle", "radius": 6}]},
                               {"id": "lf", "type": "loft", "sketches": ["s1", "s2"]}])
        check("loft", r["ok"] and nbodies(r) == 1)

        # mirror
        r = await rebuild(ws, [sketch_rect("s", 10, 10, x=20), {"id": "e", "type": "extrude", "sketch": "s", "distance": 6, "operation": "new"},
                               {"id": "mr", "type": "mirror", "plane": "YZ"}])
        check("mirror", r["ok"] and nbodies(r) == 1)

        # shell (open top)
        box20 = [sketch_rect("s", 20, 20), {"id": "e", "type": "extrude", "sketch": "s", "distance": 20, "operation": "new"}]
        r = await rebuild(ws, box20 + [{"id": "sh", "type": "shell", "thickness": 2, "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}])
        check("shell", r["ok"] and nbodies(r) == 1)

        # draft
        r = await rebuild(ws, box20 + [{"id": "dr", "type": "draft", "angle": 10, "axis": "Z", "faces": {"kind": "face", "by": "normal", "dir": [1, 0, 0]}}])
        check("draft", r["ok"] and nbodies(r) == 1)

        # patterns
        r = await rebuild(ws, [{"id": "bx", "type": "box", "length": 4, "width": 4, "height": 4}, {"id": "pr", "type": "patternRect", "countX": 3, "countY": 2, "spacingX": 10, "spacingY": 10}])
        check("patternRect 3x2", r["ok"], "")
        r = await rebuild(ws, [{"id": "cy", "type": "cylinder", "radius": 2, "height": 8}, {"id": "bx", "type": "box", "length": 2, "width": 2, "height": 2}])  # ensure 2-body ok

        # export STL then import it back as a body (real file round-trip via the server)
        stl = os.path.join(D, "box.stl")
        r = await call(ws, "export", document={"parameters": {}, "features": box20}, format="stl", path=stl)
        check("export stl", r["ok"] and os.path.exists(stl) and os.path.getsize(stl) > 0)
        r = await call(ws, "import", path=stl, format="stl")
        ok_imp = r["ok"] and r["result"]["solid"] and r["result"]["faces"] == 6
        check("import stl (merged to 6 faces)", ok_imp, f"faces={r['result'].get('faces') if r.get('ok') else r}")
        if ok_imp:
            brep = r["result"]["brep"]
            r = await rebuild(ws, [{"id": "im", "type": "import", "format": "stl", "name": "box", "brep": brep}])
            check("rebuild imported body", r["ok"] and nbodies(r) == 1)
            # combine an imported body with a primitive (cut a hole in the import)
            r = await rebuild(ws, [{"id": "im", "type": "import", "format": "stl", "name": "box", "brep": brep},
                                   {"id": "cy", "type": "cylinder", "radius": 4, "height": 40},
                                   {"id": "cb", "type": "combine", "operation": "cut"}])
            check("import + combine cut", r["ok"] and nbodies(r) == 1)

        # export step + 3mf
        for fmt, ext in (("step", "step"), ("3mf", "3mf")):
            p = os.path.join(D, f"out.{ext}")
            r = await call(ws, "export", document={"parameters": {}, "features": box20}, format=fmt, path=p)
            check(f"export {fmt}", r["ok"] and os.path.exists(p) and os.path.getsize(p) > 0)

        # error naming still works (bad fillet)
        r = await rebuild(ws, box20 + [{"id": "bad", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 100}])
        check("error names feature", (not r["ok"]) and r["error"].get("feature_id") == "bad")

    print(f"\n  {len(PASS)} passed, {len(FAIL)} failed" + (f": {FAIL}" if FAIL else ""))
    return 0 if not FAIL else 1


def run():
    env = dict(os.environ)
    proc = subprocess.Popen([sys.executable, "server.py"], cwd=os.path.dirname(os.path.abspath(__file__)) or ".",
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    try:
        # wait for readiness
        t0 = time.time()
        while time.time() - t0 < 40:
            line = proc.stdout.readline()
            if not line and proc.poll() is not None:
                print("server died:\n", proc.stdout.read()); return 1
            if line:
                print("  [server]", line.strip())
            if line.startswith("LISTENING"):
                break
        else:
            print("server never became ready"); return 1
        return asyncio.run(main())
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

if __name__ == "__main__":
    print("Verxa full-stack smoke test (real sidecar server)")
    sys.exit(run())
