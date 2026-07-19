import { Container, getContainer } from "@cloudflare/containers";

const SNIPPET = `import numpy as np, pandas as pd
import matplotlib.pyplot as plt
df = pd.DataFrame({"x": np.arange(50), "y": np.random.rand(50).cumsum()})
plt.plot(df.x, df.y); plt.title("avlo cold-start demo")
print("rows", len(df))`;

export class PyExec extends Container {
  defaultPort = 8080;
  sleepAfter = "30s"; // keep-alive window (per-user warm reuse); cold path self-destroys
  override onStart() { console.log("COLD: container booted"); }
  override onError(e: unknown) { console.log("container error:", e); }
}

interface Env { PYEXEC: DurableObjectNamespace<PyExec>; }

async function runOn(stub: any, code: string) {
  const t = Date.now();
  const res = await stub.fetch(new Request("http://c/exec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  }));
  const container = await res.json();
  return { worker_wait_ms: Date.now() - t, container };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const colo = (req as any).cf?.colo ?? "?";
    const j = (o: unknown) => Response.json(o, { headers: { "access-control-allow-origin": "*" } });

    // Cold: brand-new id => fresh container (true scale-from-zero); destroy right after to free capacity.
    if (url.pathname === "/cold") {
      const id = crypto.randomUUID();
      const stub = getContainer(env.PYEXEC, id);
      const r = await runOn(stub, SNIPPET);
      ctx.waitUntil(stub.destroy().catch(() => {}));
      return j({ mode: "cold", colo, ...r });
    }
    // Warm: stable id => reuse the same container while alive (within sleepAfter).
    if (url.pathname === "/warm") {
      const stub = getContainer(env.PYEXEC, "warm-singleton");
      const r = await runOn(stub, SNIPPET);
      return j({ mode: "warm", colo, ...r });
    }
    if (url.pathname === "/run" && req.method === "POST") {
      const { code, fresh } = (await req.json()) as { code?: string; fresh?: boolean };
      const id = fresh ? crypto.randomUUID() : "warm-singleton";
      const stub = getContainer(env.PYEXEC, id);
      const r = await runOn(stub, code ?? SNIPPET);
      if (fresh) ctx.waitUntil(stub.destroy().catch(() => {}));
      return j({ mode: fresh ? "cold" : "warm", colo, ...r });
    }
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

const HTML = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">
<title>avlo · Cloudflare Python cold-start</title>
<style>
 body{font:14px/1.5 ui-monospace,Menlo,monospace;max-width:760px;margin:24px auto;padding:0 16px;background:#0d1117;color:#c9d1d9}
 h1{font-size:18px;color:#58a6ff} button{font:inherit;padding:9px 14px;margin:4px 6px 4px 0;border:1px solid #30363d;border-radius:8px;background:#161b22;color:#c9d1d9;cursor:pointer}
 button:hover{border-color:#58a6ff} button:disabled{opacity:.5;cursor:wait}
 textarea{width:100%;height:120px;background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:8px;padding:8px;box-sizing:border-box}
 #out{white-space:pre-wrap;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px;margin-top:10px;min-height:24px}
 img{max-width:100%;border-radius:8px;margin-top:10px;background:#fff} .k{color:#7ee787} .d{color:#8b949e} .cold{color:#ff7b72} .warm{color:#d29922}
</style></head><body>
<h1>avlo · raw Cloudflare Container — Python cold start</h1>
<p class=d>standard-2 · python:3.11-slim · numpy+matplotlib eager, pandas lazy · fork-per-exec · sleepAfter 30s</p>
<button onclick="go('/cold')">❄️ Cold start (fresh container)</button>
<button onclick="go('/warm')">🔥 Warm run (reuse)</button>
<button onclick="burst()">📊 10× cold (p50/p95)</button>
<p class=d>edit & run your own snippet:</p>
<textarea id=code>import numpy as np, pandas as pd
import matplotlib.pyplot as plt
plt.plot(np.sin(np.linspace(0,10,200)))
plt.title("hello from the edge")
print("sum", float(np.arange(100).sum()))</textarea>
<div><button onclick="runCode(true)">Run (cold)</button><button onclick="runCode(false)">Run (warm)</button></div>
<div id=out>click a button…</div><img id=img style=display:none>
<script>
const out=document.getElementById('out'),img=document.getElementById('img');
function show(d){img.style.display='none';
 const cls=d.mode=='cold'?'cold':'warm';
 let h=\`<span class=\${cls}>\${d.mode.toUpperCase()}</span>  edge=\${d.colo}\\n\`;
 h+=\`<span class=k>round-trip (you→worker→container):</span> \${d.worker_wait_ms} ms\\n\`;
 if(d.container){h+=\`<span class=k>container exec:</span> \${d.container.exec_ms} ms   <span class=d>(container age \${d.container.age_ms} ms)</span>\\n\`;
  h+=\`<span class=k>≈ cold boot + route:</span> \${d.worker_wait_ms-(d.container.exec_ms||0)|0} ms\\n\`;
  if(d.container.stdout)h+='<span class=d>stdout:</span> '+d.container.stdout;}
 out.innerHTML=h;
 if(d.container&&d.container.images&&d.container.images[0]){img.src='data:image/png;base64,'+d.container.images[0];img.style.display='block';}}
async function go(p){out.textContent='⏳ '+(p=='/cold'?'cold starting a fresh container…':'running…');
 const t=Date.now();const r=await fetch(p);const d=await r.json();d.client_ms=Date.now()-t;show(d);}
async function runCode(fresh){out.textContent='⏳ running…';
 const r=await fetch('/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value,fresh})});show(await r.json());}
async function burst(){out.textContent='⏳ 10 sequential cold starts…';const xs=[];
 for(let i=0;i<10;i++){const r=await fetch('/cold');const d=await r.json();xs.push(d.worker_wait_ms);out.textContent='⏳ '+(i+1)+'/10  last='+d.worker_wait_ms+'ms';}
 xs.sort((a,b)=>a-b);const p=q=>xs[Math.min(xs.length-1,Math.floor(q*xs.length))];
 out.innerHTML=\`<span class=k>10 cold starts (worker→container ms):</span>\\n\`+JSON.stringify(xs)+\`\\n<span class=cold>p50=\${p(.5)}  p95=\${p(.95)}  min=\${xs[0]}  max=\${xs[9]}</span>\`;}
</script></body></html>`;
