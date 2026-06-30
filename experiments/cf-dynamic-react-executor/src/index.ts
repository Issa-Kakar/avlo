// Worker Loaders prototype — content-addressed sandbox executor + per-room host
// + real Preact SSR artifact build. Proves: caching/isolation semantics,
// content-addressing collapses billable "unique workers" to one-per-distinct-code,
// capability + egress boundaries, and a build-free React-family artifact pipeline.
import { buildReactModules, FRAMEWORK_VERSION } from "./react-build";

interface Env {
  LOADER: WorkerLoader;
}
interface WorkerLoader {
  load?(code: WorkerCode): WorkerStub;
  get(id: string | null, getCode: () => WorkerCode | Promise<WorkerCode>): WorkerStub;
}
interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  env?: Record<string, unknown>;
  globalOutbound?: unknown;
}
interface WorkerStub {
  getEntrypoint(name?: string): Fetcher;
}

// host-side observability: how many *unique workers* the runtime actually loaded
const loadedIds = new Set<string>();
let totalLoads = 0;

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sandbox(code: string, extra?: Partial<WorkerCode>): WorkerCode {
  return { compatibilityDate: "2025-05-01", mainModule: "index.js", modules: { "index.js": code }, globalOutbound: null, ...extra };
}

const STATEFUL = `
let n = 0;
const bootPolluted = globalThis.__polluted === true;
export default { async fetch(request, env) {
  n++;
  const url = new URL(request.url);
  if (url.searchParams.get("pollute") === "1") {
    globalThis.__polluted = true;
    if (!Array.prototype.__evil) Object.defineProperty(Array.prototype,"__evil",{value:true,enumerable:false});
  }
  return Response.json({ counter:n, bootPolluted, polluted:globalThis.__polluted===true, arrayProtoEvil:([]).__evil===true, envKeys:Object.keys(env||{}) });
}};`;

const EGRESS = `export default { async fetch(){ try { const r=await fetch("https://example.com"); return Response.json({egress:"ALLOWED",status:r.status}); } catch(e){ return Response.json({egress:"BLOCKED",error:String(e&&e.message||e)}); } } };`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "default";

    if (url.pathname === "/stats") return Response.json({ totalLoads, uniqueIds: [...loadedIds] });

    // CORE: content-addressed sandbox execution (arbitrary JS module via POST).
    if (url.pathname === "/run" && request.method === "POST") {
      const code = await request.text();
      const sandboxId = "sb:" + (await sha256hex(code));
      const wasLoaded = loadedIds.has(sandboxId);
      const worker = env.LOADER.get(sandboxId, () => { loadedIds.add(sandboxId); totalLoads++; return sandbox(code, { env: { ROOM_ID: id } }); });
      const res = await worker.getEntrypoint().fetch(new Request("https://sandbox/"));
      return Response.json({ sandboxId, cached: wasLoaded, billedNewUniqueWorker: !wasLoaded, output: await res.text(), totalLoads });
    }

    // HEADLINE: build + execute a React-family component into an HTML artifact,
    // content-addressed (framework version + source) and run network-isolated.
    if (url.pathname === "/render-react" && request.method === "POST") {
      const userSrc = await request.text();
      const sandboxId = "art:" + (await sha256hex(FRAMEWORK_VERSION + "\n" + userSrc));
      const wasLoaded = loadedIds.has(sandboxId);
      const worker = env.LOADER.get(sandboxId, () => {
        loadedIds.add(sandboxId); totalLoads++;
        return { compatibilityDate: "2025-05-01", mainModule: "index.js", modules: buildReactModules(userSrc), globalOutbound: null };
      });
      const props = new URLSearchParams(url.searchParams); props.delete("raw");
      const res = await worker.getEntrypoint().fetch(new Request("https://artifact/?" + props.toString()));
      const html = await res.text();
      if (url.searchParams.get("raw") === "1") return new Response(html, { status: res.status, headers: { "content-type": "text/html; charset=utf-8" } });
      return Response.json({ sandboxId, cached: wasLoaded, billedNewUniqueWorker: !wasLoaded, status: res.status, html, totalLoads });
    }

    // isolation probes
    if (url.pathname === "/counter") {
      const sid = "sb:" + id;
      const worker = env.LOADER.get(sid, () => { loadedIds.add(sid); totalLoads++; return sandbox(STATEFUL); });
      return worker.getEntrypoint().fetch(request);
    }
    if (url.pathname === "/counter-load") return env.LOADER.load!(sandbox(STATEFUL)).getEntrypoint().fetch(request);
    if (url.pathname === "/egress") return env.LOADER.get("egress-blocked", () => sandbox(EGRESS)).getEntrypoint().fetch(request);

    return new Response("routes: /stats  POST /run  POST /render-react[?raw=1&prop=..]  /counter?id=  /counter-load  /egress", { headers: { "content-type": "text/plain" } });
  },
};
