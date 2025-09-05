Hypothesis: So what’s the actual bug?

The svKey calculation is not sensitive to your local edits. Concretely, one of these (ranked by likelihood):

Truncation blind spot (most likely).
You’re using a truncated “state-vector signature.” If the bytes that change for your local client live outside the truncated window, the truncated key stays the same on every local mutation. IDB hydration changes many clients/bytes, so the prefix changes → you get that first publish; your own edits tweak bytes outside the prefix → no key change → no publishes.

Client filtering / ordering issue.
If your svKey builder drops or reorders the entry for the current client, your local clock bumps won’t affect the signature. Same outcome: local edits don’t change svKey.

Hashing stale buffer.
If svKey is computed from a cached state-vector buffer that isn’t refreshed for local-origin transactions (but is refreshed after IDB sync), it will also “stick.”

The logs rule out the earlier concern about mutating lastSvKey inside buildSnapshot()—you explicitly showed it doesn’t change there (“After gate check, lastSvKey still = …”). Gates also aren’t blocking anything; the RAF runs, and you do one initial publish. The only remaining blocker is the svKey equality staying true after every local mutation.

Why the “render after refresh” behavior?

A refresh replays IDB updates from another client/session → the start of the state vector changes → your truncated signature changes → a publish slips through → you finally see content. During a live session, your local edits change bytes the truncation doesn’t look at → no key change → no publish.

What to do next (surgical checks)

No code needed—just verify these with logs:

Dump state-vector lengths & a short hex digest.
Log len(encodeStateVector(ydoc)) and a full hash (e.g., SHA-256) before and after a single local stroke. If the full hash changes but your svKey doesn’t, it’s definitively a truncation/selection bug.

Move the truncation after hashing.
Conceptually: hash the entire state vector, then (if you must) truncate the hash, not the vector. That guarantees every mutation flips the key.

Confirm client coverage/order.
If you iterate clients when forming svKey, ensure the current client’s entry is included and ordering is stable (e.g., sort by client id before hashing).

Once svKey actually changes on local edits, your “Will publish? false” lines will flip to true, and strokes/clears will render immediately again.

Side notes (not root cause, but worth tracking)

refCount: 3 and that absurd fps ~ 19,949 suggest the test harness is acquiring multiple times and your render-loop timing stats are off. Clean that up later, but it’s not what’s blocking publishes right now.

The “eraser-like” clear behavior you saw in a different branch is a separate renderer invalidation issue (dirty vs full clear). It’s not showing up in this log set.

Bottom line: Your 6A is fine. The strokes not rendering are due to the svKey dedupe never changing on local edits—almost certainly because the truncated signature never sees the changing bytes. Fix the svKey computation (hash the full vector, or include the local client’s bytes in whatever you hash), and the publisher will start emitting snapshots on every draw again.


[Registry] Creating new RoomDocManager for: test-room-001
room-doc-manager.ts:1142 [Registry] Acquired reference for test-room-001, refCount: 1
room-doc-manager.ts:1142 [Registry] Acquired reference for test-room-001, refCount: 2
room-doc-manager.ts:1142 [Registry] Acquired reference for test-room-001, refCount: 3
room-doc-manager.ts:757 [DEBUG Y.Doc] Update received! Origin= IndexeddbPersistence {_observers: Map(1), doc: _Doc, name: 'avlo.v1.rooms.test-room-001', _dbref: 0, _dbsize: 0, …} Size= 107645
room-doc-manager.ts:692 [DEBUG RAF] Pre-build: isDirty= true lastSvKey= ...
room-doc-manager.ts:962 [DEBUG buildSnapshot] Before check: snapshot.svKey= wgHa0KH/Dw... lastSvKey= ...
room-doc-manager.ts:976 [DEBUG buildSnapshot] After gate check, lastSvKey still= ... (should NOT have changed!)
room-doc-manager.ts:699 [DEBUG RAF] Post-build: newSvKey= wgHa0KH/Dw... lastSvKey= ...
room-doc-manager.ts:706 [DEBUG RAF] Will publish? true (svKeyChanged= true presenceDirty= false )
room-doc-manager.ts:856 [DEBUG publishSnapshot] Publishing! svKey= wgHa0KH/Dw... subscribers= 2 strokes= 0
room-doc-manager.ts:483 [DEBUG mutate] Starting mutation...
room-doc-manager.ts:757 [DEBUG Y.Doc] Update received! Origin= 01K4BEBGQC0XGP8B78A47GJTEG Size= 238
room-doc-manager.ts:516 [DEBUG mutate] Mutation completed. Update size= 238
room-doc-manager.ts:692 [DEBUG RAF] Pre-build: isDirty= true lastSvKey= wgHa0KH/Dw...
room-doc-manager.ts:962 [DEBUG buildSnapshot] Before check: snapshot.svKey= wgHa0KH/Dw... lastSvKey= wgHa0KH/Dw...
room-doc-manager.ts:699 [DEBUG RAF] Post-build: newSvKey= wgHa0KH/Dw... lastSvKey= wgHa0KH/Dw...
room-doc-manager.ts:706 [DEBUG RAF] Will publish? false (svKeyChanged= false presenceDirty= false )
Canvas.tsx:223 [RenderLoop Stats] {fps: '19949.6', avgMs: '0.05', overBudget: 0, skipped: 0, lastClear: 'dirty'}
room-doc-manager.ts:483 [DEBUG mutate] Starting mutation...
room-doc-manager.ts:757 [DEBUG Y.Doc] Update received! Origin= 01K4BEBGQC0XGP8B78A47GJTEG Size= 218
room-doc-manager.ts:516 [DEBUG mutate] Mutation completed. Update size= 218
room-doc-manager.ts:692 [DEBUG RAF] Pre-build: isDirty= true lastSvKey= wgHa0KH/Dw...
room-doc-manager.ts:962 [DEBUG buildSnapshot] Before check: snapshot.svKey= wgHa0KH/Dw... lastSvKey= wgHa0KH/Dw...
room-doc-manager.ts:699 [DEBUG RAF] Post-build: newSvKey= wgHa0KH/Dw... lastSvKey= wgHa0KH/Dw...
room-doc-manager.ts:706 [DEBUG RAF] Will publish? false (svKeyChanged= false presenceDirty= false )
room-doc-manager.ts:483 [DEBUG mutate] Starting mutation...
room-doc-manager.ts:757 [DEBUG Y.Doc] Update received! Origin= 01K4BEBGQC0XGP8B78A47GJTEG Size= 24
room-doc-manager.ts:516 [DEBUG mutate] Mutation completed. Update size= 24
room-doc-manager.ts:692 [DEBUG RAF] Pre-build: isDirty= true lastSvKey= wgHa0KH/Dw...
room-doc-manager.ts:962 [DEBUG buildSnapshot] Before check: snapshot.svKey= wgHa0KH/Dw... lastSvKey= wgHa0KH/Dw...
room-doc-manager.ts:699 [DEBUG RAF] Post-build: newSvKey= wgHa0KH/Dw... lastSvKey= wgHa0KH/Dw...
room-doc-manager.ts:706 [DEBUG RAF] Will publish? false (svKeyChanged= false presenceDirty= false )