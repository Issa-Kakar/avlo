#!/usr/bin/env python3
"""Deploy exec server: eager numpy+matplotlib (warm font cache), lazy pandas; fork-per-request
(process isolation + warm imports via COW). Reports exec_ms + container age_ms for cold/warm detection."""
import os, sys, json, io, base64, time, contextlib, socketserver, traceback
from http.server import BaseHTTPRequestHandler, HTTPServer

os.environ.setdefault("MPLBACKEND", "Agg")
START = time.time()
import numpy as np  # noqa: F401  (eager)
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
_f = plt.figure(); plt.plot([0, 1], [0, 1]); _b = io.BytesIO(); _f.savefig(_b, format="png"); plt.close("all")  # warm font cache

def run_code(code):
    g = {"__name__": "__main__"}; out = io.StringIO(); err = io.StringIO(); images = []; error = None
    t = time.perf_counter()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(compile(code, "<snippet>", "exec"), g)
        if "matplotlib.pyplot" in sys.modules:
            for n in plt.get_fignums():
                fg = plt.figure(n); bb = io.BytesIO(); fg.savefig(bb, format="png", bbox_inches="tight")
                images.append(base64.b64encode(bb.getvalue()).decode());
            plt.close("all")
    except Exception:
        error = traceback.format_exc()
    return {"stdout": out.getvalue(), "stderr": err.getvalue(), "images": images,
            "error": error, "exec_ms": round((time.perf_counter() - t) * 1000, 1)}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/health":
            self._s(200, {"status": "ok", "age_ms": round((time.time() - START) * 1000)})
        else:
            self._s(404, {})
    def do_POST(self):
        if self.path == "/exec":
            ln = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(ln) or b"{}")
            r = run_code(body.get("code", "")); r["age_ms"] = round((time.time() - START) * 1000)
            self._s(200, r)
        else:
            self._s(404, {})
    def _s(self, c, o):
        d = json.dumps(o).encode(); self.send_response(c)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(d)))
        self.end_headers(); self.wfile.write(d)

class Srv(socketserver.ForkingMixIn, HTTPServer):
    daemon_threads = True

PORT = int(os.environ.get("PORT", "8080"))
httpd = Srv(("0.0.0.0", PORT), H)
print(f"READY port={PORT}", flush=True)
httpd.serve_forever()
