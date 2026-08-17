"""Does WebKitGTK - the engine Tauri uses on Linux - accept the tightened CSP?

Usage, from the repo root:
    python3 scripts/check-csp-serve.py <dir-with-the-two-glues> &   # serves :8099
    python3 scripts/check-csp-webkit.py

The served directory needs control.js / patched.js (the two planegcs glues),
their .wasm files, and an index.html whose EXTERNAL module imports ?g=<which>
and records the outcome on window.__r / window.__done. Note "external": under
script-src 'self' an INLINE module is itself blocked, which will look like the
glue failing if you inline it.

Chromium already showed the stock glue throwing EvalError and the vendored one
initialising. That is not transferable: CSP enforcement is per-engine, and the
packaged app runs WebKit2GTK, not Chromium. This loads both glues in a REAL
WebKitGTK view under the policy taken from src-tauri/tauri.conf.json.
"""
import json, re, sys
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib

conf = json.load(open("src-tauri/tauri.conf.json"))
def find_csp(o):
    if isinstance(o, dict):
        if isinstance(o.get("csp"), str): return o["csp"]
        for v in o.values():
            r = find_csp(v)
            if r: return r
    return None
CSP = find_csp(conf)
print("policy:", re.search(r"script-src [^;]*", CSP).group(0), flush=True)

results = {}
targets = ["control", "patched"]

def run(which, done):
    view = WebKit2.WebView()
    # Serve over http from the local server so the CSP header applies exactly as
    # the packaged app receives it.
    view.load_uri(f"http://127.0.0.1:8099/index.html?g={which}")

    def poll():
        view.run_javascript(
            "JSON.stringify(window.__done ? window.__r : null)", None, got, None)
        return False

    def got(v, res, _):
        try:
            js = view.run_javascript_finish(res)
            val = js.get_js_value().to_string()
        except Exception as e:
            val = None
        if not val or val == "null":
            GLib.timeout_add(400, poll)
            return
        results[which] = json.loads(val)
        done()

    GLib.timeout_add(900, poll)

def after_control():
    run("patched", after_patched)

def after_patched():
    Gtk.main_quit()

run("control", after_control)
GLib.timeout_add_seconds(40, Gtk.main_quit)
Gtk.main()

for t in targets:
    r = results.get(t)
    if r is None:
        print(f"{t:8} NO RESULT (timed out)")
    else:
        print(f"{t:8} init ok={r.get('ok')}  {('err=' + str(r.get('err'))[:120]) if r.get('err') else ''}")
