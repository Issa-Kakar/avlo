 [Registry] Creating new RoomDocManager for: test-room-001
room-doc-manager.ts:1168 [Registry] Acquired reference for test-room-001, refCount: 1
room-doc-manager.ts:1168 [Registry] Acquired reference for test-room-001, refCount: 2
room-doc-manager.ts:1168 [Registry] Acquired reference for test-room-001, refCount: 3
room-doc-manager.ts:783 [DEBUG Y.Doc] Update received! Origin= IndexeddbPersistence {_observers: Map(1), doc: _Doc, name: 'avlo.v1.rooms.test-room-001', _dbref: 0, _dbsize: 0, …} Size= 123390
room-doc-manager.ts:718 [DEBUG RAF] Pre-build: isDirty= true lastSvKey= ...
room-doc-manager.ts:668 [DEBUG svKey] State vector length: 1319 bytes
room-doc-manager.ts:675 [DEBUG svKey] Full vector hash: 2092060682
room-doc-manager.ts:682 [DEBUG svKey] Using first 100 bytes for key (out of 1319 )
room-doc-manager.ts:691 [DEBUG svKey] First 20 bytes: de 01 da d0 a1 ff 0f 0b bd aa bc fa 0f 0e d8 91 db f3 0f 0b
room-doc-manager.ts:692 [DEBUG svKey] Last 20 bytes: 0b 94 8d d0 19 12 82 90 ba 13 0a e7 be bf 0f 0c 84 ba 6a 18
room-doc-manager.ts:705 [DEBUG svKey] Generated key: 3gHa0KH/Dwu9qrz6Dw7Y...
room-doc-manager.ts:988 [DEBUG buildSnapshot] Before check: snapshot.svKey= 3gHa0KH/Dw... lastSvKey= ...
room-doc-manager.ts:1002 [DEBUG buildSnapshot] After gate check, lastSvKey still= ... (should NOT have changed!)
room-doc-manager.ts:725 [DEBUG RAF] Post-build: newSvKey= 3gHa0KH/Dw... lastSvKey= ...
room-doc-manager.ts:732 [DEBUG RAF] Will publish? true (svKeyChanged= true presenceDirty= false )
room-doc-manager.ts:882 [DEBUG publishSnapshot] Publishing! svKey= 3gHa0KH/Dw... subscribers= 2 strokes= 0
room-doc-manager.ts:483 [DEBUG mutate] Starting mutation...
room-doc-manager.ts:783 [DEBUG Y.Doc] Update received! Origin= 01K4BFPEWZ1BFNT63ZKRQ8RKVN Size= 206
room-doc-manager.ts:516 [DEBUG mutate] Mutation completed. Update size= 206
room-doc-manager.ts:718 [DEBUG RAF] Pre-build: isDirty= true lastSvKey= 3gHa0KH/Dw...
room-doc-manager.ts:668 [DEBUG svKey] State vector length: 1319 bytes
room-doc-manager.ts:675 [DEBUG svKey] Full vector hash: 2007472041
room-doc-manager.ts:682 [DEBUG svKey] Using first 100 bytes for key (out of 1319 )
room-doc-manager.ts:691 [DEBUG svKey] First 20 bytes: de 01 da d0 a1 ff 0f 0b bd aa bc fa 0f 0e d8 91 db f3 0f 0b
room-doc-manager.ts:692 [DEBUG svKey] Last 20 bytes: 0b 94 8d d0 19 12 82 90 ba 13 0a e7 be bf 0f 0c 84 ba 6a 18
room-doc-manager.ts:705 [DEBUG svKey] Generated key: 3gHa0KH/Dwu9qrz6Dw7Y...
room-doc-manager.ts:988 [DEBUG buildSnapshot] Before check: snapshot.svKey= 3gHa0KH/Dw... lastSvKey= 3gHa0KH/Dw...
room-doc-manager.ts:725 [DEBUG RAF] Post-build: newSvKey= 3gHa0KH/Dw... lastSvKey= 3gHa0KH/Dw...
room-doc-manager.ts:732 [DEBUG RAF] Will publish? false (svKeyChanged= false presenceDirty= false )
room-doc-manager.ts:483 [DEBUG mutate] Starting mutation...
room-doc-manager.ts:783 [DEBUG Y.Doc] Update received! Origin= 01K4BFPEWZ1BFNT63ZKRQ8RKVN Size= 218
room-doc-manager.ts:516 [DEBUG mutate] Mutation completed. Update size= 218
room-doc-manager.ts:718 [DEBUG RAF] Pre-build: isDirty= true lastSvKey= 3gHa0KH/Dw...
room-doc-manager.ts:668 [DEBUG svKey] State vector length: 1319 bytes
room-doc-manager.ts:675 [DEBUG svKey] Full vector hash: 1922883400
room-doc-manager.ts:682 [DEBUG svKey] Using first 100 bytes for key (out of 1319 )
room-doc-manager.ts:691 [DEBUG svKey] First 20 bytes: de 01 da d0 a1 ff 0f 0b bd aa bc fa 0f 0e d8 91 db f3 0f 0b
room-doc-manager.ts:692 [DEBUG svKey] Last 20 bytes: 0b 94 8d d0 19 12 82 90 ba 13 0a e7 be bf 0f 0c 84 ba 6a 18
room-doc-manager.ts:705 [DEBUG svKey] Generated key: 3gHa0KH/Dwu9qrz6Dw7Y...
room-doc-manager.ts:988 [DEBUG buildSnapshot] Before check: snapshot.svKey= 3gHa0KH/Dw... lastSvKey= 3gHa0KH/Dw...
room-doc-manager.ts:725 [DEBUG RAF] Post-build: newSvKey= 3gHa0KH/Dw... lastSvKey= 3gHa0KH/Dw...
room-doc-manager.ts:732 [DEBUG RAF] Will publish? false (svKeyChanged= false presenceDirty= false )
ChatGPT said:
Thought for 21s

