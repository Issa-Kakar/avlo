# Canvas-AI precedents — what we copied, what we skipped (researched 2026-07)

## tldraw agent starter kit (the blueprint — verified from source)

`github.com/tldraw/agent-template` (+ `templates/agent` in the monorepo) superseded the old `@tldraw/ai` module. Their DO runs `streamText` and SSE-streams a `{actions:[...]}` array; the client applies each action as it completes. What we adopted:

- **One discriminated-union action array** per tool call, not one tool per mutation — cheap to stream, trivial to validate, one panel row per action. Every mutating action carries an `intent` string (user-visible).
- **SimpleIds**: sequential short ids (`s1`, `s7`) with a per-conversation bidirectional map; the MODEL mints ids for its creations; unknown ids → action silently dropped (`ensureShapeIdExists → null`). Ours: `web/src/core/ai/short-ids.ts` (collision = drop, not remap — simpler than their suffix-increment).
- **Chat-origin coordinates**: integers offset to a per-CONVERSATION origin (not per-request viewport — stable numbers across a session). They also save rounding diffs to un-jitter echo-backs; we round only (v1).
- **Three-tier context**: full detail for selection/pinned, blurry `{id,type,text,x,y,w,h}` for the viewport, proximity clusters (bounds + count) offscreen. Plus a viewport screenshot on first request + every review — we defer screenshots (needs an offscreen `drawObjects` render path).
- **System prompt = canvas physics**: their most load-bearing prompt content is concrete numbers (text metrics, note is 200×200, min sizes) + "prefer higher-level actions". Ours mirrors this in `workers/ai/src/prompt.ts`.
- Their loop is client-driven: `review`/`setMyView`/todo actions schedule follow-up requests until nothing is scheduled. Our v1 equivalent is the `canvas_read` tool + auto-continue; `review`/`setMyView`/todo are schema placeholders.
- Streaming: they apply per COMPLETED action via a partial-JSON repair parser (`closeAndParseJson` + `Streaming<T>` complete-flags); only think/message text streams token-by-token. We get the same UX from AI SDK tool-input streaming + apply-on-complete.
- Config: temperature 0, native thinking minimal ("think via actions"), Anthropic cache breakpoint on the system prompt, assistant prefill `{"actions":[{"_type":`.

Lineage worth knowing: makereal → drawfast → tldraw.computer → agent kit → fairies.tldraw.com (multi-agent sprites, Dec 2025).

## Diagram generation — the mermaid convergence

Excalidraw text-to-diagram, Figma's ChatGPT app, and now first-party **`@tldraw/mermaid`** all converged on: LLM emits mermaid → run mermaid's own layout → harvest node positions from its SVG → mint NATIVE editable shapes + bound arrows. Verdict for AVLO: `create_diagram(mermaidText)` action (schema placeholder today) laid out client-side; direct actions remain for edits and non-graph content. Mermaid is compact (layout-free tokens) but only fits graph-shaped asks.

## Miro / Figma (the rate-limit + UX precedents)

- **Miro**: Create-with-AI panel + Sidekicks; per-selection context actions; diagram flow is sketch-preview → "Apply to canvas". Credits: 10 (Free team) → 25/50/100 per member/month, pooled, monthly reset, no rollover; a Sidekick prompt = 2 credits.
- **Figma**: full seats 3,000–4,250 credits/mo; generative features ~20 credits, utility AI cheap/free; **credits vary by model choice** (Opus-class costs more). First Draft inserts editable native objects from curated libraries; FigJam AI generates native diagram objects.
- Both validate: hard monthly-ish budgets per user, cheap-vs-generative tiering, native-editable output (never images of diagrams). Our `AiQuota` weighted-token buckets are the same idea with finer accounting.

## AVLO-native ideas neither has (future)

- The agent as a **presence peer** (cursor + name via awareness) while acting.
- The agent **grabbing ephemeral locks** on objects it edits — remote users see the veil instead of fighting it.
- One-undo-step AI turns (reject = Ctrl+Z) falls out of Yjs `transact` + `stopCapturing` — Miro needs a staged preview for this; we don't.
