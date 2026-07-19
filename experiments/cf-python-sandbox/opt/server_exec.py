#!/usr/bin/env python3
"""Minimal Python execution server (raw-container path, no SDK).
Modes via env:
  PREIMPORT=1  -> import numpy/pandas/matplotlib + warm font cache BEFORE signaling ready (eager).
  FORK=1       -> ForkingHTTPServer: parent pre-imports, each /exec runs in a forked child (COW
                  inherits warm imports) => per-execution process isolation + warm imports.
Endpoints: GET /health -> {"status":"ok"};  POST /exec {"code":...} -> {stdout,stderr,images[b64png],error}
"""
import os, sys, json, io, base64, traceback, contextlib, socketserver
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer

os.environ.setdefault("MPLBACKEND", "Agg")
PREIMPORT = os.environ.get("PREIMPORT") == "1"
FORK = os.environ.get("FORK") == "1"

def preimport():
    import numpy, pandas  # noqa: F401
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig = plt.figure(); plt.plot([0, 1], [0, 1]); plt.title("warm")
    b = io.BytesIO(); fig.savefig(b, format="png"); plt.close("all")  # warms font cache + Agg

if PREIMPORT:
    preimport()

def run_code(code):
    g = {"__name__": "__main__"}
    out, err, images, error = io.StringIO(), io.StringIO(), [], None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(compile(code, "<snippet>", "exec"), g)
        if "matplotlib.pyplot" in sys.modules:
            import matplotlib.pyplot as plt
            for n in plt.get_fignums():
                f = plt.figure(n); bb = io.BytesIO()
                f.savefig(bb, format="png", bbox_inches="tight")
                images.append(base64.b64encode(bb.getvalue()).decode())
            plt.close("all")
    except Exception:
        error = traceback.format_exc()
    return {"stdout": out.getvalue(), "stderr": err.getvalue(), "images": images, "error": error}

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

def main():
    if FORK:
        class Srv(socketserver.ForkingMixIn, HTTPServer): pass
        httpd = Srv(("0.0.0.0", 3000), H)
    else:
        httpd = ThreadingHTTPServer(("0.0.0.0", 3000), H)
    print("READY", flush=True)
    httpd.serve_forever()

main()
