#!/usr/bin/env bash
# Reproducible empirical probe of Worker Loaders semantics against a local
# `wrangler dev` instance (default :8799). Run `npm install && npm run dev`
# in one shell, then `bash probe.sh` in another.
set -u
BASE="${BASE:-http://127.0.0.1:8799}"
C="curl -s --noproxy 127.0.0.1"

hr(){ printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

hr "0. runtime supports load() + get() locally (no deploy)"
$C "$BASE/info" 2>/dev/null || $C "$BASE/stats"; echo

hr "1. get(id,cb) caches by id — same id reuses warm isolate, state PERSISTS"
$C "$BASE/counter?id=roomX"; echo
$C "$BASE/counter?id=roomX"; echo
$C "$BASE/counter?id=roomX&pollute=1"; echo
echo "-> next call to roomX should report polluted:true, arrayProtoEvil:true (LEAK across executions in a reused isolate)"
$C "$BASE/counter?id=roomX"; echo

hr "2. different id == different V8 isolate == hard isolation (no leak)"
$C "$BASE/counter?id=roomY"; echo

hr "3. load() == fresh isolate every call (counter always 1)"
$C "$BASE/counter-load"; echo
$C "$BASE/counter-load"; echo

hr "4. globalOutbound:null blocks all network egress"
$C "$BASE/egress"; echo

hr "5. content-addressing: identical code reuses isolate (free), changed code = 1 new load"
CODE1='export default { fetch(req,env){ return new Response("artifact v1, room="+env.ROOM_ID); } };'
CODE2='export default { fetch(){ return new Response("artifact v2 CHANGED"); } };'
$C -X POST --data "$CODE1" "$BASE/run?id=room1"; echo
$C -X POST --data "$CODE1" "$BASE/run?id=room1"; echo
$C -X POST --data "$CODE2" "$BASE/run?id=room1"; echo
echo "-> /stats: totalLoads should be 2 despite many executions"
$C "$BASE/stats"; echo

hr "6. real Preact SSR artifact, built + executed in a network-isolated sandbox"
COMP='import { html } from "app";
export default function Card({ name, count }) {
  const items = Array.from({ length: Number(count || 3) }, (_, i) => html`<li>item ${i + 1}</li>`);
  return html`<div class="card"><h1>Hello, ${name || "world"}</h1><ul>${items}</ul></div>`;
}'
$C -X POST --data "$COMP" "$BASE/render-react?name=Issa&count=2&raw=1"; echo
