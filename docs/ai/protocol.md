# AVLO AI wire protocol

Schemas live in `@avlo/shared` `src/ai/` — the ONE source both runtimes import (`actions.ts`, `context.ts`, `limits.ts`, `protocol.ts`). The worker validates tool inputs (AI SDK layer); the client re-validates before the Y.Doc. Model output is untrusted at every boundary.

## Addressing + auth

- Agent instance = `buildAgentName(userId, roomId)` = `<userId>:<roomId>`, reached at `/agents/avlo-ai-agent/<name>` (WS + chat HTTP; Vite `/agents` proxy in dev, `ai.avlo.io` prod).
- The `:` travels RAW in the path (partysocket does not encode); the gate validates the raw segment and rejects `%3A` variants (they'd mint a different DO identity).
- **Edge gate enforces** (`workers/ai/src/gate.ts`): Origin allowlist → `RL_AI` → name format → `AUTH.verifySession` → require account (`isAnon === false`) → name.userId === session userId → stamp `x-avlo-user-id`. Rejects: 403 (origin/mismatch) / 429 / 400 (name) / 401 (no account). Nothing unauthorized reaches the DO.
- Close codes `4401`/`4403` (`AI_CLOSE_*`) are the DO's defense-in-depth convention (deferred 250ms past the handshake — an onConnect-window close loses the frame); the client's `shouldReconnectOnClose` treats them as terminal.

## Message shape

- Transport is `useAgent` + `useAgentChat` (AIChatAgent: DO-SQLite persistence, resumable streams — reconnect replays buffered chunks; the DO finishes turns after the browser drops).
- A user send = `parts: [{type:'text'}, {type:'data-canvasContext', data: CanvasContext}]`. The context part is PERSISTED with the message (append-only history) and inlined server-side into a deterministic `[canvas context]\n{json}` text block (`convertDataPart`) — byte-stable re-renders keep Gemini's implicit cache warm.
- Quota denials stream back as `data-quota` parts (`AiQuotaVerdict`) + readable text; the context transform strips ALL data parts from what the model sees.
- Quota snapshots also ride agent state (`AiAgentState.quota` → `onStateUpdate` → panel footer).

## Tools

| Tool | Executes | Input | Output |
|---|---|---|---|
| `canvas` | CLIENT (`apply-actions.ts`) | `{actions: AiAction[]}` ≤50 | `{results: AiActionResult[]}` |
| `canvas_read` | CLIENT (`context-serializer.ts` `readCanvas`) | `{area, detail, ids?}` | `{objects, truncated?}` |
| `generate_image` | SERVER (flag `AI_IMAGES_ENABLED=1`) | `{prompt, aspect}` | `{assetId,width,height,mimeType}` or `{error}` |

`AiAction` union (`_type`): executable v1 = `create` (SimpleObject: shape/text/note/connector/image) · `update` (flat prop patch) · `move` · `label` · `delete`. Placeholders (parse, executor answers `unsupported`): `place`, `align`, `stack`, `distribute`, `create_diagram`, `pen`.

## Conventions

- **Short ids** `s\d+`: serializer assigns for existing objects on first sight; the model MINTS new ones for creations (executor registers them against real ULIDs). Unknown id ⇒ action dropped with a reason. Collision on create ⇒ dropped ("mint a new one").
- **Chat-origin coords**: integers relative to a fixed per-conversation origin (viewport center at first use). `short-ids.ts` owns both maps; they reset ONLY on room change (`bindAiConversation`) or clear-history. A page reload loses the map by design — the model recovers via `canvas_read` (old references drop; the serializer hands out fresh ids).
- **Context tiers**: `sel` full (≤50) / `vis` blurry (≤150) / `clusters` (≤20, 1024-unit grid buckets) + board `counts` + `vp` + `title`. Byte-capped (`AI_MAX_CONTEXT_BYTES`); malformed context is dropped server-side, the turn proceeds text-only.
- **One `canvas` tool call = ONE undo step**: `stopCapturing()` + a single `transact()`; z-keys minted once via `generateNZAtTop`. Reject = Ctrl+Z.
- **Image grants**: `create` kind:`image` accepts only assetIds returned by a `generate_image` result this conversation (client grant set).

## Quota (AiQuota DO, name = userId)

Reserve BEFORE each turn (`estimate = ceil(historyChars/4)·W_IN + AI_EST_OUT_TOKENS·W_OUT`, msgs 1) → settle actuals from `onFinish` (weighted `in×1 + out×4`). Stateless reservations: the agent echoes `reserved` at settle; NO settle on abort/disconnect/error ⇒ the estimate stands (can't launder tokens by aborting). Buckets: minute msgs / day msgs / day weighted tokens / day images — lazy integer windows, UTC day reset.

> **⚠ The numbers in `limits.ts` are mutable scaffold values, not ship values.** They were set at the first integration step, deliberately dev-loose (200 msgs/day would never ship), and WILL be tightened/refined once concrete implementations are wired in and real per-turn costs are measured. Treat the bucket *shapes* + reserve/settle protocol as the contract; treat every constant as provisional.

## Verification quickstart (dev)

```bash
PORT_OFFSET=10 VITE_PORT=5180 pnpm dev   # or dev:p
# edge-gate probes (expect 401 / 403 / 400; nothing reaches the DO):
node scripts/../[probe] ws://127.0.0.1:8804/agents/avlo-ai-agent/<26-ULID>:<14-roomid>       # 401 no cookie
#   + Origin https://evil.example → 403 · malformed name → 400 · %3A-encoded name → 400
# E2E: sign in with Google → open a room → AI button → "create three sticky notes A, B, C"
#   → notes appear · ONE Ctrl+Z removes all · follow-up "move B right" resolves ids ·
#   quota footer decrements · reload resumes the conversation.
```
Chat model needs `workers/ai/.dev.vars` (`GOOGLE_AI_STUDIO_API_KEY=...`) or Workers AI account creds in the environment.
