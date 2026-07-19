#!/usr/bin/env python3
"""IPython-based execution server in a MINIMAL container (isolates 'IPython overhead' from 'SDK bloat').
Mirrors the SDK's ipython_executor approach (InteractiveShell) but with no Bun/Node/cloudflared/pool-manager.
Ready = HTTP up; the InteractiveShell is created at startup (like the SDK pool prewarm)."""
import os, sys, json, io, base64
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer

os.environ.setdefault("MPLBACKEND", "Agg")
from IPython.core.interactiveshell import InteractiveShell
from IPython.utils.capture import capture_output
shell = InteractiveShell.instance()
shell.colors = "NoColor"

def run_code(code):
    images, error = [], None
    with capture_output() as cap:
        r = shell.run_cell(code, store_history=False, silent=False)
    if r.error_in_exec:
        error = repr(r.error_in_exec)
    if "matplotlib.pyplot" in sys.modules:
        import matplotlib.pyplot as plt
        for n in plt.get_fignums():
            f = plt.figure(n); bb = io.BytesIO(); f.savefig(bb, format="png", bbox_inches="tight")
            images.append(base64.b64encode(bb.getvalue()).decode())
        plt.close("all")
    return {"stdout": cap.stdout, "stderr": cap.stderr, "images": images, "error": error}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self._send(200, {"status": "ok"}) if self.path == "/health" else self._send(404, {})
    def do_POST(self):
        if self.path == "/exec":
            ln = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(ln) or b"{}")
            self._send(200, run_code(body.get("code", "")))
        else:
            self._send(404, {})
    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers()
        self.wfile.write(data)

httpd = ThreadingHTTPServer(("0.0.0.0", 3000), H)
print("READY", flush=True)
httpd.serve_forever()