Yup—the new logs nail it.

What the logs prove (line-by-line)

Full state vector changes on every local edit:

Full vector hash: 2092060682 → 2007472041 → 1922883400 (changes each time you draw).

Your generated svKey never changes:

Generated key: stays 3gHa0KH/Dwu9qrz6Dw7Y... across all edits.

Why? You explicitly log: “Using first 100 bytes for key (out of 1319),” and the “First 20 bytes” are identical on every edit. So your truncation window never includes the bytes that change for your local client’s clock. Result: svKeyChanged=false → publisher skips every frame after the initial one.

That’s the entire reason “strokes/clear do nothing until refresh.”

Root cause (now confirmed)

Your svKey dedupe uses a truncated prefix of the Yjs state vector. With a large state vector (1319 bytes), the local client’s entry is not in the first 100 bytes, so local edits don’t affect the key. IDB hydration changes more entries (including early ones), which is why you get that one initial publish.

Why this exactly matches the observed behavior

First load after IDB hydrate → prefix changes → svKeyChanged=true → one publish.

Subsequent local strokes → only later bytes change → prefix unchanged → svKeyChanged=false → no publishes → canvas never updates until reload.

Disabling the svKey optimization appeared to “fix” it because you removed the gate that was incorrectly saying “no change.”

Short answer: turning off manager-side svKey dedupe will not hurt “feel” — even in your stress case (100 users, ~20 actively drawing). For real-time drawing, it’s effectively negligible.

Here’s the why, with quick numbers.

What actually happens per client

The manager already builds a snapshot when the doc is dirty.

Without svKey dedupe, the manager simply notifies subscribers once per rAF when dirty (≤60 publishes/sec).

This publish is local only (no extra network). Y.js networking stays the same.

Active drawing = doc dirty every frame anyway

When 1–20 people are drawing, the doc is changing virtually every frame. With or without dedupe, you end up publishing at ~60 FPS while drawing is happening. So dedupe saves almost nothing in precisely the cases you care about.

Cost breakdown (order-of-magnitude)

Per client (browser tab):

Publishes/sec while active: ≤ 60.

Subscribers per client: usually 1–3 (canvas, mini-map, maybe a HUD).

Dispatch overhead: a handful of JS function calls per frame — microseconds. The expensive part is painting, which you’re already doing when drawing.

Snapshot build cost: unchanged. You already build when dirty; removing dedupe doesn’t add builds.

Network: unchanged (publishing a snapshot is not a network send).

So even if you had 3 subscribers: 60 publishes * 3 = 180 callbacks/sec. That’s tiny compared to the canvas work you’re already doing at 60 FPS.

Scenarios
Scenario	With svKey dedupe	Without svKey dedupe	User-perceived feel
Solo drawing	Publish most frames anyway	Publish most frames anyway	Identical
4 users collab	Publish most frames anyway	Publish most frames anyway	Identical
WebRTC ≤ 15 users	Doc is dirty nearly every frame	Same	Identical; CPU bound by painting, not dispatch
100 users, 20 drawing (stress)	Doc dirty every frame	Same	Identical “feel”; any slowdowns are from rendering volume, not dedupe
When could it matter?

Idle (no edits): no difference — no dirty → no publishes.

Edge components that do heavy work per publish: if you have something unusually heavy (e.g., serializing images every frame), make that subscriber gate on a simple snapshot.version counter and early-return. You still don’t need manager-level dedupe.

Bottom line

For real-time drawing, svKey dedupe doesn’t buy you perceptible performance; it only risks suppressing real updates (as you just experienced).

Removing it keeps the system simpler and more reliable, with no visible change in latency or smoothness — even in a 100-user room with 20 active drawers.

If you ever see perf pressure, fix it at the subscriber (cheap version check / throttle), not by re-introducing a global dedupe gate.