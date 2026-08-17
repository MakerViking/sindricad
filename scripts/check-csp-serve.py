"""Serve the two glue builds under a STRICT CSP, the one the app wants to ship.

'wasm-unsafe-eval' permits WebAssembly compilation and NOT the Function
constructor. Node cannot show this - vitest has no CSP - so the solver suites
passing proves compatibility, not the fix. This is the only check that
reproduces the field bug and its removal.
"""
import http.server, functools, sys, os

CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'"

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        super().end_headers()

os.chdir(sys.argv[1])
http.server.HTTPServer(("127.0.0.1", 8099), functools.partial(H)).serve_forever()
