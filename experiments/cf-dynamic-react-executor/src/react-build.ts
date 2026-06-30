// Assembles a self-contained Preact-SSR sandbox from a user component.
// The framework (preact + render-to-string + htm) is vendored as TEXT and
// inlined into the dynamic worker's module map, so the SANDBOX needs ZERO
// network (globalOutbound: null). User authoring is build-free via htm`...`.
// NOTE: Worker Loader module *keys* must end in `.js`/`.py` (or be typed objects).
import preactSrc from "./vendor/preact.mjs.txt";
import prtsSrcRaw from "./vendor/preact-render-to-string.mjs.txt";
import htmSrc from "./vendor/htm.mjs.txt";

// Bump when the vendored framework changes so artifact hashes change with it.
export const FRAMEWORK_VERSION = "preact10-prts6-htm3";

// vendored prts imports "./preact.mjs"; module keys must be ".js"
const prtsSrc = prtsSrcRaw.replace(/\.\/preact\.mjs/g, "./preact.js");

const APP_GLUE = `
import { h, Fragment } from "./preact.js";
import htm from "./htm.js";
export const html = htm.bind(h);
export { h, Fragment };
`;

const SSR_ENTRY = `
import { renderToString } from "./preact-render-to-string.js";
import { h } from "./app.js";
import App from "./user.js";
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const props = Object.fromEntries(url.searchParams);
    let body, error = null;
    try { body = renderToString(h(App, props)); }
    catch (e) { error = String((e && e.stack) || e); }
    if (error) return new Response("SSR error:\\n" + error, { status: 500, headers: { "content-type": "text/plain" } });
    const doc =
      "<!doctype html><html><head><meta charset=\\"utf-8\\">" +
      "<meta name=\\"viewport\\" content=\\"width=device-width,initial-scale=1\\">" +
      "<title>artifact</title></head><body>" + body + "</body></html>";
    return new Response(doc, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
};
`;

// Let users write `import { html } from "app"` — rewrite to the real module key.
function normalizeUserImports(src: string): string {
  return src.replace(/(from\s*['"])app(['"])/g, "$1./app.js$2");
}

export function buildReactModules(userComponentSource: string): Record<string, string> {
  return {
    "preact.js": preactSrc,
    "htm.js": htmSrc,
    "preact-render-to-string.js": prtsSrc,
    "app.js": APP_GLUE,
    "user.js": normalizeUserImports(userComponentSource),
    "index.js": SSR_ENTRY,
  };
}
