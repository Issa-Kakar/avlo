import { getSandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";

const SNIPPET = `import numpy as np, pandas as pd
import matplotlib.pyplot as plt
df = pd.DataFrame({"x": np.arange(50), "y": np.random.rand(50).cumsum()})
plt.plot(df.x, df.y); plt.title("avlo cold-start demo")
print("rows", len(df))`;

interface Env { Sandbox: DurableObjectNamespace; }

async function runOn(env: Env, id: string) {
  const sandbox = getSandbox(env.Sandbox, id, { sleepAfter: "30s" } as any);
  const t = Date.now();
  const ctx = await (sandbox as any).createCodeContext({ language: "python" });
  const result: any = await (sandbox as any).runCode(SNIPPET, { context: ctx });
  const worker_wait_ms = Date.now() - t;
  let png = 0;
  for (const r of result.results ?? []) if (r.png || r.image) png++;
  const stdout = (result.logs?.stdout ?? []).join("");
  return { worker_wait_ms, png, stdout, error: result.error ?? null, sandbox };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const colo = (req as any).cf?.colo ?? "?";
    const j = (o: unknown) => Response.json(o, { headers: { "access-control-allow-origin": "*" } });
    try {
      if (url.pathname === "/cold") {
        const { sandbox, ...r } = await runOn(env, crypto.randomUUID().slice(0, 63));
        ctx.waitUntil((sandbox as any).destroy().catch(() => {}));
        return j({ mode: "cold", colo, ...r });
      }
      if (url.pathname === "/warm") {
        const { sandbox, ...r } = await runOn(env, "warm-singleton");
        return j({ mode: "warm", colo, ...r });
      }
    } catch (e: any) {
      return j({ error: String(e?.stack ?? e) });
    }
    return new Response("avlo SDK cold-start tester (sandbox 0.12.1-python, py-pool=1, sleepAfter 30s)\nGET /cold  GET /warm\n",
      { headers: { "content-type": "text/plain" } });
  },
};
